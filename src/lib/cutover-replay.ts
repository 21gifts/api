/**
 * Operator replay of payout triggers inside a time window: new top-level
 * media posts, moderator-group messages, `/trial` and `/admit` decisions,
 * and welcome triggers. Daily and moderator payouts are booked on the
 * event's own UTC day; at most one per member, payout kind, and day.
 */

import { isModeratorGroupMember } from '@/lib/auth/roles';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { ConversationStore } from '@/lib/conversation-store';
import { effectiveStatus, eligibleToday, utcDayKey, type FundingGrant } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { GiftKind, GiftRow } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { MESSAGE_LIST_LIMIT, type MessageRow } from '@/lib/message';
import type { MessageListRow, MessageStore } from '@/lib/message-store';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { receivingAddress } from '@/lib/receiving-address';
import type { SpendPing } from '@/lib/spend-ping';
import type { TrustStore } from '@/lib/trust-store';
import { syncWelcomePing } from '@/lib/welcome-media';

/** What triggered a replayed payout. */
export type ReplayTrigger = 'post' | 'moderator' | 'trial' | 'admit' | 'welcome';

/** Outcome of one replayed event. */
export type ReplayStatus = 'paid' | 'would_pay' | 'sent' | 'would_send' | 'skipped' | 'failed';

/** Why an event was skipped. */
export type ReplaySkipReason = 'no_wallet' | 'already_paid' | 'not_eligible' | 'spend';

/** One replayed event. Never carries a Lightning address. */
export interface ReplayEvent {
  /** Trigger kind. */
  trigger: ReplayTrigger;
  /** Post, group message, account (grant), or trust edge id of the trigger. */
  eventId: string;
  /** Trigger time, ISO-8601. */
  at: string;
  /** UTC day the payout is booked on (`YYYY-MM-DD`). */
  day: string;
  /** Member account id. */
  accountId: string;
  /** Member username, or `null`. */
  username: string | null;
  /** Payout kind. */
  payout: GiftKind;
  /** Post or group message the payout is for, or `null` when none was found. */
  messageId: string | null;
  /** Outcome. */
  status: ReplayStatus;
  /** Skip reason when `status` is `skipped`. */
  reason?: ReplaySkipReason;
  /** Detail of the skip (`trial_day_passed`, `ledger`, a spend skip reason, …). */
  detail?: string;
}

/** Counts per outcome. */
export interface ReplayTotals {
  events: number;
  paid: number;
  wouldPay: number;
  sent: number;
  wouldSend: number;
  skipped: number;
  failed: number;
}

/** Result of {@link replayPayoutWindow}. */
export interface ReplayResult {
  events: ReplayEvent[];
  totals: ReplayTotals;
}

/** Collaborators of {@link replayPayoutWindow}. */
export interface ReplayDeps {
  auth: AuthStore;
  messages: MessageStore;
  conversations: ConversationStore;
  funding: FundingStore;
  trust: TrustStore;
  gifts: Pick<GiftStore, 'listOutbound'>;
  spendPing: SpendPing;
  /** `spendPing.pingOnDay`, bound to its ping. */
  pingOnDay: NonNullable<SpendPing['pingOnDay']>;
  lnurlServer?: LnurlServerConfig;
  now: () => number;
}

interface Trigger {
  trigger: ReplayTrigger;
  eventId: string;
  atMs: number;
  accountId: string;
  messageId: string | null;
}

function hasMedia(row: MessageRow): boolean {
  return row.hasPhoto === true || row.hasVideo === true || Number(row.photoCount) > 0;
}

