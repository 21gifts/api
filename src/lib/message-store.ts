/**
 * Persistence for the public member forum.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. List queries never select the `photo` bytea column —
 * only `(photo IS NOT NULL) AS has_photo`. Bytes are loaded via {@link MessageStore.getPhoto}.
 */

import type { SqlClient } from '@/lib/auth/sql';
import {
  unsignedNostrDefaults,
  type ForumPhoto,
  type ForumPhotoContentType,
  type MessageRow,
  type NostrPublishState,
} from '@/lib/message';
import { normalizeSignedEvent } from '@/lib/nostr/publish';

function kind1MissingPhotoUrl(event: Record<string, unknown> | null, messageId: string): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return typeof content !== 'string' || !content.includes(`/messages/${messageId}/photo`);
}

function pendingKind1LacksBitcoinTag(event: Record<string, unknown> | null): boolean {
  if (event === null) {
    return true;
  }
  const tags = event['tags'];
  if (!Array.isArray(tags)) {
    return true;
  }
  return !tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === 'bitcoin');
}

/**
 * Persistence port for forum messages.
 */
export interface MessageStore {
  /**
   * Newest messages first (`createdAt` desc, then `id` desc), capped at
   * `limit`. Rows include `hasPhoto` but never photo bytes.
   *
   * @param limit - Maximum rows to return.
   * @returns Message rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<MessageRow[]>;

  /**
   * Persist a new message row and optional photo.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time, hasPhoto).
   * @param photo - Optional decoded photo (copied into storage).
   * @returns The stored row (a copy is fine) with `hasPhoto` set from `photo`.
   */
  create(row: MessageRow, photo?: ForumPhoto): Promise<MessageRow>;

  /**
   * Load photo bytes for a message id.
   *
   * @param id - Message id.
   * @returns A copy of the photo, or `null` when missing / no photo.
   */
  getPhoto(id: string): Promise<ForumPhoto | null>;

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
   * Pending signed rows whose stored kind:1 lacks `t=bitcoin` (no lease).
   * Oldest `createdAt` then `id` first. Includes `nostrEvent === null`.
   *
   * @param limit - Max rows.
   */
  listPendingSigned(limit: number): Promise<MessageRow[]>;

  /**
   * Drop the stored kind:1 so the worker can re-sign (still pending).
   * No-op unless `eventId` still matches `expectedEventId`.
   *
   * @param id - Message id.
   * @param expectedEventId - Event id observed when the row was listed.
   */
  clearSignedEvent(id: string, expectedEventId: string | null): Promise<void>;

  /**
   * Signed rows with a photo whose kind:1 content lacks the public photo URL.
   * Any publish state. Oldest `createdAt` then `id` first.
   *
   * @param limit - Max rows.
   */
  listSignedMissingPhoto(limit: number): Promise<MessageRow[]>;

  /**
   * Clear the signed event and park the row `pending` so it is signed again.
   * No-op unless `eventId` still matches `expectedEventId`.
   *
   * @param id - Message id.
   * @param expectedEventId - Event id observed when the row was listed.
   */
  resetSignedEvent(id: string, expectedEventId: string | null): Promise<void>;

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
  photo bytea,
  photo_content_type text,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS photo bytea`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS photo_content_type text`,
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

/** Copy a {@link ForumPhoto} so callers cannot mutate store buffers. */
function copyPhoto(photo: ForumPhoto): ForumPhoto {
  return { contentType: photo.contentType, bytes: photo.bytes.slice() };
}

/** Copy a row so callers cannot mutate store internals. */
function copyRow(row: MessageRow): MessageRow {
  return {
    ...row,
    hasPhoto: row.hasPhoto === true,
    createdAt: new Date(row.createdAt.getTime()),
    nostrEvent: row.nostrEvent === null ? null : { ...row.nostrEvent },
  };
}

/**
 * Process-local {@link MessageStore}. Used in tests and when no database URL
 * is configured — the process still boots. Photos live in a private map, not
 * on listed rows.
 */
export class InMemoryMessageStore implements MessageStore {
  readonly #rows: MessageRow[];
  readonly #receiptIds = new Set<string>();
  readonly #photos = new Map<string, ForumPhoto>();

