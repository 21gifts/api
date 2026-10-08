/**
 * Persistence for the daily payout roster (amounts, both payment switches,
 * comment, daily recipients, and moderators).
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

/** Listed-row bucket. The same address may exist in both. */
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
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  addRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Replace the USD amount for a daily recipient already on the roster.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  updateRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Remove a daily recipient.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Unknown address'`.
   */
  deleteRecipient(address: string): Promise<DailyRosterDocument>;

  /**
   * Add a moderator stipend row.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  addModerator(address: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Replace the USD amount for a moderator already on the roster.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400.
   */
  updateModerator(address: string, amountUsd: number): Promise<DailyRosterDocument>;

  /**
   * Remove a moderator stipend row.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   * @throws {@link DailyRosterRequestError} 400 `'Unknown address'`.
   */
  deleteModerator(address: string): Promise<DailyRosterDocument>;

  /**
   * Write the full document only when it has never been written. A second
   * call returns the stored document unchanged, including an invalid body.
   * `defaultAmountUsd` in the body is ignored. A missing switch is `true`.
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
];

/**
 * Apply {@link DAILY_ROSTER_SCHEMA_SQL} in order. Idempotent.
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
 * Process-local {@link DailyRosterStore}. Used in tests and when no database
 * URL is configured — the process still boots.
 */
export class InMemoryDailyRosterStore implements DailyRosterStore {
  #written = false;
  #comment = '';
  #paymentsEnabled = true;
  #moderatorPaymentsEnabled = true;
  readonly #recipients: DailyRosterEntry[] = [];
  readonly #moderators: DailyRosterEntry[] = [];

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
    this.#recipients.push(...seed.recipients.map(copyEntry));
    this.#moderators.push(...seed.moderators.map(copyEntry));
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
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async addRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('daily', address, amountUsd);
  }

  /**
   * Replace a daily recipient amount.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async updateRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('daily', address, amountUsd);
  }

  /**
   * Remove a daily recipient.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   */
  async deleteRecipient(address: string): Promise<DailyRosterDocument> {
    return this.#delete('daily', address);
  }

  /**
   * Append a moderator stipend row.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async addModerator(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('moderator', address, amountUsd);
  }

  /**
   * Replace a moderator stipend amount.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  async updateModerator(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('moderator', address, amountUsd);
  }

  /**
   * Remove a moderator stipend row.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   */
  async deleteModerator(address: string): Promise<DailyRosterDocument> {
    return this.#delete('moderator', address);
  }

  /**
   * First write of the full document, or a no-op when already written.
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
    this.#recipients.splice(0, this.#recipients.length, ...parsed.recipients);
    this.#moderators.splice(0, this.#moderators.length, ...parsed.moderators);
    this.#written = true;
    return Promise.resolve(this.#snapshot());
  }

  #list(bucket: DailyRosterBucket): DailyRosterEntry[] {
    return bucket === 'daily' ? this.#recipients : this.#moderators;
  }

  #add(bucket: DailyRosterBucket, address: string, amountUsd: number): DailyRosterDocument {
    const row = listedRow(address, amountUsd);
    const list = this.#list(bucket);
    if (list.some((item) => item.address === row.address)) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_ADDRESS_LISTED);
    }
    this.#written = true;
    list.push(row);
    return this.#snapshot();
  }

  #update(bucket: DailyRosterBucket, address: string, amountUsd: number): DailyRosterDocument {
    const row = listedRow(address, amountUsd);
    const list = this.#list(bucket);
    const index = list.findIndex((item) => item.address === row.address);
    if (index < 0) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    this.#written = true;
    list[index] = row;
    return this.#snapshot();
  }

  #delete(bucket: DailyRosterBucket, address: string): DailyRosterDocument {
    const normalized = rosterAddress(address);
    const list = this.#list(bucket);
    const index = list.findIndex((item) => item.address === normalized);
    if (index < 0) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    this.#written = true;
    list.splice(index, 1);
    return this.#snapshot();
  }

  #snapshot(): DailyRosterDocument {
    return copyDocument({
      comment: this.#comment,
      paymentsEnabled: this.#paymentsEnabled,
      moderatorPaymentsEnabled: this.#moderatorPaymentsEnabled,
      defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
      recipients: this.#recipients,
      moderators: this.#moderators,
    });
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
  address: string;
  amount_usd: number | string;
  bucket: DailyRosterBucket;
}

const SETTINGS_SELECT = 'comment, payments_enabled, moderator_payments_enabled';
const ENTRY_SELECT = 'address, amount_usd, bucket';

/**
 * Durable {@link DailyRosterStore} backed by Postgres.
 */
