import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { normalizeHex32, preimageMatchesHash } from '@/lib/proof';

const PREIMAGE = '11'.repeat(32);
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

describe('normalizeHex32', () => {
  it('accepts 64 hex chars any case and trims', () => {
    expect(normalizeHex32(` ${PREIMAGE.toUpperCase()} `)).toBe(PREIMAGE);
  });

  it('rejects the wrong length', () => {
    expect(normalizeHex32('aa')).toBeNull();
  });

  it('rejects non-hex', () => {
    expect(normalizeHex32('zz'.repeat(32))).toBeNull();
  });
});

describe('preimageMatchesHash', () => {
  it('returns true when sha256(preimage) equals the hash', () => {
    expect(preimageMatchesHash(PREIMAGE, HASH)).toBe(true);
  });

  it('returns false for a different preimage', () => {
    expect(preimageMatchesHash('22'.repeat(32), HASH)).toBe(false);
  });

  it('returns false for malformed hex', () => {
    expect(preimageMatchesHash('nope', HASH)).toBe(false);
    expect(preimageMatchesHash(PREIMAGE, 'nope')).toBe(false);
  });
});
