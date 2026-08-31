import { describe, expect, it } from 'vitest';
import { buildZapProbeRequest, buildZapRequest } from '@/lib/nostr/zap-request';

describe('buildZapRequest', () => {
  it('builds kind 9734 with p/e/k/amount/relays', () => {
    const event = buildZapRequest({
      recipientPubkey: 'aa'.repeat(32),
      eventId: 'ee'.repeat(32),
      amountMsat: 21_000,
      relays: ['wss://relay.nostr.space'],
    });
    expect(event.kind).toBe(9734);
    expect(event.content).toBe('');
    expect(event.tags.find((tag) => tag[0] === 'amount')?.[1]).toBe('21000');
    expect(event.tags.find((tag) => tag[0] === 'e')?.[1]).toBe('ee'.repeat(32));
  });
});

describe('buildZapProbeRequest', () => {
  it('builds kind 9734 with p/amount/relays and without e/k', () => {
    const event = buildZapProbeRequest({
      recipientPubkey: 'aa'.repeat(32),
      amountMsat: 1000,
      relays: ['wss://relay.nostr.space', 'wss://relay.damus.io'],
    });
    expect(event.kind).toBe(9734);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['p', 'aa'.repeat(32)],
      ['amount', '1000'],
      ['relays', 'wss://relay.nostr.space', 'wss://relay.damus.io'],
    ]);
    expect(event.tags.some((tag) => tag[0] === 'e')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'k')).toBe(false);
  });
});
