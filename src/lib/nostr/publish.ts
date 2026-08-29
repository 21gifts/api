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
