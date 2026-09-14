import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { FetchFn } from '@/lib/btc-usd-candles';
import {
  FX_SOURCE_FRANKFURTER_ECB,
  InMemoryFiatStore,
  PostgresFiatStore,
  USD_FIAT_DAILY_SCHEMA_SQL,
  fillFiatRatesForGiftRange,
  migrateFiatSchema,
} from '@/lib/usd-fiat-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  queryHandler: (text: string, params: readonly unknown[]) => unknown[] = () => [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return this.queryHandler(text, params) as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function frankfurterRows(
  rows: readonly { date: string; quote: string; rate: number }[],
): unknown[] {
  return rows.map((row) => ({ date: row.date, base: 'USD', quote: row.quote, rate: row.rate }));
}

function completeQuotes(
  day: string,
  fetchedAt: Date | string,
  rates: { CHF: string | number; EUR: string | number; PHP: string | number } = {
    CHF: '0.80',
    EUR: '0.90',
    PHP: '50',
  },
): unknown[] {
  return [
    { day, quote: 'CHF', rate: rates.CHF, fetched_at: fetchedAt },
    { day, quote: 'EUR', rate: rates.EUR, fetched_at: fetchedAt },
    { day, quote: 'PHP', rate: rates.PHP, fetched_at: fetchedAt },
  ];
}

describe('USD_FIAT_DAILY_SCHEMA_SQL', () => {
  it('creates usd_fiat_daily with the expected columns', () => {
    expect(USD_FIAT_DAILY_SCHEMA_SQL).toHaveLength(1);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS usd_fiat_daily/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/PRIMARY KEY \(day, quote\)/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/quote text NOT NULL/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/rate numeric NOT NULL/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/as_of_day date NOT NULL/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/source text NOT NULL/i);
    expect(USD_FIAT_DAILY_SCHEMA_SQL[0]).toMatch(/fetched_at timestamptz NOT NULL/i);
  });
});

describe('migrateFiatSchema', () => {
  it('runs every schema statement', async () => {
    const sql = new MockSql();
    await migrateFiatSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...USD_FIAT_DAILY_SCHEMA_SQL]);
  });
});

describe('InMemoryFiatStore', () => {
  it('returns an empty map by default', async () => {
    const store = new InMemoryFiatStore();
    expect(await store.ensureDays(['2026-06-01'], 0)).toEqual(new Map());
  });

  it('returns seeded crosses for requested valid days only and omits empty crosses', async () => {
    const store = new InMemoryFiatStore({
      '2026-06-01': { CHF: '0.80', EUR: '0.90', PHP: '50' },
      '2026-06-02': {},
      '2026-06-03': { CHF: '0.81' },
      '2026-06-04': { EUR: '0.91' },
      '2026-06-05': { PHP: '51' },
    });
    const rates = await store.ensureDays(
      ['2026-06-01', 'bad', '2026-06-01', '2026-06-02', '2026-06-03', '2026-13-01', '2026-02-30'],
      0,
    );
    expect([...rates.entries()]).toEqual([
      ['2026-06-01', { CHF: '0.80', EUR: '0.90', PHP: '50' }],
      ['2026-06-03', { CHF: '0.81' }],
    ]);
    const chfOnly = await store.ensureDays(['2026-06-04', '2026-06-05'], 0);
    expect(chfOnly.get('2026-06-04')).toEqual({ EUR: '0.91' });
    expect(chfOnly.get('2026-06-05')).toEqual({ PHP: '51' });
    expect(Object.prototype.hasOwnProperty.call(chfOnly.get('2026-06-04'), 'CHF')).toBe(false);
  });

  it('accepts a Map seed and never HTTP', async () => {
    const store = new InMemoryFiatStore(new Map([['2026-06-01', { CHF: '0.80' }]]));
    const rates = await store.ensureDays(['2026-06-01'], 0);
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.80' });
    const returned = rates.get('2026-06-01');
    if (returned !== undefined) {
      returned.CHF = 'mutated';
    }
    expect((await store.ensureDays(['2026-06-01'], 0)).get('2026-06-01')?.CHF).toBe('0.80');
  });
});

