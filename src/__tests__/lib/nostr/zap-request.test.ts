import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, type VerifiedEvent } from 'nostr-tools/pure';
import {
  buildZapProbeRequest,
  buildZapRequest,
  serializeZapRequest,
} from '@/lib/nostr/zap-request';

const NIP01_KEYS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'] as const;

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

  it('puts optional content on the zap request', () => {
    const event = buildZapRequest({
      recipientPubkey: 'aa'.repeat(32),
      eventId: 'ee'.repeat(32),
      amountMsat: 21_000,
      relays: ['wss://relay.nostr.space'],
      content: 'thank you',
    });
    expect(event.content).toBe('thank you');
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

describe('serializeZapRequest', () => {
  function signedZap(content = ''): VerifiedEvent {
    return finalizeEvent(
      buildZapRequest({
        recipientPubkey: 'aa'.repeat(32),
        eventId: 'ee'.repeat(32),
        amountMsat: 21_000,
        relays: ['wss://relay.nostr.space'],
        content,
      }),
      generateSecretKey(),
    );
  }

  it('uses the NIP-01 field order', () => {
    const out = serializeZapRequest(signedZap());
    expect(Object.keys(JSON.parse(out))).toEqual([...NIP01_KEYS]);
  });

  it('drops extra enumerable properties', () => {
    const event = signedZap();
    Object.assign(event, { extra: 'drop-me' });
    const out = serializeZapRequest(event);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...NIP01_KEYS]);
    expect(Object.keys(parsed)).toHaveLength(7);
    expect(parsed).not.toHaveProperty('extra');
  });

  it.each([
    ['umlauts', 'äöüÄÖÜß'],
    ['double quote', 'say "hi"'],
    ['single quote', "it's fine"],
    ['backslash', 'a\\b'],
    ['emoji', '⚡🎁'],
    ['newline', 'line1\nline2'],
    ['tab', 'col1\tcol2'],
    ['html', '<b>&amp;</b>'],
    ['line separator', 'before\u2028after'],
  ])('round-trips content with %s', (_label, content) => {
    const event = signedZap(content);
    const out = serializeZapRequest(event);
    expect(JSON.parse(out)).toEqual({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    });
  });
});
