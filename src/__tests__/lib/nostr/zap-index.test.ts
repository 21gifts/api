import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { decodeBolt11, inspectBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { unsignedConversationDefaults } from '@/lib/conversation';
import { MESSAGE_LIST_LIMIT, unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import {
  InMemoryMessageStore,
  type MessageFeedQuery,
  type MessageInvoiceAttempt,
  type UnattributedIndexedReceipt,
  type ZapIngestRow,
  type ZapReceiptGiftRow,
} from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { verifiedExternalZapRequest } from '@/lib/nostr/external';
import type { NostrEventFrame } from '@/lib/nostr/query';
import { RecordingQuerier } from '@/lib/nostr/query';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  backfillZapPayments,
  backfillExternalZappers,
  indexOpenZapReceipts,
  indexZapReceipt,
  manualReceiptIdForPaymentHash,
  settleInvoiceManually,
} from '@/lib/nostr/zap-index';
import { PostRateLimiter } from '@/lib/nostr/rate-limit';
import { InMemoryPushStore } from '@/lib/push-store';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
  inspectBolt11: vi.fn(),
}));

vi.mock('@/lib/nostr/external', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nostr/external')>();
  return {
    ...actual,
    verifiedExternalZapRequest: vi.fn(actual.verifiedExternalZapRequest),
  };
});

const mockedDecode = vi.mocked(decodeBolt11);
const mockedInspect = vi.mocked(inspectBolt11);
const mockedVerifiedExternalZapRequest = vi.mocked(verifiedExternalZapRequest);

const NOTE_EVENT_ID = 'ee'.repeat(32);
const PROVIDER_PUBKEY = 'aa'.repeat(32);
const URLS = ['wss://relay.example'] as const;

/** Distinct 64-hex view key derived from an account id (multi-account tests). */
function viewKeyFor(accountId: string): string {
  const hex = [...accountId].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return (hex + '0'.repeat(64)).slice(0, 64);
}

/** Seed one signed forum row and optional author account. */
async function seedStore(args: {
  store: InMemoryMessageStore;
  auth: InMemoryAuthStore;
  accountId: string;
  eventId?: string | null;
  lightningAddress?: string | null;
  messageId?: string;
  createAccount?: boolean;
}): Promise<string> {
  const messageId = args.messageId ?? `m-${args.accountId}`;
  if (args.createAccount !== false) {
    await args.auth.createAccount({
      id: args.accountId,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress:
        args.lightningAddress === undefined ? 'seed@example.com' : args.lightningAddress,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor(args.accountId),
      createdAt: 1,
      rulesAgreedAt: null,
    });
  }
  await args.store.create({
    id: messageId,
    accountId: args.accountId,
    name: 'Ada',
    text: 'hi',
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    eventId: args.eventId === undefined ? NOTE_EVENT_ID : args.eventId,
  });
  return messageId;
}

/** LNURL-pay metadata fetch returning a zap-capable provider pubkey. */
function lnurlFetch(nostrPubkey: string): FetchFn {
  return async () =>
    new Response(
      JSON.stringify({
        callback: 'https://example.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: 10_000_000,
        allowsNostr: true,
        nostrPubkey,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

/** Always-failing fetch (HTTP 500). */
function failFetch(): FetchFn {
  return async () => new Response('{}', { status: 500 });
}

/** Ingest helper: skip real schnorr checks in unit tests. */
async function ingest(
  args: Parameters<typeof indexOpenZapReceipts>[0],
): ReturnType<typeof indexOpenZapReceipts> {
  return indexOpenZapReceipts({
    verifyReceipt: () => true,
    ...args,
  });
}

/** Build one historical indexed-ingest fixture. */
function indexedZapIngest(args: {
  id: string;
  receiptId: string;
  createdAt: string;
  bolt11?: string;
}): ZapIngestRow {
  return {
    id: args.id,
    createdAt: new Date(args.createdAt),
    receiptId: args.receiptId,
    noteEventId: NOTE_EVENT_ID,
    messageId: 'legacy-message',
    outcome: 'indexed',
    reason: null,
    amountSats: 21,
    receiptPubkey: PROVIDER_PUBKEY,
    receipt: {
      id: args.receiptId,
      tags: args.bolt11 === undefined ? [] : [['bolt11', args.bolt11]],
    },
  };
}

/** Parse structured operator events emitted through console.warn. */
function loggedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

/** Build a signed external zap request and its receipt frame. */
function externalZapFixture(args: {
  receiptId: string;
  bolt11: string;
  noteEventId?: string;
  requestNoteEventId?: string;
  amount?: string;
  content?: string;
  createdAt?: number;
  secret?: Uint8Array;
  /** Signed 9734 JSON to embed verbatim — a replay copies the request byte for byte. */
  description?: string;
}): {
  pubkey: string;
  requestId: string;
  description: string;
  descriptionHash: string;
  receipt: NostrEventFrame;
} {
  const secret = args.secret ?? generateSecretKey();
  const request = finalizeEvent(
    {
      kind: 9734,
      created_at: 1_700_000_000,
      tags: [
        ['e', args.requestNoteEventId ?? args.noteEventId ?? NOTE_EVENT_ID],
        ['amount', args.amount ?? '21000'],
      ],
      content: args.content ?? 'external gift',
    },
    secret,
  );
  const copied =
    args.description === undefined
      ? undefined
      : (JSON.parse(args.description) as { id: string; pubkey: string });
  const description = args.description ?? JSON.stringify(request);
  return {
    pubkey: copied?.pubkey ?? request.pubkey,
    requestId: copied?.id ?? request.id,
    description,
    descriptionHash: createHash('sha256').update(description).digest('hex'),
    receipt: {
      id: args.receiptId,
      pubkey: PROVIDER_PUBKEY,
      kind: 9735,
      tags: [
        ['e', args.noteEventId ?? NOTE_EVENT_ID],
        ['bolt11', args.bolt11],
        ['description', description],
      ],
      created_at: args.createdAt ?? 1_700_000_100,
      content: '',
      sig: 'ff'.repeat(32),
    },
  };
}

/** Store override for focused historical-frame backfill cases. */
class BackfillRowsStore extends InMemoryMessageStore {
  readonly backfillCalls: Array<{
    limit: number;
    before: { createdAt: Date; eventId: string } | undefined;
  }> = [];
  readonly returnedReceiptIds: string[] = [];

  constructor(readonly backfillRows: UnattributedIndexedReceipt[]) {
    super();
  }

  override listUnattributedIndexedReceipts(
    limit: number,
    before?: { createdAt: Date; eventId: string },
  ): ReturnType<InMemoryMessageStore['listUnattributedIndexedReceipts']> {
    this.backfillCalls.push({
      limit,
      before:
        before === undefined
          ? undefined
          : { createdAt: new Date(before.createdAt.getTime()), eventId: before.eventId },
    });
    const sorted = [...this.backfillRows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.receiptEventId.localeCompare(a.receiptEventId);
    });
    const candidates =
      before === undefined
        ? sorted
        : sorted.filter((row) => {
            const byTime = row.createdAt.getTime() - before.createdAt.getTime();
            return (
              byTime < 0 || (byTime === 0 && row.receiptEventId.localeCompare(before.eventId) < 0)
            );
          });
    const page = candidates.slice(0, limit);
    this.returnedReceiptIds.push(...page.map((row) => row.receiptEventId));
    return Promise.resolve(page);
  }
}

/** Paging store that simulates another worker attributing a seen receipt between pages. */
class BetweenPagesAttributionStore extends BackfillRowsStore {
  #attributed = false;

  override listUnattributedIndexedReceipts(
    limit: number,
    before?: { createdAt: Date; eventId: string },
  ): ReturnType<InMemoryMessageStore['listUnattributedIndexedReceipts']> {
    if (before !== undefined && !this.#attributed) {
      const index = this.backfillRows.findIndex(
        (row) => row.receiptEventId === 'zz-attributed-between-pages',
      );
      if (index >= 0) {
        this.backfillRows.splice(index, 1);
      }
      this.#attributed = true;
    }
    return super.listUnattributedIndexedReceipts(limit, before);
  }
}

/** Historical indexed receipt row with deterministic defaults. */
function backfillRow(
  receiptEventId: string,
  receipt: Record<string, unknown>,
  messageId = 'backfill-skip-parent',
): UnattributedIndexedReceipt {
  return {
    receiptEventId,
    messageId,
    sats: 21,
    createdAt: new Date('2026-09-18T10:00:00.000Z'),
    receipt,
  };
}

/** Store whose final receipt-to-gift link can fail after attribution. */
class GiftLinkFailureStore extends InMemoryMessageStore {
  failGiftLinks = true;

  override updateZapReceiptGift(
    ...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>
  ): ReturnType<InMemoryMessageStore['updateZapReceiptGift']> {
    if (this.failGiftLinks && args[1].giftReplyId !== undefined) {
      return Promise.reject(new Error('link failed'));
    }
    return super.updateZapReceiptGift(...args);
  }
}

/** Prepare a member zap whose deterministic reply link remains pending. */
async function memberGiftRetryFixture(
  slug: string,
  paymentHash: string,
): Promise<{
  store: GiftLinkFailureStore;
  auth: InMemoryAuthStore;
  parentId: string;
  payerId: string;
  receiptId: string;
  querier: RecordingQuerier;
}> {
  const store = new GiftLinkFailureStore();
  const auth = new InMemoryAuthStore();
  const authorId = `${slug}-author`;
  const payerId = `${slug}-payer`;
  const parentId = await seedStore({
    store,
    auth,
    accountId: authorId,
    lightningAddress: `${slug}-author@example.com`,
    messageId: `${slug}-parent`,
  });
  await auth.createAccount({
    id: payerId,
    linkingKey: null,
    role: 'basis',
    name: 'Retry Payer',
    lightningAddress: `${slug}-payer@example.com`,
    lightningAddressVerified: true,
    location: null,
    forumLawsDismissed: false,
    viewKey: viewKeyFor(payerId),
    createdAt: 2,
    rulesAgreedAt: null,
  });
  const bolt11 = `lnbc-${slug}`;
  await store.recordInvoiceAttempt({
    id: `${slug}-invoice`,
    createdAt: new Date('2026-09-18T10:00:00.000Z'),
    messageId: parentId,
    payerAccountId: payerId,
    authorAccountId: authorId,
    amountSats: 21,
    lightningAddress: `${slug}-author@example.com`,
    zapRequest: { content: `${slug} gift` },
    result: 'ok',
    httpStatus: 200,
    pr: bolt11,
    paymentHash,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
  });
  const receiptId = `${slug}-receipt`;
  const querier = new RecordingQuerier();
  querier.events = [
    {
      id: receiptId,
      pubkey: PROVIDER_PUBKEY,
      kind: 9735,
      tags: [
        ['e', NOTE_EVENT_ID],
        ['bolt11', bolt11],
      ],
    },
  ];
  mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
  mockedInspect.mockReturnValue(null);
  return { store, auth, parentId, payerId, receiptId, querier };
}

/** Prepare a strictly verified external zap for retry-path tests. */
async function externalGiftRetryFixture(
  store: InMemoryMessageStore,
  slug: string,
  paymentHash: string,
): Promise<{
  auth: InMemoryAuthStore;
  parentId: string;
  fixture: ReturnType<typeof externalZapFixture>;
  querier: RecordingQuerier;
}> {
  const auth = new InMemoryAuthStore();
  const parentId = await seedStore({
    store,
    auth,
    accountId: `${slug}-author`,
    lightningAddress: `${slug}-author@example.com`,
    messageId: `${slug}-parent`,
  });
  const fixture = externalZapFixture({
    receiptId: `${slug}-receipt`,
    bolt11: `lnbc-${slug}`,
    content: `${slug} gift`,
  });
  mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
  mockedInspect.mockReturnValue({
    paymentHash,
    amountMsat: 21_000,
    description: null,
    descriptionHash: fixture.descriptionHash,
    expirySeconds: null,
  });
  const querier = new RecordingQuerier();
  querier.events = [fixture.receipt];
  return { auth, parentId, fixture, querier };
}

/** Seed one successful forum invoice for manual-settle tests. */
async function seedManualInvoice(
  store: InMemoryMessageStore,
  paymentHash: string,
  overrides: Partial<MessageInvoiceAttempt> = {},
): Promise<void> {
  await store.recordInvoiceAttempt({
    id: `manual-invoice-${paymentHash.slice(0, 4)}`,
    createdAt: new Date('2026-09-18T11:00:00.000Z'),
    messageId: 'manual-message',
    payerAccountId: 'manual-payer',
    authorAccountId: 'manual-author',
    amountSats: 210_000,
    lightningAddress: 'author@example.com',
    zapRequest: { content: 'manual gift' },
    result: 'ok',
    httpStatus: 200,
    pr: 'lnbc-manual',
    paymentHash,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    ...overrides,
  });
}

describe('backfillZapPayments', () => {
  it('logs an empty completed pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(backfillZapPayments(new InMemoryMessageStore())).resolves.toBe(0);
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 0, total: 0 }),
    ]);
    warn.mockRestore();
  });

  it('skips an indexed ingest without a payment hash', async () => {
    const store = new InMemoryMessageStore();
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'hashless-ingest',
        receiptId: 'hashless-receipt',
        createdAt: '2026-09-18T10:00:00.000Z',
      }),
    );
    const claim = vi.spyOn(store, 'claimZapPayment');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(backfillZapPayments(store)).resolves.toBe(0);
    expect(claim).not.toHaveBeenCalled();
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 0, total: 1 }),
    ]);
    warn.mockRestore();
  });

  it('gives a shared hash to the oldest indexed receipt and logs the newer conflict', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = '21'.repeat(32);
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'older-ingest',
        receiptId: 'older-receipt',
        createdAt: '2026-09-18T10:00:00.000Z',
        bolt11: 'lnbc-shared-old',
      }),
    );
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'newer-ingest',
        receiptId: 'newer-receipt',
        createdAt: '2026-09-18T11:00:00.000Z',
        bolt11: 'lnbc-shared-new',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(backfillZapPayments(store)).resolves.toBe(1);
    expect(await store.claimZapPayment(paymentHash, 'older-receipt', new Date())).toBe(true);
    expect(await store.claimZapPayment(paymentHash, 'newer-receipt', new Date())).toBe(false);
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({
        event: 'nostr.zap.backfill.conflict',
        receiptId: 'newer-receipt',
      }),
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 1, total: 2 }),
    ]);
    warn.mockRestore();
  });

  it('accepts the same owner again on an idempotent second pass', async () => {
    const store = new InMemoryMessageStore();
    mockedDecode.mockReturnValue({ paymentHash: '22'.repeat(32), amountMsat: 21_000 });
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'repeat-ingest',
        receiptId: 'repeat-receipt',
        createdAt: '2026-09-18T10:00:00.000Z',
        bolt11: 'lnbc-repeat',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(backfillZapPayments(store)).resolves.toBe(1);
    await expect(backfillZapPayments(store)).resolves.toBe(1);
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 1, total: 1 }),
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 1, total: 1 }),
    ]);
    warn.mockRestore();
  });

  it('propagates store failures', async () => {
    class FailingBackfillStore extends InMemoryMessageStore {
      override listIndexedZapIngests(): Promise<ZapIngestRow[]> {
        return Promise.reject(new Error('backfill read failed'));
      }
    }
    await expect(backfillZapPayments(new FailingBackfillStore())).rejects.toThrow(
      'backfill read failed',
    );
  });
});

