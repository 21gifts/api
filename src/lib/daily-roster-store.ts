/**
 * Persistence for the daily payout roster (amounts, both payment switches,
 * comment, daily recipients, and moderators). Rows are keyed by account; the
 * payout address is not stored but resolved from the account when it is paid.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Column layout matches `docs/schema/daily_roster.sql`.
 * `defaultAmountUsd` is never stored; every read sets
 * {@link DAILY_ROSTER_DEFAULT_AMOUNT_USD}.
 */

import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';
import {
  DAILY_ROSTER_ADDRESS_LISTED,
  DAILY_ROSTER_INVALID_ADDRESS,
  DAILY_ROSTER_INVALID_COMMENT,
  DAILY_ROSTER_INVALID_PAYMENTS,
  DAILY_ROSTER_UNKNOWN_ADDRESS,
  DailyRosterRequestError,
  normalizeDailyRosterComment,
  type DailyRosterDocument,
  type DailyRosterEntry,
} from '@/lib/daily-roster';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

/** USD paid to an unlisted admitted or trial grant. Never persisted. */
export const DAILY_ROSTER_DEFAULT_AMOUNT_USD = 1;

/** Listed-row bucket. The same account may be listed in both. */
export type DailyRosterBucket = 'daily' | 'moderator';

/**
 * Persistence port for the daily payout roster.
 *
 * Methods throw {@link DailyRosterRequestError} 400 with the same texts the
 * former spend roster used. Unexpected store failures propagate.
 */
export interface DailyRosterStore {
  /**
   * Current document. A never-written store is the empty defaults.
   *
   * @returns A caller-owned copy. `defaultAmountUsd` is always
   *   {@link DAILY_ROSTER_DEFAULT_AMOUNT_USD}.
   */
  get(): Promise<DailyRosterDocument>;

  /**
   * Whether a roster has been stored. False only before the first write.
   * A saved empty roster is true. Do not infer this from an empty document.
   */
  hasBeenWritten(): Promise<boolean>;

  /**
   * Replace the payment comment.
   *
   * @param comment - Comment text (newlines folded by the store).
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Invalid comment'`.
   */
  setComment(comment: string): Promise<DailyRosterDocument>;

  /**
   * Turn daily payments on or off.
   *
   * @param enabled - Payments switch.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Invalid payments switch'`.
   */
  setPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument>;

  /**
   * Turn moderator payments on or off.
   *
   * @param enabled - Moderator payments switch.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Invalid payments switch'`.
   */
  setModeratorPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument>;

  /**
   * Add a daily recipient.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  addRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Replace the USD amount for a daily recipient already on the roster.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  updateRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Remove a daily recipient.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Unknown address'`.
   */
  deleteRecipient(accountId: string): Promise<DailyRosterDocument>;

  /**
   * Add a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  addModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Replace the USD amount for a moderator already on the roster.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  updateModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Remove a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Unknown address'`.
   */
  deleteModerator(accountId: string): Promise<DailyRosterDocument>;

  /**
   * Every stored row, linked to an account or not, for the operator check
   * of the account link (see {@link DailyRosterLinkReport}).
   *
   * @returns Row counts, the rows without an account, and USD sums per bucket.
   */
  linkReport(): Promise<DailyRosterLinkReport>;

  /**
   * Write the full document only when it has never been written. A second
   * call, including an invalid body, does not insert the body and returns the
   * stored document.
   * `defaultAmountUsd` in the body is ignored. A missing switch is `true`.
   * Body rows carry an `address`; a row is listed only once it is linked to
   * an account (see {@link linkDailyRosterAccounts}).
   *
   * @param body - Parsed JSON.
   * @returns The stored document.
   * @throws {@link DailyRosterRequestError} 400 on the first write only.
   */
  importDocument(body: unknown): Promise<DailyRosterDocument>;
}

