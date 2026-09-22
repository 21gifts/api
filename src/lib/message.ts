import { createHash } from 'node:crypto';
import type { AccountRole } from '@/lib/auth/store';
import type { ForumVideoContentType } from '@/lib/video';

/**
 * Forum message domain: validation, photo decode, public JSON, operator
 * debug JSON, and staff hidden-log JSON projection.
 *
 * Text is free-form encouragement (not unique). Over-long or disallowed
 * control-character input is rejected so a bad value cannot be stored and
 * re-served on every list response. Empty trimmed text is allowed when a
 * photo is attached or `hasVideo`. Newlines (`\n`, `\r`) are allowed; other C0 controls
 * and DEL are not. Photos are JPEG/PNG/WebP only, capped at 1 MiB.
 *
 * Top-level notes have `parentId: null`. Replies are extra rows with
 * `parentId` set (NIP-10). Damus-only inbound authors may have
 * `accountId: null`.
 */

/** Maximum stored length after trim (member posts and member replies). */
export const MESSAGE_MAX_LENGTH = 500;

/** Hard cap for inbound Damus reply content (may exceed member 500). */
export const MESSAGE_INBOUND_REPLY_MAX_LENGTH = 8192;

/** Cap for `listLatest` / GET `/messages` (top-level notes only). Default and max `listFeed` page size. */
export const MESSAGE_LIST_LIMIT = 200;

/** Server-side forum feed filter for GET `/messages`. */
export type ForumFeedMode = 'all' | 'active' | 'unpaid' | 'popular';

/** Opaque keyset cursor JSON before base64url encoding. */
export type MessageFeedCursorJson =
  { k: 't'; c: string; i: string } | { k: 's'; s: number; c: string; i: string };

/** Worker publish state for a forum row. */
export type NostrPublishState = 'pending' | 'published' | 'failed' | 'skipped';

/** Maximum decoded photo size in bytes (1 MiB). */
export const MESSAGE_PHOTO_MAX_BYTES = 1_048_576;

/** Maximum still photos on one forum note (index 0 plus extras 1–9). */
export const MESSAGE_PHOTO_MAX_COUNT = 10;

/** Maximum `data` string length accepted by `decodeForumPhoto`. */
export const MESSAGE_PHOTO_MAX_BASE64_LENGTH = Math.ceil(MESSAGE_PHOTO_MAX_BYTES / 3) * 4 + 4;

/** Allowed forum photo MIME types (derived from magic bytes). */
export type ForumPhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Decoded forum photo ready for storage. */
export interface ForumPhoto {
  /** MIME type from magic bytes. */
  contentType: ForumPhotoContentType;
  /** Raw image bytes (caller-owned copy). */
  bytes: Uint8Array;
}

