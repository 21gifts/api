import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELAY_PUBLIC,
  DEFAULT_RELAY_SPACE_PRD,
  isNostrPublishEnabled,
  isNostrPublishPublicEnabled,
  resolveRelayPublic,
  resolveRelaySpace,
  resolveWriteSet,
  resolvePublicApiBase,
  INDEXER_RELAY_URL,
  SEARCH_RELAY_URL,
  readRelaysFromKind10002,
  replyHintRelay,
  resolveZapRelays,
  writeRelayUrls,
} from '@/lib/nostr/relays';

describe('relays', () => {
  it('treats only "1" as enabled', () => {
    expect(isNostrPublishEnabled({})).toBe(false);
    expect(isNostrPublishEnabled({ NOSTR_PUBLISH: 'true' })).toBe(false);
    expect(isNostrPublishEnabled({ NOSTR_PUBLISH: '1' })).toBe(true);
    expect(isNostrPublishPublicEnabled({ NOSTR_PUBLISH_PUBLIC: '1' })).toBe(true);
  });

  it('defaults space and public lists', () => {
    expect(resolveRelaySpace({})).toBe(DEFAULT_RELAY_SPACE_PRD);
    expect(resolveRelaySpace({ NOSTR_RELAY_SPACE: '  wss://x  ' })).toBe('wss://x');
    expect(resolveRelaySpace({ NOSTR_RELAY_URL: '  wss://dev-relay.nostr.space  ' })).toBe(
      'wss://dev-relay.nostr.space',
    );
    expect(
      resolveRelaySpace({
        NOSTR_RELAY_SPACE: 'wss://override',
        NOSTR_RELAY_URL: 'wss://dev-relay.nostr.space',
      }),
    ).toBe('wss://override');
    expect(resolveRelayPublic({})).toEqual([...DEFAULT_RELAY_PUBLIC]);
    expect(resolveRelayPublic({ NOSTR_RELAY_PUBLIC: 'wss://a, wss://b' })).toEqual([
      'wss://a',
      'wss://b',
    ]);
  });

  it('omits public urls when public flag is off', () => {
    const set = resolveWriteSet({ NOSTR_PUBLISH: '1' });
    expect(set.publishEnabled).toBe(true);
    expect(set.publicEnabled).toBe(false);
    expect(set.publicUrls).toEqual([]);
  });

  it('includes public urls when both flags are on', () => {
    const set = resolveWriteSet({ NOSTR_PUBLISH: '1', NOSTR_PUBLISH_PUBLIC: '1' });
    expect(set.publicUrls).toEqual([...DEFAULT_RELAY_PUBLIC]);
  });

  it('defaults zap relays to space plus public list', () => {
    expect(resolveZapRelays({})).toEqual([DEFAULT_RELAY_SPACE_PRD, ...DEFAULT_RELAY_PUBLIC]);
  });

  it('includes public defaults for zap relays when publish-public is off', () => {
    expect(resolveZapRelays({ NOSTR_RELAY_SPACE: 'wss://space' })).toEqual([
      'wss://space',
      ...DEFAULT_RELAY_PUBLIC,
    ]);
  });

  it('keeps the same zap relay list whether publish-public is on or off', () => {
    const base = { NOSTR_RELAY_SPACE: 'wss://space' };
    expect(resolveZapRelays(base)).toEqual(
      resolveZapRelays({ ...base, NOSTR_PUBLISH_PUBLIC: '1' }),
    );
  });

  it('honours NOSTR_RELAY_PUBLIC overrides for zap relays', () => {
    expect(
      resolveZapRelays({
        NOSTR_RELAY_SPACE: 'wss://space',
        NOSTR_RELAY_PUBLIC: 'wss://a, wss://b',
      }),
    ).toEqual(['wss://space', 'wss://a', 'wss://b']);
  });

  it('dedupes space when it also appears in the public list', () => {
    expect(
      resolveZapRelays({
        NOSTR_RELAY_SPACE: 'wss://space',
        NOSTR_RELAY_PUBLIC: 'wss://space, wss://a',
      }),
    ).toEqual(['wss://space', 'wss://a']);
  });

  it('maps site PUBLIC_BASE_URL to the API origin', () => {
    expect(resolvePublicApiBase({})).toBe('');
    expect(resolvePublicApiBase({ PUBLIC_BASE_URL: 'https://21.gifts/' })).toBe(
      'https://api.21.gifts',
    );
    expect(resolvePublicApiBase({ PUBLIC_BASE_URL: 'https://dev.21.gifts' })).toBe(
      'https://dev-api.21.gifts',
    );
    expect(resolvePublicApiBase({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000' })).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('lists write URLs from the write set', () => {
    expect(
      writeRelayUrls({
        spaceUrl: 'wss://space',
        publicUrls: ['wss://a'],
        publishEnabled: true,
        publicEnabled: false,
      }),
    ).toEqual(['wss://space']);
    expect(
      writeRelayUrls({
        spaceUrl: 'wss://space',
        publicUrls: ['wss://a'],
        publishEnabled: true,
        publicEnabled: true,
      }),
    ).toEqual(['wss://space', 'wss://a']);
  });

  it('hints the first public relay only when public publish is on', () => {
    expect(
      replyHintRelay({
        spaceUrl: 'wss://space',
        publicUrls: ['wss://a'],
        publishEnabled: true,
        publicEnabled: false,
      }),
    ).toBe('wss://space');
    expect(
      replyHintRelay({
        spaceUrl: 'wss://space',
        publicUrls: [],
        publishEnabled: true,
        publicEnabled: true,
      }),
    ).toBe('wss://space');
    expect(
      replyHintRelay({
        spaceUrl: 'wss://space',
        publicUrls: ['wss://a', 'wss://b'],
        publishEnabled: true,
        publicEnabled: true,
      }),
    ).toBe('wss://a');
  });

  it('reads kind:10002 read relays and drops write, non-wss, and dupes', () => {
    expect(
      readRelaysFromKind10002([
        ['t', 'x'],
        ['r'],
        ['r', 1 as unknown as string],
        ['r', '  wss://a  '],
        ['r', 'wss://a', 'read'],
        ['r', 'wss://b', 'write'],
        ['r', 'wss://c', 'both'],
        ['r', 'ws://d'],
        ['r', 'https://e'],
        ['r', 'wss://f'],
        ['r', 'wss://g', 'read'],
        ['r', 'wss://h'],
        ['r', 'wss://i'],
      ]),
    ).toEqual(['wss://a', 'wss://f', 'wss://g', 'wss://h']);
  });

  it('keeps the search and indexer relays out of writeRelayUrls', () => {
    const urls = writeRelayUrls(resolveWriteSet({ NOSTR_PUBLISH: '1', NOSTR_PUBLISH_PUBLIC: '1' }));
    expect(urls).not.toContain(SEARCH_RELAY_URL);
    expect(urls).not.toContain(INDEXER_RELAY_URL);
  });
});
