import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { buildZapReceipt, zapReceiptSecretKey } from '@/lib/nostr/zap-receipt';

const forcedDigests = vi.hoisted(() => [] as Buffer[]);

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHmac: (...args: Parameters<typeof actual.createHmac>) => {
      const real = actual.createHmac(...args);
      const forced = forcedDigests.shift();
      if (forced === undefined) {
        return real;
      }
      const fake = {
        update: () => fake,
        digest: () => forced,
      };
      return fake;
    },
  };
});

const NSEC = new Uint8Array(32).fill(0x11);
const OWNER = '0209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5';
const SECRET = '7823f7b8c202c55e269847820ffba23124488eb04bec549b3e95cb6cd6b36205';
const PUBKEY = '5b70420d181375ab9972fcc465486a20833999ad1101e0f4332e832e41292619';
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

afterEach(() => {
  forcedDigests.length = 0;
});

describe('zapReceiptSecretKey', () => {
  it('matches the test vector', () => {
    const secret = zapReceiptSecretKey(NSEC, OWNER);
    expect(hexOf(secret)).toBe(SECRET);
    expect(getPublicKey(secret)).toBe(PUBKEY);
  });

  it('lower-cases the wallet key', () => {
    expect(hexOf(zapReceiptSecretKey(NSEC, OWNER.toUpperCase()))).toBe(SECRET);
  });

  it('increments the counter while the digest is not a valid secret key', () => {
    forcedDigests.push(Buffer.alloc(32, 0xff), Buffer.alloc(32, 0));
    const secret = zapReceiptSecretKey(NSEC, OWNER);
    expect(forcedDigests).toHaveLength(0);
    expect(secret.byteLength).toBe(32);
    expect(hexOf(secret)).not.toBe(SECRET);
  });

  it('throws when no counter value yields a valid key', () => {
    for (let i = 0; i < 256; i += 1) {
      forcedDigests.push(Buffer.alloc(32, 0));
    }
    expect(() => zapReceiptSecretKey(NSEC, OWNER)).toThrow('No valid zap receipt key');
  });
});

describe('buildZapReceipt', () => {
  const secretKey = Uint8Array.from(Buffer.from(SECRET, 'hex'));
  const requester = 'aa'.repeat(32);
  const recipient = 'bb'.repeat(32);
  const noteId = 'cc'.repeat(32);
  const request = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: 'dd'.repeat(32),
      pubkey: requester,
      created_at: 1,
      kind: 9734,
      tags: [
        'junk',
        ['p', ''],
        ['p', recipient],
        ['e', noteId],
        ['relays', 'wss://a', 'wss://b', 'wss://a', '', 7],
        ['relays', 'wss://c'],
        ['amount', '21000'],
      ],
      content: 'hi',
      sig: 'ee'.repeat(64),
      ...overrides,
    });

  it('signs a kind 9735 receipt with the NIP-57 tags', () => {
    const zapRequestJson = request();
    const built = buildZapReceipt({
      secretKey,
      bolt11: 'lnbc21n1',
      zapRequestJson,
    });
    expect(built).not.toBeNull();
    const event = built?.event;
    expect(event?.kind).toBe(9735);
    expect(event?.content).toBe('');
    expect(event?.created_at).toBe(1);
    expect(event?.pubkey).toBe(PUBKEY);
    expect(event?.tags).toEqual([
      ['p', recipient],
      ['P', requester],
      ['e', noteId],
      ['bolt11', 'lnbc21n1'],
      ['description', zapRequestJson],
    ]);
    expect(verifyEvent(event as Parameters<typeof verifyEvent>[0])).toBe(true);
    expect(built?.relays).toEqual(['wss://a', 'wss://b', 'wss://c']);
  });

  it('gives the same receipt id for the same zap invoice', () => {
    const args = { secretKey, bolt11: 'lnbc21n1', zapRequestJson: request() };
    expect(buildZapReceipt(args)?.event.id).toBe(buildZapReceipt(args)?.event.id);
  });

  it('omits the e tag when the zap request has none', () => {
    const built = buildZapReceipt({
      secretKey,
      bolt11: 'lnbc1',
      zapRequestJson: request({ tags: [['p', recipient]] }),
    });
    expect(built?.event.tags.map((t) => t[0])).toEqual(['p', 'P', 'bolt11', 'description']);
    expect(built?.relays).toEqual([]);
  });

  it('returns null for an unusable zap request', () => {
    const args = { secretKey, bolt11: 'lnbc1' };
    expect(buildZapReceipt({ ...args, zapRequestJson: '{' })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: 'null' })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: '"x"' })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: '[]' })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ kind: 1 }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ pubkey: 5 }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ created_at: '1' }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ created_at: 1.5 }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ created_at: -1 }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ tags: [] }) })).toBeNull();
    expect(buildZapReceipt({ ...args, zapRequestJson: request({ tags: 'x' }) })).toBeNull();
  });
});
