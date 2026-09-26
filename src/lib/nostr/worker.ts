import { isSundayRest } from '../sunday-rest';
import { readFile } from 'node:fs/promises';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import type { Account, AuthStore } from '@/lib/auth/store';
import { unsignedConversationDefaults, type ConversationThread } from '@/lib/conversation';
import { inboxUnreadCountFor, notifyConversationMessage } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import type { FundingStore } from '@/lib/funding-store';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
import type { FetchFn } from '@/lib/lnurlp';
import {
  MESSAGE_INBOUND_REPLY_MAX_LENGTH,
  MESSAGE_LIST_LIMIT,
  normalizeForumText,
  truncatePubkeyDisplay,
  type MessageRow,
} from '@/lib/message';
import { locationHashtagName } from '@/lib/location';
import type { MessageStore } from '@/lib/message-store';
import { notifyExternalForumReply, notifyForumReply } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { errorLogFields, logEvent } from '@/lib/log';
import { decryptKind4, unwrapNip17, wrapNip17 } from '@/lib/nostr/dm';
import {
  buildKind0Event,
  buildKind0Content,
  buildKind1Event,
  buildKind10002Event,
  forumExtraPhotoUrl,
  forumPhotoUrl,
  type Kind1Photo,
  type Kind1ReplyTo,
} from '@/lib/nostr/event';
import { nip05Domain, nip05Identifier } from '@/lib/nip05';
import { forumVideoUrl, isoBmffDisplaySize, resolveMediaDir, videoFilePath } from '@/lib/video';
import { decryptNostrSecret, ensureAccountNostrKey, zeroizeSecret } from '@/lib/nostr/keys';
import { publicAcked, spaceAcked, type NostrPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import {
  resolvePublicApiBase,
  resolveRelaySpace,
  resolveWriteSet,
  resolveZapRelays,
  writeRelayUrls,
  type ResolvedWriteSet,
} from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import type { PostRateLimiter } from '@/lib/nostr/rate-limit';
import { indexOpenZapReceipts } from '@/lib/nostr/zap-index';
import type { PushStore } from '@/lib/push-store';
import type { SpendPing } from '@/lib/spend-ping';
import {
  EXTERNAL_REPLY_FUTURE_SKEW_MS,
  EXTERNAL_REPLY_NOTIFY_MAX_AGE_MS,
  ExternalIngestLimiter,
  externalDisplayName,
  resolveExternalProfileName,
} from '@/lib/nostr/external';

/** Max rows claimed or keyed profile attempts per tick. */
export const WORKER_BATCH = 20;

/** Event-id chunk size for inbound kind:1 reply REQ filters. */
const REPLY_QUERY_CHUNK = 20;

/** Lease before WebSocket I/O. */
export const WORKER_LEASE_MS = 60_000;

/** Per-relay timeout. */
export const RELAY_TIMEOUT_MS = 5_000;

/** Tick interval. */
export const WORKER_INTERVAL_MS = 2_000;

/** Pause between full relay-ingest passes (zap receipts, inbound replies, inbound DMs). */
export const WORKER_INGEST_INTERVAL_MS = 30_000;

/** Look-back for in-app invoices whose zap receipt the fast lane polls. */
export const HOT_ZAP_WINDOW_MS = 60 * 60_000;

/** Seconds subtracted from the oldest hot invoice for the receipt `since` filter. */
export const HOT_ZAP_SINCE_SLACK_S = 600;

/** Newest invoice attempts scanned for hot zap targets. */
export const HOT_ZAP_INVOICE_LIMIT = 50;

/** Which part of the worker a tick runs. */
export type NostrWorkerTickMode = 'all' | 'fast' | 'ingest';

/** Collaborators for one worker tick. */
export interface NostrWorkerDeps {
  /** Forum store. */
  messages: MessageStore;
  /** Auth store (keys). */
  auth: AuthStore;
  /** AES KEK. */
  kek: Uint8Array;
  /** Publisher (fake in tests). */
  publisher: NostrPublisher;
  /** Querier for zap-receipt ingest (fake in tests). */
  querier: NostrQuerier;
  /** Fetch used for LNURL provider pubkey resolve. */
  fetchImpl: FetchFn;
  /** Optional 9735 signature check (tests inject; production uses nostr-tools). */
  verifyReceipt?: (event: NostrEventFrame) => boolean;
  /** Clock. */
  now: () => number;
  /** Env slice for write-set flags. */
  env: Record<string, string | undefined>;
  /** Optional push store (bell-subscriber list and outbox). */
  pushStore?: PushStore;
  /** Optional signature check for inbound kind:1 replies (tests inject). */
  verifyKind1?: (event: NostrEventFrame) => boolean;
  /** Optional external-reply limiter; one instance is retained per worker/store by default. */
  externalLimiter?: ExternalIngestLimiter;
  /** Optional private-message store (skip DMs when omitted). */
  conversations?: ConversationStore;
  /** Optional in-app store: inbound replies, notifyZap, profile-note notifyForumPost. */
  notificationStore?: NotificationStore;
  /** Optional spend ping after a platform-note compose creates a top-level post. */
  spendPing?: SpendPing;
  /** Optional post limiter shared with `POST /messages`. */
  postLimiter?: PostRateLimiter;
  /** Optional funding grants; compose spend pings use the same `eligibleToday` gate as `POST /messages`. */
  fundingStore?: FundingStore;
  /** Optional crosses for the one spot taken per newly indexed zap. */
  fiatRates?: FiatRateBook;
}

const externalLimiters = new WeakMap<MessageStore, ExternalIngestLimiter>();
const externalInFlightEventIds = new WeakMap<MessageStore, Set<string>>();

/** Resolve the injected limiter or retain one default limiter per message store. */
function externalLimiterFor(deps: NostrWorkerDeps): ExternalIngestLimiter {
  if (deps.externalLimiter !== undefined) {
    return deps.externalLimiter;
  }
  const existing = externalLimiters.get(deps.messages);
  if (existing !== undefined) {
    return existing;
  }
  const created = new ExternalIngestLimiter();
  externalLimiters.set(deps.messages, created);
  return created;
}

/** Retain external reply event ids currently being processed per message store. */
function externalInFlightFor(deps: NostrWorkerDeps): Set<string> {
  const existing = externalInFlightEventIds.get(deps.messages);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<string>();
  externalInFlightEventIds.set(deps.messages, created);
  return created;
}

type Kind0Reservation = {
  content: string;
  createdAt: number;
};

/** Reserved or last-acked kind:0 content per account, keyed by auth store. */
const profileCaches = new WeakMap<AuthStore, Map<string, Kind0Reservation>>();
const profileWatermarks = new WeakMap<AuthStore, Map<string, number>>();

function profileCacheFor(auth: AuthStore): Map<string, Kind0Reservation> {
  const existing = profileCaches.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Kind0Reservation>();
  profileCaches.set(auth, created);
  return created;
}

function profileWatermarkFor(auth: AuthStore): Map<string, number> {
  const existing = profileWatermarks.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, number>();
  profileWatermarks.set(auth, created);
  return created;
}

function reservedContent(
  cache: Map<string, Kind0Reservation>,
  accountId: string,
): string | undefined {
  return cache.get(accountId)?.content;
}

/**
 * Build the shared `indexOpenZapReceipts` argument object for full and hot calls.
 *
 * @param deps - Worker collaborators.
 * @param urls - Zap relay URLs (space + public list).
 * @returns Args object with identical optional collaborators for every call site.
 */
function indexOpenZapReceiptsArgs(
  deps: NostrWorkerDeps,
  urls: readonly string[],
): Parameters<typeof indexOpenZapReceipts>[0] {
  return {
    store: deps.messages,
    auth: deps.auth,
    querier: deps.querier,
    urls,
    timeoutMs: RELAY_TIMEOUT_MS,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    ...(deps.verifyReceipt === undefined ? {} : { verifyReceipt: deps.verifyReceipt }),
    ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
    ...(deps.notificationStore === undefined ? {} : { notificationStore: deps.notificationStore }),
    ...(deps.conversations === undefined ? {} : { conversations: deps.conversations }),
    ...(deps.spendPing === undefined ? {} : { spendPing: deps.spendPing }),
    ...(deps.postLimiter === undefined ? {} : { postLimiter: deps.postLimiter }),
    ...(deps.fundingStore === undefined ? {} : { fundingStore: deps.fundingStore }),
    ...(deps.fiatRates === undefined ? {} : { fiatRates: deps.fiatRates }),
  };
}

/**
 * First non-empty NIP-57 `e` tag from a stored invoice zap request.
 *
 * Same semantics as the private `zapRequestEventId` in `message-store.ts`:
 * `tags` must be an array; each tag an array with `tag[0] === 'e'` and a
 * non-empty string `tag[1]`.
 *
 * @param zapRequest - Stored zap request JSON, or null.
 * @returns First matching event id, or null.
 */
function zapRequestEventIdFromAttempt(zapRequest: Record<string, unknown> | null): string | null {
  const tags = zapRequest?.['tags'];
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string' && tag[1] !== '') {
      return tag[1];
    }
  }
  return null;
}

