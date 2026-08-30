import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { decodeBolt11, inspectBolt11, isNip57Invoice } from '@/lib/bolt11';

const HASH = 'aa'.repeat(32);
const DESC_HASH = 'bb'.repeat(32);

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

  it('decodes a real BOLT11 fixture without an injected decoder', () => {
    // BOLT11 spec example: 2500u = 250_000_000 msat, payment_hash all known bytes.
    const pr =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    const decoded = decodeBolt11(pr);
    expect(decoded).not.toBeNull();
    expect(decoded?.amountMsat).toBe(250_000_000);
    expect(decoded?.paymentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('inspectBolt11', () => {
  it('reads description_hash invoices with description null', () => {
    const inspected = inspectBolt11('lnbc1', () => ({
      sections: [
        { name: 'payment_hash', value: HASH },
        { name: 'amount', value: '21000' },
        { name: 'description_hash', value: DESC_HASH.toUpperCase() },
        { name: 'expiry', value: 600 },
      ],
    }));
    expect(inspected).toEqual({
      paymentHash: HASH,
      amountMsat: 21000,
      description: null,
      descriptionHash: DESC_HASH,
      expirySeconds: 600,
    });
  });

  it('reads plaintext description invoices with descriptionHash null', () => {
    const description = JSON.stringify({ kind: 9734, content: 'zap' });
    const inspected = inspectBolt11('lnbc1', () => ({
      sections: [
        { name: 'payment_hash', value: HASH },
        { name: 'amount', value: 21000 },
        { name: 'description', value: description },
      ],
    }));
    expect(inspected).toEqual({
      paymentHash: HASH,
      amountMsat: 21000,
      description,
      descriptionHash: null,
      expirySeconds: null,
    });
  });

  it('returns null for a bad payment request', () => {
    expect(inspectBolt11('not-an-invoice')).toBeNull();
    expect(
      inspectBolt11('lnbc1', () => {
        throw new Error('bad');
      }),
    ).toBeNull();
    expect(
      inspectBolt11('lnbc1', () => ({
        sections: [{ name: 'amount', value: '1000' }],
      })),
    ).toBeNull();
  });

  it('ignores a non-hex description_hash', () => {
    const inspected = inspectBolt11('lnbc1', () => ({
      sections: [
        { name: 'payment_hash', value: HASH },
        { name: 'amount', value: '1000' },
        { name: 'description_hash', value: 'zz' },
      ],
    }));
    expect(inspected?.descriptionHash).toBeNull();
  });
});

describe('isNip57Invoice', () => {
  it('is true only when sha256(zap json) matches the description hash', () => {
    const zapJson = JSON.stringify({ kind: 9734, content: 'pay' });
    const hash = createHash('sha256').update(zapJson, 'utf8').digest('hex');
    expect(isNip57Invoice(hash, zapJson)).toBe(true);
    expect(isNip57Invoice(hash, JSON.stringify({ kind: 9734, content: 'other' }))).toBe(false);
    expect(isNip57Invoice(null, zapJson)).toBe(false);
    expect(isNip57Invoice(hash, null)).toBe(false);
  });
});
