import { describe, it, expect } from 'vitest';
import { normalizeLightningAddress } from '@/lib/lightning-address';

describe('normalizeLightningAddress', () => {
  it('accepts a valid address', () => {
    expect(normalizeLightningAddress('alice@walletofsatoshi.com')).toBe(
      'alice@walletofsatoshi.com',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLightningAddress('  bob@getalby.com  ')).toBe('bob@getalby.com');
  });

  it('accepts local-part and sub-domain symbols', () => {
    expect(normalizeLightningAddress('a.b_c+d%e-f@sub.domain.io')).toBe(
      'a.b_c+d%e-f@sub.domain.io',
    );
  });

  it('rejects a value without an @', () => {
    expect(normalizeLightningAddress('not-an-address')).toBeNull();
  });

  it('rejects a missing local part', () => {
    expect(normalizeLightningAddress('@domain.com')).toBeNull();
  });

  it('rejects a missing domain', () => {
    expect(normalizeLightningAddress('alice@')).toBeNull();
  });

  it('rejects a domain without a TLD', () => {
    expect(normalizeLightningAddress('alice@localhost')).toBeNull();
  });

  it('rejects an over-long address', () => {
    expect(normalizeLightningAddress(`${'a'.repeat(300)}@example.com`)).toBeNull();
  });
});