/** Persisted forum row (store-internal; includes `accountId`). */
export interface MessageRow {
  /** Opaque unique message id. */
  id: string;
  /**
   * Author account id, or `null` for Damus-only inbound replies (no 21gifts
   * account). Never auto-created from an inbound npub.
   */
  accountId: string | null;
  /** Display name snapshotted at post time (or Damus kind:0 / truncated npub). */
  name: string;
  /** Message body (already normalised; may be empty when `hasPhoto` or `hasVideo`). */
  text: string;
  /** Creation instant. */
  createdAt: Date;
  /** Whether a photo is stored for this message (bytes never on the row). */
  hasPhoto: boolean;
  /**
   * Still-photo count 0–10 when known (`hasPhoto` plus extra stills).
   * Omitted on older fixtures; serializers default `hasPhoto ? 1 : 0`.
   */
  photoCount?: number;
  /** Whether a video file is stored for this message. */
  hasVideo?: boolean;
  /** Stored video MIME, or `null`. */
  videoContentType?: ForumVideoContentType | null;
  /** Parent note id for NIP-10 replies; `null` for top-level notes. */
  parentId: string | null;
  /**
   * Author Nostr pubkey (hex) when known from a signed event; else null.
   * Set for Damus inbound and optionally for published member notes.
   */
  authorPubkey: string | null;
  /** Signed kind:1 id, or `null` until the worker signs. */
  eventId: string | null;
  /** Fan-out state. */
  nostrPublishState: NostrPublishState;
  /** Validated zap total in whole sats. */
  sats: number;
  /** USD snapshot frozen when sats were credited. */
  amountUsd?: string | null;
  /** CHF snapshot frozen when sats were credited. */
  amountChf?: string | null;
  /** EUR snapshot frozen when sats were credited. */
  amountEur?: string | null;
  /** PHP snapshot frozen when sats were credited. */
  amountPhp?: string | null;
  /**
   * Optional whole-sat ask on a top-level note. Omit or `null` means no goal.
   */
  goalSats?: number | null;
  /** Stored signed event JSON, or `null` until signed. */
  nostrEvent: Record<string, unknown> | null;
  /** Lease expiry (epoch ms), or `null`. */
  claimedUntil: number | null;
  /** First sign-or-publish attempt (epoch ms), or `null`. */
  nostrFirstAttemptAt: number | null;
  /** Publish epoch (`space` vs `space+public`). */
  nostrPublishEpoch: string | null;
  /** Sign/publish attempts in the current epoch. */
  nostrAttempts: number;
  /**
   * Soft-delete stamp when staff hid this note (or a parent hide tagged it).
   * `null` while the row is live. Default `null` on create.
   */
  deletedAt: Date | null;
  /**
   * Account id of the staff member who stamped `deletedAt`, or `null` while
   * live. Default `null` on create. Not a foreign key.
   */
  deletedBy: string | null;
  /**
   * Store-internal fingerprint for live media dedupe (`forumContentFingerprint`).
   * Set only when media is stored, `accountId` is not null, and `eventId` is
   * null; otherwise `null` / omitted. Never included in {@link PublicMessage}.
   */
  contentFp?: string | null;
}

/**
 * Public JSON shape of a forum message (no event id, no photo bytes).
 * Public GET omits `accountId`; signed-in list/replies/create may include it.
 */
export interface PublicMessage {
  /** Opaque unique message id. */
  id: string;
  /**
   * 21gifts author id; omitted for Damus-only rows and on public GET.
   */
  accountId?: string;
  /** Author display name at post time. */
  name: string;
  /** Message body (may be empty when `hasPhoto` or `hasVideo` is true). */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Validated zap total in whole sats (always present). */
  sats: number;
  /** Stored USD snapshot, or null when pricing was unavailable. */
  amountUsd: string | null;
  /** Stored CHF snapshot, or null when pricing was unavailable. */
  amountChf: string | null;
  /** Stored EUR snapshot, or null when pricing was unavailable. */
  amountEur: string | null;
  /** Stored PHP snapshot, or null when pricing was unavailable. */
  amountPhp: string | null;
  /**
   * Optional whole-sat ask on a top-level note. Included only when the stored
   * value is a positive integer; omitted on replies and when unset.
   */
  goalSats?: number;
  /** Whether `POST /messages/:id/invoice` can run. */
  payable: boolean;
  /** True when a photo can be fetched via GET `/messages/:id/photo`. */
  hasPhoto: boolean;
  /**
   * Still-photo count (0–10). `0` when there are no stills; otherwise
   * 1 + extra count. A video poster is photo 0 (`hasPhoto` true, `photoCount` 1).
   */
  photoCount: number;
  /** True when a video can be fetched via GET `/messages/:id/video.mp4|.webm|.mov`. */
  hasVideo: boolean;
  /** Stored video MIME when `hasVideo` is true; otherwise `null`. */
  videoContentType: ForumVideoContentType | null;
  /**
   * Author's live `account.role` (not a snapshot). Present for 21gifts
   * authors (`"basis"` when the account is missing). Omitted for Damus-only
   * authors.
   */
  role?: AccountRole;
  /** Marks a visible external Nostr-authored row; the pubkey remains private. */
  via?: 'nostr';
  /**
   * Number of direct replies (`parent_id` children). A top-level note
   * includes `replyCount` on `GET /messages` and on `GET /messages/:id`
   * (including 0). Only a reply omits it.
   */
  replyCount?: number;
  /**
   * Parent note id for a reply. Omitted on top-level notes (`parentId` null).
   */
  parentId?: string;
  /**
   * ISO-8601 hide timestamp. Set only when staff serialize a hidden row.
   * Omitted on live JSON.
   */
  deletedAt?: string;
  /**
   * Staff member who hid the note. Set only with {@link PublicMessage.deletedAt}.
   */
  deletedBy?: { id: string | null; name: string | null; role: AccountRole | null };
}

