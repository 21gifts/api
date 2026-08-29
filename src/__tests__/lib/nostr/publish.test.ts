import { describe, expect, it } from 'vitest';
import { publicAcked, RecordingPublisher, spaceAcked } from '@/lib/nostr/publish';

describe('RecordingPublisher', () => {
  it('records calls and ACKs each URL', async () => {
    const pub = new RecordingPublisher();
    const acks = await pub.publish({ id: 'e' }, ['wss://a', 'wss://b'], 5);
    expect(pub.calls).toHaveLength(1);
    expect(acks.every((ack) => ack.ok)).toBe(true);
    pub.ok = false;
    const nacks = await pub.publish({ id: 'e' }, ['wss://a'], 5);
    expect(nacks[0]?.ok).toBe(false);
  });
});

describe('ack helpers', () => {
  const space = 'wss://relay.nostr.space';
  it('detects space and public', () => {
    const acks = [
      { url: space, ok: true },
      { url: 'wss://relay.damus.io', ok: true },
    ];
    expect(spaceAcked(acks, space)).toBe(true);
    expect(publicAcked(acks, space)).toBe(true);
    expect(publicAcked([{ url: space, ok: true }], space)).toBe(false);
    expect(spaceAcked([{ url: space, ok: false }], space)).toBe(false);
  });
});
