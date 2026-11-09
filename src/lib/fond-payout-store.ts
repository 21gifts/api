/**
 * Persistence for `fond_payout`: the decided payout instructions a `fond`
 * member pays from its own in-app wallet when `PAYOUT_SIGNER=fond`.
 *
 * A row is written by the ping path with the already-decided amount and
 * comment. The member-session `/fond` routes then request the invoice and
 * post the proof. Column layout matches `docs/schema/fond_payout.sql`.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** Payout kinds the API decides. Matches the `kind` CHECK constraint. */
export type FondPayoutKind = 'daily' | 'moderator' | 'welcome';

/** Row lifecycle. Matches the `status` CHECK constraint. */
export type FondPayoutStatus = 'owed' | 'invoiced' | 'paid' | 'failed';

/** One queued payout. Never logged with its address. */
export interface FondPayoutRow {
  /** Opaque unique id. */
  id: string;
  /** UTC day the payout is booked on (`YYYY-MM-DD`). */
  utcDay: string;
  /** Payout kind. */
  kind: FondPayoutKind;
  /** Recipient Lightning Address as decided. */
  address: string;
  /** Decided USD amount string, e.g. `1.00`. */
  amountUsd: string;
  /** Decided comment. */
  comment: string;
  /** Daily/welcome trigger post id, or `null`. */
  messageId: string | null;
  /** Moderator trigger message id, or `null`. */
  groupMessageId: string | null;
  /** Lifecycle status. */
  status: FondPayoutStatus;
  /** Short failure reason when `failed`, else `null`. */
  failure: string | null;
  /** Invoice id returned by the issue logic, or `null`. */
  invoiceId: string | null;
  /** Invoice payment hash, or `null`. */
  paymentHash: string | null;
  /** Invoice BOLT11, or `null`. */
  bolt11: string | null;
  /** Enqueue time. */
  createdAt: Date;
  /** Last status or invoice change. */
  updatedAt: Date;
}

/** A decided instruction the queue sink writes. */
export interface FondPayoutEnqueue {
  /** New row id. */
  id: string;
  /** UTC day key (`YYYY-MM-DD`). */
  utcDay: string;
  /** Payout kind. */
  kind: FondPayoutKind;
  /** Recipient Lightning Address. */
  address: string;
  /** Decided USD amount string. */
  amountUsd: string;
  /** Decided comment. */
  comment: string;
  /** Daily/welcome trigger post id, or `null`. */
  messageId: string | null;
  /** Moderator trigger message id, or `null`. */
  groupMessageId: string | null;
}

/** Invoice fields stored when the issue logic returns an invoice. */
export interface FondPayoutInvoice {
  /** Invoice id returned by the issue logic. */
  invoiceId: string;
  /** Invoice payment hash. */
  paymentHash: string;
  /** Invoice BOLT11. */
  bolt11: string;
}

/**
 * Persistence port for `fond_payout`.
 *
 * `enqueue` follows spend's dedupe: at most one `daily`/`moderator` row per
 * `(utc_day, kind, address)` and one `welcome` row per `(kind, address)`.
 */
export interface FondPayoutStore {
  /**
   * Insert one decided payout unless a dedupe key already exists.
   *
   * @param row - Decided instruction.
   * @returns `'accepted'` for a new or already-queued row; `'paid'` when the
   *   existing row is already `paid`.
   */
  enqueue(row: FondPayoutEnqueue): Promise<'accepted' | 'paid'>;

  /**
   * Rows of `utcDay` with status `owed` or `invoiced`, oldest first.
   *
   * @param utcDay - UTC day key `YYYY-MM-DD`.
   * @returns Caller-owned copies.
   */
  listOpen(utcDay: string): Promise<FondPayoutRow[]>;

  /**
   * One row by id.
   *
   * @param id - Row id.
   * @returns A caller-owned copy, or `undefined`.
   */
  get(id: string): Promise<FondPayoutRow | undefined>;

