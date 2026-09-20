import { describe, expect, it } from 'vitest';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore, QueryGiftStore } from '@/lib/gift-store';

const EARLY: GiftRow = {
  paidAt: new Date('2026-06-02T00:00:00.000Z'),
  amountSats: 2,
  recipientWosUser: 'b',
};
const LATE: GiftRow = {
  paidAt: new Date('2026-06-01T00:00:00.000Z'),
  amountSats: 1,
  recipientWosUser: 'a',
};

describe('InMemoryGiftStore', () => {
  it('returns a paidAt-sorted copy and does not mutate the seed', async () => {
    const seed: GiftRow[] = [EARLY, LATE];
    const store = new InMemoryGiftStore(seed);
    const listed = await store.listOutbound();
    expect(listed.map((r) => r.amountSats)).toEqual([1, 2]);
    expect(seed[0]).toBe(EARLY);
    listed.pop();
    expect((await store.listOutbound()).length).toBe(2);
  });

  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryGiftStore().listOutbound()).toEqual([]);
  });

  it('dumps stored gift fields newest-first', async () => {
    const listed = await new InMemoryGiftStore([EARLY, LATE]).listDebug(10);
    expect(listed.map((row) => row.amountSats)).toEqual([2, 1]);
    expect(listed[0]).toEqual(
      expect.objectContaining({
        direction: 'outbound',
        recipientWosUser: 'b',
        paidAt: EARLY.paidAt.toISOString(),
      }),
    );
  });
});

describe('QueryGiftStore', () => {
  it('returns the injected query result', async () => {
    const store = new QueryGiftStore(async () => [LATE]);
    expect(await store.listOutbound()).toEqual([LATE]);
    const dumped = await store.listDebug(10);
    expect(dumped[0]).toEqual(expect.objectContaining({ amountSats: 1, direction: 'outbound' }));
  });

  it('uses the injected full-column debug query', async () => {
    const store = new QueryGiftStore(
      async () => [LATE],
      async () => [
        {
          id: 7,
          paidAt: LATE.paidAt.toISOString(),
          direction: 'outbound',
          currency: 'BTC',
          amountSats: 1,
          feeSats: 0,
          recipientWosUser: 'a',
          lightningInvoice: 'lnbc1',
          wosTransactionId: null,
          description: 'gift',
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: 'house',
          importedAt: LATE.paidAt.toISOString(),
        },
      ],
    );
    expect(await store.listDebug(10)).toEqual([
      expect.objectContaining({ id: 7, lightningInvoice: 'lnbc1', currency: 'BTC' }),
    ]);
  });
});
