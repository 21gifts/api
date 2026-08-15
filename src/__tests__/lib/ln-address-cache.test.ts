import { describe, it, expect } from 'vitest';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { InMemoryLnAddressCache, type CachedLnAddress } from '@/lib/ln-address-cache';

const ENTRY: CachedLnAddress = {
  address: 'alice@walletofsatoshi.com',
  callback: 'https://walletofsatoshi.com/lnurlp/callback',
  minSendable: 1000,
  maxSendable: 100_000_000_000,
  commentAllowed: 255,
};

describe('InMemoryLnAddressCache', () => {
  it('returns a put entry on get (cache hit)', () => {
    const cache = new InMemoryLnAddressCache();
    const t0 = 1_000_000;
    cache.put(ENTRY, t0);
    expect(cache.get(ENTRY.address, t0)).toEqual(ENTRY);
  });

  it('returns null for a missing key', () => {
    const cache = new InMemoryLnAddressCache();
    expect(cache.get('nobody@example.com', 1_000_000)).toBeNull();
  });

  it('returns null when now is past the TTL', () => {
    const cache = new InMemoryLnAddressCache();
    const t0 = 1_000_000;
    cache.put(ENTRY, t0);
    expect(cache.get(ENTRY.address, t0 + LN_ADDRESS_CACHE_TTL_MS)).toBeNull();
    expect(cache.get(ENTRY.address, t0 + LN_ADDRESS_CACHE_TTL_MS - 1)).toEqual(ENTRY);
  });

  it('honors a custom ttlMs constructor argument', () => {
    const cache = new InMemoryLnAddressCache(100);
    cache.put(ENTRY, 0);
    expect(cache.get(ENTRY.address, 99)).toEqual(ENTRY);
    expect(cache.get(ENTRY.address, 100)).toBeNull();
  });

  it('overwrites an existing entry on put', () => {
    const cache = new InMemoryLnAddressCache();
    cache.put(ENTRY, 1_000_000);
    const updated: CachedLnAddress = {
      ...ENTRY,
      minSendable: 2000,
      callback: 'https://walletofsatoshi.com/lnurlp/callback-v2',
    };
    cache.put(updated, 1_000_001);
    expect(cache.get(ENTRY.address, 1_000_001)).toEqual(updated);
  });
});
