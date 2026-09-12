/**
 * Persistence for in-app notifications (forum replies).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. New public tables are covered by `db_change` attach.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { NotificationRow, NotificationType } from '@/lib/notification';

/**
 * Persistence port for in-app notifications.
 */
export interface NotificationStore {
  /**
   * Persist a notification. Unique on `(recipientAccountId, type, replyId)` —
   * a duplicate returns the existing row.
   *
   * @param row - Fully formed notification.
   * @returns The stored row (a copy is fine).
   */
  create(row: NotificationRow): Promise<NotificationRow>;

  /**
   * Newest notifications first (`createdAt` desc, then `id` desc), capped at
   * `limit`.
   *
   * @param accountId - Recipient account.
   * @param limit - Maximum rows.
   * @returns Notification rows (caller-owned copies).
   */
  listByRecipient(accountId: string, limit: number): Promise<NotificationRow[]>;

  /**
   * Count of unread rows for the recipient (not limited to a list page).
   *
   * @param accountId - Recipient account.
   * @returns Unread count (`readAt === null`).
   */
  unreadCount(accountId: string): Promise<number>;

  /**
   * One notification by id for the recipient, or `undefined`.
   *
   * @param id - Notification id.
   * @param accountId - Recipient account.
   */
  getByIdForRecipient(id: string, accountId: string): Promise<NotificationRow | undefined>;

  /**
   * Mark one notification read. Missing / other recipient → `undefined`.
   * Already read → return as-is (do not overwrite `readAt`).
   *
   * @param id - Notification id.
   * @param accountId - Recipient account.
   * @param readAt - Read stamp for a previously unread row.
   */
  markRead(id: string, accountId: string, readAt: Date): Promise<NotificationRow | undefined>;

  /**
   * Mark every unread notification for the recipient read. Already-read rows
   * stay unchanged.
   *
   * @param accountId - Recipient account.
   * @param readAt - Read stamp for previously unread rows.
   */
  markAllRead(accountId: string, readAt: Date): Promise<void>;
}