describe('backfillExternalZappers', () => {
  it('stops after an empty initial page without advancing a cursor', async () => {
    const store = new BackfillRowsStore([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth: new InMemoryAuthStore(),
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(store.backfillCalls).toEqual([{ limit: 200, before: undefined }]);
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zapper.backfill.done', scanned: 0 }),
    );
    warn.mockRestore();
  });

  it('pages past 450 newer unattributable receipts and is idempotent', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'paged-backfill-author',
      messageId: 'paged-backfill-parent',
    });
    for (let index = 0; index < 450; index += 1) {
      const receiptId = `newer-unattributable-${index.toString().padStart(3, '0')}`;
      await store.recordZapReceipt(receiptId, parentId, 1);
      await store.recordZapIngest({
        id: `newer-ingest-${index.toString().padStart(3, '0')}`,
        createdAt: new Date('2026-09-18T11:00:00.000Z'),
        receiptId,
        noteEventId: NOTE_EVENT_ID,
        messageId: parentId,
        outcome: 'indexed',
        reason: null,
        amountSats: 1,
        receiptPubkey: PROVIDER_PUBKEY,
        receipt: {
          id: `mismatched-${receiptId}`,
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [],
        },
      });
    }
    const fixture = externalZapFixture({
      receiptId: 'older-valid-receipt',
      bolt11: 'lnbc-older-valid',
      content: 'older gift',
    });
    await store.recordZapReceipt(fixture.receipt.id, parentId, 21);
    await store.recordZapIngest({
      id: 'older-valid-ingest',
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      receiptId: fixture.receipt.id,
      noteEventId: NOTE_EVENT_ID,
      messageId: parentId,
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: PROVIDER_PUBKEY,
      receipt: { ...fixture.receipt },
    });
    mockedDecode.mockReturnValue({ paymentHash: '90'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '90'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deps = {
      auth,
      querier: new RecordingQuerier(),
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_800_000_000_000,
    };

    await expect(backfillExternalZappers(store, deps)).resolves.toBe(1);
    expect(await store.listReplies(parentId)).toHaveLength(1);
    expect((await store.listReplies(parentId))[0]?.text).toBe('older gift');
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'nostr.zapper.backfill.done',
        scanned: 451,
        verified: 1,
        attributed: 1,
        gifts: 1,
      }),
    );

    await expect(backfillExternalZappers(store, deps)).resolves.toBe(0);
    expect(await store.listReplies(parentId)).toHaveLength(1);
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'nostr.zapper.backfill.done',
        scanned: 450,
        verified: 0,
        attributed: 0,
        gifts: 0,
      }),
    );
    warn.mockRestore();
  });

  it('stops and logs after scanning the 10,000-receipt ceiling', async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) =>
      backfillRow(`ceiling-receipt-${index}`, {
        id: `mismatched-ceiling-receipt-${index}`,
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [],
      }),
    );
    const store = new BackfillRowsStore(rows);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth: new InMemoryAuthStore(),
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(store.backfillCalls).toHaveLength(50);
    expect(store.backfillCalls[0]).toEqual({ limit: 200, before: undefined });
    expect(store.backfillCalls.at(-1)?.limit).toBe(200);
    expect(store.backfillCalls.at(-1)?.before).toBeDefined();
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zapper.backfill.ceiling', ceiling: 10_000 }),
    );
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zapper.backfill.done', scanned: 10_000 }),
    );
    warn.mockRestore();
  });

  it('does not skip or repeat rows when a seen receipt is attributed between pages', async () => {
    const rows = [
      backfillRow('zz-attributed-between-pages', {
        id: 'mismatched-attributed-between-pages',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [],
      }),
      ...Array.from({ length: 199 }, (_, index) =>
        backfillRow(`yy-staying-receipt-${index.toString().padStart(3, '0')}`, {
          id: `mismatched-staying-receipt-${index.toString().padStart(3, '0')}`,
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [],
        }),
      ),
      backfillRow('aa-oldest-receipt', {
        id: 'mismatched-oldest-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [],
      }),
    ];
    const store = new BetweenPagesAttributionStore(rows);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth: new InMemoryAuthStore(),
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(store.backfillCalls).toHaveLength(2);
    expect(store.backfillCalls[0]).toEqual({ limit: 200, before: undefined });
    expect(store.backfillCalls[1]?.before).toEqual({
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      eventId: 'yy-staying-receipt-000',
    });
    expect(store.returnedReceiptIds).toHaveLength(201);
    expect(new Set(store.returnedReceiptIds).size).toBe(201);
    expect(store.returnedReceiptIds).toContain('aa-oldest-receipt');
    warn.mockRestore();
  });

  it('creates an external gift reply and skips an account-owned pubkey', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'backfill-author',
      messageId: 'backfill-parent',
    });
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const request = finalizeEvent(
      {
        kind: 9734,
        created_at: 1_700_000_000,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['amount', '21000'],
        ],
        content: 'historical gift',
      },
      secret,
    );
    const description = JSON.stringify(request);
    const hash = createHash('sha256').update(description).digest('hex');
    mockedDecode.mockReturnValue({ paymentHash: '91'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '91'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: hash,
      expirySeconds: null,
    });
    await store.recordZapReceipt('backfill-receipt', parentId, 21);
    await store.recordZapIngest({
      id: 'backfill-ingest',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: 'backfill-receipt',
      noteEventId: NOTE_EVENT_ID,
      messageId: parentId,
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: PROVIDER_PUBKEY,
      receipt: {
        id: 'backfill-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-backfill'],
          ['description', description],
        ],
        created_at: 1_700_000_100,
        content: '',
        sig: 'sig',
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      backfillExternalZappers(store, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(1);
    expect(await store.listZapperPubkeys()).toEqual([pubkey]);
    expect((await store.listReplies(parentId))[0]).toMatchObject({
      accountId: null,
      authorPubkey: pubkey,
      text: 'historical gift',
      nostrPublishState: 'skipped',
    });

    await auth.setNostrKeyIfAbsent('backfill-author', {
      pubkey,
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    const secondStore = new InMemoryMessageStore();
    await secondStore.create((await store.getById(parentId))!);
    await secondStore.recordZapReceipt('member-receipt', parentId, 21);
    await secondStore.recordZapIngest({
      ...(await store.listZapIngests(1))[0]!,
      id: 'member-ingest',
      receiptId: 'member-receipt',
      receipt: { ...(await store.listZapIngests(1))[0]!.receipt, id: 'member-receipt' },
    });
    await expect(
      backfillExternalZappers(secondStore, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);
    expect(await secondStore.listZapperPubkeys()).toEqual([]);
    expect(
      loggedEvents(warn).some((event) => event['event'] === 'nostr.zapper.backfill.done'),
    ).toBe(true);
    warn.mockRestore();
    mockedInspect.mockReset();
  });

  it('does not record entitlement when the credited amount is below the minimum', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'backfill-zero-author',
      messageId: 'backfill-zero-parent',
    });
    const fixture = externalZapFixture({
      receiptId: 'backfill-zero-receipt',
      bolt11: 'lnbc-backfill-zero',
    });
    mockedDecode.mockReturnValue({ paymentHash: '92'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '92'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    await store.recordZapReceipt(fixture.receipt.id, parentId, 0);
    await store.recordZapIngest({
      id: 'backfill-zero-ingest',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: fixture.receipt.id,
      noteEventId: NOTE_EVENT_ID,
      messageId: parentId,
      outcome: 'indexed',
      reason: null,
      amountSats: 0,
      receiptPubkey: PROVIDER_PUBKEY,
      receipt: { ...fixture.receipt },
    });
    const recordZapper = vi.spyOn(store, 'recordZapper');

    await expect(
      backfillExternalZappers(store, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(1);

    expect(recordZapper).not.toHaveBeenCalled();
    expect(await store.listZapperPubkeys()).toEqual([]);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it.each([
    [
      'a mismatched receipt id',
      { id: 'different-backfill-id', pubkey: PROVIDER_PUBKEY, kind: 9735, tags: [] },
    ],
    [
      'a missing tags field',
      { id: 'malformed-backfill-receipt', pubkey: PROVIDER_PUBKEY, kind: 9735 },
    ],
    [
      'a non-array tags field',
      {
        id: 'malformed-backfill-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: 'not-tags',
      },
    ],
    [
      'a tag containing a non-string part',
      {
        id: 'malformed-backfill-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [['e', 21]],
      },
    ],
  ])('skips %s in the stored backfill frame', async (_caseName, receipt) => {
    const store = new BackfillRowsStore([backfillRow('malformed-backfill-receipt', receipt)]);
    const auth = new InMemoryAuthStore();
    const recordZapper = vi.spyOn(store, 'recordZapper');
    mockedDecode.mockClear();
    mockedInspect.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(mockedDecode).not.toHaveBeenCalled();
    expect(mockedInspect).not.toHaveBeenCalled();
    expect(recordZapper).not.toHaveBeenCalled();
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ verified: 0, attributed: 0, gifts: 0 }),
    );
    warn.mockRestore();
  });

  it.each([
    ['has no e tag', [['bolt11', 'lnbc-backfill-tags']]],
    [
      'has an empty e tag',
      [
        ['e', ''],
        ['bolt11', 'lnbc-backfill-tags'],
      ],
    ],
    ['has no bolt11 tag', [['e', NOTE_EVENT_ID]]],
  ])('skips a stored backfill frame that %s', async (_caseName, tags) => {
    const receiptId = 'missing-backfill-tag-receipt';
    const store = new BackfillRowsStore([
      backfillRow(receiptId, {
        id: receiptId,
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags,
      }),
    ]);
    mockedDecode.mockClear();
    mockedInspect.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth: new InMemoryAuthStore(),
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(mockedDecode).not.toHaveBeenCalled();
    expect(mockedInspect).not.toHaveBeenCalled();
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ verified: 0, attributed: 0, gifts: 0 }),
    );
    warn.mockRestore();
  });

  it.each(['decode failure', 'inspection failure', 'sub-sat amount'] as const)(
    'skips a stored backfill frame after %s',
    async (failure) => {
      const receiptId = `decoded-backfill-${failure.replaceAll(' ', '-')}`;
      const store = new BackfillRowsStore([
        backfillRow(receiptId, {
          id: receiptId,
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [
            ['e', NOTE_EVENT_ID],
            ['bolt11', 'lnbc-backfill-decoder'],
          ],
        }),
      ]);
      mockedDecode.mockReturnValue(
        failure === 'decode failure'
          ? null
          : {
              paymentHash: '93'.repeat(32),
              amountMsat: failure === 'sub-sat amount' ? 999 : 21_000,
            },
      );
      mockedInspect.mockReturnValue(
        failure === 'inspection failure'
          ? null
          : {
              paymentHash: '93'.repeat(32),
              amountMsat: 21_000,
              description: null,
              descriptionHash: '94'.repeat(32),
              expirySeconds: null,
            },
      );
      const recordZapper = vi.spyOn(store, 'recordZapper');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        backfillExternalZappers(store, {
          auth: new InMemoryAuthStore(),
          querier: new RecordingQuerier(),
          urls: URLS,
          timeoutMs: 50,
          now: () => 1_800_000_000_000,
        }),
      ).resolves.toBe(0);

      expect(recordZapper).not.toHaveBeenCalled();
      expect(loggedEvents(warn)).toContainEqual(
        expect.objectContaining({ verified: 0, attributed: 0, gifts: 0 }),
      );
      warn.mockRestore();
    },
  );

  it('accepts a stored frame that omits optional receipt fields', async () => {
    const auth = new InMemoryAuthStore();
    const fixture = externalZapFixture({
      receiptId: 'optional-backfill-receipt',
      bolt11: 'lnbc-optional-backfill',
    });
    const storedReceipt = {
      id: fixture.receipt.id,
      pubkey: fixture.receipt.pubkey,
      kind: fixture.receipt.kind,
      tags: fixture.receipt.tags,
    };
    const row = backfillRow(fixture.receipt.id, storedReceipt, 'optional-backfill-parent');
    const store = new BackfillRowsStore([row]);
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'optional-backfill-author',
      messageId: row.messageId,
    });
    await store.recordZapReceipt(fixture.receipt.id, parentId, 21);
    mockedDecode.mockReturnValue({ paymentHash: '95'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '95'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });

    await expect(
      backfillExternalZappers(store, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(1);

    expect(store.backfillRows[0]?.receipt).not.toHaveProperty('created_at');
    expect(store.backfillRows[0]?.receipt).not.toHaveProperty('sig');
    expect(store.backfillRows[0]?.receipt).not.toHaveProperty('content');
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.createdAt).toEqual(row.createdAt);
  });

  it('keeps an account-owned zap request out of the external backfill', async () => {
    const auth = new InMemoryAuthStore();
    const fixture = externalZapFixture({
      receiptId: 'member-only-backfill-receipt',
      bolt11: 'lnbc-member-only-backfill',
    });
    const row = backfillRow(
      fixture.receipt.id,
      { ...fixture.receipt },
      'member-only-backfill-parent',
    );
    const store = new BackfillRowsStore([row]);
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'member-only-backfill-owner',
      messageId: row.messageId,
    });
    await auth.setNostrKeyIfAbsent('member-only-backfill-owner', {
      pubkey: fixture.pubkey,
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    await store.recordZapReceipt(fixture.receipt.id, parentId, 21);
    mockedDecode.mockReturnValue({ paymentHash: '96'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '96'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    const recordZapper = vi.spyOn(store, 'recordZapper');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      backfillExternalZappers(store, {
        auth,
        querier: new RecordingQuerier(),
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toBe(0);

    expect(recordZapper).not.toHaveBeenCalled();
    expect(await store.listZapperPubkeys()).toEqual([]);
    expect(await store.listReplies(parentId)).toEqual([]);
    expect(loggedEvents(warn)).toContainEqual(
      expect.objectContaining({ verified: 0, attributed: 0, gifts: 0 }),
    );
    warn.mockRestore();
  });
});

describe('manual invoice settlement', () => {
  it('derives a lowercase deterministic 64-hex receipt id', () => {
    const paymentHash = 'AB'.repeat(32);
    const expected = createHash('sha256')
      .update(`21gifts-manual-settle:${paymentHash.toLowerCase()}`)
      .digest('hex');
    expect(manualReceiptIdForPaymentHash(paymentHash)).toBe(expected);
    expect(manualReceiptIdForPaymentHash(paymentHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed hashes, notes, and optional preimages before lookup', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const settle = (paymentHash: string, note: string, preimage?: string) =>
      settleInvoiceManually({
        store,
        auth,
        now: () => 1,
        paymentHash,
        note,
        ...(preimage === undefined ? {} : { preimage }),
      });
    await expect(settle('bad', 'evidence')).resolves.toEqual({ ok: false, reason: 'shape' });
    await expect(settle('aa'.repeat(32), '   ')).resolves.toEqual({
      ok: false,
      reason: 'note',
    });
    await expect(settle('aa'.repeat(32), 'a'.repeat(501))).resolves.toEqual({
      ok: false,
      reason: 'note',
    });
    await expect(settle('aa'.repeat(32), 'bad\u0001note')).resolves.toEqual({
      ok: false,
      reason: 'note',
    });
    await expect(settle('aa'.repeat(32), 'evidence', 'bad')).resolves.toEqual({
      ok: false,
      reason: 'shape',
    });
    await expect(settle('aa'.repeat(32), 'evidence', 'bb'.repeat(32))).resolves.toEqual({
      ok: false,
      reason: 'preimage',
    });
    expect(await store.listZapIngests(10)).toEqual([]);
  });

  it('rejects missing or unusable successful invoices', async () => {
    const auth = new InMemoryAuthStore();
    const hash = '31'.repeat(32);
    await expect(
      settleInvoiceManually({
        store: new InMemoryMessageStore(),
        auth,
        now: () => 1,
        paymentHash: hash,
        note: 'evidence',
      }),
    ).resolves.toEqual({ ok: false, reason: 'invoice' });

    for (const overrides of [
      { amountSats: 1.5 },
      { amountSats: 0 },
      { pr: null },
      { pr: '   ' },
    ] satisfies Array<Partial<MessageInvoiceAttempt>>) {
      const store = new InMemoryMessageStore();
      await seedManualInvoice(store, hash, overrides);
      await expect(
        settleInvoiceManually({
          store,
          auth,
          now: () => 1,
          paymentHash: hash,
          note: 'evidence',
        }),
      ).resolves.toEqual({ ok: false, reason: 'invoice' });
    }
  });

  it('rejects conversation, missing, and deleted message targets', async () => {
    const auth = new InMemoryAuthStore();
    const conversationStore = new InMemoryMessageStore();
    await seedManualInvoice(conversationStore, '32'.repeat(32), {
      conversationId: 'conversation',
    });
    await expect(
      settleInvoiceManually({
        store: conversationStore,
        auth,
        now: () => 1,
        paymentHash: '32'.repeat(32),
        note: 'evidence',
      }),
    ).resolves.toEqual({ ok: false, reason: 'conversation' });

    const missingStore = new InMemoryMessageStore();
    await seedManualInvoice(missingStore, '33'.repeat(32));
    await expect(
      settleInvoiceManually({
        store: missingStore,
        auth,
        now: () => 1,
        paymentHash: '33'.repeat(32),
        note: 'evidence',
      }),
    ).resolves.toEqual({ ok: false, reason: 'message' });

    const deletedStore = new InMemoryMessageStore();
    await deletedStore.create({
      id: 'manual-message',
      accountId: 'manual-author',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await deletedStore.markDeleted('manual-message', new Date(2), 'moderator');
    await seedManualInvoice(deletedStore, '34'.repeat(32));
    await expect(
      settleInvoiceManually({
        store: deletedStore,
        auth,
        now: () => 1,
        paymentHash: '34'.repeat(32),
        note: 'evidence',
      }),
    ).resolves.toEqual({ ok: false, reason: 'message' });
  });

  it('settles with verified preimage, receipt evidence, notification, and gift reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const preimage = '00'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, { conversationId: null });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash: paymentHash.toUpperCase(),
      note: ' Wallet history checked ',
      preimage: preimage.toUpperCase(),
      notificationStore: notifications,
      pushStore,
    });
    warn.mockRestore();
    expect(result).toEqual({
      ok: true,
      receiptId: manualReceiptIdForPaymentHash(paymentHash),
      messageId,
      amountSats: 210_000,
      resumed: false,
    });
    expect((await store.getById(messageId))?.sats).toBe(210_000);
    const ingestRow = (await store.listZapIngests(10))[0];
    expect(ingestRow?.outcome).toBe('indexed');
    expect(ingestRow?.receiptPubkey).toBeNull();
    expect(ingestRow?.receipt).toMatchObject({
      id: manualReceiptIdForPaymentHash(paymentHash),
      pubkey: '',
      kind: 9735,
      created_at: 1,
      content: '',
      sig: '',
    });
    expect(ingestRow?.receipt['tags']).toEqual([
      ['e', NOTE_EVENT_ID],
      ['bolt11', 'lnbc-manual'],
      ['description', JSON.stringify({ content: 'manual gift' })],
      ['preimage', preimage],
      ['manual', 'debug-settle'],
      ['note', 'Wallet history checked'],
    ]);
    expect((await store.listReplies(messageId))[0]?.text).toBe('manual gift');
    expect(await notifications.listByRecipient('manual-author', 10)).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(preimage);
  });

  it('skips notifyZap when the note author lookup throws', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const realGet = auth.getAccount.bind(auth);
    vi.spyOn(auth, 'getAccount').mockImplementation(async (id: string) => {
      if (id === 'manual-author') {
        throw new Error('author boom');
      }
      return realGet(id);
    });
    const preimage = '0e'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, { conversationId: null });
    const notifications = new InMemoryNotificationStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      settleInvoiceManually({
        store,
        auth,
        now: () => 1_800,
        paymentHash,
        note: 'author lookup failed',
        preimage,
        notificationStore: notifications,
      }),
    ).rejects.toThrow('author boom');
    warn.mockRestore();
    expect(
      await store.getZapReceiptGift(manualReceiptIdForPaymentHash(paymentHash)),
    ).toBeUndefined();
    expect(await store.listIndexedZapIngests()).toEqual([]);
    expect((await store.getById(messageId))?.sats).toBe(0);
    expect(await notifications.listByRecipient('manual-author', 10)).toHaveLength(0);
  });

  it('turns a platform-note zap comment into a top-level post', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '12'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: 'Hello from Ada' },
    });
    const notifications = new InMemoryNotificationStore();
    const spendPing = { ping: vi.fn(async () => undefined) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose fee',
      preimage,
      notificationStore: notifications,
      spendPing,
      postLimiter: new PostRateLimiter(),
      conversations: new InMemoryConversationStore(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const created = (await store.listLatest(20)).find((row) => row.text === 'Hello from Ada');
    expect(created?.parentId).toBeNull();
    expect(created?.accountId).toBe('manual-payer');
    expect(created?.sats).toBe(0);
    expect(spendPing.ping).toHaveBeenCalledTimes(0);
    const kinds = (await notifications.listByRecipient('manual-author', 10)).map((row) => row.type);
    expect(kinds).toEqual(['forum_post']);
  });

  it('pings spend after a compose post when the payer is eligible today', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'eligible-author',
      messageId: 'eligible-message',
    });
    const platform = await auth.getAccount('eligible-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'eligible-payer',
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      username: 'ada-eligible',
      lightningAddress: 'eligible@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('eligible-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: 'eligible-payer',
        status: 'admitted',
        appliedAt: 1,
        decidedAt: 2,
        decidedBy: 'staff',
        trialUtcDate: null,
        admittedAt: 2,
        note: null,
      },
    ]);
    const preimage = '13'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      messageId: 'eligible-message',
      payerAccountId: 'eligible-payer',
      authorAccountId: 'eligible-author',
      zapRequest: { content: 'Eligible compose' },
    });
    const spendPing = { ping: vi.fn(async () => undefined) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'eligible compose',
      preimage,
      spendPing,
      fundingStore,
      postLimiter: new PostRateLimiter(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const created = (await store.listLatest(20)).find((row) => row.text === 'Eligible compose');
    expect(created?.accountId).toBe('eligible-payer');
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('eligible@example.com', created?.id);
  });

  it('logs spend.ping.failed when compose funding lookup throws', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'throw-author',
      messageId: 'throw-message',
    });
    const platform = await auth.getAccount('throw-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'throw-payer',
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      username: 'ada-throw',
      lightningAddress: 'throw@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('throw-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '14'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      messageId: 'throw-message',
      payerAccountId: 'throw-payer',
      authorAccountId: 'throw-author',
      zapRequest: { content: 'Throw compose' },
    });
    const spendPing = { ping: vi.fn(async () => undefined) };
    const fundingStore = new InMemoryFundingStore();
    vi.spyOn(fundingStore, 'getByAccountId').mockRejectedValue(new Error('funding boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'throw compose',
      preimage,
      spendPing,
      fundingStore,
      postLimiter: new PostRateLimiter(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(spendPing.ping).toHaveBeenCalledTimes(0);
  });

  it('skips a platform-note compose when the payer is missing forum.post fields', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const preimage = '19'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: 'Needs a username' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose missing username',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect((await store.listLatest(20)).filter((row) => row.accountId === 'manual-payer')).toEqual(
      [],
    );
  });

  it('skips a platform-note compose when the post limiter denies', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '1a'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: 'Rate limited' },
    });
    const limiter = new PostRateLimiter();
    vi.spyOn(limiter, 'allow').mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose limited',
      preimage,
      postLimiter: limiter,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect((await store.listLatest(20)).filter((row) => row.accountId === 'manual-payer')).toEqual(
      [],
    );
  });

  it('still creates a platform-note post when notify or spendPing throw', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '1b'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: 'Notify boom' },
    });
    const notifications = new InMemoryNotificationStore();
    vi.spyOn(notifications, 'create').mockRejectedValue(new Error('notify boom'));
    const spendPing = {
      ping: vi.fn(async () => {
        throw new Error('ping boom');
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose notify boom',
      preimage,
      notificationStore: notifications,
      spendPing,
      pushStore: new InMemoryPushStore(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(
      (await store.listLatest(20)).some((row) => row.text === 'Notify boom' && row.sats === 0),
    ).toBe(true);
  });

  it('still creates a platform-note reply when notifyForumReply throws', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const parentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await store.create({
      id: parentId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '1c'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${parentId}\nThanks boom` },
    });
    const notifications = new InMemoryNotificationStore();
    vi.spyOn(notifications, 'create').mockRejectedValue(new Error('reply notify boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose reply notify boom',
      preimage,
      notificationStore: notifications,
      pushStore: new InMemoryPushStore(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect((await store.listReplies(parentId))[0]?.text).toBe('Thanks boom');
  });

  it('turns a platform-note inReplyTo comment into a reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const parentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await store.create({
      id: parentId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '13'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${parentId}\nThanks` },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose reply fee',
      preimage,
      conversations: new InMemoryConversationStore(),
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const reply = (await store.listReplies(parentId))[0];
    expect(reply?.text).toBe('Thanks');
    expect(reply?.sats).toBe(0);
  });

  it('skips an empty platform-note zap comment', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '14'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: '' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'empty compose fee',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect((await store.listLatest(20)).filter((row) => row.accountId === 'manual-payer')).toEqual(
      [],
    );
  });

  it('skips a platform-note inReplyTo prefix with an empty body', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const parentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await store.create({
      id: parentId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: messageId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '18'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${parentId}` },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'empty compose reply',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(await store.listReplies(parentId)).toEqual([]);
    expect((await store.listLatest(20)).filter((row) => row.accountId === 'manual-payer')).toEqual(
      [],
    );
  });

  it('falls back to a top-level post when inReplyTo is not a live parent', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const missingParent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const preimage = '15'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${missingParent}\nStill a post` },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose missing parent',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const created = (await store.listLatest(20)).find((row) => row.text === 'Still a post');
    expect(created?.parentId).toBeNull();
    expect(created?.accountId).toBe('manual-payer');
    expect(created?.sats).toBe(0);
  });

  it('falls back to a top-level post when inReplyTo is a nested reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nestedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await store.create({
      id: rootId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'root',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: nestedId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'nested',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: rootId,
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '16'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${nestedId}\nUnnested` },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose nested parent',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const created = (await store.listLatest(20)).find((row) => row.text === 'Unnested');
    expect(created?.parentId).toBeNull();
    expect(created?.sats).toBe(0);
  });

  it('falls back to a top-level post when inReplyTo is hidden', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const hiddenId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await store.create({
      id: hiddenId,
      accountId: 'manual-author',
      name: 'Ada',
      text: 'hidden',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      deletedAt: new Date('2026-08-29T00:00:00.000Z'),
    });
    const platform = await auth.getAccount('manual-author');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const preimage = '17'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedManualInvoice(store, paymentHash, {
      conversationId: null,
      zapRequest: { content: `inReplyTo:${hiddenId}\nAfter hide` },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1_800,
      paymentHash,
      note: 'compose hidden parent',
      preimage,
    });
    warn.mockRestore();
    expect(result.ok).toBe(true);
    const created = (await store.listLatest(20)).find((row) => row.text === 'After hide');
    expect(created?.parentId).toBeNull();
    expect(created?.sats).toBe(0);
  });

  it('settles without preimage when the payer is missing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
      eventId: '',
    });
    const hash = '35'.repeat(32);
    await seedManualInvoice(store, hash, { zapRequest: null });
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 2_000,
      paymentHash: hash,
      note: 'wallet screenshot',
    });
    expect(result.ok).toBe(true);
    const tags = (await store.listZapIngests(10))[0]?.receipt['tags'];
    expect(tags).toEqual([
      ['bolt11', 'lnbc-manual'],
      ['manual', 'debug-settle'],
      ['note', 'wallet screenshot'],
    ]);
    expect(await store.listReplies('manual-message')).toEqual([]);
  });

  it('skips notification for a Damus-only parent but still inserts the payer reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await store.create({
      id: 'manual-message',
      accountId: null,
      name: 'Damus',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: null,
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const hash = '36'.repeat(32);
    await seedManualInvoice(store, hash);
    const notifications = new InMemoryNotificationStore();
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 2_000,
      paymentHash: hash,
      note: 'wallet screenshot',
      notificationStore: notifications,
    });
    expect(result.ok).toBe(true);
    expect(await notifications.listByRecipient('manual-payer', 10)).toEqual([]);
    expect(await store.listReplies('manual-message')).toHaveLength(1);
  });

  it('rejects manual receipt, indexed payment hash, and record races as duplicates', async () => {
    const auth = new InMemoryAuthStore();
    const hash = '37'.repeat(32);
    const receiptStore = new InMemoryMessageStore();
    await receiptStore.create({
      id: 'manual-message',
      accountId: 'manual-author',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await seedManualInvoice(receiptStore, hash);
    const args = {
      store: receiptStore,
      auth,
      now: () => 1,
      paymentHash: hash,
      note: 'evidence',
    };
    expect((await settleInvoiceManually(args)).ok).toBe(true);
    await expect(settleInvoiceManually(args)).resolves.toEqual({ ok: false, reason: 'duplicate' });

    const indexedStore = new InMemoryMessageStore();
    await indexedStore.create({
      id: 'manual-message',
      accountId: 'manual-author',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await seedManualInvoice(indexedStore, hash);
    mockedDecode.mockReturnValue({ paymentHash: hash, amountMsat: 210_000_000 });
    await indexedStore.recordZapIngest({
      id: 'existing-ingest',
      createdAt: new Date(1),
      receiptId: 'existing-receipt',
      noteEventId: null,
      messageId: 'manual-message',
      outcome: 'indexed',
      reason: null,
      amountSats: 210_000,
      receiptPubkey: PROVIDER_PUBKEY,
      receipt: { tags: [['bolt11', 'lnbc-existing']] },
    });
    await expect(settleInvoiceManually({ ...args, store: indexedStore })).resolves.toEqual({
      ok: false,
      reason: 'duplicate',
    });

    const raceStore = new InMemoryMessageStore();
    await raceStore.create({
      id: 'manual-message',
      accountId: 'manual-author',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await seedManualInvoice(raceStore, hash);
    raceStore.recordZapReceipt = async () => false;
    await expect(settleInvoiceManually({ ...args, store: raceStore })).resolves.toEqual({
      ok: false,
      reason: 'duplicate',
    });

    const claimedStore = new InMemoryMessageStore();
    await claimedStore.create({
      id: 'manual-message',
      accountId: 'manual-author',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await seedManualInvoice(claimedStore, hash);
    await claimedStore.claimZapPayment(hash, 'foreign-receipt', new Date(1));
    await expect(settleInvoiceManually({ ...args, store: claimedStore })).resolves.toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('resumes a half-recorded settle on a note hidden in the meantime without notifying', async () => {
    const paymentHash = '3a'.repeat(32);
    class FailOnceIngestStore extends InMemoryMessageStore {
      failIngest = true;

      override recordZapIngest(row: ZapIngestRow): Promise<void> {
        if (this.failIngest) {
          this.failIngest = false;
          return Promise.reject(new Error('ingest persist boom'));
        }
        return super.recordZapIngest(row);
      }
    }
    const store = new FailOnceIngestStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    // A known payer, so only the hidden-note guard can keep the gift-reply away.
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'payer@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await seedManualInvoice(store, paymentHash);
    const notifications = new InMemoryNotificationStore();
    const args = {
      store,
      auth,
      now: () => 2_000,
      paymentHash,
      note: 'wallet evidence',
      notificationStore: notifications,
    };

    await expect(settleInvoiceManually(args)).rejects.toThrow('ingest persist boom');
    await store.markDeleted('manual-message', new Date(3_000), 'moderator');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(settleInvoiceManually(args)).resolves.toMatchObject({ ok: true, resumed: true });
    // The gift-reply is not even attempted on a hidden note (an attempt would log a failure).
    const resumeEvents = loggedEvents(warn).map((event) => event['event']);
    warn.mockRestore();
    expect(resumeEvents).toContain('nostr.zap.settled_manually');
    expect(resumeEvents).not.toContain('nostr.zap.gift_reply.failed');
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    expect(
      (await store.listIndexedZapIngests()).filter(
        (row) => row.receiptId === manualReceiptIdForPaymentHash(paymentHash),
      ),
    ).toHaveLength(1);
    expect(await store.listReplies('manual-message')).toEqual([]);
    for (const account of await auth.listAccounts()) {
      expect(await notifications.listByRecipient(account.id, 10)).toEqual([]);
    }
  });

  it('propagates a failed ingest write and resumes without crediting twice', async () => {
    const paymentHash = '39'.repeat(32);
    class FailingIngestStore extends InMemoryMessageStore {
      receiptCalls = 0;
      failIngest = true;

      override recordZapReceipt(
        ...args: Parameters<InMemoryMessageStore['recordZapReceipt']>
      ): ReturnType<InMemoryMessageStore['recordZapReceipt']> {
        if (args[0] === manualReceiptIdForPaymentHash(paymentHash)) {
          this.receiptCalls += 1;
        }
        return super.recordZapReceipt(...args);
      }

      override recordZapIngest(row: ZapIngestRow): Promise<void> {
        if (this.failIngest) {
          this.failIngest = false;
          return Promise.reject(new Error('ingest persist boom'));
        }
        return super.recordZapIngest(row);
      }
    }
    const store = new FailingIngestStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    await seedManualInvoice(store, paymentHash);
    const args = {
      store,
      auth,
      now: () => 2_000,
      paymentHash,
      note: 'wallet evidence',
    };

    await expect(settleInvoiceManually(args)).rejects.toThrow('ingest persist boom');
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    expect(await store.listZapIngests(10)).toEqual([]);

    await expect(settleInvoiceManually(args)).resolves.toEqual({
      ok: true,
      receiptId: manualReceiptIdForPaymentHash(paymentHash),
      messageId: 'manual-message',
      amountSats: 210_000,
      resumed: true,
    });
    expect(store.receiptCalls).toBe(1);
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === manualReceiptIdForPaymentHash(paymentHash) && row.outcome === 'indexed',
      ),
    ).toBe(true);
  });

  it('keeps settlement successful when payer lookup throws after crediting', async () => {
    class ThrowingPayerAuthStore extends InMemoryAuthStore {
      override getAccount(id: string): Promise<Account | undefined> {
        if (id === 'manual-payer') {
          return Promise.reject(new Error('payer lookup boom'));
        }
        return super.getAccount(id);
      }
    }
    const store = new InMemoryMessageStore();
    const auth = new ThrowingPayerAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    const paymentHash = '3a'.repeat(32);
    const receiptId = manualReceiptIdForPaymentHash(paymentHash);
    await seedManualInvoice(store, paymentHash);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 2_000,
      paymentHash,
      note: 'wallet evidence',
    });
    const events = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    warn.mockRestore();

    expect(result).toMatchObject({ ok: true, receiptId, resumed: false });
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    expect(await store.listReplies('manual-message')).toEqual([]);
    expect(
      events.some(
        (event) =>
          event['event'] === 'nostr.zap.gift_reply.failed' && event['receiptId'] === receiptId,
      ),
    ).toBe(true);
  });

  it('logs notification and gift-reply failures after crediting', async () => {
    class GiftReplyBoomStore extends InMemoryMessageStore {
      failCreate = false;

      override create(
        ...args: Parameters<InMemoryMessageStore['create']>
      ): ReturnType<InMemoryMessageStore['create']> {
        if (this.failCreate) {
          return Promise.reject(new Error('gift reply boom'));
        }
        return super.create(...args);
      }
    }
    const store = new GiftReplyBoomStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
    });
    await auth.createAccount({
      id: 'manual-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('manual-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const hash = '38'.repeat(32);
    await seedManualInvoice(store, hash);
    const notifications = new InMemoryNotificationStore();
    notifications.create = async () => {
      throw new Error('notify boom');
    };
    store.failCreate = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await settleInvoiceManually({
      store,
      auth,
      now: () => 1,
      paymentHash: hash,
      note: 'evidence',
      notificationStore: notifications,
    });
    const events = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    warn.mockRestore();
    expect(result.ok).toBe(true);
    expect(events.some((event) => event['event'] === 'push.enqueue.failed')).toBe(true);
    expect(events.some((event) => event['event'] === 'nostr.zap.gift_reply.failed')).toBe(true);
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
  });
});

describe('indexZapReceipt', () => {
  it('adds sats when the provider pubkey matches', async () => {
    const store = new InMemoryMessageStore();
    const row = await store.create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const ok = await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r1', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 21,
    });
    expect(ok).toBe(true);
    expect((await store.getById(row.id))?.sats).toBe(21);
  });

  it('returns false on duplicate receipt id without adding sats again', async () => {
    const store = new InMemoryMessageStore();
    const row = await store.create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r-dup', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 21,
    });
    const dup = await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r-dup', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 21,
    });
    expect(dup).toBe(false);
    expect((await store.getById(row.id))?.sats).toBe(21);
  });

  it('rejects a mismatched provider pubkey', async () => {
    const store = new InMemoryMessageStore();
    const ok = await indexZapReceipt({
      store,
      messageId: 'm1',
      receipt: { id: 'r2', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: 'bb'.repeat(32),
      amountSats: 21,
    });
    expect(ok).toBe(false);
  });

  it('matches provider pubkeys case-insensitively', async () => {
    const store = new InMemoryMessageStore();
    const row = await store.create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const ok = await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r-case', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY.toUpperCase(),
      amountSats: 21,
    });
    expect(ok).toBe(true);
    expect((await store.getById(row.id))?.sats).toBe(21);
  });

  it('rejects a non-positive amount', async () => {
    const store = new InMemoryMessageStore();
    const ok = await indexZapReceipt({
      store,
      messageId: 'm1',
      receipt: { id: 'r3', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 0,
    });
    expect(ok).toBe(false);
  });

  it('rejects a non-integer amount', async () => {
    const store = new InMemoryMessageStore();
    const ok = await indexZapReceipt({
      store,
      messageId: 'm1',
      receipt: { id: 'r4', pubkey: PROVIDER_PUBKEY, tags: [] },
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 1.5,
    });
    expect(ok).toBe(false);
  });
});

describe('indexOpenZapReceipts', () => {
  it('creates one clamped external gift reply and rejects a replayed zap request id', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'external-author',
      lightningAddress: 'external-author@example.com',
    });
    const secret = generateSecretKey();
    const first = externalZapFixture({
      receiptId: 'external-receipt-one',
      bolt11: 'lnbc-external-one',
      createdAt: 1_800_000_000,
      secret,
    });
    const replay = externalZapFixture({
      receiptId: 'external-receipt-two',
      bolt11: 'lnbc-external-two',
      createdAt: 1_800_000_100,
      secret,
      description: first.description,
    });
    expect(replay.requestId).toBe(first.requestId);
    const paymentHashes = new Map([
      ['lnbc-external-one', '31'.repeat(32)],
      ['lnbc-external-two', '32'.repeat(32)],
    ]);
    mockedDecode.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '33'.repeat(32),
      amountMsat: 21_000,
    }));
    mockedInspect.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '33'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: first.descriptionHash,
      expirySeconds: null,
    }));
    const querier = new RecordingQuerier();
    querier.events = [first.receipt, replay.receipt];
    const nowMs = 1_700_000_200_000;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => nowMs,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(42);
    expect(await store.listZapperPubkeys()).toEqual([first.pubkey]);
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      accountId: null,
      authorPubkey: first.pubkey,
      text: 'external gift',
      sats: 21,
      nostrPublishState: 'skipped',
    });
    expect(replies[0]?.createdAt.getTime()).toBe(nowMs);
    expect((await store.getZapReceiptGift('external-receipt-one'))?.zapRequestId).toBe(
      first.requestId,
    );
    expect(await store.getZapReceiptGift('external-receipt-two')).toMatchObject({
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
    });
  });

  it('keeps a replayed zap request rejected on a later tick', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'external-replay-later-author',
      lightningAddress: 'external-replay-later-author@example.com',
      messageId: 'external-replay-later-parent',
    });
    const secret = generateSecretKey();
    const first = externalZapFixture({
      receiptId: 'external-replay-later-receipt-one',
      bolt11: 'lnbc-external-replay-later-one',
      createdAt: 1_800_000_200,
      secret,
    });
    const replay = externalZapFixture({
      receiptId: 'external-replay-later-receipt-two',
      bolt11: 'lnbc-external-replay-later-two',
      createdAt: 1_800_000_300,
      secret,
      description: first.description,
    });
    expect(replay.requestId).toBe(first.requestId);
    const paymentHashes = new Map([
      ['lnbc-external-replay-later-one', '71'.repeat(32)],
      ['lnbc-external-replay-later-two', '72'.repeat(32)],
    ]);
    mockedDecode.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '73'.repeat(32),
      amountMsat: 21_000,
    }));
    mockedInspect.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '73'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: first.descriptionHash,
      expirySeconds: null,
    }));
    const querier = new RecordingQuerier();
    querier.events = [first.receipt, replay.receipt];
    const nowMs = 1_700_000_300_000;
    mockedVerifiedExternalZapRequest.mockClear();
    const writes = [
      vi.spyOn(store, 'claimZapPayment'),
      vi.spyOn(store, 'recordZapReceipt'),
      vi.spyOn(store, 'recordZapIngest'),
      vi.spyOn(store, 'addSats'),
      vi.spyOn(store, 'recordZapper'),
      vi.spyOn(store, 'attributeZapReceipt'),
      vi.spyOn(store, 'updateZapReceiptGift'),
      vi.spyOn(store, 'create'),
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => nowMs,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(42);
    expect(await store.listZapperPubkeys()).toEqual([first.pubkey]);
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      accountId: null,
      authorPubkey: first.pubkey,
      text: 'external gift',
      sats: 21,
      nostrPublishState: 'skipped',
    });
    expect(replies[0]?.createdAt.getTime()).toBe(nowMs);
    expect((await store.getZapReceiptGift(first.receipt.id))?.zapRequestId).toBe(first.requestId);
    expect(await store.getZapReceiptGift(replay.receipt.id)).toMatchObject({
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
    });
    const writesAfterFirstTick = writes.map((spy) => spy.mock.calls.length);
    const verificationsAfterFirstTick = mockedVerifiedExternalZapRequest.mock.calls.length;

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => nowMs,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(42);
    expect(await store.listZapperPubkeys()).toEqual([first.pubkey]);
    expect(await store.listReplies(parentId)).toHaveLength(1);
    expect(await store.getZapReceiptGift(replay.receipt.id)).toMatchObject({
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
    });
    expect(writes.map((spy) => spy.mock.calls.length)).toEqual(writesAfterFirstTick);
    expect(mockedVerifiedExternalZapRequest).toHaveBeenCalledTimes(verificationsAfterFirstTick);
  });

  it('remembers a below-minimum external receipt without writes or re-verification', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'external-below-minimum-author',
      lightningAddress: 'external-below-minimum@example.com',
    });
    const fixture = externalZapFixture({
      receiptId: 'external-below-minimum-receipt',
      bolt11: 'lnbc-external-below-minimum',
    });
    await store.recordZapReceipt(fixture.receipt.id, parentId, 0);
    mockedDecode.mockReturnValue({ paymentHash: '74'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '74'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [fixture.receipt];
    mockedVerifiedExternalZapRequest.mockClear();
    const recordZapper = vi.spyOn(store, 'recordZapper');
    const writes = [
      vi.spyOn(store, 'claimZapPayment'),
      vi.spyOn(store, 'recordZapReceipt'),
      vi.spyOn(store, 'recordZapIngest'),
      vi.spyOn(store, 'addSats'),
      recordZapper,
      vi.spyOn(store, 'attributeZapReceipt'),
      vi.spyOn(store, 'updateZapReceiptGift'),
      vi.spyOn(store, 'create'),
    ];

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_300_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(await store.getZapReceiptGift(fixture.receipt.id)).toMatchObject({
      sats: 0,
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
    });
    expect(recordZapper).not.toHaveBeenCalled();
    const writesAfterFirstTick = writes.map((spy) => spy.mock.calls.length);
    const verificationsAfterFirstTick = mockedVerifiedExternalZapRequest.mock.calls.length;
    expect(verificationsAfterFirstTick).toBe(1);

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_300_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(writes.map((spy) => spy.mock.calls.length)).toEqual(writesAfterFirstTick);
    expect(mockedVerifiedExternalZapRequest).toHaveBeenCalledTimes(verificationsAfterFirstTick);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('evicts the oldest terminal external receipt after 10,000 remembered ids', async () => {
    const fillerFixture = externalZapFixture({
      receiptId: 'terminal-external-filler',
      bolt11: 'lnbc-terminal-external-filler',
    });
    const parentId = 'terminal-external-bound-parent';
    const backfillRows = Array.from({ length: 10_000 }, (_, index) => {
      const receiptId = `terminal-external-filler-${index.toString().padStart(5, '0')}`;
      return backfillRow(receiptId, { ...fillerFixture.receipt, id: receiptId }, parentId);
    });
    const store = new BackfillRowsStore(backfillRows);
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'terminal-external-bound-author',
      lightningAddress: 'terminal-external-bound@example.com',
      messageId: parentId,
    });
    for (const row of backfillRows) {
      await store.recordZapReceipt(row.receiptEventId, parentId, row.sats);
    }
    const oldest = externalZapFixture({
      receiptId: 'terminal-external-oldest',
      bolt11: 'lnbc-terminal-external-oldest',
    });
    await store.recordZapReceipt(oldest.receipt.id, parentId, 0);
    mockedDecode.mockReturnValue({ paymentHash: '75'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '75'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: oldest.descriptionHash,
      expirySeconds: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [oldest.receipt];
    mockedVerifiedExternalZapRequest.mockClear();

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_300_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    const claimedRequestReceiptId = 'terminal-external-claimed-request';
    await store.recordZapReceipt(claimedRequestReceiptId, parentId, 21);
    await expect(
      store.attributeZapReceipt(claimedRequestReceiptId, {
        payerPubkey: fillerFixture.pubkey,
        zapRequestId: fillerFixture.requestId,
        comment: '',
      }),
    ).resolves.toBe(true);
    await store.updateZapReceiptGift(claimedRequestReceiptId, { payerPubkey: null });

    const originalVerification = mockedVerifiedExternalZapRequest.getMockImplementation();
    if (originalVerification === undefined) {
      throw new Error('expected wrapped external verifier');
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedVerifiedExternalZapRequest.mockReturnValue({
      pubkey: fillerFixture.pubkey,
      requestId: fillerFixture.requestId,
      content: '',
    });
    try {
      await expect(
        backfillExternalZappers(store, {
          auth,
          querier: new RecordingQuerier(),
          urls: URLS,
          timeoutMs: 50,
          now: () => 1_700_000_300_000,
        }),
      ).resolves.toBe(10_000);
    } finally {
      mockedVerifiedExternalZapRequest.mockImplementation(originalVerification);
      warn.mockRestore();
    }
    // 1 oldest + 10,000 colliding fillers = 10,001 additions, so the oldest is evicted.
    mockedVerifiedExternalZapRequest.mockClear();

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_300_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(mockedVerifiedExternalZapRequest).toHaveBeenCalledTimes(1);
  });

  it('records one entitlement across ticks while attributing two external gifts', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const firstNoteEventId = '81'.repeat(32);
    const secondNoteEventId = '82'.repeat(32);
    const firstParentId = await seedStore({
      store,
      auth,
      accountId: 'same-external-zapper-author',
      eventId: firstNoteEventId,
      lightningAddress: 'same-external-zapper@example.com',
      messageId: 'same-external-zapper-parent-one',
    });
    const secondParentId = await seedStore({
      store,
      auth,
      accountId: 'same-external-zapper-author',
      eventId: secondNoteEventId,
      messageId: 'same-external-zapper-parent-two',
      createAccount: false,
    });
    const secret = generateSecretKey();
    const first = externalZapFixture({
      receiptId: 'same-external-zapper-receipt-one',
      bolt11: 'lnbc-same-external-zapper-one',
      noteEventId: firstNoteEventId,
      secret,
    });
    const second = externalZapFixture({
      receiptId: 'same-external-zapper-receipt-two',
      bolt11: 'lnbc-same-external-zapper-two',
      noteEventId: secondNoteEventId,
      secret,
    });
    expect(second.pubkey).toBe(first.pubkey);
    const paymentHashes = new Map([
      ['lnbc-same-external-zapper-one', '83'.repeat(32)],
      ['lnbc-same-external-zapper-two', '84'.repeat(32)],
    ]);
    const descriptionHashes = new Map([
      ['lnbc-same-external-zapper-one', first.descriptionHash],
      ['lnbc-same-external-zapper-two', second.descriptionHash],
    ]);
    mockedDecode.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '85'.repeat(32),
      amountMsat: 21_000,
    }));
    mockedInspect.mockImplementation((bolt11) => ({
      paymentHash: paymentHashes.get(bolt11) ?? '85'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: descriptionHashes.get(bolt11) ?? null,
      expirySeconds: null,
    }));
    const querier = new RecordingQuerier();
    const recordZapper = vi.spyOn(store, 'recordZapper');
    const deps = {
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_300_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    };

    querier.events = [first.receipt];
    await ingest(deps);
    querier.events = [second.receipt];
    await ingest(deps);

    expect(recordZapper).toHaveBeenCalledTimes(1);
    expect(recordZapper).toHaveBeenCalledWith(
      first.pubkey,
      first.receipt.id,
      new Date(1_700_000_300_000),
    );
    expect(await store.getZapReceiptGift(first.receipt.id)).toMatchObject({
      payerPubkey: first.pubkey,
      zapRequestId: first.requestId,
    });
    expect(await store.getZapReceiptGift(second.receipt.id)).toMatchObject({
      payerPubkey: second.pubkey,
      zapRequestId: second.requestId,
    });
    expect(await store.listReplies(firstParentId)).toHaveLength(1);
    expect(await store.listReplies(secondParentId)).toHaveLength(1);
  });

  it('keeps strictly invalid external attribution anonymous while crediting sats', async () => {
    const cases = [
      { name: 'description hash', requestEventId: NOTE_EVENT_ID, amount: '21000', badHash: true },
      { name: 'e tag', requestEventId: '12'.repeat(32), amount: '21000', badHash: false },
      { name: 'amount', requestEventId: NOTE_EVENT_ID, amount: '22000', badHash: false },
    ] as const;
    for (const [index, row] of cases.entries()) {
      const store = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      const parentId = await seedStore({
        store,
        auth,
        accountId: `invalid-external-author-${index}`,
        lightningAddress: `invalid-${index}@example.com`,
      });
      const fixture = externalZapFixture({
        receiptId: `invalid-external-${index}`,
        bolt11: `lnbc-invalid-${index}`,
        requestNoteEventId: row.requestEventId,
        amount: row.amount,
      });
      mockedDecode.mockReturnValue({ paymentHash: `${40 + index}`.repeat(32), amountMsat: 21_000 });
      mockedInspect.mockReturnValue({
        paymentHash: `${40 + index}`.repeat(32),
        amountMsat: 21_000,
        description: null,
        descriptionHash: row.badHash ? '00'.repeat(32) : fixture.descriptionHash,
        expirySeconds: null,
      });
      const querier = new RecordingQuerier();
      querier.events = [fixture.receipt];
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => 1_700_000_200_000,
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      });
      expect((await store.getById(parentId))?.sats, row.name).toBe(21);
      expect(await store.listZapperPubkeys(), row.name).toEqual([]);
      expect(await store.listReplies(parentId), row.name).toEqual([]);
      expect((await store.getZapReceiptGift(fixture.receipt.id))?.payerPubkey, row.name).toBeNull();
    }
  });

  it('credits and attributes a blocked external zap once without a visible gift reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'blocked-external-author',
      lightningAddress: 'blocked-external@example.com',
    });
    const fixture = externalZapFixture({
      receiptId: 'blocked-external-receipt',
      bolt11: 'lnbc-blocked-external',
    });
    await store.blockPubkeyAndHideRows(fixture.pubkey, new Date(1), 'staff', 'blocked-message');
    mockedDecode.mockReturnValue({ paymentHash: '51'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '51'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [fixture.receipt];
    mockedVerifiedExternalZapRequest.mockClear();
    const recordZapper = vi.spyOn(store, 'recordZapper');
    const writes = [
      vi.spyOn(store, 'claimZapPayment'),
      vi.spyOn(store, 'recordZapReceipt'),
      vi.spyOn(store, 'recordZapIngest'),
      vi.spyOn(store, 'addSats'),
      recordZapper,
      vi.spyOn(store, 'attributeZapReceipt'),
      vi.spyOn(store, 'updateZapReceiptGift'),
      vi.spyOn(store, 'create'),
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listZapperPubkeys()).toEqual([fixture.pubkey]);
    expect(await store.listReplies(parentId)).toEqual([]);
    expect(await store.getZapReceiptGift(fixture.receipt.id)).toMatchObject({
      payerPubkey: null,
      zapRequestId: fixture.requestId,
      giftReplyId: null,
    });
    const writesAfterFirstTick = writes.map((spy) => spy.mock.calls.length);
    const verificationsAfterFirstTick = mockedVerifiedExternalZapRequest.mock.calls.length;
    await store.unblockPubkeyByMessage('blocked-message');
    expect(await store.listBlockedPubkeys()).toEqual([]);

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(writes.map((spy) => spy.mock.calls.length)).toEqual(writesAfterFirstTick);
    expect(mockedVerifiedExternalZapRequest).toHaveBeenCalledTimes(verificationsAfterFirstTick);
    expect(recordZapper).toHaveBeenCalledTimes(1);
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('lets an in-flight block win before a live external gift reply is created', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'live-block-race-author',
      lightningAddress: 'live-block-race@example.com',
    });
    const fixture = externalZapFixture({
      receiptId: 'live-block-race-receipt',
      bolt11: 'lnbc-live-block-race',
    });
    mockedDecode.mockReturnValue({ paymentHash: '52'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '52'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    mockedVerifiedExternalZapRequest.mockClear();
    let releaseProfile: () => void = () => {};
    const profileHeld = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    let enterProfile: () => void = () => {};
    const profileEntered = new Promise<void>((resolve) => {
      enterProfile = resolve;
    });
    const querier = new RecordingQuerier();
    querier.events = [fixture.receipt];
    let queryCount = 0;
    querier.query = async (): Promise<NostrEventFrame[]> => {
      queryCount += 1;
      if (queryCount === 1) {
        return querier.events;
      }
      enterProfile();
      await profileHeld;
      return [];
    };

    const pending = ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    await profileEntered;
    await store.blockPubkeyAndHideRows(
      fixture.pubkey,
      new Date(1_700_000_200_000),
      'live-block-race-staff',
      'live-block-race-message',
    );
    releaseProfile();
    await pending;

    expect(await store.listReplies(parentId)).toEqual([]);
    expect(await store.getZapReceiptGift(fixture.receipt.id)).toMatchObject({
      payerPubkey: null,
      giftReplyId: null,
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
  });

  it('keeps a dequeued external receipt inert when the receipt is delivered again', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const topId = await seedStore({
      store,
      auth,
      accountId: 'reply-zap-author',
      eventId: '61'.repeat(32),
      lightningAddress: 'reply-zap@example.com',
      messageId: 'reply-zap-top',
    });
    await store.create({
      id: 'reply-zap-child',
      accountId: 'reply-zap-author',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-08-28T00:01:00Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: topId,
      eventId: NOTE_EVENT_ID,
    });
    const fixture = externalZapFixture({
      receiptId: 'reply-zap-receipt',
      bolt11: 'lnbc-reply-zap',
    });
    mockedDecode.mockReturnValue({ paymentHash: '62'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue({
      paymentHash: '62'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: fixture.descriptionHash,
      expirySeconds: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [fixture.receipt];
    const giftWrites = vi.spyOn(store, 'updateZapReceiptGift');
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById('reply-zap-child'))?.sats).toBe(21);
    expect(await store.listReplies('reply-zap-child')).toEqual([]);
    expect(await store.listZapperPubkeys()).toEqual([fixture.pubkey]);
    expect(await store.getZapReceiptGift(fixture.receipt.id)).toMatchObject({
      payerPubkey: null,
      zapRequestId: fixture.requestId,
      giftReplyId: null,
    });
    const writesAfterDequeue = giftWrites.mock.calls.length;

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(giftWrites).toHaveBeenCalledTimes(writesAfterDequeue);
    expect(await store.listReplies('reply-zap-child')).toEqual([]);
  });

  it('does nothing when urls is empty', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-urls-empty',
      lightningAddress: 'zap-urls-empty@example.com',
    });
    await ingest({
      store,
      auth,
      querier,
      urls: [],
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect(querier.calls).toEqual([]);
  });

  it('does not query when only unsigned or empty eventId rows exist', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-unsigned',
      eventId: null,
      lightningAddress: 'zap-unsigned@example.com',
      messageId: 'm-unsigned',
    });
    await seedStore({
      store,
      auth,
      accountId: 'acc-empty-eid',
      eventId: '',
      lightningAddress: 'zap-empty-eid@example.com',
      messageId: 'm-empty-eid',
    });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect(querier.calls).toEqual([]);
  });

  it('chunks 21 distinct event ids into two queries of 20 then 1', async () => {
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await auth.createAccount({
      id: 'acc-chunk',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'zap-chunk@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const firstId = `${'01'.repeat(31)}00`;
    const rows: MessageRow[] = [];
    for (let i = 0; i < 21; i += 1) {
      const eventId = `${'01'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      rows.push({
        id: `m-chunk-${i}`,
        accountId: 'acc-chunk',
        name: 'Ada',
        text: `n${i}`,
        createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, i)),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        eventId,
      });
    }
    // Seed a duplicate eventId (create() is unique) so seen.has is covered.
    rows.push({
      id: 'm-chunk-dup',
      accountId: 'acc-chunk',
      name: 'Ada',
      text: 'dup',
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, 22)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: firstId,
    });
    // Child with the same eventId so reply collection dedups via `seen`.
    rows.push({
      id: 'm-chunk-child-dup',
      accountId: 'acc-chunk',
      name: 'Ada',
      text: 'child-dup',
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, 23)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm-chunk-0',
      eventId: firstId,
    });
    const store = new InMemoryMessageStore(rows);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect(querier.calls).toHaveLength(2);
    const firstFilter = querier.calls[0]?.filter as {
      '#e': string[];
      kinds: number[];
      limit: number;
    };
    expect(firstFilter.kinds).toEqual([9735]);
    expect(firstFilter.limit).toBe(200);
    expect(firstFilter['#e']).toHaveLength(20);
    expect((querier.calls[1]?.filter as { '#e': string[] })['#e']).toHaveLength(1);
  });

  it('skips kind 1, empty id/pubkey, and non-string id/pubkey', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-skip',
      lightningAddress: 'zap-skip@example.com',
    });
    querier.events = [
      {
        id: 'skip-kind1',
        pubkey: PROVIDER_PUBKEY,
        kind: 1,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      },
      {
        id: '',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      },
      {
        id: 'skip-empty-pk',
        pubkey: '',
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      },
      {
        id: 1,
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      } as unknown as NostrEventFrame,
      {
        id: 'skip-num-pk',
        pubkey: 1,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      } as unknown as NostrEventFrame,
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('does not increment sats when the receipt has no e tag', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-no-e',
      lightningAddress: 'zap-no-e@example.com',
    });
    querier.events = [
      {
        id: 'r-no-e',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [['bolt11', 'lnbc']],
      },
      {
        id: 'r-empty-e',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', ''],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(2);
    expect(ingests.every((row) => row.outcome === 'rejected' && row.reason === 'event')).toBe(true);
  });

  it('does not increment sats for an unknown e-tag event id', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-unknown-e',
      lightningAddress: 'zap-unknown-e@example.com',
    });
    querier.events = [
      {
        id: 'r-unknown',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', 'ff'.repeat(32)],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('rejected');
    expect(ingests[0]?.reason).toBe('event');
    expect(ingests[0]?.noteEventId).toBe('ff'.repeat(32));
  });

  it('does not increment sats without bolt11 or when decodeBolt11 returns null', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-bolt11',
      lightningAddress: 'zap-bolt11@example.com',
    });
    querier.events = [
      {
        id: 'r-no-bolt11',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [['e', NOTE_EVENT_ID]],
      },
      {
        id: 'r-bad-bolt11',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-bad'],
        ],
      },
    ];
    mockedDecode.mockReturnValue(null);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(2);
    expect(ingests.every((row) => row.outcome === 'rejected' && row.reason === 'bolt11')).toBe(
      true,
    );
  });

  it('does not increment sats when bolt11 tag value is empty', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-empty-bolt11',
      lightningAddress: 'zap-empty-bolt11@example.com',
    });
    querier.events = [
      {
        id: 'r-empty-bolt11',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', ''],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('does not increment sats when amountMsat floors below 1 sat', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-amt',
      lightningAddress: 'zap-amt@example.com',
    });
    querier.events = [
      {
        id: 'r-amt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-dust'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 500 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('does not increment sats when lightningAddress is null or blank', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-null-addr',
      eventId: `${'ee'.repeat(31)}01`,
      lightningAddress: null,
      messageId: 'm-null-addr',
    });
    await seedStore({
      store,
      auth,
      accountId: 'acc-blank-addr',
      eventId: `${'ee'.repeat(31)}02`,
      lightningAddress: '   ',
      messageId: 'm-blank-addr',
    });
    querier.events = [
      {
        id: 'r-null-addr',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', `${'ee'.repeat(31)}01`],
          ['bolt11', 'lnbc'],
        ],
      },
      {
        id: 'r-blank-addr',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', `${'ee'.repeat(31)}02`],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById('m-null-addr'))?.sats).toBe(0);
    expect((await store.getById('m-blank-addr'))?.sats).toBe(0);
  });

  it('does not increment sats when the author account is missing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-missing',
      lightningAddress: 'zap-missing@example.com',
      createAccount: false,
    });
    querier.events = [
      {
        id: 'r-missing',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('does not increment sats when the message has no author accountId', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    const eventId = 'da'.repeat(32);
    await store.create({
      id: 'm-damus-author',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'hi',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId,
    });
    querier.events = [
      {
        id: 'r-damus-author',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', eventId],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById('m-damus-author'))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('rejected');
    expect(ingests[0]?.reason).toBe('author');
    expect(ingests[0]?.messageId).toBe('m-damus-author');
  });

  it('does not increment sats when LNURL fetch fails or lacks zap fields', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-fetch500',
      eventId: `${'ee'.repeat(31)}10`,
      lightningAddress: 'zap-fetch500@example.com',
      messageId: 'm-fetch500',
    });
    await seedStore({
      store,
      auth,
      accountId: 'acc-no-allows',
      eventId: `${'ee'.repeat(31)}11`,
      lightningAddress: 'zap-no-allows@example.com',
      messageId: 'm-no-allows',
    });
    await seedStore({
      store,
      auth,
      accountId: 'acc-no-npk',
      eventId: `${'ee'.repeat(31)}12`,
      lightningAddress: 'zap-no-npk@example.com',
      messageId: 'm-no-npk',
    });
    querier.events = [
      {
        id: 'r-fetch500',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', `${'ee'.repeat(31)}10`],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect((await store.getById('m-fetch500'))?.sats).toBe(0);

    querier.events = [
      {
        id: 'r-no-allows',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', `${'ee'.repeat(31)}11`],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    const noAllowsFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: false,
          nostrPubkey: PROVIDER_PUBKEY,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: noAllowsFetch,
    });
    expect((await store.getById('m-no-allows'))?.sats).toBe(0);

    querier.events = [
      {
        id: 'r-no-npk',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', `${'ee'.repeat(31)}12`],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    const missingNpkFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: missingNpkFetch,
    });
    expect((await store.getById('m-no-npk'))?.sats).toBe(0);
  });

  it('does not increment sats when LNURL nostrPubkey is empty', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-empty-npk',
      lightningAddress: 'zap-empty-npk@example.com',
    });
    querier.events = [
      {
        id: 'r-empty-npk',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    const emptyNpkFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: true,
          nostrPubkey: '',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: emptyNpkFetch,
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('indexes a valid receipt for 21 sats', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'acc-ok',
      lightningAddress: 'zap-ok@example.com',
    });
    querier.events = [
      {
        id: 'r-ok',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-ok'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('indexed');
    expect(ingests[0]?.reason).toBeNull();
    expect(ingests[0]?.amountSats).toBe(21);
    expect(ingests[0]?.messageId).toBe(messageId);
    expect(ingests[0]?.receiptId).toBe('r-ok');
  });

  it('records one ingest when the same receipt is seen again', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    await seedStore({
      store,
      auth,
      accountId: 'acc-dup',
      lightningAddress: 'zap-dup@example.com',
    });
    querier.events = [
      {
        id: 'r-dup',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-dup'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('indexed');
    expect(ingests[0]?.reason).toBeNull();
  });

  it('credits a second receipt for a legacy indexed payment when the backfill is omitted', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'legacy-control-author',
      messageId: 'legacy-message',
      lightningAddress: 'legacy-control@example.com',
    });
    const paymentHash = '27'.repeat(32);
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    await store.recordZapReceipt('legacy-receipt-control', messageId, 21);
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'legacy-ingest-control',
        receiptId: 'legacy-receipt-control',
        createdAt: '2026-09-18T10:00:00.000Z',
        bolt11: 'lnbc-legacy-control',
      }),
    );

    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'later-receipt-control',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-later-control'],
        ],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect((await store.getById(messageId))?.sats).toBe(42);
    expect(
      (await store.listZapIngests(10)).some(
        (row) => row.receiptId === 'later-receipt-control' && row.outcome === 'indexed',
      ),
    ).toBe(true);
  });

  it('backfills a legacy credit so a second receipt for its payment is settled', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'legacy-backfill-author',
      messageId: 'legacy-message',
      lightningAddress: 'legacy-backfill@example.com',
    });
    const paymentHash = '28'.repeat(32);
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    await store.recordZapReceipt('legacy-receipt-backfill', messageId, 21);
    await store.recordZapIngest(
      indexedZapIngest({
        id: 'legacy-ingest-backfill',
        receiptId: 'legacy-receipt-backfill',
        createdAt: '2026-09-18T10:00:00.000Z',
        bolt11: 'lnbc-legacy-backfill',
      }),
    );
    await backfillZapPayments(store);

    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'later-receipt-backfill',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-later-backfill'],
        ],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect((await store.getById(messageId))?.sats).toBe(21);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === 'later-receipt-backfill' &&
          row.outcome === 'rejected' &&
          row.reason === 'settled',
      ),
    ).toBe(true);
  });

  it('rejects a later real receipt when its payment hash was manually settled', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
      lightningAddress: 'manual@example.com',
    });
    const paymentHash = '29'.repeat(32);
    await seedManualInvoice(store, paymentHash);
    const settled = await settleInvoiceManually({
      store,
      auth,
      now: () => 1,
      paymentHash,
      note: 'wallet evidence',
    });
    expect(settled.ok).toBe(true);

    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 210_000_000 });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'real-receipt-after-manual',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-manual'],
        ],
      },
    ];
    const fetchImpl = vi.fn(failFetch());
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    const ingests = await store.listZapIngests(10);
    expect(
      ingests.some(
        (row) =>
          row.receiptId === 'real-receipt-after-manual' &&
          row.outcome === 'rejected' &&
          row.reason === 'settled',
      ),
    ).toBe(true);
  });

  it('keeps a real-receipt claim after its indexed ingest write fails', async () => {
    class FailingReceiptIngestStore extends InMemoryMessageStore {
      failReceiptIngest = true;

      override recordZapIngest(row: ZapIngestRow): Promise<void> {
        if (row.receiptId === 'real-receipt-ingest-failure' && this.failReceiptIngest) {
          this.failReceiptIngest = false;
          return Promise.reject(new Error('ingest persist boom'));
        }
        return super.recordZapIngest(row);
      }
    }
    const store = new FailingReceiptIngestStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'claim-failure-author',
      messageId: 'manual-message',
      lightningAddress: 'claim-failure@example.com',
    });
    const paymentHash = '2a'.repeat(32);
    await seedManualInvoice(store, paymentHash, { amountSats: 21 });
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'real-receipt-ingest-failure',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-claim-failure'],
        ],
      },
    ];
    const args = {
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest(args);
    expect((await store.getById('manual-message'))?.sats).toBe(21);
    expect(await store.listZapIngests(10)).toEqual([]);

    await ingest(args);
    warn.mockRestore();
    expect((await store.getById('manual-message'))?.sats).toBe(21);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === 'real-receipt-ingest-failure' &&
          row.outcome === 'rejected' &&
          row.reason === 'duplicate',
      ),
    ).toBe(true);

    await expect(
      settleInvoiceManually({
        store,
        auth,
        now: () => 3,
        paymentHash,
        note: 'wallet evidence',
      }),
    ).resolves.toEqual({ ok: false, reason: 'duplicate' });
    expect((await store.getById('manual-message'))?.sats).toBe(21);
  });

  it('retries the same payment claim after the first receipt credit throws', async () => {
    class FailingReceiptCreditStore extends InMemoryMessageStore {
      recordZapReceiptCalls = 0;

      override recordZapReceipt(
        ...args: Parameters<InMemoryMessageStore['recordZapReceipt']>
      ): ReturnType<InMemoryMessageStore['recordZapReceipt']> {
        this.recordZapReceiptCalls += 1;
        if (this.recordZapReceiptCalls === 1) {
          return Promise.reject(new Error('receipt credit failed'));
        }
        return super.recordZapReceipt(...args);
      }
    }
    const store = new FailingReceiptCreditStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store,
      auth,
      accountId: 'credit-retry-author',
      messageId: 'credit-retry-message',
      lightningAddress: 'credit-retry@example.com',
    });
    const paymentHash = '2c'.repeat(32);
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'credit-retry-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-credit-retry'],
        ],
      },
    ];
    const args = {
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await ingest(args);
    expect((await store.getById(messageId))?.sats).toBe(0);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === 'credit-retry-receipt' &&
          row.outcome === 'rejected' &&
          row.reason === 'error',
      ),
    ).toBe(true);

    await ingest(args);
    warn.mockRestore();
    expect(store.recordZapReceiptCalls).toBe(2);
    expect((await store.getById(messageId))?.sats).toBe(21);
    expect(
      (await store.listZapIngests(10)).some(
        (row) => row.receiptId === 'credit-retry-receipt' && row.outcome === 'indexed',
      ),
    ).toBe(true);
  });

  it('keeps the payment claim after deleting and recreating a settled message', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'restored-author',
      messageId: 'manual-message',
      lightningAddress: 'restored@example.com',
    });
    const paymentHash = '2b'.repeat(32);
    const manualReceiptId = manualReceiptIdForPaymentHash(paymentHash);
    await seedManualInvoice(store, paymentHash);
    expect(
      (
        await settleInvoiceManually({
          store,
          auth,
          now: () => 1,
          paymentHash,
          note: 'wallet evidence',
        })
      ).ok,
    ).toBe(true);
    expect(await store.deleteById('manual-message')).toBe(true);
    expect(await store.getZapReceiptGift(manualReceiptId)).toBeUndefined();
    await seedStore({
      store,
      auth,
      accountId: 'restored-author',
      messageId: 'manual-message',
      lightningAddress: 'restored@example.com',
    });

    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 210_000_000 });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'real-receipt-after-restore',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-after-restore'],
        ],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect((await store.getById('manual-message'))?.sats).toBe(0);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === 'real-receipt-after-restore' &&
          row.outcome === 'rejected' &&
          row.reason === 'settled',
      ),
    ).toBe(true);
  });

  it('persists one rejected/duplicate for a known receipt then skips validation', async () => {
    const base = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const messageId = await seedStore({
      store: base,
      auth,
      accountId: 'acc-known-dup',
      lightningAddress: 'zap-known-dup@example.com',
    });
    await base.recordZapReceipt('r-known-dup', messageId, 21);
    let getByEventIdCalls = 0;
    const store = {
      listLatest: (limit: number) => base.listLatest(limit),
      listFeed: (query: MessageFeedQuery) => base.listFeed(query),
      listDebug: (limit: number) => base.listDebug(limit),
      postCountsByUtcDay: () => base.postCountsByUtcDay(),
      listHidden: (limit: number) => base.listHidden(limit),
      listIdsByPrefix: (prefix: string) => base.listIdsByPrefix(prefix),
      listDirectChildren: (parentId: string) => base.listDirectChildren(parentId),
      listChildIds: (parentId: string) => base.listChildIds(parentId),
      listReplies: (parentId: string, limit?: number, includeHidden?: boolean) =>
        base.listReplies(parentId, limit, includeHidden),
      listPublishedEventIds: (limit: number) => base.listPublishedEventIds(limit),
      create: (...args: Parameters<InMemoryMessageStore['create']>) => base.create(...args),
      findLiveByAccountContent: (
        ...args: Parameters<InMemoryMessageStore['findLiveByAccountContent']>
      ) => base.findLiveByAccountContent(...args),
      accountHasLivePost: (...args: Parameters<InMemoryMessageStore['accountHasLivePost']>) =>
        base.accountHasLivePost(...args),
      accountHasLiveTopLevelPost: (
        ...args: Parameters<InMemoryMessageStore['accountHasLiveTopLevelPost']>
      ) => base.accountHasLiveTopLevelPost(...args),
      countByAccount: (...args: Parameters<InMemoryMessageStore['countByAccount']>) =>
        base.countByAccount(...args),
      countAttributedReplies: (
        ...args: Parameters<InMemoryMessageStore['countAttributedReplies']>
      ) => base.countAttributedReplies(...args),
      listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
        base.listPostsByAccount(...args),
      listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
        base.listRepliesByAccount(...args),
      getPhoto: (id: string) => base.getPhoto(id),
      getExtraPhoto: (id: string, index: number) => base.getExtraPhoto(id, index),
      listExtraPhotos: (id: string) => base.listExtraPhotos(id),
      deleteById: (id: string) => base.deleteById(id),
      markDeleted: (id: string, at: Date, by: string) => base.markDeleted(id, at, by),
      markUndeleted: (id: string) => base.markUndeleted(id),
      getById: (id: string) => base.getById(id),
      getByEventId: async (id: string) => {
        getByEventIdCalls += 1;
        return base.getByEventId(id);
      },
      claimUnsigned: (...args: Parameters<InMemoryMessageStore['claimUnsigned']>) =>
        base.claimUnsigned(...args),
      claimUnpublished: (...args: Parameters<InMemoryMessageStore['claimUnpublished']>) =>
        base.claimUnpublished(...args),
      listPendingSigned: (limit: number) => base.listPendingSigned(limit),
      listSignedMissingPhoto: (limit: number) => base.listSignedMissingPhoto(limit),
      listSignedMissingVideo: (limit: number) => base.listSignedMissingVideo(limit),
      listSignedMissingHashtags: (limit: number) => base.listSignedMissingHashtags(limit),
      clearSignedEvent: (...args: Parameters<InMemoryMessageStore['clearSignedEvent']>) =>
        base.clearSignedEvent(...args),
      resetSignedEvent: (...args: Parameters<InMemoryMessageStore['resetSignedEvent']>) =>
        base.resetSignedEvent(...args),
      updateText: (...args: Parameters<InMemoryMessageStore['updateText']>) =>
        base.updateText(...args),
      updatePhoto: (...args: Parameters<InMemoryMessageStore['updatePhoto']>) =>
        base.updatePhoto(...args),
      updateSignedEvent: (...args: Parameters<InMemoryMessageStore['updateSignedEvent']>) =>
        base.updateSignedEvent(...args),
      updatePublishState: (...args: Parameters<InMemoryMessageStore['updatePublishState']>) =>
        base.updatePublishState(...args),
      addSats: (...args: Parameters<InMemoryMessageStore['addSats']>) => base.addSats(...args),
      claimZapPayment: (...args: Parameters<InMemoryMessageStore['claimZapPayment']>) =>
        base.claimZapPayment(...args),
      recordZapReceipt: (...args: Parameters<InMemoryMessageStore['recordZapReceipt']>) =>
        base.recordZapReceipt(...args),
      recordInvoiceAttempt: (...args: Parameters<InMemoryMessageStore['recordInvoiceAttempt']>) =>
        base.recordInvoiceAttempt(...args),
      listInvoiceAttempts: (limit: number) => base.listInvoiceAttempts(limit),
      recordZapIngest: (...args: Parameters<InMemoryMessageStore['recordZapIngest']>) =>
        base.recordZapIngest(...args),
      listZapIngests: (limit: number) => base.listZapIngests(limit),
      findOkInvoiceByPaymentHash: (hash: string) => base.findOkInvoiceByPaymentHash(hash),
      findOkInvoiceByPr: (pr: string) => base.findOkInvoiceByPr(pr),
      updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
        base.updateZapReceiptGift(...args),
      getZapReceiptGift: (id: string) => base.getZapReceiptGift(id),
      listZapReceiptsAwaitingGiftReply: (limit: number) =>
        base.listZapReceiptsAwaitingGiftReply(limit),
      attributeZapReceipt: (...args: Parameters<InMemoryMessageStore['attributeZapReceipt']>) =>
        base.attributeZapReceipt(...args),
      recordZapper: (...args: Parameters<InMemoryMessageStore['recordZapper']>) =>
        base.recordZapper(...args),
      listZapperPubkeys: (...args: Parameters<InMemoryMessageStore['listZapperPubkeys']>) =>
        base.listZapperPubkeys(...args),
      listZappers: (...args: Parameters<InMemoryMessageStore['listZappers']>) =>
        base.listZappers(...args),
      blockPubkeyAndHideRows: (
        ...args: Parameters<InMemoryMessageStore['blockPubkeyAndHideRows']>
      ) => base.blockPubkeyAndHideRows(...args),
      unblockPubkeyByMessage: (
        ...args: Parameters<InMemoryMessageStore['unblockPubkeyByMessage']>
      ) => base.unblockPubkeyByMessage(...args),
      isPubkeyBlocked: (...args: Parameters<InMemoryMessageStore['isPubkeyBlocked']>) =>
        base.isPubkeyBlocked(...args),
      isZapperPubkey: (...args: Parameters<InMemoryMessageStore['isZapperPubkey']>) =>
        base.isZapperPubkey(...args),
      listBlockedPubkeys: (...args: Parameters<InMemoryMessageStore['listBlockedPubkeys']>) =>
        base.listBlockedPubkeys(...args),
      listBlockedPubkeyRows: (...args: Parameters<InMemoryMessageStore['listBlockedPubkeyRows']>) =>
        base.listBlockedPubkeyRows(...args),
      listUnattributedIndexedReceipts: (
        ...args: Parameters<InMemoryMessageStore['listUnattributedIndexedReceipts']>
      ) => base.listUnattributedIndexedReceipts(...args),
      listInvoiceAttemptsForPayer: (payerAccountId: string) =>
        base.listInvoiceAttemptsForPayer(payerAccountId),
      listIndexedZapIngests: () => base.listIndexedZapIngests(),
      listAuthoredMessages: (accountId: string) => base.listAuthoredMessages(accountId),
      listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
    };
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-known-dup',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-known-dup'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listZapIngests(10)).toHaveLength(1);
    expect((await store.listZapIngests(10))[0]?.outcome).toBe('rejected');
    expect((await store.listZapIngests(10))[0]?.reason).toBe('duplicate');
    const callsAfterFirst = getByEventIdCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listZapIngests(10)).toHaveLength(1);
    expect(getByEventIdCalls).toBe(callsAfterFirst);
  });

  it('persists again when a non-terminal decision later becomes indexed', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const accountId = 'acc-decision-change';
    await seedStore({
      store,
      auth,
      accountId,
      lightningAddress: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-decision-change',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-decision-change'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const afterAddress = await store.listZapIngests(10);
    expect(afterAddress).toHaveLength(1);
    expect(afterAddress[0]?.outcome).toBe('rejected');
    expect(afterAddress[0]?.reason).toBe('address');
    const account = await auth.getAccount(accountId);
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...account,
      lightningAddress: 'zap-decision-change@example.com',
    });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const afterIndexed = await store.listZapIngests(10);
    expect(afterIndexed).toHaveLength(2);
    expect(afterIndexed.some((row) => row.outcome === 'rejected' && row.reason === 'address')).toBe(
      true,
    );
    expect(afterIndexed.some((row) => row.outcome === 'indexed' && row.reason === null)).toBe(true);
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
  });

  it('does not remember a decision when recordZapIngest throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const base = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      await seedStore({
        store: base,
        auth,
        accountId: 'acc-remember-fail',
        lightningAddress: 'zap-remember-fail@example.com',
      });
      let ingestCalls = 0;
      const store = {
        listLatest: (limit: number) => base.listLatest(limit),
        listFeed: (query: MessageFeedQuery) => base.listFeed(query),
        listDebug: (limit: number) => base.listDebug(limit),
        postCountsByUtcDay: () => base.postCountsByUtcDay(),
        listHidden: (limit: number) => base.listHidden(limit),
        listIdsByPrefix: (prefix: string) => base.listIdsByPrefix(prefix),
        listDirectChildren: (parentId: string) => base.listDirectChildren(parentId),
        listChildIds: (parentId: string) => base.listChildIds(parentId),
        listReplies: (parentId: string, limit?: number, includeHidden?: boolean) =>
          base.listReplies(parentId, limit, includeHidden),
        listPublishedEventIds: (limit: number) => base.listPublishedEventIds(limit),
        create: (...args: Parameters<InMemoryMessageStore['create']>) => base.create(...args),
        findLiveByAccountContent: (
          ...args: Parameters<InMemoryMessageStore['findLiveByAccountContent']>
        ) => base.findLiveByAccountContent(...args),
        accountHasLivePost: (...args: Parameters<InMemoryMessageStore['accountHasLivePost']>) =>
          base.accountHasLivePost(...args),
        accountHasLiveTopLevelPost: (
          ...args: Parameters<InMemoryMessageStore['accountHasLiveTopLevelPost']>
        ) => base.accountHasLiveTopLevelPost(...args),
        countByAccount: (...args: Parameters<InMemoryMessageStore['countByAccount']>) =>
          base.countByAccount(...args),
        countAttributedReplies: (
          ...args: Parameters<InMemoryMessageStore['countAttributedReplies']>
        ) => base.countAttributedReplies(...args),
        listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
          base.listPostsByAccount(...args),
        listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
          base.listRepliesByAccount(...args),
        getPhoto: (id: string) => base.getPhoto(id),
        getExtraPhoto: (id: string, index: number) => base.getExtraPhoto(id, index),
        listExtraPhotos: (id: string) => base.listExtraPhotos(id),
        deleteById: (id: string) => base.deleteById(id),
        markDeleted: (id: string, at: Date, by: string) => base.markDeleted(id, at, by),
        markUndeleted: (id: string) => base.markUndeleted(id),
        getById: (id: string) => base.getById(id),
        getByEventId: (id: string) => base.getByEventId(id),
        claimUnsigned: (...args: Parameters<InMemoryMessageStore['claimUnsigned']>) =>
          base.claimUnsigned(...args),
        claimUnpublished: (...args: Parameters<InMemoryMessageStore['claimUnpublished']>) =>
          base.claimUnpublished(...args),
        listPendingSigned: (limit: number) => base.listPendingSigned(limit),
        listSignedMissingPhoto: (limit: number) => base.listSignedMissingPhoto(limit),
        listSignedMissingVideo: (limit: number) => base.listSignedMissingVideo(limit),
        listSignedMissingHashtags: (limit: number) => base.listSignedMissingHashtags(limit),
        clearSignedEvent: (...args: Parameters<InMemoryMessageStore['clearSignedEvent']>) =>
          base.clearSignedEvent(...args),
        resetSignedEvent: (...args: Parameters<InMemoryMessageStore['resetSignedEvent']>) =>
          base.resetSignedEvent(...args),
        updateText: (...args: Parameters<InMemoryMessageStore['updateText']>) =>
          base.updateText(...args),
        updatePhoto: (...args: Parameters<InMemoryMessageStore['updatePhoto']>) =>
          base.updatePhoto(...args),
        updateSignedEvent: (...args: Parameters<InMemoryMessageStore['updateSignedEvent']>) =>
          base.updateSignedEvent(...args),
        updatePublishState: (...args: Parameters<InMemoryMessageStore['updatePublishState']>) =>
          base.updatePublishState(...args),
        addSats: (...args: Parameters<InMemoryMessageStore['addSats']>) => base.addSats(...args),
        claimZapPayment: (...args: Parameters<InMemoryMessageStore['claimZapPayment']>) =>
          base.claimZapPayment(...args),
        recordZapReceipt: (...args: Parameters<InMemoryMessageStore['recordZapReceipt']>) =>
          base.recordZapReceipt(...args),
        recordInvoiceAttempt: (...args: Parameters<InMemoryMessageStore['recordInvoiceAttempt']>) =>
          base.recordInvoiceAttempt(...args),
        listInvoiceAttempts: (limit: number) => base.listInvoiceAttempts(limit),
        recordZapIngest: async (...args: Parameters<InMemoryMessageStore['recordZapIngest']>) => {
          ingestCalls += 1;
          if (ingestCalls === 1) {
            throw new Error('ingest persist boom');
          }
          return base.recordZapIngest(...args);
        },
        listZapIngests: (limit: number) => base.listZapIngests(limit),
        findOkInvoiceByPaymentHash: (hash: string) => base.findOkInvoiceByPaymentHash(hash),
        findOkInvoiceByPr: (pr: string) => base.findOkInvoiceByPr(pr),
        updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
          base.updateZapReceiptGift(...args),
        getZapReceiptGift: (id: string) => base.getZapReceiptGift(id),
        listZapReceiptsAwaitingGiftReply: (limit: number) =>
          base.listZapReceiptsAwaitingGiftReply(limit),
        attributeZapReceipt: (...args: Parameters<InMemoryMessageStore['attributeZapReceipt']>) =>
          base.attributeZapReceipt(...args),
        recordZapper: (...args: Parameters<InMemoryMessageStore['recordZapper']>) =>
          base.recordZapper(...args),
        listZapperPubkeys: (...args: Parameters<InMemoryMessageStore['listZapperPubkeys']>) =>
          base.listZapperPubkeys(...args),
        listZappers: (...args: Parameters<InMemoryMessageStore['listZappers']>) =>
          base.listZappers(...args),
        blockPubkeyAndHideRows: (
          ...args: Parameters<InMemoryMessageStore['blockPubkeyAndHideRows']>
        ) => base.blockPubkeyAndHideRows(...args),
        unblockPubkeyByMessage: (
          ...args: Parameters<InMemoryMessageStore['unblockPubkeyByMessage']>
        ) => base.unblockPubkeyByMessage(...args),
        isPubkeyBlocked: (...args: Parameters<InMemoryMessageStore['isPubkeyBlocked']>) =>
          base.isPubkeyBlocked(...args),
        isZapperPubkey: (...args: Parameters<InMemoryMessageStore['isZapperPubkey']>) =>
          base.isZapperPubkey(...args),
        listBlockedPubkeys: (...args: Parameters<InMemoryMessageStore['listBlockedPubkeys']>) =>
          base.listBlockedPubkeys(...args),
        listBlockedPubkeyRows: (
          ...args: Parameters<InMemoryMessageStore['listBlockedPubkeyRows']>
        ) => base.listBlockedPubkeyRows(...args),
        listUnattributedIndexedReceipts: (
          ...args: Parameters<InMemoryMessageStore['listUnattributedIndexedReceipts']>
        ) => base.listUnattributedIndexedReceipts(...args),
        listInvoiceAttemptsForPayer: (payerAccountId: string) =>
          base.listInvoiceAttemptsForPayer(payerAccountId),
        listIndexedZapIngests: () => base.listIndexedZapIngests(),
        listAuthoredMessages: (accountId: string) => base.listAuthoredMessages(accountId),
        listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
      };
      const querier = new RecordingQuerier();
      querier.events = [
        {
          id: 'r-remember-fail',
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [
            ['e', NOTE_EVENT_ID],
            ['bolt11', 'lnbc-remember-fail'],
          ],
        },
      ];
      mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => 1,
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      });
      expect(ingestCalls).toBe(1);
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => 1,
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      });
      expect(ingestCalls).toBe(2);
      const ingests = await store.listZapIngests(10);
      expect(ingests).toHaveLength(1);
      expect(ingests[0]?.outcome).toBe('rejected');
      expect(ingests[0]?.reason).toBe('duplicate');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a second identical non-terminal ingest write', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-same-reject',
      lightningAddress: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-same-reject',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-same-reject'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listZapIngests(10)).toHaveLength(1);
    expect((await store.listZapIngests(10))[0]?.reason).toBe('address');
  });

  it('caches provider pubkey within TTL and refreshes after expiry', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    const address = 'zap-cache-unique@example.com';
    await seedStore({
      store,
      auth,
      accountId: 'acc-cache',
      lightningAddress: address,
    });
    let fetchCount = 0;
    const countingFetch: FetchFn = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: true,
          nostrPubkey: PROVIDER_PUBKEY,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    // One payment hash per invoice: the payment claim dedupes receipts that share a hash.
    mockedDecode.mockImplementation((pr) => ({
      paymentHash: createHash('sha256').update(pr).digest('hex'),
      amountMsat: 1000,
    }));
    const t0 = 1_000_000;
    for (const [receiptId, nowMs] of [
      ['r-cache-1', t0],
      ['r-cache-2', t0 + 1],
    ] as const) {
      querier.events = [
        {
          id: receiptId,
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [
            ['e', NOTE_EVENT_ID],
            ['bolt11', `lnbc-cache-${receiptId}`],
          ],
        },
      ];
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => nowMs,
        fetchImpl: countingFetch,
      });
    }
    expect(fetchCount).toBe(1);

    querier.events = [
      {
        id: 'r-cache-3',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-cache-3'],
        ],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => t0 + LN_ADDRESS_CACHE_TTL_MS + 1,
      fetchImpl: countingFetch,
    });
    expect(fetchCount).toBe(2);
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(3);
  });

  it('does not increment sats when the signature check fails', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({ store, auth, accountId: 'acc-sig' });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-sig',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-sig'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      verifyReceipt: () => false,
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('rejected');
    expect(ingests[0]?.reason).toBe('sig');
    expect(ingests[0]?.receiptId).toBe('r-sig');
  });

  it('rejects a foreign-provider receipt before claiming the payment hash', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({ store, auth, accountId: 'acc-foreign' });
    const querier = new RecordingQuerier();
    const paymentHash = '12'.repeat(32);
    querier.events = [
      {
        id: 'r-foreign',
        pubkey: 'bb'.repeat(32),
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-foreign'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('rejected');
    expect(ingests[0]?.reason).toBe('pubkey');
    // The hash stays unclaimed, so the provider's real receipt can still take it.
    expect(await store.claimZapPayment(paymentHash, 'r-real', new Date(2))).toBe(true);
  });

  it('logs nostr.zap.ingest.record_failed when recordZapIngest throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const base = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      await seedStore({
        store: base,
        auth,
        accountId: 'acc-record-fail',
        lightningAddress: 'zap-record-fail@example.com',
      });
      const store = {
        listLatest: (limit: number) => base.listLatest(limit),
        listFeed: (query: MessageFeedQuery) => base.listFeed(query),
        listDebug: (limit: number) => base.listDebug(limit),
        postCountsByUtcDay: () => base.postCountsByUtcDay(),
        listHidden: (limit: number) => base.listHidden(limit),
        listIdsByPrefix: (prefix: string) => base.listIdsByPrefix(prefix),
        listDirectChildren: (parentId: string) => base.listDirectChildren(parentId),
        listChildIds: (parentId: string) => base.listChildIds(parentId),
        listReplies: (parentId: string, limit?: number, includeHidden?: boolean) =>
          base.listReplies(parentId, limit, includeHidden),
        listPublishedEventIds: (limit: number) => base.listPublishedEventIds(limit),
        create: (...args: Parameters<InMemoryMessageStore['create']>) => base.create(...args),
        findLiveByAccountContent: (
          ...args: Parameters<InMemoryMessageStore['findLiveByAccountContent']>
        ) => base.findLiveByAccountContent(...args),
        accountHasLivePost: (...args: Parameters<InMemoryMessageStore['accountHasLivePost']>) =>
          base.accountHasLivePost(...args),
        accountHasLiveTopLevelPost: (
          ...args: Parameters<InMemoryMessageStore['accountHasLiveTopLevelPost']>
        ) => base.accountHasLiveTopLevelPost(...args),
        countByAccount: (...args: Parameters<InMemoryMessageStore['countByAccount']>) =>
          base.countByAccount(...args),
        countAttributedReplies: (
          ...args: Parameters<InMemoryMessageStore['countAttributedReplies']>
        ) => base.countAttributedReplies(...args),
        listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
          base.listPostsByAccount(...args),
        listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
          base.listRepliesByAccount(...args),
        getPhoto: (id: string) => base.getPhoto(id),
        getExtraPhoto: (id: string, index: number) => base.getExtraPhoto(id, index),
        listExtraPhotos: (id: string) => base.listExtraPhotos(id),
        deleteById: (id: string) => base.deleteById(id),
        markDeleted: (id: string, at: Date, by: string) => base.markDeleted(id, at, by),
        markUndeleted: (id: string) => base.markUndeleted(id),
        getById: (id: string) => base.getById(id),
        getByEventId: (id: string) => base.getByEventId(id),
        claimUnsigned: (...args: Parameters<InMemoryMessageStore['claimUnsigned']>) =>
          base.claimUnsigned(...args),
        claimUnpublished: (...args: Parameters<InMemoryMessageStore['claimUnpublished']>) =>
          base.claimUnpublished(...args),
        listPendingSigned: (limit: number) => base.listPendingSigned(limit),
        listSignedMissingPhoto: (limit: number) => base.listSignedMissingPhoto(limit),
        listSignedMissingVideo: (limit: number) => base.listSignedMissingVideo(limit),
        listSignedMissingHashtags: (limit: number) => base.listSignedMissingHashtags(limit),
        clearSignedEvent: (...args: Parameters<InMemoryMessageStore['clearSignedEvent']>) =>
          base.clearSignedEvent(...args),
        resetSignedEvent: (...args: Parameters<InMemoryMessageStore['resetSignedEvent']>) =>
          base.resetSignedEvent(...args),
        updateText: (...args: Parameters<InMemoryMessageStore['updateText']>) =>
          base.updateText(...args),
        updatePhoto: (...args: Parameters<InMemoryMessageStore['updatePhoto']>) =>
          base.updatePhoto(...args),
        updateSignedEvent: (...args: Parameters<InMemoryMessageStore['updateSignedEvent']>) =>
          base.updateSignedEvent(...args),
        updatePublishState: (...args: Parameters<InMemoryMessageStore['updatePublishState']>) =>
          base.updatePublishState(...args),
        addSats: (...args: Parameters<InMemoryMessageStore['addSats']>) => base.addSats(...args),
        claimZapPayment: (...args: Parameters<InMemoryMessageStore['claimZapPayment']>) =>
          base.claimZapPayment(...args),
        recordZapReceipt: (...args: Parameters<InMemoryMessageStore['recordZapReceipt']>) =>
          base.recordZapReceipt(...args),
        recordInvoiceAttempt: (...args: Parameters<InMemoryMessageStore['recordInvoiceAttempt']>) =>
          base.recordInvoiceAttempt(...args),
        listInvoiceAttempts: (limit: number) => base.listInvoiceAttempts(limit),
        recordZapIngest: async () => {
          throw new Error('ingest persist boom');
        },
        listZapIngests: (limit: number) => base.listZapIngests(limit),
        findOkInvoiceByPaymentHash: (hash: string) => base.findOkInvoiceByPaymentHash(hash),
        findOkInvoiceByPr: (pr: string) => base.findOkInvoiceByPr(pr),
        updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
          base.updateZapReceiptGift(...args),
        getZapReceiptGift: (id: string) => base.getZapReceiptGift(id),
        listZapReceiptsAwaitingGiftReply: (limit: number) =>
          base.listZapReceiptsAwaitingGiftReply(limit),
        attributeZapReceipt: (...args: Parameters<InMemoryMessageStore['attributeZapReceipt']>) =>
          base.attributeZapReceipt(...args),
        recordZapper: (...args: Parameters<InMemoryMessageStore['recordZapper']>) =>
          base.recordZapper(...args),
        listZapperPubkeys: (...args: Parameters<InMemoryMessageStore['listZapperPubkeys']>) =>
          base.listZapperPubkeys(...args),
        listZappers: (...args: Parameters<InMemoryMessageStore['listZappers']>) =>
          base.listZappers(...args),
        blockPubkeyAndHideRows: (
          ...args: Parameters<InMemoryMessageStore['blockPubkeyAndHideRows']>
        ) => base.blockPubkeyAndHideRows(...args),
        unblockPubkeyByMessage: (
          ...args: Parameters<InMemoryMessageStore['unblockPubkeyByMessage']>
        ) => base.unblockPubkeyByMessage(...args),
        isPubkeyBlocked: (...args: Parameters<InMemoryMessageStore['isPubkeyBlocked']>) =>
          base.isPubkeyBlocked(...args),
        isZapperPubkey: (...args: Parameters<InMemoryMessageStore['isZapperPubkey']>) =>
          base.isZapperPubkey(...args),
        listBlockedPubkeys: (...args: Parameters<InMemoryMessageStore['listBlockedPubkeys']>) =>
          base.listBlockedPubkeys(...args),
        listBlockedPubkeyRows: (
          ...args: Parameters<InMemoryMessageStore['listBlockedPubkeyRows']>
        ) => base.listBlockedPubkeyRows(...args),
        listUnattributedIndexedReceipts: (
          ...args: Parameters<InMemoryMessageStore['listUnattributedIndexedReceipts']>
        ) => base.listUnattributedIndexedReceipts(...args),
        listInvoiceAttemptsForPayer: (payerAccountId: string) =>
          base.listInvoiceAttemptsForPayer(payerAccountId),
        listIndexedZapIngests: () => base.listIndexedZapIngests(),
        listAuthoredMessages: (accountId: string) => base.listAuthoredMessages(accountId),
        listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
      };
      const querier = new RecordingQuerier();
      querier.events = [
        {
          id: 'r-record-fail',
          pubkey: PROVIDER_PUBKEY,
          kind: 9735,
          tags: [
            ['e', NOTE_EVENT_ID],
            ['bolt11', 'lnbc-ok'],
          ],
        },
      ];
      mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
      await expect(
        ingest({
          store,
          auth,
          querier,
          urls: URLS,
          timeoutMs: 50,
          now: () => 1,
          fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        }),
      ).resolves.toBeUndefined();
      expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'nostr.zap.ingest.record_failed')).toBe(true);
      expect(events.some((e) => e['event'] === 'nostr.zap.indexed')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('indexes a later receipt when an earlier verify throws', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({ store, auth, accountId: 'acc-err' });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-err-1',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-1'],
        ],
      },
      {
        id: 'r-err-2',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-2'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    let calls = 0;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      verifyReceipt: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('verify boom');
        }
        return true;
      },
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
  });

  it('rejects unsigned frames when using the default verifier', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({ store, auth, accountId: 'acc-unsigned' });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-unsigned',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-unsigned'],
        ],
      },
      {
        id: 'dd'.repeat(32),
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-unsigned'],
        ],
        created_at: 1,
        sig: '',
      },
      {
        id: 'cc'.repeat(32),
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-bad-sig'],
        ],
        created_at: 1,
        sig: '11'.repeat(64),
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await indexOpenZapReceipts({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(0);
  });

  it('indexes a schnorr-signed 9735 with the default verifier', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const signed = finalizeEvent(
      {
        kind: 9735,
        content: '',
        created_at: 1_700_000_000,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-signed'],
        ],
      },
      secret,
    );
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-signed',
      lightningAddress: 'signed@example.com',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await indexOpenZapReceipts({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(pubkey),
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
  });

  it('records ingest error with null receiptPubkey when pubkey is not a string', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({ store, auth, accountId: 'acc-pubkey-type' });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-bad-pubkey',
        pubkey: 1 as unknown as string,
        kind: 9735,
        tags: [['e', NOTE_EVENT_ID]],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      verifyReceipt: () => {
        throw new Error('verify boom');
      },
    });
    const rows = await store.listZapIngests(10);
    const row = rows.find((item) => item.receiptId === 'r-bad-pubkey');
    expect(row?.outcome).toBe('rejected');
    expect(row?.reason).toBe('pubkey');
    expect(row?.receiptPubkey).toBeNull();
  });

  it('enqueues a zap push for the author when a receipt is newly indexed', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const signed = finalizeEvent(
      {
        kind: 9735,
        content: '',
        created_at: 1_700_000_000,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-signed-push'],
        ],
      },
      secret,
    );
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-zap-push',
      lightningAddress: 'zap-push@example.com',
    });
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/author',
      accountId: 'acc-zap-push',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(1),
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await indexOpenZapReceipts({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(pubkey),
      pushStore,
    });
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
    const claimed = await pushStore.claimPending(20, 2, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('acc-zap-push');
    expect(claimed[0]?.type).toBe('zap');
  });

  it('skips the invoice payer on zap notify and still notifies the note author', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-zap-payer-skip',
      lightningAddress: 'zap-payer-skip@example.com',
      messageId: 'm-zap-payer-skip',
    });
    await auth.createAccount({
      id: 'payer-zap-skip',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-zap-skip@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-zap-skip'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-zap-payer-skip',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-zap-skip',
      authorAccountId: 'acc-zap-payer-skip',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-zap-payer-skip',
      paymentHash: 'a1'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/author',
      accountId: 'acc-zap-payer-skip',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1),
    });
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/payer',
      accountId: 'payer-zap-skip',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1),
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-zap-payer-skip',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-zap-payer-skip'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'a1'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      notificationStore: notifications,
      pushStore,
    });
    const forAuthor = await notifications.listByRecipient('acc-zap-payer-skip', 10);
    const forPayer = await notifications.listByRecipient('payer-zap-skip', 10);
    expect(forPayer.filter((row) => row.type === 'zap')).toEqual([]);
    expect(forAuthor.filter((row) => row.type === 'zap')).toHaveLength(1);
  });

  it('creates one zap notification and no forum_reply for a gift-only zap', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-one-notify-empty',
      lightningAddress: 'zap-one-notify-empty@example.com',
      messageId: 'm-one-notify-empty',
    });
    await auth.createAccount({
      id: 'payer-one-notify-empty',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-one-notify-empty@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-one-notify-empty'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-one-notify-empty',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-one-notify-empty',
      authorAccountId: 'acc-one-notify-empty',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-one-notify-empty',
      paymentHash: 'a2'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const notifications = new InMemoryNotificationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-one-notify-empty',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-one-notify-empty'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'a2'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      notificationStore: notifications,
    });
    const forAuthor = await notifications.listByRecipient('acc-one-notify-empty', 10);
    const forPayer = await notifications.listByRecipient('payer-one-notify-empty', 10);
    expect(forAuthor.filter((row) => row.type === 'zap')).toHaveLength(1);
    expect(forAuthor.filter((row) => row.type === 'forum_reply')).toEqual([]);
    expect(forPayer.filter((row) => row.type === 'zap')).toEqual([]);
    expect(forPayer.filter((row) => row.type === 'forum_reply')).toEqual([]);
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('');
  });

  it('skips notifyZap and creates a compose post for a platform-note ingest', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'acc-ingest-platform',
      lightningAddress: 'platform-ingest@example.com',
      messageId: 'm-ingest-platform',
    });
    const platform = await auth.getAccount('acc-ingest-platform');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'payer-ingest-platform',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada-ingest-platform',
      lightningAddress: 'ada-ingest-platform@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-ingest-platform'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-ingest-platform',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: feeId,
      payerAccountId: 'payer-ingest-platform',
      authorAccountId: 'acc-ingest-platform',
      amountSats: 1,
      lightningAddress: null,
      zapRequest: { content: 'Hello from Ada' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-ingest-platform',
      paymentHash: 'c1'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const notifications = new InMemoryNotificationStore();
    const spendPing = { ping: vi.fn(async () => undefined) };
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-ingest-platform',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-ingest-platform'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c1'.repeat(32), amountMsat: 1000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      notificationStore: notifications,
      spendPing,
      postLimiter: new PostRateLimiter(),
    });
    const created = (await store.listLatest(20)).find((row) => row.text === 'Hello from Ada');
    expect(created?.parentId).toBeNull();
    expect(created?.accountId).toBe('payer-ingest-platform');
    expect(created?.sats).toBe(0);
    expect(spendPing.ping).toHaveBeenCalledTimes(0);
    const forPlatform = await notifications.listByRecipient('acc-ingest-platform', 10);
    expect(forPlatform.filter((row) => row.type === 'zap')).toEqual([]);
    expect(forPlatform.filter((row) => row.type === 'forum_post')).toHaveLength(1);
  });

  it('still queries the platform profile event after it ages out of listLatest', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileEventId = 'ab'.repeat(32);
    const feeId = await seedStore({
      store,
      auth,
      accountId: 'acc-aged-platform',
      eventId: profileEventId,
      lightningAddress: 'platform-aged@example.com',
      messageId: 'm-aged-platform',
    });
    const platform = await auth.getAccount('acc-aged-platform');
    expect(platform).toBeDefined();
    await auth.updateAccount({
      ...platform!,
      isPlatform: true,
      profileMessageId: feeId,
    });
    await auth.createAccount({
      id: 'payer-aged-platform',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada-aged-platform',
      lightningAddress: 'ada-aged-platform@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-aged-platform'),
      createdAt: 2,
      rulesAgreedAt: 1,
    });
    const newer = new Date('2026-09-21T00:00:00.000Z');
    for (let i = 0; i < MESSAGE_LIST_LIMIT; i += 1) {
      const n = i.toString(16).padStart(2, '0');
      await store.create({
        id: `m-aged-newer-${n}`,
        accountId: 'acc-aged-platform',
        name: 'Ada',
        text: `newer ${n}`,
        createdAt: newer,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        eventId: `${n}${'c'.repeat(62)}`,
      });
    }
    expect((await store.listLatest(MESSAGE_LIST_LIMIT)).some((row) => row.id === feeId)).toBe(
      false,
    );
    await store.recordInvoiceAttempt({
      id: 'inv-aged-platform',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: feeId,
      payerAccountId: 'payer-aged-platform',
      authorAccountId: 'acc-aged-platform',
      amountSats: 1,
      lightningAddress: null,
      zapRequest: { content: 'Aged compose' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-aged-platform',
      paymentHash: 'c2'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const queried: string[][] = [];
    const querier = {
      query: async (
        filter: Record<string, unknown>,
        _urls: readonly string[],
        _timeoutMs: number,
      ) => {
        const chunk = Array.isArray(filter['#e'])
          ? filter['#e'].filter((id): id is string => typeof id === 'string')
          : [];
        queried.push(chunk);
        if (!chunk.includes(profileEventId)) {
          return [];
        }
        return [
          {
            id: 'r-aged-platform',
            pubkey: PROVIDER_PUBKEY,
            kind: 9735,
            tags: [
              ['e', profileEventId],
              ['bolt11', 'lnbc-aged-platform'],
            ],
          },
        ];
      },
    };
    mockedDecode.mockReturnValue({ paymentHash: 'c2'.repeat(32), amountMsat: 1000 });
    const composeAt = newer.getTime() + 1_000;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => composeAt,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      postLimiter: new PostRateLimiter(),
    });
    expect(queried.some((chunk) => chunk.includes(profileEventId))).toBe(true);
    const created = (await store.listLatest(MESSAGE_LIST_LIMIT)).find(
      (row) => row.text === 'Aged compose',
    );
    expect(created?.parentId).toBeNull();
    expect(created?.accountId).toBe('payer-aged-platform');
    expect(created?.sats).toBe(0);
  });

  it('creates one zap notification and no forum_reply for a zap with a NIP-57 comment', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-one-notify-comment',
      lightningAddress: 'zap-one-notify-comment@example.com',
      messageId: 'm-one-notify-comment',
    });
    await auth.createAccount({
      id: 'payer-one-notify-comment',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-one-notify-comment@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-one-notify-comment'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-one-notify-comment',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-one-notify-comment',
      authorAccountId: 'acc-one-notify-comment',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-one-notify-comment',
      paymentHash: 'a3'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const notifications = new InMemoryNotificationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-one-notify-comment',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-one-notify-comment'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'a3'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      notificationStore: notifications,
    });
    const forAuthor = await notifications.listByRecipient('acc-one-notify-comment', 10);
    const forPayer = await notifications.listByRecipient('payer-one-notify-comment', 10);
    expect(forAuthor.filter((row) => row.type === 'zap')).toHaveLength(1);
    expect(forAuthor.filter((row) => row.type === 'forum_reply')).toEqual([]);
    expect(forPayer.filter((row) => row.type === 'zap')).toEqual([]);
    expect(forPayer.filter((row) => row.type === 'forum_reply')).toEqual([]);
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('thanks');
  });

  it('indexes sats even when zap push enqueue throws', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const signed = finalizeEvent(
      {
        kind: 9735,
        content: '',
        created_at: 1_700_000_000,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-signed-push-fail'],
        ],
      },
      secret,
    );
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-zap-push-fail',
      lightningAddress: 'zap-push-fail@example.com',
    });
    const pushStore = new InMemoryPushStore();
    pushStore.enqueue = async () => {
      throw new Error('enqueue failed');
    };
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/author',
      accountId: 'acc-zap-push-fail',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(1),
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await indexOpenZapReceipts({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(pubkey),
      pushStore,
    });
    warn.mockRestore();
    expect((await store.getByEventId(NOTE_EVENT_ID))?.sats).toBe(21);
  });

  it('keeps account zap resolution when invoice inspection lacks a description hash', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'inspect-null-author',
      lightningAddress: 'inspect-null-author@example.com',
      messageId: 'inspect-null-parent',
    });
    await auth.createAccount({
      id: 'inspect-null-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Iris',
      lightningAddress: 'inspect-null-payer@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('inspect-null-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inspect-null-invoice',
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'inspect-null-payer',
      authorAccountId: 'inspect-null-author',
      amountSats: 21,
      lightningAddress: 'inspect-null-author@example.com',
      zapRequest: { content: 'inspection fallback' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-inspect-null',
      paymentHash: 'a4'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'inspect-null-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-inspect-null'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'a4'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue(null);

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(mockedInspect).toHaveBeenCalledWith('lnbc-inspect-null');
    expect(await store.listReplies(parentId)).toEqual([
      expect.objectContaining({ accountId: 'inspect-null-payer', text: 'inspection fallback' }),
    ]);
  });

  it('resolves a remembered receipt without an e tag using an empty note event id', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'remembered-no-e-author',
      lightningAddress: 'remembered-no-e-author@example.com',
      messageId: 'remembered-no-e-parent',
    });
    await auth.createAccount({
      id: 'remembered-no-e-payer',
      linkingKey: null,
      role: 'basis',
      name: 'Nia',
      lightningAddress: 'remembered-no-e-payer@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('remembered-no-e-payer'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'remembered-no-e-invoice',
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'remembered-no-e-payer',
      authorAccountId: 'remembered-no-e-author',
      amountSats: 21,
      lightningAddress: 'remembered-no-e-author@example.com',
      zapRequest: { content: 'no e retry' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-remembered-no-e',
      paymentHash: 'a5'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const receipt: NostrEventFrame = {
      id: 'remembered-no-e-receipt',
      pubkey: PROVIDER_PUBKEY,
      kind: 9735,
      tags: [['bolt11', 'lnbc-remembered-no-e']],
    };
    mockedDecode.mockReturnValue({ paymentHash: 'a5'.repeat(32), amountMsat: 21_000 });
    mockedInspect.mockReturnValue(null);
    await indexZapReceipt({
      store,
      messageId: parentId,
      receipt,
      providerPubkey: PROVIDER_PUBKEY,
      amountSats: 21,
      receiptEvent: { ...receipt },
    });
    const querier = new RecordingQuerier();
    querier.events = [receipt];

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(await store.listReplies(parentId)).toEqual([
      expect.objectContaining({ accountId: 'remembered-no-e-payer', text: 'no e retry' }),
    ]);
  });

  it('creates a gift-only reply from an ok invoice after indexing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-gift-parent',
      lightningAddress: 'zap-gift-parent@example.com',
      messageId: 'm-gift-parent',
    });
    await auth.createAccount({
      id: 'payer-gift',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-gift'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-gift',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-gift',
      authorAccountId: 'acc-gift-parent',
      amountSats: 21,
      lightningAddress: 'zap-gift-parent@example.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-gift',
      paymentHash: '33'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-gift'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '33'.repeat(32), amountMsat: 21_000 });
    const pushStore = new InMemoryPushStore();
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      pushStore,
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.accountId).toBe('payer-gift');
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.sats).toBe(21);
    expect(replies[0]?.nostrPublishState).toBe('skipped');
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([]);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      pushStore,
    });
    expect(await store.listReplies(parentId)).toHaveLength(1);
  });

  it('does not insert a nested gift-reply when the zapped note is a reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-gift-reply-parent',
      lightningAddress: 'zap-gift-reply-parent@example.com',
      messageId: 'm-gift-reply-parent',
    });
    const replyEventId = 'dd'.repeat(32);
    const replyId = 'm-gift-reply-child';
    await store.create({
      id: replyId,
      accountId: 'acc-gift-reply-parent',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-08-28T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: replyEventId,
    });
    await auth.createAccount({
      id: 'payer-gift-reply',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob-gift-reply@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-gift-reply'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-gift-reply',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: replyId,
      payerAccountId: 'payer-gift-reply',
      authorAccountId: 'acc-gift-reply-parent',
      amountSats: 21,
      lightningAddress: 'zap-gift-reply-parent@example.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-gift-reply',
      paymentHash: '44'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift-reply',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', replyEventId],
          ['bolt11', 'lnbc-gift-reply'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '44'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(replyId))?.sats).toBe(21);
    expect(await store.listReplies(replyId)).toEqual([]);
    const siblings = await store.listReplies(parentId);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]?.id).toBe(replyId);
  });

  it('does not occupy the gift-reply retry queue when the zapped note is a reply', async () => {
    class HoldRetryStore extends InMemoryMessageStore {
      payerWrites: Array<string | null> = [];

      override updateZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['updateZapReceiptGift']> {
        if (args[0] === 'r-queue-drop-reply' && args[1].payerAccountId !== undefined) {
          this.payerWrites.push(args[1].payerAccountId);
        }
        return super.updateZapReceiptGift(...args);
      }

      override listZapReceiptsAwaitingGiftReply(
        _limit: number,
      ): ReturnType<InMemoryMessageStore['listZapReceiptsAwaitingGiftReply']> {
        // Keep retryGiftReplies from dropping the reply receipt itself.
        return Promise.resolve([]);
      }

      peekZapReceiptsAwaitingGiftReply(
        limit: number,
      ): ReturnType<InMemoryMessageStore['listZapReceiptsAwaitingGiftReply']> {
        return super.listZapReceiptsAwaitingGiftReply(limit);
      }
    }
    const store = new HoldRetryStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-queue-drop-parent',
      lightningAddress: 'zap-queue-drop-parent@example.com',
      messageId: 'm-queue-drop-parent',
    });
    const topAwaitId = await seedStore({
      store,
      auth,
      accountId: 'acc-queue-drop-parent',
      lightningAddress: 'zap-queue-drop-parent@example.com',
      messageId: 'm-queue-drop-top',
      eventId: 'ce'.repeat(32),
      createAccount: false,
    });
    await store.recordZapReceipt('r-queue-drop-top', topAwaitId, 7);
    await store.updateZapReceiptGift('r-queue-drop-top', {
      payerAccountId: 'payer-queue-drop-top',
    });
    const replyEventId = 'cd'.repeat(32);
    const replyId = 'm-queue-drop-child';
    await store.create({
      id: replyId,
      accountId: 'acc-queue-drop-parent',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-08-28T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: replyEventId,
    });
    await auth.createAccount({
      id: 'payer-queue-drop',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob-queue-drop@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-queue-drop'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-queue-drop',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: replyId,
      payerAccountId: 'payer-queue-drop',
      authorAccountId: 'acc-queue-drop-parent',
      amountSats: 21,
      lightningAddress: 'zap-queue-drop-parent@example.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-queue-drop',
      paymentHash: 'cf'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-queue-drop-reply',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', replyEventId],
          ['bolt11', 'lnbc-queue-drop'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'cf'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(replyId))?.sats).toBe(21);
    expect(await store.listReplies(replyId)).toEqual([]);
    const gift = await store.getZapReceiptGift('r-queue-drop-reply');
    expect(gift?.payerAccountId).toBeNull();
    expect(gift?.giftReplyId).toBeNull();
    expect(store.payerWrites).toEqual([null]);
    expect(await store.peekZapReceiptsAwaitingGiftReply(10)).toEqual([
      {
        receiptEventId: 'r-queue-drop-top',
        messageId: topAwaitId,
        sats: 7,
        payerAccountId: 'payer-queue-drop-top',
        payerPubkey: null,
        zapRequestId: null,
        receiptCreatedAt: null,
        comment: '',
      },
    ]);
  });

  it('queries a reply eventId and does not insert a nested gift-reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-gift-watch-parent',
      lightningAddress: 'zap-gift-watch-parent@example.com',
      messageId: 'm-gift-watch-parent',
    });
    const replyEventId = 'bb'.repeat(32);
    const replyId = 'm-gift-watch-child';
    await store.create({
      id: replyId,
      accountId: 'acc-gift-watch-parent',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-08-28T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: replyEventId,
    });
    await store.create({
      id: 'm-gift-watch-unsigned-parent',
      accountId: 'acc-gift-watch-parent',
      name: 'Ada',
      text: 'unsigned parent',
      createdAt: new Date('2026-08-28T00:00:02.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: null,
    });
    await store.create({
      id: 'm-gift-watch-null-child',
      accountId: 'acc-gift-watch-parent',
      name: 'Ada',
      text: 'null eventId child',
      createdAt: new Date('2026-08-28T00:00:03.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm-gift-watch-unsigned-parent',
      eventId: null,
    });
    await store.create({
      id: 'm-gift-watch-empty-child',
      accountId: 'acc-gift-watch-parent',
      name: 'Ada',
      text: 'empty eventId child',
      createdAt: new Date('2026-08-28T00:00:04.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm-gift-watch-unsigned-parent',
      eventId: '',
    });
    await auth.createAccount({
      id: 'payer-gift-watch',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob-gift-watch@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-gift-watch'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-gift-watch',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: replyId,
      payerAccountId: 'payer-gift-watch',
      authorAccountId: 'acc-gift-watch-parent',
      amountSats: 21,
      lightningAddress: 'zap-gift-watch-parent@example.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-gift-watch',
      paymentHash: '55'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift-watch',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', replyEventId],
          ['bolt11', 'lnbc-gift-watch'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '55'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(
      querier.calls.some((call) => {
        const tagged = call.filter['#e'];
        return Array.isArray(tagged) && tagged.includes(replyEventId);
      }),
    ).toBe(true);
    expect((await store.getById(replyId))?.sats).toBe(21);
    expect(await store.listReplies(replyId)).toEqual([]);
    const siblings = await store.listReplies(parentId);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]?.id).toBe(replyId);
  });

  it('retries a pending gift reply on the next tick', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-retry-parent',
      lightningAddress: 'zap-retry-parent@example.com',
      messageId: 'm-retry-parent',
    });
    await auth.createAccount({
      id: 'payer-retry',
      linkingKey: null,
      role: 'basis',
      name: 'Cara',
      lightningAddress: 'cara@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-retry'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordZapReceipt('r-retry', parentId, 7);
    await store.updateZapReceiptGift('r-retry', {
      payerAccountId: 'payer-retry',
      comment: 'keep going',
    });
    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('keep going');
    expect(replies[0]?.nostrPublishState).toBe('pending');
    expect(replies[0]?.sats).toBe(7);
  });

  it('skips retry insert when the pending receipt parent is a reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-retry-reply-parent',
      lightningAddress: 'zap-retry-reply-parent@example.com',
      messageId: 'm-retry-reply-parent',
    });
    const replyId = 'm-retry-reply-child';
    await store.create({
      id: replyId,
      accountId: 'acc-retry-reply-parent',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-08-28T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'cc'.repeat(32),
    });
    await auth.createAccount({
      id: 'payer-retry-reply',
      linkingKey: null,
      role: 'basis',
      name: 'Cara',
      lightningAddress: 'cara-retry-reply@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-retry-reply'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordZapReceipt('r-retry-reply', replyId, 7);
    await store.updateZapReceiptGift('r-retry-reply', {
      payerAccountId: 'payer-retry-reply',
      comment: 'keep going',
    });
    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect(await store.listReplies(replyId)).toEqual([]);
    const siblings = await store.listReplies(parentId);
    expect(siblings).toHaveLength(1);
    expect(siblings[0]?.id).toBe(replyId);
    expect((await store.getById(replyId))?.sats).toBe(7);
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([]);
  });

  it('dequeues a pending external payer when its parent is hidden', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'retry-hidden-external-author',
      messageId: 'retry-hidden-external-parent',
    });
    const receiptId = 'retry-hidden-external-receipt';
    const payerPubkey = 'b6'.repeat(32);
    await store.recordZapReceipt(receiptId, parentId, 21);
    await store.attributeZapReceipt(receiptId, {
      payerPubkey,
      zapRequestId: 'b7'.repeat(32),
      comment: 'hidden retry',
    });
    await store.markDeleted(parentId, new Date(2), 'retry-hidden-moderator');

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect((await store.getZapReceiptGift(receiptId))?.payerPubkey).toBeNull();
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('dequeues a pending external payer when its parent is a reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'retry-reply-external-author',
      eventId: 'b8'.repeat(32),
      messageId: 'retry-reply-external-parent',
    });
    const replyId = 'retry-reply-external-child';
    await store.create({
      id: replyId,
      accountId: 'retry-reply-external-author',
      name: 'Ada',
      text: 'child',
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: NOTE_EVENT_ID,
    });
    const receiptId = 'retry-reply-external-receipt';
    await store.recordZapReceipt(receiptId, replyId, 21);
    await store.attributeZapReceipt(receiptId, {
      payerPubkey: 'b9'.repeat(32),
      zapRequestId: 'ba'.repeat(32),
      comment: 'reply retry',
    });

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect((await store.getZapReceiptGift(receiptId))?.payerPubkey).toBeNull();
    expect(await store.listReplies(replyId)).toEqual([]);
  });

  it('clears a blocked external payer without a reply on this and a later retry tick', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'retry-blocked-external-author',
      messageId: 'retry-blocked-external-parent',
    });
    const receiptId = 'retry-blocked-external-receipt';
    const payerPubkey = '9c67a2e14d8f305b71c694e2af83d0574b2e9c116fd37a508ce429db65f184aa';

    await store.recordZapReceipt(receiptId, parentId, 21);
    await store.attributeZapReceipt(receiptId, {
      payerPubkey,
      zapRequestId: '2a8d5e71c4930fb6e17c4a925bd8603f74e1a9c50d6b328fac9574e163b20df8',
      comment: 'blocked retry',
    });
    await store.blockPubkeyAndHideRows(
      payerPubkey,
      new Date(1),
      'retry-blocked-staff',
      'retry-blocked-external-parent',
    );

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect((await store.getZapReceiptGift(receiptId))?.payerPubkey).toBeNull();
    expect(await store.listReplies(parentId)).toEqual([]);
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect((await store.getZapReceiptGift(receiptId))?.giftReplyId).toBeNull();

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect((await store.getZapReceiptGift(receiptId))?.payerPubkey).toBeNull();
    expect(await store.listReplies(parentId)).toEqual([]);
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect((await store.getZapReceiptGift(receiptId))?.giftReplyId).toBeNull();
  });

  it('lets an in-flight block win before a retried external gift reply is created', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'retry-block-race-author',
      messageId: 'retry-block-race-parent',
    });
    const receiptId = 'retry-block-race-receipt';
    const payerPubkey = getPublicKey(generateSecretKey());
    await store.recordZapReceipt(receiptId, parentId, 21);
    await store.attributeZapReceipt(receiptId, {
      payerPubkey,
      zapRequestId: '53'.repeat(32),
      comment: 'retry block race',
    });
    let releaseProfile: () => void = () => {};
    const profileHeld = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });
    let enterProfile: () => void = () => {};
    const profileEntered = new Promise<void>((resolve) => {
      enterProfile = resolve;
    });
    const querier = new RecordingQuerier();
    querier.query = async (): Promise<NostrEventFrame[]> => {
      enterProfile();
      await profileHeld;
      return [];
    };

    const pending = ingest({
      store,
      auth,
      querier,
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });
    await profileEntered;
    await store.blockPubkeyAndHideRows(
      payerPubkey,
      new Date(1_700_000_200_000),
      'retry-block-race-staff',
      'retry-block-race-message',
    );
    releaseProfile();
    await pending;

    expect(await store.listReplies(parentId)).toEqual([]);
    expect(await store.getZapReceiptGift(receiptId)).toMatchObject({
      payerPubkey: null,
      giftReplyId: null,
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
  });

  it('retries a pending external payer directly from the retry queue', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'retry-live-external-author',
      messageId: 'retry-live-external-parent',
    });
    const receiptId = 'retry-live-external-receipt';
    const payerPubkey = 'bb'.repeat(32);
    await store.recordZapReceipt(receiptId, parentId, 21);
    await store.recordZapper(payerPubkey, receiptId, new Date(1_700_000_100_000));
    await store.attributeZapReceipt(receiptId, {
      payerPubkey,
      zapRequestId: 'bc'.repeat(32),
      comment: 'live retry',
    });

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect(await store.listReplies(parentId)).toEqual([
      expect.objectContaining({
        accountId: null,
        authorPubkey: payerPubkey,
        text: 'live retry',
        nostrPublishState: 'skipped',
      }),
    ]);
    expect((await store.getZapReceiptGift(receiptId))?.giftReplyId).not.toBeNull();
  });

  it('skips a defensive retry row that has neither payer kind', async () => {
    const receiptId = 'retry-no-payer-receipt';
    const parentId = 'retry-no-payer-parent';
    class NoPayerRetryStore extends InMemoryMessageStore {
      override listZapReceiptsAwaitingGiftReply(_limit: number): Promise<ZapReceiptGiftRow[]> {
        return Promise.resolve([
          {
            receiptEventId: receiptId,
            messageId: parentId,
            sats: 21,
            payerAccountId: null,
            payerPubkey: null,
            zapRequestId: null,
            receiptCreatedAt: null,
            comment: 'must skip',
          },
        ]);
      }
    }
    const store = new NoPayerRetryStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'retry-no-payer-author',
      messageId: parentId,
    });
    const update = vi.spyOn(store, 'updateZapReceiptGift');
    const create = vi.spyOn(store, 'create');

    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: failFetch(),
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('does not create a reply when no payer can be resolved', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-anon-parent',
      lightningAddress: 'zap-anon-parent@example.com',
      messageId: 'm-anon-parent',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-anon',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-anon'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '55'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('creates a reply from a verified 9734 description when no invoice matches', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-damus-parent',
      lightningAddress: 'zap-damus-parent@example.com',
      messageId: 'm-damus-parent',
    });
    const zapSecret = generateSecretKey();
    const zapPub = getPublicKey(zapSecret);
    await auth.createAccount({
      id: 'payer-damus',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'damus@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-damus'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await auth.setNostrKeyIfAbsent('payer-damus', {
      pubkey: zapPub,
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    const zapReq = finalizeEvent(
      {
        kind: 9734,
        content: 'from damus',
        created_at: 1_700_000_000,
        tags: [['p', 'aa'.repeat(32)]],
      },
      zapSecret,
    );
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-damus',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-damus'],
          ['description', JSON.stringify(zapReq)],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '66'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.accountId).toBe('payer-damus');
    expect(replies[0]?.text).toBe('from damus');
  });

  it('keeps parent sats when gift-reply create throws', async () => {
    class BoomStore extends InMemoryMessageStore {
      override create(
        ...args: Parameters<InMemoryMessageStore['create']>
      ): ReturnType<InMemoryMessageStore['create']> {
        if (args[0].parentId !== null) {
          return Promise.reject(new Error('create boom'));
        }
        return super.create(...args);
      }
    }
    const store = new BoomStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-boom-parent',
      lightningAddress: 'zap-boom-parent@example.com',
      messageId: 'm-boom-parent',
    });
    await auth.createAccount({
      id: 'payer-boom',
      linkingKey: null,
      role: 'basis',
      name: 'Bo',
      lightningAddress: 'bo@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-boom'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-boom',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-boom',
      authorAccountId: 'acc-boom-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 21 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-boom',
      paymentHash: '77'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-boom',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-boom'],
          ['description', 'not-json'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '77'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listReplies(parentId)).toEqual([]);
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toHaveLength(1);
  });

  it('skips retry when the parent is gone or the payer is missing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-skip-parent',
      lightningAddress: 'zap-skip-parent@example.com',
      messageId: 'm-skip-parent',
    });
    await store.recordZapReceipt('r-skip-deleted', parentId, 3);
    await store.updateZapReceiptGift('r-skip-deleted', { payerAccountId: 'ghost' });
    await store.markDeleted(parentId, new Date(1), 'acc-skip-parent');
    await store.create({
      id: 'm-skip-live',
      accountId: 'acc-skip-parent',
      name: 'Ada',
      text: 'live',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: `${'01'.repeat(32)}`,
    });
    await store.recordZapReceipt('r-skip-ghost', 'm-skip-live', 3);
    await store.updateZapReceiptGift('r-skip-ghost', { payerAccountId: 'ghost' });
    await auth.createAccount({
      id: 'payer-no-inv',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'noinv@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-no-inv'),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    await store.recordZapReceipt('r-no-inv', 'm-skip-live', 2);
    await store.updateZapReceiptGift('r-no-inv', { payerAccountId: 'payer-no-inv' });
    class RetryBoomStore extends InMemoryMessageStore {
      override create(
        ...args: Parameters<InMemoryMessageStore['create']>
      ): ReturnType<InMemoryMessageStore['create']> {
        if (args[0].id !== 'm-skip-live' && args[0].parentId === 'm-skip-live') {
          return Promise.reject(new Error('retry boom'));
        }
        return super.create(...args);
      }
    }
    const boomStore = new RetryBoomStore();
    await boomStore.create((await store.getById('m-skip-live'))!);
    await boomStore.recordZapReceipt('r-no-inv', 'm-skip-live', 2);
    await boomStore.updateZapReceiptGift('r-no-inv', { payerAccountId: 'payer-no-inv' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store: boomStore,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    warn.mockRestore();
    await ingest({
      store,
      auth,
      querier: new RecordingQuerier(),
      urls: [],
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
      notificationStore: new InMemoryNotificationStore(),
      pushStore: new InMemoryPushStore(),
    });
    const skipped = await store.listReplies('m-skip-live');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.accountId).toBe('payer-no-inv');
    expect(skipped[0]?.text).toBe('');
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([]);
    expect((await store.getZapReceiptGift('r-skip-deleted'))?.payerAccountId).toBeNull();
    expect((await store.getZapReceiptGift('r-skip-ghost'))?.payerAccountId).toBeNull();
  });

  it('ignores an unverified or non-9734 description tag', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-bad-desc',
      lightningAddress: 'zap-bad-desc@example.com',
      messageId: 'm-bad-desc',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-bad-desc',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-bad-desc'],
          ['description', JSON.stringify({ kind: 1, pubkey: 'aa'.repeat(32), content: 'nope' })],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '88'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('ignores a 9734 description without id/sig or with a bad signature', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-bad-sig',
      lightningAddress: 'zap-bad-sig@example.com',
      messageId: 'm-bad-sig',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-no-sig',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-no-sig'],
          ['description', JSON.stringify({ kind: 9734, pubkey: 'aa'.repeat(32), content: 'x' })],
        ],
      },
      {
        id: 'r-bad-sig',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-bad-sig'],
          [
            'description',
            JSON.stringify({
              kind: 9734,
              pubkey: 'aa'.repeat(32),
              id: 'ff'.repeat(32),
              sig: 'ee'.repeat(32),
              created_at: 1,
              tags: [],
              content: 'x',
            }),
          ],
        ],
      },
    ];
    // One payment hash per invoice: the payment claim dedupes receipts that share a hash.
    mockedDecode.mockImplementation((pr) => ({
      paymentHash: createHash('sha256').update(pr).digest('hex'),
      amountMsat: 21_000,
    }));
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(42);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('ignores empty, non-json, and non-object description tags', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-desc-parse',
      lightningAddress: 'zap-desc-parse@example.com',
      messageId: 'm-desc-parse',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-empty-desc',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-empty-desc'],
          ['description', ''],
        ],
      },
      {
        id: 'r-not-json',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-not-json'],
          ['description', 'not-json'],
        ],
      },
      {
        id: 'r-json-null',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-json-null'],
          ['description', 'null'],
        ],
      },
      {
        id: 'r-json-num',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-json-num'],
          ['description', '1'],
        ],
      },
      {
        id: 'r-overlong',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-overlong'],
          [
            'description',
            JSON.stringify(
              finalizeEvent(
                {
                  kind: 9734,
                  content: 'A'.repeat(501),
                  created_at: 1_700_000_000,
                  tags: [['p', 'aa'.repeat(32)]],
                },
                generateSecretKey(),
              ),
            ),
          ],
        ],
      },
    ];
    // One payment hash per invoice: the payment claim dedupes receipts that share a hash.
    mockedDecode.mockImplementation((pr) => ({
      paymentHash: createHash('sha256').update(pr).digest('hex'),
      amountMsat: 21_000,
    }));
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(105);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('matches an ok invoice by pr when the payment hash differs', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-pr-parent',
      lightningAddress: 'zap-pr-parent@example.com',
      messageId: 'm-pr-parent',
    });
    await auth.createAccount({
      id: 'payer-pr',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-pr'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-pr',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-pr',
      authorAccountId: 'acc-pr-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'via pr' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pr-match',
      paymentHash: '00'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pr',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pr-match'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'bb'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('via pr');
  });

  it('logs notify failure without dropping the gift reply', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-notify-parent',
      lightningAddress: 'zap-notify-parent@example.com',
      messageId: 'm-notify-parent',
    });
    await auth.createAccount({
      id: 'payer-notify',
      linkingKey: null,
      role: 'basis',
      name: 'Ned',
      lightningAddress: 'ned@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-notify'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-notify',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-notify',
      authorAccountId: 'acc-notify-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'A'.repeat(501) },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-notify',
      paymentHash: 'cc'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const notifications = new InMemoryNotificationStore();
    notifications.create = async () => {
      throw new Error('notify boom');
    };
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/notify-boom',
      accountId: 'acc-notify-parent',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1),
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-notify',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-notify'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'cc'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      notificationStore: notifications,
      pushStore,
    });
    warn.mockRestore();
    expect(await store.listReplies(parentId)).toHaveLength(1);
  });

  it('does not attribute a gift reply to a 9734 pubkey when the invoice payer is gone', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-wrong-parent',
      lightningAddress: 'zap-wrong-parent@example.com',
      messageId: 'm-wrong-parent',
    });
    const zapSecret = generateSecretKey();
    const zapPub = getPublicKey(zapSecret);
    await auth.createAccount({
      id: 'payer-other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      lightningAddress: 'other@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-other'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await auth.setNostrKeyIfAbsent('payer-other', {
      pubkey: zapPub,
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    await store.recordInvoiceAttempt({
      id: 'inv-wrong',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-missing',
      authorAccountId: 'acc-wrong-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'invoice comment' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-wrong',
      paymentHash: 'dd'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const zapReq = finalizeEvent(
      {
        kind: 9734,
        content: 'from other',
        created_at: 1_700_000_000,
        tags: [['p', 'aa'.repeat(32)]],
      },
      zapSecret,
    );
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-wrong',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-wrong'],
          ['description', JSON.stringify(zapReq)],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'dd'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('retries gift-reply after a lookup throw without rejecting the indexed receipt', async () => {
    let blows = true;
    class LookupBoomStore extends InMemoryMessageStore {
      override findOkInvoiceByPaymentHash(
        ...args: Parameters<InMemoryMessageStore['findOkInvoiceByPaymentHash']>
      ): ReturnType<InMemoryMessageStore['findOkInvoiceByPaymentHash']> {
        if (blows) {
          return Promise.reject(new Error('lookup boom'));
        }
        return super.findOkInvoiceByPaymentHash(...args);
      }
    }
    const store = new LookupBoomStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-lookup-parent',
      lightningAddress: 'zap-lookup-parent@example.com',
      messageId: 'm-lookup-parent',
    });
    await auth.createAccount({
      id: 'payer-lookup',
      linkingKey: null,
      role: 'basis',
      name: 'Lou',
      lightningAddress: 'lou@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-lookup'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-lookup',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-lookup',
      authorAccountId: 'acc-lookup-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'later' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-lookup',
      paymentHash: 'ee'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-lookup',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-lookup'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ee'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const ingests = await store.listZapIngests(10);
    expect(ingests[0]?.outcome).toBe('indexed');
    expect(ingests.some((row) => row.outcome === 'rejected' && row.reason === 'error')).toBe(false);
    expect(await store.listReplies(parentId)).toEqual([]);
    blows = false;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('later');
  });

  it('does not reject ingest when gift-reply lookup throws on a remembered indexed receipt', async () => {
    let giftLookupBlows = false;
    class GiftLookupBoomStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
        if (giftLookupBlows) {
          return Promise.reject(new Error('gift lookup boom'));
        }
        return super.getZapReceiptGift(...args);
      }
    }
    const store = new GiftLookupBoomStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-gift-lookup-mem',
      lightningAddress: 'zap-gift-lookup-mem@example.com',
      messageId: 'm-gift-lookup-mem',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift-lookup-mem',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-gift-lookup-mem'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c1'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.listZapIngests(10))[0]?.outcome).toBe('indexed');
    giftLookupBlows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const events = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    warn.mockRestore();
    expect(events.some((e) => e['event'] === 'nostr.zap.gift_reply.failed')).toBe(true);
    expect(events.some((e) => e['event'] === 'nostr.zap.rejected')).toBe(false);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('indexed');
    expect(ingests.some((row) => row.outcome === 'rejected' && row.reason === 'error')).toBe(false);
    expect((await store.getById(parentId))?.sats).toBe(21);
  });

  it('skips gift-reply when a remembered indexed receipt is missing', async () => {
    let hideReceipt = false;
    class HideGiftStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
        if (hideReceipt) {
          return Promise.resolve(undefined);
        }
        return super.getZapReceiptGift(...args);
      }
    }
    const store = new HideGiftStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-gift-hide',
      lightningAddress: 'zap-gift-hide@example.com',
      messageId: 'm-gift-hide',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift-hide',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-gift-hide'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c3'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    hideReceipt = true;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('indexed');
    expect(await store.listReplies('m-gift-hide')).toEqual([]);
  });

  it('does not ensure a gift-reply from an unverified remembered receipt frame', async () => {
    let giftLookups = 0;
    class CountGiftStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
        if (args[0] === 'r-gift-unverified') {
          giftLookups += 1;
        }
        return super.getZapReceiptGift(...args);
      }
    }
    const store = new CountGiftStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-gift-unverified',
      lightningAddress: 'zap-gift-unverified@example.com',
      messageId: 'm-gift-unverified',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-gift-unverified',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-gift-unverified'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c5'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    const lookupsAfterIndex = giftLookups;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      verifyReceipt: () => false,
    });
    expect(giftLookups).toBe(lookupsAfterIndex);
    const ingests = await store.listZapIngests(10);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.outcome).toBe('indexed');
  });

  it('relinks a gift reply with a deterministic id when the receipt update throws', async () => {
    let linkBlows = true;
    class LinkBoomStore extends InMemoryMessageStore {
      override updateZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['updateZapReceiptGift']> {
        if (linkBlows && args[1].giftReplyId !== undefined) {
          return Promise.reject(new Error('link boom'));
        }
        return super.updateZapReceiptGift(...args);
      }
    }
    const store = new LinkBoomStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-link-parent',
      lightningAddress: 'zap-link-parent@example.com',
      messageId: 'm-link-parent',
    });
    await auth.createAccount({
      id: 'payer-link',
      linkingKey: null,
      role: 'basis',
      name: 'Lia',
      lightningAddress: 'lia@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-link'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-link',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-link',
      authorAccountId: 'acc-link-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'once' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-link',
      paymentHash: '11'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-link',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-link'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listReplies(parentId)).toHaveLength(1);
    expect((await store.getZapReceiptGift('r-link'))?.giftReplyId).toBeNull();
    linkBlows = false;
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();
    const replies = await store.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect((await store.getZapReceiptGift('r-link'))?.giftReplyId).toBe(replies[0]?.id);
  });

  it('clears a pre-resolved account payer on a re-delivered receipt after its parent is hidden', async () => {
    const fixture = await memberGiftRetryFixture(
      'region1-hidden-redeliver',
      '8f27c34ad1906be5427a8190fc63de8ba4510d73e92f674cb8a13605ed49fa21',
    );
    const create = vi.spyOn(fixture.store, 'create');

    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(await fixture.store.getZapReceiptGift(fixture.receiptId)).toMatchObject({
      payerAccountId: fixture.payerId,
      giftReplyId: null,
    });
    const createsForParent = create.mock.calls.filter(
      ([row]) => row.parentId === fixture.parentId,
    ).length;
    expect(createsForParent).toBeGreaterThan(0);

    await fixture.store.markDeleted(fixture.parentId, new Date(2), fixture.payerId);
    await seedStore({
      store: fixture.store,
      auth: fixture.auth,
      accountId: 'region1-hidden-redeliver-keepalive',
      lightningAddress: 'region1-hidden-redeliver-keepalive@example.com',
      messageId: 'region1-hidden-redeliver-keepalive-parent',
      eventId: 'd3a86104bc7f9e254190a3f76d8cb5201e649af782c3156db9470e2af53c6819',
    });
    fixture.store.failGiftLinks = false;

    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect((await fixture.store.getZapReceiptGift(fixture.receiptId))?.payerAccountId).toBeNull();
    expect((await fixture.store.getZapReceiptGift(fixture.receiptId))?.giftReplyId).toBeNull();
    expect(create.mock.calls.filter(([row]) => row.parentId === fixture.parentId)).toHaveLength(
      createsForParent,
    );
  });

  it('clears a pre-resolved account payer after its parent is hidden', async () => {
    const fixture = await memberGiftRetryFixture('account-hidden-retry', 'b1'.repeat(32));
    const create = vi.spyOn(fixture.store, 'create');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await fixture.store.getZapReceiptGift(fixture.receiptId)).toMatchObject({
      payerAccountId: fixture.payerId,
      giftReplyId: null,
    });
    const replyCreatesAfterFirstIngest = create.mock.calls.filter(
      ([row]) => row.parentId === fixture.parentId,
    ).length;
    await fixture.store.markDeleted(fixture.parentId, new Date(2), fixture.payerId);
    fixture.store.failGiftLinks = false;

    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();

    expect((await fixture.store.getZapReceiptGift(fixture.receiptId))?.payerAccountId).toBeNull();
    expect(create.mock.calls.filter(([row]) => row.parentId === fixture.parentId)).toHaveLength(
      replyCreatesAfterFirstIngest,
    );
  });

  it('clears a pre-resolved account payer when the account disappears before retry', async () => {
    const fixture = await memberGiftRetryFixture('account-missing-retry', 'b2'.repeat(32));
    const create = vi.spyOn(fixture.store, 'create');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await fixture.store.getZapReceiptGift(fixture.receiptId)).toMatchObject({
      payerAccountId: fixture.payerId,
      giftReplyId: null,
    });
    const replyCreatesAfterFirstIngest = create.mock.calls.filter(
      ([row]) => row.parentId === fixture.parentId,
    ).length;
    await fixture.auth.deleteAccount(fixture.payerId);
    fixture.store.failGiftLinks = false;

    await ingest({
      store: fixture.store,
      auth: fixture.auth,
      querier: fixture.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();

    expect((await fixture.store.getZapReceiptGift(fixture.receiptId))?.payerAccountId).toBeNull();
    expect(create.mock.calls.filter(([row]) => row.parentId === fixture.parentId)).toHaveLength(
      replyCreatesAfterFirstIngest,
    );
  });

  it('clears a pre-resolved external payer when the pubkey is blocked before retry', async () => {
    class ExternalCreateFailureStore extends InMemoryMessageStore {
      failExternalCreates = true;

      override create(
        ...args: Parameters<InMemoryMessageStore['create']>
      ): ReturnType<InMemoryMessageStore['create']> {
        if (this.failExternalCreates && args[0].accountId === null && args[0].parentId !== null) {
          return Promise.reject(new Error('external create failed'));
        }
        return super.create(...args);
      }
    }
    const store = new ExternalCreateFailureStore();
    const scenario = await externalGiftRetryFixture(
      store,
      'external-blocked-retry',
      'b3'.repeat(32),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.getZapReceiptGift(scenario.fixture.receipt.id)).toMatchObject({
      payerPubkey: scenario.fixture.pubkey,
      zapRequestId: scenario.fixture.requestId,
      giftReplyId: null,
    });
    expect(await store.listReplies(scenario.parentId)).toEqual([]);
    await store.blockPubkeyAndHideRows(
      scenario.fixture.pubkey,
      new Date(2),
      'retry-staff',
      'blocked-reply',
    );
    store.failExternalCreates = false;

    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();

    expect((await store.getZapReceiptGift(scenario.fixture.receipt.id))?.payerPubkey).toBeNull();
    expect(await store.listReplies(scenario.parentId)).toEqual([]);
  });

  it('clears a pre-resolved external payer on a re-delivered receipt after its parent is hidden', async () => {
    const store = new GiftLinkFailureStore();
    const scenario = await externalGiftRetryFixture(
      store,
      'region2-hidden-redeliver',
      'd13c6f36d3c66a9cc5a56b7e3d26260b8132db94de72050be92900702e2b6dd3',
    );
    const create = vi.spyOn(store, 'create');

    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect(await store.getZapReceiptGift(scenario.fixture.receipt.id)).toMatchObject({
      payerPubkey: scenario.fixture.pubkey,
      giftReplyId: null,
    });
    const replyCreatesAfterFirstIngest = create.mock.calls.filter(
      ([row]) => row.parentId === scenario.parentId,
    ).length;
    expect(replyCreatesAfterFirstIngest).toBeGreaterThan(0);

    await store.markDeleted(scenario.parentId, new Date(2), 'region2-hidden-redeliver-mod');
    await seedStore({
      store,
      auth: scenario.auth,
      accountId: 'region2-hidden-redeliver-keepalive',
      lightningAddress: 'region2-hidden-redeliver-keepalive@example.com',
      messageId: 'region2-hidden-redeliver-keepalive-parent',
      eventId: '79af968c8597d4bdc1937ab33a68ec5b317f0d3140862f390519380aad6dc55f',
    });
    store.failGiftLinks = false;

    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });

    expect((await store.getZapReceiptGift(scenario.fixture.receipt.id))?.payerPubkey).toBeNull();
    expect((await store.getZapReceiptGift(scenario.fixture.receipt.id))?.giftReplyId).toBeNull();
    expect(create.mock.calls.filter(([row]) => row.parentId === scenario.parentId)).toHaveLength(
      replyCreatesAfterFirstIngest,
    );
  });

  it('clears a pre-resolved external payer after its parent is hidden', async () => {
    const store = new GiftLinkFailureStore();
    const scenario = await externalGiftRetryFixture(
      store,
      'external-hidden-retry',
      'b4'.repeat(32),
    );
    const create = vi.spyOn(store, 'create');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.getZapReceiptGift(scenario.fixture.receipt.id)).toMatchObject({
      payerPubkey: scenario.fixture.pubkey,
      giftReplyId: null,
    });
    const replyCreatesAfterFirstIngest = create.mock.calls.filter(
      ([row]) => row.parentId === scenario.parentId,
    ).length;
    await store.markDeleted(scenario.parentId, new Date(2), 'retry-moderator');
    store.failGiftLinks = false;

    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();

    expect((await store.getZapReceiptGift(scenario.fixture.receipt.id))?.payerPubkey).toBeNull();
    expect(create.mock.calls.filter(([row]) => row.parentId === scenario.parentId)).toHaveLength(
      replyCreatesAfterFirstIngest,
    );
  });

  it('relinks a pre-resolved external gift reply after its first link write fails', async () => {
    const store = new GiftLinkFailureStore();
    const scenario = await externalGiftRetryFixture(store, 'external-link-retry', 'b5'.repeat(32));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.getZapReceiptGift(scenario.fixture.receipt.id)).toMatchObject({
      payerPubkey: scenario.fixture.pubkey,
      zapRequestId: scenario.fixture.requestId,
      giftReplyId: null,
    });
    expect(await store.listReplies(scenario.parentId)).toHaveLength(1);
    store.failGiftLinks = false;

    await ingest({
      store,
      auth: scenario.auth,
      querier: scenario.querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1_700_000_200_000,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    warn.mockRestore();

    const replies = await store.listReplies(scenario.parentId);
    expect(replies).toHaveLength(1);
    expect((await store.getZapReceiptGift(scenario.fixture.receipt.id))?.giftReplyId).toBe(
      replies[0]?.id,
    );
  });

  it('skips gift-reply insert when the receipt vanishes after the payer link', async () => {
    let giftGets = 0;
    class VanishReceiptStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
        // The manual-settle guard also looks up its own receipt id; count only the real one.
        if (args[0] !== 'r-vanish') {
          return super.getZapReceiptGift(...args);
        }
        giftGets += 1;
        if (giftGets >= 2) {
          return Promise.resolve(undefined);
        }
        return super.getZapReceiptGift(...args);
      }
    }
    const store = new VanishReceiptStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-vanish-parent',
      lightningAddress: 'zap-vanish-parent@example.com',
      messageId: 'm-vanish-parent',
    });
    await auth.createAccount({
      id: 'payer-vanish',
      linkingKey: null,
      role: 'basis',
      name: 'Val',
      lightningAddress: 'val@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-vanish'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-vanish',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-vanish',
      authorAccountId: 'acc-vanish-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: '' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-vanish',
      paymentHash: '22'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-vanish',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-vanish'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '22'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listReplies(parentId)).toHaveLength(0);
  });

  it('skips gift-reply insert when giftReplyId is already set', async () => {
    let giftGets = 0;
    class LinkedReceiptStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
        // The manual-settle guard also looks up its own receipt id; count only the real one.
        if (args[0] !== 'r-linked') {
          return super.getZapReceiptGift(...args);
        }
        giftGets += 1;
        return super.getZapReceiptGift(...args).then((row) => {
          if (giftGets >= 2 && row !== undefined) {
            return { ...row, giftReplyId: 'already-linked' };
          }
          return row;
        });
      }
    }
    const store = new LinkedReceiptStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-linked-parent',
      lightningAddress: 'zap-linked-parent@example.com',
      messageId: 'm-linked-parent',
    });
    await auth.createAccount({
      id: 'payer-linked',
      linkingKey: null,
      role: 'basis',
      name: 'Lee',
      lightningAddress: 'lee@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-linked'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-linked',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-linked',
      authorAccountId: 'acc-linked-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: '' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-linked',
      paymentHash: '33'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-linked',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-linked'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '33'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listReplies(parentId)).toHaveLength(0);
  });

  it('drops a gift receipt when the parent row is gone', async () => {
    class MissingParentStore extends InMemoryMessageStore {
      override getById(): ReturnType<InMemoryMessageStore['getById']> {
        return Promise.resolve(undefined);
      }
    }
    const store = new MissingParentStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-missing-parent',
      lightningAddress: 'zap-missing-parent@example.com',
      messageId: 'm-missing-parent',
    });
    await auth.createAccount({
      id: 'payer-missing-parent',
      linkingKey: null,
      role: 'basis',
      name: 'Mo',
      lightningAddress: 'mo@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-missing-parent'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-missing-parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-missing-parent',
      authorAccountId: 'acc-missing-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'gone' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-missing-parent',
      paymentHash: '22'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-missing-parent',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-missing-parent'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '22'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getZapReceiptGift('r-missing-parent'))?.payerAccountId).toBeNull();
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('does not insert a gift-reply when the parent is soft-deleted on first ingest', async () => {
    const deletedAt = new Date('2026-09-01T00:00:00.000Z');
    const payerClears: string[] = [];
    class DeletedParentStore extends InMemoryMessageStore {
      override getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        return super.getById(id).then((row): MessageRow | undefined => {
          if (row === undefined) {
            return undefined;
          }
          return { ...row, deletedAt };
        });
      }

      override updateZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['updateZapReceiptGift']> {
        if (args[1].payerAccountId === null) {
          payerClears.push(args[0]);
        }
        return super.updateZapReceiptGift(...args);
      }
    }
    const store = new DeletedParentStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-deleted-parent',
      lightningAddress: 'zap-deleted-parent@example.com',
      messageId: 'm-deleted-parent',
    });
    await auth.createAccount({
      id: 'payer-deleted-parent',
      linkingKey: null,
      role: 'basis',
      name: 'Del',
      lightningAddress: 'del@example.com',
      lightningAddressVerified: true,
      location: null,
      forumLawsDismissed: false,
      viewKey: viewKeyFor('payer-deleted-parent'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-deleted-parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: parentId,
      payerAccountId: 'payer-deleted-parent',
      authorAccountId: 'acc-deleted-parent',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'hidden parent' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-deleted-parent',
      paymentHash: 'c2'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-deleted-parent',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-deleted-parent'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c2'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(payerClears).toEqual(['r-deleted-parent']);
    expect((await store.getZapReceiptGift('r-deleted-parent'))?.payerAccountId).toBeNull();
    expect(await store.listReplies(parentId)).toEqual([]);
  });

  it('retries without a bolt11 tag and when decodeBolt11 returns null', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const parentId = await seedStore({
      store,
      auth,
      accountId: 'acc-nobolt-parent',
      lightningAddress: 'zap-nobolt-parent@example.com',
      messageId: 'm-nobolt-parent',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-nobolt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-nobolt'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ab'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.getById(parentId))?.sats).toBe(21);
    querier.events = [
      {
        id: 'r-nobolt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [['e', NOTE_EVENT_ID]],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    querier.events = [
      {
        id: 'r-nobolt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-nobolt'],
        ],
      },
    ];
    mockedDecode.mockReturnValue(null);
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect(await store.listReplies(parentId)).toEqual([]);
  });
});

