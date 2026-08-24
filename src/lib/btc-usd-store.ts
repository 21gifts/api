/**
 * Persisted BTC-USD daily closes and the rate book used by gift stats.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { fetchDailyCloses, type FetchFn } from '@/lib/btc-usd-candles';

/** Idempotent DDL for the FX table (matches `docs/schema/btc_usd_daily.sql`). */
export const BTC_USD_DAILY_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS btc_usd_daily (
    day date PRIMARY KEY,
    usd_per_btc numeric NOT NULL,
    source text NOT NULL,
    fetched_at timestamptz NOT NULL
  )`,
];

/** Coinbase Exchange daily-close source tag stored on each row. */
export const FX_SOURCE_COINBASE_DAILY_CLOSE = 'coinbase-exchange-daily-close';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const ONE_HOUR_MS = 3_600_000;

/**
 * Load persisted rates; fetch and persist any missing days (and refresh
 * UTC-today when `fetched_at` is older than one hour). Never overwrite a
 * historical day.
 */
export interface BtcUsdRateBook {
  /**
   * Ensure rates for the requested UTC days.
   *
   * @param days - UTC `YYYY-MM-DD` days (duplicates / invalid ignored).
   * @param nowMs - Clock for "today" and the one-hour refresh window.
   * @returns Map of day → `usd_per_btc` string for days that are available.
   */
  ensureDays(days: readonly string[], nowMs: number): Promise<ReadonlyMap<string, string>>;
}

/** Row shape selected from `btc_usd_daily`. */
interface BtcUsdRow {
  day: Date | string;
  usd_per_btc: string | number;
  fetched_at: Date | string;
}

/**
 * Apply {@link BTC_USD_DAILY_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateBtcUsdSchema(sql: SqlClient): Promise<void> {
  for (const statement of BTC_USD_DAILY_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * In-memory rate book. Returns the seed only — never HTTP.
 */
export class MemoryBtcUsdStore implements BtcUsdRateBook {
  readonly #rates: ReadonlyMap<string, string>;

  /**
   * @param seed - Optional day → rate map or record.
   */
  constructor(seed?: ReadonlyMap<string, string> | Record<string, string>) {
    if (seed === undefined) {
      this.#rates = new Map();
    } else if (seed instanceof Map) {
      this.#rates = new Map(seed);
    } else {
      this.#rates = new Map(Object.entries(seed));
    }
  }

  /**
   * Return seeded rates for the requested valid days. Missing days are omitted.
   *
   * @param days - Requested UTC days.
   * @param _nowMs - Ignored (no refresh).
   * @returns Subset of the seed.
   */
  async ensureDays(days: readonly string[], _nowMs: number): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const day of uniqueValidDays(days)) {
      const rate = this.#rates.get(day);
      if (rate !== undefined) {
        out.set(day, rate);
      }
    }
    return out;
  }
}

/**
 * Postgres-backed rate book that fills gaps from Coinbase candles.
 */
export class PostgresBtcUsdStore implements BtcUsdRateBook {
  readonly #sql: SqlClient;
  readonly #fetchImpl: FetchFn;
  readonly #candlesUrl: string;
  readonly #source: string;

  /**
   * @param args - SQL client, fetch, candles URL, optional source tag.
   */
  constructor(args: { sql: SqlClient; fetchImpl: FetchFn; candlesUrl: string; source?: string }) {
    this.#sql = args.sql;
    this.#fetchImpl = args.fetchImpl;
    this.#candlesUrl = args.candlesUrl;
    this.#source = args.source ?? FX_SOURCE_COINBASE_DAILY_CLOSE;
  }

  /**
   * Load rates for `days`, fetching and inserting any gaps (and refreshing
   * UTC-today when stale). Historical days are insert-only on conflict.
   * Still-missing days are omitted — the caller decides on 503.
   *
   * @param days - Requested UTC days.
   * @param nowMs - Clock for today / one-hour refresh.
   * @returns Available day → rate map.
   */
  async ensureDays(days: readonly string[], nowMs: number): Promise<ReadonlyMap<string, string>> {
    const unique = uniqueValidDays(days);
    if (unique.length === 0) {
      return new Map();
    }

    const existing = await this.#selectDays(unique);
    const today = utcDayFromMs(nowMs);
    const needFetch: string[] = [];
    for (const day of unique) {
      const row = existing.get(day);
      if (row === undefined) {
        needFetch.push(day);
        continue;
      }
      if (day === today && row.fetchedAtMs < nowMs - ONE_HOUR_MS) {
        needFetch.push(day);
        continue;
      }
      // Intraday print written during `day` is not the settled close until UTC
      // midnight; refresh once after the calendar rolls.
      if (day < today && utcDayFromMs(row.fetchedAtMs) === day) {
        needFetch.push(day);
      }
    }

    if (needFetch.length > 0) {
      const sorted = [...needFetch].sort();
      const fromDay = sorted[0] as string;
      const toDay = sorted[sorted.length - 1] as string;
      const closes = await fetchDailyCloses({
        fetchImpl: this.#fetchImpl,
        url: this.#candlesUrl,
        fromDay,
        toDay,
      });
      const fetchedAt = new Date(nowMs).toISOString();
      for (const close of closes) {
        await this.#sql.execute(
          `INSERT INTO btc_usd_daily (day, usd_per_btc, source, fetched_at)
           VALUES ($1::date, $2::numeric, $3, $4::timestamptz)
           ON CONFLICT (day) DO UPDATE SET
             usd_per_btc = EXCLUDED.usd_per_btc,
             source = EXCLUDED.source,
             fetched_at = EXCLUDED.fetched_at
           WHERE btc_usd_daily.day = $5::date`,
          [
            close.day,
            close.usdPerBtc,
            this.#source,
            fetchedAt,
            needFetch.includes(today) ? today : '0001-01-01',
          ],
        );
      }
    }

    const refreshed = await this.#selectDays(unique);
    const out = new Map<string, string>();
    for (const day of unique) {
      const row = refreshed.get(day);
      if (row !== undefined) {
        out.set(day, row.usdPerBtc);
      }
    }
    return out;
  }

  /**
   * SELECT rate rows for the given days.
   *
   * @param days - Valid UTC days.
   * @returns Map of day → rate + fetched_at ms.
   */
  async #selectDays(
    days: readonly string[],
  ): Promise<Map<string, { usdPerBtc: string; fetchedAtMs: number }>> {
    const placeholders = days.map((_, i) => `$${i + 1}::date`).join(', ');
    const rows = await this.#sql.query<BtcUsdRow>(
      `SELECT day::text AS day, usd_per_btc::text AS usd_per_btc, fetched_at
       FROM btc_usd_daily
       WHERE day IN (${placeholders})`,
      days,
    );
    const out = new Map<string, { usdPerBtc: string; fetchedAtMs: number }>();
    for (const row of rows) {
      const day = normalizeDay(row.day);
      if (day === null) {
        continue;
      }
      const fetchedAtMs =
        row.fetched_at instanceof Date
          ? row.fetched_at.getTime()
          : new Date(row.fetched_at).getTime();
      out.set(day, { usdPerBtc: String(row.usd_per_btc), fetchedAtMs });
    }
    return out;
  }
}

/**
 * Pre-fill FX rates for every UTC day from the earliest through latest
 * outbound gift. No-op when there are no outbound gifts. Does not catch —
 * callers (boot) decide whether to swallow errors.
 *
 * @param sql - SQL client for the gift range query.
 * @param book - Rate book to fill.
 * @param nowMs - Clock passed to `ensureDays`.
 */
export async function fillRatesForGiftRange(
  sql: SqlClient,
  book: BtcUsdRateBook,
  nowMs: number,
): Promise<void> {
  const rows = await sql.query<{ min: Date | string | null; max: Date | string | null }>(
    `SELECT min(paid_at) AS min, max(paid_at) AS max
     FROM gift
     WHERE direction = 'outbound'`,
  );
  const row = rows[0];
  if (row === undefined || row.min === null || row.max === null) {
    return;
  }
  const minDate = row.min instanceof Date ? row.min : new Date(row.min);
  const maxDate = row.max instanceof Date ? row.max : new Date(row.max);
  const fromDay = utcDayFromMs(minDate.getTime());
  const toDay = utcDayFromMs(maxDate.getTime());
  await book.ensureDays(enumerateUtcDays(fromDay, toDay), nowMs);
}

/**
 * Deduplicate and keep only valid `YYYY-MM-DD` calendar days.
 *
 * @param days - Candidate day strings.
 * @returns Sorted unique valid days.
 */
function uniqueValidDays(days: readonly string[]): string[] {
  const set = new Set<string>();
  for (const day of days) {
    if (isValidUtcDay(day)) {
      set.add(day);
    }
  }
  return [...set].sort();
}

/**
 * Whether `day` is a real UTC calendar day `YYYY-MM-DD`.
 *
 * @param day - Candidate.
 * @returns `true` when valid.
 */
function isValidUtcDay(day: string): boolean {
  if (!DAY_RE.test(day)) {
    return false;
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return false;
  }
  return new Date(ms).toISOString().slice(0, 10) === day;
}

/**
 * UTC day string from epoch milliseconds.
 *
 * @param ms - Epoch ms.
 * @returns `YYYY-MM-DD`.
 */
function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Normalize a SQL `date` / text value to `YYYY-MM-DD`.
 *
 * @param value - Date or string from the driver.
 * @returns Day string or `null`.
 */
function normalizeDay(value: Date | string): string | null {
  if (value instanceof Date) {
    const day = value.toISOString().slice(0, 10);
    // Date#toISOString is always a real UTC calendar day; keep the guard.
    /* v8 ignore next -- Invalid Date throws before this return */
    return isValidUtcDay(day) ? day : null;
  }
  const day = value.length >= 10 ? value.slice(0, 10) : value;
  return isValidUtcDay(day) ? day : null;
}

/**
 * Inclusive UTC day list from `fromDay` through `toDay`.
 *
 * @param fromDay - Start day.
 * @param toDay - End day.
 * @returns Every UTC day in the range.
 */
function enumerateUtcDays(fromDay: string, toDay: string): string[] {
  const start = Date.parse(`${fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  const out: string[] = [];
  for (let ms = start; ms <= end; ms += MS_PER_DAY) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}
