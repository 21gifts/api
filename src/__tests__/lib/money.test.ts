import { describe, expect, it } from 'vitest';
import {
  SATS_PER_BTC,
  parseUsdPerBtc,
  satsToBtcString,
  satsToUsdCents,
  usdCentsToString,
} from '@/lib/money';

describe('SATS_PER_BTC', () => {
  it('is 100 million', () => {
    expect(SATS_PER_BTC).toBe(100_000_000);
  });
});

describe('satsToBtcString', () => {
  it('formats zero and small amounts with eight decimals', () => {
    expect(satsToBtcString(0)).toBe('0.00000000');
    expect(satsToBtcString(1000)).toBe('0.00001000');
    expect(satsToBtcString(1)).toBe('0.00000001');
  });

  it('formats whole bitcoins', () => {
    expect(satsToBtcString(SATS_PER_BTC)).toBe('1.00000000');
    expect(satsToBtcString(SATS_PER_BTC + 50)).toBe('1.00000050');
  });

  it('rejects non-integers and negatives', () => {
    expect(() => satsToBtcString(1.5)).toThrow(/non-negative integer/);
    expect(() => satsToBtcString(-1)).toThrow(/non-negative integer/);
    expect(() => satsToBtcString(Number.NaN)).toThrow(/non-negative integer/);
  });
});

describe('parseUsdPerBtc', () => {
  it('scales rates with up to eight fractional digits', () => {
    expect(parseUsdPerBtc('95000')).toBe(9_500_000_000_000n);
    expect(parseUsdPerBtc('95000.12')).toBe(9_500_012_000_000n);
    expect(parseUsdPerBtc('0.00000001')).toBe(1n);
  });

  it('rounds half-up when more than eight fractional digits', () => {
    expect(parseUsdPerBtc('1.123456784')).toBe(112_345_678n);
    expect(parseUsdPerBtc('1.123456785')).toBe(112_345_679n);
  });

  it('rejects invalid or non-positive rates', () => {
    expect(() => parseUsdPerBtc('')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('0')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('0.0')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('-1')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('1e5')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('00.1')).toThrow(/invalid/);
    expect(() => parseUsdPerBtc('.5')).toThrow(/invalid/);
  });
});

describe('satsToUsdCents', () => {
  it('converts at a round USD-per-BTC rate', () => {
    // 1000 sats at $100_000/BTC → $1.00 → 100 cents
    expect(satsToUsdCents(1000, '100000')).toBe(100);
    // 1 BTC at $95_000.12 → 9_500_012 cents
    expect(satsToUsdCents(SATS_PER_BTC, '95000.12')).toBe(9_500_012);
  });

  it('rounds half-up to the nearest cent', () => {
    // Choose sats * rate so fractional cents are exactly .5
    // 1 sat at $50_000/BTC = $0.0005 = 0.05 cents → rounds to 0
    expect(satsToUsdCents(1, '50000')).toBe(0);
    // 1 sat at $150_000/BTC = $0.0015 = 0.15 cents → rounds to 0
    expect(satsToUsdCents(1, '150000')).toBe(0);
    // 5 sats at $100_000/BTC = $0.005 = 0.5 cents → half-up to 1
    expect(satsToUsdCents(5, '100000')).toBe(1);
  });

  it('rejects bad sats', () => {
    expect(() => satsToUsdCents(-1, '100000')).toThrow(/non-negative integer/);
    expect(() => satsToUsdCents(1.2, '100000')).toThrow(/non-negative integer/);
  });
});

describe('usdCentsToString', () => {
  it('formats cents with two decimals', () => {
    expect(usdCentsToString(0)).toBe('0.00');
    expect(usdCentsToString(1)).toBe('0.01');
    expect(usdCentsToString(123_456)).toBe('1234.56');
  });

  it('rejects non-integers and negatives', () => {
    expect(() => usdCentsToString(-1)).toThrow(/non-negative integer/);
    expect(() => usdCentsToString(1.5)).toThrow(/non-negative integer/);
  });
});
