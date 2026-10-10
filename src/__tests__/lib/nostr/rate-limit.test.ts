import { describe, expect, it } from 'vitest';
import {
  HEART_HOUR_CAP,
  HEART_NOTE_COOLDOWN_MS,
  HeartRateLimiter,
  INVOICE_BURST_CAP,
  INVOICE_HOUR_CAP,
  InvoiceRateLimiter,
  PostRateLimiter,
  resolveTestInvoiceRateCaps,
  utcDayKey,
} from '@/lib/nostr/rate-limit';

describe('utcDayKey', () => {
  it('uses UTC calendar day', () => {
    expect(utcDayKey(Date.parse('2026-08-29T23:00:00.000Z'))).toBe('2026-08-29');
  });
});

describe('PostRateLimiter', () => {
  it('allows the first post and rejects a burst', () => {
    const limiter = new PostRateLimiter();
    const t0 = 1_000_000;
    expect(limiter.allow('a', t0)).toBe(true);
    expect(limiter.allow('a', t0 + 100)).toBe(false);
    expect(limiter.allow('b', t0 + 100)).toBe(true);
  });

  it('allows again after the 10s window', () => {
    const limiter = new PostRateLimiter();
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 10_000)).toBe(true);
  });

  it('evicts idle keys after 48h', () => {
    const limiter = new PostRateLimiter();
    expect(limiter.allow('idle', 0)).toBe(true);
    expect(limiter.allow('idle', 48 * 60 * 60 * 1000 + 1)).toBe(true);
  });
});

describe('InvoiceRateLimiter', () => {
  it('allows then rejects in the burst window', () => {
    const limiter = new InvoiceRateLimiter();
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 1)).toBe(false);
    expect(limiter.allow('a', 10_000)).toBe(true);
  });

  it('rejects a 21st invoice in the hour window', () => {
    const limiter = new InvoiceRateLimiter();
    for (let i = 0; i < INVOICE_HOUR_CAP; i += 1) {
      expect(limiter.allow('a', i * 10_000)).toBe(true);
    }
    expect(limiter.allow('a', INVOICE_HOUR_CAP * 10_000)).toBe(false);
  });

  it('honours injected burst and hour caps', () => {
    const limiter = new InvoiceRateLimiter({ burstCap: 2, hourCap: 3 });
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 1)).toBe(true);
    expect(limiter.allow('a', 2)).toBe(false);
    expect(limiter.allow('a', 10_000)).toBe(true);
    expect(limiter.allow('a', 20_000)).toBe(false);
  });

  it('evicts idle invoice keys after 48h', () => {
    const limiter = new InvoiceRateLimiter();
    expect(limiter.allow('idle', 0)).toBe(true);
    expect(limiter.allow('idle', 48 * 60 * 60 * 1000 + 1)).toBe(true);
  });
});

const LOCAL_TEST_ENV = {
  BIND_ADDR: '127.0.0.1:3000',
  WEBAUTHN_RP_ID: 'localhost',
};

