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
