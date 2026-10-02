import type { EventTemplate, VerifiedEvent } from 'nostr-tools/pure';

/**
 * Build an unsigned kind:9734 zap request (not published to relays).
 *
 * @param args - Recipient pubkey, event id, amount millisats, write relays,
 *   optional NIP-57 comment (`content`, default empty).
 * @returns Unsigned event template for `finalizeEvent`.
 */
export function buildZapRequest(args: {
  recipientPubkey: string;
  eventId: string;
  amountMsat: number;
  relays: readonly string[];
  /** Optional NIP-57 comment. Default empty (gift-only). */
  content?: string;
}): EventTemplate {
  return {
    kind: 9734,
    content: args.content ?? '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', args.recipientPubkey],
      ['e', args.eventId],
      ['k', '1'],
      ['amount', String(args.amountMsat)],
      ['relays', ...args.relays],
    ],
  };
}

/**
 * Serialise a signed kind 9734 event with the NIP-01 field order
 * `id, pubkey, created_at, kind, tags, content, sig`.
 *
 * @param event - Signed zap request.
 * @returns JSON string with exactly those seven keys in that order; the value
 *   sent as LNURL `nostr=` and hashed by `isNip57Invoice`.
 */
export function serializeZapRequest(event: VerifiedEvent): string {
  return JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
}

/**
 * Build an unsigned throwaway kind:9734 for a NIP-57 mint probe (no `e`/`k`).
 *
 * Used before linking a Lightning Address; the invoice is never paid and is
 * not written to `message_invoice`.
 *
 * @param args - Recipient pubkey, amount millisats, zap relays.
 * @returns Unsigned event template for `finalizeEvent`.
 */
export function buildZapProbeRequest(args: {
  recipientPubkey: string;
  amountMsat: number;
  relays: readonly string[];
}): EventTemplate {
  return {
    kind: 9734,
    content: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', args.recipientPubkey],
      ['amount', String(args.amountMsat)],
      ['relays', ...args.relays],
    ],
  };
}