/**
 * SHA-256 hex of utf8(text) + 0x00 + SHA-256(mediaBytes). Media required.
 *
 * Matches the SQL photo backfill (`digest(photo, 'sha256')` with a 0x00
 * separator after the UTF-8 text). When `extraMedia` is omitted or empty the
 * two-arg formula is unchanged. When extras are present, each extra's
 * SHA-256 digest is appended onto the outer hasher in index order (1..n).
 *
 * @param text - Already-normalised forum text (may be empty).
 * @param mediaBytes - Photo or video bytes (video wins when both exist).
 * @param extraMedia - Optional extra still-photo bytes (indices 1..n). Omit
 *   or pass empty for the N=1 fingerprint. Video paths must not pass extras.
 * @returns Lowercase hex SHA-256 (64 characters).
 */
export function forumContentFingerprint(
  text: string,
  mediaBytes: Uint8Array,
  extraMedia?: readonly Uint8Array[],
): string {
  const mediaDigest = createHash('sha256').update(mediaBytes).digest();
  const hasher = createHash('sha256')
    .update(Buffer.from(text, 'utf8'))
    .update(Buffer.from([0x00]))
    .update(mediaDigest);
  for (const extra of extraMedia ?? []) {
    hasher.update(createHash('sha256').update(extra).digest());
  }
  return hasher.digest('hex');
}

/** Public/debug/hidden JSON `photoCount` (0–10). */
function photoCountOf(row: MessageRow): number {
  return typeof row.photoCount === 'number' ? row.photoCount : row.hasPhoto ? 1 : 0;
}

/**
 * Public/debug/hidden JSON `goalSats` when the stored value is a positive
 * integer on a top-level note. Omitted on replies and when unset/0.
 */
function publicGoalSats(row: MessageRow): number | undefined {
  if (row.parentId !== null) {
    return undefined;
  }
  const value = row.goalSats;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Trim and validate forum message text.
 *
 * Empty / whitespace-only input becomes `''` (valid for photo-only or video-only posts).
 * Over-long text and disallowed controls still reject.
 *
 * @param raw - User input.
 * @param maxLength - Maximum length after trim (default {@link MESSAGE_MAX_LENGTH}).
 * @returns The trimmed text (possibly empty), or `null` when longer than
 * `maxLength`, or contains a C0 control other than LF/CR
 * (`charCode < 32` except 10 and 13) or DEL (`=== 127`). Internal spaces
 * and newlines are kept.
 */
export function normalizeForumText(
  raw: string,
  maxLength: number = MESSAGE_MAX_LENGTH,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > maxLength) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code === 10 || code === 13) {
      continue;
    }
    if (code < 32 || code === 127) {
      return null;
    }
  }
  return trimmed;
}

/**
 * Truncate a hex pubkey or npub-like string for Damus-only display names.
 *
 * @param pubkeyHex - 64-char hex pubkey when available.
 * @returns Short display token (never empty).
 */
