/**
 * Persistence for the public member forum.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { unsignedNostrDefaults, type MessageRow, type NostrPublishState } from '@/lib/message';
import { normalizeSignedEvent } from '@/lib/nostr/publish';

/**
 * Persistence port for forum messages.
 */
export interface MessageStore {
  /**
   * Newest messages first (`createdAt` desc, then `id` desc), capped at
   * `limit`.
   *
   * @param limit - Maximum rows to return.
   * @returns Message rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<MessageRow[]>;

  /**
   * Persist a new message row.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time).
   * @returns The stored row (a copy is fine).
   */
  create(row: MessageRow): Promise<MessageRow>;

  /** One row by id, or `undefined`. */
  getById(id: string): Promise<MessageRow | undefined>;

  /** One row by Nostr event id, or `undefined`. */
  getByEventId(eventId: string): Promise<MessageRow | undefined>;

  /**
   * Claim unsigned pending rows (`eventId` null) for signing.
   *
   * @param limit - Max rows.
   * @param nowMs - Clock.
   * @param leaseMs - Lease duration.
   */
  claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]>;

  /**
   * Claim signed-but-unpublished pending rows for fan-out.
   */
  claimUnpublished(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]>;

  /**
   * Pending rows that already have an `eventId` (no lease).
   *
   * @param limit - Max rows.
   */
  listPendingSigned(limit: number): Promise<MessageRow[]>;

  /**
   * Drop the stored kind:1 so the worker can re-sign (still pending).
   *
   * @param id - Message id.
   */
  clearSignedEvent(id: string): Promise<void>;

  /** Persist a signed event id + JSON. Returns false on event-id collision. */
  updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean>;

  /** Mark space ACK (park) or published after public quorum. */
  updatePublishState(id: string, state: NostrPublishState, epoch: string | null): Promise<void>;

  /** Add validated zap sats (idempotent receipt id is the caller's job). */
  addSats(id: string, extraSats: number): Promise<void>;

  /**
   * Persist a zap receipt once and add its sats to the message.
   *
   * @param receiptEventId - Kind:9735 event id (unique).
   * @param messageId - Forum row to credit.
   * @param sats - Whole sats to add.
   * @returns `true` when the receipt was new and sats were added; `false` on
   *   duplicate receipt id (no second add).
   */
  recordZapReceipt(receiptEventId: string, messageId: string, sats: number): Promise<boolean>;
}

/** Idempotent DDL for the forum table (matches `docs/schema/message.sql`). */
export const MESSAGE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS event_id text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_publish_state text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_event jsonb`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS claimed_until timestamptz`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_first_attempt_at timestamptz`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_publish_epoch text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_attempts integer NOT NULL DEFAULT 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_event_id_uidx ON message (event_id) WHERE event_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS nostr_zap_receipt (
  event_id text PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message (id),
  sats bigint NOT NULL
)`,
];