/**
 * Hot-lane zap ingest: poll receipts for recent in-app invoice e-tags only.
 * Targets come from {@link MessageStore.listRecentOkInvoiceAttempts}, which already
 * filters to `result = 'ok'` attempts created at or after the window start, so this
 * function does not re-check either condition.
 *
 * @param deps - Worker collaborators.
 * @param nowMs - Clock sample taken at the start of the fast tick.
 */
async function indexHotZapReceipts(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const attempts = await deps.messages.listRecentOkInvoiceAttempts(
    new Date(nowMs - HOT_ZAP_WINDOW_MS),
    HOT_ZAP_INVOICE_LIMIT,
  );
  const eventIds: string[] = [];
  const seen = new Set<string>();
  let oldestKeptCreatedAtMs: number | undefined;
  for (const attempt of attempts) {
    const createdAtMs = attempt.createdAt.getTime();
    const eventId = zapRequestEventIdFromAttempt(attempt.zapRequest);
    if (eventId === null) {
      continue;
    }
    if (oldestKeptCreatedAtMs === undefined || createdAtMs < oldestKeptCreatedAtMs) {
      oldestKeptCreatedAtMs = createdAtMs;
    }
    if (seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);
    eventIds.push(eventId);
  }
  if (oldestKeptCreatedAtMs === undefined) {
    return;
  }
  const urls = resolveZapRelays(deps.env);
  const since = Math.floor(oldestKeptCreatedAtMs / 1000) - HOT_ZAP_SINCE_SLACK_S;
  await indexOpenZapReceipts({
    ...indexOpenZapReceiptsArgs(deps, urls),
    eventIds,
    since,
  });
}