/** Idempotent DDL (matches `docs/schema/daily_roster.sql`). */
export const DAILY_ROSTER_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS daily_roster (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  comment text NOT NULL,
  payments_enabled boolean NOT NULL,
  moderator_payments_enabled boolean NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS daily_roster_entry (
  id serial PRIMARY KEY,
  address text NOT NULL,
  amount_usd double precision NOT NULL CHECK (amount_usd > 0),
  bucket text NOT NULL CHECK (bucket IN ('daily', 'moderator')),
  UNIQUE (address, bucket)
)`,
  `ALTER TABLE daily_roster_entry ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES account (id)`,
  `ALTER TABLE daily_roster_entry ALTER COLUMN address DROP NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS daily_roster_entry_account_bucket_uidx
    ON daily_roster_entry (account_id, bucket)`,
];

/**
 * Apply {@link DAILY_ROSTER_SCHEMA_SQL} in order. Idempotent. Needs `account`.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateDailyRosterSchema(sql: SqlClient): Promise<void> {
  for (const statement of DAILY_ROSTER_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * One statement that links rows without an account (see
 * {@link linkDailyRosterAccounts}). `$1` is the lower-cased host, or null.
 * The UPDATE runs as one statement, so `trg_db_change` records each row.
 */
export const DAILY_ROSTER_ACCOUNT_LINK_SQL = `WITH matched AS (
  SELECT c.id, c.bucket,
         CASE WHEN c.legacy_id IS NULL OR c.legacy_id = c.wallet_id THEN c.wallet_id
              WHEN c.wallet_id IS NULL THEN c.legacy_id END AS account_id
    FROM (
      SELECT e.id, e.bucket,
             (SELECT a.id FROM account a
               WHERE lower(btrim(a.lightning_address)) = lower(btrim(e.address))) AS legacy_id,
             (SELECT a.id FROM account a
               WHERE $1::text IS NOT NULL AND btrim(coalesce(a.username, '')) <> ''
                 AND lower(btrim(a.username)) || '@' || $1::text = lower(btrim(e.address))) AS wallet_id
        FROM daily_roster_entry e
       WHERE e.account_id IS NULL AND e.address IS NOT NULL
    ) c
),
ranked AS (
  SELECT m.id, m.account_id,
         row_number() OVER (PARTITION BY m.account_id, m.bucket ORDER BY m.id) AS position
    FROM matched m
   WHERE m.account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM daily_roster_entry t
        WHERE t.account_id = m.account_id AND t.bucket = m.bucket
     )
),
linked AS (
  UPDATE daily_roster_entry u
     SET account_id = r.account_id
    FROM ranked r
   WHERE u.id = r.id AND r.position = 1
  RETURNING u.id
)
SELECT (SELECT count(*) FROM linked)::int AS linked,
       ((SELECT count(*) FROM daily_roster_entry WHERE account_id IS NULL)
         - (SELECT count(*) FROM linked))::int AS unlinked`;

/** Counts from {@link linkDailyRosterAccounts}. */
export interface DailyRosterAccountLink {
  /** Rows this run linked to an account. */
  linked: number;
  /** Rows still without an account after this run. They are never paid. */
  unlinked: number;
}

/**
 * Link every roster row without an account to the account it names.
 *
 * A row's trimmed address is compared case-insensitively with the legacy
 * `account.lightning_address` (unique per account), and, when `host` is
 * given, with `<username>@<host>`. A row whose two matches name different
 * accounts is linked to neither. Per account and
 * bucket only one row is linked: none when the bucket already holds a row of
 * that account, else the lowest `id`. Rows that match no account keep a null
 * `account_id`, are left out of every document, and are never paid. Amounts,
 * buckets, and addresses are not changed and no row is deleted. Runs as
 * {@link DAILY_ROSTER_ACCOUNT_LINK_SQL}, one statement. A second run changes
 * nothing. Needs `account` and `daily_roster_entry`.
 *
 * @param sql - Parameter-bound SQL client.
 * @param host - Host of `PUBLIC_BASE_URL` (`LnurlServerConfig.host`), or null when the LNURL server is off.
 * @returns How many rows this run linked and how many stay without an account.
 */
export async function linkDailyRosterAccounts(
  sql: SqlClient,
  host: string | null,
): Promise<DailyRosterAccountLink> {
  const [row] = await sql.query<{ linked: number | string; unlinked: number | string }>(
    DAILY_ROSTER_ACCOUNT_LINK_SQL,
    [host === null ? null : host.toLowerCase()],
  );
  return { linked: Number(row?.linked ?? 0), unlinked: Number(row?.unlinked ?? 0) };
}

/** One stored row without an account in {@link DailyRosterLinkReport}. */
export interface DailyRosterUnlinkedRow {
  /** Bucket of the row. */
  bucket: DailyRosterBucket;
  /** Stored legacy address, or `null`. */
  address: string | null;
  /** Stored USD amount. */
  amountUsd: number;
}

/** USD sums of one bucket in {@link DailyRosterLinkReport}. */
export interface DailyRosterBucketSums {
  /** Stored rows of the bucket. */
  rows: number;
  /** Rows of the bucket linked to an account. */
  linked: number;
  /** Sum over every stored row of the bucket. */
  totalUsd: number;
  /** Sum over the rows linked to an account: what the bucket pays. */
  linkedUsd: number;
}

/**
 * Operator check of the account link: every stored row, linked or not.
 * `rows` minus `linked` rows are never paid; they are listed in `unlinked`.
 */
export interface DailyRosterLinkReport {
  /** Every stored row, both buckets. */
  rows: number;
  /** Rows linked to an account, both buckets. */
  linked: number;
  /** Rows without an account, in stored order (`id` order in Postgres). */
  unlinked: DailyRosterUnlinkedRow[];
  /** Counts and USD sums per bucket. */
  buckets: Record<DailyRosterBucket, DailyRosterBucketSums>;
}

/** One stored row: an account, or a legacy address not linked to one. */
interface StoredRosterRow {
  accountId: string | null;
  address: string | null;
  amountUsd: number;
}

/**
 * Process-local {@link DailyRosterStore}. Used in tests and when no database
 * URL is configured — the process still boots. It has no accounts, so an
 * imported address row stays without an account and is not listed.
 */
export class InMemoryDailyRosterStore implements DailyRosterStore {
  #written = false;
  #comment = '';
  #paymentsEnabled = true;
  #moderatorPaymentsEnabled = true;
  readonly #recipients: StoredRosterRow[] = [];
  readonly #moderators: StoredRosterRow[] = [];

  /**
   * @param seed - Optional already-written document; copied into private storage.
   */
  constructor(seed?: DailyRosterDocument) {
    if (seed === undefined) {
      return;
    }
    this.#written = true;
    this.#comment = seed.comment;
    this.#paymentsEnabled = seed.paymentsEnabled;
    this.#moderatorPaymentsEnabled = seed.moderatorPaymentsEnabled;
    this.#recipients.push(...seed.recipients.map(storedRow));
    this.#moderators.push(...seed.moderators.map(storedRow));
  }

  /**
   * Caller-owned copy of the current document.
   *
   * @returns Empty defaults when never written.
   */
  get(): Promise<DailyRosterDocument> {
    return Promise.resolve(this.#snapshot());
  }

  /**
   * Whether a roster has been stored. False only before the first write.
   * A saved empty roster is true. Do not infer this from an empty document.
   *
   * @returns `this.#written`.
   */
  hasBeenWritten(): Promise<boolean> {
    return Promise.resolve(this.#written);
  }

  /**
   * Fold newlines, trim, refuse length over 500, then store.
   *
   * @param comment - Comment text.
   * @returns The document after the change.
   */
  async setComment(comment: string): Promise<DailyRosterDocument> {
    this.#comment = foldedComment(comment);
    this.#written = true;
    return Promise.resolve(this.#snapshot());
  }

  /**
   * Store the daily payments switch.
   *
   * @param enabled - Payments switch.
   * @returns The document after the change.
   */
  async setPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument> {
    requireSwitch(enabled);
    this.#paymentsEnabled = enabled;
    this.#written = true;
    return Promise.resolve(this.#snapshot());
  }

  /**
   * Store the moderator payments switch.
   *
   * @param enabled - Moderator payments switch.
   * @returns The document after the change.
   */
  async setModeratorPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument> {
    requireSwitch(enabled);
    this.#moderatorPaymentsEnabled = enabled;
    this.#written = true;
    return Promise.resolve(this.#snapshot());
  }

  /**
   * Append a daily recipient.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async addRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('daily', accountId, amountUsd);
  }

  /**
   * Replace a daily recipient amount.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async updateRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('daily', accountId, amountUsd);
  }

  /**
   * Remove a daily recipient.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   */
  async deleteRecipient(accountId: string): Promise<DailyRosterDocument> {
    return this.#delete('daily', accountId);
  }

  /**
   * Append a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async addModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('moderator', accountId, amountUsd);
  }

  /**
   * Replace a moderator stipend amount.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async updateModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('moderator', accountId, amountUsd);
  }

  /**
   * Remove a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   */
  async deleteModerator(accountId: string): Promise<DailyRosterDocument> {
    return this.#delete('moderator', accountId);
  }

  /**
   * Every stored row, linked or not.
   *
   * @returns Counts, the rows without an account, and USD sums per bucket.
   */
  linkReport(): Promise<DailyRosterLinkReport> {
    return Promise.resolve(
      buildLinkReport([
        ...this.#recipients.map((row) => ({ ...row, bucket: 'daily' as const })),
        ...this.#moderators.map((row) => ({ ...row, bucket: 'moderator' as const })),
      ]),
    );
  }

  /**
   * First write of the full document, or a no-op when already written.
   * Imported rows keep their address and no account.
   *
   * @param body - Parsed JSON.
   * @returns The stored document.
   */
  async importDocument(body: unknown): Promise<DailyRosterDocument> {
    if (this.#written) {
      return Promise.resolve(this.#snapshot());
    }
    const parsed = parseImportBody(body);
    this.#comment = parsed.comment;
    this.#paymentsEnabled = parsed.paymentsEnabled;
    this.#moderatorPaymentsEnabled = parsed.moderatorPaymentsEnabled;
    this.#recipients.splice(0, this.#recipients.length, ...parsed.recipients.map(importedRow));
    this.#moderators.splice(0, this.#moderators.length, ...parsed.moderators.map(importedRow));
    this.#written = true;
    return Promise.resolve(this.#snapshot());
  }

  #list(bucket: DailyRosterBucket): StoredRosterRow[] {
    return bucket === 'daily' ? this.#recipients : this.#moderators;
  }

  #add(bucket: DailyRosterBucket, accountId: string, amountUsd: number): DailyRosterDocument {
    const row = listedRow(accountId, amountUsd);
    const list = this.#list(bucket);
    if (list.some((item) => item.accountId === row.accountId)) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_ADDRESS_LISTED);
    }
    this.#written = true;
    list.push(storedRow(row));
    return this.#snapshot();
  }

  #update(bucket: DailyRosterBucket, accountId: string, amountUsd: number): DailyRosterDocument {
    const row = listedRow(accountId, amountUsd);
    const found = this.#list(bucket).find((item) => item.accountId === row.accountId);
    if (found === undefined) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    this.#written = true;
    found.amountUsd = row.amountUsd;
    return this.#snapshot();
  }

  #delete(bucket: DailyRosterBucket, accountId: string): DailyRosterDocument {
    const id = rosterAccountId(accountId);
    const list = this.#list(bucket);
    const index = list.findIndex((item) => item.accountId === id);
    if (index < 0) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    this.#written = true;
    list.splice(index, 1);
    return this.#snapshot();
  }

  #snapshot(): DailyRosterDocument {
    return {
      comment: this.#comment,
      paymentsEnabled: this.#paymentsEnabled,
      moderatorPaymentsEnabled: this.#moderatorPaymentsEnabled,
      defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
      recipients: listedEntries(this.#recipients),
      moderators: listedEntries(this.#moderators),
    };
  }
}

