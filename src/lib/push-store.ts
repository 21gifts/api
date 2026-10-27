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
  /**
   * Bearer token of the session that last registered this endpoint. `null`
   * on a row stored before subscriptions were bound to a session; such a row
   * is never sent to and the sweep removes it.
   */
  sessionToken: string | null;
}

/** One queued notification awaiting the push worker. */
export interface PushOutboxRow {
  /** Outbox row id. */
  id: string;
  /** Recipient account id. */
  accountId: string;
  /** Notification kind. */
  type: 'forum' | 'zap' | 'conversation' | 'dismiss';
  /** Forum or conversation message id when applicable; null for debug pings and dismiss rows. */
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
  /** When the row became `sent` or `failed`; null while pending and on rows finished before this column existed. */
  finishedAt: Date | null;
  /** Endpoints that already received this payload (url strings). */
  deliveredEndpoints: string[];
  /** Endpoints that must not receive this payload (url strings). */
  skipEndpoints: string[];
}

/**
 * Persistence port for push subscriptions and outbox rows.
 */
export interface PushStore {
  /**
   * Insert or rebind a subscription by endpoint. A rebind replaces the
   * account, keys, and session token.
   *
   * @param row - Fully formed subscription.
   * @returns The stored row (original `createdAt` on endpoint conflict).
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
   * Remove a subscription only while it still matches the listed row's
   * account, endpoint, and session token. A re-POST that rebound the
   * endpoint after the row was read keeps the new binding.
   *
   * @param sub - Subscription as it was read (account, endpoint, session token).
   * @returns Whether a matching row was removed.
   */
  deleteStaleSubscription(sub: PushSubscriptionRecord): Promise<boolean>;

  /**
   * List subscriptions for one account (caller-owned copies).
   *
   * @param accountId - Account id.
   * @returns Subscription rows.
   */
  listByAccount(accountId: string): Promise<PushSubscriptionRecord[]>;

  /**
   * Every push subscription (caller-owned copies). Operator dump.
   *
   * @returns Subscription rows.
   */
  listAllSubscriptions(): Promise<PushSubscriptionRecord[]>;

  /**
   * Newest outbox rows first (`createdAt` desc, then `id` desc), capped at
   * `limit`. Operator dump.
   *
   * @param limit - Maximum rows.
   * @returns Outbox copies.
   */
  listAllOutbox(limit: number): Promise<PushOutboxRow[]>;

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
   * Mark an outbox row as sent and stamp `finishedAt`.
   *
   * @param id - Outbox id.
   * @param nowMs - Clock stored as `finishedAt`.
   */
  markSent(id: string, nowMs: number): Promise<void>;

  /**
   * Increment attempts; terminal failed at 8 (stamps `finishedAt`),
   * otherwise re-queue pending.
   *
   * @param id - Outbox id.
   * @param nowMs - Clock stored as `finishedAt` when the row turns failed.
   */
  markFailed(id: string, nowMs: number): Promise<void>;

  /**
   * Delete `sent` and `failed` rows that finished before `beforeMs`. A row
   * finished before `finishedAt` existed counts from its `createdAt`.
   * Pending rows are never deleted.
   *
   * @param beforeMs - Cutoff (epoch ms, exclusive).
   * @returns Number of rows deleted.
   */
  deleteFinishedOutbox(beforeMs: number): Promise<number>;