/**
 * Ingest zap receipts, then sign unsigned rows and optionally fan out to relays.
 *
 * Modes (`mode`, default `'all'`):
 * - `'all'`: today's full sequence — full `indexOpenZapReceipts`, resign/sign,
 *   publish when enabled, inbound kind:1 replies, inbound DMs, then
 *   `backfillProfileMessages`.
 * - `'fast'`: hot zap ingest for recent in-app invoice e-tags, then the same
 *   resign/sign/publish/`backfillProfileMessages` path. No full zap enumeration,
 *   no inbound replies, no inbound DMs.
 * - `'ingest'`: full `indexOpenZapReceipts` (incl. `retryGiftReplies`), then
 *   inbound replies and DMs. No sign, publish, or `backfillProfileMessages`.
 *
 * Always signs on `'all'` / `'fast'`. Publishes only when `NOSTR_PUBLISH=1`.
 * Public relays only when `NOSTR_PUBLISH_PUBLIC=1`. Space ACK with public off
 * is terminal `published`/`space`. With public on, space-only ACK parks
 * `pending`/`space` until a public ACK makes `published`/`public`. Pending
 * kind:1 JSON without `t=bitcoin` is dropped and re-signed before fan-out.
 * Then unsigned rows are signed. Then published unpaid rows missing a photo
 * URL or a video URL (`PUBLIC_BASE_URL` set) or Damus `#bitcoin`/`#21gifts`
 * (and, when `account.location` is set, the location hashtag) in content are
 * reset for the next tick (`profileMessageId` rows are skipped so a name note
 * is not rewritten with those hashtags; location is never applied to profile
 * notes). Pending rows EVENT as-is — resetting them first renews the 60s sign
 * lease and they never reach a relay. Zapped rows (`sats !== 0`) keep their
 * event id so receipts still resolve. An empty API base skips photo- and
 * video-URL resign so it cannot un-publish and loop. When publishing, also
 * fans out a replaceable kind:0 profile (`name` / `display_name` / `picture`,
 * optional `nip05`) and a NIP-65 kind:10002 relay list. Kind:1 photo and video
 * posts include the public media URL and an `imeta` tag (video may add poster
 * `image`). Kind:0 `created_at` is `max(wall clock, last issued + 1)` so an
 * in-flight older profile cannot win a same-second replaceable-event tie.
 * Zap ingest runs at the **start** of `'all'` / `'fast'` ticks (full or hot),
 * before resign/sign/publish, so receipt indexing is not delayed by relay
 * publish timeouts. `nowMs` for sign/publish leases is sampled only after zap
 * ingest returns, so an overlapping fast tick cannot reclaim with a later
 * clock while this tick still signs/publishes under a stale lease time. Full
 * ingest queries zap relays (space plus the public list, even when
 * `NOSTR_PUBLISH_PUBLIC` is off) for kind:9735 receipts and indexes validated
 * ones onto `sats`, even when publish is off. After sign/publish, `'all'` (and
 * the ingest lane) also REQs kind:1 replies (`#e` = our note event ids) and
 * persists inbound replies whose pubkey maps to a 21.gifts account or to an
 * entitled, unblocked external zapper (even when publish is off). Other npubs
 * are skipped. After a member reply is stored, `notifyForumReply` always runs
 * with `auth` (in-app every account except the actor; no-op when the actor is
 * the official platform account; Web Push only to bell subscribers). Failures
 * log `nostr.reply.notify.failed` and do not undo persist. Zap ingest still
 * calls `notifyZap` after a newly indexed **member-note** forum receipt. A
 * member/invoice zap on the official platform profile note is a compose fee:
 * skip `notifyZap`, then fan out `notifyForumPost` / `notifyForumReply` plus a
 * top-level `spendPing` only when `eligibleToday` (same gate as
 * `POST /messages`; otherwise `spend.ping.skipped` / `not_eligible`). An
 * external zap on that same note still inserts `insertExternalGiftReply`. PN
 * ingest appends a conversation gift (`appendConversationGift`) and does not
 * call `notifyZap`. A member-note gift-reply does not call `notifyForumReply`.
 * When a conversation store is present, `'all'` / `'fast'` also
 * signs/publishes NIP-17 wraps; `'all'` / `'ingest'` REQs inbound kind:1059 /
 * kind:4 to member and platform pubkeys. Fast-lane ticks are not serialised
 * (`setInterval` does not await the previous tick); the ingest lane waits for
 * each pass to settle before scheduling the next.
 *
 * @param deps - Stores, kek, publisher, querier, fetch, clock, env.
 * @param mode - Which lane work to run (default `'all'`).
 * @returns Resolves when the selected work has finished (notify failures are
 *   swallowed).
 */
export async function runNostrWorkerTick(
  deps: NostrWorkerDeps,
  mode: NostrWorkerTickMode = 'all',
): Promise<void> {
  if (isSundayRest(deps.now())) return;
  const writeSet = resolveWriteSet(deps.env);
  const urls = resolveZapRelays(deps.env);
  if (mode === 'ingest') {
    if (isSundayRest(deps.now())) return;
    await indexOpenZapReceipts(indexOpenZapReceiptsArgs(deps, urls));
    if (isSundayRest(deps.now())) return;
    await indexInboundForumReplies(deps, urls);
    if (isSundayRest(deps.now())) return;
    await indexInboundDirectMessages(deps, urls);
    return;
  }
  if (mode === 'fast') {
    if (isSundayRest(deps.now())) return;
    await indexHotZapReceipts(deps, deps.now());
  } else {
    if (isSundayRest(deps.now())) return;
    await indexOpenZapReceipts(indexOpenZapReceiptsArgs(deps, urls));
  }
  const nowMs = deps.now();
  if (isSundayRest(deps.now())) return;
  await resignLegacyKind1Tags(deps);
  if (isSundayRest(deps.now())) return;
  await signBatch(deps, nowMs);
  if (isSundayRest(deps.now())) return;
  await signConversationBatch(deps, nowMs);
  if (isSundayRest(deps.now())) return;
  await resignPhotoKind1(deps);
  if (isSundayRest(deps.now())) return;
  await resignVideoKind1(deps);
  if (isSundayRest(deps.now())) return;
  await resignHashtagKind1(deps);
  if (writeSet.publishEnabled) {
    if (isSundayRest(deps.now())) return;
    await publishProfiles(deps, writeSet);
    if (isSundayRest(deps.now())) return;
    await publishRelayLists(deps, writeSet);
    if (isSundayRest(deps.now())) return;
    await publishBatch(deps, writeSet, nowMs);
    if (isSundayRest(deps.now())) return;
    await publishConversationBatch(deps, writeSet, nowMs);
  }
  if (mode === 'all') {
    if (isSundayRest(deps.now())) return;
    await indexInboundForumReplies(deps, urls);
    if (isSundayRest(deps.now())) return;
    await indexInboundDirectMessages(deps, urls);
  }
  if (isSundayRest(deps.now())) return;
  await backfillProfileMessages(deps);
}

/**
 * Verify a queried kind:1 frame is a signed Nostr event.
 *
 * @param event - Frame from a relay.
 * @returns Whether nostr-tools accepts the signature.
 */
function defaultVerifyKind1(event: NostrEventFrame): boolean {
  if (typeof event.created_at !== 'number' || typeof event.sig !== 'string' || event.sig === '') {
    return false;
  }
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content ?? '',
      sig: event.sig,
    });
    /* v8 ignore next 3 -- nostr-tools verifyEvent returns boolean, does not throw */
  } catch {
    return false;
  }
}

/**
 * Project a queried kind:1 frame to the JSON object stored on the reply row.
 *
 * @param event - Frame from a relay.
 * @param content - Event content (empty string when the frame omitted it).
 * @param sig - Signature hex (empty string when the frame omitted it).
 * @returns JSON object stored on the reply row.
 */
function kind1Frame(event: NostrEventFrame, content: string, sig: string): Record<string, unknown> {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    tags: event.tags,
    created_at: event.created_at,
    content,
    sig,
  };
}

/**
 * Pick the parent note event id from NIP-10 `e` tags.
 *
 * Prefers `reply`, then `root`, then the first matching `e` whose id is in
 * `noteEventIds`. Does not require `t=21gifts`.
 *
 * @param tags - Event tags.
 * @param noteEventIds - Top-level published note event ids.
 * @returns Matching note event id, or null.
 */
