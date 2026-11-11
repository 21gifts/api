/**
 * Injectable Nostr REQ querier. Production uses the shared relay pool; tests inject fakes.
 */

import { type NostrRelayPool, sharedNostrRelayPool } from '@/lib/nostr/relay-pool';

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
  /** Unix created_at (needed to verify the signature). */
  created_at?: number;
  /** Schnorr signature hex. */
  sig?: string;
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
 * Validate one EVENT payload into a {@link NostrEventFrame}.
 *
 * @param payload - Third element of an `["EVENT", subId, payload]` frame.
 * @returns The frame, or `null` when id, pubkey, kind or tags are malformed.
 */
function parseEventFrame(payload: unknown): NostrEventFrame | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
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
    return null;
  }
  const tags: string[][] = [];
  for (const tag of obj['tags']) {
    if (!Array.isArray(tag)) {
      return null;
    }
    const row: string[] = [];
    for (const cell of tag) {
      if (typeof cell !== 'string') {
        return null;
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
  if (typeof obj['created_at'] === 'number') {
    frame.created_at = obj['created_at'];
  }
  if (typeof obj['sig'] === 'string' && obj['sig'] !== '') {
    frame.sig = obj['sig'];
  }
  return frame;
}

/**
 * Production querier: REQ subscriptions on the shared connection per relay URL.
 *
 * @param pool - Relay pool. Default is the process-wide {@link sharedNostrRelayPool}.
 */
export class WebsocketNostrQuerier implements NostrQuerier {
  /**
   * @param pool - Relay pool. Default is the process-wide {@link sharedNostrRelayPool}.
   */
  constructor(private readonly pool: NostrRelayPool = sharedNostrRelayPool()) {}

  /**
   * Send REQ on each relay's shared connection, collect EVENT frames until
   * EOSE, CLOSED or timeout, then CLOSE the subscription. The socket stays open.
   *
   * A relay that cannot connect, drops, or times out contributes the events
   * it delivered before that (never throws). Empty `urls` → `[]`. Results are
   * deduped by event id; the first URL in `urls` that returns a given id wins.
   * Every relay's deadline counts from this call: each pool call gets only the
   * time left, and a relay reached with no time left contributes `[]` without
   * a pool call.
   *
   * @param filter - NIP-01 filter.
   * @param urls - Relay WebSocket URLs.
   * @param timeoutMs - Per-relay timeout in milliseconds, counted from this call.
   * @returns Deduped {@link NostrEventFrame} list.
   */
  async query(
    filter: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<NostrEventFrame[]> {
    const startedAt = Date.now();
    const batches = await Promise.all(
      urls.map(async (url) => {
        const collected: NostrEventFrame[] = [];
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          return collected;
        }
        await this.pool.query(filter, url, remainingMs, (payload) => {
          const frame = parseEventFrame(payload);
          if (frame !== null) {
            collected.push(frame);
          }
        });
        return collected;
      }),
    );
    const byId = new Map<string, NostrEventFrame>();
    for (const batch of batches) {
      for (const event of batch) {
        if (!byId.has(event.id)) {
          byId.set(event.id, event);
        }
      }
    }
    return [...byId.values()];
  }
}
