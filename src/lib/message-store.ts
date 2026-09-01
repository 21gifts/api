/**
 * Persistence for the public member forum.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. List queries never select the `photo` bytea column —
 * only `(photo IS NOT NULL) AS has_photo`. Bytes are loaded via {@link MessageStore.getPhoto}.
 * `video_content_type` (MIME) lives in Postgres; video bytes live on disk under
 * `MEDIA_DIR`, not as bytea.
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
import {
  removeForumVideo,
  writeForumVideo,
  type ForumVideo,
  type ForumVideoContentType,
} from '@/lib/video';

function kind1MissingPhotoUrl(event: Record<string, unknown> | null, messageId: string): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return typeof content !== 'string' || !content.includes(`/messages/${messageId}/photo.`);
}

function kind1MissingVideoUrl(event: Record<string, unknown> | null, messageId: string): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return typeof content !== 'string' || !content.includes(`/messages/${messageId}/video.`);
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

/** Top-level list row with computed reply count. */
export interface MessageListRow extends MessageRow {
  /** Direct children with this note as `parentId`. */
  replyCount: number;
}

/**
 * Persistence port for forum messages.
 */
export interface MessageStore {
  /**
   * Newest **top-level** notes first (`parent_id IS NULL`, `createdAt` desc,
   * then `id` desc), capped at `limit`. Each row includes `replyCount`.
   * Rows include `hasPhoto`, `hasVideo`, and `videoContentType` but never
   * photo or video bytes. Replies are never listed.
   *
   * @param limit - Maximum rows to return.
   * @returns Message list rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<MessageListRow[]>;

  /**
   * Oldest replies first for a parent note id.
   *
   * @param parentId - Parent message id.
   * @param limit - Maximum rows (default 200).
   * @returns Reply rows (caller-owned copies).
   */
  listReplies(parentId: string, limit?: number): Promise<MessageRow[]>;

  /**
   * Persist a new message row and optional photo and video.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time, hasPhoto).
   * @param photo - Optional decoded photo (copied into storage).
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @returns The stored row (a copy is fine) with `hasPhoto` set from `photo` and
   *   `hasVideo` / `videoContentType` from `video`.
   */
  create(row: MessageRow, photo?: ForumPhoto, video?: ForumVideo): Promise<MessageRow>;

  /**
   * Load photo bytes for a message id.
   *
   * @param id - Message id.
   * @returns A copy of the photo, or `null` when missing / no photo.
   */
  getPhoto(id: string): Promise<ForumPhoto | null>;

  /**
   * Delete a note, its direct replies, invoice attempts, zap receipts, photos,
   * and on-disk videos.
   *
   * @param id - Message id.
   * @returns True when a row was removed.
   */
  deleteById(id: string): Promise<boolean>;

  /** One row by id, or `undefined`. */
  getById(id: string): Promise<MessageRow | undefined>;

  /** One row by Nostr event id, or `undefined`. */
  getByEventId(eventId: string): Promise<MessageRow | undefined>;

  /**
   * Published note event ids (non-null) for inbound reply REQ, newest first.
   * Top-level only (`parentId` null).
   *
   * @param limit - Max ids.
   * @returns Event id strings.
   */
  listPublishedEventIds(limit: number): Promise<string[]>;

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
   * No-op unless `eventId` still matches `expectedEventId` and the note has
   * no child replies.
   *
   * @param id - Message id.
   * @param expectedEventId - Event id observed when the row was listed.
   */
  clearSignedEvent(id: string, expectedEventId: string | null): Promise<void>;

  /**
   * Published rows with a photo whose kind:1 content lacks the public photo URL.
   * Video rows (poster JPEG stored as `photo`) are excluded — their kind:1
   * content has `/video.`, not `/photo.`. Top-level only (`parentId` null) so
   * a reply with a photo is not re-signed (that would mint a new kind:1 id).
   * Parents that already have a child row are skipped for the same reason.
   * `sats = 0` only (zapped rows keep their event id). Pending rows are left
   * for fan-out — resetting them renews the sign lease and they never EVENT.
   * Oldest `createdAt` then `id` first.
   *
   * @param limit - Max rows.
   */
  listSignedMissingPhoto(limit: number): Promise<MessageRow[]>;

  /**
   * Published rows with a video whose kind:1 content lacks the public video URL.
   * Top-level only (`parentId` null) so a reply with a video is not re-signed.
   * Parents that already have a child row are skipped for the same reason.
   * `sats = 0` only (zapped rows keep their event id). Pending rows are left
   * for fan-out — resetting them renews the sign lease and they never EVENT.
   * Oldest `createdAt` then `id` first.
   *
   * @param limit - Max rows.
   */
  listSignedMissingVideo(limit: number): Promise<MessageRow[]>;