function pickParentNoteEventId(tags: string[][], noteEventIds: ReadonlySet<string>): string | null {
  let replyMatch: string | null = null;
  let rootMatch: string | null = null;
  let firstMatch: string | null = null;
  for (const tag of tags) {
    if (tag[0] !== 'e' || typeof tag[1] !== 'string' || tag[1] === '') {
      continue;
    }
    if (!noteEventIds.has(tag[1])) {
      continue;
    }
    const marker = tag[3];
    if (marker === 'reply' && replyMatch === null) {
      replyMatch = tag[1];
    } else if (marker === 'root' && rootMatch === null) {
      rootMatch = tag[1];
    }
    if (firstMatch === null) {
      firstMatch = tag[1];
    }
  }
  return replyMatch ?? rootMatch ?? firstMatch;
}

/**
 * REQ kind:1 replies referencing our published top-level notes and persist
 * those whose pubkey maps to a member or an entitled external zapper.
 *
 * Runs on the ingest lane / mode `'all'` (even when `NOSTR_PUBLISH` is off).
 * Does not require `t=21gifts`. Skips invalid signatures, already-stored event
 * ids, empty / over-long content, events that equal the parent note id, and
 * unknown or blocked npubs (same silent skip as an empty event id). Member
 * replies posted from Damus with the custodial key still persist (named, or
 * nameless via {@link truncatePubkeyDisplay}). After a successful persist, fans
 * out via {@link notifyForumReply} (in-app every account except the actor;
 * no-op when the actor is the official platform account; Web Push only to bell
 * subscribers); notify failure logs `nostr.reply.notify.failed`
 * and does not fail persist.
 *
 * @param deps - Worker collaborators.
 * @param urls - Zap relay URLs (space + public list).
 */
async function indexInboundForumReplies(
  deps: NostrWorkerDeps,
  urls: readonly string[],
): Promise<void> {
  /* v8 ignore next 3 -- no zap relays configured */
  if (urls.length === 0) {
    return;
  }
  const noteEventIds = await deps.messages.listPublishedEventIds(MESSAGE_LIST_LIMIT);
  if (noteEventIds.length === 0) {
    return;
  }
  const noteIdSet = new Set(noteEventIds);
  const verify = deps.verifyKind1 ?? defaultVerifyKind1;
  const accounts = await deps.auth.listAccounts();
  const pubkeyToAccount = new Map<string, { id: string; name: string | null }>();
  for (const account of accounts) {
    const pubkey = await deps.auth.getNostrPublicKey(account.id);
    if (pubkey === undefined || pubkey === '') {
      continue;
    }
    pubkeyToAccount.set(pubkey.toLowerCase(), { id: account.id, name: account.name });
  }
  const zappers = new Set(
    (await deps.messages.listZapperPubkeys()).map((value) => value.toLowerCase()),
  );
  const blocked = new Set(
    (await deps.messages.listBlockedPubkeys()).map((value) => value.toLowerCase()),
  );
  const limiter = externalLimiterFor(deps);
  const externalInFlight = externalInFlightFor(deps);
  const accountNames = accounts
    .map((account) => account.name)
    .filter((value): value is string => value !== null);

  for (let i = 0; i < noteEventIds.length; i += REPLY_QUERY_CHUNK) {
    const chunk = noteEventIds.slice(i, i + REPLY_QUERY_CHUNK);
    const events = await deps.querier.query({ kinds: [1], '#e': chunk }, urls, RELAY_TIMEOUT_MS);
    for (const event of events) {
      if (event.kind !== 1) {
        continue;
      }
      if (typeof event.id !== 'string' || event.id === '') {
        continue;
      }
      if (typeof event.pubkey !== 'string' || event.pubkey === '') {
        continue;
      }
      const pubkey = event.pubkey.toLowerCase();
      const matched = pubkeyToAccount.get(pubkey);
      const external = matched === undefined;
      if (external && (!zappers.has(pubkey) || blocked.has(pubkey))) {
        continue;
      }
      if (!verify(event)) {
        continue;
      }
      const existing = await deps.messages.getByEventId(event.id);
      if (existing !== undefined) {
        continue;
      }
      const parentEventId = pickParentNoteEventId(event.tags, noteIdSet);
      if (parentEventId === null || parentEventId === event.id) {
        continue;
      }
      const parentNote = await deps.messages.getByEventId(parentEventId);
      if (parentNote === undefined || parentNote.parentId !== null) {
        continue;
      }
      const rawContent = event.content ?? '';
      const rawSig = event.sig ?? '';
      const text = normalizeForumText(rawContent, MESSAGE_INBOUND_REPLY_MAX_LENGTH);
      if (text === null || text === '') {
        continue;
      }
      const nowMs = deps.now();
      if (external) {
        if (externalInFlight.has(event.id)) {
          continue;
        }
        externalInFlight.add(event.id);
      }
      try {
        let accountId: string | null;
        let name: string;
        let authorPubkey: string;
        if (matched !== undefined) {
          accountId = matched.id;
          const accountName = matched.name?.trim() ?? '';
          name = accountName !== '' ? accountName : truncatePubkeyDisplay(event.pubkey);
          authorPubkey = event.pubkey;
        } else {
          accountId = null;
          authorPubkey = pubkey;
          const profileName = await resolveExternalProfileName({
            querier: deps.querier,
            urls,
            pubkey,
            nowMs,
            timeoutMs: RELAY_TIMEOUT_MS,
          });
          name = externalDisplayName({ profileName, pubkey, accountNames });
        }
        const eventMs = typeof event.created_at === 'number' ? event.created_at * 1000 : nowMs;
        const createdAt = new Date(Math.min(eventMs, nowMs));
        if (external && (await deps.messages.isPubkeyBlocked(pubkey))) {
          continue;
        }
        if (external && !limiter.tryAcquire(pubkey, nowMs)) {
          continue;
        }
        try {
          const created = await deps.messages.create({
            id: crypto.randomUUID(),
            accountId,
            name,
            text,
            createdAt,
            hasPhoto: false,
            hasVideo: false,
            videoContentType: null,
            parentId: parentNote.id,
            authorPubkey,
            eventId: event.id,
            nostrPublishState: 'published',
            sats: 0,
            nostrEvent: kind1Frame(event, rawContent, rawSig),
            claimedUntil: null,
            nostrFirstAttemptAt: null,
            nostrPublishEpoch: null,
            nostrAttempts: 0,
            deletedAt: null,
            deletedBy: null,
          });
          try {
            const notificationDeps = {
              auth: deps.auth,
              ...(deps.notificationStore === undefined
                ? {}
                : { notifications: deps.notificationStore }),
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
              /* v8 ignore next 3 -- production worker always has conversationStore */
              ...(deps.conversations === undefined
                ? {}
                : { inboxUnreadCount: inboxUnreadCountFor(deps.conversations, deps.auth) }),
            };
            if (external) {
              if (
                typeof event.created_at === 'number' &&
                eventMs <= nowMs + EXTERNAL_REPLY_FUTURE_SKEW_MS &&
                nowMs - eventMs <= EXTERNAL_REPLY_NOTIFY_MAX_AGE_MS
              ) {
                await notifyExternalForumReply({
                  ...notificationDeps,
                  parent: parentNote,
                  created,
                });
              }
            } else {
              /* v8 ignore next -- the member branch always has an account id */
              if (accountId === null) continue;
              await notifyForumReply({
                ...notificationDeps,
                messages: deps.messages,
                account: { id: accountId },
                created,
                parentId: parentNote.id,
              });
            }
          } catch {
            logEvent('nostr.reply.notify.failed', { eventId: event.id });
          }
        } catch {
          if (external) {
            limiter.release(pubkey, nowMs);
          }
          logEvent('nostr.reply.inbound.failed', { eventId: event.id });
        }
      } finally {
        if (external) {
          externalInFlight.delete(event.id);
        }
      }
    }
  }
}

