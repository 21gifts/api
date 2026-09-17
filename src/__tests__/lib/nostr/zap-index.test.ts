import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryMessageStore, type MessageInvoiceAttempt } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import type { NostrEventFrame } from '@/lib/nostr/query';
import { RecordingQuerier } from '@/lib/nostr/query';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { indexOpenZapReceipts, indexZapReceipt } from '@/lib/nostr/zap-index';
import { InMemoryPushStore } from '@/lib/push-store';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

const mockedDecode = vi.mocked(decodeBolt11);

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
      listDebug: (limit: number) => base.listDebug(limit),
      listHidden: (limit: number) => base.listHidden(limit),
      listReplies: (parentId: string, limit?: number) => base.listReplies(parentId, limit),
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
      listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
        base.listPostsByAccount(...args),
      listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
        base.listRepliesByAccount(...args),
      getPhoto: (id: string) => base.getPhoto(id),
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
        listDebug: (limit: number) => base.listDebug(limit),
        listHidden: (limit: number) => base.listHidden(limit),
        listReplies: (parentId: string, limit?: number) => base.listReplies(parentId, limit),
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
        listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
          base.listPostsByAccount(...args),
        listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
          base.listRepliesByAccount(...args),
        getPhoto: (id: string) => base.getPhoto(id),
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
    mockedDecode.mockReturnValue({ paymentHash: '11'.repeat(32), amountMsat: 1000 });
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
            ['bolt11', 'lnbc-cache'],
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
          ['bolt11', 'lnbc-cache'],
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
        listDebug: (limit: number) => base.listDebug(limit),
        listHidden: (limit: number) => base.listHidden(limit),
        listReplies: (parentId: string, limit?: number) => base.listReplies(parentId, limit),
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
        listPostsByAccount: (...args: Parameters<InMemoryMessageStore['listPostsByAccount']>) =>
          base.listPostsByAccount(...args),
        listRepliesByAccount: (...args: Parameters<InMemoryMessageStore['listRepliesByAccount']>) =>
          base.listRepliesByAccount(...args),
        getPhoto: (id: string) => base.getPhoto(id),
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
    mockedDecode.mockReturnValue({ paymentHash: '99'.repeat(32), amountMsat: 21_000 });
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
    mockedDecode.mockReturnValue({ paymentHash: 'aa'.repeat(32), amountMsat: 21_000 });
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
        giftLookups += 1;
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

  it('skips gift-reply insert when the receipt vanishes after the payer link', async () => {
    let giftGets = 0;
    class VanishReceiptStore extends InMemoryMessageStore {
      override getZapReceiptGift(
        ...args: Parameters<InMemoryMessageStore['getZapReceiptGift']>
      ): ReturnType<InMemoryMessageStore['getZapReceiptGift']> {
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
});
