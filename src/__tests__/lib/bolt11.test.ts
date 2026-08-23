import { describe, it, expect } from 'vitest';
import { decodeBolt11 } from '@/lib/bolt11';

const HASH = 'aa'.repeat(32);

describe('decodeBolt11', () => {
  it('reads payment hash and amount from sections', () => {
    const decoded = decodeBolt11('lnbc1', () => ({
      sections: [
        { name: 'payment_hash', value: HASH.toUpperCase() },
        { name: 'amount', value: '100000' },
      ],
    }));
    expect(decoded).toEqual({ paymentHash: HASH, amountMsat: 100000 });
  });

  it('accepts a numeric amount', () => {
    const decoded = decodeBolt11('lnbc1', () => ({
      sections: [
        { name: 'payment_hash', value: HASH },
        { name: 'amount', value: 2500 },
      ],
    }));
    expect(decoded).toEqual({ paymentHash: HASH, amountMsat: 2500 });
  });

  it('returns null when decode throws', () => {
    expect(
      decodeBolt11('lnbc1', () => {
        throw new Error('bad invoice');
      }),
    ).toBeNull();
  });

  it('returns null when sections are missing', () => {
    expect(decodeBolt11('lnbc1', () => ({}))).toBeNull();
  });

  it('returns null without a payment hash', () => {
    expect(
      decodeBolt11('lnbc1', () => ({
        sections: [{ name: 'amount', value: '1000' }],
      })),
    ).toBeNull();
  });

  it('returns null when the payment hash is not 32-byte hex', () => {
    expect(
      decodeBolt11('lnbc1', () => ({
        sections: [
          { name: 'payment_hash', value: 'zz' },
          { name: 'amount', value: '1000' },
        ],
      })),
    ).toBeNull();
  });

  it('returns null without an amount', () => {
    expect(
      decodeBolt11('lnbc1', () => ({
        sections: [{ name: 'payment_hash', value: HASH }],
      })),
    ).toBeNull();
  });

  it('returns null when the amount is not a positive integer', () => {
    expect(
      decodeBolt11('lnbc1', () => ({
        sections: [
          { name: 'payment_hash', value: HASH },
          { name: 'amount', value: 'nope' },
        ],
      })),
    ).toBeNull();
  });

  it('returns null for a garbage invoice using the library decode', () => {
    expect(decodeBolt11('not-an-invoice')).toBeNull();
  });
});
