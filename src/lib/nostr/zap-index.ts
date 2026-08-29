import type { AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import type { NostrQuerier } from '@/lib/nostr/query';

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
 * Validate a kind:9735 receipt against the author's LNURL `nostrPubkey`
 * and add sats to the message once via durable receipt storage.
 *
 * Full Appendix F (bolt11 description hash) is applied when `bolt11AmountSats`
 * is provided by the caller; the provider pubkey check is mandatory.
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
}): Promise<boolean> {
  if (args.receipt.pubkey !== args.providerPubkey) {
    logEvent('nostr.zap.rejected', { reason: 'pubkey' });
    return false;
  }
  if (!Number.isInteger(args.amountSats) || args.amountSats <= 0) {
    logEvent('nostr.zap.rejected', { reason: 'amount' });
    return false;
  }
  const added = await args.store.recordZapReceipt(args.receipt.id, args.messageId, args.amountSats);
  if (!added) {
    return false;
  }
  logEvent('nostr.zap.indexed', { messageId: args.messageId, sats: args.amountSats });
  return true;
}

/**
 * Query write-set relays for kind:9735 receipts on recent forum notes and
 * index validated ones.
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
    for (const event of events) {
      await ingestOneReceipt(event, args);
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
  event: {
    id: string;
    pubkey: string;
    kind: number;
    tags: string[][];
  },
  args: {
    store: MessageStore;
    auth: AuthStore;
    now: () => number;
    fetchImpl: FetchFn;
  },
): Promise<void> {
  if (event.kind !== 9735) {
    return;
  }
  if (typeof event.id !== 'string' || event.id === '') {
    return;
  }
  if (typeof event.pubkey !== 'string' || event.pubkey === '') {
    return;
  }

  const eTag = event.tags.find((tag) => tag[0] === 'e' && typeof tag[1] === 'string');
  const noteEventId = eTag?.[1];
  if (noteEventId === undefined || noteEventId === '') {
    logEvent('nostr.zap.rejected', { reason: 'event' });
    return;
  }
  const row = await args.store.getByEventId(noteEventId);
  if (row === undefined) {
    logEvent('nostr.zap.rejected', { reason: 'event' });
    return;
  }

  const bolt11Tag = event.tags.find((tag) => tag[0] === 'bolt11' && typeof tag[1] === 'string');
  const pr = bolt11Tag?.[1];
  if (pr === undefined || pr === '') {
    logEvent('nostr.zap.rejected', { reason: 'bolt11' });
    return;
  }
  const decoded = decodeBolt11(pr);
  if (decoded === null) {
    logEvent('nostr.zap.rejected', { reason: 'bolt11' });
    return;
  }
  const amountSats = Math.floor(decoded.amountMsat / 1000);
  if (amountSats < 1) {
    logEvent('nostr.zap.rejected', { reason: 'amount' });
    return;
  }

  const author = await args.auth.getAccount(row.accountId);
  const address = author?.lightningAddress;
  if (address === undefined || address === null || address.trim() === '') {
    logEvent('nostr.zap.rejected', { reason: 'address' });
    return;
  }

  const providerPubkey = await resolveProviderPubkey({
    address: address.trim().toLowerCase(),
    fetchImpl: args.fetchImpl,
    nowMs: args.now(),
  });
  if (providerPubkey === null) {
    logEvent('nostr.zap.rejected', { reason: 'provider' });
    return;
  }

  await indexZapReceipt({
    store: args.store,
    messageId: row.id,
    receipt: { id: event.id, pubkey: event.pubkey, tags: event.tags },
    providerPubkey,
    amountSats,
  });
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
    nostrPubkey = resolved.metadata.nostrPubkey;
  }
  providerPubkeyCache.set(args.address, {
    nostrPubkey,
    expiresAt: args.nowMs + LN_ADDRESS_CACHE_TTL_MS,
  });
  return nostrPubkey;
}
