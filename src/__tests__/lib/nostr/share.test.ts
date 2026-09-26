import { describe, expect, it } from 'vitest';
import { decode } from 'nostr-tools/nip19';
import {
  DEFAULT_RELAY_PUBLIC,
  DEFAULT_RELAY_SPACE_PRD,
  INDEXER_RELAY_URL,
  SEARCH_RELAY_URL,
} from '@/lib/nostr/relays';
import { nostrNoteUri, publicNoteRelays } from '@/lib/nostr/share';

const EVENT_ID = 'ab'.repeat(32);
const AUTHOR_PUBKEY = 'cd'.repeat(32);

function decodedNevent(uri: string): { id: string; author?: string; relays?: string[] } {
  const decoded = decode(uri);
  if (decoded.type !== 'nevent') {
    throw new Error(decoded.type);
  }
  return decoded.data;
}

describe('nostrNoteUri', () => {
  it('encodes nostr:nevent with id, author, and relays', () => {
    const relays = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
    const uri = nostrNoteUri(EVENT_ID, AUTHOR_PUBKEY, relays);
    expect(uri?.startsWith('nostr:')).toBe(true);
    const decoded = decodedNevent(uri!.slice('nostr:'.length));
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.author).toBe(AUTHOR_PUBKEY);
    expect(decoded.relays).toEqual(relays);
  });

  it('returns null when event id or pubkey is missing or not 64 lowercase hex', () => {
    const relays = ['wss://relay.damus.io'];
    expect(nostrNoteUri(null, AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(undefined, AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri('', AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, null, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, undefined, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, '', relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID.slice(0, 63), AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(`${EVENT_ID}a`, AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(`g${EVENT_ID.slice(1)}`, AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, AUTHOR_PUBKEY.slice(0, 63), relays)).toBeNull();
  });

  it('returns null for uppercase or mixed-case hex', () => {
    const relays = ['wss://relay.damus.io'];
    expect(nostrNoteUri(EVENT_ID.toUpperCase(), AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, AUTHOR_PUBKEY.toUpperCase(), relays)).toBeNull();
    expect(nostrNoteUri(`A${EVENT_ID.slice(1)}`, AUTHOR_PUBKEY, relays)).toBeNull();
    expect(nostrNoteUri(EVENT_ID, `B${AUTHOR_PUBKEY.slice(1)}`, relays)).toBeNull();
  });

  it('filters relay hints: wss only, trim, first-wins dedupe, cap 3', () => {
    const uri = nostrNoteUri(EVENT_ID, AUTHOR_PUBKEY, [
      '  ',
      'https://example.com',
      'ws://insecure.example',
      'wss://a.example',
      'wss://a.example',
      '  wss://b.example  ',
      'wss://c.example',
      'wss://d.example',
    ]);
    expect(uri?.startsWith('nostr:')).toBe(true);
    const decoded = decodedNevent(uri!.slice('nostr:'.length));
    expect(decoded.id).toBe(EVENT_ID);
    expect(decoded.author).toBe(AUTHOR_PUBKEY);
    expect(decoded.relays).toEqual(['wss://a.example', 'wss://b.example', 'wss://c.example']);

    const empty = nostrNoteUri(EVENT_ID, AUTHOR_PUBKEY, []);
    expect(empty?.startsWith('nostr:')).toBe(true);
    const emptyDecoded = decodedNevent(empty!.slice('nostr:'.length));
    expect(emptyDecoded.id).toBe(EVENT_ID);
    expect(emptyDecoded.author).toBe(AUTHOR_PUBKEY);
    expect(emptyDecoded.relays ?? []).toEqual([]);
  });
});

describe('publicNoteRelays', () => {
  it('returns the three default public relays when public publish is on', () => {
    const urls = publicNoteRelays({ NOSTR_PUBLISH_PUBLIC: '1' });
    expect(urls).toEqual([...DEFAULT_RELAY_PUBLIC]);
    expect(urls).not.toContain('wss://relay.nostr.space');
    expect(urls).not.toContain(SEARCH_RELAY_URL);
    expect(urls).not.toContain(INDEXER_RELAY_URL);
  });

  it('returns only the durability relay when public publish is off', () => {
    expect(publicNoteRelays({})).toEqual([DEFAULT_RELAY_SPACE_PRD]);
    expect(publicNoteRelays({ NOSTR_PUBLISH: '1' })).toEqual([DEFAULT_RELAY_SPACE_PRD]);
  });

  it('honours NOSTR_RELAY_SPACE when public publish is off', () => {
    expect(publicNoteRelays({ NOSTR_RELAY_SPACE: 'wss://custom-space.example' })).toEqual([
      'wss://custom-space.example',
    ]);
  });

  it('honours NOSTR_RELAY_PUBLIC when public publish is on and omits space', () => {
    const urls = publicNoteRelays({
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_PUBLIC: 'wss://a.example, wss://b.example',
    });
    expect(urls).toEqual(['wss://a.example', 'wss://b.example']);
    expect(urls).not.toContain(DEFAULT_RELAY_SPACE_PRD);
    expect(urls).not.toContain('wss://relay.nostr.space');
  });
});