function inWindow(atMs: number, fromMs: number, toMs: number): boolean {
  return atMs >= fromMs && atMs < toMs;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Live top-level notes in `[fromMs, toMs)`, paging the feed back from `toMs`. */
async function windowPosts(
  messages: MessageStore,
  fromMs: number,
  toMs: number,
): Promise<MessageListRow[]> {
  const rows: MessageListRow[] = [];
  // The nil UUID sorts before every id, so the first page starts strictly before `toMs`.
  let cursor = { k: 't' as const, c: new Date(toMs), i: '00000000-0000-0000-0000-000000000000' };
  for (;;) {
    const page = await messages.listFeed({
      limit: MESSAGE_LIST_LIMIT,
      mode: 'all',
      cursor,
      staffAccountIds: new Set(),
    });
    rows.push(...page.filter((row) => inWindow(row.createdAt.getTime(), fromMs, toMs)));
    const last = page.at(-1);
    if (
      page.length < MESSAGE_LIST_LIMIT ||
      last === undefined ||
      last.createdAt.getTime() < fromMs
    ) {
      return rows;
    }
    cursor = { k: 't', c: last.createdAt, i: last.id };
  }
}

async function windowGroupMessages(
  conversations: ConversationStore,
  fromMs: number,
  toMs: number,
): Promise<Trigger[]> {
  const group = await conversations.getModeratorGroup();
  if (group === undefined) {
    return [];
  }
  const triggers: Trigger[] = [];
  let cursor: { c: Date; i: string } | null = null;
  for (;;) {
    const page = await conversations.listThreadPage({
      conversationId: group.id,
      limit: MESSAGE_LIST_LIMIT,
      cursor,
    });
    for (const row of page) {
      if (row.senderAccountId !== null && inWindow(row.createdAt.getTime(), fromMs, toMs)) {
        triggers.push({
          trigger: 'moderator',
          eventId: row.id,
          atMs: row.createdAt.getTime(),
          accountId: row.senderAccountId,
          messageId: row.id,
        });
      }
    }
    const oldest = page[0];
    if (
      page.length < MESSAGE_LIST_LIMIT ||
      oldest === undefined ||
      oldest.createdAt.getTime() < fromMs
    ) {
      return triggers;
    }
    cursor = { c: oldest.createdAt, i: oldest.id };
  }
}

/**
 * Whether `grant` is a trial that expired and was stored as `pending` by
 * `expiredTrialAsPending`, the only writer of a pending row with a decision.
 */
function isExpiredTrial(grant: FundingGrant): boolean {
  return grant.status === 'pending' && grant.decidedAt !== null;
}

function grantTrigger(grant: FundingGrant, fromMs: number, toMs: number): Trigger | null {
  if (grant.decidedAt === null || !inWindow(grant.decidedAt, fromMs, toMs)) {
    return null;
  }
  const trial = grant.status === 'trial' || isExpiredTrial(grant);
  if (!trial && grant.status !== 'admitted') {
    return null;
  }
  return {
    trigger: trial ? 'trial' : 'admit',
    eventId: grant.accountId,
    atMs: grant.decidedAt,
    accountId: grant.accountId,
    messageId: null,
  };
}

async function collectTriggers(deps: ReplayDeps, fromMs: number, toMs: number): Promise<Trigger[]> {
  const posts = await windowPosts(deps.messages, fromMs, toMs);
  const triggers: Trigger[] = [];
  for (const row of posts) {
    if (row.accountId === null || !hasMedia(row)) {
      continue;
    }
    const base = { eventId: row.id, atMs: row.createdAt.getTime(), accountId: row.accountId };
    triggers.push({ ...base, trigger: 'post', messageId: row.id });
    triggers.push({ ...base, trigger: 'welcome', messageId: row.id });
  }
  triggers.push(...(await windowGroupMessages(deps.conversations, fromMs, toMs)));
  for (const grant of await deps.funding.listGrants()) {
    const trigger = grantTrigger(grant, fromMs, toMs);
    if (trigger !== null) {
      triggers.push(trigger);
    }
  }
  for (const edge of await deps.trust.listEdges()) {
    if (edge.kind === 'verify' && inWindow(edge.createdAt, fromMs, toMs)) {
      triggers.push({
        trigger: 'welcome',
        eventId: edge.id,
        atMs: edge.createdAt,
        accountId: edge.subjectId,
        messageId: null,
      });
    }
  }
  return triggers.sort((a, b) => a.atMs - b.atMs || a.eventId.localeCompare(b.eventId));
}

function handleOf(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  return (at === -1 ? trimmed : trimmed.slice(0, at)).trim().toLowerCase();
}

/**
 * Whether the gift ledger records a `kind` payout on `day` to any of
 * `handles` (the account's username or its legacy external address).
 */
function paidInLedger(
  gifts: readonly GiftRow[],
  handles: ReadonlySet<string>,
  kind: GiftKind,
  day: string,
): boolean {
  return gifts.some(
    (gift) =>
      gift.kind === kind &&
      handles.has(handleOf(gift.recipientWosUser)) &&
      gift.paidAt instanceof Date &&
      !Number.isNaN(gift.paidAt.getTime()) &&
      utcDayKey(gift.paidAt.getTime()) === day,
  );
}

function notEligibleDetail(
  account: Account,
  grant: FundingGrant | undefined,
  eligible: boolean,
  nowMs: number,
): string | null {
  if (eligible) {
    return null;
  }
  if (
    account.role !== 'basis' &&
    grant !== undefined &&
    (isExpiredTrial(grant) ||
      (grant.status === 'trial' &&
        grant.trialUtcDate !== null &&
        grant.trialUtcDate < utcDayKey(nowMs)))
  ) {
    return 'trial_day_passed';
  }
  return eligibleToday(account.role, grant, nowMs, true) ? 'no_recovery_share' : 'grant';
}

/**
 * Replay every payout trigger in `[fromMs, toMs)`.
 *
 * Each event is paid only when the account has a verified wallet now, is
 * eligible now through `loadPayoutEligibility` (a `trial` grant of an earlier
 * UTC day, also once it was stored as `pending`, is reported as `not_eligible`
 * / `trial_day_passed`, except for a `basis` account, which is never eligible
 * and is reported as `grant`; an account eligible but for the 21.gifts
 * recovery share of its current wallet is reported as `no_recovery_share`),
 * and has no payout of that kind on the event's UTC day: neither in the gift
 * ledger under its username or its legacy external address, nor earlier in
 * this run. Daily and moderator payouts go
 * through `SpendPing.pingOnDay` on the event's UTC day; spend's own record per
 * day and address makes a repeated run skip what it already booked. Welcome
 * triggers are handed to `syncWelcomePing`, which pays once per account.
 * `dryRun` reports `would_pay` / `would_send` and pings nothing.
 *
 * @param deps - Stores, spend ping (with `pingOnDay`), LNURL server config, and clock.
 * @param window - Window start (inclusive) and end (exclusive) in epoch ms, and dry-run flag.
 * @returns Every event in time order with its outcome, and totals.
 * @throws When a store read throws.
 */
export async function replayPayoutWindow(
  deps: ReplayDeps,
  window: { fromMs: number; toMs: number; dryRun: boolean },
): Promise<ReplayResult> {
  const nowMs = deps.now();
  const triggers = await collectTriggers(deps, window.fromMs, window.toMs);
  const gifts = await deps.gifts.listOutbound();
  const legacy = (await deps.auth.listLegacyPayoutHandles?.()) ?? new Map<string, string>();
  const accounts = new Map<string, Account | undefined>();
  const booked = new Set<string>();
  const postsByDay = new Map<string, MessageListRow[]>();
  const dayPosts = async (day: string): Promise<MessageListRow[]> => {
    let rows = postsByDay.get(day);
    if (rows === undefined) {
      const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
      rows = await windowPosts(deps.messages, dayStartMs, dayStartMs + DAY_MS);
      postsByDay.set(day, rows);
    }
    return rows;
  };
  const events: ReplayEvent[] = [];

  for (const trigger of triggers) {
    if (!accounts.has(trigger.accountId)) {
      accounts.set(trigger.accountId, await deps.auth.getAccount(trigger.accountId));
    }
    const account = accounts.get(trigger.accountId);
    if (account?.isPlatform === true) {
      continue;
    }
    const payout: GiftKind =
      trigger.trigger === 'moderator'
        ? 'moderator'
        : trigger.trigger === 'welcome'
          ? 'welcome'
          : 'daily';
    // Only a verified account earns a welcome, once; other welcome triggers are not events.
    if (payout === 'welcome') {
      if (account?.role !== 'verified' || booked.has(`${account.id}|welcome`)) {
        continue;
      }
      booked.add(`${account.id}|welcome`);
    }
    const day = utcDayKey(trigger.atMs);
    const event: ReplayEvent = {
      trigger: trigger.trigger,
      eventId: trigger.eventId,
      at: new Date(trigger.atMs).toISOString(),
      day,
      accountId: trigger.accountId,
      username: account?.username ?? null,
      payout,
      messageId: trigger.messageId,
      status: 'skipped',
    };
    events.push(event);
    const skip = (reason: ReplaySkipReason, detail: string): void => {
      event.reason = reason;
      event.detail = detail;
    };
    if (account === undefined) {
      skip('not_eligible', 'no_account');
      continue;
    }
    const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;

    if (payout === 'welcome') {
      const lnurlServer = deps.lnurlServer;
      if (address === null || lnurlServer === undefined) {
        skip('no_wallet', 'no_verified_wallet');
      } else if (window.dryRun) {
        event.status = 'would_send';
      } else {
        await syncWelcomePing({
          spendPing: deps.spendPing,
          messages: deps.messages,
          auth: deps.auth,
          gifts: deps.gifts,
          account,
          lnurlServer,
        });
        event.status = 'sent';
      }
      continue;
    }

    if (address === null) {
      skip('no_wallet', 'no_verified_wallet');
      continue;
    }
    const { grant, eligible } = await loadPayoutEligibility(
      deps.funding,
      deps.auth,
      account,
      nowMs,
    );
    const ineligible = notEligibleDetail(account, grant, eligible, nowMs);
    if (ineligible !== null) {
      skip('not_eligible', ineligible);
      continue;
    }
    const posts = (await dayPosts(day)).filter((row) => row.accountId === account.id);
    if (payout === 'moderator' && !isModeratorGroupMember(account)) {
      skip('not_eligible', 'not_moderator');
      continue;
    }
    if (
      payout === 'moderator' &&
      !posts.some((row) => row.id !== (account.profileMessageId ?? null))
    ) {
      skip('not_eligible', 'no_public_post');
      continue;
    }
    if (trigger.trigger === 'post' && account.profileMessageId === trigger.messageId) {
      skip('not_eligible', 'profile_note');
      continue;
    }
    const messageId =
      trigger.trigger === 'trial' || trigger.trigger === 'admit'
        ? (posts.find(hasMedia)?.id ?? null)
        : trigger.messageId;
    if (messageId === null) {
      skip('not_eligible', 'no_media_post');
      continue;
    }
    event.messageId = messageId;

    const key = `${account.id}|${payout}|${day}`;
    const handles = new Set<string>();
    if (typeof account.username === 'string' && account.username.trim() !== '') {
      handles.add(account.username.trim().toLowerCase());
    }
    const legacyHandle = legacy.get(account.id);
    if (legacyHandle !== undefined) {
      handles.add(legacyHandle);
    }
    if (booked.has(key)) {
      skip('already_paid', 'this_run');
      continue;
    }
    if (paidInLedger(gifts, handles, payout, day)) {
      skip('already_paid', 'ledger');
      continue;
    }
    if (window.dryRun) {
      booked.add(key);
      event.status = 'would_pay';
      continue;
    }
    const outcome = await deps.pingOnDay(
      address,
      messageId,
      day,
      payout === 'daily' ? effectiveStatus(grant, nowMs) : undefined,
      payout,
    );
    if (outcome.status === 'accepted') {
      booked.add(key);
      event.status = 'paid';
    } else if (outcome.status === 'skipped' && outcome.reason === 'paid') {
      booked.add(key);
      skip('already_paid', 'spend');
    } else if (outcome.status === 'skipped') {
      skip('spend', outcome.reason);
    } else {
      event.status = 'failed';
    }
  }

  const count = (status: ReplayStatus): number =>
    events.filter((event) => event.status === status).length;
  return {
    events,
    totals: {
      events: events.length,
      paid: count('paid'),
      wouldPay: count('would_pay'),
      sent: count('sent'),
      wouldSend: count('would_send'),
      skipped: count('skipped'),
      failed: count('failed'),
    },
  };
}
