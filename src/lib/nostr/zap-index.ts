import { createHash } from 'node:crypto';
import { paymentHashFromReceipt } from '@/lib/account-activity';
import { requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11, inspectBolt11 } from '@/lib/bolt11';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import { LN_ADDRESS_CACHE_TTL_MS, type LnurlServerConfig } from '@/lib/config';
import { unsignedConversationDefaults } from '@/lib/conversation';
import { resolveMentionMarks } from '@/lib/mention';
import type { ConversationStore } from '@/lib/conversation-store';
import { errorLogFields, logEvent, type LogFields } from '@/lib/log';
import {
  MESSAGE_LIST_LIMIT,
  MESSAGE_MAX_LENGTH,
  normalizeForumText,
  truncatePubkeyDisplay,
  unsignedNostrDefaults,
  type MessageRow,
} from '@/lib/message';
import {
  ZapIngestRecordError,
  type MessageInvoiceAttempt,
  type RepaymentSettlement,
  type MessageStore,
  type ZapIngestRow,
  type ZapReceiptSettlement,
} from '@/lib/message-store';
import { fiatFromSats, type FiatAmounts, type FiatCrossRates } from '@/lib/money';
import type { FetchFn } from '@/lib/lnurlp';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
import { resolveLnurlp } from '@/lib/lnurlp';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import {
  EXTERNAL_ZAPPER_MIN_SATS,
  externalDisplayName,
  resolveExternalProfileName,
  verifiedExternalZapRequest,
} from '@/lib/nostr/external';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import { effectiveStatus } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { notifyForumPost, notifyForumReply, notifyHeart, notifyZap } from '@/lib/notification';
import { forumRateLimitExempt, type PostRateLimiter } from '@/lib/nostr/rate-limit';
import type { SpendPing } from '@/lib/spend-ping';
import type { NotificationStore } from '@/lib/notification-store';
import { normalizeHex32, preimageMatchesHash } from '@/lib/proof';
import type { PushStore } from '@/lib/push-store';
import { verifyEvent } from 'nostr-tools/pure';
import { parseRepaymentDescription, parseRepaymentPartDescription } from '@/lib/credit-repayment';
import { lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';

/** Minimal zap receipt fields we validate. */
export interface ZapReceipt {
  /** Receipt event id (unique). */
  id: string;
  /** LNURL provider pubkey (must match `nostrPubkey`). */
  pubkey: string;
  /** Tags (`e`, `bolt11`, …). */
  tags: string[][];
}

/** Cached LNURL provider pubkey resolve (success or failure). */
interface ProviderCacheRow {
  /** Provider pubkey when resolved and allowsNostr; otherwise null. */
  nostrPubkey: string | null;
  /** Expiry epoch ms. */
  expiresAt: number;
}

const providerPubkeyCache = new Map<string, ProviderCacheRow>();
const FIAT_GOAL_CURRENCIES = new Set(['USD', 'CHF', 'EUR', 'PHP']);
const EXTERNAL_ZAPPER_BACKFILL_CEILING = 10_000;
const NO_EXTERNAL_GIFT_REPLY_LIMIT = 10_000;

type SettleInvoiceResult =
  | { ok: true; receiptId: string; messageId: string; amountSats: number; resumed: boolean }
  | {
      ok: false;
      reason: 'shape' | 'note' | 'preimage' | 'invoice' | 'conversation' | 'message' | 'duplicate';
    };

/** Build immutable settlement identity only from an invoice read under its message lock. */
function lockedRepaymentSettlement(
  invoice: MessageInvoiceAttempt | undefined,
  paidAt: Date,
): { settlement: RepaymentSettlement; part: boolean } | null {
  if (invoice === undefined) {
    return null;
  }
  const repayment = parseRepaymentDescription(invoice.description);
  if (repayment === null) {
    return null;
  }
  const part = parseRepaymentPartDescription(invoice.description);
  return {
    settlement:
      part === null
        ? {
            kind: 'legacy',
            messageId: invoice.messageId,
            dayIndex: repayment.dayIndex,
            recipientAccountId: invoice.authorAccountId,
            dueSats: invoice.amountSats,
            paidAt,
          }
        : {
            kind: 'part',
            messageId: invoice.messageId,
            dayIndex: part.dayIndex,
            recipientAccountId: invoice.authorAccountId,
            partIndex: part.partIndex,
            units: part.units,
            sats: invoice.amountSats,
            shareUnits: part.shareUnits,
            paidAt,
          },
    part: part !== null,
  };
}

/** Normalise required operator evidence without allowing control characters. */
function normalizeManualNote(raw: string): string | null {
  const note = raw.trim();
  if (note.length < 1 || note.length > MESSAGE_MAX_LENGTH) {
    return null;
  }
  for (let i = 0; i < note.length; i += 1) {
    const code = note.charCodeAt(i);
    if (code < 32 || code === 127) {
      return null;
    }
  }
  return note;
}

/**
 * Deterministic synthetic kind:9735 id for a manually settled payment hash.
 *
 * @param paymentHash - Caller-supplied payment hash; case is ignored.
 * @returns Lowercase 64-hex SHA-256 event id.
 */
export function manualReceiptIdForPaymentHash(paymentHash: string): string {
  return createHash('sha256')
    .update(`21gifts-manual-settle:${paymentHash.toLowerCase()}`)
    .digest('hex');
}

/**
 * Backfill durable payment-hash claims for previously indexed zap receipts.
 *
 * Indexed ingests are returned newest-first, so this walks them oldest-first
 * to preserve the earliest credited receipt as owner. The operation is
 * idempotent because same-owner claims succeed. Its boot cost is one
 * insert-or-skip per indexed ingest with a decodable BOLT11 payment hash.
 *
 * @param store - Message store containing indexed ingests and payment claims.
 * @returns The number of new or same-owner claims accepted by the store.
 * @throws Propagates ingest-list and payment-claim store failures.
 */
export async function backfillZapPayments(store: MessageStore): Promise<number> {
  const indexed = await store.listIndexedZapIngests();
  let claimed = 0;
  for (const row of [...indexed].reverse()) {
    const hash = paymentHashFromReceipt(row.receipt);
    if (hash === null) {
      continue;
    }
    if (await store.claimZapPayment(hash, row.receiptId, row.createdAt)) {
      claimed += 1;
    } else {
      logEvent('nostr.zap.backfill.conflict', { receiptId: row.receiptId });
    }
  }
  logEvent('nostr.zap.backfill.done', { claimed, total: indexed.length });
  return claimed;
}

/**
 * Backfill external-zapper attribution from stored indexed receipt frames.
 *
 * The scan pages through unattributed receipts in newest-first batches and is
 * capped at 10,000 rows per boot. Account-owned pubkeys are kept on the member
 * path, while malformed, synthetic, replayed, or otherwise unverifiable frames
 * remain unattributed for a later bounded boot scan. A strict cursor advances
 * past every row seen, using immutable ingest creation time and receipt event
 * id keys so attribution changes between pages cannot skip or repeat rows.
 *
 * @param store - Message store containing indexed receipt frames.
 * @param deps - Auth, profile querier, relays, timeout, and clock.
 * @returns Number of verified external zappers encountered in this scan.
 * @throws Propagates store failures; relay profile failures are suppressed by
 *   {@link resolveExternalProfileName}.
 */
export async function backfillExternalZappers(
  store: MessageStore,
  deps: {
    auth: AuthStore;
    querier: NostrQuerier;
    urls: readonly string[];
    timeoutMs: number;
    now: () => number;
  },
): Promise<number> {
  let verified = 0;
  let attributed = 0;
  let gifts = 0;
  let scanned = 0;
  let before: { createdAt: Date; eventId: string } | undefined;
  while (scanned < EXTERNAL_ZAPPER_BACKFILL_CEILING) {
    const batchLimit = Math.min(MESSAGE_LIST_LIMIT, EXTERNAL_ZAPPER_BACKFILL_CEILING - scanned);
    const rows = await store.listUnattributedIndexedReceipts(batchLimit, before);
    scanned += rows.length;
    for (const row of rows) {
      const event = storedReceiptFrame(row.receipt);
      if (event === null || event.id !== row.receiptEventId) {
        continue;
      }
      const noteEventId = event.tags.find((tag) => tag[0] === 'e')?.[1];
      const bolt11 = event.tags.find((tag) => tag[0] === 'bolt11')?.[1];
      if (typeof noteEventId !== 'string' || noteEventId === '' || typeof bolt11 !== 'string') {
        continue;
      }
      const decoded = decodeBolt11(bolt11);
      const inspected = inspectBolt11(bolt11);
      if (
        decoded === null ||
        inspected === null ||
        Math.floor(decoded.amountMsat / 1000) < EXTERNAL_ZAPPER_MIN_SATS
      ) {
        continue;
      }
      const request = verifiedExternalZapRequest({
        tags: event.tags,
        descriptionHash: inspected.descriptionHash,
        amountMsat: decoded.amountMsat,
        noteEventId,
      });
      if (request === null || (await deps.auth.getAccountByPubkey(request.pubkey)) !== undefined) {
        continue;
      }
      verified += 1;
      const result = await persistExternalGiftReply({
        store,
        auth: deps.auth,
        querier: deps.querier,
        urls: deps.urls,
        timeoutMs: deps.timeoutMs,
        now: deps.now,
        receiptEventId: row.receiptEventId,
        parent: await store.getById(row.messageId),
        amountSats: row.sats,
        payerPubkey: request.pubkey,
        zapRequestId: request.requestId,
        text: request.content,
        receiptCreatedAt: receiptCreatedAt(event, row.createdAt.getTime()),
      });
      if (result.attributed) {
        attributed += 1;
      }
      if (result.gift) gifts += 1;
    }
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      before = { createdAt: lastRow.createdAt, eventId: lastRow.receiptEventId };
    }
    if (rows.length < batchLimit) {
      break;
    }
  }
  if (scanned === EXTERNAL_ZAPPER_BACKFILL_CEILING) {
    logEvent('nostr.zapper.backfill.ceiling', {
      ceiling: EXTERNAL_ZAPPER_BACKFILL_CEILING,
    });
  }
  logEvent('nostr.zapper.backfill.done', {
    scanned,
    verified,
    attributed,
    gifts,
  });
  return verified;
}

/**
 * Last persisted ingest `outcome:reason` per receipt id, keyed by message store.
 * Empty after process restart; the first tick may then re-persist a forgotten
 * decision, but only for the receipts that tick still queries. A receipt is
 * queried while its message is in the current `listLatest` result, or is a
 * reply of one of those latest rows (non-null child `eventId`), or is among
 * the newest `MESSAGE_LIST_LIMIT` live replies that have an event id
 * (`listRecentReplies`), even when the parent is not in `listLatest`.
 *
 * Note the asymmetry with `MessageStore.deleteById`: both store adapters forget
 * the receipt id when the message goes away and would record it again, but this
 * map does not, so a terminal decision here keeps suppressing ingest persist
 * until the process restarts. Terminal receipts still run `verifyReceipt` then
 * `tryEnsureGiftReply`, whose separate terminal-outcome memo can stop before
 * external request verification.
 */
const zapDecisions = new WeakMap<MessageStore, Map<string, string>>();

/**
 * Receipt ids whose verified external path cannot produce a gift-reply.
 * This process-local, per-store memory covers replayed request ids and amounts
 * below the external minimum. Oldest entries are evicted above the fixed cap.
 */
const noExternalGiftReplyReceipts = new WeakMap<MessageStore, Set<string>>();

/**
 * Lowercase pubkeys whose durable zapper entitlement this process recorded.
 * This per-store set is intentionally unbounded: distinct entitled pubkeys
 * are limited by the real-world zapper population, not receipt-count churn.
 */
const knownExternalZapperPubkeys = new WeakMap<MessageStore, Set<string>>();

/**
 * Get-or-create the per-store map of last persisted ingest decisions.
 *
 * @param store - Forum store instance.
 * @returns Mutable map from receipt id to `outcome:reason`.
 */
function decisionsFor(store: MessageStore): Map<string, string> {
  const existing = zapDecisions.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, string>();
  zapDecisions.set(store, created);
  return created;
}

/** Get-or-create the per-store terminal external gift-reply receipt set. */
function noExternalGiftReplyReceiptsFor(store: MessageStore): Set<string> {
  const existing = noExternalGiftReplyReceipts.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<string>();
  noExternalGiftReplyReceipts.set(store, created);
  return created;
}

