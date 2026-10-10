import { describe, expect, it } from 'vitest';
import { IP_RATE_WINDOW_MS, IpRateLimiter } from '@/lib/ip-rate-limit';

describe('IpRateLimiter', () => {
  it('allows up to the limit and refuses the next hit', () => {
    const limiter = new IpRateLimiter(2);
    const t0 = 1_000_000;
    expect(limiter.allow('1.1.1.1', t0)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0 + 1)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0 + 2)).toBe(false);
  });

  it('allows again after the window slides past the earliest hits', () => {
    const limiter = new IpRateLimiter(1);
    const t0 = 1_000_000;
    expect(limiter.allow('1.1.1.1', t0)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0 + 1)).toBe(false);
    expect(limiter.allow('1.1.1.1', t0 + IP_RATE_WINDOW_MS)).toBe(true);
  });

  it('keeps separate addresses independent', () => {
    const limiter = new IpRateLimiter(1);
    const t0 = 1_000_000;
    expect(limiter.allow('1.1.1.1', t0)).toBe(true);
    expect(limiter.allow('2.2.2.2', t0)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0 + 1)).toBe(false);
    expect(limiter.allow('2.2.2.2', t0 + 1)).toBe(false);
  });

  it('always allows a null client address and never counts it', () => {
    const limiter = new IpRateLimiter(1);
    const t0 = 1_000_000;
    expect(limiter.allow(null, t0)).toBe(true);
    expect(limiter.allow(null, t0 + 1)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0)).toBe(true);
    expect(limiter.allow('1.1.1.1', t0 + 1)).toBe(false);
  });

  it('forgets hits older than the window and keeps counting newer ones across a sweep', () => {
    const limiter = new IpRateLimiter(2);
    const t0 = 1_000_000;
    const A = '1.1.1.1';
    const B = '2.2.2.2';
    const C = '3.3.3.3';
    expect(limiter.allow(A, t0)).toBe(true);
    // First call swept at t0; this call is still inside the window, so no second sweep.
    expect(limiter.allow(B, t0 + 30_000)).toBe(true);
    // Full window elapsed: sweep removes A (expired) and keeps B (hit at t0+30_000).
    expect(limiter.allow(C, t0 + 60_000)).toBe(true);
    expect(limiter.allow(B, t0 + 60_000)).toBe(true);
    expect(limiter.allow(B, t0 + 60_000)).toBe(false);
    expect(limiter.allow(A, t0 + 60_000)).toBe(true);
  });

  it('keeps refusing an address inside the window while other addresses are served', () => {
    const limiter = new IpRateLimiter(1);
    const t0 = 1_000_000;
    const E = '5.5.5.5';
    const F = '6.6.6.6';
    expect(limiter.allow(E, t0)).toBe(true);
    expect(limiter.allow(E, t0 + 1)).toBe(false);
    expect(limiter.allow(F, t0 + 2)).toBe(true);
    expect(limiter.allow(E, t0 + 3)).toBe(false);
  });

  it('exports a one-minute window', () => {
    expect(IP_RATE_WINDOW_MS).toBe(60_000);
  });
});