describe('PostgresFiatStore', () => {
  it('returns an empty map for empty or invalid days without querying', async () => {
    const sql = new MockSql();
    const store = new PostgresFiatStore({
      sql,
      fetchImpl: vi.fn<FetchFn>(),
      ratesUrl: 'https://example.test/rates',
    });
    expect(await store.ensureDays([], 0)).toEqual(new Map());
    expect(await store.ensureDays(['nope', '2026-13-01', '2026-02-30'], 0)).toEqual(new Map());
    expect(sql.queries).toHaveLength(0);
  });

  it('returns persisted complete quotes without fetching', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => completeQuotes('2026-06-01', new Date('2026-06-02T00:05:00.000Z'));
    const fetchImpl = vi.fn<FetchFn>();
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:30:00.000Z'));
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.80', EUR: '0.90', PHP: '50' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sql.executes).toHaveLength(0);
  });

  it('skips SQL rows whose day cannot be normalized and unknown quotes', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        day: 'not-a-day',
        quote: 'CHF',
        rate: '1',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: 'short',
        quote: 'EUR',
        rate: '1',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: '2026-99-99',
        quote: 'PHP',
        rate: '1',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: '2026-06-01T00:00:00.000Z',
        quote: 'GBP',
        rate: '1',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: new Date('2026-06-01T00:00:00.000Z'),
        quote: 'chf',
        rate: 0.8,
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: '2026-06-01',
        quote: 'EUR',
        rate: '0.90',
        fetched_at: '2026-06-02T00:05:00.000Z',
      },
      {
        day: '2026-06-01',
        quote: 'PHP',
        rate: 50,
        fetched_at: '2026-06-02T00:05:00.000Z',
      },
    ];
    const fetchImpl = vi.fn<FetchFn>();
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:00:00.000Z'));
    expect([...rates.keys()]).toEqual(['2026-06-01']);
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.8', EUR: '0.90', PHP: '50' });
    expect(Object.prototype.hasOwnProperty.call(rates.get('2026-06-01'), 'GBP')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-fetches a historical day whose fetched_at is still on that day', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      const rate = selectPass === 1 ? '0.80' : '0.81';
      return completeQuotes('2026-06-01', new Date('2026-06-01T18:00:00.000Z'), {
        CHF: rate,
        EUR: '0.90',
        PHP: '50',
      });
    };
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse(
        frankfurterRows([
          { date: '2026-06-01', quote: 'CHF', rate: 0.81 },
          { date: '2026-06-01', quote: 'EUR', rate: 0.9 },
          { date: '2026-06-01', quote: 'PHP', rate: 50 },
        ]),
      ),
    );
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:30:00.000Z'));
    expect(fetchImpl).toHaveBeenCalled();
    expect(sql.executes).toHaveLength(3);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(day, quote\) DO UPDATE/);
    expect(sql.executes[0]?.params[0]).toBe('2026-06-01');
  });

  it('fetches missing days from min(needFetch)-10 through max(needFetch)', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      if (selectPass === 1) {
        return [];
      }
      return [
        ...completeQuotes('2026-06-01', '2026-06-10T00:00:00.000Z'),
        ...completeQuotes('2026-06-03', '2026-06-10T00:00:00.000Z', {
          CHF: '0.82',
          EUR: '0.92',
          PHP: '51',
        }),
      ];
    };
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('from')).toBe('2026-05-22');
      expect(url.searchParams.get('to')).toBe('2026-06-03');
      expect(url.searchParams.get('base')).toBe('usd');
      expect(url.searchParams.get('quotes')).toBe('chf,eur,php');
      return jsonResponse(
        frankfurterRows([
          { date: '2026-06-01', quote: 'CHF', rate: 0.8 },
          { date: '2026-06-01', quote: 'EUR', rate: 0.9 },
          { date: '2026-06-01', quote: 'PHP', rate: 50 },
          { date: '2026-06-02', quote: 'CHF', rate: 0.81 },
          { date: '2026-06-03', quote: 'CHF', rate: 0.82 },
          { date: '2026-06-03', quote: 'EUR', rate: 0.92 },
          { date: '2026-06-03', quote: 'PHP', rate: 51 },
        ]),
      );
    });
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
      source: FX_SOURCE_FRANKFURTER_ECB,
    });
    const rates = await store.ensureDays(
      ['2026-06-03', '2026-06-01'],
      Date.parse('2026-06-10T12:00:00.000Z'),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.80', EUR: '0.90', PHP: '50' });
    expect(rates.get('2026-06-03')).toEqual({ CHF: '0.82', EUR: '0.92', PHP: '51' });
    expect(rates.has('2026-06-02')).toBe(false);
    expect(sql.executes.length).toBeGreaterThan(0);
    expect(sql.executes[0]?.params[4]).toBe(FX_SOURCE_FRANKFURTER_ECB);
  });

  it('skips quotes with no candle and omits those keys from the returned object', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      if (selectPass === 1) {
        return [];
      }
      return [
        {
          day: '2026-06-01',
          quote: 'CHF',
          rate: '0.80',
          fetched_at: '2026-06-01T15:00:00.000Z',
        },
      ];
    };
    const fetchImpl: FetchFn = async () =>
      jsonResponse(frankfurterRows([{ date: '2026-06-01', quote: 'CHF', rate: 0.8 }]));
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    const rates = await store.ensureDays(['2026-06-01'], nowMs);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.params[1]).toBe('CHF');
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.80' });
    expect(Object.prototype.hasOwnProperty.call(rates.get('2026-06-01'), 'EUR')).toBe(false);
  });

  it('refreshes UTC-today when fetched_at is older than one hour', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    sql.queryHandler = () => {
      selectPass += 1;
      const chf = selectPass === 1 ? '0.80' : '0.81';
      return completeQuotes('2026-06-01', new Date(nowMs - 3_600_001), {
        CHF: chf,
        EUR: '0.90',
        PHP: '50',
      });
    };
    const fetchImpl: FetchFn = async () =>
      jsonResponse(
        frankfurterRows([
          { date: '2026-06-01', quote: 'CHF', rate: 0.81 },
          { date: '2026-06-01', quote: 'EUR', rate: 0.9 },
          { date: '2026-06-01', quote: 'PHP', rate: 50 },
        ]),
      );
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const rates = await store.ensureDays(['2026-06-01'], nowMs);
    expect(rates.get('2026-06-01')?.CHF).toBe('0.81');
    expect(sql.executes).toHaveLength(3);
  });

  it('does not refresh a fresh today row', async () => {
    const sql = new MockSql();
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    sql.queryHandler = () => completeQuotes('2026-06-01', new Date(nowMs - 1_000));
    const fetchImpl = vi.fn<FetchFn>();
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    await store.ensureDays(['2026-06-01'], nowMs);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches when any quote is missing even if the others are settled', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      if (selectPass === 1) {
        return [
          {
            day: '2026-06-01',
            quote: 'CHF',
            rate: '0.80',
            fetched_at: new Date('2026-06-02T00:05:00.000Z'),
          },
          {
            day: '2026-06-01',
            quote: 'EUR',
            rate: '0.90',
            fetched_at: new Date('2026-06-02T00:05:00.000Z'),
          },
        ];
      }
      return completeQuotes('2026-06-01', new Date('2026-06-02T00:30:00.000Z'));
    };
    const fetchImpl = vi.fn<FetchFn>(async () =>
      jsonResponse(
        frankfurterRows([
          { date: '2026-06-01', quote: 'CHF', rate: 0.8 },
          { date: '2026-06-01', quote: 'EUR', rate: 0.9 },
          { date: '2026-06-01', quote: 'PHP', rate: 50 },
        ]),
      ),
    );
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:30:00.000Z'));
    expect(fetchImpl).toHaveBeenCalled();
    expect(rates.get('2026-06-01')).toEqual({ CHF: '0.80', EUR: '0.90', PHP: '50' });
  });

  it('carry-forwards a Friday ECB print onto a Saturday gift day', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      if (selectPass === 1) {
        return [];
      }
      return completeQuotes('2026-09-05', '2026-09-06T00:00:00.000Z');
    };
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('from')).toBe('2026-08-26');
      expect(url.searchParams.get('to')).toBe('2026-09-05');
      return jsonResponse(
        frankfurterRows([
          { date: '2026-08-25', quote: 'CHF', rate: 0.79 },
          { date: '2026-09-03', quote: 'CHF', rate: 0.795 },
          { date: '2026-09-04', quote: 'CHF', rate: 0.8 },
          { date: '2026-09-04', quote: 'EUR', rate: 0.9 },
          { date: '2026-09-04', quote: 'PHP', rate: 50 },
          { date: '2026-09-06', quote: 'CHF', rate: 0.81 },
        ]),
      );
    });
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const nowMs = Date.parse('2026-09-06T12:00:00.000Z');
    const rates = await store.ensureDays(['2026-09-05'], nowMs);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sql.executes).toHaveLength(3);
    expect(sql.executes.map((e) => e.params[0])).toEqual([
      '2026-09-05',
      '2026-09-05',
      '2026-09-05',
    ]);
    expect(sql.executes.map((e) => e.params[3])).toEqual([
      '2026-09-04',
      '2026-09-04',
      '2026-09-04',
    ]);
    expect(sql.executes.map((e) => e.params[1])).toEqual(['CHF', 'EUR', 'PHP']);
    expect(sql.executes[0]?.params[2]).toBe('0.8');
    expect(sql.executes[0]?.params[4]).toBe(FX_SOURCE_FRANKFURTER_ECB);
    expect(sql.executes[0]?.params[5]).toBe(new Date(nowMs).toISOString());
    expect(rates.get('2026-09-05')).toEqual({ CHF: '0.80', EUR: '0.90', PHP: '50' });
  });

  it('omits a requested day when no candle falls within 10 days', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [];
    const fetchImpl: FetchFn = async () =>
      jsonResponse(frankfurterRows([{ date: '2026-05-20', quote: 'CHF', rate: 0.8 }]));
    const store = new PostgresFiatStore({
      sql,
      fetchImpl,
      ratesUrl: 'https://example.test/rates',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:00:00.000Z'));
    expect(sql.executes).toHaveLength(0);
    expect(rates.size).toBe(0);
  });
});

