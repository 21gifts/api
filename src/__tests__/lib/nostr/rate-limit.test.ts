import { describe, expect, it } from 'vitest';
import {
  HEART_HOUR_CAP,
  HEART_NOTE_COOLDOWN_MS,
  HeartRateLimiter,
  InvoiceRateLimiter,
  PostRateLimiter,
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

  it('evicts idle invoice keys after 48h', () => {
    const limiter = new InvoiceRateLimiter();
    expect(limiter.allow('idle', 0)).toBe(true);
    expect(limiter.allow('idle', 48 * 60 * 60 * 1000 + 1)).toBe(true);
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
