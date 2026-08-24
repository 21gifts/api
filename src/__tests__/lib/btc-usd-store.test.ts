import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { FetchFn } from '@/lib/btc-usd-candles';
import {
  BTC_USD_DAILY_SCHEMA_SQL,
  FX_SOURCE_COINBASE_DAILY_CLOSE,
  InMemoryBtcUsdStore,
  PostgresBtcUsdStore,
  fillRatesForGiftRange,
  migrateBtcUsdSchema,
} from '@/lib/btc-usd-store';

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

describe('BTC_USD_DAILY_SCHEMA_SQL', () => {
  it('creates btc_usd_daily with the expected columns', () => {
    expect(BTC_USD_DAILY_SCHEMA_SQL).toHaveLength(1);
    expect(BTC_USD_DAILY_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS btc_usd_daily/i);
    expect(BTC_USD_DAILY_SCHEMA_SQL[0]).toMatch(/day date PRIMARY KEY/i);
    expect(BTC_USD_DAILY_SCHEMA_SQL[0]).toMatch(/usd_per_btc numeric NOT NULL/i);
    expect(BTC_USD_DAILY_SCHEMA_SQL[0]).toMatch(/source text NOT NULL/i);
    expect(BTC_USD_DAILY_SCHEMA_SQL[0]).toMatch(/fetched_at timestamptz NOT NULL/i);
  });
});

describe('migrateBtcUsdSchema', () => {
  it('runs every schema statement', async () => {
    const sql = new MockSql();
    await migrateBtcUsdSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...BTC_USD_DAILY_SCHEMA_SQL]);
  });
});

describe('InMemoryBtcUsdStore', () => {
  it('returns an empty map by default', async () => {
    const store = new InMemoryBtcUsdStore();
    expect(await store.ensureDays(['2026-06-01'], 0)).toEqual(new Map());
  });

  it('returns seeded rates for requested valid days only', async () => {
    const store = new InMemoryBtcUsdStore({ '2026-06-01': '100000', '2026-06-02': '101000' });
    const rates = await store.ensureDays(
      ['2026-06-01', 'bad', '2026-06-01', '2026-06-03', '2026-13-01', '2026-02-30'],
      0,
    );
    expect([...rates.entries()]).toEqual([['2026-06-01', '100000']]);
  });

  it('accepts a Map seed', async () => {
    const store = new InMemoryBtcUsdStore(new Map([['2026-06-01', '99000']]));
    const rates = await store.ensureDays(['2026-06-01'], 0);
    expect(rates.get('2026-06-01')).toBe('99000');
  });
});