describe('resolveTestInvoiceRateCaps', () => {
  it('returns null when both values are unset or blank', () => {
    expect(resolveTestInvoiceRateCaps({})).toBeNull();
    expect(resolveTestInvoiceRateCaps({ TEST_INVOICE_BURST_CAP: '  ' })).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        ...LOCAL_TEST_ENV,
        TEST_INVOICE_BURST_CAP: '',
        TEST_INVOICE_HOUR_CAP: '  ',
      }),
    ).toBeNull();
  });

  it('returns null when the bind host is not loopback, without parsing', () => {
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        WEBAUTHN_RP_ID: 'localhost',
      }),
    ).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '',
        WEBAUTHN_RP_ID: 'localhost',
      }),
    ).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '0.0.0.0:3000',
        WEBAUTHN_RP_ID: 'localhost',
      }),
    ).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '10.0.0.1:3000',
        WEBAUTHN_RP_ID: 'localhost',
      }),
    ).toBeNull();
  });

  it('returns null when WEBAUTHN_RP_ID is not localhost, without parsing', () => {
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '127.0.0.1:3000',
      }),
    ).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '127.0.0.1:3000',
        WEBAUTHN_RP_ID: '21.gifts',
      }),
    ).toBeNull();
    expect(
      resolveTestInvoiceRateCaps({
        TEST_INVOICE_BURST_CAP: 'nope',
        BIND_ADDR: '127.0.0.1:3000',
        WEBAUTHN_RP_ID: '  ',
      }),
    ).toBeNull();
  });

  it('uses the default for a blank cap when the other is set', () => {
    expect(resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_BURST_CAP: '8' })).toEqual({
      burstCap: 8,
      hourCap: INVOICE_HOUR_CAP,
    });
    expect(resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_HOUR_CAP: '50' })).toEqual({
      burstCap: INVOICE_BURST_CAP,
      hourCap: 50,
    });
    expect(
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_BURST_CAP: '  8  ' }),
    ).toEqual({ burstCap: 8, hourCap: INVOICE_HOUR_CAP });
  });

  it('throws on invalid text', () => {
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_BURST_CAP: '1e2' }),
    ).toThrowError('TEST_INVOICE_BURST_CAP must be an integer from 1 to 100000');
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_HOUR_CAP: '20.5' }),
    ).toThrowError('TEST_INVOICE_HOUR_CAP must be an integer from 20 to 100000');
  });

  it('throws below the default', () => {
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_BURST_CAP: '0' }),
    ).toThrowError('TEST_INVOICE_BURST_CAP must be an integer from 1 to 100000');
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_HOUR_CAP: '19' }),
    ).toThrowError('TEST_INVOICE_HOUR_CAP must be an integer from 20 to 100000');
  });

  it('throws above 100000', () => {
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_BURST_CAP: '100001' }),
    ).toThrowError('TEST_INVOICE_BURST_CAP must be an integer from 1 to 100000');
    expect(() =>
      resolveTestInvoiceRateCaps({ ...LOCAL_TEST_ENV, TEST_INVOICE_HOUR_CAP: '100001' }),
    ).toThrowError('TEST_INVOICE_HOUR_CAP must be an integer from 20 to 100000');
  });

  it('returns both caps on a gated boot', () => {
    expect(
      resolveTestInvoiceRateCaps({
        ...LOCAL_TEST_ENV,
        TEST_INVOICE_BURST_CAP: '5',
        TEST_INVOICE_HOUR_CAP: '100',
      }),
    ).toEqual({ burstCap: 5, hourCap: 100 });
    expect(
      resolveTestInvoiceRateCaps({
        BIND_ADDR: 'localhost:3000',
        WEBAUTHN_RP_ID: ' localhost ',
        TEST_INVOICE_BURST_CAP: '1',
        TEST_INVOICE_HOUR_CAP: '20',
      }),
    ).toEqual({ burstCap: 1, hourCap: 20 });
    expect(
      resolveTestInvoiceRateCaps({
        BIND_ADDR: '::1:3000',
        WEBAUTHN_RP_ID: 'localhost',
        TEST_INVOICE_BURST_CAP: '100000',
        TEST_INVOICE_HOUR_CAP: '100000',
      }),
    ).toEqual({ burstCap: 100000, hourCap: 100000 });
    expect(
      resolveTestInvoiceRateCaps({
        BIND_ADDR: '[::1]:3000',
        WEBAUTHN_RP_ID: 'localhost',
        TEST_INVOICE_BURST_CAP: '2',
      }),
    ).toEqual({ burstCap: 2, hourCap: INVOICE_HOUR_CAP });
    expect(
      resolveTestInvoiceRateCaps({
        BIND_ADDR: '127.0.0.1',
        WEBAUTHN_RP_ID: 'localhost',
        TEST_INVOICE_BURST_CAP: '3',
      }),
    ).toEqual({ burstCap: 3, hourCap: INVOICE_HOUR_CAP });
  });
});

describe('HeartRateLimiter', () => {
  it('allows one heart per note per cooldown and other notes meanwhile', () => {
    const limiter = new HeartRateLimiter();
    const t0 = 1_000_000;
    expect(limiter.allow('a', 'n1', t0)).toBe(true);
    expect(limiter.allow('a', 'n1', t0 + 100)).toBe(false);
    expect(limiter.allow('a', 'n2', t0 + 100)).toBe(true);
    expect(limiter.allow('b', 'n1', t0 + 100)).toBe(true);
    expect(limiter.allow('a', 'n1', t0 + HEART_NOTE_COOLDOWN_MS)).toBe(true);
  });

  it('caps hearts per account per hour across notes', () => {
    const limiter = new HeartRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < HEART_HOUR_CAP; i += 1) {
      expect(limiter.allow('a', `n${i}`, t0 + i)).toBe(true);
    }
    expect(limiter.allow('a', 'fresh', t0 + HEART_HOUR_CAP)).toBe(false);
    expect(limiter.allow('b', 'fresh', t0 + HEART_HOUR_CAP)).toBe(true);
    expect(limiter.allow('a', 'fresh', t0 + 60 * 60 * 1000)).toBe(true);
  });

  it('does not share a budget with the invoice limiter', () => {
    const hearts = new HeartRateLimiter();
    const invoices = new InvoiceRateLimiter();
    expect(invoices.allow('a', 1_000_000)).toBe(true);
    expect(hearts.allow('a', 'n1', 1_000_000)).toBe(true);
    expect(invoices.allow('a', 1_000_001)).toBe(false);
    expect(hearts.allow('a', 'n2', 1_000_001)).toBe(true);
  });

  it('evicts idle heart keys after 48h', () => {
    const limiter = new HeartRateLimiter();
    expect(limiter.allow('idle', 'n1', 0)).toBe(true);
    expect(limiter.allow('idle', 'n1', 48 * 60 * 60 * 1000 + 1)).toBe(true);
  });
});
