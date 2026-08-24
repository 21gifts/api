import { describe, it, expect } from 'vitest';
import { randomHex } from '@/lib/auth/hex';

describe('randomHex', () => {
  it('returns 64 lowercase hex chars for 32 bytes', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns independent values', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});
