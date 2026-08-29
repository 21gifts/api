import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocketLike } from '@/lib/nostr/publish';
import { RecordingQuerier, WebsocketNostrQuerier } from '@/lib/nostr/query';

/** In-memory WebSocket stub (no network). */
class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  throwOnSend = false;
  throwOnClose = false;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('send failed');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.throwOnClose) {
      throw new Error('close failed');
    }
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

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
  let originalWebSocket: typeof globalThis.WebSocket | undefined;

  afterEach(() => {
    if (originalWebSocket !== undefined) {
      globalThis.WebSocket = originalWebSocket;
      originalWebSocket = undefined;
    }
  });

  it('returns [] for empty urls', async () => {
    const querier = new WebsocketNostrQuerier(() => new FakeSocket());
    await expect(querier.query({ kinds: [1] }, [], 20)).resolves.toEqual([]);
  });

  it('sends REQ, collects EVENT object payloads, CLOSEs on EOSE, and closes', async () => {
    const socket = new FakeSocket();
    const querier = new WebsocketNostrQuerier(() => socket);
    const filter = { kinds: [9735], '#e': ['note1'], limit: 200 };
    const pending = querier.query(filter, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      const req = JSON.parse(socket.sent[0]!) as unknown[];
      expect(req[0]).toBe('REQ');
      const subId = req[1] as string;
      expect(req[2]).toEqual(filter);
      socket.emit('message', {
        data: JSON.stringify([
          'EVENT',
          subId,
          {
            id: 'evt1',
            pubkey: 'pk1',
            kind: 9735,
            tags: [['e', 'note1']],
            content: 'hello',
          },
        ]),
      });
      socket.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    });
    const events = await pending;
    expect(events).toEqual([
      {
        id: 'evt1',
        pubkey: 'pk1',
        kind: 9735,
        tags: [['e', 'note1']],
        content: 'hello',
      },
    ]);
    expect(socket.sent.some((frame) => frame.startsWith('["CLOSE"'))).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it('times out with no EOSE', async () => {
    const socket = new FakeSocket();
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 20);
    queueMicrotask(() => {
      socket.emit('open');
    });
    await expect(pending).resolves.toEqual([]);
    expect(socket.closed).toBe(true);
  });

  it('contributes [] when the factory throws', async () => {
    const querier = new WebsocketNostrQuerier(() => {
      throw new Error('no socket');
    });
    await expect(querier.query({ kinds: [1] }, ['wss://a'], 20)).resolves.toEqual([]);
  });

  it('returns [] on socket error', async () => {
    const socket = new FakeSocket();
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('error');
    });
    await expect(pending).resolves.toEqual([]);
  });

  it('returns [] on socket close before EOSE', async () => {
    const socket = new FakeSocket();
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('close');
    });
    await expect(pending).resolves.toEqual([]);
  });

  it('returns [] when send throws on open', async () => {
    const socket = new FakeSocket();
    socket.throwOnSend = true;
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
    });
    await expect(pending).resolves.toEqual([]);
  });

  it('settles when CLOSE send and close throw after EOSE', async () => {
    const socket = new FakeSocket();
    socket.throwOnClose = true;
    let sendCount = 0;
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      sendCount += 1;
      if (sendCount > 1) {
        throw new Error('CLOSE failed');
      }
      originalSend(data);
    };
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [1] }, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      const req = JSON.parse(socket.sent[0]!) as unknown[];
      const subId = req[1] as string;
      socket.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    });
    await expect(pending).resolves.toEqual([]);
  });

  it('ignores malformed frames and non-object EVENT payloads', async () => {
    const socket = new FakeSocket();
    const querier = new WebsocketNostrQuerier(() => socket);
    const pending = querier.query({ kinds: [9735] }, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      const req = JSON.parse(socket.sent[0]!) as unknown[];
      const subId = req[1] as string;
      socket.emit('message', { data: 42 });
      socket.emit('message', { data: 'not-json{' });
      socket.emit('message', { data: JSON.stringify(['NOTICE', 'hi']) });
      socket.emit('message', { data: JSON.stringify(['EVENT']) });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', 'other-sub', { id: 'x', pubkey: 'y', kind: 1, tags: [] }]),
      });
      socket.emit('message', { data: JSON.stringify(['EVENT', subId, 'string-payload']) });
      socket.emit('message', { data: JSON.stringify(['EVENT', subId, [1, 2]]) });
      socket.emit('message', { data: JSON.stringify(['EVENT', subId, null]) });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 1, pubkey: 'pk', kind: 1, tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: 2, kind: 1, tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { pubkey: 'pk', kind: 1, tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: 'pk', kind: 1 }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: '', pubkey: 'pk', kind: 1, tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: '', kind: 1, tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: 'pk', kind: '1', tags: [] }]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: 'pk', kind: 1, tags: 'no' }]),
      });
      socket.emit('message', {
        data: JSON.stringify([
          'EVENT',
          subId,
          { id: 'id', pubkey: 'pk', kind: 1, tags: ['not-array'] },
        ]),
      });
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'id', pubkey: 'pk', kind: 1, tags: [[1]] }]),
      });
      socket.emit('message', {
        data: JSON.stringify([
          'EVENT',
          subId,
          {
            id: 'good',
            pubkey: 'pk',
            kind: 9735,
            tags: [['e', 'note']],
            content: 123,
          },
        ]),
      });
      socket.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    });
    const events = await pending;
    expect(events).toEqual([
      {
        id: 'good',
        pubkey: 'pk',
        kind: 9735,
        tags: [['e', 'note']],
      },
    ]);
  });

  it('concatenates multiple URLs and dedups by id', async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    const sockets = [a, b];
    let i = 0;
    const querier = new WebsocketNostrQuerier(() => sockets[i++]!);
    const pending = querier.query({ kinds: [1] }, ['wss://a', 'wss://b'], 100);
    queueMicrotask(() => {
      a.emit('open');
      b.emit('open');
      const subA = (JSON.parse(a.sent[0]!) as unknown[])[1] as string;
      const subB = (JSON.parse(b.sent[0]!) as unknown[])[1] as string;
      const shared = { id: 'same', pubkey: 'pk', kind: 1, tags: [] as string[][] };
      a.emit('message', { data: JSON.stringify(['EVENT', subA, shared]) });
      b.emit('message', {
        data: JSON.stringify(['EVENT', subB, { ...shared, pubkey: 'other' }]),
      });
      b.emit('message', {
        data: JSON.stringify(['EVENT', subB, { id: 'other', pubkey: 'pk2', kind: 1, tags: [] }]),
      });
      a.emit('message', { data: JSON.stringify(['EOSE', subA]) });
      b.emit('message', { data: JSON.stringify(['EOSE', subB]) });
    });
    const events = await pending;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id).sort()).toEqual(['other', 'same']);
  });

  it('uses the default WebSocket factory when constructed with no args', async () => {
    originalWebSocket = globalThis.WebSocket;
    const socket = new FakeSocket();
    globalThis.WebSocket = class {
      constructor(_url: string) {
        return socket;
      }
    } as unknown as typeof WebSocket;

    const querier = new WebsocketNostrQuerier();
    const pending = querier.query({ kinds: [1] }, ['wss://default'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      const subId = (JSON.parse(socket.sent[0]!) as unknown[])[1] as string;
      socket.emit('message', {
        data: JSON.stringify(['EVENT', subId, { id: 'e', pubkey: 'p', kind: 1, tags: [] }]),
      });
      socket.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    });
    await expect(pending).resolves.toEqual([{ id: 'e', pubkey: 'p', kind: 1, tags: [] }]);
  });
});
