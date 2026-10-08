import { describe, expect, it } from 'vitest';
import {
  SATS_PER_BTC,
  crossForPaymentDay,
  fiatFromSats,
  fiatFromUsd,
  normalizeAmountUsd,
  paymentRateDays,
  quoteFromLargestSibling,
  shownFiatFromBody,
  parseUsdPerBtc,
  satsToBtcString,
  satsToUsdCents,
  usdCentsToFiatCents,
  usdCentsToString,
} from '@/lib/money';

describe('normalizeAmountUsd', () => {
  it('normalizes integer-cent USD values and rejects unusable values', () => {
    expect(normalizeAmountUsd('5')).toBe('5.00');
    expect(normalizeAmountUsd('5.1')).toBe('5.10');
    expect(normalizeAmountUsd('0')).toBeNull();
    expect(normalizeAmountUsd('100000.01')).toBeNull();
    expect(normalizeAmountUsd('5.001')).toBeNull();
  });
});

describe('shownFiatFromBody', () => {
  it('stays unpinned when the client sends no fiat keys', () => {
    expect(shownFiatFromBody({})).toEqual({ pinned: false });
  });

  it('pins the shown amounts and treats a missing sibling as null', () => {
    expect(shownFiatFromBody({ amountUsd: '5', amountChf: null })).toEqual({
      pinned: true,
      fiat: { usd: '5.00', chf: null, eur: null, php: null },
    });
  });

  it('accepts a zero shown amount and rejects an unusable string', () => {
    expect(shownFiatFromBody({ amountUsd: '0.00' })).toEqual({
      pinned: true,
      fiat: { usd: '0.00', chf: null, eur: null, php: null },
    });
    expect(shownFiatFromBody({ amountUsd: 'nope' })).toBeNull();
  });

  it('accepts a large peso and rejects an over-cap dollar or an unsafe cross', () => {
    expect(shownFiatFromBody({ amountUsd: '5.00', amountPhp: '500000.00' })).toEqual({
      pinned: true,
      fiat: { usd: '5.00', chf: null, eur: null, php: '500000.00' },
    });
    expect(shownFiatFromBody({ amountUsd: '100000.01' })).toBeNull();
    expect(shownFiatFromBody({ amountChf: '1.001' })).toBeNull();
    expect(shownFiatFromBody({ amountEur: '9007199254740993' })).toBeNull();
  });
});

describe('paymentRateDays', () => {
  it('returns the payment day and the previous nine', () => {
    const days = paymentRateDays('2026-10-08');
    expect(days).toHaveLength(10);
    expect(days[0]).toBe('2026-10-08');
    expect(days[1]).toBe('2026-10-07');
    expect(days[9]).toBe('2026-09-29');
  });

  it('clamps the window and rejects a day that is not a calendar date', () => {
    expect(paymentRateDays('2026-10-08', 3)).toEqual(['2026-10-08', '2026-10-07', '2026-10-06']);
    expect(paymentRateDays('2026-10-08', 0)).toEqual(['2026-10-08']);
    expect(paymentRateDays('2026-10-08', 40)).toHaveLength(10);
    expect(paymentRateDays('2026-10-08', Number.NaN)).toHaveLength(10);
    expect(paymentRateDays('nope')).toEqual([]);
    expect(paymentRateDays('2026-02-31')).toEqual([]);
    expect(paymentRateDays('2026-02-29')).toEqual([]);
    expect(paymentRateDays('2024-02-29')).toEqual([
      '2024-02-29',
      '2024-02-28',
      '2024-02-27',
      '2024-02-26',
      '2024-02-25',
      '2024-02-24',
      '2024-02-23',
      '2024-02-22',
      '2024-02-21',
      '2024-02-20',
    ]);
  });
});

describe('crossForPaymentDay', () => {
  it('fills each quote from the nearest day on or before the payment', () => {
    const book = new Map([
      ['2026-10-08', { CHF: '0.80' }],
      ['2026-10-07', { EUR: '0.90', PHP: '50' }],
      ['2026-10-09', { PHP: '99' }],
    ]);
    expect(crossForPaymentDay(book, '2026-10-08')).toEqual({
      CHF: '0.80',
      EUR: '0.90',
      PHP: '50',
    });
    expect(crossForPaymentDay(new Map(), '2026-10-08')).toEqual({});
    expect(
      crossForPaymentDay(
        new Map([
          ['2026-10-08', { PHP: 'nope', CHF: '0' }],
          ['2026-10-07', { PHP: '50', CHF: '0.80' }],
        ]),
        '2026-10-08',
      ),
    ).toEqual({ PHP: '50', CHF: '0.80' });
  });
});

