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
import { kind1ContentWithHashtags } from '@/lib/nostr/event';
import { normalizeSignedEvent } from '@/lib/nostr/publish';

function kind1MissingPhotoUrl(event: Record<string, unknown> | null, messageId: string): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return typeof content !== 'string' || !content.includes(`/messages/${messageId}/photo.`);
}

function kind1MissingHashtags(event: Record<string, unknown> | null): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return typeof content !== 'string' || kind1ContentWithHashtags(content) !== content;
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
   * Published rows with a photo whose kind:1 content lacks the public photo URL.
   * `sats = 0` only (zapped rows keep their event id). Pending rows are left
   * for fan-out — resetting them renews the sign lease and they never EVENT.
   * Oldest `createdAt` then `id` first.
   *
   * @param limit - Max rows.
   */
  listSignedMissingPhoto(limit: number): Promise<MessageRow[]>;

  /**
   * Published rows whose kind:1 content lacks a `#21gifts` or `#bitcoin` token
   * (case-insensitive; next character must not be `[A-Za-z0-9_]`, so
   * `#bitcoiners` still lacks `#bitcoin`). `sats = 0` only (zapped rows keep
   * their event id). Pending rows are left for fan-out — resetting them
   * renews the sign lease and they never EVENT. Oldest `createdAt` then `id`
   * first. Includes `nostrEvent === null` and non-string content.
   *
   * @param limit - Max rows.
   */
  listSignedMissingHashtags(limit: number): Promise<MessageRow[]>;

  /**
   * Clear the signed event and park the row `pending` so it is signed again.
   * No-op unless `eventId` still matches `expectedEventId` and `sats` is 0.
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

  /** Append one POST /messages/:id/invoice attempt (success or failure). */
  recordInvoiceAttempt(row: MessageInvoiceAttempt): Promise<void>;

  /** Newest invoice attempts first, capped at `limit`. */
  listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]>;

  /** Append one kind:9735 ingest decision (indexed or rejected). */
  recordZapIngest(row: ZapIngestRow): Promise<void>;

  /** Newest zap ingest rows first, capped at `limit`. */
  listZapIngests(limit: number): Promise<ZapIngestRow[]>;
}

/** Outcome of POST /messages/:id/invoice after auth. */
export type MessageInvoiceResult =
  | 'ok'
  | 'noZap'
  | 'not_zap'
  | 'unreachable'
  | 'no_event'
  | 'no_author'
  | 'no_key'
  | 'sign_failed'
  | 'rate_limited'
  | 'bad_body'
  | 'not_found';

/** One persisted invoice attempt for operator debug. */
export interface MessageInvoiceAttempt {
  id: string;
  createdAt: Date;
  messageId: string;
  payerAccountId: string;
  authorAccountId: string;
  amountSats: number;
  lightningAddress: string | null;
  zapRequest: Record<string, unknown> | null;
  result: MessageInvoiceResult;
  httpStatus: number;
  pr: string | null;
  paymentHash: string | null;
  description: string | null;
  descriptionHash: string | null;
  isNip57Invoice: boolean;
}

