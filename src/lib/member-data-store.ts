/**
 * Read side of a member's reported wallet data and interaction events, plus
 * the team access audit log.
 *
 * `wallet_balance_snapshot`, `wallet_payment`, and `member_event` are written
 * by the app reports (`POST /me/wallet/report`, `POST /me/events`). This
 * module only reads them; it carries the same idempotent DDL so the team
 * screens work on a database where the report routes have not created the
 * tables yet. `team_access_audit` is written here: one row for every team
 * read of a member's wallet data or events.
 *
 * None of these tables has a column for a recovery phrase, seed, PRF output,
 * preimage, or private key.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** Where a payment's counterparty sits, computed when the payment is stored. */
export type WalletPaymentCategory =
  'member' | 'shop' | 'platform' | 'gift' | 'outside_lightning' | 'onchain' | 'unknown';

/** Every {@link WalletPaymentCategory}, in display order. */
export const WALLET_PAYMENT_CATEGORIES: readonly WalletPaymentCategory[] = [
  'member',
  'shop',
  'platform',
  'gift',
  'outside_lightning',
  'onchain',
  'unknown',
];

/** Payment direction as the wallet reports it. */
export type WalletPaymentDirection = 'in' | 'out';

/** Payment status as the wallet reports it. */
export type WalletPaymentStatus = 'pending' | 'completed' | 'failed';

/** One stored balance report. */
export interface WalletBalanceSnapshotRow {
  /** Row id. */
  id: string;
  /** Reporting account. */
  accountId: string;
  /** Balance in sats at `syncedAt`. */
  balanceSats: number;
  /** When the wallet finished the sync the balance comes from. */
  syncedAt: Date;
  /** When the api stored the report. */
  receivedAt: Date;
}

/** One stored wallet payment. */
export interface WalletPaymentRow {
  /** Reporting account. */
  accountId: string;
  /** Wallet SDK payment id; unique per account. */
  paymentId: string;
  /** `in` or `out`. */
  direction: WalletPaymentDirection;
  /** `pending`, `completed`, or `failed`. */
  status: WalletPaymentStatus;
  /** Amount in sats. */
  amountSats: number;
  /** Fee in sats (0 when none). */
  feeSats: number;
  /** Payment time from the wallet SDK. */
  paidAt: Date;
  /** Payment method (`lightning`, `spark`, `onchain`, `token`, …). */
  method: string;
  /** Invoice payment hash, or null. */
  paymentHash: string | null;
  /** BOLT11 or Spark invoice string, or null. */
  invoice: string | null;
  /** Lightning address, LNURL domain, Spark address, on-chain address, or txid; or null. */
  destination: string | null;
  /** Invoice description or memo, or null. */
  description: string | null;
  /** LNURL comment, or null. */
  lnurlComment: string | null;
  /** Category computed when stored. */
  category: WalletPaymentCategory;
  /** Member on the other side when known, or null. */
  counterpartyAccountId: string | null;
  /** When the api first stored this payment. */
  firstSeenAt: Date;
  /** When the api last changed this payment. */
  updatedAt: Date;
}

/** A scalar value in a stored event's flat `props` object. */
export type MemberEventProp = string | number | boolean | null;

/** One stored interaction event. */
export interface MemberEventRow {
  /** Row id. */
  id: string;
  /** Account that sent the event. */
  accountId: string;
  /** Event name (`screen_view`, `post_created`, …). */
  name: string;
  /** When the event happened on the device. */
  at: Date;
  /** App path without query, or null. */
  path: string | null;
  /** Flat props object. */
  props: Record<string, MemberEventProp>;
  /** When the api stored the event. */
  receivedAt: Date;
}

/** What a team read showed. */
export type TeamAccessWhat = 'wallet' | 'events';

/** One audit row: a team member read a member's data. */
export interface TeamAccessRow {
  /** Row id. */
  id: string;
  /** Team member who read the data. */
  viewerAccountId: string;
  /** Member whose data was read. */
  memberAccountId: string;
  /** `wallet` or `events`. */
  what: TeamAccessWhat;
  /** When the read happened. */
  at: Date;
}