/** Settings row from `daily_roster`. */
interface DailyRosterSettingsRow {
  comment: string;
  payments_enabled: boolean;
  moderator_payments_enabled: boolean;
}

/** Entry row from `daily_roster_entry`. */
interface DailyRosterEntryRow {
  account_id: string | null;
  address: string | null;
  amount_usd: number | string;
  bucket: DailyRosterBucket;
}

const SETTINGS_SELECT = 'comment, payments_enabled, moderator_payments_enabled';
const ENTRY_SELECT = 'account_id, address, amount_usd, bucket';

/**
 * Durable {@link DailyRosterStore} backed by Postgres.
 */
export class PostgresDailyRosterStore implements DailyRosterStore {
  readonly #sql: SqlClient;
  readonly #host: string | null;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   * @param host - Host of `PUBLIC_BASE_URL` for {@link linkDailyRosterAccounts} after an import, or null.
   */
  constructor(sql: SqlClient, host: string | null = null) {
    this.#sql = sql;
    this.#host = host;
  }

  /**
   * Settings plus the rows linked to an account, ordered by `id`. No settings
   * row is the empty document.
   *
   * @returns A caller-owned copy.
   */
  async get(): Promise<DailyRosterDocument> {
    return this.#load();
  }

  /**
   * Whether a roster has been stored. False only before the first write.
   * A saved empty roster is true. Do not infer this from an empty document.
   *
   * @returns True iff the `daily_roster` singleton row exists.
   */
  async hasBeenWritten(): Promise<boolean> {
    const settings = await this.#settings();
    return settings !== undefined;
  }

