import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { GiftRow } from '@/lib/gift';
import {
  InMemoryGiftStore,
  migrateGiftSchema,
  QueryGiftStore,
  repairGiftKind,
} from '@/lib/gift-store';

const EARLY: GiftRow = {
  paidAt: new Date('2026-06-02T00:00:00.000Z'),
  amountSats: 2,
  recipientWosUser: 'b',
  kind: 'daily',
};
const LATE: GiftRow = {
  paidAt: new Date('2026-06-01T00:00:00.000Z'),
  amountSats: 1,
  recipientWosUser: 'a',
  kind: 'daily',
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
          kind: 'daily',
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
        if (text.includes('kind IS NULL') && text.includes('LIMIT 1')) {
          return [] as T[];
        }
        if (text.includes('pg_constraint') || text.includes('gift_kind_check')) {
          return [] as T[];
        }
        if (text.includes('fiat_usd IS NULL')) {
          return candidates as T[];
        }
        return [] as T[];
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
    return sql.executes.filter(
      (row) =>
        row.text.includes('UPDATE') &&
        (row.text.includes('fiat_usd') || row.text.includes('SET fiat')),
    );
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

describe('migrateGiftSchema kind backfill', () => {
  interface KindGift {
    id: number;
    description: string;
    kind: string | null;
  }

  interface KindMatch {
    gift_id: number;
    message_id: string;
    message_text: string;
    abs_seconds: number;
  }

  function kindSql(
    gifts: KindGift[],
    matches: KindMatch[] = [],
  ): SqlClient & {
    gifts: KindGift[];
    executes: { text: string; params: readonly unknown[] }[];
  } {
    let constraintExists = false;
    const executes: { text: string; params: readonly unknown[] }[] = [];
    const sql: SqlClient & {
      gifts: KindGift[];
      executes: { text: string; params: readonly unknown[] }[];
    } = {
      gifts,
      executes,
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('btc_usd_daily')) {
          return [] as T[];
        }
        if (text.includes('kind IS NULL') && text.includes('LIMIT 1')) {
          const remaining = gifts.find((row) => row.kind === null);
          return (remaining === undefined ? [] : [{ id: remaining.id }]) as T[];
        }
        if (text.includes('pg_trigger')) {
          return [{ present: 1 }] as T[];
        }
        if (text.includes('message_text')) {
          const nullIds = new Set(
            gifts.filter((row) => row.kind === null).map((row) => String(row.id)),
          );
          return matches.filter((row) => nullIds.has(String(row.gift_id))) as T[];
        }
        if (text.includes('pg_constraint') || text.includes('gift_kind_check')) {
          return (constraintExists ? [{ conname: 'gift_kind_check' }] : []) as T[];
        }
        if (text.includes('fiat_usd IS NULL')) {
          return [] as T[];
        }
        return [] as T[];
      },
      execute: async (text, params = []) => {
        executes.push({ text, params });
        if (text.includes("SET kind = 'moderator'")) {
          for (const row of gifts) {
            if (row.kind === null && row.description === '21gifts moderator') {
              row.kind = 'moderator';
            }
          }
        } else if (text.includes("SET kind = 'welcome'")) {
          const id = String(params[0]);
          for (const row of gifts) {
            if (String(row.id) === id && row.kind === null) {
              row.kind = 'welcome';
            }
          }
        } else if (text.includes("SET kind = 'daily'") && text.includes('kind IS NULL')) {
          for (const row of gifts) {
            if (row.kind === null) {
              row.kind = 'daily';
            }
          }
        } else if (text.includes('ADD CONSTRAINT gift_kind_check')) {
          constraintExists = true;
        }
      },
    };
    return sql;
  }

  it('sets description 21gifts moderator to moderator even when a Welcome reply would match', async () => {
    const gifts: KindGift[] = [{ id: 1, description: '21gifts moderator', kind: null }];
    const sql = kindSql(gifts, [
      { gift_id: 1, message_id: 'm-welcome', message_text: 'Welcome', abs_seconds: 0 },
    ]);
    await repairGiftKind(sql);
    expect(gifts[0]?.kind).toBe('moderator');
    expect(sql.executes.some((row) => row.text.includes("SET kind = 'welcome'"))).toBe(false);
  });

  it('sets a NULL gift to welcome when a Welcome reply matches within 3 seconds', async () => {
    const gifts: KindGift[] = [{ id: 1, description: '21gifts daily', kind: null }];
    const sql = kindSql(gifts, [
      { gift_id: 1, message_id: 'm-welcome', message_text: 'Welcome', abs_seconds: 1 },
    ]);
    await repairGiftKind(sql);
    expect(gifts[0]?.kind).toBe('welcome');
  });

  it('assigns one Welcome and leaves the other gift daily via the final NULL update', async () => {
    const gifts: KindGift[] = [
      { id: 1, description: '21gifts daily', kind: null },
      { id: 2, description: '21gifts daily', kind: null },
    ];
    const sql = kindSql(gifts, [
      { gift_id: 2, message_id: 'm-daily', message_text: '21gifts daily', abs_seconds: 2 },
      { gift_id: 1, message_id: 'm-daily', message_text: '21gifts daily', abs_seconds: 1 },
      { gift_id: 2, message_id: 'm-welcome', message_text: 'Welcome', abs_seconds: 1.5 },
      { gift_id: 1, message_id: 'm-welcome', message_text: 'Welcome', abs_seconds: 0.5 },
    ]);
    await repairGiftKind(sql);
    expect(gifts.map((row) => row.kind)).toEqual(['welcome', 'daily']);
    const welcomeUpdates = sql.executes.filter((row) => row.text.includes("SET kind = 'welcome'"));
    expect(welcomeUpdates).toEqual([expect.objectContaining({ params: [1] })]);
  });

  it('sets a NULL row with no reply to daily', async () => {
    const gifts: KindGift[] = [{ id: 1, description: '21gifts daily', kind: null }];
    const sql = kindSql(gifts);
    await repairGiftKind(sql);
    expect(gifts[0]?.kind).toBe('daily');
    expect(sql.executes.some((row) => row.text.includes("SET kind = 'welcome'"))).toBe(false);
  });

  it('does not change a set kind on a second migrateGiftSchema call', async () => {
    const gifts: KindGift[] = [{ id: 1, description: '21gifts daily', kind: null }];
    const sql = kindSql(gifts, [
      { gift_id: 1, message_id: 'm-welcome', message_text: 'Welcome', abs_seconds: 0 },
    ]);
    await repairGiftKind(sql);
    expect(gifts[0]?.kind).toBe('welcome');
    const afterFirst = sql.executes.length;
    const kinds = gifts.map((row) => row.kind);
    await repairGiftKind(sql);
    expect(gifts.map((row) => row.kind)).toEqual(kinds);
    expect(
      sql.executes.slice(afterFirst).some((row) => row.text.includes("SET kind = 'welcome'")),
    ).toBe(false);
    expect(
      sql.executes.filter((row) => row.text.includes('ADD CONSTRAINT gift_kind_check')),
    ).toHaveLength(1);
  });

  it('does not write kind until the audit trigger is attached', async () => {
    const gifts: KindGift[] = [{ id: 1, description: '21gifts daily', kind: null }];
    const sql = kindSql(gifts);
    sql.query = async <T>(text: string): Promise<T[]> => {
      if (text.includes('pg_trigger')) {
        return [] as T[];
      }
      return [{ present: 1 }] as T[];
    };
    await repairGiftKind(sql);
    expect(gifts[0]?.kind).toBeNull();
    expect(sql.executes.some((row) => row.text.includes('SET kind'))).toBe(false);
  });
});