export function truncatePubkeyDisplay(pubkeyHex: string): string {
  const trimmed = pubkeyHex.trim().toLowerCase();
  if (trimmed.length <= 12) {
    return trimmed === '' ? 'npub' : trimmed;
  }
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

/**
 * Project a store row to its public JSON shape.
 *
 * When `row.name` is empty after trim, JSON `name` is
 * {@link truncatePubkeyDisplay} of `row.authorPubkey` (`'npub'` when the
 * pubkey is missing). Non-empty names are unchanged. Invalid `createdAt`
 * is not guarded here: `toISOString()` still throws. `GET /messages/:id/replies`
 * and `GET /members/:accountId/replies` omit that child (200, siblings remain);
 * `GET /messages` (list), `GET /members/:accountId/posts`, and public
 * `GET /messages/:id` return 503.
 *
 * @param row - Persisted message.
 * @param payable - Whether the note can accept a NIP-57 zap payment.
 * @param role - Author's live {@link AccountRole}, or `undefined` for Damus-only.
 * @param replyCount - Reply count for a top-level `GET /messages` list row
 * and for a top-level `GET /messages/:id`, including 0. A reply passes
 * `undefined` so the key is omitted.
 * @param includeAccountId - When true, set `accountId` for 21gifts authors
 * (`row.accountId !== null`). Public GET leaves this unset.
 * @param hidden - When set, stamp `deletedAt` / `deletedBy` and force
 * `payable` false (the `payable` argument is ignored). Omit on live JSON so
 * those keys are absent.
 *
 * @returns Public fields (`sats`, `payable`, `hasPhoto`, `photoCount`,
 * `hasVideo`, `videoContentType`; live `role` for 21gifts authors; optional
 * `via: 'nostr'` when `row.accountId === null && row.authorPubkey !== null`;
 * optional `accountId` when requested; optional `parentId` when
 * `row.parentId !== null`; optional `goalSats` when the stored value is a
 * positive integer on a top-level note; optional hide stamps when `hidden`
 * is set); `createdAt` ISO-8601. Never includes photo or video bytes, and
 * never includes `contentFp`. Omits the `parentId` key on top-level notes.
 * Omits `goalSats` on replies and when the stored value is null, 0, or unset.
 * Live serialize omits `deletedAt` / `deletedBy`.
 * @throws RangeError (or Error) when createdAt is invalid.
 */
export function serializeMessage(
  row: MessageRow,
  payable: boolean,
  role: AccountRole | undefined,
  replyCount?: number,
  includeAccountId?: boolean,
  hidden?: {
    deletedAt: Date;
    deletedBy: { id: string | null; name: string | null; role: AccountRole | null };
  },
): PublicMessage {
  const body: PublicMessage = {
    id: row.id,
    name: row.name.trim() === '' ? truncatePubkeyDisplay(row.authorPubkey ?? '') : row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sats: row.sats,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    payable: hidden === undefined ? payable : false,
    hasPhoto: row.hasPhoto,
    photoCount: photoCountOf(row),
    hasVideo: row.hasVideo === true,
    videoContentType: row.videoContentType ?? null,
  };
  if (role !== undefined) {
    body.role = role;
  }
  if (row.accountId === null && row.authorPubkey !== null) {
    body.via = 'nostr';
  }
  if (replyCount !== undefined) {
    body.replyCount = replyCount;
  }
  if (includeAccountId === true && row.accountId !== null) {
    body.accountId = row.accountId;
  }
  if (row.parentId !== null) {
    body.parentId = row.parentId;
  }
  const goalSats = publicGoalSats(row);
  if (goalSats !== undefined) {
    body.goalSats = goalSats;
  }
  if (hidden !== undefined) {
    body.deletedAt = hidden.deletedAt.toISOString();
    body.deletedBy = hidden.deletedBy;
  }
  return body;
}

/** Optional still-photo lengths for operator debug JSON (never payloads). */
export interface DebugMessagePhotoMeta {
  /** Photo 0 MIME, or `null` when none. */
  photoContentType: string | null;
  /** Photo 0 byte length, or `0`. */
  photoBytes: number;
  /** Extra stills (indices 1–9) with lengths only. */
  extraPhotos: Array<{ idx: number; photoContentType: string | null; bytes: number }>;
}

/**
 * Project a store row to operator debug JSON (includes soft-hide stamps).
 *
 * Always includes `accountId` (JSON `null` for Damus-only rows). Soft-hidden
 * rows keep `text` and `deletedAt` / `deletedBy`. Includes every
 * {@link MessageRow} column (`nostrEvent`, `claimedUntil`,
 * `nostrFirstAttemptAt`, `nostrPublishEpoch`, `contentFp`). Photo/video
 * **payloads** stay off JSON; `photo` / extra stills are MIME + byte length.
 *
 * @param row - Persisted message (including hidden rows and replies).
 * @param photo - Optional photo 0 / extra-still lengths (defaults: `null` / `0` / `[]`).
 * @returns Debug fields; `createdAt` / `deletedAt` ISO-8601 (`deletedAt` null
 *   when live). `goalSats` is the stored column (JSON `null` when unset).
 * @throws RangeError (or Error) when `createdAt` or `deletedAt` is invalid.
 */
export function serializeDebugMessage(
  row: MessageRow,
  photo?: DebugMessagePhotoMeta,
): Record<string, unknown> {
  const deletedAt = row.deletedAt ?? null;
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sats: row.sats,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    hasPhoto: row.hasPhoto === true,
    photoCount: photoCountOf(row),
    hasVideo: row.hasVideo === true,
    videoContentType: row.videoContentType ?? null,
    parentId: row.parentId ?? null,
    eventId: row.eventId ?? null,
    nostrPublishState: row.nostrPublishState,
    nostrEvent: row.nostrEvent ?? null,
    claimedUntil: row.claimedUntil ?? null,
    nostrFirstAttemptAt: row.nostrFirstAttemptAt ?? null,
    nostrPublishEpoch: row.nostrPublishEpoch ?? null,
    contentFp: row.contentFp ?? null,
    deletedAt: deletedAt === null ? null : deletedAt.toISOString(),
    deletedBy: row.deletedBy ?? null,
    authorPubkey: row.authorPubkey ?? null,
    nostrAttempts: row.nostrAttempts,
    accountId: row.accountId ?? null,
    goalSats: row.goalSats ?? null,
    photoContentType: photo?.photoContentType ?? null,
    photoBytes: photo?.photoBytes ?? 0,
    extraPhotos: photo?.extraPhotos ?? [],
  };
}

