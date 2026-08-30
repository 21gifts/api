import type { AccountRole } from '@/lib/auth/store';
import type { ForumVideoContentType } from '@/lib/video';

/**
 * Forum message domain: validation, photo decode, and public JSON projection.
 *
 * Text is free-form encouragement (not unique). Over-long or disallowed
 * control-character input is rejected so a bad value cannot be stored and
 * re-served on every list response. Empty trimmed text is allowed when a
 * photo is attached. Newlines (`\n`, `\r`) are allowed; other C0 controls
 * and DEL are not. Photos are JPEG/PNG/WebP only, capped at 1 MiB.
 */

/** Maximum stored length after trim. */
export const MESSAGE_MAX_LENGTH = 500;

/** Cap for `listLatest` / GET `/messages`. */
export const MESSAGE_LIST_LIMIT = 200;

/** Worker publish state for a forum row. */
export type NostrPublishState = 'pending' | 'published' | 'failed';

/** Maximum decoded photo size in bytes (1 MiB). */
export const MESSAGE_PHOTO_MAX_BYTES = 1_048_576;

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
  /** Author account id. */
  accountId: string;
  /** Display name snapshotted at post time. */
  name: string;
  /** Message body (already normalised; may be empty when `hasPhoto`). */
  text: string;
  /** Creation instant. */
  createdAt: Date;
  /** Whether a photo is stored for this message (bytes never on the row). */
  hasPhoto: boolean;
  /** Whether a video file is stored for this message. */
  hasVideo?: boolean;
  /** Stored video MIME, or `null`. */
  videoContentType?: ForumVideoContentType | null;
  /** Signed kind:1 id, or `null` until the worker signs. */
  eventId: string | null;
  /** Fan-out state. */
  nostrPublishState: NostrPublishState;
  /** Validated zap total in whole sats. */
  sats: number;
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
}

/** Public JSON shape of a forum message (no `accountId`, no event id, no photo bytes). */
export interface PublicMessage {
  /** Opaque unique message id. */
  id: string;
  /** Author display name at post time. */
  name: string;
  /** Message body (may be empty when `hasPhoto` is true). */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Validated zap total in whole sats (always present). */
  sats: number;
  /** Whether `POST /messages/:id/invoice` can run. */
  payable: boolean;
  /** True when a photo can be fetched via GET `/messages/:id/photo`. */
  hasPhoto: boolean;
  /** True when a video can be fetched via GET `/messages/:id/video.mp4`. */
  hasVideo: boolean;
  /**
   * Author's live `account.role` (not a snapshot). Always present; `"basis"`
   * when the author account is missing.
   */
  role: AccountRole;
}

/**
 * Trim and validate forum message text.
 *
 * Empty / whitespace-only input becomes `''` (valid for photo-only posts).
 * Over-long text and disallowed controls still reject.
 *
 * @param raw - User input.
 * @returns The trimmed text (possibly empty), or `null` when longer than
 * {@link MESSAGE_MAX_LENGTH}, or contains a C0 control other than LF/CR
 * (`charCode < 32` except 10 and 13) or DEL (`=== 127`). Internal spaces
 * and newlines are kept.
 */
export function normalizeForumText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
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
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted message.
 * @param payable - Whether the note can accept a NIP-57 zap payment.
 * @param role - Author's live {@link AccountRole} (or `'basis'` if missing).
 * @returns Public fields (`sats`, `payable`, `hasPhoto`, `role`; no `accountId`);
 * `createdAt` ISO-8601. Never includes photo bytes.
 */
export function serializeMessage(
  row: MessageRow,
  payable: boolean,
  role: AccountRole,
): PublicMessage {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sats: row.sats,
    payable,
    hasPhoto: row.hasPhoto,
    hasVideo: row.hasVideo === true,
    role,
  };
}

/**
 * Default Nostr columns for a freshly posted row (unsigned, pending).
 *
 * @returns The unsigned/pending defaults.
 */
export function unsignedNostrDefaults(): Pick<
  MessageRow,
  | 'eventId'
  | 'nostrPublishState'
  | 'sats'
  | 'nostrEvent'
  | 'claimedUntil'
  | 'nostrFirstAttemptAt'
  | 'nostrPublishEpoch'
  | 'nostrAttempts'
> {
  return {
    eventId: null,
    nostrPublishState: 'pending',
    sats: 0,
    nostrEvent: null,
    claimedUntil: null,
    nostrFirstAttemptAt: null,
    nostrPublishEpoch: null,
    nostrAttempts: 0,
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