  /**
   * Store the issued invoice and move an `owed`/`invoiced` row to `invoiced`.
   * A row of any other status is left unchanged.
   *
   * @param id - Row id.
   * @param invoice - Invoice fields from the issue logic.
   * @returns The updated row, or `undefined` when the row is missing or not payable.
   */
  setInvoiced(id: string, invoice: FondPayoutInvoice): Promise<FondPayoutRow | undefined>;

  /**
   * Move an `owed`/`invoiced` row to `failed` with a short reason.
   *
   * @param id - Row id.
   * @param failure - Client-facing issue error text.
   * @returns The updated row, or `undefined` when the row is missing or not payable.
   */
  setFailed(id: string, failure: string): Promise<FondPayoutRow | undefined>;

  /**
   * Move an `invoiced` row to `paid`.
   *
   * @param id - Row id.
   * @returns The updated row, or `undefined` when the row is missing or not invoiced.
   */
  setPaid(id: string): Promise<FondPayoutRow | undefined>;
}

/** Idempotent DDL (matches `docs/schema/fond_payout.sql`). */
export const FOND_PAYOUT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fond_payout (
  id uuid PRIMARY KEY,
  utc_day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('daily', 'moderator', 'welcome')),
  address text NOT NULL,
  amount_usd text NOT NULL,
  comment text NOT NULL,
  message_id text,
  group_message_id text,
  status text NOT NULL CHECK (status IN ('owed', 'invoiced', 'paid', 'failed')),
  failure text,
  invoice_id text,
  payment_hash text,
  bolt11 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_daily_moderator_uidx
    ON fond_payout (utc_day, kind, address)
    WHERE kind IN ('daily', 'moderator')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_welcome_uidx
    ON fond_payout (kind, address)
    WHERE kind = 'welcome'`,
];

/**
 * Apply {@link FOND_PAYOUT_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateFondPayoutSchema(sql: SqlClient): Promise<void> {
  for (const statement of FOND_PAYOUT_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Dedupe key shared by the InMemory adapter and the conflict lookup. */
function dedupeKey(row: Pick<FondPayoutRow, 'utcDay' | 'kind' | 'address'>): string {
  return row.kind === 'welcome'
    ? `welcome\u0000${row.address}`
    : `${row.utcDay}\u0000${row.kind}\u0000${row.address}`;
}

/** Caller-owned copy of a row. */
function copyRow(row: FondPayoutRow): FondPayoutRow {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

/** Process-local {@link FondPayoutStore}; starts empty. */
export class InMemoryFondPayoutStore implements FondPayoutStore {
  readonly #rows = new Map<string, FondPayoutRow>();
  readonly #now: () => number;

  /**
   * @param now - Clock for `createdAt`/`updatedAt` (default `Date.now`).
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Insert unless a dedupe key already exists.
   *
   * @param row - Decided instruction.
   * @returns `'accepted'` for a new or already-queued row; `'paid'` when the existing row is paid.
   */
  async enqueue(row: FondPayoutEnqueue): Promise<'accepted' | 'paid'> {
    const key = dedupeKey({ utcDay: row.utcDay, kind: row.kind, address: row.address });
    const existing = [...this.#rows.values()].find(
      (item) => dedupeKey({ utcDay: item.utcDay, kind: item.kind, address: item.address }) === key,
    );
    if (existing !== undefined) {
      return existing.status === 'paid' ? 'paid' : 'accepted';
    }
    const at = new Date(this.#now());
    this.#rows.set(row.id, {
      ...row,
      status: 'owed',
      failure: null,
      invoiceId: null,
      paymentHash: null,
      bolt11: null,
      createdAt: at,
      updatedAt: at,
    });
    return 'accepted';
  }

  /**
   * Rows of `utcDay` with status `owed` or `invoiced`, oldest first.
   *
   * @param utcDay - UTC day key.
   * @returns Copies, oldest first.
   */
  async listOpen(utcDay: string): Promise<FondPayoutRow[]> {
    return [...this.#rows.values()]
      .filter(
        (row) => row.utcDay === utcDay && (row.status === 'owed' || row.status === 'invoiced'),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map(copyRow);
  }

  /**
   * One row by id.
   *
   * @param id - Row id.
   * @returns A copy, or `undefined`.
   */
  async get(id: string): Promise<FondPayoutRow | undefined> {
    const row = this.#rows.get(id);
    return row === undefined ? undefined : copyRow(row);
  }

  /**
   * Store the invoice and move a payable row to `invoiced`.
   *
   * @param id - Row id.
   * @param invoice - Invoice fields.
   * @returns The updated copy, or `undefined` when not payable.
   */
  async setInvoiced(id: string, invoice: FondPayoutInvoice): Promise<FondPayoutRow | undefined> {
    return this.#transition(id, ['owed', 'invoiced'], (row) => ({
      ...row,
      status: 'invoiced',
      failure: null,
      invoiceId: invoice.invoiceId,
      paymentHash: invoice.paymentHash,
      bolt11: invoice.bolt11,
    }));
  }

  /**
   * Move a payable row to `failed`.
   *
   * @param id - Row id.
   * @param failure - Short reason.
   * @returns The updated copy, or `undefined` when not payable.
   */
  async setFailed(id: string, failure: string): Promise<FondPayoutRow | undefined> {
    return this.#transition(id, ['owed', 'invoiced'], (row) => ({
      ...row,
      status: 'failed',
      failure,
    }));
  }

  /**
   * Move an `invoiced` row to `paid`.
   *
   * @param id - Row id.
   * @returns The updated copy, or `undefined` when not invoiced.
   */
  async setPaid(id: string): Promise<FondPayoutRow | undefined> {
    return this.#transition(id, ['invoiced'], (row) => ({
      ...row,
      status: 'paid',
      failure: null,
    }));
  }

  #transition(
    id: string,
    from: readonly FondPayoutStatus[],
    change: (row: FondPayoutRow) => FondPayoutRow,
  ): FondPayoutRow | undefined {
    const current = this.#rows.get(id);
    if (current === undefined || !from.includes(current.status)) {
      return undefined;
    }
    const next = { ...change(current), updatedAt: new Date(this.#now()) };
    this.#rows.set(id, next);
    return copyRow(next);
  }
}

/** One driver row of `fond_payout`. */
interface FondPayoutSqlRow {
  id: string;
  utc_day: string | Date;
  kind: FondPayoutKind;
  address: string;
  amount_usd: string;
  comment: string;
  message_id: string | null;
  group_message_id: string | null;
  status: FondPayoutStatus;
  failure: string | null;
  invoice_id: string | null;
  payment_hash: string | null;
  bolt11: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const FOND_PAYOUT_SELECT = `id, utc_day, kind, address, amount_usd, comment, message_id,
  group_message_id, status, failure, invoice_id, payment_hash, bolt11, created_at, updated_at`;

/** Date-only text for a driver `date` value. */
function isoDay(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

/** Timestamp for a driver value. */
function timestamp(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Map one driver row. */
function mapRow(row: FondPayoutSqlRow): FondPayoutRow {
  return {
    id: row.id,
    utcDay: isoDay(row.utc_day),
    kind: row.kind,
    address: row.address,
    amountUsd: row.amount_usd,
    comment: row.comment,
    messageId: row.message_id,
    groupMessageId: row.group_message_id,
    status: row.status,
    failure: row.failure,
    invoiceId: row.invoice_id,
    paymentHash: row.payment_hash,
    bolt11: row.bolt11,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

/** {@link FondPayoutStore} against the `fond_payout` table. */
export class PostgresFondPayoutStore implements FondPayoutStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert with `ON CONFLICT DO NOTHING`. On a conflict, read the existing
   * row's status: `paid` returns `'paid'`, every other status `'accepted'`.
   *
   * @param row - Decided instruction.
   * @returns `'accepted'` or `'paid'`.
   * @throws Propagates SQL failures.
   */
  async enqueue(row: FondPayoutEnqueue): Promise<'accepted' | 'paid'> {
    const inserted = await this.#sql.query<{ id: string }>(
      `INSERT INTO fond_payout
  (id, utc_day, kind, address, amount_usd, comment, message_id, group_message_id, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'owed')