/**
 * Project a store row to staff hidden-log JSON (who hid it and when).
 *
 * JSON `name` is the stored `row.name` (no empty-name pubkey fallback).
 * Always includes `parentId` (JSON `null` on top-level notes) and
 * `deletedAt` (JSON `null` when live). Optional `via: 'nostr'` is present
 * exactly when `row.accountId === null && row.authorPubkey !== null`; the
 * pubkey itself never appears in this JSON. Never includes `accountId`,
 * `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`,
 * `claimedUntil`, `contentFp`, nsec, or photo/video bytes.
 *
 * @param row - Persisted message (including hidden rows and replies).
 * @param deletedBy - Resolved deleter `{ id, name, role }` from the route.
 * @returns Hidden-log fields (`id`, `name`, `text`, `createdAt`, `sats`,
 *   media flags, `parentId`, `deletedAt`, `deletedBy`, optional `via`, and
 *   optional `goalSats`); `createdAt` / `deletedAt` are ISO-8601
 *   (`deletedAt` null when live). Optional `goalSats` when the stored value
 *   is a positive integer on a top-level note (omitted otherwise).
 * @throws RangeError (or Error) when `createdAt` or `deletedAt` is invalid.
 */
export function serializeHiddenMessage(
  row: MessageRow,
  deletedBy: { id: string | null; name: string | null; role: AccountRole | null },
): Record<string, unknown> & { via?: 'nostr' } {
  const deletedAt = row.deletedAt ?? null;
  const goalSats = publicGoalSats(row);
  const body: Record<string, unknown> & { via?: 'nostr' } = {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sats: row.sats,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    hasPhoto: row.hasPhoto === true,
    photoCount: photoCountOf(row),
    hasVideo: row.hasVideo === true,
    videoContentType: row.videoContentType ?? null,
    parentId: row.parentId ?? null,
    deletedAt: deletedAt === null ? null : deletedAt.toISOString(),
    deletedBy,
    ...(goalSats === undefined ? {} : { goalSats }),
  };
  if (row.accountId === null && row.authorPubkey !== null) {
    body.via = 'nostr';
  }
  return body;
}

/**
 * Default Nostr columns for a freshly posted row (unsigned, pending).
 *
 * @returns The unsigned/pending defaults (`goalSats: null`).
 */
export function unsignedNostrDefaults(): Pick<
  MessageRow,
  | 'eventId'
  | 'nostrPublishState'
  | 'sats'
  | 'amountUsd'
  | 'amountChf'
  | 'amountEur'
  | 'amountPhp'
  | 'goalSats'
  | 'nostrEvent'
  | 'claimedUntil'
  | 'nostrFirstAttemptAt'
  | 'nostrPublishEpoch'
  | 'nostrAttempts'
  | 'parentId'
  | 'authorPubkey'
  | 'deletedAt'
  | 'deletedBy'
