/**
 * Persistence for Web Push subscriptions and the notification outbox.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** One browser PushSubscription bound to an account. */
export interface PushSubscriptionRecord {
  /** Push service endpoint URL (primary key). */
  endpoint: string;
  /** Owning account id. */
  accountId: string;
  /** Client public key (url-safe base64). */
  p256dh: string;
  /** Auth secret (url-safe base64). */
  auth: string;
  /** When the subscription was first stored. */
  createdAt: Date;
}

/** One queued notification awaiting the push worker. */
export interface PushOutboxRow {
  /** Outbox row id. */
  id: string;
  /** Recipient account id. */
  accountId: string;
  /** Notification kind. */
  type: 'forum' | 'zap';
  /** Forum message id when applicable; null for debug pings. */
  messageId: string | null;
  /** JSON string payload. */
  payload: string;
  /** Delivery status. */
  status: 'pending' | 'sent' | 'failed';
  /** Failed send attempts so far. */
  attempts: number;
  /** Lease expiry while a worker owns the row. */
  claimedUntil: Date | null;
  /** Enqueue time. */
  createdAt: Date;
}

/**
 * Persistence port for push subscriptions and outbox rows.
 */
export interface PushStore {
  /**
   * Insert or rebind a subscription by endpoint.
   *
   * @param row - Fully formed subscription.
   */
  upsertSubscription(row: PushSubscriptionRecord): Promise<PushSubscriptionRecord>;

  /**
   * Remove a subscription for an account + endpoint.
   *
   * @param accountId - Owning account.
   * @param endpoint - Push endpoint URL.
   * @returns Whether a matching row was removed.
   */
  deleteSubscription(accountId: string, endpoint: string): Promise<boolean>;

  /**
   * List subscriptions for one account (caller-owned copies).
   *
   * @param accountId - Account id.
   * @returns Subscription rows.
   */
  listByAccount(accountId: string): Promise<PushSubscriptionRecord[]>;

  /**
   * Distinct account ids that currently have at least one subscription.
   *
   * @returns Account ids.
   */
  listAccountIdsWithSubscriptions(): Promise<string[]>;

  /**
   * Append a pending outbox row.
   *
   * @param row - Fully formed outbox row.
   */
  enqueue(row: PushOutboxRow): Promise<void>;

  /**
   * Claim pending outbox rows with a lease (oldest first).
   *
   * @param limit - Max rows.
   * @param nowMs - Clock.
   * @param leaseMs - Lease duration.
   * @returns Claimed rows.
   */
  claimPending(limit: number, nowMs: number, leaseMs: number): Promise<PushOutboxRow[]>;

  /**
   * Mark an outbox row as sent.
   *
   * @param id - Outbox id.
   */
  markSent(id: string): Promise<void>;

  /**
   * Increment attempts; terminal failed at 8, otherwise re-queue pending.
   *
   * @param id - Outbox id.
   */
  markFailed(id: string): Promise<void>;
}