/** One persisted kind:9735 ingest decision for operator debug. */
export interface ZapIngestRow {
  id: string;
  createdAt: Date;
  receiptId: string;
  noteEventId: string | null;
  messageId: string | null;
  outcome: 'indexed' | 'rejected';
  reason: string | null;
  amountSats: number | null;
  receiptPubkey: string | null;
  receipt: Record<string, unknown>;
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
  `CREATE TABLE IF NOT EXISTS message_invoice (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  message_id uuid NOT NULL,
  payer_account_id uuid NOT NULL,
  author_account_id uuid NOT NULL,
  amount_sats bigint NOT NULL,
  lightning_address text,
  zap_request jsonb,
  result text NOT NULL,
  http_status integer NOT NULL,
  pr text,
  payment_hash text,
  description text,
  description_hash text,
  is_nip57_invoice boolean NOT NULL DEFAULT false
)`,
  `CREATE INDEX IF NOT EXISTS message_invoice_created_at_idx
  ON message_invoice (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS message_invoice_message_id_idx
  ON message_invoice (message_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS nostr_zap_ingest (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  receipt_id text NOT NULL,
  note_event_id text,
  message_id uuid,
  outcome text NOT NULL,
  reason text,
  amount_sats bigint,
  receipt_pubkey text,
  receipt jsonb NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS nostr_zap_ingest_receipt_id_idx
  ON nostr_zap_ingest (receipt_id)`,
  `CREATE INDEX IF NOT EXISTS nostr_zap_ingest_created_at_idx
  ON nostr_zap_ingest (created_at DESC, id DESC)`,
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

/** Copy an invoice attempt so callers cannot mutate store internals. */
function copyInvoiceAttempt(row: MessageInvoiceAttempt): MessageInvoiceAttempt {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    zapRequest: row.zapRequest === null ? null : { ...row.zapRequest },
  };
}