/** Keyset position: rows strictly older than `(at, id)` follow. */
export interface MemberDataCursor {
  /** Time of the last row on the previous page. */
  at: Date;
  /** Id of the last row on the previous page. */
  id: string;
}

/** Optional filters for {@link MemberDataStore.listPayments}. */
export interface WalletPaymentFilter {
  /** Only payments at or after this time; null for all. */
  since: Date | null;
  /** Only this category. */
  category?: WalletPaymentCategory;
  /** Only this direction. */
  direction?: WalletPaymentDirection;
}

/** Completed-payment totals for one category and direction. */
export interface WalletPaymentTotalRow {
  /** Category. */
  category: WalletPaymentCategory;
  /** Direction. */
  direction: WalletPaymentDirection;
  /** Number of completed payments. */
  count: number;
  /** Sum of `amountSats`. */
  amountSats: number;
  /** Sum of `feeSats`. */
  feeSats: number;
}

/** Persistence port for the team member-data screens. */
export interface MemberDataStore {
  /**
   * The newest balance report of an account (`receivedAt` desc, then `id` desc).
   *
   * @param accountId - Member account.
   * @returns The snapshot, or null when the member never reported one.
   */
  latestBalance(accountId: string): Promise<WalletBalanceSnapshotRow | null>;
  /**
   * Payments of an account, newest first (`paidAt` desc, then `paymentId` desc
   * in byte order).
   *
   * @param accountId - Member account.
   * @param filter - Period, category, and direction filters.
   * @param cursor - Keyset position, or null for the first page.
   * @param limit - Maximum rows.
   * @returns Payment rows (copies).
   */
  listPayments(
    accountId: string,
    filter: WalletPaymentFilter,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<WalletPaymentRow[]>;
  /**
   * Completed-payment totals of an account grouped by category and direction.
   *
   * @param accountId - Member account.
   * @param since - Only payments at or after this time; null for all.
   * @returns One row per category and direction that has a completed payment.
   */
  paymentTotals(accountId: string, since: Date | null): Promise<WalletPaymentTotalRow[]>;
  /**
   * Interaction events of an account, newest first (`at` desc, then `id` desc).
   *
   * @param accountId - Member account.
   * @param cursor - Keyset position, or null for the first page.
   * @param limit - Maximum rows.
   * @returns Event rows (copies).
   */
  listEvents(
    accountId: string,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<MemberEventRow[]>;
  /**
   * Append one audit row.
   *
   * @param row - Fully formed audit row.
   * @returns Resolves once stored.
   */
  appendAccess(row: TeamAccessRow): Promise<void>;
  /**
   * Audit rows, newest first (`at` desc, then `id` desc).
   *
   * @param cursor - Keyset position, or null for the first page.
   * @param limit - Maximum rows.
   * @returns Audit rows (copies).
   */
  listAccess(cursor: MemberDataCursor | null, limit: number): Promise<TeamAccessRow[]>;
}

/**
 * Idempotent DDL for the reported wallet data, the interaction events, and
 * the team access audit log (matches `docs/schema/member_data.sql`).
 */
export const MEMBER_DATA_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS wallet_balance_snapshot (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  balance_sats bigint NOT NULL CHECK (balance_sats >= 0),
  synced_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS wallet_balance_snapshot_account_received_idx ON wallet_balance_snapshot (account_id, received_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS wallet_payment (
  account_id uuid NOT NULL REFERENCES account (id),
  payment_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  amount_sats bigint NOT NULL CHECK (amount_sats >= 0),
  fee_sats bigint NOT NULL CHECK (fee_sats >= 0),
  paid_at timestamptz NOT NULL,
  method text NOT NULL,
  payment_hash text,
  invoice text,
  destination text,
  description text,
  lnurl_comment text,
  category text NOT NULL CHECK (category IN ('member', 'shop', 'platform', 'gift', 'outside_lightning', 'onchain', 'unknown')),
  counterparty_account_id uuid REFERENCES account (id),
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, payment_id)
)`,
  `ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS invoice text`,
  `CREATE INDEX IF NOT EXISTS wallet_payment_account_paid_idx ON wallet_payment (account_id, paid_at DESC, payment_id DESC)`,
  `CREATE TABLE IF NOT EXISTS member_event (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  at timestamptz NOT NULL,
  path text,
  props jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS member_event_account_at_idx ON member_event (account_id, at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS team_access_audit (
  id uuid PRIMARY KEY,
  viewer_account_id uuid NOT NULL REFERENCES account (id),
  member_account_id uuid NOT NULL REFERENCES account (id),
  what text NOT NULL CHECK (what IN ('wallet', 'events')),
  at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS team_access_audit_at_idx ON team_access_audit (at DESC, id DESC)`,
];

/**
 * Apply {@link MEMBER_DATA_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateMemberDataSchema(sql: SqlClient): Promise<void> {
  for (const statement of MEMBER_DATA_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Whether `(at, id)` sorts strictly before the cursor in a newest-first list. */
function olderThan(at: Date, id: string, cursor: MemberDataCursor | null): boolean {
  if (cursor === null) {
    return true;
  }
  const delta = at.getTime() - cursor.at.getTime();
  return delta < 0 || (delta === 0 && id < cursor.id);
}

/** Newest-first comparator on `(time, id)`; ids compare in byte order. */
function newestFirst(aAt: Date, aId: string, bAt: Date, bId: string): number {
  const delta = bAt.getTime() - aAt.getTime();
  if (delta !== 0) {
    return delta;
  }
  if (aId === bId) {
    return 0;
  }
  return aId < bId ? 1 : -1;
}

/** Copy a payment row. */
function copyPayment(row: WalletPaymentRow): WalletPaymentRow {
  return {
    ...row,
    paidAt: new Date(row.paidAt.getTime()),
    firstSeenAt: new Date(row.firstSeenAt.getTime()),
    updatedAt: new Date(row.updatedAt.getTime()),
  };
}

/** Seed rows for {@link InMemoryMemberDataStore}. */
export interface MemberDataSeed {
  /** Balance reports. */
  balances?: readonly WalletBalanceSnapshotRow[];
  /** Payments. */
  payments?: readonly WalletPaymentRow[];
  /** Interaction events. */
  events?: readonly MemberEventRow[];
}

/**
 * Process-local {@link MemberDataStore}. Used in tests and when no database
 * URL is configured — the process still boots with no member data.
 */
export class InMemoryMemberDataStore implements MemberDataStore {
  readonly #balances: WalletBalanceSnapshotRow[];
  readonly #payments: WalletPaymentRow[];
  readonly #events: MemberEventRow[];
  readonly #access: TeamAccessRow[] = [];

  /**
   * @param seed - Optional balance, payment, and event rows; copied.
   */
  constructor(seed: MemberDataSeed = {}) {
    this.#balances = (seed.balances ?? []).map((row) => ({
      ...row,
      syncedAt: new Date(row.syncedAt.getTime()),
      receivedAt: new Date(row.receivedAt.getTime()),
    }));
    this.#payments = (seed.payments ?? []).map((row) => copyPayment(row));
    this.#events = (seed.events ?? []).map((row) => ({
      ...row,
      at: new Date(row.at.getTime()),
      props: { ...row.props },
      receivedAt: new Date(row.receivedAt.getTime()),
    }));
  }

  /**
   * Newest balance report of `accountId`.
   *
   * @param accountId - Member account.
   * @returns A copy, or null.
   */
  latestBalance(accountId: string): Promise<WalletBalanceSnapshotRow | null> {
    const newest = this.#balances
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => newestFirst(a.receivedAt, a.id, b.receivedAt, b.id))[0];
    return Promise.resolve(
      newest === undefined
        ? null
        : {
            ...newest,
            syncedAt: new Date(newest.syncedAt.getTime()),
            receivedAt: new Date(newest.receivedAt.getTime()),
          },
    );
  }

  /**
   * Filtered newest-first payments of `accountId`.
   *
   * @param accountId - Member account.
   * @param filter - Period, category, and direction filters.
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Copies.
   */
  listPayments(
    accountId: string,
    filter: WalletPaymentFilter,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<WalletPaymentRow[]> {
    const since = filter.since;
    const rows = this.#payments
      .filter(
        (row) =>
          row.accountId === accountId &&
          (since === null || row.paidAt.getTime() >= since.getTime()) &&
          (filter.category === undefined || row.category === filter.category) &&
          (filter.direction === undefined || row.direction === filter.direction) &&
          olderThan(row.paidAt, row.paymentId, cursor),
      )
      .sort((a, b) => newestFirst(a.paidAt, a.paymentId, b.paidAt, b.paymentId))
      .slice(0, limit)
      .map((row) => copyPayment(row));
    return Promise.resolve(rows);
  }

  /**
   * Completed-payment totals of `accountId` by category and direction.
   *
   * @param accountId - Member account.
   * @param since - Lower bound, or null.
   * @returns Total rows in category order, `in` before `out`.
   */
  paymentTotals(accountId: string, since: Date | null): Promise<WalletPaymentTotalRow[]> {
    const totals = new Map<string, WalletPaymentTotalRow>();
    for (const row of this.#payments) {
      if (
        row.accountId !== accountId ||
        row.status !== 'completed' ||
        (since !== null && row.paidAt.getTime() < since.getTime())
      ) {
        continue;
      }
      const key = `${row.category}:${row.direction}`;
      const total = totals.get(key) ?? {
        category: row.category,
        direction: row.direction,
        count: 0,
        amountSats: 0,
        feeSats: 0,
      };
      total.count += 1;
      total.amountSats += row.amountSats;
      total.feeSats += row.feeSats;
      totals.set(key, total);
    }
    return Promise.resolve([...totals.values()]);
  }

  /**
   * Newest-first events of `accountId`.
   *
   * @param accountId - Member account.
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Copies.
   */
  listEvents(
    accountId: string,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<MemberEventRow[]> {
    const rows = this.#events
      .filter((row) => row.accountId === accountId && olderThan(row.at, row.id, cursor))
      .sort((a, b) => newestFirst(a.at, a.id, b.at, b.id))
      .slice(0, limit)
      .map((row) => ({
        ...row,
        at: new Date(row.at.getTime()),
        props: { ...row.props },
        receivedAt: new Date(row.receivedAt.getTime()),
      }));
    return Promise.resolve(rows);
  }

  /**
   * Append a copy of `row`.
   *
   * @param row - Audit row.
   * @returns Resolves once stored.
   */
  appendAccess(row: TeamAccessRow): Promise<void> {
    this.#access.push({ ...row, at: new Date(row.at.getTime()) });
    return Promise.resolve();
  }

  /**
   * Newest-first audit rows.
   *
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Copies.
   */
  listAccess(cursor: MemberDataCursor | null, limit: number): Promise<TeamAccessRow[]> {
    const rows = this.#access
      .filter((row) => olderThan(row.at, row.id, cursor))
      .sort((a, b) => newestFirst(a.at, a.id, b.at, b.id))
      .slice(0, limit)
      .map((row) => ({ ...row, at: new Date(row.at.getTime()) }));
    return Promise.resolve(rows);
  }
}

/** A SQL timestamp as the driver returns it. */
type SqlTime = Date | string;

/** A SQL bigint as the driver returns it. */
type SqlInt = number | string | bigint;

/** Parse a SQL timestamp. */
function sqlDate(value: SqlTime): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Row shape selected from `wallet_balance_snapshot`. */
interface BalanceSqlRow {
  id: string;
  account_id: string;
  balance_sats: SqlInt;
  synced_at: SqlTime;
  received_at: SqlTime;
}

/** Row shape selected from `wallet_payment`. */
interface PaymentSqlRow {
  account_id: string;
  payment_id: string;
  direction: WalletPaymentDirection;
  status: WalletPaymentStatus;
  amount_sats: SqlInt;
  fee_sats: SqlInt;
  paid_at: SqlTime;
  method: string;
  payment_hash: string | null;
  invoice: string | null;
  destination: string | null;
  description: string | null;
  lnurl_comment: string | null;
  category: WalletPaymentCategory;
  counterparty_account_id: string | null;
  first_seen_at: SqlTime;
  updated_at: SqlTime;
}

/** Row shape of the grouped totals query. */
interface TotalSqlRow {
  category: WalletPaymentCategory;
  direction: WalletPaymentDirection;
  count: SqlInt;
  amount_sats: SqlInt;
  fee_sats: SqlInt;
}

/** Row shape selected from `member_event`. */
interface EventSqlRow {
  id: string;
  account_id: string;
  name: string;
  at: SqlTime;
  path: string | null;
  props: Record<string, MemberEventProp> | string | null;
  received_at: SqlTime;
}

/** Row shape selected from `team_access_audit`. */
interface AccessSqlRow {
  id: string;
  viewer_account_id: string;
  member_account_id: string;
  what: TeamAccessWhat;
  at: SqlTime;
}

/** Read a jsonb `props` value that the driver may return as text. */
function sqlProps(value: EventSqlRow['props']): Record<string, MemberEventProp> {
  if (value === null) {
    return {};
  }
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, MemberEventProp>) : value;
}

/** Columns selected from `wallet_payment`. */
const PAYMENT_COLUMNS = `account_id, payment_id, direction, status, amount_sats, fee_sats, paid_at, method,
  payment_hash, invoice, destination, description, lnurl_comment, category, counterparty_account_id,
  first_seen_at, updated_at`;

/**
 * Durable {@link MemberDataStore} backed by Postgres.
 */
export class PostgresMemberDataStore implements MemberDataStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Newest row of `wallet_balance_snapshot` for `accountId`.
   *
   * @param accountId - Member account (`$1`).
   * @returns The snapshot, or null.
   */
  async latestBalance(accountId: string): Promise<WalletBalanceSnapshotRow | null> {
    const rows = await this.#sql.query<BalanceSqlRow>(
      `SELECT id, account_id, balance_sats, synced_at, received_at
       FROM wallet_balance_snapshot
       WHERE account_id = $1
       ORDER BY received_at DESC, id DESC
       LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      balanceSats: Number(row.balance_sats),
      syncedAt: sqlDate(row.synced_at),
      receivedAt: sqlDate(row.received_at),
    };
  }

  /**
   * Filtered newest-first page of `wallet_payment`.
   *
   * @param accountId - Member account.
   * @param filter - Period, category, and direction filters.
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Mapped rows.
   */
  async listPayments(
    accountId: string,
    filter: WalletPaymentFilter,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<WalletPaymentRow[]> {
    const params: unknown[] = [accountId];
    const where = ['account_id = $1'];
    if (filter.since !== null) {
      params.push(filter.since);
      where.push(`paid_at >= $${params.length}`);
    }
    if (filter.category !== undefined) {
      params.push(filter.category);
      where.push(`category = $${params.length}`);
    }
    if (filter.direction !== undefined) {
      params.push(filter.direction);
      where.push(`direction = $${params.length}`);
    }
    if (cursor !== null) {
      params.push(cursor.at, cursor.id);
      const at = `$${params.length - 1}`;
      const id = `$${params.length}`;
      where.push(`(paid_at < ${at} OR (paid_at = ${at} AND payment_id COLLATE "C" < ${id}))`);
    }
    params.push(limit);
    const rows = await this.#sql.query<PaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS}
       FROM wallet_payment
       WHERE ${where.join(' AND ')}
       ORDER BY paid_at DESC, payment_id COLLATE "C" DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      paymentId: row.payment_id,
      direction: row.direction,
      status: row.status,
      amountSats: Number(row.amount_sats),
      feeSats: Number(row.fee_sats),
      paidAt: sqlDate(row.paid_at),
      method: row.method,
      paymentHash: row.payment_hash,
      invoice: row.invoice,
      destination: row.destination,
      description: row.description,
      lnurlComment: row.lnurl_comment,
      category: row.category,
      counterpartyAccountId: row.counterparty_account_id,
      firstSeenAt: sqlDate(row.first_seen_at),
      updatedAt: sqlDate(row.updated_at),
    }));
  }

  /**
   * Completed-payment totals grouped by category and direction.
   *
   * @param accountId - Member account (`$1`).
   * @param since - Lower bound (`$2`), or null.
   * @returns Total rows.
   */
  async paymentTotals(accountId: string, since: Date | null): Promise<WalletPaymentTotalRow[]> {
    const rows = await this.#sql.query<TotalSqlRow>(
      `SELECT category, direction, count(*) AS count,
              coalesce(sum(amount_sats), 0)::text AS amount_sats,
              coalesce(sum(fee_sats), 0)::text AS fee_sats
       FROM wallet_payment
       WHERE account_id = $1 AND status = 'completed'
         AND ($2::timestamptz IS NULL OR paid_at >= $2::timestamptz)
       GROUP BY category, direction`,
      [accountId, since],
    );
    return rows.map((row) => ({
      category: row.category,
      direction: row.direction,
      count: Number(row.count),
      amountSats: Number(row.amount_sats),
      feeSats: Number(row.fee_sats),
    }));
  }