ON CONFLICT DO NOTHING
RETURNING id`,
      [
        row.id,
        row.utcDay,
        row.kind,
        row.address,
        row.amountUsd,
        row.comment,
        row.messageId,
        row.groupMessageId,
      ],
    );
    if (inserted.length > 0) {
      return 'accepted';
    }
    const existing =
      row.kind === 'welcome'
        ? await this.#sql.query<{ status: FondPayoutStatus }>(
            `SELECT status FROM fond_payout WHERE kind = 'welcome' AND address = $1`,
            [row.address],
          )
        : await this.#sql.query<{ status: FondPayoutStatus }>(
            `SELECT status FROM fond_payout WHERE utc_day = $1 AND kind = $2 AND address = $3`,
            [row.utcDay, row.kind, row.address],
          );
    return existing[0]?.status === 'paid' ? 'paid' : 'accepted';
  }

  /**
   * Rows of `utcDay` with status `owed` or `invoiced`, oldest first.
   *
   * @param utcDay - UTC day key.
   * @returns The matching rows.
   * @throws Propagates SQL failures.
   */
  async listOpen(utcDay: string): Promise<FondPayoutRow[]> {
    const rows = await this.#sql.query<FondPayoutSqlRow>(
      `SELECT ${FOND_PAYOUT_SELECT}
