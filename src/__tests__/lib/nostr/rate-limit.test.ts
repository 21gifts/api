import { describe, expect, it } from 'vitest';
import { InvoiceRateLimiter, PostRateLimiter, utcDayKey } from '@/lib/nostr/rate-limit';

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

  it('evicts idle invoice keys after 48h', () => {
    const limiter = new InvoiceRateLimiter();
    expect(limiter.allow('idle', 0)).toBe(true);
    expect(limiter.allow('idle', 48 * 60 * 60 * 1000 + 1)).toBe(true);
  });
});
