import type { EventTemplate } from 'nostr-tools/pure';

/**
 * Build an unsigned kind:9734 zap request (not published to relays).
 *
 * @param args - Recipient pubkey, event id, amount millisats, write relays.
 * @returns Unsigned event template for `finalizeEvent`.
 */
export function buildZapRequest(args: {
  recipientPubkey: string;
  eventId: string;
  amountMsat: number;
  relays: readonly string[];
}): EventTemplate {
  return {
    kind: 9734,
    content: '',
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