  /**
   * Published rows whose kind:1 content lacks a `#21gifts` or `#bitcoin` token
   * (case-insensitive; next character must not be `[A-Za-z0-9_]`, so
   * `#bitcoiners` still lacks `#bitcoin`). Top-level only (`parentId` null);
   * parents that already have a child row are skipped so NIP-10 `e` tags stay
   * valid. `sats = 0` only (zapped rows keep
   * their event id). Pending rows are left for fan-out — resetting them
   * renews the sign lease and they never EVENT. Oldest `createdAt` then `id`
   * first. Includes `nostrEvent === null` and non-string content.
   *
   * @param limit - Max rows.
   */
  listSignedMissingHashtags(limit: number): Promise<MessageRow[]>;

  /**
   * Clear the signed event and park the row `pending` so it is signed again.
   * No-op unless `eventId` still matches `expectedEventId`, `sats` is 0, and
   * the note has no child replies.
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
  /** Raw LNURL callback JSON when the HTTP body was JSON; else null. Never nsec. */
  lnurlResponse: Record<string, unknown> | null;
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
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS video_content_type text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_event_id_uidx ON message (event_id) WHERE event_id IS NOT NULL`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES message (id)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS author_pubkey text`,
  `ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC)`,
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
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb`,
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
    hasVideo: row.hasVideo === true,
    videoContentType: row.videoContentType ?? null,
    parentId: row.parentId ?? null,
    authorPubkey: row.authorPubkey ?? null,
    accountId: row.accountId ?? null,
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
    lnurlResponse: row.lnurlResponse === null ? null : { ...row.lnurlResponse },
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
   * Newest-first top-level notes only, capped at `limit`, with `replyCount`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of list row copies; mutating it does not change the store.
   * Listed objects include `hasVideo` / `videoContentType` but never expose
   * photo or video bytes (video lives on disk under `MEDIA_DIR`).
   */
  listLatest(limit: number): Promise<MessageListRow[]> {
    const topLevel = this.#rows.filter((row) => row.parentId === null);
    const sorted = [...topLevel].sort((a, b) => {
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
        copy.hasVideo = row.hasVideo === true;
        copy.videoContentType = row.videoContentType ?? null;
        const replyCount = this.#rows.filter((child) => child.parentId === row.id).length;
        return { ...copy, replyCount };
      }),
    );
  }

  /**
   * Oldest-first replies for `parentId`.
   *
   * @param parentId - Parent note id.
   * @param limit - Max rows (default 200).
   * @returns Reply row copies.
   */
  listReplies(parentId: string, limit: number = 200): Promise<MessageRow[]> {
    const replies = this.#rows
      .filter((row) => row.parentId === parentId)
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((row) => {
        const copy = copyRow(row);
        copy.hasPhoto = this.#photos.has(row.id) || row.hasPhoto === true;
        copy.hasVideo = row.hasVideo === true;
        copy.videoContentType = row.videoContentType ?? null;
        return copy;
      });
    return Promise.resolve(replies);
  }

  /**
   * Non-null event ids for published/pending signed notes (inbound reply REQ).
   * Top-level only (`parentId` null). Newest `createdAt` then `id` first.
   *
   * @param limit - Max ids.
   * @returns Event id list, newest first.
   */
  listPublishedEventIds(limit: number): Promise<string[]> {
    const ids = this.#rows
      .filter((row) => row.eventId !== null && row.parentId === null)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map((row) => row.eventId as string);
    return Promise.resolve(ids);
  }

  /**
   * Append a copy of `row` and optional photo and video; return a copy.
   * A non-null `eventId` that already exists returns the stored row (same
   * uniqueness as `message_event_id_uidx` and conversation `appendMessage`).
   *
   * @param row - Message to store.
   * @param photo - Optional photo (bytes copied).
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @returns A copy of the stored row with `hasPhoto` from `photo` and
   *   `hasVideo` / `videoContentType` from `video`.
   */
  async create(row: MessageRow, photo?: ForumPhoto, video?: ForumVideo): Promise<MessageRow> {
    if (row.eventId !== null) {
      const existing = this.#rows.find((item) => item.eventId === row.eventId);
      if (existing !== undefined) {
        return copyRow(existing);
      }
    }
    const hasPhoto = photo !== undefined;
    const hasVideo = video !== undefined;
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
      hasVideo,
      videoContentType: video === undefined ? null : video.contentType,
    });
    if (video !== undefined) {
      await writeForumVideo(stored.id, video);
    }
    this.#rows.push(stored);
    if (photo !== undefined) {
      this.#photos.set(stored.id, copyPhoto(photo));
    }
    return copyRow(stored);
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
        (row) => {
          if (row.eventId !== null || row.nostrPublishState !== 'pending') {
            return false;
          }
          // Damus inbound already has eventId; member replies wait for parent eventId.
          if (row.parentId !== null) {
            const parent = this.#rows.find((item) => item.id === row.parentId);
            if (parent === undefined || parent.eventId === null) {
              return false;
            }
          }
          // Skip Damus-only rows without an account (nothing to sign with).
          if (row.accountId === null) {
            return false;
          }
          return true;
        },
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
          row.parentId === null &&
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
      row.eventId === expectedEventId &&
      !this.#rows.some((child) => child.parentId === id)
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
          row.parentId === null &&
          row.eventId !== null &&
          row.hasPhoto &&
          row.hasVideo !== true &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          !this.#rows.some((child) => child.parentId === row.id) &&
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

  listSignedMissingVideo(limit: number): Promise<MessageRow[]> {
    const rows = this.#rows
      .filter(
        (row) =>
          row.parentId === null &&
          row.eventId !== null &&
          row.hasVideo === true &&
          row.videoContentType !== null &&
          row.videoContentType !== undefined &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          !this.#rows.some((child) => child.parentId === row.id) &&
          kind1MissingVideoUrl(row.nostrEvent, row.id),
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
          row.parentId === null &&
          row.eventId !== null &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          !this.#rows.some((child) => child.parentId === row.id) &&
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
    if (
      row !== undefined &&
      row.eventId === expectedEventId &&
      row.sats === 0 &&
      !this.#rows.some((child) => child.parentId === id)
    ) {
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

  async deleteById(id: string): Promise<boolean> {
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return false;
    }
    const childIds = this.#rows.filter((item) => item.parentId === id).map((item) => item.id);
    const ids = new Set([id, ...childIds]);
    for (const item of this.#rows) {
      if (!ids.has(item.id)) {
        continue;
      }
      if (item.hasVideo === true && item.videoContentType != null) {
        await removeForumVideo(item.id, item.videoContentType);
      }
      this.#photos.delete(item.id);
    }
    this.#rows.splice(0, this.#rows.length, ...this.#rows.filter((item) => !ids.has(item.id)));
    const kept = this.#invoiceAttempts.filter((item) => !ids.has(item.messageId));
    this.#invoiceAttempts.length = 0;
    this.#invoiceAttempts.push(...kept);
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
  account_id: string | null;
  name: string;
  text: string;
  created_at: Date | string;
  has_photo: boolean | number | string | null;
  video_content_type?: string | null;
  parent_id?: string | null;
  author_pubkey?: string | null;
  event_id?: string | null;
  nostr_publish_state?: string | null;
  sats?: string | number | null;
  nostr_event?: Record<string, unknown> | string | null;
  claimed_until?: Date | string | null;
  nostr_first_attempt_at?: Date | string | null;
  nostr_publish_epoch?: string | null;
  nostr_attempts?: number | null;
  reply_count?: string | number | null;
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

function parseVideoContentType(value: string | null | undefined): ForumVideoContentType | null {
  if (value === 'video/mp4' || value === 'video/webm' || value === 'video/quicktime') {
    return value;
  }
  return null;
}

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
    hasVideo:
      row.video_content_type !== null &&
      row.video_content_type !== undefined &&
      row.video_content_type !== '',
    videoContentType: parseVideoContentType(row.video_content_type),
    parentId: row.parent_id ?? null,
    authorPubkey: row.author_pubkey ?? null,
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
              video_content_type,
              parent_id, author_pubkey,
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
   * Newest-first top-level notes from `message`, capped at `limit`, with
   * `replyCount`. Selects `(photo IS NOT NULL) AS has_photo` and
   * `video_content_type` (`hasVideo` / `videoContentType`) — never the
   * `photo` bytea column; video bytes live on disk under `MEDIA_DIR`, not as
   * bytea. Replies (`parent_id IS NOT NULL`) are excluded.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped list rows.
   */
  async listLatest(limit: number): Promise<MessageListRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS},
              (SELECT COUNT(*)::int FROM message child WHERE child.parent_id = message.id) AS reply_count
       FROM message
       WHERE parent_id IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      ...mapMessageRow(row),
      replyCount: Number(row.reply_count ?? 0),
    }));
  }

  /**
   * Oldest-first replies for a parent note.
   *
   * @param parentId - Parent message id (`$1`).
   * @param limit - Max rows (`$2`, default 200).
   * @returns Mapped reply rows.
   */
  async listReplies(parentId: string, limit: number = 200): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [parentId, limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Non-null top-level event ids for inbound reply REQ.
   *
   * @param limit - Max ids (`$1`).
   * @returns Event id strings, newest first.
   */
  async listPublishedEventIds(limit: number): Promise<string[]> {
    const rows = await this.#sql.query<{ event_id: string }>(
      `SELECT event_id FROM message
       WHERE event_id IS NOT NULL AND parent_id IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.event_id);
  }

  /**
   * Insert `row` (and optional photo and video) into `message` and return it.
   *
   * @param row - Fully formed message.
   * @param photo - Optional decoded photo.
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @returns The stored row after a successful insert (a copy) with `hasPhoto`
   *   from `photo` and `hasVideo` / `videoContentType` from `video`. INSERT
   *   failure unlinks the video (`removeForumVideo`).
   */
  async create(row: MessageRow, photo?: ForumPhoto, video?: ForumVideo): Promise<MessageRow> {
    const hasPhoto = photo !== undefined;
    const hasVideo = video !== undefined;
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
      hasVideo,
      videoContentType: video === undefined ? null : video.contentType,
    });
    if (video !== undefined) {
      await writeForumVideo(stored.id, video);
    }
    try {
      await this.#sql.execute(
        `INSERT INTO message (
           id, account_id, name, text, photo, photo_content_type, video_content_type, created_at,
           nostr_publish_state, sats, parent_id, author_pubkey, event_id, nostr_event
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
         )`,
        [
          stored.id,
          stored.accountId,
          stored.name,
          stored.text,
          photo === undefined ? null : photo.bytes,
          photo === undefined ? null : photo.contentType,
          stored.videoContentType,
          stored.createdAt,
          stored.nostrPublishState,
          stored.sats,
          stored.parentId,
          stored.authorPubkey,
          stored.eventId,
          stored.nostrEvent === null ? null : JSON.stringify(stored.nostrEvent),
        ],
      );
    } catch (err) {
      if (video !== undefined) {
        await removeForumVideo(stored.id, video.contentType);
      }
      throw err;
    }
    return stored;
  }

  async deleteById(id: string): Promise<boolean> {
    const row = await this.getById(id);
    if (row === undefined) {
      return false;
    }
    const children = await this.#sql.query<{ id: string; video_content_type: string | null }>(
      `SELECT id, video_content_type FROM message WHERE parent_id = $1`,
      [id],
    );
    await this.#sql.execute(
      `DELETE FROM nostr_zap_receipt WHERE message_id = $1
       OR message_id IN (SELECT id FROM message WHERE parent_id = $1)`,
      [id],
    );
    await this.#sql.execute(
      `DELETE FROM message_invoice WHERE message_id = $1
       OR message_id IN (SELECT id FROM message WHERE parent_id = $1)`,
      [id],
    );
    await this.#sql.execute(`DELETE FROM message WHERE parent_id = $1`, [id]);
    await this.#sql.execute(`DELETE FROM message WHERE id = $1`, [id]);
    for (const child of children) {
      const mime = parseVideoContentType(child.video_content_type);
      if (mime !== null) {
        await removeForumVideo(child.id, mime);
      }
    }
    if (row.videoContentType != null) {
      await removeForumVideo(row.id, row.videoContentType);
    }
    return true;
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
         SELECT m.id FROM message m
         WHERE m.event_id IS NULL AND m.nostr_publish_state = 'pending'
           AND m.account_id IS NOT NULL
           AND (m.claimed_until IS NULL OR m.claimed_until <= $2)
           AND (
             m.parent_id IS NULL
             OR EXISTS (
               SELECT 1 FROM message p
               WHERE p.id = m.parent_id AND p.event_id IS NOT NULL
             )
           )
         ORDER BY m.created_at ASC, m.id ASC
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
       WHERE parent_id IS NULL
         AND event_id IS NOT NULL AND nostr_publish_state = 'pending'
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
       WHERE id = $1 AND nostr_publish_state = 'pending' AND event_id IS NOT DISTINCT FROM $2
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)`,
      [id, expectedEventId],
    );
  }

  async listSignedMissingPhoto(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id IS NULL AND event_id IS NOT NULL AND photo IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)
         AND (video_content_type IS NULL OR video_content_type = '')
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

  async listSignedMissingVideo(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id IS NULL AND event_id IS NOT NULL
         AND video_content_type IN ('video/mp4', 'video/webm', 'video/quicktime')
         AND sats = 0
         AND nostr_publish_state = 'published'
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)
         AND (
           nostr_event IS NULL
           OR COALESCE(nostr_event->>'content', '') NOT LIKE '%/messages/' || id::text || '/video.%'
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
       WHERE parent_id IS NULL AND event_id IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)
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
       WHERE id = $1 AND event_id IS NOT DISTINCT FROM $2 AND sats = 0
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)`,
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
         pr, payment_hash, description, description_hash, is_nip57_invoice,
         lnurl_response
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
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
        row.lnurlResponse === null ? null : JSON.stringify(row.lnurlResponse),
      ],
    );
  }

  async listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response
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
  lnurl_response?: Record<string, unknown> | string | null;
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
    lnurlResponse: parseJsonObject(row.lnurl_response),
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