describe('PostgresBtcUsdStore', () => {
  it('returns an empty map for empty or invalid days without querying', async () => {
    const sql = new MockSql();
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl: vi.fn<FetchFn>(),
      candlesUrl: 'https://example.test/candles',
    });
    expect(await store.ensureDays([], 0)).toEqual(new Map());
    expect(await store.ensureDays(['nope'], 0)).toEqual(new Map());
    expect(sql.queries).toHaveLength(0);
  });

  it('returns persisted rates without fetching when complete', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        day: '2026-06-01',
        usd_per_btc: '100000',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
    ];
    const fetchImpl = vi.fn<FetchFn>();
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:30:00.000Z'));
    expect(rates.get('2026-06-01')).toBe('100000');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sql.executes).toHaveLength(0);
  });

  it('skips SQL rows whose day cannot be normalized', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        day: 'not-a-day',
        usd_per_btc: '1',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
      {
        day: '2026-06-01',
        usd_per_btc: '100000',
        fetched_at: new Date('2026-06-02T00:05:00.000Z'),
      },
    ];
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl: vi.fn<FetchFn>(),
      candlesUrl: 'https://example.test/candles',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:00:00.000Z'));
    expect([...rates.keys()]).toEqual(['2026-06-01']);
  });

  it('re-fetches an intraday print after UTC midnight so the settled close can land', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      {
        day: '2026-06-01',
        usd_per_btc: '99000',
        fetched_at: new Date('2026-06-01T18:00:00.000Z'),
      },
    ];
    const dayMs = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    const fetchImpl = vi.fn<FetchFn>(async () => jsonResponse([[dayMs, 1, 2, 3, 100500, 1]]));
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
    });
    await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:30:00.000Z'));
    expect(fetchImpl).toHaveBeenCalled();
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.params).toHaveLength(4);
    expect(sql.executes[0]?.params[0]).toBe('2026-06-01');
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(day\) DO UPDATE/);
    expect(sql.executes[0]?.text).not.toMatch(/WHERE btc_usd_daily\.day = \$5::date/);
  });

  it('fetches and inserts missing days; omits still-missing after re-select', async () => {
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
          usd_per_btc: '100000',
          fetched_at: '2026-06-01T12:00:00.000Z',
        },
      ];
    };
    const dayMs = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    const fetchImpl: FetchFn = async () => jsonResponse([[dayMs, 1, 2, 3, 100000, 1]]);
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
      source: FX_SOURCE_COINBASE_DAILY_CLOSE,
    });
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    const rates = await store.ensureDays(['2026-06-01', '2026-06-02'], nowMs);
    expect(rates.get('2026-06-01')).toBe('100000');
    expect(rates.has('2026-06-02')).toBe(false);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(day\) DO UPDATE/);
    expect(sql.executes[0]?.text).not.toMatch(/\$5/);
    expect(sql.executes[0]?.params).toHaveLength(4);
    expect(sql.executes[0]?.params[0]).toBe('2026-06-01');
    expect(sql.executes[0]?.params[1]).toBe('100000');
    expect(sql.executes[0]?.params[2]).toBe(FX_SOURCE_COINBASE_DAILY_CLOSE);
  });

  it('fetches only contiguous runs and skips extra candle days', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    sql.queryHandler = () => {
      selectPass += 1;
      if (selectPass === 1) {
        return [];
      }
      return [
        { day: '2026-06-01', usd_per_btc: '100000', fetched_at: '2026-06-10T00:00:00.000Z' },
        { day: '2026-06-03', usd_per_btc: '102000', fetched_at: '2026-06-10T00:00:00.000Z' },
      ];
    };
    const d1 = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    const d2 = Date.parse('2026-06-02T00:00:00.000Z') / 1000;
    const d3 = Date.parse('2026-06-03T00:00:00.000Z') / 1000;
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start');
      if (start === '2026-06-01T00:00:00.000Z') {
        return jsonResponse([
          [d1, 1, 2, 3, 100000, 1],
          [d2, 1, 2, 3, 101000, 1],
        ]);
      }
      return jsonResponse([[d3, 1, 2, 3, 102000, 1]]);
    });
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
    });
    const rates = await store.ensureDays(
      ['2026-06-01', '2026-06-03'],
      Date.parse('2026-06-10T12:00:00.000Z'),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(firstUrl.searchParams.get('start')).toBe('2026-06-01T00:00:00.000Z');
    expect(firstUrl.searchParams.get('end')).toBe('2026-06-01T00:00:00.000Z');
    expect(secondUrl.searchParams.get('start')).toBe('2026-06-03T00:00:00.000Z');
    expect(secondUrl.searchParams.get('end')).toBe('2026-06-03T00:00:00.000Z');
    expect(sql.executes).toHaveLength(2);
    expect(sql.executes.map((e) => e.params[0])).toEqual(['2026-06-01', '2026-06-03']);
    expect(rates.get('2026-06-01')).toBe('100000');
    expect(rates.get('2026-06-03')).toBe('102000');
    expect(rates.has('2026-06-02')).toBe(false);
  });

  it('refreshes UTC-today when fetched_at is older than one hour', async () => {
    const sql = new MockSql();
    let selectPass = 0;
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    sql.queryHandler = () => {
      selectPass += 1;
      const rate = selectPass === 1 ? '100000' : '101000';
      return [
        {
          day: new Date('2026-06-01T00:00:00.000Z'),
          usd_per_btc: rate,
          fetched_at: new Date(nowMs - 3_600_001),
        },
      ];
    };
    const dayMs = Date.parse('2026-06-01T00:00:00.000Z') / 1000;
    const fetchImpl: FetchFn = async () => jsonResponse([[dayMs, 1, 2, 3, 101000, 1]]);
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
    });
    const rates = await store.ensureDays(['2026-06-01'], nowMs);
    expect(rates.get('2026-06-01')).toBe('101000');
    expect(sql.executes).toHaveLength(1);
  });

  it('does not refresh a fresh today row', async () => {
    const sql = new MockSql();
    const nowMs = Date.parse('2026-06-01T15:00:00.000Z');
    sql.queryHandler = () => [
      {
        day: '2026-06-01',
        usd_per_btc: '100000',
        fetched_at: new Date(nowMs - 1_000),
      },
    ];
    const fetchImpl = vi.fn<FetchFn>();
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl,
      candlesUrl: 'https://example.test/candles',
    });
    await store.ensureDays(['2026-06-01'], nowMs);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips rows whose day cannot be normalized', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [
      { day: 'not-a-day', usd_per_btc: '1', fetched_at: new Date(0) },
      { day: 'short', usd_per_btc: '1', fetched_at: new Date(0) },
      { day: new Date('2026-06-01T00:00:00.000Z'), usd_per_btc: 100000, fetched_at: new Date(0) },
    ];
    const store = new PostgresBtcUsdStore({
      sql,
      fetchImpl: vi.fn<FetchFn>(),
      candlesUrl: 'https://example.test/candles',
    });
    const rates = await store.ensureDays(['2026-06-01'], Date.parse('2026-06-02T00:00:00.000Z'));
    expect([...rates.keys()]).toEqual(['2026-06-01']);
    expect(rates.get('2026-06-01')).toBe('100000');
  });
});

describe('fillRatesForGiftRange', () => {
  it('returns without ensureDays when there are no outbound gifts', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [{ min: null, max: null }];
    const book = new InMemoryBtcUsdStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillRatesForGiftRange(sql, book, 0);
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
    const book = new InMemoryBtcUsdStore({
      '2026-06-01': '1',
      '2026-06-02': '2',
      '2026-06-03': '3',
    });
    const spy = vi.spyOn(book, 'ensureDays');
    await fillRatesForGiftRange(sql, book, 1_000);
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
    const book = new InMemoryBtcUsdStore({ '2026-06-01': '1' });
    const spy = vi.spyOn(book, 'ensureDays');
    await fillRatesForGiftRange(sql, book, 2_000);
    expect(spy).toHaveBeenCalledWith(['2026-06-01'], 2_000);
  });

  it('returns when min is set but max is null', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [{ min: new Date('2026-06-01T12:00:00.000Z'), max: null }];
    const book = new InMemoryBtcUsdStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillRatesForGiftRange(sql, book, 0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('no-ops when the range query returns no rows', async () => {
    const sql = new MockSql();
    sql.queryHandler = () => [];
    const book = new InMemoryBtcUsdStore();
    const spy = vi.spyOn(book, 'ensureDays');
    await fillRatesForGiftRange(sql, book, 0);
    expect(spy).not.toHaveBeenCalled();
  });
});
