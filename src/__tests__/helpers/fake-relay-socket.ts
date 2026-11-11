import type { WebSocketLike } from '@/lib/nostr/publish';

/** In-memory relay WebSocket stub (no network). */
export class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  throwOnSend = false;
  throwOnClose = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url = '') {}

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
    this.emit('close');
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /** Deliver one relay frame as JSON text. */
  frame(...parts: unknown[]): void {
    this.emit('message', { data: JSON.stringify(parts) });
  }

  /** Sent frames parsed back to arrays. */
  frames(): unknown[][] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown[]);
  }

  /** Subscription id of the `index`-th REQ sent on this socket. */
  subId(index = 0): string {
    const reqs = this.frames().filter((f) => f[0] === 'REQ');
    return reqs[index]![1] as string;
  }
}

/** Socket factory that records every socket it opens. */
export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  /** When set, the next `create` throws instead of opening a socket. */
  throwNext = false;

  readonly create = (url: string): FakeSocket => {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('factory failed');
    }
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  /** Most recently opened socket. */
  last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }
}