export class PostgresDailyRosterStore implements DailyRosterStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Settings plus entries ordered by `id`. No settings row is the empty document.
   *
   * @returns A caller-owned copy.
   */
  async get(): Promise<DailyRosterDocument> {
    return this.#load();
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
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  addRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('daily', address, amountUsd);
  }

  /**
   * Replace a daily recipient amount.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  updateRecipient(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('daily', address, amountUsd);
  }

  /**
   * Remove a daily recipient.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   */
  deleteRecipient(address: string): Promise<DailyRosterDocument> {
    return this.#delete('daily', address);
  }

  /**
   * Append a moderator stipend row.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  addModerator(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#add('moderator', address, amountUsd);
  }

  /**
   * Replace a moderator stipend amount.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The document after the change.
   */
  updateModerator(address: string, amountUsd: number): Promise<DailyRosterDocument> {
    return this.#update('moderator', address, amountUsd);
  }

  /**
   * Remove a moderator stipend row.
   *
   * @param address - Lightning address.
   * @returns The document after the change.
   */
  deleteModerator(address: string): Promise<DailyRosterDocument> {
    return this.#delete('moderator', address);
  }

  /**
   * First write of the full document, or a no-op when a settings row exists.
   *
   * @param body - Parsed JSON.
   * @returns The stored document.
   */
  async importDocument(body: unknown): Promise<DailyRosterDocument> {
    const settings = await this.#settings();
    if (settings !== undefined) {
      return this.#load();
    }
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
      if (isUniqueViolation(error)) {
        return this.#load();
      }
      throw error;
    }
    return this.#load();
  }

  async #add(
    bucket: DailyRosterBucket,
    address: string,
    amountUsd: number,
  ): Promise<DailyRosterDocument> {
    const row = listedRow(address, amountUsd);
    try {
      await this.#sql.execute(
        `WITH ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  VALUES (true, '', true, true)
  ON CONFLICT (singleton) DO NOTHING
)
INSERT INTO daily_roster_entry (address, amount_usd, bucket)
VALUES ($1, $2, $3)`,
        [row.address, row.amountUsd, bucket],
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
    address: string,
    amountUsd: number,
  ): Promise<DailyRosterDocument> {
    const row = listedRow(address, amountUsd);
    const updated = await this.#sql.query<{ address: string }>(
      `WITH updated AS (
  UPDATE daily_roster_entry SET amount_usd = $1
  WHERE address = $2 AND bucket = $3
  RETURNING address
), ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  SELECT true, '', true, true FROM updated
  ON CONFLICT (singleton) DO NOTHING
)
SELECT address FROM updated`,
      [row.amountUsd, row.address, bucket],
    );
    if (updated[0] === undefined) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
    }
    return this.#load();
  }

  async #delete(bucket: DailyRosterBucket, address: string): Promise<DailyRosterDocument> {
    const normalized = rosterAddress(address);
    const deleted = await this.#sql.query<{ address: string }>(
      `WITH deleted AS (
  DELETE FROM daily_roster_entry
  WHERE address = $1 AND bucket = $2
  RETURNING address
), ensured AS (
  INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
  SELECT true, '', true, true FROM deleted
  ON CONFLICT (singleton) DO NOTHING
)
SELECT address FROM deleted`,
      [normalized, bucket],
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
      const entry = { address: row.address, amountUsd: Number(row.amount_usd) };
      if (row.bucket === 'moderator') {
        moderators.push(entry);
      } else {
        recipients.push(entry);
      }
    }
    return copyDocument({
      comment: settings.comment,
      paymentsEnabled: settings.payments_enabled,
      moderatorPaymentsEnabled: settings.moderator_payments_enabled,
      defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
      recipients,
      moderators,
    });
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

/** Caller-owned copy. `defaultAmountUsd` is always the constant. */
function copyDocument(doc: DailyRosterDocument): DailyRosterDocument {
  return {
    comment: doc.comment,
    paymentsEnabled: doc.paymentsEnabled,
    moderatorPaymentsEnabled: doc.moderatorPaymentsEnabled,
    defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
    recipients: doc.recipients.map(copyEntry),
    moderators: doc.moderators.map(copyEntry),
  };
}

/** Caller-owned row copy. */
function copyEntry(row: DailyRosterEntry): DailyRosterEntry {
  return { address: row.address, amountUsd: row.amountUsd };
}

/**
 * Trim then lower-case, matching the roster address comparison.
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
 * Normalize address and amount for a listed row.
 *
 * @param address - Raw address.
 * @param amountUsd - USD amount.
 * @returns The stored row.
 */
function listedRow(address: string, amountUsd: number): DailyRosterEntry {
  return { address: rosterAddress(address), amountUsd: rosterAmount(amountUsd) };
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
  recipients: DailyRosterEntry[];
  moderators: DailyRosterEntry[];
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
function optionalImportList(value: unknown): DailyRosterEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
  }
  const rows: DailyRosterEntry[] = [];
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
    const row = listedRow(record['address'], amountUsd);
    if (seen.has(row.address)) {
      throw new DailyRosterRequestError(400, DAILY_ROSTER_ADDRESS_LISTED);
    }
    seen.add(row.address);
    rows.push(row);
  }
  return rows;
}