> {
  return {
    eventId: null,
    nostrPublishState: 'pending',
    sats: 0,
    amountUsd: null,
    amountChf: null,
    amountEur: null,
    amountPhp: null,
    goalSats: null,
    nostrEvent: null,
    claimedUntil: null,
    nostrFirstAttemptAt: null,
    nostrPublishEpoch: null,
    nostrAttempts: 0,
    parentId: null,
    authorPubkey: null,
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * Detect JPEG / PNG / WebP from magic bytes.
 *
 * @param bytes - Raw image candidate.
 * @returns The matching {@link ForumPhotoContentType}, or `null` when the
 * prefix is empty, SVG, GIF, HEIC, or otherwise unrecognized.
 */
export function detectImageContentType(bytes: Uint8Array): ForumPhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Decode a base64 forum photo and validate size + magic bytes.
 *
 * The declared `contentType` is ignored for the stored type; the MIME comes
 * from {@link detectImageContentType} on the decoded bytes.
 *
 * @param _contentType - Client-declared type (non-authoritative; ignored).
 * @param data - Standard base64 payload.
 * @returns A {@link ForumPhoto} with copied bytes, or `null` on invalid
 * base64, empty decode, oversize encoded
 * (`> {@link MESSAGE_PHOTO_MAX_BASE64_LENGTH}`) or decoded
 * (`> {@link MESSAGE_PHOTO_MAX_BYTES}`), or unrecognized magic.
 */
export function decodeForumPhoto(_contentType: string, data: string): ForumPhoto | null {
  if (data.length === 0) {
    return null;
  }
  // Standard base64 only: alphabet, quartet length, and padding in the last group.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return null;
  }
  if (data.length > MESSAGE_PHOTO_MAX_BASE64_LENGTH) {
    return null;
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length === 0 || decoded.length > MESSAGE_PHOTO_MAX_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  const detected = detectImageContentType(bytes);
  if (detected === null) {
    return null;
  }
  return { contentType: detected, bytes: bytes.slice() };
}

/**
 * HTTP response for stored forum photo bytes (owner, view, and public note).
 *
 * Same headers as public `GET /messages/:id/photo`: JPEG/PNG/WebP
 * `Content-Type`, one-day public cache, CORS `*`, and an inline
 * `photo.jpg|png|webp` filename from the stored MIME.
 *
 * @param photo - Decoded photo to send (caller-owned bytes).
 * @returns A 200 `Response` whose body is `photo.bytes`.
 */
export function forumPhotoResponse(photo: ForumPhoto): Response {
  const ext =
    photo.contentType === 'image/png' ? 'png' : photo.contentType === 'image/webp' ? 'webp' : 'jpg';
  return new Response(photo.bytes, {
    status: 200,
    headers: {
      'Content-Type': photo.contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `inline; filename="photo.${ext}"`,
    },
  });
}

/**
 * Opaque base64url JSON cursor for GET `/messages` keyset pagination.
 *
 * @param cursor - Time (`k: 't'`) or popular (`k: 's'`) cursor fields.
 * @returns UTF-8 JSON encoded as standard base64url (padding omitted).
 */
export function encodeMessageFeedCursor(cursor: MessageFeedCursorJson): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode an opaque feed cursor. Returns null when the payload is not valid
 * base64url JSON of the expected shape (including invalid ISO `c` / non-finite `s`).
 * Does not interpret mode; the GET `/` handler rejects the wrong `k` for the mode.
 *
 * @param raw - Query `cursor` string.
 * @returns The decoded cursor, or `null` when the payload is not valid.
 */
export function decodeMessageFeedCursor(raw: string): MessageFeedCursorJson | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    const createdAt = rec['c'];
    const id = rec['i'];
    if (typeof createdAt !== 'string' || typeof id !== 'string') {
      return null;
    }
    if (Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    if (rec['k'] === 't') {
      return { k: 't', c: createdAt, i: id };
    }
    if (rec['k'] === 's') {
      const sats = rec['s'];
      if (typeof sats !== 'number' || !Number.isFinite(sats)) {
        return null;
      }
      return { k: 's', s: sats, c: createdAt, i: id };
    }
    return null;
  } catch {
    return null;
  }
}
