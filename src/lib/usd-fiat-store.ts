/**
 * Persisted USD→CHF/EUR/PHP daily ECB rates and the book used by gift stats.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { FetchFn } from '@/lib/btc-usd-candles';
import { fetchFiatRates, type FiatCandle } from '@/lib/usd-fiat-candles';

/** Idempotent DDL for the fiat table (matches `docs/schema/usd_fiat_daily.sql`). */
export const USD_FIAT_DAILY_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usd_fiat_daily (
  day date NOT NULL,
  quote text NOT NULL,
  rate numeric NOT NULL,
  as_of_day date NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (day, quote)
)`,
];

/** Frankfurter ECB source tag stored on each row. */
export const FX_SOURCE_FRANKFURTER_ECB = 'frankfurter-ecb';

/** Quote currencies converted from historical USD. */
export type FiatQuote = 'CHF' | 'EUR' | 'PHP';

/** USD-cross rates for one UTC day. Missing keys are omitted, not empty. */
export interface FiatCross {
  /** CHF per 1 USD, when known. */
  CHF?: string;
  /** EUR per 1 USD, when known. */
  EUR?: string;
  /** PHP per 1 USD, when known. */
  PHP?: string;
}

/**
 * Load persisted USD-fiat crosses; fetch and upsert days in needFetch
 * (missing quotes, stale UTC-today, after-midnight finalize of an
 * intraday print). Settled historical days are not re-fetched. Missing
 * fiat is omitted — callers must not 503.
 */
export interface FiatRateBook {
  /**
   * Ensure CHF/EUR/PHP crosses for the requested UTC days.
   *
   * @param days - UTC `YYYY-MM-DD` days (duplicates / invalid ignored).
   * @param nowMs - Clock for "today" and the one-hour refresh window.
   * @returns Map of day → available crosses; days with no quote omitted.
   */
  ensureDays(days: readonly string[], nowMs: number): Promise<ReadonlyMap<string, FiatCross>>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const ONE_HOUR_MS = 3_600_000;
const LOOKBACK_DAYS = 10;
const QUOTES: readonly FiatQuote[] = ['CHF', 'EUR', 'PHP'];

/** Row shape selected from `usd_fiat_daily`. */
interface UsdFiatRow {
  day: Date | string;
  quote: string;
  rate: string | number;
  fetched_at: Date | string;
}

/** Grouped persisted crosses plus per-quote fetch timestamps. */
interface StoredDay {
  rates: FiatCross;
  fetchedAtMs: Partial<Record<FiatQuote, number>>;
}

/**
 * Apply {@link USD_FIAT_DAILY_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateFiatSchema(sql: SqlClient): Promise<void> {
  for (const statement of USD_FIAT_DAILY_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * In-memory USD-fiat book. Returns the seed only — never HTTP.
 */
export class InMemoryFiatStore implements FiatRateBook {
  readonly #rates: ReadonlyMap<string, FiatCross>;

  /**
   * @param seed - Optional day → cross map or record.
   */
  constructor(seed?: ReadonlyMap<string, FiatCross> | Record<string, FiatCross>) {
    if (seed === undefined) {
      this.#rates = new Map();
    } else if (seed instanceof Map) {
      this.#rates = new Map(seed);
    } else {
      this.#rates = new Map(Object.entries(seed));
    }
  }

  /**
   * Return seeded crosses for the requested valid days. Missing days and
   * empty crosses are omitted.
   *
   * @param days - Requested UTC days.
   * @param _nowMs - Ignored (no refresh).
   * @returns Subset of the seed.
   */
  async ensureDays(
    days: readonly string[],
    _nowMs: number,
  ): Promise<ReadonlyMap<string, FiatCross>> {
    const out = new Map<string, FiatCross>();
    for (const day of uniqueValidDays(days)) {
      const seed = this.#rates.get(day);
      if (seed === undefined) {
        continue;
      }
      const cross = copyCross(seed);
      if (hasAnyQuote(cross)) {
        out.set(day, cross);
      }
    }
    return out;
  }
}

/**
 * Postgres-backed USD-fiat book that fills gaps from Frankfurter ECB rates.
 */
export class PostgresFiatStore implements FiatRateBook {
  readonly #sql: SqlClient;
  readonly #fetchImpl: FetchFn;
  readonly #ratesUrl: string;
  readonly #source: string;

  /**
   * @param args - SQL client, fetch, rates URL, optional source tag.
   */
  constructor(args: { sql: SqlClient; fetchImpl: FetchFn; ratesUrl: string; source?: string }) {
    this.#sql = args.sql;
    this.#fetchImpl = args.fetchImpl;
    this.#ratesUrl = args.ratesUrl;
    this.#source = args.source ?? FX_SOURCE_FRANKFURTER_ECB;
  }

  /**
   * Load crosses for `days`. INSERT … ON CONFLICT DO UPDATE only for days
   * in needFetch. Quotes with no candle within 10 days are skipped.
   * Still-missing quotes are omitted — the caller never 503s on fiat.
   *
   * @param days - Requested UTC days.
   * @param nowMs - Clock for today / one-hour refresh.
   * @returns Available day → cross map.
   */
  async ensureDays(
    days: readonly string[],
    nowMs: number,
  ): Promise<ReadonlyMap<string, FiatCross>> {
    const unique = uniqueValidDays(days);
    if (unique.length === 0) {
      return new Map();
    }

    const existing = await this.#selectDays(unique);
    const today = utcDayFromMs(nowMs);
    const needFetch: string[] = [];
    for (const day of unique) {
      const row = existing.get(day);
      if (row === undefined || isStaleDay(day, today, row, nowMs)) {
        needFetch.push(day);
      }
    }

    if (needFetch.length > 0) {
      const fetchedAt = new Date(nowMs).toISOString();
      const minDay = needFetch[0] as string;
      const maxDay = needFetch[needFetch.length - 1] as string;
      const fromMs = Date.parse(`${minDay}T00:00:00.000Z`) - LOOKBACK_DAYS * MS_PER_DAY;
      const fromDay = new Date(fromMs).toISOString().slice(0, 10);
      const candles = await fetchFiatRates({
        fetchImpl: this.#fetchImpl,
        url: this.#ratesUrl,
        fromDay,
        toDay: maxDay,
      });
      for (const day of needFetch) {
        for (const quote of QUOTES) {
          const candle = bestCandleOnOrBefore(candles, quote, day);
          if (candle === undefined) {
            continue;
          }
          await this.#sql.execute(
            `INSERT INTO usd_fiat_daily (day, quote, rate, as_of_day, source, fetched_at)
             VALUES ($1::date, $2, $3::numeric, $4::date, $5, $6::timestamptz)
             ON CONFLICT (day, quote) DO UPDATE SET
               rate = EXCLUDED.rate,
               as_of_day = EXCLUDED.as_of_day,
               source = EXCLUDED.source,
               fetched_at = EXCLUDED.fetched_at`,
            [day, quote, candle.rate, candle.day, this.#source, fetchedAt],
          );
        }
      }
    }

    const refreshed = await this.#selectDays(unique);
    const out = new Map<string, FiatCross>();
    for (const day of unique) {
      const row = refreshed.get(day);
      if (row === undefined) {
        continue;
      }
      const cross = copyCross(row.rates);
      /* v8 ignore next -- #selectDays only inserts days that have a quote */
      if (hasAnyQuote(cross)) {
        out.set(day, cross);
      }
    }
    return out;
  }

  /**
   * SELECT fiat rows for the given days, grouped by day.
   *
   * @param days - Valid UTC days.
   * @returns Map of day → rates + per-quote fetched_at ms.
   */
  async #selectDays(days: readonly string[]): Promise<Map<string, StoredDay>> {
    const placeholders = days.map((_, i) => `$${i + 1}::date`).join(', ');
    const rows = await this.#sql.query<UsdFiatRow>(
      `SELECT day::text AS day, quote, rate::text AS rate, fetched_at
       FROM usd_fiat_daily
       WHERE day IN (${placeholders})`,
      days,
    );
    const out = new Map<string, StoredDay>();
    for (const row of rows) {
      const day = normalizeDay(row.day);
      if (day === null) {
        continue;
      }
      const quote = parseFiatQuote(row.quote);
      if (quote === null) {
        continue;
      }
      const fetchedAtMs =
        row.fetched_at instanceof Date
          ? row.fetched_at.getTime()
          : new Date(row.fetched_at).getTime();
      const stored = out.get(day) ?? { rates: {}, fetchedAtMs: {} };
      assignQuote(stored.rates, quote, String(row.rate));
      stored.fetchedAtMs[quote] = fetchedAtMs;
      out.set(day, stored);
    }
    return out;
  }
}

/**
 * Pre-fill USD-fiat rates for every UTC day from the earliest through latest
 * outbound gift. No-op when there are no outbound gifts. Does not catch —
 * callers (boot) decide whether to swallow errors.
 *
 * @param sql - SQL client for the gift range query.
 * @param book - Fiat book to fill.
 * @param nowMs - Clock passed to `ensureDays`.
 * @returns Resolves when ensureDays has run, or immediately on no-op.
 */
export async function fillFiatRatesForGiftRange(
  sql: SqlClient,
  book: FiatRateBook,
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
 * Copy a cross so callers cannot mutate the seed; only assign keys that exist.
 *
 * @param seed - Source cross.
 * @returns A new object with the same present quotes.
 */
function copyCross(seed: FiatCross): FiatCross {
  const cross: FiatCross = {};
  if (seed.CHF !== undefined) {
    cross.CHF = seed.CHF;
  }
  if (seed.EUR !== undefined) {
    cross.EUR = seed.EUR;
  }
  if (seed.PHP !== undefined) {
    cross.PHP = seed.PHP;
  }
  return cross;
}

/**
 * Whether at least one quote is present.
 *
 * @param cross - Candidate.
 * @returns `true` when CHF, EUR, or PHP is set.
 */
function hasAnyQuote(cross: FiatCross): boolean {
  return cross.CHF !== undefined || cross.EUR !== undefined || cross.PHP !== undefined;
}

/**
 * Whether a stored day must be re-fetched (missing quote, stale today, or
 * unsettled close).
 *
 * @param day - Gift UTC day.
 * @param today - UTC today from `nowMs`.
 * @param stored - Persisted quotes and fetch times.
 * @param nowMs - Clock.
 * @returns `true` when any quote is missing or stale.
 */
function isStaleDay(day: string, today: string, stored: StoredDay, nowMs: number): boolean {
  for (const quote of QUOTES) {
    const fetchedAtMs = stored.fetchedAtMs[quote];
    if (fetchedAtMs === undefined) {
      return true;
    }
    if (day === today && fetchedAtMs < nowMs - ONE_HOUR_MS) {
      return true;
    }
    if (day < today && utcDayFromMs(fetchedAtMs) === day) {
      return true;
    }
  }
  return false;
}

/**
 * Pick the candle for `quote` with the greatest `day` ≤ `targetDay` within 10 days.
 *
 * @param candles - Parsed Frankfurter rows.
 * @param quote - Desired quote.
 * @param targetDay - Gift UTC lookup day.
 * @returns Best candle, or `undefined` when none qualify.
 */
function bestCandleOnOrBefore(
  candles: readonly FiatCandle[],
  quote: FiatQuote,
  targetDay: string,
): FiatCandle | undefined {
  const dayMs = Date.parse(`${targetDay}T00:00:00.000Z`);
  const minMs = dayMs - LOOKBACK_DAYS * MS_PER_DAY;
  let best: FiatCandle | undefined;
  for (const candle of candles) {
    if (candle.quote !== quote) {
      continue;
    }
    const candleMs = Date.parse(`${candle.day}T00:00:00.000Z`);
    if (
      /* v8 ignore next -- parseFrankfurterRates only emits real YYYY-MM-DD */
      Number.isNaN(candleMs) ||
      candleMs > dayMs ||
      candleMs < minMs
    ) {
      continue;
    }
    if (best === undefined || candle.day > best.day) {
      best = candle;
    }
  }
  return best;
}

/**
 * Assign a quote key only when the rate exists (`exactOptionalPropertyTypes`).
 *
 * @param cross - Target object.
 * @param quote - Quote code.
 * @param rate - Decimal string.
 */
function assignQuote(cross: FiatCross, quote: FiatQuote, rate: string): void {
  if (quote === 'CHF') {
    cross.CHF = rate;
    return;
  }
  if (quote === 'EUR') {
    cross.EUR = rate;
    return;
  }
  cross.PHP = rate;
}

/**
 * Parse a SQL quote column into a {@link FiatQuote}.
 *
 * @param value - Raw quote text.
 * @returns Uppercase quote or `null`.
 */
function parseFiatQuote(value: string): FiatQuote | null {
  const code = value.toUpperCase();
  if (code === 'CHF' || code === 'EUR' || code === 'PHP') {
    return code;
  }
  return null;
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