/** Copy a zap ingest row so callers cannot mutate store internals. */
function copyZapIngest(row: ZapIngestRow): ZapIngestRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    receipt: { ...row.receipt },
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
  readonly #invoiceAttempts: MessageInvoiceAttempt[] = [];
  readonly #zapIngests: ZapIngestRow[] = [];

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
    return Promise.resolve(
      this.#claim(
        (row) => row.eventId === null && row.nostrPublishState === 'pending',
        limit,
        nowMs,
        leaseMs,
      ),
    );
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
          row.eventId !== null &&
          row.hasPhoto &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          kind1MissingPhotoUrl(row.nostrEvent, row.id),
      )
      .sort((left, right) => {
        const byTime = left.createdAt.getTime() - right.createdAt.getTime();
        return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((row) => copyRow(row));
    return Promise.resolve(rows);
  }

  listSignedMissingHashtags(limit: number): Promise<MessageRow[]> {
    const rows = this.#rows
      .filter(
        (row) =>
          row.eventId !== null &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          kind1MissingHashtags(row.nostrEvent),
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
    if (row !== undefined && row.eventId === expectedEventId && row.sats === 0) {
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

  recordInvoiceAttempt(row: MessageInvoiceAttempt): Promise<void> {
    this.#invoiceAttempts.push(copyInvoiceAttempt(row));
    return Promise.resolve();
  }

  listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]> {
    const sorted = [...this.#invoiceAttempts].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyInvoiceAttempt(row)));
  }

  recordZapIngest(row: ZapIngestRow): Promise<void> {
    this.#zapIngests.push(copyZapIngest(row));
    return Promise.resolve();
  }

  listZapIngests(limit: number): Promise<ZapIngestRow[]> {
    const sorted = [...this.#zapIngests].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => copyZapIngest(row)));
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
           AND (claimed_until IS NULL OR claimed_until <= $2)
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
           AND (claimed_until IS NULL OR claimed_until <= $2)
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
       WHERE event_id IS NOT NULL AND photo IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND (
           nostr_event IS NULL
           OR COALESCE(nostr_event->>'content', '') NOT LIKE '%/messages/' || id::text || '/photo.%'
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async listSignedMissingHashtags(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE event_id IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND (
           nostr_event IS NULL
           OR jsonb_typeof(nostr_event->'content') IS DISTINCT FROM 'string'
           OR NOT (LOWER(COALESCE(nostr_event->>'content', '')) ~ '#21gifts([^a-z0-9_]|$)')
           OR NOT (LOWER(COALESCE(nostr_event->>'content', '')) ~ '#bitcoin([^a-z0-9_]|$)')
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
       WHERE id = $1 AND event_id IS NOT DISTINCT FROM $2 AND sats = 0`,
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

  async recordInvoiceAttempt(row: MessageInvoiceAttempt): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO message_invoice (
         id, created_at, message_id, payer_account_id, author_account_id,
         amount_sats, lightning_address, zap_request, result, http_status,
         pr, payment_hash, description, description_hash, is_nip57_invoice
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15
       )`,
      [
        row.id,
        row.createdAt,
        row.messageId,
        row.payerAccountId,
        row.authorAccountId,
        row.amountSats,
        row.lightningAddress,
        row.zapRequest === null ? null : JSON.stringify(row.zapRequest),
        row.result,
        row.httpStatus,
        row.pr,
        row.paymentHash,
        row.description,
        row.descriptionHash,
        row.isNip57Invoice,
      ],
    );
  }

  async listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice
       FROM message_invoice
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapInvoiceAttemptRow(row));
  }

  async recordZapIngest(row: ZapIngestRow): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO nostr_zap_ingest (
         id, created_at, receipt_id, note_event_id, message_id,
         outcome, reason, amount_sats, receipt_pubkey, receipt
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb
       )`,
      [
        row.id,
        row.createdAt,
        row.receiptId,
        row.noteEventId,
        row.messageId,
        row.outcome,
        row.reason,
        row.amountSats,
        row.receiptPubkey,
        JSON.stringify(row.receipt),
      ],
    );
  }

  async listZapIngests(limit: number): Promise<ZapIngestRow[]> {
    const rows = await this.#sql.query<ZapIngestSqlRow>(
      `SELECT id, created_at, receipt_id, note_event_id, message_id,
              outcome, reason, amount_sats, receipt_pubkey, receipt
       FROM nostr_zap_ingest
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapZapIngestRow(row));
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

/** SQL row shape for `message_invoice`. */
interface MessageInvoiceSqlRow {
  id: string;
  created_at: Date | string;
  message_id: string;
  payer_account_id: string;
  author_account_id: string;
  amount_sats: string | number;
  lightning_address: string | null;
  zap_request: Record<string, unknown> | string | null;
  result: string;
  http_status: number;
  pr: string | null;
  payment_hash: string | null;
  description: string | null;
  description_hash: string | null;
  is_nip57_invoice: boolean | number | string | null;
}

/** SQL row shape for `nostr_zap_ingest`. */
interface ZapIngestSqlRow {
  id: string;
  created_at: Date | string;
  receipt_id: string;
  note_event_id: string | null;
  message_id: string | null;
  outcome: string;
  reason: string | null;
  amount_sats: string | number | null;
  receipt_pubkey: string | null;
  receipt: Record<string, unknown> | string;
}

/** Parse jsonb that may arrive as object or JSON string. */
function parseJsonObject(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return { ...value };
}

/** Map a `message_invoice` SQL row. */
function mapInvoiceAttemptRow(row: MessageInvoiceSqlRow): MessageInvoiceAttempt {
  const result = row.result as MessageInvoiceResult;
  return {
    id: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    messageId: row.message_id,
    payerAccountId: row.payer_account_id,
    authorAccountId: row.author_account_id,
    amountSats: Number(row.amount_sats),
    lightningAddress: row.lightning_address,
    zapRequest: parseJsonObject(row.zap_request),
    result,
    httpStatus: row.http_status,
    pr: row.pr,
    paymentHash: row.payment_hash,
    description: row.description,
    descriptionHash: row.description_hash,
    isNip57Invoice: Boolean(row.is_nip57_invoice),
  };
}

/** Map a `nostr_zap_ingest` SQL row. */
function mapZapIngestRow(row: ZapIngestSqlRow): ZapIngestRow {
  const receipt = parseJsonObject(row.receipt) ?? {};
  return {
    id: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    receiptId: row.receipt_id,
    noteEventId: row.note_event_id,
    messageId: row.message_id,
    outcome: row.outcome === 'indexed' ? 'indexed' : 'rejected',
    reason: row.reason,
    amountSats: row.amount_sats === null ? null : Number(row.amount_sats),
    receiptPubkey: row.receipt_pubkey,
    receipt,
  };
}