/** Get-or-create the per-store set of already-recorded zapper pubkeys. */
function knownExternalZapperPubkeysFor(store: MessageStore): Set<string> {
  const existing = knownExternalZapperPubkeys.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<string>();
  knownExternalZapperPubkeys.set(store, created);
  return created;
}

/** Remember a terminal external outcome, evicting the oldest id at the cap. */
function rememberNoExternalGiftReply(store: MessageStore, receiptEventId: string): void {
  const receiptIds = noExternalGiftReplyReceiptsFor(store);
  receiptIds.add(receiptEventId);
  if (receiptIds.size > NO_EXTERNAL_GIFT_REPLY_LIMIT) {
    const oldest = receiptIds.values().next().value as string;
    receiptIds.delete(oldest);
  }
}

/**
 * Stable key for an ingest outcome and optional reason.
 *
 * @param outcome - `indexed` or `rejected`.
 * @param reason - Rejection reason, or null/undefined when indexed / unset.
 * @returns Template string `outcome:reason` (empty reason segment when nullish).
 */
function decisionKey(outcome: string, reason: string | null | undefined): string {
  return `${outcome}:${reason ?? ''}`;
}

const QUERY_CHUNK = 20;

/**
 * Verify a queried 9735 frame is a signed Nostr event.
 *
 * @param event - Frame from a relay.
 * @returns Whether nostr-tools accepts the signature.
 */
function defaultVerifyReceipt(event: NostrEventFrame): boolean {
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

/** Project a queried frame to the JSON object stored on ingest rows. */
function receiptFrame(event: NostrEventFrame): Record<string, unknown> {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    tags: event.tags,
    created_at: event.created_at,
    content: event.content ?? '',
    sig: event.sig ?? '',
  };
}

/** Narrow one persisted JSON object back to the receipt frame used by ingest. */
function storedReceiptFrame(value: Record<string, unknown>): NostrEventFrame | null {
  const id = value['id'];
  const pubkey = value['pubkey'];
  const kind = value['kind'];
  const tags = value['tags'];
  if (
    typeof id !== 'string' ||
    typeof pubkey !== 'string' ||
    typeof kind !== 'number' ||
    !Array.isArray(tags) ||
    !tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
  ) {
    return null;
  }
  const createdAt = value['created_at'];
  const sig = value['sig'];
  const content = value['content'];
  return {
    id,
    pubkey,
    kind,
    tags: tags as string[][],
    ...(typeof createdAt === 'number' ? { created_at: createdAt } : {}),
    ...(typeof sig === 'string' ? { sig } : {}),
    ...(typeof content === 'string' ? { content } : {}),
  };
}

/** Clamp a receipt timestamp to the ingest clock, falling back to that clock. */
function receiptCreatedAt(event: NostrEventFrame, nowMs: number): Date {
  const eventMs = typeof event.created_at === 'number' ? event.created_at * 1000 : Number.NaN;
  return new Date(Number.isFinite(eventMs) ? Math.min(eventMs, nowMs) : nowMs);
}

/**
 * Persist an ingest decision without failing the tick.
 * Skips the write when the memory already holds the same outcome:reason for the
 * receipt id on this store instance. The memory is set only after the write
 * resolves, so two overlapping ticks can both pass this check.
 *
 * @param store - Forum store.
 * @param row - Ingest row.
 */
async function persistZapIngest(store: MessageStore, row: ZapIngestRow): Promise<void> {
  const key = decisionKey(row.outcome, row.reason);
  if (decisionsFor(store).get(row.receiptId) === key) {
    return;
  }
  try {
    await store.recordZapIngest(row);
    decisionsFor(store).set(row.receiptId, key);
  } catch {
    logEvent('nostr.zap.ingest.record_failed');
  }
}

/**
 * Fields for a thrown ingest: `reason` plus the allowlisted error scalars.
 *
 * @param error - Caught value from `ingestOneReceipt`.
 * @returns Fields for `nostr.zap.rejected` ({@link errorLogFields}; never message text).
 */
function zapIngestCatchFields(error: unknown): LogFields {
  return { reason: 'error', ...errorLogFields(error) };
}

/**
 * Build a zap ingest row for an indexed or rejected decision.
 *
 * @param args - Outcome fields plus the receipt frame.
 */
/** Stored amounts from an invoice the payer already priced. Undefined when not pinned. */
function pinnedInvoiceFiat(invoice: MessageInvoiceAttempt | undefined): FiatAmounts | undefined {
  if (invoice?.fiatPinned !== true) {
    return undefined;
  }
  return {
    usd: invoice.amountUsd ?? null,
    chf: invoice.amountChf ?? null,
    eur: invoice.amountEur ?? null,
    php: invoice.amountPhp ?? null,
  };
}

/**
 * One Coinbase spot for a new zap. Null spot or a cross-book failure is null,
 * never a throw.
 *
 * @param args - Sats, instant, fetch, optional rate book, and clock.
 * @returns Payment-time snapshot, or `null`.
 */
async function snapshotSatsFiat(args: {
  sats: number;
  at: Date;
  fetchImpl: FetchFn;
  now: () => number;
  fiatRates?: FiatRateBook;
}): Promise<FiatAmounts | null> {
  const spot = await fetchBtcUsdSpot(args.fetchImpl);
  if (spot === null) {
    return null;
  }
  let crosses: FiatCrossRates = {};
  if (args.fiatRates !== undefined) {
    try {
      const day = args.at.toISOString().slice(0, 10);
      const found = (await args.fiatRates.ensureDays([day], args.now())).get(day);
      if (found !== undefined) {
        crosses = found;
      }
    } catch {
      crosses = {};
    }
  }
  try {
    return fiatFromSats(args.sats, spot, crosses);
  } catch {
    return null;
  }
}

/**
 * Attach a non-null snapshot onto an ingest row. Null leaves the row unchanged.
 *
 * @param row - Ingest row.
 * @param fiat - Snapshot, or `null`.
 * @returns The same row, or a copy with amount fields.
 */
function applyIngestFiat(row: ZapIngestRow, fiat: FiatAmounts | null): ZapIngestRow {
  if (fiat === null) {
    return row;
  }
  return {
    ...row,
    amountUsd: fiat.usd,
    amountChf: fiat.chf,
    amountEur: fiat.eur,
    amountPhp: fiat.php,
  };
}

function zapIngestRow(args: {
  receiptId: string;
  noteEventId: string | null;
  messageId: string | null;
  outcome: 'indexed' | 'rejected';
  reason: string | null;
  amountSats: number | null;
  receiptPubkey: string | null;
  receipt: Record<string, unknown>;
}): ZapIngestRow {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(),
    receiptId: args.receiptId,
    noteEventId: args.noteEventId,
    messageId: args.messageId,
    outcome: args.outcome,
    reason: args.reason,
    amountSats: args.amountSats,
    receiptPubkey: args.receiptPubkey,
    receipt: args.receipt,
  };
}

/**
 * Manually settle a successful forum invoice under operator authority.
 *
 * `DEBUG_TOKEN` is the authority for the route caller; the required note is
 * durable operator evidence. A supplied preimage is additionally verified
 * against the payment hash and stored only in the synthetic receipt tags.
 * A pre-existing legacy partial normal credit may resume even when the note
 * was hidden in the meantime; it then only completes the ingest row (no
 * notification, no gift-reply) and returns `resumed: true`. Fresh normal
 * credits store the payment-hash claim, forum receipt credit, and ingest
 * atomically and return `resumed: false`. Repayment claims and rows are atomic,
 * while their subsequent ingest write remains retryable. A fresh settle on a
 * hidden or missing note is refused.
 * On a member note, fans out `notifyZap` and attempts the payer gift-reply
 * unless the settled invoice is a heart (`heart === true`): then credits
 * sats, calls `notifyHeart`, and skips `notifyZap` and the gift-reply.
 * On the platform profile note, skips `notifyZap` and treats the zap comment
 * as a compose post/reply (`insertGiftReply`).
 *
 * @param args - Stores, clock, payment hash, operator note, optional preimage,
 *   and optional `spendPing`, `postLimiter`, `replyLimiter`, `fundingStore`,
 *   `recoveryShareRequiredFrom`, `conversations`, and `lnurlServer` (the spend ping's receiving address) for platform-note compose.
 * @returns The credited receipt details and resume status, or the first
 *   validation/lookup failure.
 * @throws Propagates store lookup, note-author lookup (before claim),
 *   payment-claim, credit, and ingest-write failures; payer-auth before
 *   settlement and notification failures are logged and suppressed.
 */