/**
 * Drop stored kind:1 JSON that predates `t=bitcoin` so `signBatch` rebuilds it.
 */
async function resignLegacyKind1Tags(deps: NostrWorkerDeps): Promise<void> {
  const rows = await deps.messages.listPendingSigned(WORKER_BATCH);
  for (const row of rows) {
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
    }
  }
}

async function resetPublishedBatch(deps: NostrWorkerDeps, rows: MessageRow[]): Promise<void> {
  for (const row of rows) {
    await deps.messages.resetSignedEvent(row.id, row.eventId);
  }
}

async function resignPhotoKind1(deps: NostrWorkerDeps): Promise<void> {
  if (resolvePublicApiBase(deps.env) === '') {
    return;
  }
  await resetPublishedBatch(deps, await deps.messages.listSignedMissingPhoto(WORKER_BATCH));
}

async function resignVideoKind1(deps: NostrWorkerDeps): Promise<void> {
  if (resolvePublicApiBase(deps.env) === '') {
    return;
  }
  await resetPublishedBatch(deps, await deps.messages.listSignedMissingVideo(WORKER_BATCH));
}

async function resignHashtagKind1(deps: NostrWorkerDeps): Promise<void> {
  const accounts = await deps.auth.listAccounts();
  const profileIds = new Set(
    accounts
      .map((account) => account.profileMessageId)
      .filter((id): id is string => typeof id === 'string' && id !== ''),
  );
  const extras = new Map<string, readonly string[]>();
  for (const account of accounts) {
    const name = locationHashtagName(account.location);
    if (name !== null) extras.set(account.id, [name]);
  }
  const rows = await deps.messages.listSignedMissingHashtags(WORKER_BATCH, extras, profileIds);
  await resetPublishedBatch(deps, rows);
}

function kind1HasBitcoinTag(event: Record<string, unknown> | null): boolean {
  if (event === null) {
    return false;
  }
  const tags = event['tags'];
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === 'bitcoin');
}

