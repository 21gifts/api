/**
 * Persistence for funding-program grants (one row per account).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Column layout matches `docs/schema/funding_grant.sql`.
 */

import type { SqlClient } from '@/lib/auth/sql';
import {
  effectiveStatus,
  expiredTrialAsPending,
  type FundingGrant,
  type FundingStatus,
} from '@/lib/funding';

/**
 * Persistence port for funding grants.
 */
export interface FundingStore {
  /**
   * The grant for `accountId`, if any.
   *
   * @param accountId - Account that applied.
   * @returns A copy of the stored grant, or `undefined` when none.
   */
  getByAccountId(accountId: string): Promise<FundingGrant | undefined>;

  /**
   * Every stored grant, oldest `appliedAt` first, then `accountId` ascending.
   *
   * @returns Grant copies (caller-owned).
   */
  listGrants(): Promise<FundingGrant[]>;

  /**
   * Insert or replace the grant for `grant.accountId`.
   *
   * @param grant - Fully formed grant.
   * @returns The stored grant (a copy).
   */
  upsert(grant: FundingGrant): Promise<FundingGrant>;
}

/** Idempotent DDL for the funding_grant table (matches `docs/schema/funding_grant.sql`). */
export const FUNDING_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS funding_grant (
  account_id uuid PRIMARY KEY REFERENCES account (id),
  status text NOT NULL CHECK (status IN ('pending', 'trial', 'admitted', 'rejected')),
  applied_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by uuid REFERENCES account (id),
  trial_utc_date date,
  admitted_at timestamptz,
  note text
)`,
];

const FUNDING_SELECT =
  'account_id, status, applied_at, decided_at, decided_by, trial_utc_date, admitted_at, note';

/**
 * Apply {@link FUNDING_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateFundingSchema(sql: SqlClient): Promise<void> {
  for (const statement of FUNDING_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * If the stored trial is expired, persist pending via
 * {@link expiredTrialAsPending} only when the row is still that trial
 * (compare-and-set) and return that; else return the grant.
 *
 * @param store - Funding persistence.
 * @param accountId - Account that applied.
 * @param nowMs - Epoch milliseconds (UTC day).
 * @returns The observed grant (lazy-persisted when an expired trial still
 *   matches), or `undefined` when no row.
 */
export async function loadGrantEffective(
  store: FundingStore,
  accountId: string,
  nowMs: number,
): Promise<FundingGrant | undefined> {
  const grant = await store.getByAccountId(accountId);
  if (grant === undefined) {
    return undefined;
  }
  if (
    effectiveStatus(grant, nowMs) === 'pending' &&
    grant.status === 'trial' &&
    grant.trialUtcDate !== null
  ) {
    return persistExpiredTrial(store, grant);
  }
  return copyGrant(grant);
}

/**
 * Rewrite expired trial → pending only while the row is still that trial.
 * Postgres uses `UPDATE … WHERE status='trial' AND trial_utc_date`; InMemory
 * re-reads, then upserts pending or returns the current row.
 *
 * @param store - Funding persistence.
 * @param grant - Expired trial from the first read.
 * @returns Pending when the CAS matched, else the current row.
 */
async function persistExpiredTrial(
  store: FundingStore,
  grant: FundingGrant,
): Promise<FundingGrant | undefined> {
  if (store instanceof PostgresFundingStore) {
    return store.expireTrialIfUnchanged(grant);
  }
  const current = await store.getByAccountId(grant.accountId);
  if (
    current !== undefined &&
    current.status === 'trial' &&
    current.trialUtcDate === grant.trialUtcDate
  ) {
    return store.upsert(expiredTrialAsPending(grant));
  }
  return current;
}

/**
 * Process-local {@link FundingStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryFundingStore implements FundingStore {
  readonly #grants = new Map<string, FundingGrant>();

  /**
   * @param seed - Optional seed grants; copied into private storage.
   */
  constructor(seed: readonly FundingGrant[] = []) {
    for (const grant of seed) {
      this.#grants.set(grant.accountId, copyGrant(grant));
    }
  }

  /**
   * Copy of the grant for `accountId`, or `undefined`.
   *
   * @param accountId - Account that applied.
   * @returns A copy, or `undefined` when none.
   */
  getByAccountId(accountId: string): Promise<FundingGrant | undefined> {
    const grant = this.#grants.get(accountId);
    return Promise.resolve(grant === undefined ? undefined : copyGrant(grant));
  }

  /**
   * Oldest-`appliedAt` copy of every stored grant, then `accountId` ascending.
   *
   * @returns A new array of copies; mutating it does not change the store.
   */
  listGrants(): Promise<FundingGrant[]> {
    return Promise.resolve([...this.#grants.values()].sort(compareGrants).map(copyGrant));
  }

  /**
   * Replace the grant for `grant.accountId` and return a copy.
   *
   * @param grant - Grant to store.
   * @returns A copy of the stored grant.
   */
  upsert(grant: FundingGrant): Promise<FundingGrant> {
    const stored = copyGrant(grant);
    this.#grants.set(stored.accountId, stored);
    return Promise.resolve(copyGrant(stored));
  }
}

/** Row shape selected from `funding_grant`. */
interface FundingSqlRow {
  account_id: string;
  status: FundingStatus;
  applied_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
  trial_utc_date: Date | string | null;
  admitted_at: Date | string | null;
  note: string | null;
}

/** Map a SQL row onto {@link FundingGrant}. Unexported. */
function mapFundingRow(row: FundingSqlRow): FundingGrant {
  return {
    accountId: row.account_id,
    status: row.status,
    appliedAt: epochMs(row.applied_at),
    decidedAt: nullableEpochMs(row.decided_at),
    decidedBy: row.decided_by,
    trialUtcDate: mapTrialUtcDate(row.trial_utc_date),
    admittedAt: nullableEpochMs(row.admitted_at),
    note: row.note,
  };
}

/**
 * Durable {@link FundingStore} backed by Postgres.
 */
export class PostgresFundingStore implements FundingStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * One row from `funding_grant` by account.
   *
   * @param accountId - Account that applied (`$1`).
   * @returns The mapped grant, or `undefined` when none.
   */
  async getByAccountId(accountId: string): Promise<FundingGrant | undefined> {
    const rows = await this.#sql.query<FundingSqlRow>(
      `SELECT ${FUNDING_SELECT} FROM funding_grant WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapFundingRow(row);
  }

  /**
   * Oldest-first list from `funding_grant`.
   *
   * @returns Mapped rows.
   */
  async listGrants(): Promise<FundingGrant[]> {
    const rows = await this.#sql.query<FundingSqlRow>(
      `SELECT ${FUNDING_SELECT} FROM funding_grant ORDER BY applied_at ASC, account_id ASC`,
    );
    return rows.map((row) => mapFundingRow(row));
  }

  /**
   * Insert or replace `grant` in `funding_grant` and return a copy.
   *
   * @param grant - Fully formed grant.
   * @returns The input grant after a successful upsert (a copy).
   */
  async upsert(grant: FundingGrant): Promise<FundingGrant> {
    await this.#sql.execute(
      `INSERT INTO funding_grant (account_id, status, applied_at, decided_at, decided_by, trial_utc_date, admitted_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status,
         applied_at = EXCLUDED.applied_at,
         decided_at = EXCLUDED.decided_at,
         decided_by = EXCLUDED.decided_by,
         trial_utc_date = EXCLUDED.trial_utc_date,
         admitted_at = EXCLUDED.admitted_at,
         note = EXCLUDED.note`,
      [
        grant.accountId,
        grant.status,
        new Date(grant.appliedAt),
        grant.decidedAt === null ? null : new Date(grant.decidedAt),
        grant.decidedBy,
        grant.trialUtcDate,
        grant.admittedAt === null ? null : new Date(grant.admittedAt),
        grant.note,
      ],
    );
    return copyGrant(grant);
  }

  /**
   * Persist pending only when the row is still `status='trial'` with
   * `grant.trialUtcDate`. Zero matching rows → current row via
   * {@link getByAccountId}.
   *
   * @param grant - Expired trial from the first read.
   * @returns The pending row when the CAS matched, else the current grant.
   */
  async expireTrialIfUnchanged(grant: FundingGrant): Promise<FundingGrant | undefined> {
    const pending = expiredTrialAsPending(grant);
    const rows = await this.#sql.query<FundingSqlRow>(
      `UPDATE funding_grant SET
         status = $3,
         applied_at = $4,
         decided_at = $5,
         decided_by = $6,
         trial_utc_date = $7,
         admitted_at = $8,
         note = $9
       WHERE account_id = $1 AND status = 'trial' AND trial_utc_date = $2
       RETURNING ${FUNDING_SELECT}`,
      [
        grant.accountId,
        grant.trialUtcDate,
        pending.status,
        new Date(pending.appliedAt),
        pending.decidedAt === null ? null : new Date(pending.decidedAt),
        pending.decidedBy,
        pending.trialUtcDate,
        null,
        pending.note,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      return this.getByAccountId(grant.accountId);
    }
    return mapFundingRow(row);
  }
}

/** Caller-owned shallow copy. */
function copyGrant(grant: FundingGrant): FundingGrant {
  return { ...grant };
}

/** Oldest `appliedAt` first, then `accountId` ascending. */
function compareGrants(a: FundingGrant, b: FundingGrant): number {
  const byTime = a.appliedAt - b.appliedAt;
  if (byTime !== 0) {
    return byTime;
  }
  return a.accountId.localeCompare(b.accountId);
}

/** `timestamptz` (Date or ISO string) to epoch ms. */
function epochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Nullable `timestamptz` to epoch ms. `null` stays `null`. */
function nullableEpochMs(value: Date | string | null): number | null {
  return value === null ? null : epochMs(value);
}

/**
 * SQL `date` to `YYYY-MM-DD`. Date → ISO day; string → first ten chars;
 * `null` stays `null`.
 */
function mapTrialUtcDate(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}
