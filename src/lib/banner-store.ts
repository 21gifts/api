/**
 * Round profile photo and wide image, one of each per account.
 *
 * The two slots never share bytes. The About me note photo is neither slot.
 * A portrait is stored only as the profile photo, never as the wide image.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { ForumPhoto, ForumPhotoContentType } from '@/lib/message';
import { imageDisplaySize } from '@/lib/nostr/image';

/** Shortest accepted banner width in pixels. */
export const WIDE_BANNER_MIN_WIDTH = 640;

/** Which profile image. The two slots never share bytes. */
export type ProfileImageSlot = 'picture' | 'banner';

/**
 * Persistence port for the round profile photo and the wide image.
 * Each account has at most one image per slot. A slot is never filled
 * from the other slot or from an About me note.
 */
export interface BannerStore {
  /**
   * Read one slot.
   *
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @returns A copy of that image, or `null` when that slot is empty.
   */
  get(accountId: string, slot: ProfileImageSlot): Promise<ForumPhoto | null>;

  /**
   * Replace or clear one slot. Does not touch the other slot.
   *
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @param photo - Image to store, or `null` to clear that slot.
   */
  set(accountId: string, slot: ProfileImageSlot, photo: ForumPhoto | null): Promise<void>;
}

/** Idempotent DDL for `account_image` (matches `docs/schema/account_image.sql`). */
export const BANNER_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS account_image (
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('picture', 'banner')),
  content_type text NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (account_id, slot)
)`,
];

/**
 * Apply {@link BANNER_SCHEMA_SQL}. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when the statement has executed.
 */
export async function migrateBannerSchema(sql: SqlClient): Promise<void> {
  for (const statement of BANNER_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * True when the still is wide enough to be a header: at least
 * {@link WIDE_BANNER_MIN_WIDTH} pixels across and at least 1.5 times as wide
 * as it is tall. A missing header, a portrait, a square, and a thin strip
 * return `null`.
 *
 * @param bytes - Image bytes.
 * @param mime - JPEG, PNG, or WebP.
 * @returns Width and height, or `null` when the image is not a wide header.
 */
export function wideBannerSize(
  bytes: Uint8Array,
  mime: ForumPhotoContentType,
): { width: number; height: number } | null {
  const dim = imageDisplaySize(bytes, mime);
  if (dim === null) {
    return null;
  }
  const split = dim.indexOf('x');
  const width = Number(dim.slice(0, split));
  const height = Number(dim.slice(split + 1));
  if (width < WIDE_BANNER_MIN_WIDTH || width * 2 < height * 3) {
    return null;
  }
  return { width, height };
}

/**
 * Public URL Damus fetches for one account's wide image.
 *
 * @param apiBase - API origin, no trailing slash required.
 * @param accountId - Account id.
 * @param mime - Stored MIME. The extension matches it.
 * @returns Absolute URL ending in `.jpg`, `.png`, or `.webp`.
 */
export function bannerPublicUrl(
  apiBase: string,
  accountId: string,
  mime: ForumPhotoContentType,
): string {
  return profileSlotUrl(apiBase, accountId, mime, 'banners');
}

/**
 * Public URL for the round profile photo. Not the wide image and not an
 * About me note photo.
 *
 * @param apiBase - API origin, no trailing slash required.
 * @param accountId - Account id.
 * @param mime - Stored MIME.
 * @returns Absolute URL under `/pictures/`.
 */
export function picturePublicUrl(
  apiBase: string,
  accountId: string,
  mime: ForumPhotoContentType,
): string {
  return profileSlotUrl(apiBase, accountId, mime, 'pictures');
}

/**
 * True when the bytes are a JPEG, PNG, or WebP with a readable size.
 * Does not require a wide shape. That rule is only for the banner slot.
 *
 * @param bytes - Image bytes.
 * @param mime - JPEG, PNG, or WebP.
 * @returns Whether the still can be stored as the profile photo.
 */
export function isProfilePhoto(bytes: Uint8Array, mime: ForumPhotoContentType): boolean {
  return imageDisplaySize(bytes, mime) !== null;
}

function profileSlotUrl(
  apiBase: string,
  accountId: string,
  mime: ForumPhotoContentType,
  root: 'banners' | 'pictures',
): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `${apiBase.replace(/\/$/, '')}/${root}/${accountId}.${ext}`;
}

function slotKey(accountId: string, slot: ProfileImageSlot): string {
  return `${accountId}\u0000${slot}`;
}

/** Process-local {@link BannerStore}. */
export class InMemoryBannerStore implements BannerStore {
  readonly #rows = new Map<string, ForumPhoto>();

  /**
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @returns A copy of that slot, or `null`.
   */
  async get(accountId: string, slot: ProfileImageSlot): Promise<ForumPhoto | null> {
    const row = this.#rows.get(slotKey(accountId, slot));
    if (row === undefined) {
      return null;
    }
    return { contentType: row.contentType, bytes: new Uint8Array(row.bytes) };
  }

  /**
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @param photo - Image to store, or `null` to clear that slot only.
   */
  async set(accountId: string, slot: ProfileImageSlot, photo: ForumPhoto | null): Promise<void> {
    const key = slotKey(accountId, slot);
    if (photo === null) {
      this.#rows.delete(key);
      return;
    }
    this.#rows.set(key, {
      contentType: photo.contentType,
      bytes: new Uint8Array(photo.bytes),
    });
  }
}

type BannerRow = { content_type: string; data: unknown };

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function asMime(value: string): ForumPhotoContentType | null {
  if (value === 'image/jpeg' || value === 'image/png' || value === 'image/webp') {
    return value;
  }
  return null;
}

/** Postgres {@link BannerStore}. */
export class PostgresBannerStore implements BannerStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client. The table must already exist.
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @returns The stored image, or `null` when the row is missing or unreadable.
   */
  async get(accountId: string, slot: ProfileImageSlot): Promise<ForumPhoto | null> {
    const rows = await this.#sql.query<BannerRow>(
      `SELECT content_type, data FROM account_image WHERE account_id = $1 AND slot = $2`,
      [accountId, slot],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const contentType = asMime(row.content_type);
    const bytes = asBytes(row.data);
    if (contentType === null || bytes === null) {
      return null;
    }
    return { contentType, bytes };
  }

  /**
   * @param accountId - Account id.
   * @param slot - `picture` or `banner`.
   * @param photo - Image to store, or `null` to delete the row.
   */
  async set(accountId: string, slot: ProfileImageSlot, photo: ForumPhoto | null): Promise<void> {
    if (photo === null) {
      await this.#sql.execute(`DELETE FROM account_image WHERE account_id = $1 AND slot = $2`, [
        accountId,
        slot,
      ]);
      return;
    }
    await this.#sql.execute(
      `INSERT INTO account_image (account_id, slot, content_type, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, slot) DO UPDATE
       SET content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
      [accountId, slot, photo.contentType, photo.bytes],
    );
  }
}