  /**
   * Union `endpoints` into the stored delivered list for this outbox row.
   * Duplicate strings are stored once. Unknown id is a no-op.
   *
   * @param id - Outbox id.
   * @param endpoints - Endpoint URLs that received the payload.
   */
  recordDelivered(id: string, endpoints: readonly string[]): Promise<void>;
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
  `ALTER TABLE push_subscription ADD COLUMN IF NOT EXISTS session_token text`,
  `CREATE TABLE IF NOT EXISTS push_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  type text NOT NULL CHECK (type IN ('forum', 'zap', 'conversation', 'dismiss')),
  message_id uuid,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL,
  delivered_endpoints text NOT NULL DEFAULT '[]',
  skip_endpoints text NOT NULL DEFAULT '[]'
)`,
  `CREATE INDEX IF NOT EXISTS push_outbox_pending_idx ON push_outbox (created_at, id) WHERE status = 'pending'`,
  `ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS delivered_endpoints text NOT NULL DEFAULT '[]'`,
  `ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS skip_endpoints text NOT NULL DEFAULT '[]'`,
  `ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS finished_at timestamptz`,
  `DO $push_outbox_type$
BEGIN
  ALTER TABLE push_outbox DROP CONSTRAINT IF EXISTS push_outbox_type_check;
  ALTER TABLE push_outbox ADD CONSTRAINT push_outbox_type_check
    CHECK (type IN ('forum', 'zap', 'conversation', 'dismiss'));
END
$push_outbox_type$;`,
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

/** Parse `delivered_endpoints` JSON text into unique non-empty strings. */
function parseDeliveredEndpoints(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string' || item === '') {
      continue;
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Union unique endpoint strings onto an existing list (first-seen order). */
function unionDeliveredEndpoints(
  current: readonly string[],
  endpoints: readonly string[],
): string[] {
  const out = current.slice();
  const seen = new Set(out);
  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string' || endpoint === '' || seen.has(endpoint)) {
      continue;
    }
    seen.add(endpoint);
    out.push(endpoint);
  }
  return out;
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
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt.getTime()),
    deliveredEndpoints: row.deliveredEndpoints.slice(),
    skipEndpoints: row.skipEndpoints.slice(),
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
   * @returns A copy of the stored row.
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
        sessionToken: row.sessionToken,
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
   * Remove the subscription when account, endpoint, and session token still match.
   *
   * @param sub - Subscription as it was read.
   * @returns Whether a row was removed.
   */
  deleteStaleSubscription(sub: PushSubscriptionRecord): Promise<boolean> {
    const existing = this.#subs.get(sub.endpoint);
    if (
      existing === undefined ||
      existing.accountId !== sub.accountId ||
      existing.sessionToken !== sub.sessionToken
    ) {
      return Promise.resolve(false);
    }
    this.#subs.delete(sub.endpoint);
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

  listAllSubscriptions(): Promise<PushSubscriptionRecord[]> {
    return Promise.resolve(
      [...this.#subs.values()]
        .sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }
          return b.endpoint.localeCompare(a.endpoint);
        })
        .map((row) => copySub(row)),
    );
  }

  listAllOutbox(limit: number): Promise<PushOutboxRow[]> {
    const sorted = [...this.#outbox].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyOutbox(row)));
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
   * @param nowMs - Clock stored as `finishedAt`.
   */
  markSent(id: string, nowMs: number): Promise<void> {
    const row = this.#outbox.find((item) => item.id === id);
    if (row !== undefined) {
      row.status = 'sent';
      row.finishedAt = new Date(nowMs);
    }
    return Promise.resolve();
  }

  /**
   * Increment attempts; fail at 8, else clear lease and stay pending.
   *
   * @param id - Outbox id.
   * @param nowMs - Clock stored as `finishedAt` when the row turns failed.
   */
  markFailed(id: string, nowMs: number): Promise<void> {
    const row = this.#outbox.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve();
    }
    row.attempts += 1;
    if (row.attempts >= 8) {
      row.status = 'failed';
      row.finishedAt = new Date(nowMs);
    } else {
      row.status = 'pending';
      row.claimedUntil = null;
    }
    return Promise.resolve();
  }

  /**
   * Drop finished rows whose `finishedAt` (else `createdAt`) is before the cutoff.
   *
   * @param beforeMs - Cutoff (epoch ms, exclusive).
   * @returns Number of rows deleted.
   */
  deleteFinishedOutbox(beforeMs: number): Promise<number> {
    let deleted = 0;
    for (let i = this.#outbox.length - 1; i >= 0; i -= 1) {
      const row = this.#outbox[i] as PushOutboxRow;
      if (row.status === 'pending') {
        continue;
      }
      if ((row.finishedAt ?? row.createdAt).getTime() < beforeMs) {
        this.#outbox.splice(i, 1);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  /**
   * Union unique endpoints onto the in-memory delivered list.
   *
   * @param id - Outbox id.
   * @param endpoints - Newly delivered endpoint URLs.
   */
  recordDelivered(id: string, endpoints: readonly string[]): Promise<void> {
    const row = this.#outbox.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve();
    }
    row.deliveredEndpoints = unionDeliveredEndpoints(row.deliveredEndpoints, endpoints);
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
  session_token: string | null;
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
  finished_at: Date | string | null;
  delivered_endpoints: string | null;
  skip_endpoints: string | null;
}

function mapSub(row: PushSubSqlRow): PushSubscriptionRecord {
  return {
    endpoint: row.endpoint,
    accountId: row.account_id,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    sessionToken: row.session_token ?? null,
  };
}

function mapOutbox(row: PushOutboxSqlRow): PushOutboxRow {
  const type =
    row.type === 'forum' ||
    row.type === 'zap' ||
    row.type === 'conversation' ||
    row.type === 'dismiss'
      ? row.type
      : 'forum';
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
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : row.finished_at instanceof Date
          ? row.finished_at
          : new Date(row.finished_at),
    deliveredEndpoints: parseDeliveredEndpoints(row.delivered_endpoints),
    skipEndpoints: parseDeliveredEndpoints(row.skip_endpoints),
  };
}

const OUTBOX_SELECT =
  'id, account_id, type, message_id, payload, status, attempts, claimed_until, created_at, finished_at, delivered_endpoints, skip_endpoints';

const SUB_SELECT = 'endpoint, account_id, p256dh, auth, created_at, session_token';

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
   * @returns The stored row from `RETURNING` (original `created_at` on conflict).
   */
  async upsertSubscription(row: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    const rows = await this.#sql.query<PushSubSqlRow>(
      `INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at, session_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         session_token = EXCLUDED.session_token
       RETURNING ${SUB_SELECT}`,
      [row.endpoint, row.accountId, row.p256dh, row.auth, row.createdAt, row.sessionToken],
    );
    const stored = rows[0];
    if (stored === undefined) {
      throw new Error('push.subscription.upsert_empty');
    }
    return mapSub(stored);
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
   * Delete by account + endpoint while `session_token` still equals the listed value.
   *
   * @param sub - Subscription as it was read.
   * @returns Whether a row was removed.
   */
  async deleteStaleSubscription(sub: PushSubscriptionRecord): Promise<boolean> {
    const rows = await this.#sql.query<{ endpoint: string }>(
      `DELETE FROM push_subscription
       WHERE account_id = $1 AND endpoint = $2 AND session_token IS NOT DISTINCT FROM $3
       RETURNING endpoint`,
      [sub.accountId, sub.endpoint, sub.sessionToken],
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
      `SELECT ${SUB_SELECT}
       FROM push_subscription WHERE account_id = $1`,
      [accountId],
    );
    return rows.map((row) => mapSub(row));
  }

  async listAllSubscriptions(): Promise<PushSubscriptionRecord[]> {
    const rows = await this.#sql.query<PushSubSqlRow>(
      `SELECT ${SUB_SELECT} FROM push_subscription
       ORDER BY created_at DESC, endpoint DESC`,
    );
    return rows.map((row) => mapSub(row));
  }

  async listAllOutbox(limit: number): Promise<PushOutboxRow[]> {
    const rows = await this.#sql.query<PushOutboxSqlRow>(
      `SELECT ${OUTBOX_SELECT} FROM push_outbox
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapOutbox(row));
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
         (id, account_id, type, message_id, payload, status, attempts, claimed_until, created_at, finished_at, delivered_endpoints, skip_endpoints)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        row.finishedAt,
        JSON.stringify(row.deliveredEndpoints),
        JSON.stringify(row.skipEndpoints),
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
    return rows
      .map((row) => mapOutbox(row))
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return a.id.localeCompare(b.id);
      });
  }

  /**
   * Mark an outbox row sent.
   *
   * @param id - Outbox id.
   * @param nowMs - Clock stored as `finished_at`.
   */
  async markSent(id: string, nowMs: number): Promise<void> {
    await this.#sql.execute(
      `UPDATE push_outbox SET status = 'sent', finished_at = $2 WHERE id = $1`,
      [id, new Date(nowMs)],
    );
  }

  /**
   * Increment attempts; terminal failed at 8, else pending with cleared lease.
   *
   * @param id - Outbox id.
   * @param nowMs - Clock stored as `finished_at` when the row turns failed.
   */
  async markFailed(id: string, nowMs: number): Promise<void> {
    await this.#sql.execute(
      `UPDATE push_outbox SET
         attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END,
         claimed_until = CASE WHEN attempts + 1 >= 8 THEN claimed_until ELSE NULL END,
         finished_at = CASE WHEN attempts + 1 >= 8 THEN $2 ELSE finished_at END
       WHERE id = $1`,
      [id, new Date(nowMs)],
    );
  }

  /**
   * Delete finished rows whose `finished_at` (else `created_at`) is before the cutoff.
   *
   * @param beforeMs - Cutoff (epoch ms, exclusive).
   * @returns Number of rows deleted.
   */
  async deleteFinishedOutbox(beforeMs: number): Promise<number> {
    const rows = await this.#sql.query<{ id: string }>(
      `DELETE FROM push_outbox
       WHERE status IN ('sent', 'failed')
         AND COALESCE(finished_at, created_at) < $1
       RETURNING id`,
      [new Date(beforeMs)],
    );
    return rows.length;
  }

  /**
   * Read current delivered JSON, union `endpoints`, write back.
   *
   * @param id - Outbox id.
   * @param endpoints - Newly delivered endpoint URLs.
   */
  async recordDelivered(id: string, endpoints: readonly string[]): Promise<void> {
    const rows = await this.#sql.query<{ delivered_endpoints: string | null }>(
      `SELECT delivered_endpoints FROM push_outbox WHERE id = $1`,
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      return;
    }
    const next = unionDeliveredEndpoints(
      parseDeliveredEndpoints(existing.delivered_endpoints),
      endpoints,
    );
    await this.#sql.execute(`UPDATE push_outbox SET delivered_endpoints = $1 WHERE id = $2`, [
      JSON.stringify(next),
      id,
    ]);
  }
}