export async function settleInvoiceManually(args: {
  store: MessageStore;
  auth: AuthStore;
  now: () => number;
  paymentHash: string;
  note: string;
  preimage?: string;
  pushStore?: PushStore;
  notificationStore?: NotificationStore;
  spendPing?: SpendPing;
  postLimiter?: PostRateLimiter;
  replyLimiter?: PostRateLimiter;
  fundingStore?: FundingStore;
  recoveryShareRequiredFrom?: string | null;
  conversations?: ConversationStore;
  lnurlServer?: LnurlServerConfig;
  /** Spot fetch. Default `fetch`. A failure does not fail the settle. */
  fetchImpl?: FetchFn;
  /** Optional crosses for the payment-time snapshot. */
  fiatRates?: FiatRateBook;
}): Promise<SettleInvoiceResult> {
  const paymentHash = normalizeHex32(args.paymentHash);
  if (paymentHash === null) {
    return { ok: false, reason: 'shape' };
  }
  const note = normalizeManualNote(args.note);
  if (note === null) {
    return { ok: false, reason: 'note' };
  }
  let preimage: string | undefined;
  if (args.preimage !== undefined) {
    preimage = normalizeHex32(args.preimage) ?? undefined;
    if (preimage === undefined) {
      return { ok: false, reason: 'shape' };
    }
    if (!preimageMatchesHash(preimage, paymentHash)) {
      return { ok: false, reason: 'preimage' };
    }
  }

  const invoice = await args.store.findOkInvoiceByPaymentHash(paymentHash);
  if (
    invoice === undefined ||
    !Number.isInteger(invoice.amountSats) ||
    invoice.amountSats <= 0 ||
    invoice.pr === null ||
    invoice.pr.trim() === ''
  ) {
    return { ok: false, reason: 'invoice' };
  }
  if (invoice.conversationId !== undefined && invoice.conversationId !== null) {
    return { ok: false, reason: 'conversation' };
  }
  const bolt11 = invoice.pr;
  const receiptId = manualReceiptIdForPaymentHash(paymentHash);
  const resumed = (await args.store.getZapReceiptGift(receiptId)) !== undefined;
  const message = await args.store.getById(invoice.messageId);
  // A resumed settle already credited the note: finish its ingest row even if staff hid the note since.
  if (message === undefined || (!resumed && message.deletedAt !== null)) {
    return { ok: false, reason: 'message' };
  }
  const hidden = message.deletedAt !== null;
  let parentAuthor: Account | undefined;
  if (message.accountId !== null) {
    parentAuthor = await args.auth.getAccount(message.accountId);
  }
  const feeNote = isPlatformFeeNote(parentAuthor, message);
  const indexed = await args.store.listIndexedZapIngests();
  if (resumed && indexed.some((row) => row.receiptId === receiptId)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (indexed.some((row) => paymentHashFromReceipt(row.receipt) === paymentHash)) {
    return { ok: false, reason: 'duplicate' };
  }
  const claimedAt = new Date(args.now());
  if (parseRepaymentDescription(invoice.description) !== null && invoice.messageId === message.id) {
    const repaymentResult = await args.store.withMessageLock(message.id, async (lockedStore) => {
      const lockedInvoice = await lockedStore.findOkInvoiceByPaymentHash(paymentHash);
      const lockedRepayment = lockedRepaymentSettlement(lockedInvoice, claimedAt);
      if (
        lockedInvoice === undefined ||
        lockedInvoice.messageId !== message.id ||
        (lockedInvoice.conversationId !== undefined && lockedInvoice.conversationId !== null) ||
        lockedRepayment === null
      ) {
        return { kind: 'error', reason: 'invoice' } as const;
      }
      const claimed = await lockedStore.settleRepaymentPaymentLocked(
        paymentHash,
        receiptId,
        claimedAt,
        lockedRepayment.settlement,
        lockedRepayment.part && !FIAT_GOAL_CURRENCIES.has(message.goalCurrency ?? ''),
      );
      if (!claimed || indexed.some((row) => row.receiptId === receiptId)) {
        return { kind: 'error', reason: 'duplicate' } as const;
      }
      const tags: string[][] = [];
      if (typeof message.eventId === 'string' && message.eventId !== '') {
        tags.push(['e', message.eventId]);
      }
      if (lockedInvoice.pr !== null) {
        tags.push(['bolt11', lockedInvoice.pr]);
      }
      tags.push(['manual', 'debug-settle'], ['note', note]);
      const receipt = {
        id: receiptId,
        pubkey: '',
        kind: 9735,
        created_at: Math.floor(args.now() / 1000),
        content: '',
        sig: '',
        tags,
      } satisfies Record<string, unknown>;
      return { kind: 'settled', amountSats: lockedInvoice.amountSats, receipt } as const;
    });
    if (repaymentResult.kind === 'error') {
      return { ok: false, reason: repaymentResult.reason };
    }
    await args.store.recordZapIngest(
      zapIngestRow({
        receiptId,
        noteEventId: message.eventId,
        messageId: message.id,
        outcome: 'indexed',
        reason: null,
        amountSats: repaymentResult.amountSats,
        receiptPubkey: null,
        receipt: repaymentResult.receipt,
      }),
    );
    logEvent('nostr.zap.repaid', {
      messageId: message.id,
      sats: repaymentResult.amountSats,
    });
    return {
      ok: true,
      receiptId,
      messageId: message.id,
      amountSats: repaymentResult.amountSats,
      resumed: false,
    };
  }
  const paidAt = new Date(args.now());
  const initiallyPinned = pinnedInvoiceFiat(invoice);
  // Avoid a needless spot fetch when the locked re-read will supply pinned fiat.
  const spotDelta =
    initiallyPinned !== undefined
      ? null
      : await snapshotSatsFiat({
          sats: invoice.amountSats,
          at: paidAt,
          fetchImpl: args.fetchImpl ?? fetch,
          now: args.now,
          ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
        });
  const settlement = await args.store.withMessageLock(message.id, async (lockedStore) => {
    const lockedInvoice = await lockedStore.findOkInvoiceByPaymentHash(paymentHash);
    if (lockedInvoice?.messageId !== message.id) {
      return { kind: 'invoice' } as const;
    }
    const delta = pinnedInvoiceFiat(lockedInvoice) ?? spotDelta;
    const tags: string[][] = [];
    if (typeof message.eventId === 'string' && message.eventId !== '') {
      tags.push(['e', message.eventId]);
    }
    tags.push(['bolt11', bolt11]);
    if (lockedInvoice.zapRequest !== null) {
      tags.push(['description', JSON.stringify(lockedInvoice.zapRequest)]);
    }
    if (preimage !== undefined) {
      tags.push(['preimage', preimage]);
    }
    tags.push(['manual', 'debug-settle'], ['note', note]);
    const receipt = {
      id: receiptId,
      pubkey: '',
      kind: 9735,
      created_at: Math.floor(args.now() / 1000),
      content: '',
      sig: '',
      tags,
    } satisfies Record<string, unknown>;
    const ingest = applyIngestFiat(
      zapIngestRow({
        receiptId,
        noteEventId: message.eventId,
        messageId: message.id,
        outcome: 'indexed',
        reason: null,
        amountSats: lockedInvoice.amountSats,
        receiptPubkey: null,
        receipt,
      }),
      delta,
    );
    if (!(await lockedStore.claimZapPayment(paymentHash, receiptId, claimedAt))) {
      return { kind: 'duplicate' } as const;
    }
    if (resumed) {
      await lockedStore.updateZapReceiptGift(receiptId, {
        payerAccountId: lockedInvoice.payerAccountId,
        comment: commentFromZapRequest(lockedInvoice.zapRequest),
      });
      await lockedStore.recordZapIngest(ingest);
      return {
        kind: 'stored',
        invoice: lockedInvoice,
        ingest,
        payerAccountId: lockedInvoice.payerAccountId,
      } as const;
    }
    const stored = await lockedStore.recordZapReceipt(
      receiptId,
      message.id,
      lockedInvoice.amountSats,
      delta,
      true,
      {
        payerAccountId: lockedInvoice.payerAccountId,
        comment: commentFromZapRequest(lockedInvoice.zapRequest),
        ...(lockedInvoice.heart === true ? { suppressGiftReply: true } : {}),
        ingest,
        recordIngest: (row) => lockedStore.recordZapIngest(row),
      },
    );
    return stored
      ? ({
          kind: 'stored',
          invoice: lockedInvoice,
          ingest,
          payerAccountId: lockedInvoice.payerAccountId,
        } as const)
      : ({ kind: 'duplicate' } as const);
  });
  if (settlement.kind === 'invoice') {
    return { ok: false, reason: 'invoice' };
  }
  if (settlement.kind === 'duplicate') {
    return { ok: false, reason: 'duplicate' };
  }
  const settledInvoice = settlement.invoice;
  const ingest = settlement.ingest;
  const settledPayerAccountId = settlement.payerAccountId;
  let payer: Account | undefined;
  try {
    payer = await args.auth.getAccount(settledPayerAccountId);
  } catch {
    payer = undefined;
    logEvent('nostr.zap.gift_reply.failed', { receiptId });
  }
  decisionsFor(args.store).set(receiptId, decisionKey(ingest.outcome, ingest.reason));
  logEvent('nostr.zap.settled_manually', {
    messageId: message.id,
    sats: settledInvoice.amountSats,
  });
  if (!hidden && message.accountId !== null && settledInvoice.heart === true) {
    try {
      await notifyHeart({
        note: message,
        receiptId,
        nowMs: args.now(),
        auth: args.auth,
        payerAccountId: settledPayerAccountId,
        amountSats: settledInvoice.amountSats,
        ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(payer === undefined ? {} : { payerName: payer.name ?? 'Someone' }),
      });
    } catch {
      logEvent('push.enqueue.failed');
    }
  } else if (!hidden && message.accountId !== null && !feeNote) {
    try {
      await notifyZap({
        note: message,
        receiptId,
        amountSats: settledInvoice.amountSats,
        nowMs: args.now(),
        auth: args.auth,
        ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(payer === undefined
          ? {}
          : { payerAccountId: payer.id, payerName: payer.name ?? 'Someone' }),
      });
    } catch {
      logEvent('push.enqueue.failed');
    }
  }
  if (!hidden && payer !== undefined && settledInvoice.heart !== true) {
    try {
      await insertGiftReply({
        store: args.store,
        auth: args.auth,
        now: args.now,
        receiptEventId: receiptId,
        parent: message,
        amountSats: settledInvoice.amountSats,
        payer,
        text: commentFromZapRequest(settledInvoice.zapRequest),
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(args.notificationStore === undefined
          ? {}
          : { notificationStore: args.notificationStore }),
        ...(args.spendPing === undefined ? {} : { spendPing: args.spendPing }),
        ...(args.postLimiter === undefined ? {} : { postLimiter: args.postLimiter }),
        ...(args.replyLimiter === undefined ? {} : { replyLimiter: args.replyLimiter }),
        ...(args.fundingStore === undefined ? {} : { fundingStore: args.fundingStore }),
        ...(args.recoveryShareRequiredFrom === undefined
          ? {}
          : { recoveryShareRequiredFrom: args.recoveryShareRequiredFrom }),
        ...(args.conversations === undefined ? {} : { conversations: args.conversations }),
        ...(args.lnurlServer === undefined ? {} : { lnurlServer: args.lnurlServer }),
      });
    } catch {
      logEvent('nostr.zap.gift_reply.failed', { receiptId });
    }
  }
  return {
    ok: true,
    receiptId,
    messageId: message.id,
    amountSats: settledInvoice.amountSats,
    resumed,
  };
}

/**
 * Validate a kind:9735 receipt against the author's LNURL `nostrPubkey`
 * and add sats to the message once via durable receipt storage.
 *
 * The provider pubkey check is case-insensitive hex. Callers must already
 * have verified the Nostr signature (`verifyEvent`).
 *
 * A repeated identical `outcome:reason` is normally not written again, because
 * the memory is consulted before the write. That is not a guarantee: the memory
 * is set only after the write resolves, worker ticks are not serialised, and a
 * failed write leaves the memory untouched, so two overlapping ticks or a retry
 * can still produce a second identical row. A later, different decision for that
 * receipt always writes another ingest row.
 *
 * @param store - Forum store.
 * @param messageId - Forum row id.
 * @param receipt - Kind 9735.
 * @param providerPubkey - LNURL `nostrPubkey` hex.
 * @param amountSats - Whole sats from the paid invoice.
 * When `paymentHash` is supplied, its claim, payer attribution, indexed fiat,
 * and message credit are written under one per-message lock, with that
 * advisory lock acquired first.
 *
 * @returns Whether sats were added.
 */
export async function indexZapReceipt(args: {
  store: MessageStore;
  messageId: string;
  receipt: ZapReceipt;
  providerPubkey: string;
  amountSats: number;
  /** Full kind:9735 frame for debug ingest rows. */
  receiptEvent?: Record<string, unknown>;
  noteEventId?: string | null;
  /** Spot fetch. Default `fetch`. A failure does not reject the receipt. */
  fetchImpl?: FetchFn;
  /** Optional crosses for the one spot taken for this zap. */
  fiatRates?: FiatRateBook;
  /** Clock for the cross day. Default `Date.now`. */
  now?: () => number;
  /** Payment hash claimed under the same message lock as the receipt credit. */
  paymentHash?: string;
  /** Known member payer stored with the receipt credit. */
  payerAccountId?: string;
  /** Normalised member comment stored with the payer attribution. */
  payerComment?: string;
  /** Keep an attributed receipt out of the gift-reply retry queue. */
  suppressGiftReply?: boolean;
  /** Re-read the matching invoice after taking the payment's message lock. */
  rereadInvoice?: boolean;
  /**
   * Amounts already stored for this payment. Omission computes a settlement-
   * time snapshot; explicit `null` stores no snapshot. A pinned invoice found
   * by the locked re-read takes precedence over either choice.
   */
  fiat?: FiatAmounts | null;
}): Promise<boolean> {
  return (await indexZapReceiptSettlement(args)).indexed;
}

interface ZapReceiptIndexResult {
  indexed: boolean;
  heart: boolean;
  payerAccountId?: string;
}

/** Index a receipt and retain payer identity and heart state from the locked settlement. */
async function indexZapReceiptSettlement(
  args: Parameters<typeof indexZapReceipt>[0] & { heart?: boolean },
): Promise<ZapReceiptIndexResult> {
  const receipt =
    args.receiptEvent ??
    ({
      id: args.receipt.id,
      pubkey: args.receipt.pubkey,
      kind: 9735,
      tags: args.receipt.tags,
      created_at: 0,
      content: '',
      sig: '',
    } satisfies Record<string, unknown>);
  const noteEventId = args.noteEventId ?? null;

  if (args.receipt.pubkey.toLowerCase() !== args.providerPubkey.toLowerCase()) {
    logEvent('nostr.zap.rejected', { reason: 'pubkey' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: args.receipt.id,
        noteEventId,
        messageId: args.messageId,
        outcome: 'rejected',
        reason: 'pubkey',
        amountSats: args.amountSats,
        receiptPubkey: args.receipt.pubkey,
        receipt,
      }),
    );
    return { indexed: false, heart: false };
  }
  if (!Number.isInteger(args.amountSats) || args.amountSats <= 0) {
    logEvent('nostr.zap.rejected', { reason: 'amount' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: args.receipt.id,
        noteEventId,
        messageId: args.messageId,
        outcome: 'rejected',
        reason: 'amount',
        amountSats: args.amountSats,
        receiptPubkey: args.receipt.pubkey,
        receipt,
      }),
    );
    return { indexed: false, heart: false };
  }
  const now = args.now ?? Date.now;
  const baseDelta =
    args.fiat !== undefined
      ? args.fiat
      : await snapshotSatsFiat({
          sats: args.amountSats,
          at: new Date(now()),
          fetchImpl: args.fetchImpl ?? fetch,
          now,
          ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
        });
  const paymentHash = args.paymentHash;
  let indexedIngest: ZapIngestRow;
  const receiptSettlement = (
    store: MessageStore,
    delta: FiatAmounts | null,
    lockedInvoice?: MessageInvoiceAttempt,
  ): {
    heart: boolean;
    payerAccountId: string | undefined;
    receipt: ZapReceiptSettlement;
  } => {
    indexedIngest = applyIngestFiat(
      zapIngestRow({
        receiptId: args.receipt.id,
        noteEventId,
        messageId: args.messageId,
        outcome: 'indexed',
        reason: null,
        amountSats: args.amountSats,
        receiptPubkey: args.receipt.pubkey,
        receipt,
      }),
      delta,
    );
    const payerAccountId = lockedInvoice?.payerAccountId ?? args.payerAccountId;
    const payerComment =
      lockedInvoice === undefined
        ? args.payerComment
        : commentFromZapRequest(lockedInvoice.zapRequest);
    const heart = lockedInvoice === undefined ? args.heart === true : lockedInvoice.heart === true;
    const suppressGiftReply = heart || args.suppressGiftReply === true;
    return {
      heart,
      payerAccountId,
      receipt: {
        ...(payerAccountId === undefined ? {} : { payerAccountId }),
        ...(payerComment === undefined ? {} : { comment: payerComment }),
        ...(suppressGiftReply ? { suppressGiftReply: true } : {}),
        ingest: indexedIngest,
        recordIngest: (row: ZapIngestRow) => store.recordZapIngest(row),
      },
    };
  };
  let settlement: {
    kind: 'added' | 'duplicate' | 'settled';
    heart: boolean;
    payerAccountId: string | undefined;
  };
  try {
    if (paymentHash === undefined) {
      const settled = receiptSettlement(args.store, baseDelta);
      settlement = {
        kind: (await args.store.recordZapReceipt(
          args.receipt.id,
          args.messageId,
          args.amountSats,
          baseDelta,
          false,
          settled.receipt,
        ))
          ? 'added'
          : 'duplicate',
        heart: settled.heart,
        payerAccountId: settled.payerAccountId,
      };
    } else {
      settlement = await args.store.withMessageLock(args.messageId, async (lockedStore) => {
        let lockedInvoice: MessageInvoiceAttempt | undefined;
        if (args.rereadInvoice === true) {
          try {
            const found = await lockedStore.findOkInvoiceByPaymentHash(paymentHash);
            if (found?.messageId === args.messageId) {
              lockedInvoice = found;
            }
          } catch {
            lockedInvoice = undefined;
          }
        }
        const delta = pinnedInvoiceFiat(lockedInvoice) ?? baseDelta;
        const settled = receiptSettlement(lockedStore, delta, lockedInvoice);
        if (!(await lockedStore.claimZapPayment(paymentHash, args.receipt.id, new Date(now())))) {
          return {
            kind: 'settled',
            heart: settled.heart,
            payerAccountId: settled.payerAccountId,
          } as const;
        }
        return {
          kind: (await lockedStore.recordZapReceipt(
            args.receipt.id,
            args.messageId,
            args.amountSats,
            delta,
            true,
            settled.receipt,
          ))
            ? 'added'
            : 'duplicate',
          heart: settled.heart,
          payerAccountId: settled.payerAccountId,
        } as const;
      });
    }
  } catch (error: unknown) {
    if (!(error instanceof ZapIngestRecordError)) {
      throw error;
    }
    logEvent('nostr.zap.ingest.record_failed');
    return { indexed: false, heart: false };
  }
  if (settlement.kind !== 'added') {
    if (settlement.kind === 'settled') {
      logEvent('nostr.zap.rejected', { reason: 'settled' });
    }
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: args.receipt.id,
        noteEventId,
        messageId: args.messageId,
        outcome: 'rejected',
        reason: settlement.kind,
        amountSats: args.amountSats,
        receiptPubkey: args.receipt.pubkey,
        receipt,
      }),
    );
    return {
      indexed: false,
      heart: settlement.heart,
      ...(settlement.payerAccountId === undefined
        ? {}
        : { payerAccountId: settlement.payerAccountId }),
    };
  }
  logEvent('nostr.zap.indexed', { messageId: args.messageId, sats: args.amountSats });
  decisionsFor(args.store).set(
    args.receipt.id,
    decisionKey(indexedIngest!.outcome, indexedIngest!.reason),
  );
  return {
    indexed: true,
    heart: settlement.heart,
    ...(settlement.payerAccountId === undefined
      ? {}
      : { payerAccountId: settlement.payerAccountId }),
  };
}

