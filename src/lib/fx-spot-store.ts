/**
 * Last good BTC spot quote for `GET /fx/spot` (one row; memory or Postgres).
 */

import type { SqlClient } from '@/lib/auth/sql';
import { SPOT_FIATS, type FxSpotQuote, type SpotFiat, type SpotRates } from '@/lib/fx-spot';

/** Idempotent DDL for the spot table (matches `docs/schema/btc_fiat_spot.sql`). */
export const BTC_FIAT_SPOT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS btc_fiat_spot (
  id smallint PRIMARY KEY CHECK (id = 1),
  usd numeric,
  chf numeric,
  eur numeric,
  php numeric,
  source text NOT NULL,
  as_of timestamptz NOT NULL
)`,
];

/** Keeps the latest quote. A save replaces the whole stored quote unless the stored one is newer. */
export interface FxSpotStore {
  /**
   * Read the stored quote.
   *
   * @returns The last saved quote, or `null` when none was ever saved.
   */
  latest(): Promise<FxSpotQuote | null>;
  /**
   * Replace the stored quote unless the stored one has a later `asOf` (several
   * processes refresh the same store). Currencies missing from `quote` are cleared.
   *
   * @param quote - Quote to keep.
   */
  save(quote: FxSpotQuote): Promise<void>;
}

/** Row shape selected from `btc_fiat_spot`. */
interface SpotRow {
  usd: string | null;
  chf: string | null;
  eur: string | null;
  php: string | null;
  source: string;
  as_of: Date | string;
}

/**
 * Apply {@link BTC_FIAT_SPOT_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateFxSpotSchema(sql: SqlClient): Promise<void> {
  for (const statement of BTC_FIAT_SPOT_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Copy only the four quoted currencies.
 *
 * @param rates - Source rates.
 * @returns A fresh rates object.
 */
function copyRates(rates: SpotRates): SpotRates {
  const out: SpotRates = {};
  for (const fiat of SPOT_FIATS) {
    const rate = rates[fiat];
    if (rate !== undefined) {
      out[fiat] = rate;
    }
  }
  return out;
}

/**
 * In-memory spot store (memory boots and tests). Lost on restart.
 */
export class InMemoryFxSpotStore implements FxSpotStore {
  #quote: FxSpotQuote | null;

  /**
   * @param seed - Optional starting quote.
   */
  constructor(seed?: FxSpotQuote) {
    this.#quote = seed === undefined ? null : { ...seed, rates: copyRates(seed.rates) };
  }

  /**
   * Read the stored quote.
   *
   * @returns A copy of the last saved quote, or `null`.
   */
  latest(): Promise<FxSpotQuote | null> {
    const quote = this.#quote;
    return Promise.resolve(quote === null ? null : { ...quote, rates: copyRates(quote.rates) });
  }

  /**
   * Replace the stored quote unless the stored one has a later `asOf`.
   *
   * @param quote - Quote to keep.
   * @returns Resolves once stored or skipped.
   */
  save(quote: FxSpotQuote): Promise<void> {
    if (this.#quote !== null && Date.parse(this.#quote.asOf) > Date.parse(quote.asOf)) {
      return Promise.resolve();
    }
    this.#quote = { ...quote, rates: copyRates(quote.rates) };
    return Promise.resolve();
  }
}

/**
 * Postgres spot store: one `btc_fiat_spot` row (`id = 1`), so a restart or a
 * provider outage still serves the last good quote.
 */
export class PostgresFxSpotStore implements FxSpotStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client.
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Read the stored row.
   *
   * @returns The quote, or `null` when the row does not exist or holds no rate.
   */
  async latest(): Promise<FxSpotQuote | null> {
    const rows = await this.#sql.query<SpotRow>(
      `SELECT usd::text AS usd, chf::text AS chf, eur::text AS eur, php::text AS php,
              source, as_of
       FROM btc_fiat_spot
       WHERE id = 1`,
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const rates: SpotRates = {};
    const values: Record<SpotFiat, string | null> = {
      USD: row.usd,
      CHF: row.chf,
      EUR: row.eur,
      PHP: row.php,
    };
    for (const fiat of SPOT_FIATS) {
      const value = values[fiat];
      if (value !== null) {
        rates[fiat] = String(value);
      }
    }
    if (Object.keys(rates).length === 0) {
      return null;
    }
    const asOf = row.as_of instanceof Date ? row.as_of : new Date(row.as_of);
    return { asOf: asOf.toISOString(), source: row.source, rates };
  }

  /**
   * Upsert the single row with every currency (missing ones become `NULL`). The
   * update only applies when the stored `as_of` is not later, so a delayed write
   * from another replica never replaces a newer quote.
   *
   * @param quote - Quote to keep.
   * @returns Resolves once the quote is written or skipped as older.
   */
  async save(quote: FxSpotQuote): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO btc_fiat_spot (id, usd, chf, eur, php, source, as_of)
       VALUES (1, $1::numeric, $2::numeric, $3::numeric, $4::numeric, $5, $6::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         usd = EXCLUDED.usd,
         chf = EXCLUDED.chf,
         eur = EXCLUDED.eur,
         php = EXCLUDED.php,
         source = EXCLUDED.source,
         as_of = EXCLUDED.as_of
       WHERE btc_fiat_spot.as_of <= EXCLUDED.as_of`,
      [
        quote.rates.USD ?? null,
        quote.rates.CHF ?? null,
        quote.rates.EUR ?? null,
        quote.rates.PHP ?? null,
        quote.source,
        quote.asOf,
      ],
    );
  }
}