  /**
   * Newest-first page of `member_event`.
   *
   * @param accountId - Member account.
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Mapped rows.
   */
  async listEvents(
    accountId: string,
    cursor: MemberDataCursor | null,
    limit: number,
  ): Promise<MemberEventRow[]> {
    const rows = await this.#sql.query<EventSqlRow>(
      `SELECT id, account_id, name, at, path, props, received_at
       FROM member_event
       WHERE account_id = $1
         AND ($2::timestamptz IS NULL OR at < $2::timestamptz OR (at = $2::timestamptz AND id < $3::uuid))
       ORDER BY at DESC, id DESC
       LIMIT $4`,
      [accountId, cursor?.at ?? null, cursor?.id ?? null, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      at: sqlDate(row.at),
      path: row.path,
      props: sqlProps(row.props),
      receivedAt: sqlDate(row.received_at),
    }));
  }

  /**
   * Insert one `team_access_audit` row.
   *
   * @param row - Audit row.
   * @returns Resolves once stored.
   */
  async appendAccess(row: TeamAccessRow): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO team_access_audit (id, viewer_account_id, member_account_id, what, at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.viewerAccountId, row.memberAccountId, row.what, row.at],
    );
  }

  /**
   * Newest-first page of `team_access_audit`.
   *
   * @param cursor - Keyset position, or null.
   * @param limit - Maximum rows.
   * @returns Mapped rows.
   */
  async listAccess(cursor: MemberDataCursor | null, limit: number): Promise<TeamAccessRow[]> {
    const rows = await this.#sql.query<AccessSqlRow>(
      `SELECT id, viewer_account_id, member_account_id, what, at
       FROM team_access_audit
       WHERE ($1::timestamptz IS NULL OR at < $1::timestamptz OR (at = $1::timestamptz AND id < $2::uuid))
       ORDER BY at DESC, id DESC
       LIMIT $3`,
      [cursor?.at ?? null, cursor?.id ?? null, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      viewerAccountId: row.viewer_account_id,
      memberAccountId: row.member_account_id,
      what: row.what,
      at: sqlDate(row.at),
    }));
  }
}