describe('conversation zap ingest', () => {
  it('rejects a conversation receipt whose payment hash was manually settled', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'manual-author',
      messageId: 'manual-message',
      lightningAddress: 'settled-pn@example.com',
    });
    const paymentHash = '2c'.repeat(32);
    await seedManualInvoice(store, paymentHash);
    expect(
      (
        await settleInvoiceManually({
          store,
          auth,
          now: () => 1,
          paymentHash,
          note: 'wallet evidence',
        })
      ).ok,
    ).toBe(true);

    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'manual-payer',
      'manual-author',
      new Date('2026-09-18T12:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'settled-conversation-invoice',
      createdAt: new Date('2026-09-18T12:00:00.000Z'),
      messageId: 'manual-message',
      payerAccountId: 'manual-payer',
      authorAccountId: 'manual-author',
      amountSats: 210_000,
      lightningAddress: 'settled-pn@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-settled-pn',
      paymentHash,
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: '29292929-2929-4929-8929-292929292929',
    });
    mockedDecode.mockReturnValue({ paymentHash, amountMsat: 210_000_000 });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'settled-conversation-receipt',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-settled-pn'],
        ],
      },
    ];
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 2,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });

    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
    expect((await store.getById('manual-message'))?.sats).toBe(210_000);
    expect(
      (await store.listZapIngests(10)).some(
        (row) =>
          row.receiptId === 'settled-conversation-receipt' &&
          row.outcome === 'rejected' &&
          row.reason === 'settled',
      ),
    ).toBe(true);
  });

  it('appends a PN gift and does not credit the profile note', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-recv',
      lightningAddress: 'recv@example.com',
      messageId: 'm-pn-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-pay',
      'acc-pn-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await store.recordInvoiceAttempt({
      id: 'inv-pn',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-pay',
      authorAccountId: 'acc-pn-recv',
      amountSats: 21,
      lightningAddress: 'recv@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn',
      paymentHash: 'ab'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ab'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    expect((await store.getById(profileId))?.sats).toBe(0);
    expect(await store.listReplies(profileId)).toEqual([]);
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(giftId);
    expect(rows[0]?.text).toBe('thanks');
    expect(rows[0]?.sats).toBe(21);
    expect(rows[0]?.nostrPublishState).toBe('pending');
  });

  it('indexes an already-inserted PN gift on a second tick without rejecting', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-recv2',
      lightningAddress: 'recv2@example.com',
      messageId: 'm-pn-profile-2',
    });
    await auth.createAccount({
      id: 'acc-pn-pay2',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat2@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-pay2'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-pay2',
      'acc-pn-recv2',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await store.recordInvoiceAttempt({
      id: 'inv-pn-2',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-pay2',
      authorAccountId: 'acc-pn-recv2',
      amountSats: 21,
      lightningAddress: 'recv2@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-2',
      paymentHash: 'ac'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-2',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-2'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ac'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      warn.mockClear();
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const rows = await conversations.listMessages(thread.id, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(giftId);
      expect(
        (await store.listZapIngests(10)).some(
          (row) => row.receiptId === 'r-pn-2' && row.outcome === 'indexed',
        ),
      ).toBe(true);
      expect(loggedEvents(warn).some((event) => event['event'] === 'nostr.zap.rejected')).toBe(
        false,
      );
      expect((await store.listLatest(10)).some((row) => row.eventId === NOTE_EVENT_ID)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('indexes a pre-existing PN gift on a cold ingest without claiming', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-recv-cold',
      lightningAddress: 'recv-cold@example.com',
      messageId: 'm-pn-profile-cold',
    });
    await auth.createAccount({
      id: 'acc-pn-pay-cold',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-cold@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-pay-cold'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-pay-cold',
      'acc-pn-recv-cold',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = '99999999-9999-4999-8999-999999999999';
    await conversations.appendMessage({
      id: giftId,
      conversationId: thread.id,
      text: 'thanks',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      senderAccountId: 'acc-pn-pay-cold',
      senderPubkey: null,
      name: 'Pat',
      ...unsignedConversationDefaults(),
      sats: 21,
    });
    await store.recordInvoiceAttempt({
      id: 'inv-pn-cold',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-pay-cold',
      authorAccountId: 'acc-pn-recv-cold',
      amountSats: 21,
      lightningAddress: 'recv-cold@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-cold',
      paymentHash: 'b2'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-cold',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-cold'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'b2'.repeat(32), amountMsat: 21_000 });
    const claim = vi.spyOn(store, 'claimZapPayment');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const rows = await conversations.listMessages(thread.id, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(giftId);
      expect(
        (await store.listZapIngests(10)).some(
          (row) => row.receiptId === 'r-pn-cold' && row.outcome === 'indexed',
        ),
      ).toBe(true);
      expect(loggedEvents(warn).some((event) => event['event'] === 'nostr.zap.rejected')).toBe(
        false,
      );
      expect(claim).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      claim.mockRestore();
    }
  });

  it('does not query relays for a conversation e-tag whose PN gift already exists', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-recv3',
      lightningAddress: 'recv3@example.com',
      messageId: 'm-pn-profile-3',
    });
    await auth.createAccount({
      id: 'acc-pn-pay3',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat3@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-pay3'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-pay3',
      'acc-pn-recv3',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const conversationEventId = 'cd'.repeat(32);
    await store.recordInvoiceAttempt({
      id: 'inv-pn-3',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-pay3',
      authorAccountId: 'acc-pn-recv3',
      amountSats: 21,
      lightningAddress: 'recv3@example.com',
      zapRequest: { tags: [['e', conversationEventId]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-3',
      paymentHash: 'ad'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    await conversations.appendMessage({
      id: giftId,
      conversationId: thread.id,
      text: 'thanks',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      senderAccountId: 'acc-pn-pay3',
      senderPubkey: null,
      name: 'Pat',
      ...unsignedConversationDefaults(),
      sats: 21,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-3',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', conversationEventId],
          ['bolt11', 'lnbc-pn-3'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ad'.repeat(32), amountMsat: 21_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      expect(
        querier.calls.some(
          (call) =>
            Array.isArray(call.filter['#e']) &&
            (call.filter['#e'] as string[]).includes(conversationEventId),
        ),
      ).toBe(false);
      expect(loggedEvents(warn).some((event) => event['event'] === 'nostr.zap.rejected')).toBe(
        false,
      );
      expect(await conversations.listMessages(thread.id, 10)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('queries a shared PN e-tag when only the first invoice gift exists', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-shared-recv',
      eventId: null,
      lightningAddress: 'shared-recv@example.com',
      messageId: 'm-pn-shared-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-shared-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'shared-pay@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-shared-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-shared-pay',
      'acc-pn-shared-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const firstGiftId = '12121212-1212-4121-8121-121212121212';
    const secondGiftId = '34343434-3434-4343-8343-343434343434';
    const sharedEventId = 'bc'.repeat(32);
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-pn-shared-first',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-shared-pay',
      authorAccountId: 'acc-pn-shared-recv',
      amountSats: 21,
      lightningAddress: 'shared-recv@example.com',
      zapRequest: { tags: [['e', sharedEventId]], content: 'first gift' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-shared-first',
      paymentHash: 'c1'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: firstGiftId,
    };
    await store.recordInvoiceAttempt(invoice);
    await store.recordInvoiceAttempt({
      ...invoice,
      id: 'inv-pn-shared-second',
      createdAt: new Date('2026-08-28T00:00:01.000Z'),
      zapRequest: { tags: [['e', sharedEventId]], content: 'second gift' },
      pr: 'lnbc-pn-shared-second',
      paymentHash: 'c2'.repeat(32),
      conversationMessageId: secondGiftId,
    });
    await conversations.appendMessage({
      id: firstGiftId,
      conversationId: thread.id,
      text: 'first gift',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      senderAccountId: 'acc-pn-shared-pay',
      senderPubkey: null,
      name: 'Pat',
      ...unsignedConversationDefaults(),
      sats: 21,
    });
    const append = vi.spyOn(conversations, 'appendMessage');
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-shared-second',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', sharedEventId],
          ['bolt11', 'lnbc-pn-shared-second'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'c2'.repeat(32), amountMsat: 21_000 });

    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });

    expect(
      querier.calls.some(
        (call) =>
          Array.isArray(call.filter['#e']) &&
          (call.filter['#e'] as string[]).includes(sharedEventId),
      ),
    ).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ id: secondGiftId }));
    expect((await conversations.listMessages(thread.id, 10)).map((row) => row.id)).toEqual([
      firstGiftId,
      secondGiftId,
    ]);
    append.mockRestore();
  });

  it('logs allowlisted catch fields without the error message', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-catch-recv',
      lightningAddress: 'catch-recv@example.com',
      messageId: 'm-pn-catch-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-catch-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'catch-pay@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-catch-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-catch-pay',
      'acc-pn-catch-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await store.recordInvoiceAttempt({
      id: 'inv-pn-catch-dup',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-catch-pay',
      authorAccountId: 'acc-pn-catch-recv',
      amountSats: 21,
      lightningAddress: 'catch-recv@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-catch-dup',
      paymentHash: 'ae'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-catch-dup',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-catch-dup'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'ae'.repeat(32), amountMsat: 21_000 });
    const claim = vi.spyOn(store, 'claimZapPayment').mockRejectedValueOnce(
      Object.assign(new Error('invalid input syntax for type uuid: "secret-value"'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '23505',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const event = loggedEvents(warn).find((row) => row['event'] === 'nostr.zap.rejected');
      expect(event).toEqual(
        expect.objectContaining({
          event: 'nostr.zap.rejected',
          reason: 'error',
          name: 'Error',
          code: 'ERR_POSTGRES_SERVER_ERROR',
          errno: '23505',
        }),
      );
      expect(event).not.toHaveProperty('error');
      expect(warn.mock.calls.flat().join('\n')).not.toContain('secret-value');
    } finally {
      warn.mockRestore();
      claim.mockRestore();
    }
  });

  it('logs only the reason for primitive and null catches', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-catch-recv2',
      lightningAddress: 'catch-recv2@example.com',
      messageId: 'm-pn-catch-profile-2',
    });
    await auth.createAccount({
      id: 'acc-pn-catch-pay2',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'catch-pay2@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-catch-pay2'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-catch-pay2',
      'acc-pn-catch-recv2',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await store.recordInvoiceAttempt({
      id: 'inv-pn-catch-plain',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-catch-pay2',
      authorAccountId: 'acc-pn-catch-recv2',
      amountSats: 21,
      lightningAddress: 'catch-recv2@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-catch-plain',
      paymentHash: 'af'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-catch-plain',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-catch-plain'],
        ],
      },
      {
        id: 'r-pn-catch-null',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-catch-plain'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'af'.repeat(32), amountMsat: 21_000 });
    const claim = vi
      .spyOn(store, 'claimZapPayment')
      .mockRejectedValueOnce('plain')
      .mockRejectedValueOnce(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const events = loggedEvents(warn).filter((row) => row['event'] === 'nostr.zap.rejected');
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event?.['reason']).toBe('error');
        expect(event).not.toHaveProperty('name');
        expect(event).not.toHaveProperty('error');
        expect(event).not.toHaveProperty('code');
        expect(event).not.toHaveProperty('errno');
      }
    } finally {
      warn.mockRestore();
      claim.mockRestore();
    }
  });

  it('omits catch fields outside the allowlist', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-catch-recv3',
      lightningAddress: 'catch-recv3@example.com',
      messageId: 'm-pn-catch-profile-3',
    });
    await auth.createAccount({
      id: 'acc-pn-catch-pay3',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'catch-pay3@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-catch-pay3'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-catch-pay3',
      'acc-pn-catch-recv3',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await store.recordInvoiceAttempt({
      id: 'inv-pn-catch-trunc',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-catch-pay3',
      authorAccountId: 'acc-pn-catch-recv3',
      amountSats: 21,
      lightningAddress: 'catch-recv3@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-catch-trunc',
      paymentHash: 'b0'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-catch-trunc',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-catch-trunc'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'b0'.repeat(32), amountMsat: 21_000 });
    const rejected = Object.assign(new Error('do not log me'), {
      name: 'Postgres-Error',
      code: 'BAD CODE',
      errno: 23505,
    });
    const claim = vi.spyOn(store, 'claimZapPayment').mockRejectedValueOnce(rejected);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const event = loggedEvents(warn).find((row) => row['event'] === 'nostr.zap.rejected');
      expect(event?.['reason']).toBe('error');
      expect(event).not.toHaveProperty('name');
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('code');
      expect(event).not.toHaveProperty('errno');
    } finally {
      warn.mockRestore();
      claim.mockRestore();
    }
  });

  it('omits non-string code and disallowed errno while retaining a safe name', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-catch-recv4',
      lightningAddress: 'catch-recv4@example.com',
      messageId: 'm-pn-catch-profile-4',
    });
    await auth.createAccount({
      id: 'acc-pn-catch-pay4',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'catch-pay4@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-catch-pay4'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-catch-pay4',
      'acc-pn-catch-recv4',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    const giftId = '10101010-1010-4101-8101-101010101010';
    await store.recordInvoiceAttempt({
      id: 'inv-pn-catch-empty',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-catch-pay4',
      authorAccountId: 'acc-pn-catch-recv4',
      amountSats: 21,
      lightningAddress: 'catch-recv4@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-catch-empty',
      paymentHash: 'b1'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: giftId,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-catch-empty',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-catch-empty'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: 'b1'.repeat(32), amountMsat: 21_000 });
    const claim = vi.spyOn(store, 'claimZapPayment').mockRejectedValueOnce(
      Object.assign(new Error('do not log me either'), {
        name: 'PostgresError',
        code: 23505,
        errno: 'BAD-ERRNO',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingest({
        store,
        auth,
        querier,
        urls: URLS,
        timeoutMs: 50,
        now: () => Date.parse('2026-08-28T00:00:00.000Z'),
        fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
        conversations,
      });
      const event = loggedEvents(warn).find((row) => row['event'] === 'nostr.zap.rejected');
      expect(event?.['reason']).toBe('error');
      expect(event?.['name']).toBe('PostgresError');
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('code');
      expect(event).not.toHaveProperty('errno');
    } finally {
      warn.mockRestore();
      claim.mockRestore();
    }
  });

  it('appends a gift-only PN row for a nameless payer', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-anon-recv',
      lightningAddress: 'anon-recv@example.com',
      messageId: 'm-pn-anon-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-anon-pay',
      linkingKey: null,
      role: 'basis',
      name: '',
      lightningAddress: 'anon-pay@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-anon-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    await ensureAccountNostrKey(auth, 'acc-pn-anon-pay', parseNostrKek('11'.repeat(32)));
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-anon-pay',
      'acc-pn-anon-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-anon',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-anon-pay',
      authorAccountId: 'acc-pn-anon-recv',
      amountSats: 21,
      lightningAddress: 'anon-recv@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]] },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-anon',
      paymentHash: '33'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-anon',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-anon'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '33'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('');
    expect(rows[0]?.nostrPublishState).toBe('skipped');
    expect(rows[0]?.name.length).toBeGreaterThan(0);
    expect(rows[0]?.senderPubkey).not.toBeNull();
  });

  it('appends a PN gift when the payer account is missing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-gone-recv',
      lightningAddress: 'gone-recv@example.com',
      messageId: 'm-pn-gone-profile',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-gone-pay',
      'acc-pn-gone-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-gone',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-gone-pay',
      authorAccountId: 'acc-pn-gone-recv',
      amountSats: 21,
      lightningAddress: 'gone-recv@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]] },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-gone',
      paymentHash: '44'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-gone',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-gone'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '44'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderPubkey).toBeNull();
  });

  it('queries a conversation invoice e-tag when listLatest has no signed notes', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await seedStore({
      store,
      auth,
      accountId: 'acc-pn-unsigned',
      eventId: null,
      lightningAddress: 'unsigned-pn@example.com',
      messageId: 'm-pn-unsigned',
    });
    await store.recordInvoiceAttempt({
      id: 'inv-pn-e',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: 'm-pn-unsigned',
      payerAccountId: 'acc-pn-unsigned',
      authorAccountId: 'acc-pn-unsigned',
      amountSats: 21,
      lightningAddress: 'unsigned-pn@example.com',
      zapRequest: { tags: [['e', 'ff'.repeat(32)]] },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-e',
      paymentHash: 'cd'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      conversationMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const querier = new RecordingQuerier();
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: failFetch(),
    });
    expect(querier.calls.length).toBeGreaterThan(0);
    const filter = querier.calls[0]?.filter as { '#e'?: string[] };
    expect(filter['#e']).toContain('ff'.repeat(32));
  });

  it('rejects a conversation invoice when the PN store is omitted', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-omit',
      lightningAddress: 'omit@example.com',
      messageId: 'm-pn-omit',
    });
    await store.recordInvoiceAttempt({
      id: 'inv-pn-omit',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-omit',
      authorAccountId: 'acc-pn-omit',
      amountSats: 21,
      lightningAddress: 'omit@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]] },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-omit',
      paymentHash: '11'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      conversationMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-omit',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-omit'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => 1,
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
    });
    expect((await store.listZapIngests(10))[0]?.reason).toBe('conversation');
    expect((await store.getById(profileId))?.sats).toBe(0);
  });

  it('skips gift-reply on a remembered conversation invoice', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-mem',
      lightningAddress: 'mem@example.com',
      messageId: 'm-pn-mem',
    });
    await auth.createAccount({
      id: 'acc-pn-mem-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-mem-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-mem-pay',
      'acc-pn-mem',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-mem',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-mem-pay',
      authorAccountId: 'acc-pn-mem',
      amountSats: 21,
      lightningAddress: 'mem@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'later' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-mem',
      paymentHash: '22'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-mem',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-mem'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '22'.repeat(32), amountMsat: 21_000 });
    const args = {
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    };
    await ingest(args);
    await ingest(args);
    expect(await store.listReplies(profileId)).toEqual([]);
    expect(await conversations.listMessages(thread.id, 10)).toHaveLength(1);
  });

  it('rejects a conversation gift when the receipt pubkey does not match', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-pk-recv',
      lightningAddress: 'pn-pubkey@example.com',
      messageId: 'm-pn-pk-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-pk-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-pk@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-pk-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-pk-pay',
      'acc-pn-pk-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-pk',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-pk-pay',
      authorAccountId: 'acc-pn-pk-recv',
      amountSats: 21,
      lightningAddress: 'pn-pubkey@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-pk',
      paymentHash: '55'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: '55555555-5555-4555-8555-555555555555',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-pk',
        pubkey: 'bb'.repeat(32),
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-pk'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '55'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    expect((await store.listZapIngests(10))[0]?.reason).toBe('pubkey');
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
    expect((await store.getById(profileId))?.sats).toBe(0);
    expect(await store.listReplies(profileId)).toEqual([]);
  });

  it('rejects a conversation gift when the LNURL provider is unresolved', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-prov-recv',
      lightningAddress: 'pn-provider@example.com',
      messageId: 'm-pn-prov-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-prov-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-prov@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-prov-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-prov-pay',
      'acc-pn-prov-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-prov',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-prov-pay',
      authorAccountId: 'acc-pn-prov-recv',
      amountSats: 21,
      lightningAddress: 'pn-provider@example.com',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-prov',
      paymentHash: '66'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: '66666666-6666-4666-8666-666666666666',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-prov',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-prov'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '66'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: failFetch(),
      conversations,
    });
    expect((await store.listZapIngests(10))[0]?.reason).toBe('provider');
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
    expect((await store.getById(profileId))?.sats).toBe(0);
    expect(await store.listReplies(profileId)).toEqual([]);
  });

  it('rejects a conversation gift when the invoice lightning address is missing', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-addr-recv',
      lightningAddress: 'pn-addr-null@example.com',
      messageId: 'm-pn-addr-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-addr-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-addr@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-addr-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-addr-pay',
      'acc-pn-addr-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-addr',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-addr-pay',
      authorAccountId: 'acc-pn-addr-recv',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-addr',
      paymentHash: '77'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: '77777777-7777-4777-8777-777777777777',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-addr',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-addr'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '77'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    expect((await store.listZapIngests(10))[0]?.reason).toBe('address');
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
    expect((await store.getById(profileId))?.sats).toBe(0);
    expect(await store.listReplies(profileId)).toEqual([]);
  });

  it('rejects a conversation gift when the invoice lightning address is blank', async () => {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    const profileId = await seedStore({
      store,
      auth,
      accountId: 'acc-pn-blank-recv',
      lightningAddress: 'pn-addr-blank@example.com',
      messageId: 'm-pn-blank-profile',
    });
    await auth.createAccount({
      id: 'acc-pn-blank-pay',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat-blank@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: viewKeyFor('acc-pn-blank-pay'),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember(
      'acc-pn-blank-pay',
      'acc-pn-blank-recv',
      new Date('2026-08-28T00:00:00.000Z'),
    );
    await store.recordInvoiceAttempt({
      id: 'inv-pn-blank',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: profileId,
      payerAccountId: 'acc-pn-blank-pay',
      authorAccountId: 'acc-pn-blank-recv',
      amountSats: 21,
      lightningAddress: '   ',
      zapRequest: { tags: [['e', NOTE_EVENT_ID]], content: 'thanks' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc-pn-blank',
      paymentHash: '88'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: thread.id,
      conversationMessageId: '88888888-8888-4888-8888-888888888888',
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'r-pn-blank',
        pubkey: PROVIDER_PUBKEY,
        kind: 9735,
        tags: [
          ['e', NOTE_EVENT_ID],
          ['bolt11', 'lnbc-pn-blank'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '88'.repeat(32), amountMsat: 21_000 });
    await ingest({
      store,
      auth,
      querier,
      urls: URLS,
      timeoutMs: 50,
      now: () => Date.parse('2026-08-28T00:00:00.000Z'),
      fetchImpl: lnurlFetch(PROVIDER_PUBKEY),
      conversations,
    });
    expect((await store.listZapIngests(10))[0]?.reason).toBe('address');
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
    expect((await store.getById(profileId))?.sats).toBe(0);
    expect(await store.listReplies(profileId)).toEqual([]);
  });
});
