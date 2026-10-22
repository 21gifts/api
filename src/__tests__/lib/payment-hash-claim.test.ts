import { describe, expect, it } from 'vitest';
import {
  PAYMENT_HASH_CLAIM_SQL,
  PAYMENT_HASH_LOCK_NAMESPACE,
  PaymentHashClaims,
  paymentHashLockKey,
} from '@/lib/payment-hash-claim';

describe('paymentHashLockKey', () => {
  it('is the first 32 bits of the hash as a signed 32-bit integer', () => {
    expect(paymentHashLockKey(`ffffffff${'0'.repeat(56)}`)).toBe(-1);
    expect(paymentHashLockKey(`00000000${'f'.repeat(56)}`)).toBe(0);
    expect(paymentHashLockKey(`7fffffff${'0'.repeat(56)}`)).toBe(2_147_483_647);
    expect(paymentHashLockKey(`80000000${'0'.repeat(56)}`)).toBe(-2_147_483_648);
    expect(paymentHashLockKey(`0000002a${'1'.repeat(56)}`)).toBe(42);
  });

  it('gives two hashes that share their first 32 bits the same key', () => {
    expect(paymentHashLockKey(`deadbeef${'1'.repeat(56)}`)).toBe(
      paymentHashLockKey(`deadbeef${'2'.repeat(56)}`),
    );
    expect(paymentHashLockKey(`deadbeef${'1'.repeat(56)}`)).not.toBe(
      paymentHashLockKey(`deadbeee${'1'.repeat(56)}`),
    );
  });

  it('gives 0 for text that is not hex', () => {
    expect(paymentHashLockKey('h1')).toBe(0);
  });
});

describe('PAYMENT_HASH_LOCK_NAMESPACE', () => {
  it('is a fixed signed 32-bit integer used with the two-key advisory lock', () => {
    expect(PAYMENT_HASH_LOCK_NAMESPACE | 0).toBe(PAYMENT_HASH_LOCK_NAMESPACE);
    expect(PAYMENT_HASH_CLAIM_SQL).toBe('SELECT pg_advisory_xact_lock($1, $2)');
  });
});

describe('PaymentHashClaims', () => {
  it('records the charge side and the shop side of one hash', () => {
    const claims = new PaymentHashClaims();
    expect(claims.holder('h')).toBeNull();
    claims.claimCharge('h', 'c1');
    expect(claims.holder('h')).toEqual({ chargeId: 'c1', paymentId: null, paymentChargeId: null });
    claims.claimShop('h', 'p1', 'c1');
    expect(claims.holder('h')).toEqual({ chargeId: 'c1', paymentId: 'p1', paymentChargeId: 'c1' });
    claims.claimShop('payer', 'p2', null);
    expect(claims.holder('payer')).toEqual({
      chargeId: null,
      paymentId: 'p2',
      paymentChargeId: null,
    });
    claims.claimCharge('payer', 'c2');
    expect(claims.holder('payer')?.chargeId).toBe('c2');
  });

  it('hands out copies', () => {
    const claims = new PaymentHashClaims();
    claims.claimCharge('h', 'c1');
    const holder = claims.holder('h');
    if (holder !== null) {
      holder.chargeId = 'changed';
    }
    expect(claims.holder('h')?.chargeId).toBe('c1');
  });

  it('releases one side and drops the entry once neither side holds it', () => {
    const claims = new PaymentHashClaims();
    claims.release('unknown', 'charge');
    expect(claims.holder('unknown')).toBeNull();
    claims.claimCharge('h', 'c1');
    claims.claimShop('h', 'p1', 'c1');
    claims.release('h', 'shop');
    expect(claims.holder('h')).toEqual({ chargeId: 'c1', paymentId: null, paymentChargeId: null });
    claims.release('h', 'charge');
    expect(claims.holder('h')).toBeNull();
    claims.claimShop('s', 'p2', null);
    claims.claimCharge('s', 'c2');
    claims.release('s', 'charge');
    expect(claims.holder('s')).toEqual({ chargeId: null, paymentId: 'p2', paymentChargeId: null });
    claims.release('s', 'shop');
    expect(claims.holder('s')).toBeNull();
  });
});
