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
});

describe('QueryGiftStore', () => {
  it('returns the injected query result', async () => {
    const store = new QueryGiftStore(async () => [LATE]);
    expect(await store.listOutbound()).toEqual([LATE]);
  });
});
