/**
 * Injectable Nostr REQ querier. Production uses WebSockets; tests inject fakes.
 */

import { type WebSocketFactory, type WebSocketLike } from '@/lib/nostr/publish';

/** Minimal EVENT payload collected from relays. */
export interface NostrEventFrame {
  /** Event id (hex). */
  id: string;
  /** Author pubkey (hex). */
  pubkey: string;
  /** Kind number. */
  kind: number;
  /** Tag list. */
  tags: string[][];
  /** Optional content. */
  content?: string;
}

/** Port so the worker never opens sockets in unit tests. */
export interface NostrQuerier {
  /**
   * Query relays with one filter; collect EVENT frames until EOSE or timeout.
   *
   * @param filter - NIP-01 filter object.
   * @param urls - Relay WebSocket URLs.
   * @param timeoutMs - Per-relay timeout.
   * @returns Deduped events (by id); order is undefined.
   */
  query(
    filter: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<NostrEventFrame[]>;
}

/**
 * Test fake that records REQ calls and returns configured events.
 */
export class RecordingQuerier implements NostrQuerier {
  readonly calls: {
    filter: Record<string, unknown>;
    urls: readonly string[];
    timeoutMs: number;
  }[] = [];

  /** Events returned from the next `query` call. */
  events: NostrEventFrame[] = [];

  /**
   * Record the call and return {@link events}.
   *
   * @param filter - Filter.
   * @param urls - Relays.
   * @param timeoutMs - Timeout.
   * @returns Configured events (copy).
   */
  query(
    filter: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<NostrEventFrame[]> {
    this.calls.push({ filter, urls, timeoutMs });
    return Promise.resolve(
      this.events.map((event) => ({ ...event, tags: event.tags.map((t) => [...t]) })),
    );
  }
}

/**
 * Production querier: one WebSocket per relay URL.
 *
 * @param createSocket - Socket factory. Default opens `new WebSocket(url)`.
 */
export class WebsocketNostrQuerier implements NostrQuerier {
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
   * Open each relay, send REQ, collect EVENT frames, CLOSE on EOSE/timeout.
   *
   * Factory throw, socket error, or timeout for one URL contributes no events
   * (never throws). Empty `urls` → `[]`. Results are deduped by event id.
   *
   * @param filter - NIP-01 filter.
   * @param urls - Relay WebSocket URLs.
   * @param timeoutMs - Per-relay timeout in milliseconds.
   * @returns Deduped {@link NostrEventFrame} list.
   */
  async query(
    filter: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<NostrEventFrame[]> {
    if (urls.length === 0) {
      return [];
    }
    const batches = await Promise.all(urls.map((url) => this.queryOne(filter, url, timeoutMs)));
    const byId = new Map<string, NostrEventFrame>();
    for (const batch of batches) {
      for (const event of batch) {
        byId.set(event.id, event);
      }
    }
    return [...byId.values()];
  }

  /**
   * Open one relay, REQ until EOSE/timeout, then CLOSE and close the socket.
   *
   * @param filter - Filter.
   * @param url - Relay URL.
   * @param timeoutMs - Settle deadline.
   * @returns Events from this URL (may be empty).
   */
  private queryOne(
    filter: Record<string, unknown>,
    url: string,
    timeoutMs: number,
  ): Promise<NostrEventFrame[]> {
    return new Promise((resolve) => {
      const collected: NostrEventFrame[] = [];
      let settled = false;
      let socket: WebSocketLike | undefined;
      const subId = `q-${Math.random().toString(36).slice(2, 10)}`;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket?.send(JSON.stringify(['CLOSE', subId]));
        } catch {
          // Ignore CLOSE failures after settle.
        }
        try {
          socket?.close();
        } catch {
          // Ignore close failures after settle.
        }
        resolve(collected);
      };
      const timer = setTimeout(() => {
        settle();
      }, timeoutMs);

      try {
        socket = this.createSocket(url);
      } catch {
        settle();
        return;
      }

      socket.addEventListener('open', () => {
        try {
          socket!.send(JSON.stringify(['REQ', subId, filter]));
        } catch {
          settle();
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
        if (!Array.isArray(parsed) || parsed.length < 2) {
          return;
        }
        if (parsed[0] === 'EOSE' && parsed[1] === subId) {
          settle();
          return;
        }
        if (parsed[0] !== 'EVENT' || parsed[1] !== subId) {
          return;
        }
        const payload = parsed[2];
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          return;
        }
        const obj = payload as Record<string, unknown>;
        if (
          typeof obj['id'] !== 'string' ||
          obj['id'] === '' ||
          typeof obj['pubkey'] !== 'string' ||
          obj['pubkey'] === '' ||
          typeof obj['kind'] !== 'number' ||
          !Array.isArray(obj['tags'])
        ) {
          return;
        }
        const tags: string[][] = [];
        for (const tag of obj['tags']) {
          if (!Array.isArray(tag)) {
            return;
          }
          const row: string[] = [];
          for (const cell of tag) {
            if (typeof cell !== 'string') {
              return;
            }
            row.push(cell);
          }
          tags.push(row);
        }
        const frame: NostrEventFrame = {
          id: obj['id'],
          pubkey: obj['pubkey'],
          kind: obj['kind'],
          tags,
        };
        if (typeof obj['content'] === 'string') {
          frame.content = obj['content'];
        }
        collected.push(frame);
      });

      socket.addEventListener('error', () => {
        settle();
      });

      socket.addEventListener('close', () => {
        settle();
      });
    });
  }
}
