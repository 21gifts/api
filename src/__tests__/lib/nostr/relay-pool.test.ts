import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket, FakeSocketFactory } from '@/__tests__/helpers/fake-relay-socket';
import { NostrRelayPool, sharedNostrRelayPool } from '@/lib/nostr/relay-pool';

const URL_A = 'wss://a';
const URL_B = 'wss://b';

/**
 * Query helper that collects payloads and reports whether the call settled.
 */
function startQuery(
  pool: NostrRelayPool,
  url: string,
  timeoutMs = 1_000,
  filter: Record<string, unknown> = { kinds: [1] },
): { events: unknown[]; done: () => boolean; promise: Promise<void> } {
  const events: unknown[] = [];
  let settled = false;
  const promise = pool
    .query(filter, url, timeoutMs, (payload) => {
      events.push(payload);
    })
    .then(() => {
      settled = true;
    });
  return { events, done: () => settled, promise };
}

describe('NostrRelayPool', () => {
  let factory: FakeSocketFactory;
  let pool: NostrRelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new FakeSocketFactory();
    pool = new NostrRelayPool({
      createSocket: factory.create,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      connectTimeoutMs: 500,
      idleMs: 10_000,
    });
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  describe('reuse', () => {
    it('serves 50 sequential queries and 50 publishes over one socket', async () => {
      for (let i = 0; i < 50; i += 1) {
        const q = startQuery(pool, URL_A);
        const socket = factory.last();
        if (i === 0) {
          socket.emit('open');
        }
        socket.frame('EOSE', socket.subId(i));
        await q.promise;
        const ack = pool.publish({ id: `e${i}` }, URL_A, 1_000);
        socket.frame('OK', `e${i}`, true);
        await expect(ack).resolves.toBe(true);
      }
      expect(factory.sockets).toHaveLength(1);
      expect(factory.last().closed).toBe(false);
    });

    it('opens one socket per relay URL for concurrent calls', async () => {
      const calls = [
        startQuery(pool, URL_A),
        startQuery(pool, URL_A),
        startQuery(pool, URL_B),
        startQuery(pool, URL_B),
      ];
      const acks = [
        pool.publish({ id: 'x' }, URL_A, 1_000),
        pool.publish({ id: 'x' }, URL_B, 1_000),
      ];
      expect(factory.sockets.map((s) => s.url)).toEqual([URL_A, URL_B]);
      for (const socket of factory.sockets) {
        socket.emit('open');
        socket.frame('EOSE', socket.subId(0));
        socket.frame('EOSE', socket.subId(1));
        socket.frame('OK', 'x', true);
      }
      await Promise.all(calls.map((c) => c.promise));
      await expect(Promise.all(acks)).resolves.toEqual([true, true]);
      expect(factory.sockets).toHaveLength(2);
    });

    it('connects lazily: no socket before the first call', () => {
      expect(factory.sockets).toHaveLength(0);
    });
  });

  describe('multiplexing', () => {
    it('routes EVENT and EOSE by subscription id and CLOSEs each finished REQ', async () => {
      const first = startQuery(pool, URL_A, 1_000, { kinds: [1] });
      const second = startQuery(pool, URL_A, 1_000, { kinds: [7] });
      const socket = factory.last();
      expect(socket.sent).toEqual([]);
      socket.emit('open');
      const frames = socket.frames();
      expect(frames).toEqual([
        ['REQ', 'q-1', { kinds: [1] }],
        ['REQ', 'q-2', { kinds: [7] }],
      ]);
      socket.frame('EVENT', 'q-2', { id: 'b' });
      socket.frame('EVENT', 'q-1', { id: 'a' });
      socket.frame('EOSE', 'q-1');
      await first.promise;
      expect(first.events).toEqual([{ id: 'a' }]);
      expect(second.done()).toBe(false);
      socket.frame('EVENT', 'q-2', { id: 'c' });
      socket.frame('CLOSED', 'q-2', 'error: too many subs');
      await second.promise;
      expect(second.events).toEqual([{ id: 'b' }, { id: 'c' }]);
      expect(socket.frames().slice(2)).toEqual([
        ['CLOSE', 'q-1'],
        ['CLOSE', 'q-2'],
      ]);
      expect(socket.closed).toBe(false);
    });

    it('sends a REQ at once when the socket is already open', () => {
      startQuery(pool, URL_A);
      const socket = factory.last();
      socket.emit('open');
      startQuery(pool, URL_A);
      expect(socket.frames().map((f) => f[1])).toEqual(['q-1', 'q-2']);
    });

    it('matches OK by event id and settles every publish of the same id', async () => {
      const first = pool.publish({ id: 'e1', kind: 1 }, URL_A, 1_000);
      const twin = pool.publish({ id: 'e1', kind: 1 }, URL_A, 1_000);
      const other = pool.publish({ id: 'e2', kind: 1 }, URL_A, 1_000);
      const socket = factory.last();
      socket.emit('open');
      expect(socket.frames()[0]).toEqual(['EVENT', { id: 'e1', kind: 1 }]);
      socket.frame('OK', 'unknown', true);
      socket.frame('OK', 'e2', false, 'blocked: spam');
      socket.frame('OK', 'e1', true, '');
      socket.frame('OK', 'e1', true, 'duplicate');
      await expect(Promise.all([first, twin, other])).resolves.toEqual([true, true, false]);
    });

    it('ignores frames that are not text, not JSON, not arrays, or for unknown ids', async () => {
      const q = startQuery(pool, URL_A);
      const socket = factory.last();
      socket.emit('open');
      socket.emit('message', { data: 42 });
      socket.emit('message', { data: 'not-json{' });
      socket.emit('message', { data: JSON.stringify({ EVENT: 1 }) });
      socket.frame('EVENT');
      socket.frame('NOTICE', 'hello');
      socket.frame('EVENT', 'q-99', { id: 'x' });
      socket.frame('AUTH', 'q-1');
      expect(q.done()).toBe(false);
      socket.frame('EOSE', 'q-1');
      await q.promise;
      expect(q.events).toEqual([]);
    });
  });

  describe('timeout', () => {
    it('ends a query at its deadline, CLOSEs it, and keeps a socket that is talking', async () => {
      const slow = startQuery(pool, URL_A, 300);
      const busy = startQuery(pool, URL_A, 5_000);
      const socket = factory.last();
      socket.emit('open');
      socket.frame('EVENT', 'q-1', { id: 'partial' });
      vi.advanceTimersByTime(300);
      await slow.promise;
      expect(slow.events).toEqual([{ id: 'partial' }]);
      expect(socket.frames()).toContainEqual(['CLOSE', 'q-1']);
      expect(socket.closed).toBe(false);
      expect(busy.done()).toBe(false);
    });

    it('fails a publish at its deadline', async () => {
      const ack = pool.publish({ id: 'e1' }, URL_A, 200);
      factory.last().emit('open');
      factory.last().frame('NOTICE', 'busy');
      vi.advanceTimersByTime(200);
      await expect(ack).resolves.toBe(false);
      expect(factory.last().closed).toBe(false);
    });

    it('recycles a socket that sent nothing since the timed-out frame went out', async () => {
      const ack = pool.publish({ id: 'e1' }, URL_A, 200);
      const q = startQuery(pool, URL_A, 5_000);
      const socket = factory.last();
      socket.emit('open');
      vi.advanceTimersByTime(200);
      await expect(ack).resolves.toBe(false);
      await q.promise;
      expect(socket.closed).toBe(true);
      const next = pool.publish({ id: 'e2' }, URL_A, 1_000);
      expect(factory.sockets).toHaveLength(1);
      vi.advanceTimersByTime(100);
      expect(factory.sockets).toHaveLength(2);
      factory.last().emit('open');
      factory.last().frame('OK', 'e2', true);
      await expect(next).resolves.toBe(true);
    });

    it('counts one drop when the CLOSE of a silent timed-out query throws', async () => {
      const q = startQuery(pool, URL_A, 200);
      const socket = factory.last();
      socket.emit('open');
      socket.throwOnSend = true;
      vi.advanceTimersByTime(200);
      await q.promise;
      expect(socket.closed).toBe(true);
      const at = Date.now();
      startQuery(pool, URL_A, 10_000);
      while (factory.sockets.length === 1) {
        vi.advanceTimersByTime(10);
      }
      expect(Date.now() - at).toBe(100);
    });

    it('ends calls that time out while the socket is still connecting', async () => {
      const q = startQuery(pool, URL_A, 100);
      const ack = pool.publish({ id: 'e1' }, URL_A, 100);
      vi.advanceTimersByTime(100);
      await q.promise;
      await expect(ack).resolves.toBe(false);
      const socket = factory.last();
      socket.emit('open');
      expect(socket.sent).toEqual([]);
    });

    it('drops a socket that does not open within the connect timeout', async () => {
      const q = startQuery(pool, URL_A, 5_000);
      vi.advanceTimersByTime(500);
      await q.promise;
      expect(factory.last().closed).toBe(true);
    });
  });

  describe('drop mid-call', () => {
    it('fails every waiting call on close and keeps events delivered before it', async () => {
      const q = startQuery(pool, URL_A);
      const ack = pool.publish({ id: 'e1' }, URL_A, 1_000);
      const socket = factory.last();
      socket.emit('open');
      socket.frame('EVENT', 'q-1', { id: 'before-drop' });
      socket.emit('close');
      await q.promise;
      expect(q.events).toEqual([{ id: 'before-drop' }]);
      await expect(ack).resolves.toBe(false);
      expect(socket.sent.filter((f) => f.startsWith('["CLOSE"'))).toEqual([]);
    });

    it('fails waiting calls on a socket error and ignores the stale socket afterwards', async () => {
      const q = startQuery(pool, URL_A);
      const socket = factory.last();
      socket.emit('open');
      socket.emit('error');
      await q.promise;
      expect(socket.closed).toBe(true);
      socket.emit('open');
      socket.frame('EOSE', 'q-1');
      socket.emit('close');
      const next = startQuery(pool, URL_A);
      vi.advanceTimersByTime(100);
      expect(factory.sockets).toHaveLength(2);
      factory.last().emit('open');
      factory.last().frame('EOSE', 'q-2');
      await next.promise;
    });

    it('treats a throwing send as a drop', async () => {
      const first = startQuery(pool, URL_A);
      const second = pool.publish({ id: 'e1' }, URL_A, 1_000);
      const socket = factory.last();
      socket.throwOnSend = true;
      socket.emit('open');
      await first.promise;
      await expect(second).resolves.toBe(false);
      expect(socket.closed).toBe(true);
    });

    it('treats a throwing CLOSE as a drop and swallows a throwing socket close', async () => {
      const first = startQuery(pool, URL_A);
      const other = pool.publish({ id: 'e1' }, URL_A, 1_000);
      const socket = factory.last();
      socket.emit('open');
      socket.throwOnSend = true;
      socket.throwOnClose = true;
      socket.frame('EOSE', 'q-1');
      await first.promise;
      await expect(other).resolves.toBe(false);
      startQuery(pool, URL_A);
      vi.advanceTimersByTime(100);
      expect(factory.sockets).toHaveLength(2);
    });

    it('fails waiting calls when the factory throws', async () => {
      factory.throwNext = true;
      const ack = pool.publish({ id: 'e1' }, URL_A, 1_000);
      await expect(ack).resolves.toBe(false);
      expect(factory.sockets).toHaveLength(0);
    });
  });

  describe('reconnect and backoff', () => {
    it('doubles the delay after each failed connect up to the cap', async () => {
      const delays: number[] = [];
      let last = Date.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const q = startQuery(pool, URL_A, 10_000);
        while (factory.sockets.length === attempt) {
          vi.advanceTimersByTime(10);
        }
        delays.push(Date.now() - last);
        factory.last().emit('error');
        await q.promise;
        last = Date.now();
      }
      expect(delays).toEqual([0, 100, 200, 400, 400]);
    });

    it('resets the backoff after the relay answers on a new socket', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const q = startQuery(pool, URL_A, 10_000);
        vi.advanceTimersByTime(400);
        factory.last().emit('close');
        await q.promise;
      }
      const q = startQuery(pool, URL_A, 10_000);
      vi.advanceTimersByTime(400);
      const socket = factory.last();
      socket.emit('open');
      socket.frame('EOSE', 'q-4');
      await q.promise;
      socket.emit('close');
      const at = Date.now();
      startQuery(pool, URL_A, 10_000);
      const before = factory.sockets.length;
      while (factory.sockets.length === before) {
        vi.advanceTimersByTime(10);
      }
      expect(Date.now() - at).toBe(100);
    });

    it('does not reconnect while no call waits, and connects at once after the backoff passed', async () => {
      const q = startQuery(pool, URL_A);
      factory.last().emit('close');
      await q.promise;
      vi.advanceTimersByTime(5_000);
      expect(factory.sockets).toHaveLength(1);
      startQuery(pool, URL_A);
      expect(factory.sockets).toHaveLength(2);
    });

    it('skips a scheduled reconnect when every waiting call timed out first', async () => {
      const q = startQuery(pool, URL_A);
      factory.last().emit('close');
      await q.promise;
      const short = startQuery(pool, URL_A, 50);
      vi.advanceTimersByTime(50);
      await short.promise;
      vi.advanceTimersByTime(100);
      expect(factory.sockets).toHaveLength(1);
    });

    it('stops sending queued frames when the socket drops during the flush on open', async () => {
      const first = pool.publish({ id: 'e1' }, URL_A, 1_000);
      const second = pool.publish({ id: 'e2' }, URL_A, 1_000);
      const socket = factory.last();
      socket.send = (frame: string): void => {
        socket.sent.push(frame);
        throw new Error('broken pipe');
      };
      socket.emit('open');
      await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
      expect(socket.sent).toHaveLength(1);
    });
  });

  describe('idle and close', () => {
    it('closes a connection after idleMs without a call and reconnects on demand', async () => {
      const q = startQuery(pool, URL_A);
      const socket = factory.last();
      socket.emit('open');
      socket.frame('EOSE', 'q-1');
      await q.promise;
      vi.advanceTimersByTime(9_999);
      expect(socket.closed).toBe(false);
      startQuery(pool, URL_A, 60_000);
      vi.advanceTimersByTime(10_000);
      expect(socket.closed).toBe(false);
      socket.frame('EOSE', 'q-2');
      vi.advanceTimersByTime(10_000);
      expect(socket.closed).toBe(true);
      startQuery(pool, URL_A);
      expect(factory.sockets).toHaveLength(2);
    });

    it('forgets an idle connection that never connected', async () => {
      factory.throwNext = true;
      const q = startQuery(pool, URL_A);
      await q.promise;
      vi.advanceTimersByTime(10_000);
      startQuery(pool, URL_A);
      expect(factory.sockets).toHaveLength(1);
    });

    it('close() fails waiting calls, closes sockets, and fails later calls at once', async () => {
      const q = startQuery(pool, URL_A);
      const ack = pool.publish({ id: 'e1' }, URL_A, 1_000);
      const waiting = startQuery(pool, URL_B);
      factory.sockets[0]!.emit('open');
      factory.sockets[1]!.throwOnClose = true;
      pool.close();
      await q.promise;
      await waiting.promise;
      await expect(ack).resolves.toBe(false);
      expect(factory.sockets[0]!.closed).toBe(true);
      const after = startQuery(pool, URL_A);
      await after.promise;
      await expect(pool.publish({ id: 'e2' }, URL_A, 1_000)).resolves.toBe(false);
      expect(factory.sockets).toHaveLength(2);
      vi.advanceTimersByTime(60_000);
      expect(factory.sockets).toHaveLength(2);
    });

    it('close() cancels a scheduled reconnect', async () => {
      const q = startQuery(pool, URL_A);
      factory.last().emit('close');
      await q.promise;
      startQuery(pool, URL_A, 10_000);
      pool.close();
      vi.advanceTimersByTime(1_000);
      expect(factory.sockets).toHaveLength(1);
    });
  });

  it('fails a publish without a string id without opening a socket', async () => {
    await expect(pool.publish({ kind: 1 }, URL_A, 1_000)).resolves.toBe(false);
    expect(factory.sockets).toHaveLength(0);
  });
});

describe('NostrRelayPool defaults', () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('opens sockets with the global WebSocket', async () => {
    const socket = new FakeSocket();
    const urls: string[] = [];
    globalThis.WebSocket = class {
      constructor(url: string) {
        urls.push(url);
        return socket;
      }
    } as unknown as typeof WebSocket;
    const pool = new NostrRelayPool();
    const ack = pool.publish({ id: 'e1' }, 'wss://default', 1_000);
    socket.emit('open');
    socket.frame('OK', 'e1', true);
    await expect(ack).resolves.toBe(true);
    expect(urls).toEqual(['wss://default']);
    pool.close();
  });

  it('sharedNostrRelayPool returns one pool per process', () => {
    expect(sharedNostrRelayPool()).toBe(sharedNostrRelayPool());
    expect(sharedNostrRelayPool()).toBeInstanceOf(NostrRelayPool);
  });
});
