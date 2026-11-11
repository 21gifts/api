/**
 * Injectable Nostr EVENT publisher. Production uses the shared relay pool; tests fake OK.
 */

import { type NostrRelayPool, sharedNostrRelayPool } from '@/lib/nostr/relay-pool';

/**
 * Whether `value` is a plain object (not null, not an array).
 *
 * @param value - Candidate.
 * @returns `true` for plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a stored or wire-shaped signed event into a plain object.
 *
 * Bun may return `jsonb` as a JSON string (sometimes double-encoded). A
 * string second element in `["EVENT", …]` is rejected by relays.
 *
 * @param value - Object, JSON string, double-encoded JSON string, or other.
 * @returns Shallow-copied plain object, or `null` when not usable.
 */
export function normalizeSignedEvent(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) {
    return { ...value };
  }
  if (typeof value !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (isPlainObject(parsed)) {
    return { ...parsed };
  }
  return null;
}

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

/** Minimal WebSocket surface used by the relay pool (injectable; no real network in tests). */
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
 * Production publisher: EVENT on the shared connection per relay URL.
 *
 * @param pool - Relay pool. Default is the process-wide {@link sharedNostrRelayPool}.
 */
export class WebsocketNostrPublisher implements NostrPublisher {
  /**
   * @param pool - Relay pool. Default is the process-wide {@link sharedNostrRelayPool}.
   */
  constructor(private readonly pool: NostrRelayPool = sharedNostrRelayPool()) {}

  /**
   * Publish a signed event to each URL over that relay's shared connection.
   *
   * The event goes through {@link normalizeSignedEvent} first; an unusable
   * event is `ok: false` for every URL without a send. A relay that cannot
   * connect, drops, rejects, or does not answer within `timeoutMs` is
   * `ok: false`. Every relay's deadline counts from this call, including the
   * normalization: each pool call gets only the time left, and a relay reached
   * with no time left is `ok: false` without a pool call. Never throws.
   *
   * @param event - Signed NIP-01 event object.
   * @param urls - Relay WebSocket URLs.
   * @param timeoutMs - Per-relay timeout in milliseconds, counted from this call.
   * @returns One {@link RelayAck} per URL, same order as `urls`.
   */
  publish(
    event: Record<string, unknown>,
    urls: readonly string[],
    timeoutMs: number,
  ): Promise<RelayAck[]> {
    const startedAt = Date.now();
    const normalized = normalizeSignedEvent(event);
    return Promise.all(
      urls.map(async (url) => {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (normalized === null || remainingMs <= 0) {
          return { url, ok: false };
        }
        return { url, ok: await this.pool.publish(normalized, url, remainingMs) };
      }),
    );
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