describe('quoteFromLargestSibling', () => {
  it('scales from the largest positive reference and rounds half up', () => {
    const refs = [
      { usd: '1.00', quote: '60.00' },
      { usd: '3.00', quote: '188.43' },
      { usd: '0.00', quote: '999.00' },
      { usd: '10.00', quote: '0.00' },
    ];
    expect(quoteFromLargestSibling('1.00', refs)).toBe('62.81');
    expect(quoteFromLargestSibling('1.00', [{ usd: '3.00', quote: '2.50' }])).toBe('0.83');
    expect(quoteFromLargestSibling('1.00', [{ usd: '2.00', quote: '0.01' }])).toBe('0.01');
    expect(quoteFromLargestSibling('3.00', [{ usd: '3.00', quote: '2.68' }])).toBe('2.68');
  });

  it('returns null for an unusable amount and does not throw', () => {
    expect(quoteFromLargestSibling('1.00', [])).toBeNull();
    expect(quoteFromLargestSibling('0.00', [{ usd: '3.00', quote: '1.00' }])).toBeNull();
    expect(quoteFromLargestSibling('nope', [{ usd: '3.00', quote: '1.00' }])).toBeNull();
    expect(quoteFromLargestSibling('1.00', [{ usd: 'nope', quote: '1.00' }])).toBeNull();
    expect(
      quoteFromLargestSibling('90071992547409.91', [{ usd: '1.00', quote: '90071992547409.91' }]),
    ).toBeNull();
  });

  it('keeps the first reference when two have the same USD amount', () => {
    expect(
      quoteFromLargestSibling('1.00', [
        { usd: '3.00', quote: '188.43' },
        { usd: '3.00', quote: '180.00' },
      ]),
    ).toBe('62.81');
  });
});

describe('fiatFromUsd', () => {
  it('freezes USD and available crosses', () => {
    expect(fiatFromUsd('5.00', { CHF: '0.80', EUR: '0.90', PHP: '50' })).toEqual({
      usd: '5.00',
      chf: '4.00',
      eur: '4.50',
      php: '250.00',
    });
  });

  it('keeps missing crosses null', () => {
    expect(fiatFromUsd('5.00', {})).toEqual({ usd: '5.00', chf: null, eur: null, php: null });
  });

  it('rejects a non-normalized amount', () => {
    expect(() => fiatFromUsd('nope', {})).toThrow('amountUsd must be normalized');
  });
});

describe('fiatFromSats', () => {
  it('freezes spot USD and available crosses', () => {
    expect(fiatFromSats(1000, '100000', { CHF: '0.80' })).toEqual({
      usd: '1.00',
      chf: '0.80',
      eur: null,
      php: null,
    });
  });
});

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

  it('throws when cents exceed MAX_SAFE_INTEGER', () => {
    expect(() => satsToUsdCents(100_000_000, '100000000000000')).toThrow(/usd cents overflow/);
  });
});

describe('usdCentsToFiatCents', () => {
  it('converts USD cents at CHF, EUR, and PHP rates', () => {
    expect(usdCentsToFiatCents(100, '0.80')).toBe(80);
    expect(usdCentsToFiatCents(100, '0.90')).toBe(90);
    expect(usdCentsToFiatCents(100, '50')).toBe(5000);
  });

  it('rounds half-up to the nearest quote cent', () => {
    expect(usdCentsToFiatCents(1, '0.5')).toBe(1);
    expect(usdCentsToFiatCents(1, '0.4')).toBe(0);
  });

  it('rejects negative / non-integer cents', () => {
    expect(() => usdCentsToFiatCents(-1, '0.80')).toThrow(/non-negative integer/);
    expect(() => usdCentsToFiatCents(1.2, '0.80')).toThrow(/non-negative integer/);
    expect(() => usdCentsToFiatCents(Number.NaN, '0.80')).toThrow(/non-negative integer/);
  });

  it('rejects an invalid rate', () => {
    expect(() => usdCentsToFiatCents(100, '0')).toThrow(/invalid/);
    expect(() => usdCentsToFiatCents(100, '-1')).toThrow(/invalid/);
  });

  it('throws when rounded cents exceed MAX_SAFE_INTEGER', () => {
    expect(() => usdCentsToFiatCents(Number.MAX_SAFE_INTEGER, '2')).toThrow(/fiat cents overflow/);
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
