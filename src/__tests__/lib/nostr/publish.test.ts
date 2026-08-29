import { afterEach, describe, expect, it } from 'vitest';
import {
  publicAcked,
  RecordingPublisher,
  spaceAcked,
  WebsocketNostrPublisher,
  type WebSocketLike,
} from '@/lib/nostr/publish';

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

describe('WebsocketNostrPublisher', () => {
  const event = { id: 'abc123', kind: 1 };
  let originalWebSocket: typeof globalThis.WebSocket | undefined;

  afterEach(() => {
    if (originalWebSocket !== undefined) {
      globalThis.WebSocket = originalWebSocket;
      originalWebSocket = undefined;
    }
  });

  it('returns [] for empty urls', async () => {
    const pub = new WebsocketNostrPublisher(() => new FakeSocket());
    await expect(pub.publish(event, [], 20)).resolves.toEqual([]);
  });

  it('ACKs ok:true, sends EVENT, and closes the socket', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      expect(socket.sent[0]).toBe(JSON.stringify(['EVENT', event]));
      socket.emit('message', { data: JSON.stringify(['OK', 'abc123', true]) });
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: true }]);
    expect(socket.closed).toBe(true);
  });

  it('ACKs ok:false when the relay rejects', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('message', { data: JSON.stringify(['OK', 'abc123', false, 'rejected']) });
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: false }]);
    expect(socket.closed).toBe(true);
  });

  it('times out with ok:false and closes the socket', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 20);
    queueMicrotask(() => {
      socket.emit('open');
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: false }]);
    expect(socket.closed).toBe(true);
  });

  it('returns ok:false when the factory throws', async () => {
    const pub = new WebsocketNostrPublisher(() => {
      throw new Error('no socket');
    });
    await expect(pub.publish(event, ['wss://a'], 20)).resolves.toEqual([
      { url: 'wss://a', ok: false },
    ]);
  });

  it('returns ok:false on socket error', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('error');
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: false }]);
  });

  it('returns ok:false when send throws', async () => {
    const socket = new FakeSocket();
    socket.throwOnSend = true;
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: false }]);
  });

  it('returns ok:false when the socket closes before OK', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('close');
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: false }]);
  });

  it('ignores non-JSON, wrong-id, and non-OK frames until a matching OK', async () => {
    const socket = new FakeSocket();
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('message', { data: 'not-json{' });
      socket.emit('message', { data: 42 });
      socket.emit('message', { data: JSON.stringify(['NOTICE', 'hi']) });
      socket.emit('message', { data: JSON.stringify(['OK', 'other-id', true]) });
      socket.emit('message', { data: JSON.stringify(['OK', 'abc123', true]) });
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: true }]);
  });

  it('publishes to multiple URLs independently', async () => {
    const okSocket = new FakeSocket();
    const badSocket = new FakeSocket();
    const sockets = [okSocket, badSocket];
    let i = 0;
    const pub = new WebsocketNostrPublisher(() => sockets[i++]!);
    const pending = pub.publish(event, ['wss://ok', 'wss://bad'], 100);
    queueMicrotask(() => {
      okSocket.emit('open');
      okSocket.emit('message', { data: JSON.stringify(['OK', 'abc123', true]) });
      badSocket.emit('open');
      badSocket.emit('message', { data: JSON.stringify(['OK', 'abc123', false]) });
    });
    await expect(pending).resolves.toEqual([
      { url: 'wss://ok', ok: true },
      { url: 'wss://bad', ok: false },
    ]);
  });

  it('still settles when close throws after OK', async () => {
    const socket = new FakeSocket();
    socket.throwOnClose = true;
    const pub = new WebsocketNostrPublisher(() => socket);
    const pending = pub.publish(event, ['wss://a'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('message', { data: JSON.stringify(['OK', 'abc123', true]) });
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://a', ok: true }]);
  });

  it('uses the default WebSocket factory when constructed with no args', async () => {
    originalWebSocket = globalThis.WebSocket;
    const socket = new FakeSocket();
    globalThis.WebSocket = class {
      constructor(_url: string) {
        return socket;
      }
    } as unknown as typeof WebSocket;

    const pub = new WebsocketNostrPublisher();
    const pending = pub.publish(event, ['wss://default'], 100);
    queueMicrotask(() => {
      socket.emit('open');
      socket.emit('message', { data: JSON.stringify(['OK', 'abc123', true]) });
    });
    await expect(pending).resolves.toEqual([{ url: 'wss://default', ok: true }]);
    expect(socket.sent[0]).toBe(JSON.stringify(['EVENT', event]));
  });
});