/** Idempotent DDL for push tables (matches `docs/schema/push.sql`). */
export const PUSH_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS push_subscription (
  endpoint text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS push_subscription_account_id_idx ON push_subscription (account_id)`,
  `CREATE TABLE IF NOT EXISTS push_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  type text NOT NULL CHECK (type IN ('forum', 'zap')),
  message_id uuid,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS push_outbox_pending_idx ON push_outbox (created_at, id) WHERE status = 'pending'`,
];

/**
 * Apply {@link PUSH_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migratePushSchema(sql: SqlClient): Promise<void> {
  for (const statement of PUSH_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Copy a subscription so callers cannot mutate store state. */
function copySub(row: PushSubscriptionRecord): PushSubscriptionRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
  };
}

/** Copy an outbox row so callers cannot mutate store state. */
function copyOutbox(row: PushOutboxRow): PushOutboxRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    claimedUntil: row.claimedUntil === null ? null : new Date(row.claimedUntil.getTime()),
  };
}

/**
 * Process-local {@link PushStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryPushStore implements PushStore {
  readonly #subs = new Map<string, PushSubscriptionRecord>();
  readonly #outbox: PushOutboxRow[] = [];

  /**
   * Insert or rebind by endpoint; keep original `createdAt` on conflict.
   *
   * @param row - Subscription to store.
   */
  upsertSubscription(row: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    const existing = this.#subs.get(row.endpoint);
    if (existing !== undefined) {
      const stored: PushSubscriptionRecord = {
        endpoint: row.endpoint,
        accountId: row.accountId,
        p256dh: row.p256dh,
        auth: row.auth,
        createdAt: new Date(existing.createdAt.getTime()),
      };
      this.#subs.set(row.endpoint, stored);
      return Promise.resolve(copySub(stored));
    }
    this.#subs.set(row.endpoint, copySub(row));
    return Promise.resolve(copySub(row));
  }

  /**
   * Remove a matching account + endpoint subscription.
   *
   * @param accountId - Owning account.
   * @param endpoint - Push endpoint.
   * @returns Whether a row was removed.
   */
  deleteSubscription(accountId: string, endpoint: string): Promise<boolean> {
    const existing = this.#subs.get(endpoint);
    if (existing === undefined || existing.accountId !== accountId) {
      return Promise.resolve(false);
    }
    this.#subs.delete(endpoint);
    return Promise.resolve(true);
  }

  /**
   * List subscriptions for one account (copies).
   *
   * @param accountId - Account id.
   * @returns Subscription copies.
   */
  listByAccount(accountId: string): Promise<PushSubscriptionRecord[]> {
    const rows: PushSubscriptionRecord[] = [];
    for (const row of this.#subs.values()) {
      if (row.accountId === accountId) {
        rows.push(copySub(row));
      }
    }
    return Promise.resolve(rows);
  }

  /**
   * Distinct account ids with at least one subscription.
   *
   * @returns Account ids.
   */
  listAccountIdsWithSubscriptions(): Promise<string[]> {
    const ids = new Set<string>();
    for (const row of this.#subs.values()) {
      ids.add(row.accountId);
    }
    return Promise.resolve([...ids]);
  }

  /**
   * Append a copy of the outbox row.
   *
   * @param row - Outbox row.
   */
  enqueue(row: PushOutboxRow): Promise<void> {
    this.#outbox.push(copyOutbox(row));
    return Promise.resolve();
  }

  /**
   * Claim pending rows whose lease is null or expired (oldest first).
   *
   * @param limit - Max rows.
   * @param nowMs - Clock.
   * @param leaseMs - Lease duration.
   * @returns Claimed copies.
   */
  claimPending(limit: number, nowMs: number, leaseMs: number): Promise<PushOutboxRow[]> {
    const until = new Date(nowMs + leaseMs);
    const candidates = this.#outbox
      .filter((row) => {
        if (row.status !== 'pending') {
          return false;
        }
        if (row.claimedUntil !== null && row.claimedUntil.getTime() > nowMs) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, limit);
    const claimed: PushOutboxRow[] = [];
    for (const row of candidates) {
      row.claimedUntil = until;
      claimed.push(copyOutbox(row));
    }
    return Promise.resolve(claimed);
  }

  /**
   * Mark an outbox row sent.
   *
   * @param id - Outbox id.
   */
  markSent(id: string): Promise<void> {
    const row = this.#outbox.find((item) => item.id === id);
    if (row !== undefined) {
      row.status = 'sent';
    }
    return Promise.resolve();
  }

  /**
   * Increment attempts; fail at 8, else clear lease and stay pending.
   *
   * @param id - Outbox id.
   */
  markFailed(id: string): Promise<void> {
    const row = this.#outbox.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve();
    }
    row.attempts += 1;
    if (row.attempts >= 8) {
      row.status = 'failed';
    } else {
      row.status = 'pending';
      row.claimedUntil = null;
    }
    return Promise.resolve();
  }
}

/** Row shape selected from `push_subscription`. */
interface PushSubSqlRow {
  endpoint: string;
  account_id: string;
  p256dh: string;
  auth: string;
  created_at: Date | string;
}

/** Row shape selected from `push_outbox`. */
interface PushOutboxSqlRow {
  id: string;
  account_id: string;
  type: string;
  message_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  claimed_until: Date | string | null;
  created_at: Date | string;
}

function mapSub(row: PushSubSqlRow): PushSubscriptionRecord {
  return {
    endpoint: row.endpoint,
    accountId: row.account_id,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

function mapOutbox(row: PushOutboxSqlRow): PushOutboxRow {
  const type = row.type === 'forum' || row.type === 'zap' ? row.type : 'forum';
  const status =
    row.status === 'pending' || row.status === 'sent' || row.status === 'failed'
      ? row.status
      : 'pending';
  return {
    id: row.id,
    accountId: row.account_id,
    type,
    messageId: row.message_id,
    payload: row.payload,
    status,
    attempts: row.attempts,
    claimedUntil:
      row.claimed_until === null || row.claimed_until === undefined
        ? null
        : row.claimed_until instanceof Date
          ? row.claimed_until
          : new Date(row.claimed_until),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

const OUTBOX_SELECT =
  'id, account_id, type, message_id, payload, status, attempts, claimed_until, created_at';

/**
 * Durable {@link PushStore} backed by Postgres.
 */
export class PostgresPushStore implements PushStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert or rebind by endpoint; do not overwrite `created_at` on conflict.
   *
   * @param row - Subscription to store.
   */
  async upsertSubscription(row: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    const rows = await this.#sql.query<{
      endpoint: string;
      account_id: string;
      p256dh: string;
      auth: string;
      created_at: Date | string;
    }>(
      `INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth
       RETURNING endpoint, account_id, p256dh, auth, created_at`,
      [row.endpoint, row.accountId, row.p256dh, row.auth, row.createdAt],
    );
    const stored = rows[0];
    if (stored === undefined) {
      throw new Error('push.subscription.upsert_empty');
    }
    return {
      endpoint: stored.endpoint,
      accountId: stored.account_id,
      p256dh: stored.p256dh,
      auth: stored.auth,
      createdAt:
        stored.created_at instanceof Date ? stored.created_at : new Date(stored.created_at),
    };
  }

  /**
   * Delete by account + endpoint.
   *
   * @param accountId - Owning account.
   * @param endpoint - Push endpoint.
   * @returns Whether a row was removed.
   */
  async deleteSubscription(accountId: string, endpoint: string): Promise<boolean> {
    const rows = await this.#sql.query<{ endpoint: string }>(
      `DELETE FROM push_subscription WHERE account_id = $1 AND endpoint = $2 RETURNING endpoint`,
      [accountId, endpoint],
    );
    return rows.length > 0;
  }

  /**
   * List subscriptions for one account.
   *
   * @param accountId - Account id.
   * @returns Mapped rows.
   */
  async listByAccount(accountId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.#sql.query<PushSubSqlRow>(
      `SELECT endpoint, account_id, p256dh, auth, created_at
       FROM push_subscription WHERE account_id = $1`,
      [accountId],
    );
    return rows.map((row) => mapSub(row));
  }

  /**
   * Distinct account ids with subscriptions.
   *
   * @returns Account ids.
   */
  async listAccountIdsWithSubscriptions(): Promise<string[]> {
    const rows = await this.#sql.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM push_subscription`,
    );
    return rows.map((row) => row.account_id);
  }

  /**
   * Insert an outbox row.
   *
   * @param row - Fully formed outbox row.
   */
  async enqueue(row: PushOutboxRow): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO push_outbox
         (id, account_id, type, message_id, payload, status, attempts, claimed_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.accountId,
        row.type,
        row.messageId,
        row.payload,
        row.status,
        row.attempts,
        row.claimedUntil,
        row.createdAt,
      ],
    );
  }

  /**
   * Claim pending rows with `FOR UPDATE SKIP LOCKED`.
   *
   * @param limit - Max rows.
   * @param nowMs - Clock.
   * @param leaseMs - Lease duration.
   * @returns Claimed rows.
   */
  async claimPending(limit: number, nowMs: number, leaseMs: number): Promise<PushOutboxRow[]> {
    const until = new Date(nowMs + leaseMs);
    const rows = await this.#sql.query<PushOutboxSqlRow>(
      `UPDATE push_outbox SET claimed_until = $1
       WHERE id IN (
         SELECT id FROM push_outbox
         WHERE status = 'pending'
           AND (claimed_until IS NULL OR claimed_until < $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${OUTBOX_SELECT}`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapOutbox(row));
  }

  /**
   * Mark an outbox row sent.
   *
   * @param id - Outbox id.
   */
  async markSent(id: string): Promise<void> {
    await this.#sql.execute(`UPDATE push_outbox SET status = 'sent' WHERE id = $1`, [id]);
  }

  /**
   * Increment attempts; terminal failed at 8, else pending with cleared lease.
   *
   * @param id - Outbox id.
   */
  async markFailed(id: string): Promise<void> {
    await this.#sql.execute(
      `UPDATE push_outbox SET
         attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END,
         claimed_until = CASE WHEN attempts + 1 >= 8 THEN claimed_until ELSE NULL END
       WHERE id = $1`,
      [id],
    );
  }
}
