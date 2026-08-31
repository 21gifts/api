import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
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
    const store = new InMemoryMessageStore();
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
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const firstId = `${'01'.repeat(31)}00`;
    for (let i = 0; i < 21; i += 1) {
      const eventId = `${'01'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      await store.create({
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
    // Duplicate eventId covers the seen.has branch without a third query.
    await store.create({
      id: 'm-chunk-dup',
      accountId: 'acc-chunk',
      name: 'Ada',
      text: 'dup',
      createdAt: new Date(Date.UTC(2026, 7, 28, 0, 0, 22)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: firstId,
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

  it('records duplicate ingest when the same receipt is seen again', async () => {
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
    expect(ingests).toHaveLength(2);
    expect(ingests.some((row) => row.outcome === 'indexed' && row.reason === null)).toBe(true);
    expect(ingests.some((row) => row.outcome === 'rejected' && row.reason === 'duplicate')).toBe(
      true,
    );
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
        listReplies: (parentId: string, limit?: number) => base.listReplies(parentId, limit),
        listPublishedEventIds: (limit: number) => base.listPublishedEventIds(limit),
        create: (...args: Parameters<InMemoryMessageStore['create']>) => base.create(...args),
        getPhoto: (id: string) => base.getPhoto(id),
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
});