async function signBatch(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const ids = await deps.auth.listAccountIdsWithoutNostrKey(WORKER_BATCH);
  for (const accountId of ids) {
    try {
      await ensureAccountNostrKey(deps.auth, accountId, deps.kek);
    } catch {
      logEvent('nostr.keygen.backfill.failed', { accountId });
    }
  }
  const rows = await deps.messages.claimUnsigned(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const spaceRelay = resolveRelaySpace(deps.env);
  for (const row of rows) {
    if (row.accountId === null) {
      continue;
    }
    try {
      await ensureAccountNostrKey(deps.auth, row.accountId, deps.kek);
      let createdAt = Math.floor(row.createdAt.getTime() / 1000);
      let stored = false;
      const apiBase = resolvePublicApiBase(deps.env);
      let photo: Kind1Photo | undefined;
      let extraPhotos: Kind1Photo[] | undefined;
      if (apiBase !== '') {
        const storedPhoto = await deps.messages.getPhoto(row.id);
        const videoMime = row.videoContentType;
        if (videoMime !== null && videoMime !== undefined && row.hasVideo === true) {
          photo = {
            url: forumVideoUrl(apiBase, row.id, videoMime),
            mime: videoMime,
            ...(storedPhoto !== null
              ? { posterUrl: forumPhotoUrl(apiBase, row.id, storedPhoto.contentType) }
              : {}),
          };
          try {
            const fileBytes = new Uint8Array(
              await readFile(
                videoFilePath(resolveMediaDir({ ...process.env, ...deps.env }), row.id, videoMime),
              ),
            );
            const dim = isoBmffDisplaySize(fileBytes);
            if (dim !== null) {
              photo.dim = `${dim.width}x${dim.height}`;
              photo.size = fileBytes.byteLength;
            }
          } catch {
            /* missing or unreadable file — omit dim/size */
          }
        } else if (storedPhoto !== null) {
          photo = {
            url: forumPhotoUrl(apiBase, row.id, storedPhoto.contentType),
            mime: storedPhoto.contentType,
          };
          const storedExtras = await deps.messages.listExtraPhotos(row.id);
          if (storedExtras.length > 0) {
            extraPhotos = storedExtras.map((item, i) => ({
              url: forumExtraPhotoUrl(apiBase, row.id, i + 1, item.contentType),
              mime: item.contentType,
            }));
          }
        } else if (row.hasPhoto) {
          logEvent('nostr.sign.photo_url_missing', { messageId: row.id });
        }
      }
      let replyTo: Kind1ReplyTo | undefined;
      if (row.parentId !== null) {
        const parent = await deps.messages.getById(row.parentId);
        if (parent === undefined || parent.eventId === null) {
          continue;
        }
        let noteAuthorPubkey = parent.authorPubkey;
        if (noteAuthorPubkey === null && parent.accountId !== null) {
          /* v8 ignore next -- parent account has no stored pubkey */
          noteAuthorPubkey = (await deps.auth.getNostrPublicKey(parent.accountId)) ?? null;
        }
        if (noteAuthorPubkey === null) {
          logEvent('nostr.sign.failed', { messageId: row.id, reason: 'parent_pubkey' });
          continue;
        }
        replyTo = {
          noteEventId: parent.eventId,
          spaceRelay,
          noteAuthorPubkey,
        };
      }
      const account = await deps.auth.getAccount(row.accountId);
      const isProfile = account?.profileMessageId === row.id;
      const location = isProfile ? null : (account?.location ?? null);
      for (let attempt = 0; attempt < 2 && !stored; attempt += 1) {
        const unsigned =
          extraPhotos !== undefined
            ? buildKind1Event(row.text, createdAt, photo, replyTo, location, extraPhotos)
            : photo === undefined
              ? buildKind1Event(row.text, createdAt, undefined, replyTo, location)
              : buildKind1Event(row.text, createdAt, photo, replyTo, location);
        const signed = await signEventForAccount(deps.auth, row.accountId, deps.kek, unsigned);
        stored = await deps.messages.updateSignedEvent(
          row.id,
          signed.id,
          signed as unknown as Record<string, unknown>,
        );
        if (!stored) {
          createdAt += 1;
        }
      }
      if (!stored) {
        logEvent('nostr.sign.failed', { messageId: row.id, reason: 'event_id' });
      }
      /* v8 ignore next 3 -- sign/decrypt failures */
    } catch {
      logEvent('nostr.sign.failed', { messageId: row.id });
    }
  }
}

/**
 * Create a profile forum note for named accounts with a non-blank Lightning
 * Address that lack one (or whose stored id no longer points at a message
 * row). `ensureProfileMessage` no-ops without LN.
 *
 * @param deps - Auth and message stores (and optional push / notifications).
 */
async function backfillProfileMessages(deps: NostrWorkerDeps): Promise<void> {
  const accounts = await deps.auth.listAccounts();
  for (const account of accounts) {
    if (account.name === null || account.name.trim() === '') {
      continue;
    }
    const profileId = account.profileMessageId;
    if (typeof profileId === 'string' && profileId.trim() !== '') {
      const existing = await deps.messages.getById(profileId);
      if (existing !== undefined) {
        continue;
      }
    }
    await ensureProfileMessage({
      auth: deps.auth,
      messages: deps.messages,
      account,
      now: deps.now,
      ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
      ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
      ...(deps.conversations === undefined ? {} : { conversations: deps.conversations }),
    });
  }
}

async function publishProfiles(deps: NostrWorkerDeps, writeSet: ResolvedWriteSet): Promise<void> {
  const cache = profileCacheFor(deps.auth);
  const watermarks = profileWatermarkFor(deps.auth);
  const urls = writeRelayUrls(writeSet);
  const accounts = await deps.auth.listAccounts();
  const named = accounts.filter((row) => row.name !== null && row.name.trim() !== '');
  const domain = nip05Domain(deps.env);
  let attempted = 0;
  for (const account of accounts) {
    if (attempted >= WORKER_BATCH) {
      break;
    }
    const live = await deps.auth.getAccount(account.id);
    if (live === undefined || live.name === null) {
      continue;
    }
    const namedForLive = named.map((row) => (row.id === live.id ? live : row));
    const nip05 = domain === null ? null : nip05Identifier(live, namedForLive, domain);
    let about = '21.gifts';
    const profileId = live.profileMessageId;
    if (typeof profileId === 'string' && profileId.trim() !== '') {
      const note = await deps.messages.getById(profileId);
      if (note !== undefined) {
        about = note.text;
      }
    }
    const content = buildKind0Content(live.name, live.lightningAddress, nip05, about);
    if (reservedContent(cache, live.id) === content) {
      continue;
    }
    const previous = cache.get(live.id);
    const reservation: Kind0Reservation = {
      content,
      createdAt: Math.max(previous?.createdAt ?? 0, watermarks.get(live.id) ?? 0),
    };
    cache.set(live.id, reservation);
    try {
      const pubkey = await deps.auth.getNostrPublicKey(live.id);
      if (pubkey === undefined) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        continue;
      }
      attempted += 1;
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const wall = Math.floor(deps.now() / 1000);
      reservation.createdAt = Math.max(wall, reservation.createdAt + 1);
      watermarks.set(live.id, reservation.createdAt);
      const unsigned = buildKind0Event(
        live.name,
        live.lightningAddress,
        reservation.createdAt,
        nip05,
        about,
      );
      const signed = await signEventForAccount(deps.auth, live.id, deps.kek, unsigned);
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const acks = await deps.publisher.publish(
        signed as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
      const spaceOk = spaceAcked(acks, writeSet.spaceUrl);
      const publicOk = !writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl);
      if (!spaceOk || !publicOk) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        logEvent('nostr.profile.nack', { accountId: live.id });
        continue;
      }
      logEvent('nostr.profile.ok', { accountId: live.id });
    } catch {
      if (cache.get(live.id) === reservation) {
        cache.delete(live.id);
      }
      logEvent('nostr.profile.nack', { accountId: live.id });
    }
  }
}

const relayListCaches = new WeakMap<AuthStore, Map<string, Kind0Reservation>>();
const relayListWatermarks = new WeakMap<AuthStore, Map<string, number>>();

function relayListCacheFor(auth: AuthStore): Map<string, Kind0Reservation> {
  const existing = relayListCaches.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Kind0Reservation>();
  relayListCaches.set(auth, created);
  return created;
}

function relayListWatermarkFor(auth: AuthStore): Map<string, number> {
  const existing = relayListWatermarks.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, number>();
  relayListWatermarks.set(auth, created);
  return created;
}

async function publishRelayLists(deps: NostrWorkerDeps, writeSet: ResolvedWriteSet): Promise<void> {
  const cache = relayListCacheFor(deps.auth);
  const watermarks = relayListWatermarkFor(deps.auth);
  const urls = writeRelayUrls(writeSet);
  const content = urls.join('\n');
  const accounts = await deps.auth.listAccounts();
  let attempted = 0;
  for (const account of accounts) {
    if (attempted >= WORKER_BATCH) {
      break;
    }
    const live = await deps.auth.getAccount(account.id);
    if (live === undefined || live.name === null) {
      continue;
    }
    if (reservedContent(cache, live.id) === content) {
      continue;
    }
    const previous = cache.get(live.id);
    const reservation: Kind0Reservation = {
      content,
      createdAt: Math.max(previous?.createdAt ?? 0, watermarks.get(live.id) ?? 0),
    };
    cache.set(live.id, reservation);
    try {
      const pubkey = await deps.auth.getNostrPublicKey(live.id);
      if (pubkey === undefined) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        continue;
      }
      attempted += 1;
      /* v8 ignore next 3 -- overlapping tick replaced the reservation */
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const wall = Math.floor(deps.now() / 1000);
      reservation.createdAt = Math.max(wall, reservation.createdAt + 1);
      watermarks.set(live.id, reservation.createdAt);
      const unsigned = buildKind10002Event(urls, reservation.createdAt);
      const signed = await signEventForAccount(deps.auth, live.id, deps.kek, unsigned);
      /* v8 ignore next 3 -- overlapping tick replaced the reservation */
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const acks = await deps.publisher.publish(
        signed as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
      const spaceOk = spaceAcked(acks, writeSet.spaceUrl);
      const publicOk = !writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl);
      if (!spaceOk || !publicOk) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        logEvent('nostr.relays.nack', { accountId: live.id });
        continue;
      }
      logEvent('nostr.relays.ok', { accountId: live.id });
    } catch {
      if (cache.get(live.id) === reservation) {
        cache.delete(live.id);
      }
      logEvent('nostr.relays.nack', { accountId: live.id });
    }
  }
}

