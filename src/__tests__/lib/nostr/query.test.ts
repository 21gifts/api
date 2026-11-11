import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, FakeSocketFactory } from '@/__tests__/helpers/fake-relay-socket';
import { WebsocketNostrPublisher } from '@/lib/nostr/publish';
import { RecordingQuerier, WebsocketNostrQuerier } from '@/lib/nostr/query';
import { NostrRelayPool } from '@/lib/nostr/relay-pool';

describe('RecordingQuerier', () => {
  it('records calls and returns event copies', async () => {
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'e1',
        pubkey: 'pk',
        kind: 9735,
        tags: [['e', 'note']],
      },
    ];
    const filter = { kinds: [9735] };
    const urls = ['wss://a'];
    const out = await querier.query(filter, urls, 50);
    expect(querier.calls).toEqual([{ filter, urls, timeoutMs: 50 }]);
    expect(out).toEqual(querier.events);
    expect(out[0]).not.toBe(querier.events[0]);
    expect(out[0]?.tags[0]).not.toBe(querier.events[0]?.tags[0]);
  });
});

describe('WebsocketNostrQuerier', () => {
  let factory: FakeSocketFactory;
  let pool: NostrRelayPool;

  beforeEach(() => {
    factory = new FakeSocketFactory();
    pool = new NostrRelayPool({ createSocket: factory.create });
  });

  afterEach(() => {
    pool.close();
  });

  it('returns [] for a filter that cannot be serialized, without opening a socket', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    await expect(
      querier.query({ kinds: [1], since: 1n }, ['wss://a', 'wss://b'], 20),
    ).resolves.toEqual([]);
    expect(factory.sockets).toHaveLength(0);
  });

  it('returns [] for empty urls without opening a socket', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    await expect(querier.query({ kinds: [1] }, [], 20)).resolves.toEqual([]);
    expect(factory.sockets).toHaveLength(0);
  });

  it('sends REQ, collects EVENT object payloads, CLOSEs on EOSE, and keeps the socket', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    const filter = { kinds: [9735], '#e': ['note1'], limit: 200 };
    const pending = querier.query(filter, ['wss://a'], 100);
    const socket = factory.last();
    socket.emit('open');
    expect(socket.frames()[0]).toEqual(['REQ', socket.subId(), filter]);
    socket.frame('EVENT', socket.subId(), {
      id: 'evt1',
      pubkey: 'pk1',
      kind: 9735,
      tags: [['e', 'note1']],
      content: 'hello',
      created_at: 1_700_000_000,
      sig: 'ab'.repeat(32),
    });
    socket.frame('EOSE', socket.subId());
    await expect(pending).resolves.toEqual([
      {
        id: 'evt1',
        pubkey: 'pk1',
        kind: 9735,
        tags: [['e', 'note1']],
        content: 'hello',
        created_at: 1_700_000_000,
        sig: 'ab'.repeat(32),
      },
    ]);
    expect(socket.frames()).toContainEqual(['CLOSE', socket.subId()]);
    expect(socket.closed).toBe(false);
  });

  it('runs 20 queries and 20 publishes of one querier and one publisher over a single socket', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    const publisher = new WebsocketNostrPublisher(pool);
    for (let i = 0; i < 20; i += 1) {
      const pending = querier.query({ kinds: [1], limit: i }, ['wss://a'], 100);
      const socket = factory.last();
      if (i === 0) {
        socket.emit('open');
      }
      socket.frame('EVENT', socket.subId(i), { id: `e${i}`, pubkey: 'pk', kind: 1, tags: [] });
      socket.frame('EOSE', socket.subId(i));
      await expect(pending).resolves.toHaveLength(1);
      const acks = publisher.publish({ id: `p${i}`, kind: 1 }, ['wss://a'], 100);
      socket.frame('OK', `p${i}`, true);
      await expect(acks).resolves.toEqual([{ url: 'wss://a', ok: true }]);
    }
    expect(factory.sockets).toHaveLength(1);
  });

  it('returns the events delivered before a timeout', async () => {
    vi.useFakeTimers();
    try {
      const querier = new WebsocketNostrQuerier(pool);
      const pending = querier.query({ kinds: [1] }, ['wss://a'], 20);
      const socket = factory.last();
      socket.emit('open');
      socket.frame('EVENT', socket.subId(), { id: 'e', pubkey: 'p', kind: 1, tags: [] });
      vi.advanceTimersByTime(20);
      await expect(pending).resolves.toEqual([{ id: 'e', pubkey: 'p', kind: 1, tags: [] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contributes [] when the socket cannot be opened', async () => {
    factory.throwNext = true;
    const querier = new WebsocketNostrQuerier(pool);
    await expect(querier.query({ kinds: [1] }, ['wss://a'], 100)).resolves.toEqual([]);
  });

  it('returns [] when the socket drops before EOSE', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 100);
    factory.last().emit('open');
    factory.last().emit('close');
    await expect(pending).resolves.toEqual([]);
  });

  it('ignores malformed EVENT payloads', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    const pending = querier.query({ kinds: [9735] }, ['wss://a'], 100);
    const socket = factory.last();
    socket.emit('open');
    const subId = socket.subId();
    for (const payload of [
      'string-payload',
      [1, 2],
      null,
      { id: 1, pubkey: 'pk', kind: 1, tags: [] },
      { id: 'id', pubkey: 2, kind: 1, tags: [] },
      { pubkey: 'pk', kind: 1, tags: [] },
      { id: 'id', pubkey: 'pk', kind: 1 },
      { id: '', pubkey: 'pk', kind: 1, tags: [] },
      { id: 'id', pubkey: '', kind: 1, tags: [] },
      { id: 'id', pubkey: 'pk', kind: '1', tags: [] },
      { id: 'id', pubkey: 'pk', kind: 1, tags: 'no' },
      { id: 'id', pubkey: 'pk', kind: 1, tags: ['not-array'] },
      { id: 'id', pubkey: 'pk', kind: 1, tags: [[1]] },
      { id: 'good', pubkey: 'pk', kind: 9735, tags: [['e', 'note']], content: 123, sig: '' },
    ]) {
      socket.frame('EVENT', subId, payload);
    }
    socket.frame('EOSE', subId);
    await expect(pending).resolves.toEqual([
      { id: 'good', pubkey: 'pk', kind: 9735, tags: [['e', 'note']] },
    ]);
  });

  it('concatenates multiple URLs and dedups by id; the first URL wins', async () => {
    const querier = new WebsocketNostrQuerier(pool);
    const pending = querier.query({ kinds: [1] }, ['wss://a', 'wss://b'], 100);
    const [a, b] = factory.sockets as [FakeSocket, FakeSocket];
    a.emit('open');
    b.emit('open');
    const shared = { id: 'same', pubkey: 'pk', kind: 1, tags: [] as string[][] };
    b.frame('EVENT', b.subId(), { ...shared, pubkey: 'other' });
    a.frame('EVENT', a.subId(), shared);
    b.frame('EVENT', b.subId(), { id: 'other', pubkey: 'pk2', kind: 1, tags: [] });
    a.frame('EOSE', a.subId());
    b.frame('EOSE', b.subId());
    const events = await pending;
    expect(events.map((e) => e.id).sort()).toEqual(['other', 'same']);
    expect(events.find((e) => e.id === 'same')?.pubkey).toBe('pk');
  });

  it('uses the shared process pool when constructed with no args', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const socket = new FakeSocket();
    globalThis.WebSocket = class {
      constructor(_url: string) {
        return socket;
      }
    } as unknown as typeof WebSocket;
    try {
      const querier = new WebsocketNostrQuerier();
      const pending = querier.query({ kinds: [1] }, ['wss://default'], 100);
      socket.emit('open');
      socket.frame('EVENT', socket.subId(), { id: 'e', pubkey: 'p', kind: 1, tags: [] });
      socket.frame('EOSE', socket.subId());
      await expect(pending).resolves.toEqual([{ id: 'e', pubkey: 'p', kind: 1, tags: [] }]);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