describe('fillFiatRatesForGiftRange', () => {
  it('returns without ensureDays when there are no outbound gifts', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [{ min: null, max: null }];
    const book = new InMemoryFiatStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillFiatRatesForGiftRange(sql, book, 0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ensures every UTC day from min through max paid_at', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        min: new Date('2026-06-01T12:00:00.000Z'),
        max: '2026-06-03T01:00:00.000Z',
      },
    ];
    const book = new InMemoryFiatStore({
      '2026-06-01': { CHF: '0.80' },
      '2026-06-02': { CHF: '0.81' },
      '2026-06-03': { CHF: '0.82' },
    });
    const spy = vi.spyOn(book, 'ensureDays');
    await fillFiatRatesForGiftRange(sql, book, 1_000);
    expect(spy).toHaveBeenCalledWith(['2026-06-01', '2026-06-02', '2026-06-03'], 1_000);
  });

  it('parses string min and Date max paid_at', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        min: '2026-06-01T12:00:00.000Z',
        max: new Date('2026-06-01T18:00:00.000Z'),
      },
    ];
    const book = new InMemoryFiatStore({ '2026-06-01': { CHF: '0.80' } });
    const spy = vi.spyOn(book, 'ensureDays');
    await fillFiatRatesForGiftRange(sql, book, 2_000);
    expect(spy).toHaveBeenCalledWith(['2026-06-01'], 2_000);
  });

  it('returns when min is set but max is null', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [{ min: new Date('2026-06-01T12:00:00.000Z'), max: null }];
    const book = new InMemoryFiatStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillFiatRatesForGiftRange(sql, book, 0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('no-ops when the range query returns no rows', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [];
    const book = new InMemoryFiatStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillFiatRatesForGiftRange(sql, book, 0);
    expect(spy).not.toHaveBeenCalled();
  });
});
