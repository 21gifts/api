import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore, migrateGiftSchema, QueryGiftStore } from '@/lib/gift-store';

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
          amountUsd: null,
          amountChf: null,
          amountEur: null,
          amountPhp: null,
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

describe('migrateGiftSchema fiat backfill', () => {
  function sqlFor(
    candidates: unknown[],
    rates: unknown[],
  ): SqlClient & {
    executes: { text: string; params: readonly unknown[] }[];
  } {
    const executes: { text: string; params: readonly unknown[] }[] = [];
    const sql: SqlClient & { executes: { text: string; params: readonly unknown[] }[] } = {
      executes,
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('btc_usd_daily')) {
          return rates as T[];
        }
        return candidates as T[];
      },
      execute: async (text, params = []) => {
        executes.push({ text, params });
      },
    };
    return sql;
  }

  function updates(sql: { executes: { text: string; params: readonly unknown[] }[] }): {
    text: string;
    params: readonly unknown[];
  }[] {
    return sql.executes.filter((row) => row.text.includes('UPDATE gift'));
  }

  it('writes stored fiat for a priced gift and skips a bad timestamp and a day without a rate', async () => {
    const sql = sqlFor(
      [
        { id: 1, paid_at: new Date('2026-06-01T12:00:00.000Z'), amount_sats: 1000 },
        { id: 2, paid_at: 'not-a-date', amount_sats: 1000 },
        { id: 3, paid_at: '2026-07-01T00:00:00.000Z', amount_sats: 1000 },
      ],
      [
        { day: '2026-06-01', usd_per_btc: '100000', quote: null, rate: null },
        { day: '2026-06-01', usd_per_btc: '100000', quote: 'EUR', rate: null },
        { day: '2026-06-01', usd_per_btc: '100000', quote: 'CHF', rate: '0.80' },
        { day: '2026-06-01', usd_per_btc: '100000', quote: 'PHP', rate: '50' },
      ],
    );
    await migrateGiftSchema(sql);
    expect(updates(sql)).toEqual([
      expect.objectContaining({
        params: [1, '1.00', '0.80', null, '50.00'],
      }),
    ]);
  });

  it('does not update when every paid_at is invalid', async () => {
    const sql = sqlFor([{ id: 9, paid_at: 'nope', amount_sats: 1000 }], []);
    await migrateGiftSchema(sql);
    expect(updates(sql)).toEqual([]);
  });

  it('does not update when the day has no BTC rate', async () => {
    const sql = sqlFor(
      [{ id: 4, paid_at: new Date('2026-06-01T00:00:00.000Z'), amount_sats: 1000 }],
      [],
    );
    await migrateGiftSchema(sql);
    expect(updates(sql)).toEqual([]);
  });
});