  /**
   * Fold newlines, trim, refuse length over 500, then store.
   *
   * @param comment - Comment text.
   * @returns The document after the change.
   */
  async setComment(comment: string): Promise<DailyRosterDocument> {
    const folded = foldedComment(comment);
    await this.#sql.execute(
      `INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
       VALUES (true, $1, true, true)
       ON CONFLICT (singleton) DO UPDATE SET comment = EXCLUDED.comment`,
      [folded],
    );
    return this.#load();
  }

  /**
   * Store the daily payments switch.
   *
   * @param enabled - Payments switch.
   * @returns The document after the change.
   */
  async setPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument> {
    requireSwitch(enabled);
    await this.#sql.execute(
      `INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
       VALUES (true, '', $1, true)
       ON CONFLICT (singleton) DO UPDATE SET payments_enabled = EXCLUDED.payments_enabled`,
      [enabled],
    );
    return this.#load();
  }

  /**
   * Store the moderator payments switch.
   *
   * @param enabled - Moderator payments switch.
   * @returns The document after the change.
   */
  async setModeratorPaymentsEnabled(enabled: boolean): Promise<DailyRosterDocument> {
    requireSwitch(enabled);
    await this.#sql.execute(
      `INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
       VALUES (true, '', true, $1)
       ON CONFLICT (singleton) DO UPDATE
         SET moderator_payments_enabled = EXCLUDED.moderator_payments_enabled`,
      [enabled],
    );
    return this.#load();
  }

  /**
   * Append a daily recipient.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  addRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('daily', accountId, amountUsd);
  }

  /**
   * Replace a daily recipient amount.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  updateRecipient(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('daily', accountId, amountUsd);
  }

  /**
   * Remove a daily recipient.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   */
  deleteRecipient(accountId: string): Promise<DailyRosterDocument> {
    return this.#delete('daily', accountId);
  }

  /**
   * Append a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  addModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('moderator', accountId, amountUsd);
  }

  /**
   * Replace a moderator stipend amount.
   *
   * @param accountId - Listed account.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  updateModerator(accountId: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('moderator', accountId, amountUsd);
  }

  /**
   * Remove a moderator stipend row.
   *
   * @param accountId - Listed account.
   * @returns The document after the change.
   */
  deleteModerator(accountId: string): Promise<DailyRosterDocument> {
    return this.#delete('moderator', accountId);
  }

  /**
   * Every stored row, linked or not, in `id` order.
   *
   * @returns Counts, the rows without an account, and USD sums per bucket.
   */
  async linkReport(): Promise<DailyRosterLinkReport> {
    const rows = await this.#entries();
    return buildLinkReport(
      rows.map((row) => ({
        accountId: row.account_id,
        address: row.address,
        amountUsd: Number(row.amount_usd),
        bucket: row.bucket,
      })),
    );
  }

  /**
   * First write of the full document; a later call does not insert the body.
   * Every call then links the address rows with {@link linkDailyRosterAccounts},
   * so a retry after a failed link still links them.
   *
   * @param body - Parsed JSON.
   * @returns The stored document.
   */
  async importDocument(body: unknown): Promise<DailyRosterDocument> {
    if ((await this.#settings()) === undefined) {
      await this.#insertDocument(body);
    }
    await linkDailyRosterAccounts(this.#sql, this.#host);
    return this.#load();
  }

  async #insertDocument(body: unknown): Promise<void> {
    const parsed = parseImportBody(body);
    const addresses = [
      ...parsed.recipients.map((row) => row.address),
      ...parsed.moderators.map((row) => row.address),
    ];
    const amounts = [
      ...parsed.recipients.map((row) => row.amountUsd),
      ...parsed.moderators.map((row) => row.amountUsd),
    ];
    const buckets = [
      ...parsed.recipients.map(() => 'daily'),
      ...parsed.moderators.map(() => 'moderator'),
    ];
    try {
      await this.#sql.execute(
        `WITH inserted AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  VALUES (true, $1, $2, $3)
  RETURNING singleton
)
INSERT INTO daily_roster_entry (address, amount_usd, bucket)
SELECT addr, amt, bucket
FROM unnest($4::text[], $5::float8[], $6::text[]) AS imported(addr, amt, bucket)`,
        [
          parsed.comment,
          parsed.paymentsEnabled,
          parsed.moderatorPaymentsEnabled,
          postgresTextArrayLiteral(addresses),
          postgresTextArrayLiteral(amounts.map((amount) => String(amount))),
          postgresTextArrayLiteral(buckets),
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  async #add(
    bucket: DailyRosterBucket,
    accountId: string,
    amountUsd: number,
  ): Promise<DailyRosterDocument> {
    const row = listedRow(accountId, amountUsd);
    try {
      await this.#sql.execute(
        `WITH ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  VALUES (true, '', true, true)
  ON CONFLICT (singleton) DO NOTHING
)
INSERT INTO daily_roster_entry (account_id, amount_usd, bucket)
VALUES ($1, $2, $3)`,
        [row.accountId, row.amountUsd, bucket],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DailyRosterRequestError(400, DAILY_ROSTER_ADDRESS_LISTED);
      }
      throw error;
    }
    return this.#load();
  }

  async #update(
    bucket: DailyRosterBucket,
    accountId: string,
    amountUsd: number,
  ): Promise<DailyRosterDocument> {
    const row = listedRow(accountId, amountUsd);
    const updated = await this.#sql.query<{ id: number }>(
      `WITH updated AS (
  UPDATE daily_roster_entry SET amount_usd = $1
  WHERE account_id = $2 AND bucket = $3
  RETURNING id
), ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  SELECT true, '', true, true FROM updated
  ON CONFLICT (singleton) DO NOTHING
)
SELECT id FROM updated`,
      [row.amountUsd, row.accountId, bucket],
    );
    if (updated[0] === undefined) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    return this.#load();
  }

  async #delete(bucket: DailyRosterBucket, accountId: string): Promise<DailyRosterDocument> {
    const id = rosterAccountId(accountId);
    const deleted = await this.#sql.query<{ id: number }>(
      `WITH deleted AS (
  DELETE FROM daily_roster_entry
  WHERE account_id = $1 AND bucket = $2
  RETURNING id
), ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  SELECT true, '', true, true FROM deleted
  ON CONFLICT (singleton) DO NOTHING
)
SELECT id FROM deleted`,
      [id, bucket],
    );
    if (deleted[0] === undefined) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    return this.#load();
  }

  async #settings(): Promise<DailyRosterSettingsRow | undefined> {
    const rows = await this.#sql.query<DailyRosterSettingsRow>(
      `SELECT ${SETTINGS_SELECT} FROM daily_roster WHERE singleton = true`,
    );
    return rows[0];
  }

  async #entries(): Promise<DailyRosterEntryRow[]> {
    return this.#sql.query<DailyRosterEntryRow>(
      `SELECT ${ENTRY_SELECT} FROM daily_roster_entry ORDER BY id ASC`,
    );
  }

  async #load(): Promise<DailyRosterDocument> {
    const settings = await this.#settings();
    if (settings === undefined) {
      return emptyDocument();
    }
    const recipients: DailyRosterEntry[] = [];
    const moderators: DailyRosterEntry[] = [];
    for (const row of await this.#entries()) {
      if (row.account_id === null) {
        continue;
      }
      const entry = { accountId: row.account_id, amountUsd: Number(row.amount_usd) };
      if (row.bucket === 'moderator') {
        moderators.push(entry);
      } else {
        recipients.push(entry);
      }
    }
    return {
      comment: settings.comment,
      paymentsEnabled: settings.payments_enabled,
      moderatorPaymentsEnabled: settings.moderator_payments_enabled,
      defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
      recipients,
      moderators,
    };
  }
}

