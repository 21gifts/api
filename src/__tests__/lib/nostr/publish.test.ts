import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, FakeSocketFactory } from '@/__tests__/helpers/fake-relay-socket';
import {
  normalizeSignedEvent,
  publicAcked,
  RecordingPublisher,
  spaceAcked,
  WebsocketNostrPublisher,
} from '@/lib/nostr/publish';
import { NostrRelayPool } from '@/lib/nostr/relay-pool';

describe('normalizeSignedEvent', () => {
  it('returns a shallow copy of a plain object', () => {
    const input = { id: 'abc', kind: 1 };
    const out = normalizeSignedEvent(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('parses a JSON string and a double-encoded JSON string', () => {
    const obj = { id: 'abc123', kind: 1 };
    expect(normalizeSignedEvent(JSON.stringify(obj))).toEqual(obj);
    expect(normalizeSignedEvent(JSON.stringify(JSON.stringify(obj)))).toEqual(obj);
  });

  it('returns null for invalid JSON, arrays, and primitives', () => {
    expect(normalizeSignedEvent('{not-json')).toBeNull();
    expect(normalizeSignedEvent([1, 2])).toBeNull();
    expect(normalizeSignedEvent(JSON.stringify([1, 2]))).toBeNull();
    expect(normalizeSignedEvent(42)).toBeNull();
    expect(normalizeSignedEvent(true)).toBeNull();
    expect(normalizeSignedEvent(null)).toBeNull();
    expect(normalizeSignedEvent(JSON.stringify('still-a-string'))).toBeNull();
  });
});

describe('RecordingPublisher', () => {
  it('records calls and ACKs each URL', async () => {
    const pub = new RecordingPublisher();
    const acks = await pub.publish({ id: 'e' }, ['wss://a', 'wss://b'], 5);
    expect(pub.calls).toHaveLength(1);
    expect(acks.every((ack) => ack.ok)).toBe(true);
    pub.ok = false;
    const nacks = await pub.publish({ id: 'e' }, ['wss://a'], 5);
    expect(nacks[0]?.ok).toBe(false);
  });
});

describe('ack helpers', () => {
  const space = 'wss://relay.nostr.space';
  it('detects space and public', () => {
    const acks = [
      { url: space, ok: true },
      { url: 'wss://relay.damus.io', ok: true },
    ];
    expect(spaceAcked(acks, space)).toBe(true);
    expect(publicAcked(acks, space)).toBe(true);
    expect(publicAcked([{ url: space, ok: true }], space)).toBe(false);
    expect(spaceAcked([{ url: space, ok: false }], space)).toBe(false);
  });
});

describe('WebsocketNostrPublisher', () => {
  const event = { id: 'abc123', kind: 1 };
  let factory: FakeSocketFactory;
  let pool: NostrRelayPool;

  beforeEach(() => {
    factory = new FakeSocketFactory();
    pool = new NostrRelayPool({ createSocket: factory.create });
  });

  afterEach(() => {
    pool.close();
  });

  it('is ok: false for an event that cannot be serialized, without opening a socket', async () => {
    const publisher = new WebsocketNostrPublisher(pool);
    const cyclic: Record<string, unknown> = { id: 'abc123', kind: 1 };
    cyclic['self'] = cyclic;
    await expect(publisher.publish(cyclic, ['wss://a', 'wss://b'], 20)).resolves.toEqual([
      { url: 'wss://a', ok: false },
      { url: 'wss://b', ok: false },
    ]);
    expect(factory.sockets).toHaveLength(0);
  });

  describe('deadline counted from the call across relays', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives the second relay only the time left after the first serialized', async () => {
      const publisher = new WebsocketNostrPublisher(pool);
      const calls = vi.spyOn(pool, 'publish');
      const tags = {
        toJSON: () => {
          vi.advanceTimersByTime(400);
          return [];
        },
      };
      const pending = publisher.publish(
        { id: 'abc123', kind: 1, tags },
        ['wss://a', 'wss://b'],
        1_000,
      );
      expect(calls.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ['wss://a', 1_000],
        ['wss://b', 600],
      ]);
      vi.advanceTimersByTime(1_000);
      await expect(pending).resolves.toEqual([
        { url: 'wss://a', ok: false },
        { url: 'wss://b', ok: false },
      ]);
    });

    it('counts normalization and skips the pool when no time is left', async () => {
      const publisher = new WebsocketNostrPublisher(pool);
      const calls = vi.spyOn(pool, 'publish');
      const event: Record<string, unknown> = { id: 'abc123' };
      Object.defineProperty(event, 'kind', {
        enumerable: true,
        get: () => {
          vi.advanceTimersByTime(1_000);
          return 1;
        },
      });
      await expect(publisher.publish(event, ['wss://a', 'wss://b'], 1_000)).resolves.toEqual([
        { url: 'wss://a', ok: false },
        { url: 'wss://b', ok: false },
      ]);
      expect(calls).not.toHaveBeenCalled();
      expect(factory.sockets).toHaveLength(0);
    });
  });

  it('returns [] for empty urls', async () => {
    const pub = new WebsocketNostrPublisher(pool);
    await expect(pub.publish(event, [], 20)).resolves.toEqual([]);
  });

  it('sends EVENT and maps OK true/false per URL in input order', async () => {
    const pub = new WebsocketNostrPublisher(pool);
    const pending = pub.publish(event, ['wss://a', 'wss://b'], 100);
    const [a, b] = factory.sockets as [FakeSocket, FakeSocket];
    a.emit('open');
    b.emit('open');
    expect(a.frames()).toEqual([['EVENT', event]]);
    b.frame('OK', 'abc123', false, 'blocked');
    a.frame('OK', 'abc123', true, '');
    await expect(pending).resolves.toEqual([
      { url: 'wss://a', ok: true },
      { url: 'wss://b', ok: false },
    ]);
    expect(a.closed).toBe(false);
  });

  it('normalizes a JSON-string event before sending', async () => {
    const pub = new WebsocketNostrPublisher(pool);
    const pending = pub.publish(
      JSON.stringify(event) as unknown as Record<string, unknown>,
      ['wss://a'],
      100,
    );
    const socket = factory.last();
    socket.emit('open');
    expect(socket.frames()).toEqual([['EVENT', event]]);
    socket.frame('OK', 'abc123', true);
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: true }]);
  });

  it('fails every URL without a socket when the event is not usable', async () => {
    const pub = new WebsocketNostrPublisher(pool);
    await expect(
      pub.publish('{bad' as unknown as Record<string, unknown>, ['wss://a', 'wss://b'], 100),
    ).resolves.toEqual([
      { url: 'wss://a', ok: false },
      { url: 'wss://b', ok: false },
    ]);
    expect(factory.sockets).toHaveLength(0);
  });

  it('is ok: false on drop, on timeout, and when the socket cannot open', async () => {
    vi.useFakeTimers();
    try {
      const pub = new WebsocketNostrPublisher(pool);
      const dropped = pub.publish(event, ['wss://a'], 100);
      factory.last().emit('open');
      factory.last().emit('close');
      await expect(dropped).resolves.toEqual([{ url: 'wss://a', ok: false }]);
      const timedOut = pub.publish(event, ['wss://b'], 100);
      factory.last().emit('open');
      vi.advanceTimersByTime(100);
      await expect(timedOut).resolves.toEqual([{ url: 'wss://b', ok: false }]);
      factory.throwNext = true;
      await expect(pub.publish(event, ['wss://c'], 100)).resolves.toEqual([
        { url: 'wss://c', ok: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
      const pub = new WebsocketNostrPublisher();
      const pending = pub.publish(event, ['wss://default'], 100);
      socket.emit('open');
      socket.frame('OK', 'abc123', true);
      await expect(pending).resolves.toEqual([{ url: 'wss://default', ok: true }]);
      expect(socket.frames()[0]).toEqual(['EVENT', event]);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