/**
 * Query zap relays for kind:9735 receipts on recent forum notes, their
 * nested replies, the newest `MESSAGE_LIST_LIMIT` live replies that have
 * an event id (`listRecentReplies`) even when the parent is not in
 * `listLatest`, the official platform profile note (even after it ages
 * out of `listLatest`), and open conversation-invoice e-tags, index validated
 * ones, then insert a payer gift-reply (forum) or append the paid PN row
 * (conversation invoice) and fan out zap in-app notifications to every
 * account except skip (no-op when the payer is the official platform
 * account; Web Push only to bell subscribers). A heart invoice
 * (`heart === true`) credits sats, calls `notifyHeart`, and skips
 * `notifyZap` and the gift-reply. Conversation
 * invoices skip `addSats`, gift-reply, and `notifyZap`. Gift-reply insert
 * runs only when the paid message is a top-level member note (`parentId`
 * null) that is not the official platform profile note; a member-note
 * gift-reply does not call `notifyForumReply`. A member/invoice zap
 * (`payerAccountId`) on that platform note is a compose fee (payer
 * post/reply, `sats` 0) that skips `notifyZap` and fans out
 * `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing`
 * only when `eligibleToday` (same gate as `POST /messages`; otherwise
 * `spend.ping.skipped` / `not_eligible`).
 * An external zap (`payerPubkey`) on that same note still inserts
 * `insertExternalGiftReply`. A reply zap is `recordZapReceipt` onto `received_*`
 * (no nested gift-reply) and
 * clears `payerAccountId` so the receipt never occupies the
 * awaiting-gift-reply queue. Retries receipts that have a payer and no
 * gift-reply id yet, and drops already-queued reply receipts from that
 * queue.
 *
 * Hot mode (`eventIds` set): skip the whole note/conversation enumeration,
 * dedupe the given ids (drop empty strings, keep first-seen order), query
 * those ids in `QUERY_CHUNK` batches with the same receipt filter (plus
 * optional `since`), run the same per-receipt ingest path, and **do not**
 * call `retryGiftReplies` (the worker ingest lane does that on the full
 * pass). Empty `urls` or no remaining ids return immediately.
 *
 * Receipts whose terminal decision this process already persisted (`indexed`,
 * or `rejected` with reason `duplicate`) skip note lookup, account/LNURL
 * validation, and ingest persist. They still run `verifyReceipt` then
 * `tryEnsureGiftReply` unless the receipt matches a conversation invoice.
 * A forum receipt whose payment hash was already manually settled is rejected
 * with reason `settled` before author/provider lookup and cannot add sats again.
 * Every other rejection reason is re-validated on each full ingest pass and
 * writes again whenever the decision changes. The memory is process-local, so
 * the first ingest pass after a restart may re-persist decisions it has
 * forgotten, bounded by the receipts that pass queries. Fast-lane ticks are
 * not serialised (`setInterval` does not await the previous tick); the ingest
 * lane waits for each pass to settle, so the ingest skip is per pass, not a
 * guarantee across concurrent fast ticks.
 *
 * @param args - Store, auth, querier, relay urls, timeout, clock, fetch;
 *   optional `eventIds` / `since` for hot mode; optional `pushStore`,
 *   `notificationStore`, and `conversations` (PN invoices append here;
 *   omitted → `rejected`/`conversation`); optional `spendPing`, `postLimiter`,
 *   `replyLimiter`, `fundingStore`, and `recoveryShareRequiredFrom` for platform-note compose (`spendPing` only when
 *   `eligibleToday`, same gate as `POST /messages`); optional `lnurlServer`
 *   for wallet-backed recipients.
 * @returns Resolves when the ingest pass finishes.
 * @throws Propagates relay-query and unguarded store failures.
 */
export async function indexOpenZapReceipts(args: {
  store: MessageStore;
  auth: AuthStore;
  querier: NostrQuerier;
  urls: readonly string[];
  timeoutMs: number;
  now: () => number;
  fetchImpl: FetchFn;
  /** Signature check; production uses nostr-tools `verifyEvent`. */
  verifyReceipt?: (event: NostrEventFrame) => boolean;
  /** Optional push store; newly indexed member-note receipts call `notifyZap` (not the official platform profile note). */
  pushStore?: PushStore;
  /** Optional notification store; in-app rows via `auth` even without `pushStore`. */
  notificationStore?: NotificationStore;
  /** Optional PN store; conversation invoices append here instead of forum sats. Zap payloads include listed unread when set. */
  conversations?: ConversationStore;
  /** Optional spend ping after a platform-note compose creates a top-level post. */
  spendPing?: SpendPing;
  /** Optional top-level note limiter; a top-level platform-note compose counts against the same caps as `POST /messages`. */
  postLimiter?: PostRateLimiter;
  /** Optional reply limiter; a reply platform-note compose counts against the same caps as a `POST /messages` reply. */
  replyLimiter?: PostRateLimiter;
  /** Optional funding grants; compose spend pings use the same `eligibleToday` gate as `POST /messages`. */
  fundingStore?: FundingStore;
  recoveryShareRequiredFrom?: string | null;
  /** Optional crosses for the one spot taken per newly indexed zap. */
  fiatRates?: FiatRateBook;
  /** LNURL server; wallet-backed recipients resolve their receipt signer through it. */
  lnurlServer?: LnurlServerConfig;
  /** Hot mode: query exactly these note event ids instead of enumerating recent notes. */
  eventIds?: readonly string[];
  /** Unix seconds added as `since` to every kind:9735 receipt filter. */
  since?: number;
}): Promise<void> {
  if (args.eventIds !== undefined) {
    if (args.urls.length === 0) {
      return;
    }
    const eventIds: string[] = [];
    const seen = new Set<string>();
    for (const id of args.eventIds) {
      if (id === '' || seen.has(id)) {
        continue;
      }
      seen.add(id);
      eventIds.push(id);
    }
    if (eventIds.length === 0) {
      return;
    }
    await queryAndIngestZapReceipts(args, eventIds);
    return;
  }

  if (args.urls.length === 0) {
    await retryGiftReplies(args);
    return;
  }
  const rows = await args.store.listLatest(MESSAGE_LIST_LIMIT);
  const eventIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.eventId === null || row.eventId === '') {
      continue;
    }
    if (seen.has(row.eventId)) {
      continue;
    }
    seen.add(row.eventId);
    eventIds.push(row.eventId);
  }
  const accounts = await args.auth.listAccounts();
  const platform = accounts.find((account) => account.isPlatform === true);
  const profileId = platform?.profileMessageId;
  if (typeof profileId === 'string' && profileId !== '') {
    const profile = await args.store.getById(profileId);
    if (profile !== undefined && profile.deletedAt === null) {
      const profileEventId = profile.eventId;
      if (profileEventId !== null && profileEventId !== '' && !seen.has(profileEventId)) {
        seen.add(profileEventId);
        eventIds.push(profileEventId);
      }
    }
  }
  for (const row of await args.store.listOpenConversationZapEventIds()) {
    if (row.eventId === '' || seen.has(row.eventId)) {
      continue;
    }
    if (args.conversations !== undefined) {
      const existingGift = await args.conversations.getMessageById(row.conversationMessageId);
      if (existingGift !== undefined) {
        continue;
      }
    }
    seen.add(row.eventId);
    eventIds.push(row.eventId);
  }
  for (const row of rows) {
    const children = await args.store.listReplies(row.id, MESSAGE_LIST_LIMIT);
    for (const child of children) {
      if (child.eventId === null || child.eventId === '') {
        continue;
      }
      if (seen.has(child.eventId)) {
        continue;
      }
      seen.add(child.eventId);
      eventIds.push(child.eventId);
    }
  }
  for (const child of await args.store.listRecentReplies(MESSAGE_LIST_LIMIT)) {
    if (child.eventId === null || child.eventId === '') {
      continue;
    }
    if (seen.has(child.eventId)) {
      continue;
    }
    seen.add(child.eventId);
    eventIds.push(child.eventId);
  }
  if (eventIds.length === 0) {
    await retryGiftReplies(args);
    return;
  }

  await queryAndIngestZapReceipts(args, eventIds);
  await retryGiftReplies(args);
}

/**
 * Query kind:9735 receipts for `eventIds` in chunks and run per-receipt ingest.
 *
 * @param args - Ingest collaborators (including optional `since`).
 * @param eventIds - Deduped note event ids to put in `#e`.
 */
