import type { AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';
import type { MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import type { PushStore } from '@/lib/push-store';
import { enqueueZapPush } from '@/lib/push-worker';
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

/**
 * Persist an ingest decision without failing the tick.
 *
 * @param store - Forum store.
 * @param row - Ingest row.
 */
async function persistZapIngest(store: MessageStore, row: ZapIngestRow): Promise<void> {
  try {
    await store.recordZapIngest(row);
  } catch {
    logEvent('nostr.zap.ingest.record_failed');
  }
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
 * Validate a kind:9735 receipt against the author's LNURL `nostrPubkey`
 * and add sats to the message once via durable receipt storage.
 *
 * The provider pubkey check is case-insensitive hex. Callers must already
 * have verified the Nostr signature (`verifyEvent`).
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
 * Query zap relays for kind:9735 receipts on recent forum notes and index
 * validated ones.
 *
 * @param args - Store, auth, querier, relay urls, timeout, clock, fetch.
 * @returns Resolves when the tick's ingest pass finishes.
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
  /** Optional push store; newly indexed receipts enqueue a zap push. */
  pushStore?: PushStore;
}): Promise<void> {
  if (args.urls.length === 0) {
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
  if (eventIds.length === 0) {
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
      } catch {
        logEvent('nostr.zap.rejected', { reason: 'error' });
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
}

/**
 * Validate and index one candidate receipt event.
 *
 * @param event - Queried frame.
 * @param args - Ingest collaborators.
 */
async function ingestOneReceipt(
  event: NostrEventFrame,
  args: {
    store: MessageStore;
    auth: AuthStore;
    now: () => number;
    fetchImpl: FetchFn;
    verifyReceipt: (event: NostrEventFrame) => boolean;
    pushStore?: PushStore;
  },
): Promise<void> {
  if (event.kind !== 9735) {
    return;
  }
  if (typeof event.id !== 'string' || event.id === '') {
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

  const indexed = await indexZapReceipt({
    store: args.store,
    messageId: row.id,
    receipt: { id: event.id, pubkey: event.pubkey, tags: event.tags },
    providerPubkey,
    amountSats,
    receiptEvent: receipt,
    noteEventId,
  });
  if (indexed && args.pushStore !== undefined) {
    try {
      await enqueueZapPush(args.pushStore, row.accountId, row.id, args.now());
    } catch {
      logEvent('push.enqueue.failed');
    }
  }
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
