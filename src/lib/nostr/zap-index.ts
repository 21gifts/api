import { createHash } from 'node:crypto';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { logEvent } from '@/lib/log';
import {
  MESSAGE_LIST_LIMIT,
  MESSAGE_MAX_LENGTH,
  normalizeForumText,
  truncatePubkeyDisplay,
  unsignedNostrDefaults,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import { notifyForumReply } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
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

/**
 * Last persisted ingest `outcome:reason` per receipt id, keyed by message store.
 * Empty after process restart; first tick may rewrite one row per known receipt.
 */
const zapDecisions = new WeakMap<MessageStore, Map<string, string>>();

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

/**
 * Persist an ingest decision without failing the tick.
 * Skips the write when this process already persisted the same outcome:reason
 * for the receipt id on this store instance.
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
 * Query zap relays for kind:9735 receipts on recent forum notes, index
 * validated ones, then insert a payer gift-reply and notify the parent
 * author. Retries receipts that have a payer and no gift-reply id yet.
 *
 * @param args - Store, auth, querier, relay urls, timeout, clock, fetch;
 *   optional `pushStore` and `notificationStore`.
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
  /** Optional notification store; gift-replies notify the parent author. */
  notificationStore?: NotificationStore;
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
  await retryGiftReplies(args);
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
    notificationStore?: NotificationStore;
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

  const indexed = await indexZapReceipt({
    store: args.store,
    messageId: row.id,
    receipt: { id: event.id, pubkey: event.pubkey, tags: event.tags },
    providerPubkey,
    amountSats,
    receiptEvent: receipt,
    noteEventId,
  });
  if (indexed && args.pushStore !== undefined && row.accountId !== null) {
    try {
      await enqueueZapPush(args.pushStore, row.accountId, row.id, args.now());
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

/** Collaborators for creating a gift-reply after a zap is indexed. */
interface GiftReplyDeps {
  store: MessageStore;
  auth: AuthStore;
  now: () => number;
  pushStore?: PushStore;
  notificationStore?: NotificationStore;
}

/**
 * Decode the receipt's parent and bolt11, then insert a gift-reply.
 * Never throws — lookup/create failures log `nostr.zap.gift_reply.failed`.
 * A soft-deleted parent is treated as missing (`payerAccountId` cleared).
 *
 * @param event - Indexed kind:9735 frame.
 * @param args - Store, auth, clock, optional notify collaborators.
 */
async function tryEnsureGiftReply(event: NostrEventFrame, args: GiftReplyDeps): Promise<void> {
  /* v8 ignore next 3 -- ingestOneReceipt already requires a receipt id */
  if (typeof event.id !== 'string' || event.id === '') {
    return;
  }
  try {
    const receipt = await args.store.getZapReceiptGift(event.id);
    if (receipt === undefined || receipt.giftReplyId !== null) {
      return;
    }
    const parent = await args.store.getById(receipt.messageId);
    if (parent === undefined || parent.deletedAt !== null) {
      await args.store.updateZapReceiptGift(event.id, { payerAccountId: null });
      return;
    }
    const taggedPr = event.tags.find((tag) => tag[0] === 'bolt11')?.[1];
    const pr = typeof taggedPr === 'string' ? taggedPr : '';
    const decoded = pr === '' ? null : decodeBolt11(pr);
    const paymentHash = decoded === null ? '' : decoded.paymentHash;
    await ensureGiftReplyFromReceipt({
      store: args.store,
      auth: args.auth,
      now: args.now,
      receiptEventId: event.id,
      parent,
      amountSats: receipt.sats,
      bolt11: pr,
      paymentHash,
      tags: event.tags,
      ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
      ...(args.notificationStore === undefined
        ? {}
        : { notificationStore: args.notificationStore }),
    });
  } catch {
    logEvent('nostr.zap.gift_reply.failed', { receiptId: event.id });
  }
}

/**
 * Create a forum reply for a newly indexed receipt (invoice first, then 9734).
 *
 * @param args - Receipt, parent, bolt11, tags.
 */
async function ensureGiftReplyFromReceipt(
  args: GiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow;
    amountSats: number;
    bolt11: string;
    paymentHash: string;
    tags: string[][];
  },
): Promise<void> {
  let payer: Account | undefined;
  let text = '';
  const byHash = await args.store.findOkInvoiceByPaymentHash(args.paymentHash);
  const invoice = byHash ?? (await args.store.findOkInvoiceByPr(args.bolt11));
  if (invoice !== undefined) {
    payer = await args.auth.getAccount(invoice.payerAccountId);
    text = commentFromZapRequest(invoice.zapRequest);
    if (payer === undefined) {
      return;
    }
  } else {
    const parsed = parseVerifiedZapRequest(args.tags);
    if (parsed !== null) {
      payer = await args.auth.getAccountByPubkey(parsed.pubkey);
      if (payer !== undefined) {
        text = parsed.content;
      }
    }
  }
  if (payer === undefined) {
    return;
  }
  await insertGiftReply({
    store: args.store,
    auth: args.auth,
    now: args.now,
    receiptEventId: args.receiptEventId,
    parent: args.parent,
    amountSats: args.amountSats,
    payer,
    text,
    ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    ...(args.notificationStore === undefined ? {} : { notificationStore: args.notificationStore }),
  });
}

/**
 * Retry receipts that have a payer but no gift-reply row yet.
 *
 * @param args - Store, auth, optional notify collaborators.
 */
async function retryGiftReplies(args: GiftReplyDeps): Promise<void> {
  const pending = await args.store.listZapReceiptsAwaitingGiftReply(MESSAGE_LIST_LIMIT);
  for (const row of pending) {
    try {
      const parent = await args.store.getById(row.messageId);
      if (parent === undefined || parent.deletedAt !== null) {
        await args.store.updateZapReceiptGift(row.receiptEventId, { payerAccountId: null });
        continue;
      }
      const payer = await args.auth.getAccount(row.payerAccountId);
      if (payer === undefined) {
        await args.store.updateZapReceiptGift(row.receiptEventId, { payerAccountId: null });
        continue;
      }
      const text = row.comment;
      await insertGiftReply({
        store: args.store,
        auth: args.auth,
        now: args.now,
        receiptEventId: row.receiptEventId,
        parent,
        amountSats: row.sats,
        payer,
        text,
        ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
        ...(args.notificationStore === undefined
          ? {}
          : { notificationStore: args.notificationStore }),
      });
    } catch {
      logEvent('nostr.zap.gift_reply.failed', { receiptId: row.receiptEventId });
    }
  }
}

/**
 * Persist the gift-reply row and notify. Logs and returns on create/notify failure.
 *
 * @param args - Payer, parent, text, receipt id.
 */
async function insertGiftReply(
  args: GiftReplyDeps & {
    receiptEventId: string;
    parent: MessageRow;
    amountSats: number;
    payer: Account;
    text: string;
  },
): Promise<void> {
  await args.store.updateZapReceiptGift(args.receiptEventId, {
    payerAccountId: args.payer.id,
    comment: args.text,
  });
  const receipt = await args.store.getZapReceiptGift(args.receiptEventId);
  /* v8 ignore next 3 -- gift_reply_id already set (retry race) */
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
  try {
    await notifyForumReply({
      messages: args.store,
      account: args.payer,
      created,
      parentId: args.parent.id,
      ...(args.notificationStore === undefined ? {} : { notifications: args.notificationStore }),
      ...(args.pushStore === undefined ? {} : { pushStore: args.pushStore }),
    });
  } catch {
    logEvent('messages.reply.notify.failed');
  }
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