/**
 * Apply {@link MESSAGE_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateMessageSchema(sql: SqlClient): Promise<void> {
  for (const statement of MESSAGE_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link MessageStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryMessageStore implements MessageStore {
  readonly #rows: MessageRow[];
  readonly #receiptIds = new Set<string>();

  /**
   * @param seed - Optional seed rows; copied into private storage.
   */
  constructor(seed: readonly MessageRow[] = []) {
    this.#rows = seed.map((row) => copyRow(row));
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   */
  listLatest(limit: number): Promise<MessageRow[]> {
    const sorted = [...this.#rows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyRow(row)));
  }

  /**
   * Append a copy of `row` and return a copy.
   *
   * @param row - Message to store.
   * @returns A copy of the stored row.
   */
  create(row: MessageRow): Promise<MessageRow> {
    const stored = copyRow({ ...unsignedNostrDefaults(), ...row });
    this.#rows.push(stored);
    return Promise.resolve(copyRow(stored));
  }

  getById(id: string): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.id === id);
    return Promise.resolve(row === undefined ? undefined : copyRow(row));
  }

  getByEventId(eventId: string): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.eventId === eventId);
    return Promise.resolve(row === undefined ? undefined : copyRow(row));
  }

  claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]> {
    return Promise.resolve(this.#claim((row) => row.eventId === null, limit, nowMs, leaseMs));
  }

  claimUnpublished(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]> {
    return Promise.resolve(
      this.#claim(
        (row) => row.eventId !== null && row.nostrPublishState === 'pending',
        limit,
        nowMs,
        leaseMs,
      ),
    );
  }

  listPendingSigned(limit: number): Promise<MessageRow[]> {
    const rows = this.#rows
      .filter((row) => row.eventId !== null && row.nostrPublishState === 'pending')
      .slice(0, limit)
      .map((row) => copyRow(row));
    return Promise.resolve(rows);
  }

  clearSignedEvent(id: string): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (row !== undefined && row.nostrPublishState === 'pending') {
      row.eventId = null;
      row.nostrEvent = null;
      row.claimedUntil = null;
    }
    return Promise.resolve();
  }

  updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.#rows.some((row) => row.eventId === eventId && row.id !== id)) {
      return Promise.resolve(false);
    }
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    row.eventId = eventId;
    row.nostrEvent = { ...nostrEvent };
    return Promise.resolve(true);
  }

  updatePublishState(id: string, state: NostrPublishState, epoch: string | null): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (row !== undefined) {
      row.nostrPublishState = state;
      row.nostrPublishEpoch = epoch;
    }
    return Promise.resolve();
  }

  addSats(id: string, extraSats: number): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (row !== undefined) {
      row.sats += extraSats;
    }
    return Promise.resolve();
  }

  async recordZapReceipt(
    receiptEventId: string,
    messageId: string,
    sats: number,
  ): Promise<boolean> {
    if (this.#receiptIds.has(receiptEventId)) {
      return false;
    }
    this.#receiptIds.add(receiptEventId);
    await this.addSats(messageId, sats);
    return true;
  }

  #claim(
    predicate: (row: MessageRow) => boolean,
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): MessageRow[] {
    const claimed: MessageRow[] = [];
    for (const row of this.#rows) {
      if (claimed.length >= limit) {
        break;
      }
      if (!predicate(row)) {
        continue;
      }
      if (row.claimedUntil !== null && row.claimedUntil > nowMs) {
        continue;
      }
      row.claimedUntil = nowMs + leaseMs;
      claimed.push(copyRow(row));
    }
    return claimed;
  }
}

/** Copy a row so callers cannot mutate store internals. */
function copyRow(row: MessageRow): MessageRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    nostrEvent: row.nostrEvent === null ? null : { ...row.nostrEvent },
  };
}

/** Row shape selected from `message`. */
interface MessageSqlRow {
  id: string;
  account_id: string;
  name: string;
  text: string;
  created_at: Date | string;
  event_id?: string | null;
  nostr_publish_state?: string | null;
  sats?: string | number | null;
  nostr_event?: Record<string, unknown> | string | null;
  claimed_until?: Date | string | null;
  nostr_first_attempt_at?: Date | string | null;
  nostr_publish_epoch?: string | null;
  nostr_attempts?: number | null;
}

function optionalDate(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Map a SQL row onto {@link MessageRow}. Unexported. */
function mapMessageRow(row: MessageSqlRow): MessageRow {
  const defaults = unsignedNostrDefaults();
  const state = row.nostr_publish_state;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    eventId: row.event_id ?? defaults.eventId,
    nostrPublishState:
      state === 'pending' || state === 'published' || state === 'failed'
        ? state
        : defaults.nostrPublishState,
    sats: Number(row.sats ?? defaults.sats),
    nostrEvent: normalizeSignedEvent(row.nostr_event) ?? null,
    claimedUntil: optionalDate(row.claimed_until),
    nostrFirstAttemptAt: optionalDate(row.nostr_first_attempt_at),
    nostrPublishEpoch: row.nostr_publish_epoch ?? defaults.nostrPublishEpoch,
    nostrAttempts: row.nostr_attempts ?? defaults.nostrAttempts,
  };
}