/** Empty never-written document. */
function emptyDocument(): DailyRosterDocument {
  return {
    comment: '',
    paymentsEnabled: true,
    moderatorPaymentsEnabled: true,
    defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
    recipients: [],
    moderators: [],
  };
}

/** Stored form of a listed entry. */
function storedRow(row: DailyRosterEntry): StoredRosterRow {
  return { accountId: row.accountId, address: null, amountUsd: row.amountUsd };
}

/** One address row of an import body. */
interface ImportedRosterRow {
  address: string;
  amountUsd: number;
}

/** Stored form of an imported address row: no account. */
function importedRow(row: ImportedRosterRow): StoredRosterRow {
  return { accountId: null, address: row.address, amountUsd: row.amountUsd };
}

/** Caller-owned copies of the rows linked to an account, in stored order. */
function listedEntries(rows: readonly StoredRosterRow[]): DailyRosterEntry[] {
  const entries: DailyRosterEntry[] = [];
  for (const row of rows) {
    if (row.accountId !== null) {
      entries.push({ accountId: row.accountId, amountUsd: row.amountUsd });
    }
  }
  return entries;
}

/**
 * Count and sum stored rows for {@link DailyRosterStore.linkReport}.
 *
 * @param rows - Every stored row in stored order, with its bucket.
 * @returns The report.
 */