async function publishBatch(
  deps: NostrWorkerDeps,
  writeSet: ResolvedWriteSet,
  nowMs: number,
): Promise<void> {
  const rows = await deps.messages.claimUnpublished(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const urls = writeRelayUrls(writeSet);
  for (const row of rows) {
    /* v8 ignore next 3 -- signed rows always store nostrEvent */
    if (row.nostrEvent === null) {
      continue;
    }
    /* v8 ignore start -- overlapping tick may still hold a pre-resign snapshot */
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
      continue;
    }
    /* v8 ignore stop */
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (!writeSet.publicEnabled) {
        await deps.messages.updatePublishState(row.id, 'published', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, epoch: 'space' });
      } else if (publicAcked(acks, writeSet.spaceUrl)) {
        await deps.messages.updatePublishState(row.id, 'published', 'public');
        logEvent('nostr.publish.ok', { messageId: row.id });
      } else {
        await deps.messages.updatePublishState(row.id, 'pending', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, parked: 1 });
      }
    } catch {
      logEvent('nostr.publish.nack', { messageId: row.id });
    }
  }
}

function asNostrEvent(event: NostrEventFrame): NostrEvent | null {
  if (typeof event.created_at !== 'number' || typeof event.sig !== 'string' || event.sig === '') {
    return null;
  }
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content ?? '',
    sig: event.sig,
  };
}

async function accountsByPubkey(auth: AuthStore): Promise<Map<string, Account>> {
  const map = new Map<string, Account>();
  const accounts = await auth.listAccounts();
  for (const account of accounts) {
    const pubkey = await auth.getNostrPublicKey(account.id);
    /* v8 ignore next 3 -- accounts without a stored key are skipped */
    if (pubkey === undefined || pubkey === '') {
      continue;
    }
    map.set(pubkey.toLowerCase(), account);
  }
  return map;
}

async function recipientPubkeyFor(
  thread: ConversationThread,
  senderAccountId: string,
  auth: AuthStore,
): Promise<string | null> {
  if (thread.kind === 'member_damus') {
    return thread.counterpartPubkey;
  }
  if (thread.kind === 'member_platform' && thread.accountA === senderAccountId) {
    const accounts = await auth.listAccounts();
    const platform = accounts.find((account) => account.isPlatform === true);
    if (platform !== undefined && platform.id !== senderAccountId) {
      const pubkey = await auth.getNostrPublicKey(platform.id);
      if (pubkey !== undefined && pubkey !== '') {
        return pubkey.toLowerCase();
      }
    }
  }
  /* v8 ignore next -- sender is always one of the two account ids */
  const otherId = thread.accountA === senderAccountId ? thread.accountB : thread.accountA;
  /* v8 ignore next 3 -- member_member/platform threads always have the other id */
  if (otherId === null) {
    return null;
  }
  const pubkey = await auth.getNostrPublicKey(otherId);
  /* v8 ignore next -- missing counterpart key */
  return pubkey === undefined || pubkey === '' ? null : pubkey.toLowerCase();
}

async function withAccountSecret<T>(
  deps: NostrWorkerDeps,
  accountId: string,
  fn: (secret: Uint8Array) => Promise<T> | T,
): Promise<T | null> {
  const ciphertext = await deps.auth.getNostrSecret(accountId);
  if (ciphertext === undefined) {
    return null;
  }
  const secret = await decryptNostrSecret(ciphertext, deps.kek, accountId);
  try {
    return await fn(secret);
  } finally {
    zeroizeSecret(secret);
  }
}

async function signConversationBatch(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const store = deps.conversations;
  if (store === undefined) {
    return;
  }
  const rows = await store.claimUnsigned(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  for (const row of rows) {
    if (row.senderAccountId === null) {
      continue;
    }
    const thread = await store.getById(row.conversationId);
    if (thread === undefined) {
      continue;
    }
    try {
      await ensureAccountNostrKey(deps.auth, row.senderAccountId, deps.kek);
      const recipient = await recipientPubkeyFor(thread, row.senderAccountId, deps.auth);
      if (recipient === null) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'recipient_pubkey' });
        continue;
      }
      const wrap = await withAccountSecret(deps, row.senderAccountId, (secret) =>
        wrapNip17(secret, recipient, row.text),
      );
      if (wrap === null) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'secret' });
        continue;
      }
      const stored = await store.updateSignedEvent(
        row.id,
        wrap.id,
        wrap as unknown as Record<string, unknown>,
      );
      if (!stored) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'event_id' });
      }
    } catch {
      logEvent('nostr.dm.sign.failed', { messageId: row.id });
    }
  }
}

async function publishConversationBatch(
  deps: NostrWorkerDeps,
  writeSet: ResolvedWriteSet,
  nowMs: number,
): Promise<void> {
  const store = deps.conversations;
  if (store === undefined) {
    return;
  }
  const rows = await store.claimUnpublished(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const urls = writeRelayUrls(writeSet);
  for (const row of rows) {
    if (row.nostrEvent === null) {
      continue;
    }
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.dm.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (!writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl)) {
        await store.updatePublishState(row.id, 'published');
        logEvent('nostr.dm.publish.ok', { messageId: row.id });
      } else {
        await store.updatePublishState(row.id, 'pending');
        logEvent('nostr.dm.publish.ok', { messageId: row.id, parked: 1 });
      }
    } catch {
      logEvent('nostr.dm.publish.nack', { messageId: row.id });
    }
  }
}

