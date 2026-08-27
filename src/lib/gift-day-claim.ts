import type { SqlClient } from '@/lib/auth/sql';

/**
 * One outbound gift per recipient per UTC calendar day.
 *
 * Claim *before* fetching a BOLT11 so a concurrent spend worker cannot
 * pay Lightning twice. Existing duplicate `gift` rows (legacy) still
 * count as already paid.
 */
export interface DayClaimStore {
  /**
   * Try to reserve `(handle, utcDay)`.
   *
   * @param handle - `recipient_wos_user`.
   * @param utcDay - `YYYY-MM-DD`.
   * @returns `true` if this caller owns the slot, `false` if already paid or claimed.
   */
  tryClaim(handle: string, utcDay: string): Promise<boolean>;
}

/**
 * Always allows a claim (tests / no database).
 */
export class AllowAllDayClaimStore implements DayClaimStore {
  /**
   * @returns Always `true`.
   */
  tryClaim(_handle: string, _utcDay: string): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/**
 * Process-local claims, plus an optional seed of already-paid `(handle, day)` pairs.
 */
export class InMemoryDayClaimStore implements DayClaimStore {
  private readonly claimed = new Set<string>();

  /**
   * @param alreadyPaid - Seed keys `handle\\0utcDay`.
   */
  constructor(alreadyPaid: Iterable<string> = []) {
    for (const key of alreadyPaid) {
      this.claimed.add(key);
    }
  }

  /**
   * @returns `false` when the pair was already claimed.
   */
  tryClaim(handle: string, utcDay: string): Promise<boolean> {
    const key = `${handle}\0${utcDay}`;
    if (this.claimed.has(key)) {
      return Promise.resolve(false);
    }
    this.claimed.add(key);
    return Promise.resolve(true);
  }
}

/** DDL for `gift_day_claim`. */
export const GIFT_DAY_CLAIM_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS gift_day_claim (
  recipient_wos_user text NOT NULL,
  utc_day date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_wos_user, utc_day)
);`;

/**
 * Create `gift_day_claim` if missing.
 *
 * @param sql - Shared boot client.
 */
export async function migrateGiftDayClaimSchema(sql: SqlClient): Promise<void> {
  await sql.execute(GIFT_DAY_CLAIM_SCHEMA_SQL);
}

/**
 * Durable claim: existing `gift` row that UTC day, else insert PK.
 */
export class SqlDayClaimStore implements DayClaimStore {
  /**
   * @param sql - Shared boot client.
   */
  constructor(private readonly sql: SqlClient) {}

  /**
   * @returns `false` when a gift or claim already exists for that UTC day.
   */
  async tryClaim(handle: string, utcDay: string): Promise<boolean> {
    const existing = await this.sql.query<{ one: number }>(
      `SELECT 1 AS one
         FROM gift
        WHERE direction = 'outbound'
          AND recipient_wos_user = $1
          AND (timezone('UTC', paid_at))::date = $2::date
        LIMIT 1`,
      [handle, utcDay],
    );
    if (existing.length > 0) {
      return false;
    }
    const inserted = await this.sql.query<{ utc_day: string }>(
      `INSERT INTO gift_day_claim (recipient_wos_user, utc_day)
       VALUES ($1, $2::date)
       ON CONFLICT (recipient_wos_user, utc_day) DO NOTHING
       RETURNING utc_day`,
      [handle, utcDay],
    );
    return inserted.length === 1;
  }
}