function buildLinkReport(
  rows: readonly (StoredRosterRow & { bucket: DailyRosterBucket })[],
): DailyRosterLinkReport {
  const buckets: Record<DailyRosterBucket, DailyRosterBucketSums> = {
    daily: { rows: 0, linked: 0, totalUsd: 0, linkedUsd: 0 },
    moderator: { rows: 0, linked: 0, totalUsd: 0, linkedUsd: 0 },
  };
  const unlinked: DailyRosterUnlinkedRow[] = [];
  for (const row of rows) {
    const sums = buckets[row.bucket];
    sums.rows += 1;
    sums.totalUsd += row.amountUsd;
    if (row.accountId === null) {
      unlinked.push({ bucket: row.bucket, address: row.address, amountUsd: row.amountUsd });
    } else {
      sums.linked += 1;
      sums.linkedUsd += row.amountUsd;
    }
  }
  return { rows: rows.length, linked: rows.length - unlinked.length, unlinked, buckets };
}

/**
 * Trim, matching the stored account id.
 *
 * @param accountId - Raw account id.
 * @returns The stored form.
 * @throws {@link DailyRosterRequestError} 400 when empty after trim.
 */
function rosterAccountId(accountId: string): string {
  const trimmed = typeof accountId === 'string' ? accountId.trim() : '';
  if (trimmed === '') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
  }
  return trimmed;
}