  /**
   * @param seed - Optional seed rows; copied into private storage. Seeded rows
   * default to `hasPhoto: false` when omitted on the input object.
   */
  constructor(seed: readonly MessageRow[] = []) {
    this.#rows = seed.map((row) => copyRow(row));
  }

  /**
   * Newest-first copy of stored rows, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   * Listed objects never expose photo bytes.
   */
  listLatest(limit: number): Promise<MessageRow[]> {
    const sorted = [...this.#rows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(
      sorted.slice(0, limit).map((row) => {
        const copy = copyRow(row);
        copy.hasPhoto = this.#photos.has(row.id) || row.hasPhoto === true;
        return copy;
      }),
    );
  }

  /**
   * Append a copy of `row` and optional photo; return a copy.
   *
   * @param row - Message to store.
   * @param photo - Optional photo (bytes copied).
   * @returns A copy of the stored row with `hasPhoto` from `photo`.
   */
  create(row: MessageRow, photo?: ForumPhoto): Promise<MessageRow> {
    const hasPhoto = photo !== undefined;
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
    });
    this.#rows.push(stored);
    if (photo !== undefined) {
      this.#photos.set(stored.id, copyPhoto(photo));
    }
    return Promise.resolve(copyRow(stored));
  }

  /**
   * Return a copy of the photo for `id`, or `null`.
   *
   * @param id - Message id.
   * @returns Photo copy or `null`.
   */
  getPhoto(id: string): Promise<ForumPhoto | null> {
    const photo = this.#photos.get(id);
    return Promise.resolve(photo === undefined ? null : copyPhoto(photo));
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
      .filter(
        (row) =>
          row.eventId !== null &&
          row.nostrPublishState === 'pending' &&
          pendingKind1LacksBitcoinTag(row.nostrEvent),
      )
      .sort((left, right) => {
        const byTime = left.createdAt.getTime() - right.createdAt.getTime();
        return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((row) => copyRow(row));
    return Promise.resolve(rows);
  }

  clearSignedEvent(id: string, expectedEventId: string | null): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (
      row !== undefined &&
      row.nostrPublishState === 'pending' &&
      row.eventId === expectedEventId
    ) {
      row.eventId = null;
      row.nostrEvent = null;
      row.claimedUntil = null;
    }
    return Promise.resolve();
  }

  listSignedMissingPhoto(limit: number): Promise<MessageRow[]> {
    const rows = this.#rows
      .filter(
        (row) =>
          row.eventId !== null && row.hasPhoto && kind1MissingPhotoUrl(row.nostrEvent, row.id),
      )
      .sort((left, right) => {
        const byTime = left.createdAt.getTime() - right.createdAt.getTime();
        return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((row) => copyRow(row));
    return Promise.resolve(rows);
  }

  resetSignedEvent(id: string, expectedEventId: string | null): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (row !== undefined && row.eventId === expectedEventId) {
      row.eventId = null;
      row.nostrEvent = null;
      row.claimedUntil = null;
      row.nostrPublishState = 'pending';
      row.nostrPublishEpoch = null;
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

/** Row shape selected from `message` for list (no photo bytes). */
interface MessageSqlRow {
  id: string;
  account_id: string;
  name: string;
  text: string;
  created_at: Date | string;
  has_photo: boolean | number | string | null;
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

/** Row shape for `getPhoto`. */
interface MessagePhotoSqlRow {
  photo: Uint8Array | Buffer | number[] | null;
  photo_content_type: string | null;
}

const FORUM_PHOTO_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Map a SQL list row onto {@link MessageRow}. Unexported. */
function mapMessageRow(row: MessageSqlRow): MessageRow {
  const defaults = unsignedNostrDefaults();
  const state = row.nostr_publish_state;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    hasPhoto: Boolean(row.has_photo),
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

/** Coerce Postgres bytea drivers into a fresh {@link Uint8Array}. */
function toUint8Array(value: Uint8Array | Buffer | number[]): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  return Uint8Array.from(value);
}

/** Shared SELECT list: Nostr columns plus has_photo, never photo bytea. */
const MESSAGE_SELECT_COLUMNS = `id, account_id, name, text, created_at,
              (photo IS NOT NULL) AS has_photo,
              event_id, nostr_publish_state, sats,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts`;

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
   * Selects `(photo IS NOT NULL) AS has_photo` — never the `photo` bytea column.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listLatest(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Insert `row` (and optional photo) into `message` and return it.
   *
   * @param row - Fully formed message.
   * @param photo - Optional decoded photo.
   * @returns The stored row after a successful insert (a copy).
   */
  async create(row: MessageRow, photo?: ForumPhoto): Promise<MessageRow> {
    const hasPhoto = photo !== undefined;
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
    });
    await this.#sql.execute(
      `INSERT INTO message (id, account_id, name, text, photo, photo_content_type, created_at, nostr_publish_state, sats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0)`,
      [
        stored.id,
        stored.accountId,
        stored.name,
        stored.text,
        photo === undefined ? null : photo.bytes,
        photo === undefined ? null : photo.contentType,
        stored.createdAt,
      ],
    );
    return stored;
  }

  async getById(id: string): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async getByEventId(eventId: string): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
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
       RETURNING ${MESSAGE_SELECT_COLUMNS}`,
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
       RETURNING ${MESSAGE_SELECT_COLUMNS}`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async listPendingSigned(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE event_id IS NOT NULL AND nostr_publish_state = 'pending'
         AND (
           nostr_event IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(COALESCE(nostr_event->'tags', 'null'::jsonb)) = 'array'
                 THEN nostr_event->'tags'
                 ELSE '[]'::jsonb
               END
             ) AS tag
             WHERE tag->>0 = 't' AND tag->>1 = 'bitcoin'
           )
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async clearSignedEvent(id: string, expectedEventId: string | null): Promise<void> {
    await this.#sql.execute(
      `UPDATE message SET event_id = NULL, nostr_event = NULL, claimed_until = NULL
       WHERE id = $1 AND nostr_publish_state = 'pending' AND event_id IS NOT DISTINCT FROM $2`,
      [id, expectedEventId],
    );
  }

  async listSignedMissingPhoto(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE event_id IS NOT NULL AND photo IS NOT NULL
         AND (
           nostr_event IS NULL
           OR COALESCE(nostr_event->>'content', '') NOT LIKE '%/messages/' || id::text || '/photo%'
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async resetSignedEvent(id: string, expectedEventId: string | null): Promise<void> {
    await this.#sql.execute(
      `UPDATE message SET event_id = NULL, nostr_event = NULL, claimed_until = NULL,
         nostr_publish_state = 'pending', nostr_publish_epoch = NULL
       WHERE id = $1 AND event_id IS NOT DISTINCT FROM $2`,
      [id, expectedEventId],
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
       UPDATE message SET sats = message.sats + inserted.sats
       FROM inserted
       WHERE message.id = inserted.message_id
       RETURNING inserted.event_id`,
      [receiptEventId, messageId, sats],
    );
    return inserted[0] !== undefined;
  }

  /**
   * Load photo bytes for a message id.
   *
   * @param id - Message id (`$1`).
   * @returns Photo copy, or `null` when missing / null photo / bad type.
   */
  async getPhoto(id: string): Promise<ForumPhoto | null> {
    const rows = await this.#sql.query<MessagePhotoSqlRow>(
      `SELECT photo, photo_content_type FROM message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.photo === null || row.photo_content_type === null) {
      return null;
    }
    if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
      return null;
    }
    return {
      contentType: row.photo_content_type as ForumPhotoContentType,
      bytes: toUint8Array(row.photo),
    };
  }
}