async function queryAndIngestZapReceipts(
  args: {
    store: MessageStore;
    auth: AuthStore;
    querier: NostrQuerier;
    urls: readonly string[];
    timeoutMs: number;
    now: () => number;
    fetchImpl: FetchFn;
    verifyReceipt?: (event: NostrEventFrame) => boolean;
    pushStore?: PushStore;
    notificationStore?: NotificationStore;
    conversations?: ConversationStore;
    spendPing?: SpendPing;
    postLimiter?: PostRateLimiter;
    replyLimiter?: PostRateLimiter;
    fundingStore?: FundingStore;
    recoveryShareRequiredFrom?: string | null;
    fiatRates?: FiatRateBook;
    /** LNURL server; wallet-backed recipients resolve their receipt signer through it. */
    lnurlServer?: LnurlServerConfig;
    since?: number;
  },
  eventIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < eventIds.length; i += QUERY_CHUNK) {
    const chunk = eventIds.slice(i, i + QUERY_CHUNK);
    const events = await args.querier.query(
      {
        kinds: [9735],
        '#e': chunk,
        limit: 200,
        ...(args.since === undefined ? {} : { since: args.since }),
      },
      args.urls,
      args.timeoutMs,
    );
    for (const event of events) {
      await ingestZapReceipt(event, args);
    }
  }
}

/**
 * Run the receipt ingest for one kind 9735 event, as the relay passes do.
 *
 * Same validation, crediting, and ingest rows as {@link indexOpenZapReceipts}
 * for one queried receipt (signature, provider pubkey of the recipient's
 * receiving address, payment hash claimed once). A thrown ingest step logs
 * `nostr.zap.rejected` and persists a `rejected`/`error` ingest row instead of
 * rejecting. Used by the Spark invoice worker so a receipt it signs is
 * credited without waiting for a relay round trip.
 *
 * @param event - Candidate receipt.
 * @param args - The {@link indexOpenZapReceipts} collaborators (`eventIds` and `since` are ignored).
 * @returns `true` when this receipt is credited: its latest ingest decision on
 *   this store is `indexed`, or `rejected`/`duplicate` (already recorded under
 *   the same receipt id). `false` for any other rejection, or when a step threw;
 *   the `rejected`/`error` ingest row is then persisted when the event has a
 *   non-empty id. A failure to write an ingest row is logged as
 *   `nostr.zap.ingest.record_failed` and not propagated.
 */
export async function ingestZapReceipt(
  event: NostrEventFrame,
  args: Parameters<typeof indexOpenZapReceipts>[0],
): Promise<boolean> {
  const verifyReceipt = args.verifyReceipt ?? defaultVerifyReceipt;
  try {
    await ingestOneReceipt(event, { ...args, verifyReceipt });
    const decision = decisionsFor(args.store).get(event.id);
    return (
      decision === decisionKey('indexed', null) || decision === decisionKey('rejected', 'duplicate')
    );
  } catch (error: unknown) {
    logEvent('nostr.zap.rejected', zapIngestCatchFields(error));
    if (typeof event.id === 'string' && event.id !== '') {
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'error',
          amountSats: null,
          /* v8 ignore next -- ingestOneReceipt returns unless pubkey is a string */
          receiptPubkey: typeof event.pubkey === 'string' ? event.pubkey : null,
          receipt: receiptFrame(event),
        }),
      );
    }
    return false;
  }
}

/**
 * Validate and index one candidate receipt event.
 *
 * Returns after id validation when this process already persisted a terminal
 * decision for the receipt id on this store instance (`indexed`, or `rejected`
 * with reason `duplicate`): still runs `verifyReceipt` then `tryEnsureGiftReply`,
 * whose terminal external memo can return before receipt lookup and request
 * verification, and does not persist ingest again. A payment hash already
 * represented by a synthetic manual receipt is rejected as `settled` before
 * provider lookup.
 * After address/provider/pubkey checks, an existing PN gift row is persisted
 * as `indexed` without claim or append. Every other rejection reason is
 * re-validated on each call.
 * A loaded invoice supplies its durable payer attribution even when the later
 * payer lookup fails. Heart status learned from either lookup suppresses the
 * gift reply and selects the heart notification.
 *
 * @param event - Queried frame.
 * @param args - Ingest collaborators.
 */