async function indexInboundDirectMessages(
  deps: NostrWorkerDeps,
  urls: readonly string[],
): Promise<void> {
  const store = deps.conversations;
  if (store === undefined || urls.length === 0) {
    return;
  }
  const byPubkey = await accountsByPubkey(deps.auth);
  const ourPubkeys = [...byPubkey.keys()];
  if (ourPubkeys.length === 0) {
    return;
  }
  const verify = deps.verifyKind1 ?? defaultVerifyKind1;
  for (let i = 0; i < ourPubkeys.length; i += REPLY_QUERY_CHUNK) {
    const chunk = ourPubkeys.slice(i, i + REPLY_QUERY_CHUNK);
    const events = await deps.querier.query(
      { kinds: [4, 1059], '#p': chunk },
      urls,
      RELAY_TIMEOUT_MS,
    );
    for (const event of events) {
      if (event.kind !== 4 && event.kind !== 1059) {
        continue;
      }
      if (typeof event.id !== 'string' || event.id === '') {
        continue;
      }
      if (!verify(event)) {
        continue;
      }
      const existing = await store.getMessageByEventId(event.id);
      if (existing !== undefined) {
        continue;
      }
      const signed = asNostrEvent(event);
      if (signed === null) {
        continue;
      }
      const pTags = event.tags.filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string');
      let ingested = false;
      for (const tag of pTags) {
        const tagged = tag[1];
        /* v8 ignore next 3 -- p-tags are filtered to strings */
        if (tagged === undefined) {
          continue;
        }
        const recipientPubkey = tagged.toLowerCase();
        const recipient = byPubkey.get(recipientPubkey);
        if (recipient === undefined || ingested) {
          continue;
        }
        try {
          const plain = await withAccountSecret(
            deps,
            recipient.id,
            (secret): { senderPubkey: string; text: string; createdAt: number } | null => {
              if (event.kind === 1059) {
                return unwrapNip17(signed, secret);
              }
              const text = decryptKind4(secret, event.pubkey, event.content ?? '');
              const envelopeAt = event.created_at;
              if (text === null || typeof envelopeAt !== 'number') {
                return null;
              }
              return {
                senderPubkey: event.pubkey.toLowerCase(),
                text,
                createdAt: envelopeAt,
              };
            },
          );
          if (plain === null) {
            continue;
          }
          const text = normalizeForumText(plain.text, MESSAGE_INBOUND_REPLY_MAX_LENGTH);
          if (text === null || text === '') {
            continue;
          }
          const senderPubkey = plain.senderPubkey.toLowerCase();
          if (senderPubkey === recipientPubkey) {
            continue;
          }
          const sender = byPubkey.get(senderPubkey);
          const createdAt = new Date(plain.createdAt * 1000);
          let thread: ConversationThread;
          if (sender !== undefined) {
            if (sender.isPlatform === true || recipient.isPlatform === true) {
              const member = sender.isPlatform === true ? recipient : sender;
              const platform = sender.isPlatform === true ? sender : recipient;
              thread = await store.openMemberPlatform(member.id, platform.id, createdAt);
            } else {
              thread = await store.openMemberMember(sender.id, recipient.id, createdAt);
            }
          } else {
            thread = await store.openMemberDamus(recipient.id, senderPubkey, createdAt);
          }
          const liveName = sender?.name?.trim() ?? '';
          const senderName = liveName !== '' ? liveName : truncatePubkeyDisplay(senderPubkey);
          const created = await store.appendMessage({
            id: crypto.randomUUID(),
            conversationId: thread.id,
            text,
            createdAt,
            senderAccountId: sender?.id ?? null,
            senderPubkey,
            name: senderName,
            ...unsignedConversationDefaults(),
            actorAccountId: sender?.id ?? null,
            actorName: sender === undefined ? '' : senderName,
            eventId: event.id,
            nostrPublishState: 'published',
            nostrEvent: {
              id: signed.id,
              pubkey: signed.pubkey,
              kind: signed.kind,
              tags: signed.tags,
              created_at: signed.created_at,
              content: signed.content,
              sig: signed.sig,
            },
            claimedUntil: null,
          });
          try {
            await notifyConversationMessage({
              conversations: store,
              authStore: deps.auth,
              thread,
              message: created,
              nowMs: deps.now(),
              /* v8 ignore next 5 -- production worker always has pushStore when DMs run */
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
              ...(deps.notificationStore === undefined
                ? {}
                : { notifications: deps.notificationStore }),
            });
            /* v8 ignore next 3 -- fire-and-forget enqueue */
          } catch {
            logEvent('nostr.dm.push.failed');
          }
          ingested = true;
        } catch {
          logEvent('nostr.dm.inbound.failed', { eventId: event.id });
        }
      }
    }
  }
}

/**
 * Start the two-lane Nostr worker. Returns a stop function.
 *
 * Fast lane: `setInterval(intervalMs)` (default {@link WORKER_INTERVAL_MS})
 * runs `runNostrWorkerTick(deps, 'fast')` with no in-flight guard — overlapping
 * ticks stay safe via sign/publish leases, and a guard would couple unpaid
 * latency to 5 s publish timeouts. A rejecting fast tick logs
 * `nostr.worker.tick.failed`.
 *
 * Ingest lane: starts one `runNostrWorkerTick(deps, 'ingest')` pass
 * synchronously on call (before the handle returns). When that pass settles
 * (success or failure) and the handle was not stopped, schedules the next with
 * `setTimeout(ingestIntervalMs)` (default {@link WORKER_INGEST_INTERVAL_MS}).
 * At most one ingest pass is ever in flight. A rejecting pass logs
 * `nostr.worker.ingest.failed` and still reschedules.
 *
 * `stop()` clears the fast interval, clears a pending ingest timeout, and marks
 * the handle stopped so an in-flight ingest pass that settles later does not
 * schedule another one.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Fast-lane tick period.
 * @param ingestIntervalMs - Pause after an ingest pass settles before the next.
 * @returns Stop handle.
 */
export function startNostrWorker(
  deps: NostrWorkerDeps,
  intervalMs: number = WORKER_INTERVAL_MS,
  ingestIntervalMs: number = WORKER_INGEST_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  let ingestTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleIngest = (): void => {
    ingestTimer = setTimeout(() => {
      void runIngestPass();
    }, ingestIntervalMs);
  };

  const runIngestPass = (): Promise<void> =>
    runNostrWorkerTick(deps, 'ingest')
      .catch((error: unknown) => {
        logEvent('nostr.worker.ingest.failed', errorLogFields(error));
      })
      .finally(() => {
        if (!stopped) {
          scheduleIngest();
        }
      });

  void runIngestPass();

  const timer = setInterval(() => {
    void runNostrWorkerTick(deps, 'fast').catch((error: unknown) => {
      logEvent('nostr.worker.tick.failed', errorLogFields(error));
    });
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (ingestTimer !== undefined) {
        clearTimeout(ingestTimer);
        ingestTimer = undefined;
      }
    },
  };
}