/**
 * Durable {@link MessageStore} backed by Postgres.
 */
export class PostgresMessageStore implements MessageStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Newest-first list from `message`, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts
       FROM message ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Insert `row` into `message` and return it.
   *
   * @param row - Fully formed message.
   * @returns The input row after a successful insert (a copy).
   */
  async create(row: MessageRow): Promise<MessageRow> {
    const stored = copyRow({ ...unsignedNostrDefaults(), ...row });
    await this.#sql.execute(
      `INSERT INTO message (id, account_id, name, text, created_at, nostr_publish_state, sats)
       VALUES ($1,$2,$3,$4,$5,'pending',0)`,
      [stored.id, stored.accountId, stored.name, stored.text, stored.createdAt],
    );
    return stored;
  }

  async getById(id: string): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts
       FROM message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async getByEventId(eventId: string): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts
       FROM message WHERE event_id = $1`,
      [eventId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]> {
    const until = new Date(nowMs + leaseMs);
    const rows = await this.#sql.query<MessageSqlRow>(
      `UPDATE message SET claimed_until = $1
       WHERE id IN (
         SELECT id FROM message
         WHERE event_id IS NULL AND nostr_publish_state = 'pending'
           AND (claimed_until IS NULL OR claimed_until < $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
                 nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async claimUnpublished(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]> {
    const until = new Date(nowMs + leaseMs);
    const rows = await this.#sql.query<MessageSqlRow>(
      `UPDATE message SET claimed_until = $1
       WHERE id IN (
         SELECT id FROM message
         WHERE event_id IS NOT NULL AND nostr_publish_state = 'pending'
           AND (claimed_until IS NULL OR claimed_until < $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
                 nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async listPendingSigned(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts
       FROM message
       WHERE event_id IS NOT NULL AND nostr_publish_state = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async clearSignedEvent(id: string): Promise<void> {
    await this.#sql.execute(
      `UPDATE message SET event_id = NULL, nostr_event = NULL, claimed_until = NULL
       WHERE id = $1 AND nostr_publish_state = 'pending'`,
      [id],
    );
  }

  async updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const rows = await this.#sql.query<{ id: string }>(
        `UPDATE message SET event_id = $2, nostr_event = $3::jsonb WHERE id = $1 RETURNING id`,
        [id, eventId, JSON.stringify(nostrEvent)],
      );
      return rows[0] !== undefined;
      /* v8 ignore next 3 -- unique_violation on event_id */
    } catch {
      return false;
    }
  }

  async updatePublishState(
    id: string,
    state: NostrPublishState,
    epoch: string | null,
  ): Promise<void> {
    await this.#sql.execute(
      `UPDATE message SET nostr_publish_state = $2, nostr_publish_epoch = $3 WHERE id = $1`,
      [id, state, epoch],
    );
  }

  async addSats(id: string, extraSats: number): Promise<void> {
    await this.#sql.execute(`UPDATE message SET sats = sats + $2 WHERE id = $1`, [id, extraSats]);
  }

  async recordZapReceipt(
    receiptEventId: string,
    messageId: string,
    sats: number,
  ): Promise<boolean> {
    const inserted = await this.#sql.query<{ event_id: string }>(
      `WITH inserted AS (
         INSERT INTO nostr_zap_receipt (event_id, message_id, sats)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id, message_id, sats
       )
       UPDATE message SET sats = sats + inserted.sats
       FROM inserted
       WHERE message.id = inserted.message_id
       RETURNING inserted.event_id`,
      [receiptEventId, messageId, sats],
    );
    return inserted[0] !== undefined;
  }
}
