import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { RecordingQuerier } from '@/lib/nostr/query';
import { DEFAULT_RELAY_PUBLIC } from '@/lib/nostr/relays';
import { runNostrWorkerTick, startNostrWorker, type NostrWorkerDeps } from '@/lib/nostr/worker';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

const mockedDecode = vi.mocked(decodeBolt11);

const KEK = parseNostrKek('cd'.repeat(32));

/** Dummy fetch that never resolves LNURL metadata. */
function dummyFetch(): FetchFn {
  return async () => new Response('{}', { status: 500 });
}

/** Build worker deps with querier + fetch defaults so existing cases stay short. */
function deps(
  partial: Omit<NostrWorkerDeps, 'querier' | 'fetchImpl'> &
    Partial<Pick<NostrWorkerDeps, 'querier' | 'fetchImpl' | 'verifyReceipt'>>,
): NostrWorkerDeps {
  return {
    querier: partial.querier ?? new RecordingQuerier(),
    fetchImpl: partial.fetchImpl ?? dummyFetch(),
    ...partial,
  };
}

async function seed(): Promise<{
  auth: InMemoryAuthStore;
  messages: InMemoryMessageStore;
}> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: 1,
  });
  await ensureAccountNostrKey(auth, 'acc', KEK);
  const messages = new InMemoryMessageStore();
  await messages.create({
    id: 'm1',
    accountId: 'acc',
    name: 'Ada',
    text: 'hello',
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    ...unsignedNostrDefaults(),
  });
  return { auth, messages };
}

describe('runNostrWorkerTick', () => {
  it('re-signs pending kind:1 events that lack t=bitcoin', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello',
      tags: [
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const row = await messages.getById('m1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.eventId).not.toBe('ab'.repeat(32));
    expect(row?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('re-signs pending rows with a null stored event', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'm-null',
      accountId: 'acc',
      name: 'Ada',
      text: 'later',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
      nostrEvent: null,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m-null'))?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('re-signs a legacy note even when newer bitcoin-tagged notes are pending', async () => {
    const { auth, messages } = await seed();
    const modern = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    for (let i = 0; i < 20; i += 1) {
      const id = `n${String(i).padStart(2, '0')}`;
      await messages.create({
        id,
        accountId: 'acc',
        name: 'Ada',
        text: `n${i}`,
        createdAt: new Date(Date.parse('2026-08-27T00:00:00.000Z') + i * 1000),
        ...unsignedNostrDefaults(),
      });
      await messages.updateSignedEvent(id, `${i.toString(16).padStart(2, '0')}`.repeat(32), {
        kind: 1,
        content: `n${i}`,
        tags: modern,
        created_at: 1,
      });
    }
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello',
      tags: [['t', '21gifts']],
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('leaves pending kind:1 events that already have t=bitcoin', async () => {
    const { auth, messages } = await seed();
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    const eventId = 'cd'.repeat(32);
    await messages.updateSignedEvent('m1', eventId, {
      kind: 1,
      content: 'hello',
      tags,
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toBe(eventId);
  });

  it('re-signs pending rows whose stored event has no tag array', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ef'.repeat(32), { kind: 1, content: 'hello' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('signs without publishing when NOSTR_PUBLISH is off', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const row = await messages.getById('m1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.calls).toHaveLength(0);
  });

  it('publishes to space when NOSTR_PUBLISH=1', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect(publisher.calls.length).toBeGreaterThan(0);
    expect(publisher.calls[0]?.urls).toEqual(['wss://relay.nostr.space']);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
    const afterFirst = publisher.calls.length;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    expect(publisher.calls.length).toBe(afterFirst);
  });

  it('marks published when public ACK is present', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('parks when public relays are on but only space ACKs', async () => {
    const { auth, messages } = await seed();
    const space = 'wss://relay.nostr.space';
    const publisher: RecordingPublisher = new RecordingPublisher();
    publisher.publish = async (event, urls, _timeoutMs) => {
      publisher.calls.push({ event, urls });
      return Promise.resolve(urls.map((url) => ({ url, ok: url === space })));
    };
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
  });

  it('bumps created_at when two notes collide on event id', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'm2',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const first = await messages.getById('m1');
    const second = await messages.getById('m2');
    expect(first?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).not.toBe(first?.eventId);
  });

  it('stops signing after two event-id collisions', async () => {
    const { auth, messages } = await seed();
    messages.updateSignedEvent = async (): Promise<boolean> => false;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toBeNull();
  });

  it('logs nack when space rejects', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('logs nack when publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async () => {
      throw new Error('ws down');
    };
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('backfills a missing key with a valid KEK', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc2',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages: new InMemoryMessageStore(),
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1,
        env: {},
      }),
    );
    expect(await auth.getNostrPublicKey('acc2')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs keygen backfill failure when the KEK is the wrong size', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages: new InMemoryMessageStore(),
        auth,
        kek: new Uint8Array(16),
        publisher: new RecordingPublisher(),
        now: () => 1,
        env: {},
      }),
    );
    expect(await auth.getNostrPublicKey('acc')).toBeUndefined();
  });

  it('indexes a valid kind:9735 onto sats when publish is off', async () => {
    const eventId = 'ab'.repeat(32);
    const providerPubkey = 'cd'.repeat(32);
    const receiptId = 'ef'.repeat(32);
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc-zap',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'worker-zap-ok@example.com',
      lightningAddressVerified: true,
      createdAt: 1,
    });
    await ensureAccountNostrKey(auth, 'acc-zap', KEK);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: 'm-zap',
      accountId: 'acc-zap',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      eventId,
      nostrEvent: {
        id: eventId,
        kind: 1,
        tags: [
          ['t', 'bitcoin'],
          ['t', '21gifts'],
          ['r', 'https://21.gifts'],
        ],
      },
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: receiptId,
        pubkey: providerPubkey,
        kind: 9735,
        tags: [
          ['e', eventId],
          ['bolt11', 'lnbc-test'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({
      paymentHash: '11'.repeat(32),
      amountMsat: 21_000,
    });
    const fetchImpl: FetchFn = async () =>
      new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: true,
          nostrPubkey: providerPubkey,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        fetchImpl,
        verifyReceipt: () => true,
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m-zap'))?.sats).toBe(21);
  });

  it('queries zap relays including public defaults when publish-public is off', async () => {
    const eventId = 'ab'.repeat(32);
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', eventId, {
      id: eventId,
      kind: 1,
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    const querier = new RecordingQuerier();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
    );
    expect(querier.calls[0]?.urls).toEqual(['wss://space', ...DEFAULT_RELAY_PUBLIC]);
  });
});

describe('startNostrWorker', () => {
  it('returns a stop handle', () => {
    const handle = startNostrWorker(
      deps({
        messages: new InMemoryMessageStore(),
        auth: new InMemoryAuthStore(),
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 0,
        env: {},
      }),
      60_000,
    );
    handle.stop();
  });
});