/** Idempotent DDL for the notification table (matches `docs/schema/notification.sql`). */
export const NOTIFICATION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS notification (
  id uuid PRIMARY KEY,
  recipient_account_id uuid NOT NULL REFERENCES account (id),
  actor_account_id uuid NOT NULL REFERENCES account (id),
  type text NOT NULL,
  parent_id uuid NOT NULL,
  reply_id uuid NOT NULL,
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notification_recipient_type_reply_idx
  ON notification (recipient_account_id, type, reply_id)`,
  `CREATE INDEX IF NOT EXISTS notification_recipient_created_at_idx
  ON notification (recipient_account_id, created_at DESC, id DESC)`,
];

const NOTIFICATION_SELECT =
  'id, recipient_account_id, actor_account_id, type, parent_id, reply_id, name, text, created_at, read_at';

/**
 * Apply {@link NOTIFICATION_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateNotificationSchema(sql: SqlClient): Promise<void> {
  for (const statement of NOTIFICATION_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link NotificationStore}. Used in tests and when no database
 * URL is configured — the process still boots.
 */
export class InMemoryNotificationStore implements NotificationStore {
  readonly #rows: NotificationRow[];

  /**
   * @param seed - Optional seed rows; copied into private storage.
   */
  constructor(seed: readonly NotificationRow[] = []) {
    this.#rows = seed.map((row) => copyNotification(row));
  }

  /**
   * Append a copy of `row`, or return the existing unique row.
   *
   * @param row - Notification to store.
   * @returns A copy of the stored row.
   */
  create(row: NotificationRow): Promise<NotificationRow> {
    const existing = this.#rows.find(
      (item) =>
        item.recipientAccountId === row.recipientAccountId &&
        item.type === row.type &&
        item.replyId === row.replyId,
    );
    if (existing !== undefined) {
      return Promise.resolve(copyNotification(existing));
    }
    const stored = copyNotification(row);
    this.#rows.push(stored);
    return Promise.resolve(copyNotification(stored));
  }

  /**
   * Newest-first copy of stored rows for `accountId`, capped at `limit`.
   *
   * @param accountId - Recipient account.
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   */
  listByRecipient(accountId: string, limit: number): Promise<NotificationRow[]> {
    const sorted = this.#rows
      .filter((row) => row.recipientAccountId === accountId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyNotification(row)));
  }

  /**
   * Count unread rows for `accountId`.
   *
   * @param accountId - Recipient account.
   * @returns Unread count.
   */
  unreadCount(accountId: string): Promise<number> {
    return Promise.resolve(
      this.#rows.filter((row) => row.recipientAccountId === accountId && row.readAt === null)
        .length,
    );
  }

  /**
   * One notification by id and recipient, or `undefined`.
   *
   * @param id - Notification id.
   * @param accountId - Recipient account.
   */
  getByIdForRecipient(id: string, accountId: string): Promise<NotificationRow | undefined> {
    const row = this.#rows.find((item) => item.id === id && item.recipientAccountId === accountId);
    return Promise.resolve(row === undefined ? undefined : copyNotification(row));
  }

  /**
   * Stamp `readAt` on an unread row owned by `accountId`.
   *
   * @param id - Notification id.
   * @param accountId - Recipient account.
   * @param readAt - Read stamp.
   */
  markRead(id: string, accountId: string, readAt: Date): Promise<NotificationRow | undefined> {
    const row = this.#rows.find((item) => item.id === id && item.recipientAccountId === accountId);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    if (row.readAt !== null) {
      return Promise.resolve(copyNotification(row));
    }
    row.readAt = new Date(readAt.getTime());
    return Promise.resolve(copyNotification(row));
  }

  /**
   * Stamp `readAt` on every unread row for `accountId`.
   *
   * @param accountId - Recipient account.
   * @param readAt - Read stamp.
   */
  markAllRead(accountId: string, readAt: Date): Promise<void> {
    for (const row of this.#rows) {
      if (row.recipientAccountId === accountId && row.readAt === null) {
        row.readAt = new Date(readAt.getTime());
      }
    }
    return Promise.resolve();
  }
}

/** Row shape selected from `notification`. */
interface NotificationSqlRow {
  id: string;
  recipient_account_id: string;
  actor_account_id: string;
  type: string;
  parent_id: string;
  reply_id: string;
  name: string;
  text: string;
  created_at: Date | string;
  read_at: Date | string | null;
}

/**
 * Durable {@link NotificationStore} backed by Postgres.
 */
export class PostgresNotificationStore implements NotificationStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert `row` into `notification`. Unique violation re-selects the existing
   * row. Empty re-select throws.
   *
   * @param row - Fully formed notification.
   * @returns The stored row (a copy).
   */
  async create(row: NotificationRow): Promise<NotificationRow> {
    try {
      await this.#sql.execute(
        `INSERT INTO notification (
           id, recipient_account_id, actor_account_id, type, parent_id, reply_id, name, text, created_at, read_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.id,
          row.recipientAccountId,
          row.actorAccountId,
          row.type,
          row.parentId,
          row.replyId,
          row.name,
          row.text,
          row.createdAt,
          row.readAt,
        ],
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.#sql.query<NotificationSqlRow>(
        `SELECT ${NOTIFICATION_SELECT} FROM notification
         WHERE recipient_account_id = $1 AND type = $2 AND reply_id = $3`,
        [row.recipientAccountId, row.type, row.replyId],
      );
      const found = existing[0];
      if (found === undefined) {
        throw new Error('notification create failed');
      }
      return mapNotificationRow(found);
    }
    return copyNotification(row);
  }

  /**
   * Newest-first list from `notification` for `accountId`, capped at `limit`.
   *
   * @param accountId - Recipient (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped rows.
   */
  async listByRecipient(accountId: string, limit: number): Promise<NotificationRow[]> {
    const rows = await this.#sql.query<NotificationSqlRow>(
      `SELECT ${NOTIFICATION_SELECT} FROM notification
       WHERE recipient_account_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((row) => mapNotificationRow(row));
  }

  /**
   * Count unread rows for `accountId`.
   *
   * @param accountId - Recipient (`$1`).
   * @returns Mapped count.
   */
  async unreadCount(accountId: string): Promise<number> {
    const rows = await this.#sql.query<{ count: number | string | bigint }>(
      `SELECT COUNT(*)::bigint AS count FROM notification WHERE recipient_account_id = $1 AND read_at IS NULL`,
      [accountId],
    );
    return mapCount(rows[0]?.count);
  }

  /**
   * One row by id and recipient, or `undefined`.
   *
   * @param id - Notification id (`$1`).
   * @param accountId - Recipient (`$2`).
   */
  async getByIdForRecipient(id: string, accountId: string): Promise<NotificationRow | undefined> {
    const rows = await this.#sql.query<NotificationSqlRow>(
      `SELECT ${NOTIFICATION_SELECT} FROM notification WHERE id = $1 AND recipient_account_id = $2`,
      [id, accountId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapNotificationRow(row);
  }

  /**
   * Stamp `read_at` when the row is unread and owned by `accountId`.
   *
   * @param id - Notification id.
   * @param accountId - Recipient.
   * @param readAt - Read stamp.
   */
  async markRead(
    id: string,
    accountId: string,
    readAt: Date,
  ): Promise<NotificationRow | undefined> {
    const existing = await this.getByIdForRecipient(id, accountId);
    if (existing === undefined) {
      return undefined;
    }
    if (existing.readAt !== null) {
      return existing;
    }
    await this.#sql.execute(
      `UPDATE notification SET read_at = $3 WHERE id = $1 AND recipient_account_id = $2 AND read_at IS NULL`,
      [id, accountId, readAt],
    );
    return { ...existing, readAt: new Date(readAt.getTime()) };
  }

  /**
   * Stamp `read_at` on every unread row for `accountId`.
   *
   * @param accountId - Recipient (`$1`).
   * @param readAt - Read stamp (`$2`).
   */
  async markAllRead(accountId: string, readAt: Date): Promise<void> {
    await this.#sql.execute(
      `UPDATE notification SET read_at = $2 WHERE recipient_account_id = $1 AND read_at IS NULL`,
      [accountId, readAt],
    );
  }
}

function copyNotification(row: NotificationRow): NotificationRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    readAt: row.readAt === null ? null : new Date(row.readAt.getTime()),
  };
}

function mapNotificationRow(row: NotificationSqlRow): NotificationRow {
  return {
    id: row.id,
    recipientAccountId: row.recipient_account_id,
    actorAccountId: row.actor_account_id,
    type: row.type as NotificationType,
    parentId: row.parent_id,
    replyId: row.reply_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    readAt:
      row.read_at === null || row.read_at === undefined
        ? null
        : row.read_at instanceof Date
          ? row.read_at
          : new Date(row.read_at),
  };
}

function mapCount(value: number | string | bigint | undefined): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return 0;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
