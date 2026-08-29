import { describe, expect, it } from 'vitest';
import {
  buildKind0Content,
  buildKind0Event,
  buildKind1Event,
  buildKind10002Event,
  kind1Tags,
} from '@/lib/nostr/event';

describe('kind1', () => {
  it('uses frozen tags and no name prefix', () => {
    const event = buildKind1Event('hello', 1_700_000_000);
    expect(event.kind).toBe(1);
    expect(event.content).toBe('hello');
    expect(event.tags).toEqual([
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
    expect(kind1Tags()).not.toBe(event.tags);
  });
});

describe('kind0', () => {
  it('omits lud16 when the address is null', () => {
    expect(JSON.parse(buildKind0Content('Ada', null))).toEqual({
      name: 'Ada',
      display_name: 'Ada',
      website: 'https://21.gifts',
    });
    expect(buildKind0Event('Ada', null, 1).tags).toEqual([]);
  });

  it('includes lud16 when set', () => {
    expect(JSON.parse(buildKind0Content('Ada', 'ada@walletofsatoshi.com')).lud16).toBe(
      'ada@walletofsatoshi.com',
    );
  });
});

describe('kind10002', () => {
  it('emits r tags', () => {
    const event = buildKind10002Event(['wss://relay.nostr.space'], 2);
    expect(event.kind).toBe(10002);
    expect(event.tags).toEqual([['r', 'wss://relay.nostr.space']]);
  });
});
