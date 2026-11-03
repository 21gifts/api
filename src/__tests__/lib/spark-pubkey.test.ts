import { describe, expect, it } from 'vitest';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';

describe('normalizeSparkPubkey', () => {
  it('accepts a valid 02-prefixed compressed key', () => {
    expect(normalizeSparkPubkey(`02${'a'.repeat(64)}`)).toBe(`02${'a'.repeat(64)}`);
  });

  it('accepts a valid 03-prefixed compressed key', () => {
    expect(normalizeSparkPubkey(`03${'b'.repeat(64)}`)).toBe(`03${'b'.repeat(64)}`);
  });

  it('trims and lower-cases upper-case input', () => {
    expect(normalizeSparkPubkey(`  02${'A'.repeat(64)}  `)).toBe(`02${'a'.repeat(64)}`);
  });

  it('rejects the wrong length', () => {
    expect(normalizeSparkPubkey(`02${'a'.repeat(63)}`)).toBeNull();
    expect(normalizeSparkPubkey(`02${'a'.repeat(65)}`)).toBeNull();
  });

  it('rejects a wrong prefix', () => {
    expect(normalizeSparkPubkey(`04${'a'.repeat(64)}`)).toBeNull();
    expect(normalizeSparkPubkey(`01${'a'.repeat(64)}`)).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeSparkPubkey(`02${'g'.repeat(64)}`)).toBeNull();
    expect(normalizeSparkPubkey(`02${'a'.repeat(63)}z`)).toBeNull();
  });
});