FROM fond_payout
WHERE utc_day = $1 AND status IN ('owed', 'invoiced')
ORDER BY created_at ASC, id ASC`,
      [utcDay],
    );
    return rows.map(mapRow);
  }

  /**
   * One row by id.
   *
   * @param id - Row id.
   * @returns The row, or `undefined`.
   * @throws Propagates SQL failures.
   */
  async get(id: string): Promise<FondPayoutRow | undefined> {
    const rows = await this.#sql.query<FondPayoutSqlRow>(
      `SELECT ${FOND_PAYOUT_SELECT} FROM fond_payout WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Store the invoice and move an `owed`/`invoiced` row to `invoiced`.
   *
   * @param id - Row id.
   * @param invoice - Invoice fields.
   * @returns The updated row, or `undefined` when not payable.
   * @throws Propagates SQL failures.
   */
  async setInvoiced(id: string, invoice: FondPayoutInvoice): Promise<FondPayoutRow | undefined> {
    const rows = await this.#sql.query<FondPayoutSqlRow>(
      `UPDATE fond_payout
SET status = 'invoiced', failure = NULL,
    invoice_id = $2, payment_hash = $3, bolt11 = $4, updated_at = now()
WHERE id = $1 AND status IN ('owed', 'invoiced')
RETURNING ${FOND_PAYOUT_SELECT}`,
      [id, invoice.invoiceId, invoice.paymentHash, invoice.bolt11],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Move an `owed`/`invoiced` row to `failed`.
   *
   * @param id - Row id.
   * @param failure - Short reason.
   * @returns The updated row, or `undefined` when not payable.
   * @throws Propagates SQL failures.
   */
  async setFailed(id: string, failure: string): Promise<FondPayoutRow | undefined> {
    const rows = await this.#sql.query<FondPayoutSqlRow>(
      `UPDATE fond_payout
SET status = 'failed', failure = $2, updated_at = now()
WHERE id = $1 AND status IN ('owed', 'invoiced')
RETURNING ${FOND_PAYOUT_SELECT}`,
      [id, failure],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Move an `invoiced` row to `paid`.
   *
   * @param id - Row id.
   * @returns The updated row, or `undefined` when not invoiced.
   * @throws Propagates SQL failures.
   */
  async setPaid(id: string): Promise<FondPayoutRow | undefined> {
    const rows = await this.#sql.query<FondPayoutSqlRow>(
      `UPDATE fond_payout
SET status = 'paid', failure = NULL, updated_at = now()
WHERE id = $1 AND status = 'invoiced'
RETURNING ${FOND_PAYOUT_SELECT}`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapRow(row);
  }
}
