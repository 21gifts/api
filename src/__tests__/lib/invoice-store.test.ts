import { describe, it, expect } from 'vitest';
import { InMemoryInvoiceStore, newInvoiceId, type GiftInvoice } from '@/lib/invoice-store';

function sample(id: string): GiftInvoice {
  return {
    id,
    pr: 'lnbc1test',
    paymentHash: 'aa'.repeat(32),
    amountMsat: 1000,
    createdAt: 1,
    expiresAt: 2,
  };
}

describe('newInvoiceId', () => {
  it('returns 32 lowercase hex characters', () => {
    const id = newInvoiceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newInvoiceId()).not.toBe(id);
  });
});

describe('InMemoryInvoiceStore', () => {
  it('stores and returns a row by id', () => {
    const store = new InMemoryInvoiceStore();
    const row = sample('a'.repeat(32));
    store.put(row);
    expect(store.get(row.id)).toEqual(row);
  });

  it('returns undefined for an unknown id', () => {
    expect(new InMemoryInvoiceStore().get('missing')).toBeUndefined();
  });

  it('markPaid is a no-op for an unknown id', () => {
    const store = new InMemoryInvoiceStore();
    store.markPaid('missing', 'bb'.repeat(32), 9);
    expect(store.get('missing')).toBeUndefined();
  });

  it('markPaid sets paidAt and preimage on a copy', () => {
    const store = new InMemoryInvoiceStore();
    const row = sample('c'.repeat(32));
    store.put(row);
    store.markPaid(row.id, 'dd'.repeat(32), 42);
    expect(store.get(row.id)).toEqual({
      ...row,
      paidAt: 42,
      preimage: 'dd'.repeat(32),
    });
  });
});