/**
 * Trim then lower-case an imported address.
 *
 * @param address - Raw address.
 * @returns The stored form.
 * @throws {@link DailyRosterRequestError} 400 when empty after trim.
 */
function rosterAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (normalized === '') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
  }
  return normalized;
}

/**
 * Require a finite USD amount greater than zero.
 *
 * @param amountUsd - Candidate amount.
 * @returns The amount.
 * @throws {@link DailyRosterRequestError} 400.
 */
function rosterAmount(amountUsd: number): number {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
  }
  return amountUsd;
}

/**
 * Normalize account id and amount for a listed row.
 *
 * @param accountId - Raw account id.
 * @param amountUsd - USD amount.
 * @returns The stored row.
 */
function listedRow(accountId: string, amountUsd: number): DailyRosterEntry {
  return { accountId: rosterAccountId(accountId), amountUsd: rosterAmount(amountUsd) };
}

/**
 * Fold a comment or throw `'Invalid comment'`.
 *
 * @param comment - Raw comment.
 * @returns The folded comment.
 */
function foldedComment(comment: string): string {
  if (typeof comment !== 'string') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
  }
  const folded = normalizeDailyRosterComment(comment);
  if (folded === undefined) {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
  }
  return folded;
}

/**
 * Require a boolean payments switch.
 *
 * @param enabled - Candidate switch.
 */
