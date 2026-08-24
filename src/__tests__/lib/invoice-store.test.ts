import { describe, it, expect } from 'vitest';
import { GIFT_INVOICE_TTL_MS } from '@/lib/config';
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

  it('sweep drops unpaid rows after the 409 tombstone window', () => {
    const store = new InMemoryInvoiceStore();
    const unpaid = sample('e'.repeat(32));
    store.put(unpaid);
    store.sweep(unpaid.expiresAt);
    expect(store.get(unpaid.id)).toEqual(unpaid);
    store.sweep(unpaid.expiresAt + GIFT_INVOICE_TTL_MS);
    expect(store.get(unpaid.id)).toBeUndefined();
  });

  it('sweep keeps paid rows', () => {
    const store = new InMemoryInvoiceStore();
    const row = sample('f'.repeat(32));
    store.put(row);
    store.markPaid(row.id, 'ee'.repeat(32), 3);
    store.sweep(row.expiresAt + GIFT_INVOICE_TTL_MS);
    expect(store.get(row.id)?.paidAt).toBe(3);
  });
});
