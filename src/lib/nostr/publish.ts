/**
 * Injectable Nostr EVENT publisher. Production uses WebSockets; tests fake OK.
 */

/** One relay's response to an EVENT. */
export interface RelayAck {
  /** Relay WebSocket URL. */
  url: string;
  /** `true` when the relay accepted the event. */
  ok: boolean;
}

/** Port so the worker never opens sockets in unit tests. */
export interface NostrPublisher {
  /**
   * Publish a signed event to each URL.
   *
   * @param event - Signed NIP-01 event object.
   * @param urls - Relay URLs.
   * @param timeoutMs - Per-relay timeout.
   */
  publish(
    event: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<RelayAck[]>;
}

/** Publisher that records calls and returns configured ACKs (tests). */
export class RecordingPublisher implements NostrPublisher {
  readonly calls: { event: Record<string, unknown>; urls: readonly string[] }[] = [];
  /** Default ACK ok for every URL. */
  ok = true;

  /**
   * @param event - Signed event.
   * @param urls - Relays.
   * @param _timeoutMs - Unused in the fake.
   * @returns One ACK per URL.
   */
  publish(
    event: Record<string, unknown>,
    urls: readonly string[],
    _timeoutMs: number,
  ): Promise<RelayAck[]> {
    this.calls.push({ event, urls });
    return Promise.resolve(urls.map((url) => ({ url, ok: this.ok })));
  }
}

/** Minimal WebSocket surface used by the publisher (injectable; no real network in tests). */
export interface WebSocketLike {
  /** Register `open` / `message` / `error` / `close` listeners. */
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  /** Send a text frame. */
  send(data: string): void;
  /** Close the socket. */
  close(): void;
}

/**
 * Creates a WebSocket-like connection for one relay URL.
 *
 * @param url - Relay WebSocket URL.
 */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Production publisher: one WebSocket per relay URL.
 *
 * @param createSocket - Socket factory. Default opens `new WebSocket(url)`.
 */
export class WebsocketNostrPublisher implements NostrPublisher {
  private readonly createSocket: WebSocketFactory;

  /**
   * @param createSocket - Socket factory. Default opens `new WebSocket(url)`.
   */
  constructor(createSocket?: WebSocketFactory) {
    this.createSocket =
      createSocket ??
      ((url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike);
  }

  /**
   * Publish a signed event to each URL over an independent WebSocket.
   *
   * @param event - Signed NIP-01 event object.
   * @param urls - Relay WebSocket URLs.
   * @param timeoutMs - Per-relay timeout in milliseconds.
   * @returns One {@link RelayAck} per URL, same order as `urls`.
   */
  publish(
    event: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<RelayAck[]> {
    return Promise.all(urls.map((url) => this.publishOne(event, url, timeoutMs)));
  }

  /**
   * Open one relay, send EVENT, wait for matching OK or fail.
   *
   * @param event - Signed event.
   * @param url - Relay URL.
   * @param timeoutMs - Settle deadline.
   * @returns ACK for this URL.
   */
  private publishOne(
    event: Record<string, unknown>,
    url: string,
    timeoutMs: number,
  ): Promise<RelayAck> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: WebSocketLike | undefined;
      const settle = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // Ignore close failures after settle.
        }
        resolve({ url, ok });
      };
      const timer = setTimeout(() => {
        settle(false);
      }, timeoutMs);

      try {
        socket = this.createSocket(url);
      } catch {
        settle(false);
        return;
      }

      socket.addEventListener('open', () => {
        try {
          socket!.send(JSON.stringify(['EVENT', event]));
        } catch {
          settle(false);
        }
      });

      socket.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!Array.isArray(parsed) || parsed[0] !== 'OK') {
          return;
        }
        if (parsed[1] !== event['id']) {
          return;
        }
        settle(parsed[2] === true);
      });

      socket.addEventListener('error', () => {
        settle(false);
      });

      socket.addEventListener('close', () => {
        settle(false);
      });
    });
  }
}

/**
 * Whether space ACK succeeded.
 *
 * @param acks - Relay results.
 * @param spaceUrl - Durability relay.
 * @returns `true` when that URL returned ok.
 */
export function spaceAcked(acks: readonly RelayAck[], spaceUrl: string): boolean {
  return acks.some((ack) => ack.url === spaceUrl && ack.ok);
}

/**
 * Whether at least one public relay succeeded (excluding space).
 *
 * @param acks - Relay results.
 * @param spaceUrl - Durability relay to exclude.
 * @returns `true` when a non-space ACK is ok.
 */
export function publicAcked(acks: readonly RelayAck[], spaceUrl: string): boolean {
  return acks.some((ack) => ack.url !== spaceUrl && ack.ok);
}