function requireSwitch(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_PAYMENTS);
  }
}

/**
 * Parse an import body. Missing switches are `true`. `defaultAmountUsd` is ignored.
 *
 * @param body - Parsed JSON.
 * @returns The document to store (without `defaultAmountUsd`).
 */
function parseImportBody(body: unknown): {
  comment: string;
  paymentsEnabled: boolean;
  moderatorPaymentsEnabled: boolean;
  recipients: ImportedRosterRow[];
  moderators: ImportedRosterRow[];
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
  }
  const record = body as Record<string, unknown>;
  const comment = optionalImportComment(record['comment']);
  const paymentsEnabled = optionalImportSwitch(record['paymentsEnabled']);
  const moderatorPaymentsEnabled = optionalImportSwitch(record['moderatorPaymentsEnabled']);
  const recipients = optionalImportList(record['recipients']);
  const moderators = optionalImportList(record['moderators']);
  return {
    comment,
    paymentsEnabled,
    moderatorPaymentsEnabled,
    recipients,
    moderators,
  };
}

/**
 * Missing comment is `''`. A present non-string is `'Invalid comment'`.
 *
 * @param value - Body field.
 * @returns The folded comment.
 */
function optionalImportComment(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
  }
  return foldedComment(value);
}

/**
 * Missing switch is `true`. A present non-boolean is `'Invalid payments switch'`.
 *
 * @param value - Body field.
 * @returns The switch.
 */
function optionalImportSwitch(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'boolean') {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_PAYMENTS);
  }
  return value;
}

/**
 * Missing list is `[]`. A present non-array or bad row is `'Invalid address or amount'`.
 *
 * @param value - Body field.
 * @returns Normalized rows in body order.
 */
function optionalImportList(value: unknown): ImportedRosterRow[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
  }
  const rows: ImportedRosterRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
    }
    const record = item as Record<string, unknown>;
    if (typeof record['address'] !== 'string') {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
    }
    const amountUsd = record['amountUsd'];
    if (typeof amountUsd !== 'number') {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
    }
    const row = { address: rosterAddress(record['address']), amountUsd: rosterAmount(amountUsd) };
    if (seen.has(row.address)) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_ADDRESS_LISTED);
    }
    seen.add(row.address);
    rows.push(row);
  }
  return rows;
}