async function ingestOneReceipt(
  event: NostrEventFrame,
  args: {
    store: MessageStore;
    auth: AuthStore;
    querier: NostrQuerier;
    urls: readonly string[];
    timeoutMs: number;
    now: () => number;
    fetchImpl: FetchFn;
    verifyReceipt: (event: NostrEventFrame) => boolean;
    pushStore?: PushStore;
    notificationStore?: NotificationStore;
    conversations?: ConversationStore;
    spendPing?: SpendPing;
    postLimiter?: PostRateLimiter;
    replyLimiter?: PostRateLimiter;
    fundingStore?: FundingStore;
    recoveryShareRequiredFrom?: string | null;
    /** Optional crosses. Absent means the spot snapshot uses empty crosses. */
    fiatRates?: FiatRateBook;
    /** LNURL server; wallet-backed recipients resolve their receipt signer through it. */
    lnurlServer?: LnurlServerConfig;
  },
): Promise<void> {
  if (event.kind !== 9735) {
    return;
  }
  if (typeof event.id !== 'string' || event.id === '') {
    return;
  }
  const remembered = decisionsFor(args.store).get(event.id);
  if (
    remembered === decisionKey('indexed', null) ||
    remembered === decisionKey('rejected', 'duplicate')
  ) {
    if (!args.verifyReceipt(event)) {
      return;
    }
    const rememberedInvoice = await conversationInvoiceFromReceipt(args.store, event);
    if (rememberedInvoice !== undefined) {
      return;
    }
    await tryEnsureGiftReply(event, args);
    return;
  }
  if (typeof event.pubkey !== 'string' || event.pubkey === '') {
    logEvent('nostr.zap.rejected', { reason: 'pubkey' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId: null,
        messageId: null,
        outcome: 'rejected',
        reason: 'pubkey',
        amountSats: null,
        receiptPubkey: null,
        receipt: receiptFrame(event),
      }),
    );
    return;
  }

  const receipt = receiptFrame(event);

  if (!args.verifyReceipt(event)) {
    logEvent('nostr.zap.rejected', { reason: 'sig' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId: null,
        messageId: null,
        outcome: 'rejected',
        reason: 'sig',
        amountSats: null,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }

  const conversationMatch = await conversationInvoiceFromReceipt(args.store, event);
  if (conversationMatch !== undefined) {
    const { invoice: conversationInvoice, paymentHash } = conversationMatch;
    if (args.conversations === undefined) {
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'conversation',
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return;
    }
    const address = conversationInvoice.lightningAddress;
    if (address === null || address.trim() === '') {
      logEvent('nostr.zap.rejected', { reason: 'address' });
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'address',
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return;
    }
    const providerPubkey = await resolveProviderPubkey({
      address: address.trim().toLowerCase(),
      fetchImpl: lnurlServerFetch(args.lnurlServer, args.fetchImpl, args.auth),
      nowMs: args.now(),
      lnurlServerHost: args.lnurlServer?.host,
    });
    if (providerPubkey === null) {
      logEvent('nostr.zap.rejected', { reason: 'provider' });
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'provider',
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return;
    }
    if (event.pubkey.toLowerCase() !== providerPubkey.toLowerCase()) {
      logEvent('nostr.zap.rejected', { reason: 'pubkey' });
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'pubkey',
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return;
    }
    const conversationMessageId = conversationInvoice.conversationMessageId;
    if (conversationMessageId !== undefined && conversationMessageId !== null) {
      const existingGift = await args.conversations.getMessageById(conversationMessageId);
      if (existingGift !== undefined) {
        await persistZapIngest(
          args.store,
          zapIngestRow({
            receiptId: event.id,
            noteEventId: null,
            messageId: null,
            outcome: 'indexed',
            reason: null,
            amountSats: conversationInvoice.amountSats,
            receiptPubkey: event.pubkey,
            receipt,
          }),
        );
        return;
      }
    }
    if (!(await args.store.claimZapPayment(paymentHash, event.id, new Date(args.now())))) {
      logEvent('nostr.zap.rejected', { reason: 'settled' });
      await persistZapIngest(
        args.store,
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'rejected',
          reason: 'settled',
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return;
    }
    const pinnedConversation = pinnedInvoiceFiat(conversationInvoice);
    const conversationDelta =
      pinnedConversation !== undefined
        ? pinnedConversation
        : await snapshotSatsFiat({
            sats: conversationInvoice.amountSats,
            at: new Date(args.now()),
            fetchImpl: args.fetchImpl,
            now: args.now,
            ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
          });
    await appendConversationGift({
      conversations: args.conversations,
      auth: args.auth,
      now: args.now,
      invoice: conversationInvoice,
      fiat: conversationDelta,
    });
    await persistZapIngest(
      args.store,
      applyIngestFiat(
        zapIngestRow({
          receiptId: event.id,
          noteEventId: null,
          messageId: null,
          outcome: 'indexed',
          reason: null,
          amountSats: conversationInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
        conversationDelta,
      ),
    );
    return;
  }

  const eTag = event.tags.find((tag) => tag[0] === 'e' && typeof tag[1] === 'string');
  const noteEventId = eTag?.[1];
  if (noteEventId === undefined || noteEventId === '') {
    logEvent('nostr.zap.rejected', { reason: 'event' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId: null,
        messageId: null,
        outcome: 'rejected',
        reason: 'event',
        amountSats: null,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  const row = await args.store.getByEventId(noteEventId);
  if (row === undefined) {
    logEvent('nostr.zap.rejected', { reason: 'event' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: null,
        outcome: 'rejected',
        reason: 'event',
        amountSats: null,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }

  const bolt11Tag = event.tags.find((tag) => tag[0] === 'bolt11' && typeof tag[1] === 'string');
  const pr = bolt11Tag?.[1];
  if (pr === undefined || pr === '') {
    logEvent('nostr.zap.rejected', { reason: 'bolt11' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'bolt11',
        amountSats: null,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  const decoded = decodeBolt11(pr);
  if (decoded === null) {
    logEvent('nostr.zap.rejected', { reason: 'bolt11' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'bolt11',
        amountSats: null,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  const amountSats = Math.floor(decoded.amountMsat / 1000);
  if (amountSats < 1) {
    logEvent('nostr.zap.rejected', { reason: 'amount' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'amount',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }

  if (
    (await args.store.getZapReceiptGift(manualReceiptIdForPaymentHash(decoded.paymentHash))) !==
    undefined
  ) {
    logEvent('nostr.zap.rejected', { reason: 'settled' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'settled',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }

  if (await settleRepaymentReceipt(args, row, event, receipt, noteEventId, decoded, amountSats)) {
    return;
  }

  if (row.accountId === null) {
    logEvent('nostr.zap.rejected', { reason: 'author' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'author',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  const author = await args.auth.getAccount(row.accountId);
  const address =
    author === undefined ? undefined : receivingAddress(author, args.lnurlServer)?.address;
  if (address === undefined) {
    logEvent('nostr.zap.rejected', { reason: 'address' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'address',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }

  const providerPubkey = await resolveProviderPubkey({
    address: address.trim().toLowerCase(),
    fetchImpl: lnurlServerFetch(args.lnurlServer, args.fetchImpl, args.auth),
    nowMs: args.now(),
    lnurlServerHost: args.lnurlServer?.host,
  });
  if (providerPubkey === null) {
    logEvent('nostr.zap.rejected', { reason: 'provider' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'provider',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  if (event.pubkey.toLowerCase() !== providerPubkey.toLowerCase()) {
    logEvent('nostr.zap.rejected', { reason: 'pubkey' });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'rejected',
        reason: 'pubkey',
        amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
    return;
  }
  // A thrown lookup must not reject a receipt that already passed validation.
  // Retry once. The later payer lookup can still recover the effective invoice;
  // gift-reply also looks it up again.
  let invoice: MessageInvoiceAttempt | undefined;
  try {
    invoice = await args.store.findOkInvoiceByPaymentHash(decoded.paymentHash);
  } catch {
    try {
      invoice = await args.store.findOkInvoiceByPaymentHash(decoded.paymentHash);
    } catch {
      invoice = undefined;
    }
  }
  let payerResolution: Awaited<ReturnType<typeof resolveZapPayer>>;
  if ((await args.store.getZapReceiptGift(event.id)) === undefined) {
    try {
      payerResolution = await resolveZapPayer({
        store: args.store,
        auth: args.auth,
        bolt11: pr,
        paymentHash: decoded.paymentHash,
        tags: event.tags,
        descriptionHash: inspectBolt11(pr)?.descriptionHash ?? null,
        amountMsat: decoded.amountMsat,
        noteEventId,
      });
    } catch {
      payerResolution = { payer: undefined, invoice: undefined };
    }
  } else {
    payerResolution = { payer: undefined, invoice: undefined };
  }
  const resolvedPayer = payerResolution.payer;
  const effectiveInvoice = invoice ?? payerResolution.invoice;
  const pinnedForum = pinnedInvoiceFiat(effectiveInvoice);
  // A null fallback avoids a spot fetch; indexZapReceipt replaces it only from
  // the invoice re-read while holding the message lock.
  const forumDelta =
    pinnedForum !== undefined
      ? null
      : await snapshotSatsFiat({
          sats: amountSats,
          at: new Date(args.now()),
          fetchImpl: args.fetchImpl,
          now: args.now,
          ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
        });
  const heartInvoice = effectiveInvoice?.heart === true ? effectiveInvoice : undefined;
  const payerAccountId =
    effectiveInvoice === undefined && resolvedPayer?.kind === 'account'
      ? resolvedPayer.payer.id
      : undefined;
  const payerComment =
    resolvedPayer?.kind === 'account' && heartInvoice === undefined
      ? resolvedPayer.text
      : undefined;
  const settlement = await indexZapReceiptSettlement({
    store: args.store,
    messageId: row.id,
    receipt: { id: event.id, pubkey: event.pubkey, tags: event.tags },
    providerPubkey,
    amountSats,
    receiptEvent: receipt,
    noteEventId,
    fetchImpl: args.fetchImpl,
    now: args.now,
    paymentHash: decoded.paymentHash,
    ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
    fiat: forumDelta,
    ...(payerAccountId === undefined ? {} : { payerAccountId }),
    ...(payerComment === undefined ? {} : { payerComment }),
    heart: heartInvoice !== undefined,
    rereadInvoice: true,
  });
  if (
    !settlement.indexed &&
    (await args.store.zapPaymentReceiptId(decoded.paymentHash)) !== event.id
  ) {
    return;
  }
  if (settlement.indexed && row.accountId !== null) {
    let payer: Account | undefined;
    if (settlement.payerAccountId !== undefined) {
      try {
        payer = await args.auth.getAccount(settlement.payerAccountId);
      } catch {
        payer = undefined;
      }
    }
    if (settlement.heart) {
      if (settlement.payerAccountId !== undefined) {
        try {
          await notifyHeart({
            note: row,
            receiptId: event.id,
            nowMs: args.now(),
            auth: args.auth,
            payerAccountId: settlement.payerAccountId,
            amountSats,
            ...(args.notificationStore === undefined
              ? {}
              : { notifications: args.notificationStore }),
            ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
            /* v8 ignore next 3 -- production worker always has conversationStore */
            ...(args.conversations === undefined
              ? {}
              : { inboxUnreadCount: inboxUnreadCountFor(args.conversations, args.auth) }),
            ...(payer === undefined ? {} : { payerName: payer.name ?? 'Someone' }),
          });
        } catch {
          logEvent('push.enqueue.failed');
        }
      }
    } else if (!isPlatformFeeNote(author, row)) {
      try {
        await notifyZap({
          note: row,
          receiptId: event.id,
          amountSats,
          nowMs: args.now(),
          auth: args.auth,
          ...(args.notificationStore === undefined
            ? {}
            : { notifications: args.notificationStore }),
          ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
          /* v8 ignore next 3 -- production worker always has conversationStore */
          ...(args.conversations === undefined
            ? {}
            : { inboxUnreadCount: inboxUnreadCountFor(args.conversations, args.auth) }),
          ...(payer === undefined
            ? {}
            : { payerAccountId: payer.id, payerName: payer.name ?? 'Someone' }),
        });
      } catch {
        logEvent('push.enqueue.failed');
      }
    }
  }
  if (!settlement.heart) {
    await tryEnsureGiftReply(event, args);
  }
}

/**
 * A `repay:` invoice is the giver's payment, not a new gift.
 *
 * Runs before the author's provider check. The same wallet service can sign
 * both addresses, and a missing author address must not drop the repayment.
 * A receipt that is not signed by the giver's provider is rejected and does
 * not claim the payment hash. A repay invoice for another note, or for a
 * different sat amount, is rejected the same way and does not credit the ask.
 * A same-receipt claim first verifies or repairs the settlement row, then
 * resumes the missing ingest without resolving the invoice's possibly
 * merged-away giver again.
 * Returns true when this receipt was a repayment attempt, including a rejection.
 *
 * @param args - Ingest collaborators.
 * @param row - Note the receipt points at.
 * @param event - Kind 9735.
 * @param receipt - Parsed receipt kept on the ingest row.
 * @param noteEventId - Note event id from the receipt, if any.
 * @param decoded - Bolt11 payment hash and amount.
 * @param amountSats - Whole sats from the bolt11.
 * @returns Whether the receipt was handled as a repayment.
 */
async function settleRepaymentReceipt(
  args: Parameters<typeof indexOpenZapReceipts>[0],
  row: Pick<MessageRow, 'id' | 'goalCurrency'>,
  event: { id: string; pubkey: string },
  receipt: Record<string, unknown>,
  noteEventId: string | null,
  decoded: { paymentHash: string },
  amountSats: number,
): Promise<boolean> {
  let invoice: Awaited<ReturnType<typeof args.store.findOkInvoiceByPaymentHash>>;
  try {
    invoice = await args.store.findOkInvoiceByPaymentHash(decoded.paymentHash);
  } catch {
    /* v8 ignore next -- a thrown lookup is not a repayment; the gift path continues */
    return false;
  }
  if (invoice === undefined || parseRepaymentDescription(invoice.description) === null) {
    return false;
  }
  const result = await args.store.withMessageLock(row.id, async (lockedStore) => {
    const lockedInvoice = await lockedStore.findOkInvoiceByPaymentHash(decoded.paymentHash);
    const paidAt = new Date(args.now());
    const lockedRepayment = lockedRepaymentSettlement(lockedInvoice, paidAt);
    if (lockedInvoice === undefined || lockedRepayment === null) {
      logEvent('nostr.zap.rejected', { reason: 'settled' });
      await persistZapIngest(
        lockedStore,
        zapIngestRow({
          receiptId: event.id,
          noteEventId,
          messageId: row.id,
          outcome: 'rejected',
          reason: 'settled',
          amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return { kind: 'handled' } as const;
    }
    if (lockedInvoice.messageId !== row.id || lockedInvoice.amountSats !== amountSats) {
      const reason = lockedInvoice.messageId !== row.id ? 'event' : 'amount';
      logEvent('nostr.zap.rejected', { reason });
      await persistZapIngest(
        lockedStore,
        zapIngestRow({
          receiptId: event.id,
          noteEventId,
          messageId: row.id,
          outcome: 'rejected',
          reason,
          amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return { kind: 'handled' } as const;
    }
    const existingClaimReceiptId = await lockedStore.zapPaymentReceiptId(decoded.paymentHash);
    if (existingClaimReceiptId !== event.id) {
      const giver = await args.auth.getAccount(lockedInvoice.authorAccountId);
      const address =
        giver === undefined
          ? ''
          : (receivingAddress(giver, args.lnurlServer)?.address.toLowerCase() ?? '');
      const giverProvider =
        address === ''
          ? null
          : await resolveProviderPubkey({
              address,
              fetchImpl: lnurlServerFetch(args.lnurlServer, args.fetchImpl, args.auth),
              nowMs: args.now(),
              lnurlServerHost: args.lnurlServer?.host,
            });
      if (giverProvider === null || event.pubkey.toLowerCase() !== giverProvider) {
        logEvent('nostr.zap.rejected', { reason: 'pubkey' });
        await persistZapIngest(
          lockedStore,
          zapIngestRow({
            receiptId: event.id,
            noteEventId,
            messageId: row.id,
            outcome: 'rejected',
            reason: 'pubkey',
            amountSats: lockedInvoice.amountSats,
            receiptPubkey: event.pubkey,
            receipt,
          }),
        );
        return { kind: 'handled' } as const;
      }
    }
    if (
      !(await lockedStore.settleRepaymentPaymentLocked(
        decoded.paymentHash,
        event.id,
        paidAt,
        lockedRepayment.settlement,
        lockedRepayment.part && !FIAT_GOAL_CURRENCIES.has(row.goalCurrency ?? ''),
      ))
    ) {
      logEvent('nostr.zap.rejected', { reason: 'settled' });
      await persistZapIngest(
        lockedStore,
        zapIngestRow({
          receiptId: event.id,
          noteEventId,
          messageId: row.id,
          outcome: 'rejected',
          reason: 'settled',
          amountSats: lockedInvoice.amountSats,
          receiptPubkey: event.pubkey,
          receipt,
        }),
      );
      return { kind: 'handled' } as const;
    }
    return { kind: 'settled', amountSats: lockedInvoice.amountSats } as const;
  });
  if (result.kind === 'settled') {
    logEvent('nostr.zap.repaid', { messageId: row.id, sats: result.amountSats });
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: event.id,
        noteEventId,
        messageId: row.id,
        outcome: 'indexed',
        reason: null,
        amountSats: result.amountSats,
        receiptPubkey: event.pubkey,
        receipt,
      }),
    );
  }
  return true;
}

/**
 * Resolve LNURL `nostrPubkey` with a module-local TTL cache (success and miss).
 *
 * An address on the LNURL server host is not cached: whether it resolves
 * through the LNURL server or over the public URL follows the username's
 * current wallet verification, so a cached key could be stale.
 *
 * @param args - Normalised address, fetch, clock, and the LNURL server host when configured.
 * @returns Provider pubkey, or `null` when unresolved / not zap-capable.
 */
async function resolveProviderPubkey(args: {
  address: string;
  fetchImpl: FetchFn;
  nowMs: number;
  lnurlServerHost: string | undefined;
}): Promise<string | null> {
  const cacheable =
    args.lnurlServerHost === undefined || !args.address.endsWith(`@${args.lnurlServerHost}`);
  const cached = cacheable ? providerPubkeyCache.get(args.address) : undefined;
  if (cached !== undefined && cached.expiresAt > args.nowMs) {
    return cached.nostrPubkey;
  }

  const resolved = await resolveLnurlp({
    address: args.address,
    fetchImpl: args.fetchImpl,
  });
  let nostrPubkey: string | null = null;
  if (
    resolved.ok &&
    resolved.metadata.allowsNostr === true &&
    typeof resolved.metadata.nostrPubkey === 'string' &&
    resolved.metadata.nostrPubkey !== ''
  ) {
    nostrPubkey = resolved.metadata.nostrPubkey.toLowerCase();
  }
  if (cacheable) {
    providerPubkeyCache.set(args.address, {
      nostrPubkey,
      expiresAt: args.nowMs + LN_ADDRESS_CACHE_TTL_MS,
    });
  }
  return nostrPubkey;
}

/** Common collaborators for writing a member gift reply. */
interface BaseGiftReplyDeps {
  store: MessageStore;
  auth: AuthStore;
  now: () => number;
  pushStore?: PushStore;
  notificationStore?: NotificationStore;
  conversations?: ConversationStore;
  spendPing?: SpendPing;
  postLimiter?: PostRateLimiter;
  replyLimiter?: PostRateLimiter;
  fundingStore?: FundingStore;
  recoveryShareRequiredFrom?: string | null;
  lnurlServer?: LnurlServerConfig;
}

/** Collaborators for creating a gift-reply after a zap is indexed. */
interface GiftReplyDeps extends BaseGiftReplyDeps {
  querier: NostrQuerier;
  urls: readonly string[];
  timeoutMs: number;
}

/**
 * Decode the receipt's parent and bolt11, then insert a gift-reply.
 * Never throws — lookup/create failures log `nostr.zap.gift_reply.failed`.
 * A soft-deleted parent is treated as missing (`payerAccountId` cleared), and
 * remembered terminal external outcomes return before receipt lookup.
 *
 * @param event - Indexed kind:9735 frame.
 * @param args - Store, auth, clock, and the relay querier, URLs and timeout
 *   used to resolve an external payer's profile name.
 */
async function tryEnsureGiftReply(event: NostrEventFrame, args: GiftReplyDeps): Promise<void> {
  /* v8 ignore next 3 -- ingestOneReceipt already requires a receipt id */
  if (typeof event.id !== 'string' || event.id === '') {
    return;
  }
  if (noExternalGiftReplyReceiptsFor(args.store).has(event.id)) {
    return;
  }
  const taggedPr = event.tags.find((tag) => tag[0] === 'bolt11')?.[1];
  const pr = typeof taggedPr === 'string' ? taggedPr : '';
  const decoded = pr === '' ? null : decodeBolt11(pr);
  if (decoded !== null) {
    let heartInvoice: MessageInvoiceAttempt | undefined;
    try {
      heartInvoice = await args.store.findOkInvoiceByPaymentHash(decoded.paymentHash);
    } catch {
      // A retained payer must not bypass a later successful heart lookup.
      try {
        heartInvoice = await args.store.findOkInvoiceByPaymentHash(decoded.paymentHash);
      } catch {
        heartInvoice = undefined;
      }
    }
    if (heartInvoice?.heart === true) {
      return;
    }
  }
  try {
    const receipt = await args.store.getZapReceiptGift(event.id);
    if (receipt === undefined || receipt.giftReplyId !== null) {
      return;
    }
    // An attributed external receipt with its payer cleared was deliberately
    // dequeued because it was blocked or its parent could not receive a reply.
    if (
      receipt.payerAccountId === null &&
      receipt.payerPubkey === null &&
      receipt.zapRequestId !== null
    ) {
      return;
    }
    const parent = await args.store.getById(receipt.messageId);
    if (receipt.payerAccountId !== null) {
      if (parent === undefined || parent.deletedAt !== null || parent.parentId !== null) {
        await args.store.updateZapReceiptGift(event.id, { payerAccountId: null });
        return;
      }
      const payer = await args.auth.getAccount(receipt.payerAccountId);
      if (payer === undefined) {
        await args.store.updateZapReceiptGift(event.id, { payerAccountId: null });
        return;
      }
      await insertGiftReply({
        ...args,
        receiptEventId: event.id,
        parent,
        amountSats: receipt.sats,
        payer,
        text: receipt.comment,
      });
      return;
    }
    if (receipt.payerPubkey !== null) {
      if (await args.store.isPubkeyBlocked(receipt.payerPubkey)) {
        await args.store.updateZapReceiptGift(event.id, { payerPubkey: null });
        return;
      }
      if (parent === undefined || parent.deletedAt !== null || parent.parentId !== null) {
        await args.store.updateZapReceiptGift(event.id, { payerPubkey: null });
        return;
      }
      await insertExternalGiftReply({
        ...args,
        receiptEventId: event.id,
        parent,
        amountSats: receipt.sats,
        payerPubkey: receipt.payerPubkey,
        text: receipt.comment,
        createdAt: receiptCreatedAt(event, args.now()),
      });
      return;
    }
    const taggedPr = event.tags.find((tag) => tag[0] === 'bolt11')?.[1];
    const pr = typeof taggedPr === 'string' ? taggedPr : '';
    const decoded = pr === '' ? null : decodeBolt11(pr);
    const inspected = pr === '' ? null : inspectBolt11(pr);
    const paymentHash = decoded === null ? '' : decoded.paymentHash;
    await ensureGiftReplyFromReceipt({
      ...args,
      receiptEventId: event.id,
      parent,
      amountSats: receipt.sats,
      bolt11: pr,
      paymentHash,
      tags: event.tags,
      descriptionHash: inspected?.descriptionHash ?? null,
      amountMsat: decoded?.amountMsat ?? null,
      noteEventId:
        event.tags.find((tag) => tag[0] === 'e' && typeof tag[1] === 'string')?.[1] ?? '',
      receiptCreatedAt: receiptCreatedAt(event, args.now()),
    });
  } catch {
    logEvent('nostr.zap.gift_reply.failed', { receiptId: event.id });
  }
}

/**
 * Resolve the zap payer from an ok invoice (payment hash, then bolt11), else a
 * verified 9734 pubkey. An invoice match whose account is missing does not
 * fall through to 9734.
 *
 * @param args - Store, auth, bolt11, payment hash, receipt tags, the
 *   invoice description hash, the invoice amount in millisats, and the zapped
 *   note's event id (the last three bind a 9734 request to this receipt).
 * @returns The matched invoice (when present) plus `payer` as either
 *   `kind: 'account'` with the member payer and comment, `kind: 'external'`
 *   with the verified request pubkey, request id and comment, or `undefined`
 *   when unknown.
 */
async function resolveZapPayer(args: {
  store: MessageStore;
  auth: AuthStore;
  bolt11: string;
  paymentHash: string;
  tags: string[][];
  descriptionHash: string | null;
  amountMsat: number | null;
  noteEventId: string;
}): Promise<{
  payer:
    | { kind: 'account'; payer: Account; text: string }
    | { kind: 'external'; pubkey: string; requestId: string; text: string }
    | undefined;
  invoice: MessageInvoiceAttempt | undefined;
}> {
  const byHash = await args.store.findOkInvoiceByPaymentHash(args.paymentHash);
  const invoice = byHash ?? (await args.store.findOkInvoiceByPr(args.bolt11));
  if (invoice !== undefined) {
    const payer = await args.auth.getAccount(invoice.payerAccountId);
    const text = commentFromZapRequest(invoice.zapRequest);
    if (payer === undefined) {
      return { payer: undefined, invoice };
    }
    return { payer: { kind: 'account', payer, text }, invoice };
  }
  const parsed = parseVerifiedZapRequest(args.tags);
  if (parsed !== null) {
    const payer = await args.auth.getAccountByPubkey(parsed.pubkey);
    if (payer !== undefined) {
      return {
        payer: { kind: 'account', payer, text: parsed.content },
        invoice: undefined,
      };
    }
    const external = verifiedExternalZapRequest({
      tags: args.tags,
      descriptionHash: args.descriptionHash,
      amountMsat: args.amountMsat,
      noteEventId: args.noteEventId,
    });
    if (external !== null) {
      return {
        payer: {
          kind: 'external',
          pubkey: external.pubkey,
          requestId: external.requestId,
          text: external.content,
        },
        invoice: undefined,
      };
    }
  }
  return { payer: undefined, invoice: undefined };
}

/**
 * Create a forum reply for a newly indexed receipt (invoice first, then 9734).
 *
 * @param args - Receipt, parent, bolt11, tags.
 */
async function ensureGiftReplyFromReceipt(
  args: GiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow | undefined;
    amountSats: number;
    bolt11: string;
    paymentHash: string;
    tags: string[][];
    descriptionHash: string | null;
    amountMsat: number | null;
    noteEventId: string;
    receiptCreatedAt: Date;
  },
): Promise<void> {
  const heartInvoice = await args.store.findOkInvoiceByPaymentHash(args.paymentHash);
  if (heartInvoice?.heart === true) {
    return;
  }
  const { payer: resolved } = await resolveZapPayer({
    store: args.store,
    auth: args.auth,
    bolt11: args.bolt11,
    paymentHash: args.paymentHash,
    tags: args.tags,
    descriptionHash: args.descriptionHash,
    amountMsat: args.amountMsat,
    noteEventId: args.noteEventId,
  });
  if (resolved === undefined) {
    return;
  }
  if (resolved.kind === 'account') {
    if (args.parent === undefined || args.parent.deletedAt !== null) {
      await args.store.updateZapReceiptGift(args.receiptEventId, { payerAccountId: null });
      return;
    }
    await insertGiftReply({
      ...args,
      receiptEventId: args.receiptEventId,
      parent: args.parent,
      amountSats: args.amountSats,
      payer: resolved.payer,
      text: resolved.text,
    });
    return;
  }
  await persistExternalGiftReply({
    ...args,
    payerPubkey: resolved.pubkey,
    zapRequestId: resolved.requestId,
    text: resolved.text,
  });
}

/**
 * Retry receipts that have a payer but no gift-reply row yet.
 *
 * @param args - Store, auth, clock, and the relay querier, URLs and timeout
 *   used to resolve an external payer's profile name.
 */
async function retryGiftReplies(args: GiftReplyDeps): Promise<void> {
  const pending = await args.store.listZapReceiptsAwaitingGiftReply(MESSAGE_LIST_LIMIT);
  for (const row of pending) {
    try {
      const parent = await args.store.getById(row.messageId);
      if (parent === undefined || parent.deletedAt !== null) {
        await args.store.updateZapReceiptGift(row.receiptEventId, {
          ...(row.payerAccountId === null ? {} : { payerAccountId: null }),
          ...(row.payerPubkey === null ? {} : { payerPubkey: null }),
        });
        continue;
      }
      if (parent.parentId !== null) {
        // Stop awaiting: a reply zap must not nest a gift-reply child.
        await args.store.updateZapReceiptGift(row.receiptEventId, {
          ...(row.payerAccountId === null ? {} : { payerAccountId: null }),
          ...(row.payerPubkey === null ? {} : { payerPubkey: null }),
        });
        continue;
      }
      if (row.payerPubkey !== null) {
        if (await args.store.isPubkeyBlocked(row.payerPubkey)) {
          await args.store.updateZapReceiptGift(row.receiptEventId, { payerPubkey: null });
          continue;
        }
        await insertExternalGiftReply({
          ...args,
          receiptEventId: row.receiptEventId,
          parent,
          amountSats: row.sats,
          payerPubkey: row.payerPubkey,
          text: row.comment,
          createdAt: new Date(Math.min(row.receiptCreatedAt?.getTime() ?? args.now(), args.now())),
        });
        continue;
      }
      if (row.payerAccountId === null) {
        continue;
      }
      const payer = await args.auth.getAccount(row.payerAccountId);
      if (payer === undefined) {
        await args.store.updateZapReceiptGift(row.receiptEventId, { payerAccountId: null });
        continue;
      }
      await insertGiftReply({
        ...args,
        receiptEventId: row.receiptEventId,
        parent,
        amountSats: row.sats,
        payer,
        text: row.comment,
      });
    } catch {
      logEvent('nostr.zap.gift_reply.failed', { receiptId: row.receiptEventId });
    }
  }
}

/** Persist external attribution, then apply block and gift-reply guards. */
async function persistExternalGiftReply(
  args: GiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow | undefined;
    amountSats: number;
    payerPubkey: string;
    zapRequestId: string;
    text: string;
    receiptCreatedAt: Date;
  },
): Promise<{ attributed: boolean; gift: boolean }> {
  if (args.amountSats < EXTERNAL_ZAPPER_MIN_SATS) {
    rememberNoExternalGiftReply(args.store, args.receiptEventId);
    return { attributed: false, gift: false };
  }
  const at = new Date(args.now());
  const payerPubkey = args.payerPubkey.toLowerCase();
  const knownZappers = knownExternalZapperPubkeysFor(args.store);
  if (!knownZappers.has(payerPubkey)) {
    await args.store.recordZapper(args.payerPubkey, args.receiptEventId, at);
    knownZappers.add(payerPubkey);
  }
  const attributed = await args.store.attributeZapReceipt(args.receiptEventId, {
    payerPubkey: args.payerPubkey,
    zapRequestId: args.zapRequestId,
    comment: args.text,
  });
  if (!attributed) {
    rememberNoExternalGiftReply(args.store, args.receiptEventId);
    return { attributed: false, gift: false };
  }
  if (await args.store.isPubkeyBlocked(args.payerPubkey)) {
    await args.store.updateZapReceiptGift(args.receiptEventId, { payerPubkey: null });
    return { attributed: true, gift: false };
  }
  if (
    args.parent === undefined ||
    args.parent.deletedAt !== null ||
    args.parent.parentId !== null
  ) {
    await args.store.updateZapReceiptGift(args.receiptEventId, { payerPubkey: null });
    return { attributed: true, gift: false };
  }
  await insertExternalGiftReply({
    ...args,
    parent: args.parent,
    createdAt: new Date(Math.min(args.receiptCreatedAt.getTime(), args.now())),
  });
  return { attributed: true, gift: true };
}

/**
 * Create one non-custodial gift reply without scheduling Nostr publication.
 *
 * Listing accounts and resolving the relay profile introduce an asynchronous
 * gap after the caller's block check. The payer is therefore checked again
 * immediately before creation; a block that landed during either lookup
 * clears the attributed payer and leaves the receipt credited but dequeued.
 *
 * @param args - Receipt, payer, parent, profile dependencies, and creation time.
 * @throws Propagates account-list and store failures; relay profile failures
 *   are suppressed by {@link resolveExternalProfileName}.
 */
async function insertExternalGiftReply(
  args: GiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow;
    amountSats: number;
    payerPubkey: string;
    text: string;
    createdAt: Date;
  },
): Promise<void> {
  const accounts = await args.auth.listAccounts();
  const profileName = await resolveExternalProfileName({
    querier: args.querier,
    urls: args.urls,
    pubkey: args.payerPubkey,
    nowMs: args.now(),
    timeoutMs: args.timeoutMs,
  });
  const name = externalDisplayName({
    profileName,
    pubkey: args.payerPubkey,
    accountNames: accounts
      .map((account) => account.name)
      .filter((value): value is string => value !== null),
  });
  if (await args.store.isPubkeyBlocked(args.payerPubkey)) {
    await args.store.updateZapReceiptGift(args.receiptEventId, { payerPubkey: null });
    return;
  }
  const created = await args.store.create({
    id: giftReplyIdForReceipt(args.receiptEventId),
    accountId: null,
    name,
    text: args.text,
    createdAt: args.createdAt,
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    parentId: args.parent.id,
    authorPubkey: args.payerPubkey.toLowerCase(),
    sats: args.amountSats,
    nostrPublishState: 'skipped',
    contentFp: null,
  });
  await args.store.updateZapReceiptGift(args.receiptEventId, { giftReplyId: created.id });
}

/**
 * Persist the gift-reply row. `store.create` throws when the parent is
 * missing or soft-hidden. Create/link failures propagate so
 * `tryEnsureGiftReply` / `retryGiftReplies` log `nostr.zap.gift_reply.failed`.
 * Gift-replies on a member note do not call `notifyForumReply`; zap ingest
 * already called `notifyZap` after indexing. A member/invoice zap on the
 * platform profile note is a compose fee: `forum.post` + the note limiter
 * gate the create (`postLimiter` when the resulting note is top-level,
 * including a reply target reset to top-level; `replyLimiter` when it is a
 * reply; neither for a {@link forumRateLimitExempt} payer), then `notifyForumPost` / `notifyForumReply` (not `notifyZap`)
 * and a top-level `spendPing` only when `eligibleToday` (same gate as
 * `POST /messages`; otherwise `spend.ping.skipped` / `not_eligible`). When
 * the parent is itself a reply, sets `payerAccountId`
 * to null and returns without `store.create` so the receipt never occupies
 * the awaiting-gift-reply queue.
 *
 * @param args - Payer, parent, text, receipt id.
 */
async function insertGiftReply(
  args: BaseGiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow;
    amountSats: number;
    payer: Account;
    text: string;
  },
): Promise<void> {
  if (args.parent.parentId !== null) {
    // Stop awaiting: a reply zap must not nest a gift-reply child.
    await args.store.updateZapReceiptGift(args.receiptEventId, { payerAccountId: null });
    return;
  }
  await args.store.updateZapReceiptGift(args.receiptEventId, {
    payerAccountId: args.payer.id,
    comment: args.text,
  });
  const receipt = await args.store.getZapReceiptGift(args.receiptEventId);
  if (receipt === undefined || receipt.giftReplyId !== null) {
    return;
  }
  const pubkey = (await args.auth.getNostrPublicKey(args.payer.id)) ?? '';
  const nameTrim = args.payer.name?.trim() ?? '';
  const name = nameTrim !== '' ? nameTrim : truncatePubkeyDisplay(pubkey === '' ? 'npub' : pubkey);
  const parentAuthor =
    args.parent.accountId === null ? undefined : await args.auth.getAccount(args.parent.accountId);
  const compose = parsePlatformCompose(args.text, parentAuthor, args.parent);
  let parentId = compose.parentId;
  const text = compose.body;
  if (compose.isFeeNote && parentId !== null) {
    const target = await args.store.getById(parentId);
    if (target === undefined || target.parentId !== null || target.deletedAt !== null) {
      parentId = null;
    }
  }
  if (compose.isFeeNote && text.trim() === '') {
    await args.store.updateZapReceiptGift(args.receiptEventId, { payerAccountId: null });
    return;
  }
  if (compose.isFeeNote) {
    const gate = requireAction(args.payer, 'forum.post');
    if (!gate.ok) {
      await args.store.updateZapReceiptGift(args.receiptEventId, { payerAccountId: null });
      return;
    }
    const limiter = parentId === null ? args.postLimiter : args.replyLimiter;
    if (
      limiter !== undefined &&
      !forumRateLimitExempt(args.payer) &&
      !limiter.allow(args.payer.id, args.now())
    ) {
      logEvent('messages.rate_limited', { accountId: args.payer.id });
      await args.store.updateZapReceiptGift(args.receiptEventId, { payerAccountId: null });
      return;
    }
  }
  const created = await args.store.create({
    id: giftReplyIdForReceipt(args.receiptEventId),
    accountId: args.payer.id,
    name,
    text,
    createdAt: new Date(args.now()),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    parentId,
    authorPubkey: pubkey === '' ? null : pubkey,
    sats: compose.isFeeNote ? 0 : args.amountSats,
    nostrPublishState: text === '' ? 'skipped' : 'pending',
    contentFp: null,
  });
  await args.store.updateZapReceiptGift(args.receiptEventId, { giftReplyId: created.id });
  if (!compose.isFeeNote) {
    return;
  }
  try {
    if (parentId === null) {
      await notifyForumPost({
        account: args.payer,
        created,
        auth: args.auth,
        ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(args.conversations === undefined
          ? {}
          : { inboxUnreadCount: inboxUnreadCountFor(args.conversations, args.auth) }),
      });
    } else {
      await notifyForumReply({
        messages: args.store,
        account: args.payer,
        created,
        parentId,
        auth: args.auth,
        ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(args.conversations === undefined
          ? {}
          : { inboxUnreadCount: inboxUnreadCountFor(args.conversations, args.auth) }),
      });
    }
  } catch {
    logEvent(parentId === null ? 'push.enqueue.failed' : 'messages.reply.notify.failed');
  }
  const spendAddress = receivingAddress(args.payer, args.lnurlServer)?.address ?? null;
  if (parentId === null && spendAddress !== null && args.spendPing !== undefined) {
    try {
      const { grant, eligible } = await loadPayoutEligibility(
        args.fundingStore ?? new InMemoryFundingStore(),
        args.auth,
        args.payer,
        args.now(),
        args.recoveryShareRequiredFrom ?? null,
      );
      if (!eligible) {
        logEvent('spend.ping.skipped', { reason: 'not_eligible' });
      } else {
        await args.spendPing.ping(
          spendAddress,
          created.id,
          'daily',
          effectiveStatus(grant, args.now()),
        );
      }
    } catch {
      logEvent('spend.ping.failed');
    }
  }
}

const COMPOSE_REPLY_PREFIX =
  /^inReplyTo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\n([\s\S]*))?$/i;

function isPlatformFeeNote(author: Account | undefined, note: MessageRow): boolean {
  return author?.isPlatform === true && author.profileMessageId === note.id;
}

function parsePlatformCompose(
  text: string,
  parentAuthor: Account | undefined,
  parent: MessageRow,
): { isFeeNote: boolean; parentId: string | null; body: string } {
  const isFeeNote = isPlatformFeeNote(parentAuthor, parent);
  if (!isFeeNote) {
    return { isFeeNote: false, parentId: parent.id, body: text };
  }
  const match = COMPOSE_REPLY_PREFIX.exec(text);
  if (match === null) {
    return { isFeeNote: true, parentId: null, body: text };
  }
  /* v8 ignore next -- the UUID capture is always set when the prefix matches */
  const replyParentId = match[1] ?? null;
  return {
    isFeeNote: true,
    parentId: replyParentId,
    body: match[2] ?? '',
  };
}

/**
 * Deterministic message id for a gift-reply so a retry of the same receipt
 * is idempotent on `message.id`.
 *
 * @param receiptEventId - Kind:9735 event id.
 * @returns UUID derived from SHA-256 of the receipt id.
 */
function giftReplyIdForReceipt(receiptEventId: string): string {
  const hex = createHash('sha256').update(`21gifts-gift-reply:${receiptEventId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Look up a conversation-scoped ok invoice from a receipt's bolt11 hash.
 *
 * A thrown payment-hash lookup is treated as "not a PN invoice" so forum
 * ingest and gift-reply retry still run.
 *
 * @param store - Invoice attempts.
 * @param event - Kind:9735 frame.
 * @returns The invoice and decoded payment hash when it targets a PN,
 *   otherwise `undefined`.
 */
async function conversationInvoiceFromReceipt(
  store: MessageStore,
  event: NostrEventFrame,
): Promise<{ invoice: MessageInvoiceAttempt; paymentHash: string } | undefined> {
  const taggedPr = event.tags.find((tag) => tag[0] === 'bolt11')?.[1];
  const pr = typeof taggedPr === 'string' ? taggedPr : '';
  if (pr === '') {
    return undefined;
  }
  const decoded = decodeBolt11(pr);
  if (decoded === null) {
    return undefined;
  }
  let invoice: MessageInvoiceAttempt | undefined;
  try {
    invoice = await store.findOkInvoiceByPaymentHash(decoded.paymentHash);
  } catch {
    return undefined;
  }
  if (
    invoice === undefined ||
    invoice.conversationId === undefined ||
    invoice.conversationId === null ||
    invoice.conversationMessageId === undefined ||
    invoice.conversationMessageId === null
  ) {
    return undefined;
  }
  return { invoice, paymentHash: decoded.paymentHash };
}

/**
 * Persist a paid PN gift. Duplicate ids are idempotent in the store.
 *
 * @param args - Conversation store, auth, clock, invoice.
 */
async function appendConversationGift(args: {
  conversations: ConversationStore;
  auth: AuthStore;
  now: () => number;
  invoice: MessageInvoiceAttempt;
  fiat: FiatAmounts | null;
}): Promise<void> {
  /* v8 ignore start -- conversationInvoiceFromReceipt already requires both ids */
  const conversationId = args.invoice.conversationId;
  const conversationMessageId = args.invoice.conversationMessageId;
  if (
    conversationId === undefined ||
    conversationId === null ||
    conversationMessageId === undefined ||
    conversationMessageId === null
  ) {
    return;
  }
  /* v8 ignore stop */
  const payer = await args.auth.getAccount(args.invoice.payerAccountId);
  const pubkey = (await args.auth.getNostrPublicKey(args.invoice.payerAccountId)) ?? '';
  const nameTrim = payer?.name?.trim() ?? '';
  const name = nameTrim !== '' ? nameTrim : truncatePubkeyDisplay(pubkey === '' ? 'npub' : pubkey);
  const text = commentFromZapRequest(args.invoice.zapRequest);
  const mentions = await resolveMentionMarks(text, (username) =>
    args.auth.getAccountByUsername(username),
  );
  await args.conversations.appendMessage(
    {
      id: conversationMessageId,
      conversationId,
      text,
      ...(mentions.length > 0 ? { mentions } : {}),
      createdAt: new Date(args.now()),
      senderAccountId: args.invoice.payerAccountId,
      senderPubkey: pubkey === '' ? null : pubkey,
      name,
      ...unsignedConversationDefaults(),
      actorAccountId: args.invoice.payerAccountId,
      actorName: name,
      sats: args.invoice.amountSats,
      nostrPublishState: text === '' ? 'skipped' : 'pending',
    },
    undefined,
    undefined,
    args.fiat,
  );
}

/**
 * Read a normalised NIP-57 comment from a stored zap request, or `''`.
 *
 * @param zapRequest - Signed 9734 JSON, or null.
 * @returns Forum text, possibly empty.
 */
function commentFromZapRequest(zapRequest: Record<string, unknown> | null): string {
  if (zapRequest === null) {
    return '';
  }
  const raw = zapRequest['content'];
  if (typeof raw !== 'string') {
    return '';
  }
  return normalizeForumText(raw, MESSAGE_MAX_LENGTH) ?? '';
}

/**
 * Parse and verify a kind:9734 from a 9735 `description` tag.
 *
 * @param tags - Receipt tags.
 * @returns Pubkey + content, or null.
 */
function parseVerifiedZapRequest(tags: string[][]): { pubkey: string; content: string } | null {
  const description = tags.find(
    (tag) => tag[0] === 'description' && typeof tag[1] === 'string',
  )?.[1];
  if (description === undefined || description === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(description) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const event = parsed as {
    kind?: unknown;
    pubkey?: unknown;
    content?: unknown;
    id?: unknown;
    sig?: unknown;
    created_at?: unknown;
    tags?: unknown;
  };
  if (event.kind !== 9734 || typeof event.pubkey !== 'string' || event.pubkey === '') {
    return null;
  }
  if (typeof event.id !== 'string' || typeof event.sig !== 'string') {
    return null;
  }
  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    return null;
  }
  const rawContent = event.content;
  /* v8 ignore next -- verified 9734 content is a string */
  const content = typeof rawContent === 'string' ? rawContent : '';
  const normalised = normalizeForumText(content, MESSAGE_MAX_LENGTH);
  const text = normalised === null ? '' : normalised;
  return { pubkey: event.pubkey, content: text };
}
