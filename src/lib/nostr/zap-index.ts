import { createHash } from 'node:crypto';
import { paymentHashFromReceipt } from '@/lib/account-activity';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11, inspectBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { unsignedConversationDefaults } from '@/lib/conversation';
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
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import {
  EXTERNAL_ZAPPER_MIN_SATS,
  externalDisplayName,
  resolveExternalProfileName,
  verifiedExternalZapRequest,
} from '@/lib/nostr/external';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import { notifyZap } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { normalizeHex32, preimageMatchesHash } from '@/lib/proof';
import type { PushStore } from '@/lib/push-store';
import { verifyEvent } from 'nostr-tools/pure';

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
const EXTERNAL_ZAPPER_BACKFILL_CEILING = 10_000;
const NO_EXTERNAL_GIFT_REPLY_LIMIT = 10_000;

type SettleInvoiceResult =
  | { ok: true; receiptId: string; messageId: string; amountSats: number; resumed: boolean }
  | {
      ok: false;
      reason: 'shape' | 'note' | 'preimage' | 'invoice' | 'conversation' | 'message' | 'duplicate';
    };

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
 * remain unattributed for a later bounded boot scan. The offset advances only
 * past rows that remain unattributed because successful attribution removes a
 * row from subsequent pages.
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
  let offset = 0;
  while (scanned < EXTERNAL_ZAPPER_BACKFILL_CEILING) {
    const batchLimit = Math.min(MESSAGE_LIST_LIMIT, EXTERNAL_ZAPPER_BACKFILL_CEILING - scanned);
    const rows = await store.listUnattributedIndexedReceipts(batchLimit, offset);
    scanned += rows.length;
    let batchAttributed = 0;
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
        batchAttributed += 1;
      }
      if (result.gift) gifts += 1;
    }
    offset += rows.length - batchAttributed;
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
 * reply of one of those latest rows (non-null child `eventId`).
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
 * A retry after a failed ingest write resumes even when the note was hidden in
 * the meantime; it then only completes the ingest row (no notification, no
 * gift-reply). A fresh settle on a hidden or missing note is refused.
 * The claim and credit are not one transaction, so the concurrent same-instant
 * race is limited to the window between them; competing different receipt ids
 * are serialised by the claim table's payment-hash primary key.
 *
 * @param args - Stores, clock, payment hash, operator note, and optional preimage.
 * @returns The credited receipt details and resume status, or the first
 *   validation/lookup failure.
 * @throws Propagates store lookup, payment-claim, credit, and ingest-write
 *   failures; payer-auth and notification failures are logged and suppressed.
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
  const receiptId = manualReceiptIdForPaymentHash(paymentHash);
  const resumed = (await args.store.getZapReceiptGift(receiptId)) !== undefined;
  const message = await args.store.getById(invoice.messageId);
  // A resumed settle already credited the note: finish its ingest row even if staff hid the note since.
  if (message === undefined || (!resumed && message.deletedAt !== null)) {
    return { ok: false, reason: 'message' };
  }
  const hidden = message.deletedAt !== null;
  const indexed = await args.store.listIndexedZapIngests();
  if (resumed && indexed.some((row) => row.receiptId === receiptId)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (indexed.some((row) => paymentHashFromReceipt(row.receipt) === paymentHash)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (!(await args.store.claimZapPayment(paymentHash, receiptId, new Date(args.now())))) {
    return { ok: false, reason: 'duplicate' };
  }
  if (!resumed && !(await args.store.recordZapReceipt(receiptId, message.id, invoice.amountSats))) {
    return { ok: false, reason: 'duplicate' };
  }

  const tags: string[][] = [];
  if (typeof message.eventId === 'string' && message.eventId !== '') {
    tags.push(['e', message.eventId]);
  }
  tags.push(['bolt11', invoice.pr]);
  if (invoice.zapRequest !== null) {
    tags.push(['description', JSON.stringify(invoice.zapRequest)]);
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
  const ingest = zapIngestRow({
    receiptId,
    noteEventId: message.eventId,
    messageId: message.id,
    outcome: 'indexed',
    reason: null,
    amountSats: invoice.amountSats,
    receiptPubkey: null,
    receipt,
  });
  await args.store.recordZapIngest(ingest);
  decisionsFor(args.store).set(receiptId, decisionKey(ingest.outcome, ingest.reason));
  logEvent('nostr.zap.settled_manually', { messageId: message.id, sats: invoice.amountSats });

  let payer: Account | undefined;
  try {
    payer = await args.auth.getAccount(invoice.payerAccountId);
  } catch {
    payer = undefined;
    logEvent('nostr.zap.gift_reply.failed', { receiptId });
  }
  if (!hidden && message.accountId !== null) {
    try {
      await notifyZap({
        note: message,
        receiptId,
        amountSats: invoice.amountSats,
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
  if (!hidden && payer !== undefined) {
    try {
      await insertGiftReply({
        store: args.store,
        auth: args.auth,
        now: args.now,
        receiptEventId: receiptId,
        parent: message,
        amountSats: invoice.amountSats,
        payer,
        text: commentFromZapRequest(invoice.zapRequest),
      });
    } catch {
      logEvent('nostr.zap.gift_reply.failed', { receiptId });
    }
  }
  return {
    ok: true,
    receiptId,
    messageId: message.id,
    amountSats: invoice.amountSats,
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
}): Promise<boolean> {
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
    return false;
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
    return false;
  }
  const added = await args.store.recordZapReceipt(args.receipt.id, args.messageId, args.amountSats);
  if (!added) {
    await persistZapIngest(
      args.store,
      zapIngestRow({
        receiptId: args.receipt.id,
        noteEventId,
        messageId: args.messageId,
        outcome: 'rejected',
        reason: 'duplicate',
        amountSats: args.amountSats,
        receiptPubkey: args.receipt.pubkey,
        receipt,
      }),
    );
    return false;
  }
  logEvent('nostr.zap.indexed', { messageId: args.messageId, sats: args.amountSats });
  await persistZapIngest(
    args.store,
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
  );
  return true;
}

/**
 * Query zap relays for kind:9735 receipts on recent forum notes, their
 * nested replies, and open conversation-invoice e-tags, index validated
 * ones, then insert a payer gift-reply (forum) or append the paid PN row
 * (conversation invoice) and fan out zap in-app notifications to every
 * account except skip (Web Push only to bell subscribers). Conversation
 * invoices skip `addSats`, gift-reply, and `notifyZap`. Gift-reply insert
 * runs only when the paid message is top-level (`parentId` null); a reply
 * zap is `addSats` only (no nested gift-reply) and clears `payerAccountId`
 * so the receipt never occupies the awaiting-gift-reply queue. Retries
 * receipts that have a payer and no gift-reply id yet, and drops
 * already-queued reply receipts from that queue. The gift-reply insert
 * does not call `notifyForumReply`.
 *
 * Receipts whose terminal decision this process already persisted (`indexed`,
 * or `rejected` with reason `duplicate`) skip note lookup, account/LNURL
 * validation, and ingest persist. They still run `verifyReceipt` then
 * `tryEnsureGiftReply` unless the receipt matches a conversation invoice.
 * A forum receipt whose payment hash was already manually settled is rejected
 * with reason `settled` before author/provider lookup and cannot add sats again.
 * Every other rejection reason is re-validated on each tick and writes again
 * whenever the decision changes. The memory is process-local, so the first
 * tick after a restart may re-persist decisions it has forgotten, bounded by
 * the receipts that tick queries. Ticks are not serialised (`setInterval`
 * does not await the previous tick), so the ingest skip is per tick, not a
 * guarantee across concurrent ticks.
 *
 * @param args - Store, auth, querier, relay urls, timeout, clock, fetch;
 *   optional `pushStore`, `notificationStore`, and `conversations` (PN
 *   invoices append here; omitted → `rejected`/`conversation`).
 * @returns Resolves when the tick's ingest pass finishes.
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
  /** Optional push store; newly indexed receipts call `notifyZap`. */
  pushStore?: PushStore;
  /** Optional notification store; in-app rows via `auth` even without `pushStore`. */
  notificationStore?: NotificationStore;
  /** Optional PN store; conversation invoices append here instead of forum sats. Zap payloads include listed unread when set. */
  conversations?: ConversationStore;
}): Promise<void> {
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
  if (eventIds.length === 0) {
    await retryGiftReplies(args);
    return;
  }

  for (let i = 0; i < eventIds.length; i += QUERY_CHUNK) {
    const chunk = eventIds.slice(i, i + QUERY_CHUNK);
    const events = await args.querier.query(
      { kinds: [9735], '#e': chunk, limit: 200 },
      args.urls,
      args.timeoutMs,
    );
    const verifyReceipt = args.verifyReceipt ?? defaultVerifyReceipt;
    for (const event of events) {
      try {
        await ingestOneReceipt(event, { ...args, verifyReceipt });
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
      }
    }
  }
  await retryGiftReplies(args);
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
      fetchImpl: args.fetchImpl,
      nowMs: args.now(),
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
    await appendConversationGift({
      conversations: args.conversations,
      auth: args.auth,
      now: args.now,
      invoice: conversationInvoice,
    });
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
  const address = author?.lightningAddress;
  if (address === undefined || address === null || address.trim() === '') {
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
    fetchImpl: args.fetchImpl,
    nowMs: args.now(),
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
  if (!(await args.store.claimZapPayment(decoded.paymentHash, event.id, new Date(args.now())))) {
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

  const indexed = await indexZapReceipt({
    store: args.store,
    messageId: row.id,
    receipt: { id: event.id, pubkey: event.pubkey, tags: event.tags },
    providerPubkey,
    amountSats,
    receiptEvent: receipt,
    noteEventId,
  });
  if (indexed && row.accountId !== null) {
    let payer: Account | undefined;
    try {
      const resolved = await resolveZapPayer({
        store: args.store,
        auth: args.auth,
        bolt11: pr,
        paymentHash: decoded.paymentHash,
        tags: event.tags,
        descriptionHash: inspectBolt11(pr)?.descriptionHash ?? null,
        amountMsat: decoded.amountMsat,
        noteEventId,
      });
      payer = resolved?.kind === 'account' ? resolved.payer : undefined;
    } catch {
      payer = undefined;
    }
    try {
      await notifyZap({
        note: row,
        receiptId: event.id,
        amountSats,
        nowMs: args.now(),
        auth: args.auth,
        ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
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
  await tryEnsureGiftReply(event, args);
}

/**
 * Resolve LNURL `nostrPubkey` with a module-local TTL cache (success and miss).
 *
 * @param args - Normalised address, fetch, clock.
 * @returns Provider pubkey, or `null` when unresolved / not zap-capable.
 */
async function resolveProviderPubkey(args: {
  address: string;
  fetchImpl: FetchFn;
  nowMs: number;
}): Promise<string | null> {
  const cached = providerPubkeyCache.get(args.address);
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
  providerPubkeyCache.set(args.address, {
    nostrPubkey,
    expiresAt: args.nowMs + LN_ADDRESS_CACHE_TTL_MS,
  });
  return nostrPubkey;
}

/** Common collaborators for writing a member gift reply. */
interface BaseGiftReplyDeps {
  store: MessageStore;
  auth: AuthStore;
  now: () => number;
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
 * @param args - Store, auth, clock.
 */
async function tryEnsureGiftReply(event: NostrEventFrame, args: GiftReplyDeps): Promise<void> {
  /* v8 ignore next 3 -- ingestOneReceipt already requires a receipt id */
  if (typeof event.id !== 'string' || event.id === '') {
    return;
  }
  if (noExternalGiftReplyReceiptsFor(args.store).has(event.id)) {
    return;
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
        store: args.store,
        auth: args.auth,
        now: args.now,
        receiptEventId: event.id,
        parent,
        amountSats: receipt.sats,
        payer,
        text: receipt.comment,
      });
      return;
    }
    if (receipt.payerPubkey !== null) {
      if ((await args.store.listBlockedPubkeys()).includes(receipt.payerPubkey.toLowerCase())) {
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
 * @param args - Store, auth, bolt11, payment hash, receipt tags.
 * @returns Payer and comment, or `undefined` when unknown.
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
}): Promise<
  | { kind: 'account'; payer: Account; text: string }
  | { kind: 'external'; pubkey: string; requestId: string; text: string }
  | undefined
> {
  const byHash = await args.store.findOkInvoiceByPaymentHash(args.paymentHash);
  const invoice = byHash ?? (await args.store.findOkInvoiceByPr(args.bolt11));
  if (invoice !== undefined) {
    const payer = await args.auth.getAccount(invoice.payerAccountId);
    const text = commentFromZapRequest(invoice.zapRequest);
    if (payer === undefined) {
      return undefined;
    }
    return { kind: 'account', payer, text };
  }
  const parsed = parseVerifiedZapRequest(args.tags);
  if (parsed !== null) {
    const payer = await args.auth.getAccountByPubkey(parsed.pubkey);
    if (payer !== undefined) {
      return { kind: 'account', payer, text: parsed.content };
    }
    const external = verifiedExternalZapRequest({
      tags: args.tags,
      descriptionHash: args.descriptionHash,
      amountMsat: args.amountMsat,
      noteEventId: args.noteEventId,
    });
    if (external !== null) {
      return {
        kind: 'external',
        pubkey: external.pubkey,
        requestId: external.requestId,
        text: external.content,
      };
    }
  }
  return undefined;
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
  const resolved = await resolveZapPayer({
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
      store: args.store,
      auth: args.auth,
      now: args.now,
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
 * @param args - Store, auth, clock.
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
        if ((await args.store.listBlockedPubkeys()).includes(row.payerPubkey.toLowerCase())) {
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
        store: args.store,
        auth: args.auth,
        now: args.now,
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
  if ((await args.store.listBlockedPubkeys()).includes(args.payerPubkey.toLowerCase())) {
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

/** Create one non-custodial gift reply without scheduling Nostr publication. */
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
 * Does not call `notifyForumReply`; zap ingest already called `notifyZap`
 * after indexing. When the parent is itself a reply, sets `payerAccountId`
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
  const text = args.text;
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
    parentId: args.parent.id,
    authorPubkey: pubkey === '' ? null : pubkey,
    sats: args.amountSats,
    nostrPublishState: text === '' ? 'skipped' : 'pending',
    contentFp: null,
  });
  await args.store.updateZapReceiptGift(args.receiptEventId, { giftReplyId: created.id });
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
  await args.conversations.appendMessage({
    id: conversationMessageId,
    conversationId,
    text,
    createdAt: new Date(args.now()),
    senderAccountId: args.invoice.payerAccountId,
    senderPubkey: pubkey === '' ? null : pubkey,
    name,
    ...unsignedConversationDefaults(),
    sats: args.invoice.amountSats,
    nostrPublishState: text === '' ? 'skipped' : 'pending',
  });
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
