/**
 * One wide profile image per account, separate from the About me photo.
 *
 * The About me photo is the round Nostr avatar. This image is only the wide
 * header. A portrait is not stored here.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { ForumPhoto, ForumPhotoContentType } from '@/lib/message';
import { imageDisplaySize } from '@/lib/nostr/image';

/** Shortest accepted banner width in pixels. */
export const WIDE_BANNER_MIN_WIDTH = 640;

/**
 * Persistence port for one wide image per account.
 */
export interface BannerStore {
  /**
   * Read the stored wide image.
   *
   * @param accountId - Account id.
   * @returns A copy of the stored image, or `null` when none is stored.
   */
  get(accountId: string): Promise<ForumPhoto | null>;

  /**
   * Replace or clear the wide image.
   *
   * @param accountId - Account id.
   * @param photo - Image to store, or `null` to clear.
   */
  set(accountId: string, photo: ForumPhoto | null): Promise<void>;
}

/** Idempotent DDL for `account_banner` (matches `docs/schema/account_banner.sql`). */
export const BANNER_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS account_banner (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data bytea NOT NULL
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
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `${apiBase.replace(/\/$/, '')}/banners/${accountId}.${ext}`;
}

/** Process-local {@link BannerStore}. */
export class InMemoryBannerStore implements BannerStore {
  readonly #rows = new Map<string, ForumPhoto>();

  /**
   * @param accountId - Account id.
   * @returns A copy of the stored image, or `null`.
   */
  async get(accountId: string): Promise<ForumPhoto | null> {
    const row = this.#rows.get(accountId);
    if (row === undefined) {
      return null;
    }
    return { contentType: row.contentType, bytes: new Uint8Array(row.bytes) };
  }

  /**
   * @param accountId - Account id.
   * @param photo - Image to store, or `null` to clear.
   */
  async set(accountId: string, photo: ForumPhoto | null): Promise<void> {
    if (photo === null) {
      this.#rows.delete(accountId);
      return;
    }
    this.#rows.set(accountId, {
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
   * @returns The stored image, or `null` when the row is missing or unreadable.
   */
  async get(accountId: string): Promise<ForumPhoto | null> {
    const rows = await this.#sql.query<BannerRow>(
      `SELECT content_type, data FROM account_banner WHERE account_id = $1`,
      [accountId],
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
   * @param photo - Image to store, or `null` to delete the row.
   */
  async set(accountId: string, photo: ForumPhoto | null): Promise<void> {
    if (photo === null) {
      await this.#sql.execute(`DELETE FROM account_banner WHERE account_id = $1`, [accountId]);
      return;
    }
    await this.#sql.execute(
      `INSERT INTO account_banner (account_id, content_type, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE
       SET content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
      [accountId, photo.contentType, photo.bytes],
    );
  }
}
