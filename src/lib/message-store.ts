/**
 * Persistence for the public member forum.
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. List queries never select the `photo` bytea column —
 * only `(photo IS NOT NULL) AS has_photo`. Bytes are loaded via {@link MessageStore.getPhoto}.
 * `video_content_type` (MIME) lives in Postgres; video bytes live on disk under
 * `MEDIA_DIR`, not as bytea. Extra stills (indices 1–9) live in
 * `message_extra_photo`; photo 0 stays on `message.photo`. List queries never
 * select extra or photo bytea.
 */

import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';
import { fiatAmountToCents } from '@/lib/credit-repayment';
import { TRANSLATION_SCHEMA_SQL } from '@/lib/translation-store';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { FetchFn } from '@/lib/btc-usd-candles';
import {
  fiatFromSats,
  satsToUsdCents,
  usdCentsToFiatCents,
  usdCentsToString,
  type FiatAmounts,
} from '@/lib/money';
import type { PostDayCount } from '@/lib/post-stats';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { canonicalGoalAmount, type GoalCurrency } from '@/lib/goal-rate';
import {
  forumContentFingerprint,
  unsignedNostrDefaults,
  type ForumFeedMode,
  type ForumPhoto,
  type ForumPhotoContentType,
  type MessageRow,
  type NostrPublishState,
} from '@/lib/message';
import { placesMatch, type ForumPlace } from '@/lib/place';

export type { ForumFeedMode };
import { kind1ContentWithHashtags } from '@/lib/nostr/event';
import { normalizeSignedEvent } from '@/lib/nostr/publish';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import {
  removeForumVideo,
  writeForumVideo,
  type ForumVideo,
  type ForumVideoContentType,
} from '@/lib/video';

const MAX_PUBLISH_ATTEMPTS = 5;

interface PaymentFiatStoreOptions {
  fetchImpl?: FetchFn;
  fiatRates?: FiatRateBook;
  now?: () => number;
}

function centsFromStoredAmount(value: string): bigint {
  if (!/^\d+\.\d{2}$/.test(value)) {
    throw new Error('stored fiat amount must have two decimals');
  }
  return BigInt(value.replace('.', ''));
}

function storedAmountFromCents(value: bigint): string {
  const digits = value.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function addStoredAmount(left: string | null, right: string | null): string | null {
  /* v8 ignore next 3 -- foldFiatColumn only calls this with two amounts */
  if (left === null || right === null) {
    return null;
  }
  return storedAmountFromCents(centsFromStoredAmount(left) + centsFromStoredAmount(right));
}

/**
 * One payment-fiat column. Extra sats of 0 or a null delta leave it.
 * A null column takes the delta as-is. Both sides add. Never assigns NULL
 * over a stored total.
 */
function foldFiatColumn(
  current: string | null | undefined,
  delta: string | null,
  extraSats: number,
): string | null {
  const stored = current ?? null;
  if (extraSats === 0 || delta === null) {
    return stored;
  }
  if (stored === null) {
    return delta;
  }
  return addStoredAmount(stored, delta);
}

/** Replies persist no ask. Top-level rows keep a legacy goalSats with null currency columns. */
function applyStoredGoal(stored: MessageRow): void {
  if (stored.parentId !== null) {
    stored.goalSats = null;
    stored.goalRepayable = null;
    stored.goalTermDays = null;
    stored.goalCurrency = null;
    stored.goalAmount = null;
    stored.goalAmountUsd = null;
    stored.goalAmountChf = null;
    stored.goalAmountEur = null;
    stored.goalAmountPhp = null;
    return;
  }
  stored.goalSats = stored.goalSats ?? null;
  stored.goalRepayable = stored.goalRepayable === true ? true : null;
  stored.goalTermDays = stored.goalTermDays ?? null;
  stored.goalCurrency = stored.goalCurrency ?? null;
  stored.goalAmount = stored.goalAmount ?? null;
  stored.goalAmountUsd = stored.goalAmountUsd ?? null;
  stored.goalAmountChf = stored.goalAmountChf ?? null;
  stored.goalAmountEur = stored.goalAmountEur ?? null;
  stored.goalAmountPhp = stored.goalAmountPhp ?? null;
}

function mapGoalCurrency(value: string | null | undefined): GoalCurrency | null {
  if (value === 'BTC' || value === 'USD' || value === 'CHF' || value === 'EUR' || value === 'PHP') {
    return value;
  }
  return null;
}

function mapGoalAmountText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return canonicalGoalAmount(String(value));
}

function mapGoalFiatText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return amount.toFixed(2);
}

async function resolvePaymentFiat(
  sats: number,
  createdAt: Date,
  supplied: FiatAmounts | null | undefined,
  options: Required<PaymentFiatStoreOptions>,
): Promise<FiatAmounts | null> {
  if (supplied !== undefined) {
    return supplied;
  }
  if (sats === 0) {
    return null;
  }
  const spot = await fetchBtcUsdSpot(options.fetchImpl);
  if (spot === null) {
    return null;
  }
  const day = createdAt.toISOString().slice(0, 10);
  try {
    const crosses = (await options.fiatRates.ensureDays([day], options.now())).get(day) ?? {};
    return fiatFromSats(sats, spot, crosses);
  } catch {
    return fiatFromSats(sats, spot, {});
  }
}

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

function kind1MissingHashtags(
  event: Record<string, unknown> | null,
  extraHashtags: readonly string[] = [],
): boolean {
  if (event === null) {
    return true;
  }
  const content = event['content'];
  return (
    typeof content !== 'string' || kind1ContentWithHashtags(content, extraHashtags) !== content
  );
}

const POSIX_REGEX_META = /[\\^$.|?*+()[\]{}]/g;

function posixHashtagTokenPattern(name: string): string {
  return `#${name.toLowerCase().replace(POSIX_REGEX_META, '\\$&')}([^a-z0-9_]|$)`;
}

/**
 * Whether `text` contains a hashtag token `#name` (case-insensitive).
 * The next character must not be `[A-Za-z0-9_]`, so `#bitcoiners` does
 * not match `bitcoin`.
 *
 * @param text - Stored note body.
 * @param name - Hashtag name without `#`.
 * @returns `true` when the token is present.
 */
export function textHasHashtagToken(text: string, name: string): boolean {
  const escaped = name.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  return new RegExp(`#${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

function extraHashtagBindings(
  extraHashtagsByAccountId: ReadonlyMap<string, readonly string[]> | undefined,
): { accountIds: string[]; patterns: string[] } | null {
  if (extraHashtagsByAccountId === undefined || extraHashtagsByAccountId.size === 0) {
    return null;
  }
  const accountIds: string[] = [];
  const patterns: string[] = [];
  for (const [accountId, names] of extraHashtagsByAccountId) {
    for (const name of names) {
      accountIds.push(accountId);
      patterns.push(posixHashtagTokenPattern(name));
    }
  }
  return { accountIds, patterns };
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
 * Keyset page query for {@link MessageStore.listFeed}.
 */
export type MessageFeedQuery = {
  /** Page size (1..200). */
  limit: number;
  /** Server-side feed filter. */
  mode: ForumFeedMode;
  /** Exclusive keyset cursor, or `null` for the first page. */
  cursor: { k: 't'; c: Date; i: string } | { k: 's'; s: number; c: Date; i: string } | null;
  /** Founder + moderator account ids; used only when mode==='active'. */
  staffAccountIds: ReadonlySet<string>;
  /** Optional hashtag name without `#`. When set, only notes whose `text` contains that token. */
  hashtag?: string;
};

/** Top-level list row with computed reply count. */
export interface MessageListRow extends MessageRow {
  /**
   * Live attributed children (`parentId` match, `deletedAt` null, and either
   * an account or a recorded zapper pubkey).
   */
  replyCount: number;
}

/** Live totals for one 21.gifts author. Soft-deleted and Damus-only rows excluded. */
export interface AccountMessageCounts {
  /** Live top-level notes (`parentId === null`). */
  postCount: number;
  /** Live replies (`parentId !== null`). */
  replyCount: number;
}

/**
 * Persistence port for forum messages.
 */
export interface MessageStore {
  /**
   * Newest **top-level** notes first (`parent_id IS NULL`, `createdAt` desc,
   * then `id` desc), capped at `limit`. Each row includes `replyCount` of
   * live attributed children (`deletedAt` null and either an account or a
   * recorded zapper pubkey).
   * Rows include `hasPhoto`, `hasVideo`, and `videoContentType` but never
   * photo or video bytes. Replies are never listed.
   *
   * @param limit - Maximum rows to return.
   * @returns Message list rows (caller-owned copies).
   */
  listLatest(limit: number): Promise<MessageListRow[]>;

  /**
   * One keyset page of **top-level** live notes (`parent_id IS NULL`,
   * `deletedAt` null) for GET `/messages`. Same `replyCount` as
   * {@link listLatest} (live attributed direct children). Never
   * selects `photo` bytea. Replies and soft-hidden rows are excluded.
   * Name-copy profile notes without a photo, extra stills, or video are omitted
   * (Postgres via the name-copy NOT EXISTS; in-memory when the provider returns
   * those ids).
   * A real About me stays.
   *
   * @param query - Mode, limit, exclusive cursor, staff ids (`active` only), and optional hashtag.
   * @returns At most `query.limit` list row copies.
   */
  listFeed(query: MessageFeedQuery): Promise<MessageListRow[]>;

  /**
   * Oldest attributed replies first for a parent note id (either an account
   * or a recorded zapper pubkey). Null-account rows whose pubkey is not a
   * zapper, and rows with neither identity, are omitted; `getById` still
   * returns them. When `includeHidden` is not `true`, live rows only
   * (`deletedAt` null). When `true`, hidden children are included.
   *
   * @param parentId - Parent message id.
   * @param limit - Maximum rows (default 200).
   * @param includeHidden - When `true`, omit the live-only filter.
   * @returns Reply rows (caller-owned copies).
   */
  listReplies(parentId: string, limit?: number, includeHidden?: boolean): Promise<MessageRow[]>;

  /**
   * Direct-child ids of `parentId` (any `deletedAt`), newest not required.
   * Empty array when the parent id is unknown or has no children.
   *
   * @param parentId - Parent message id.
   * @returns Child id strings (any hide stamp).
   */
  listChildIds(parentId: string): Promise<string[]>;

  /**
   * Newest-first forum rows for operator debug (`createdAt` desc, then `id`
   * desc), capped at `limit`. Includes top-level notes **and** replies, live
   * **and** soft-hidden (`deletedAt` set). Rows include `hasPhoto` /
   * `hasVideo` / `videoContentType` but never photo or video bytes.
   *
   * @param limit - Maximum rows to return.
   * @returns Message row copies.
   */
  listDebug(limit: number): Promise<MessageRow[]>;

  /**
   * Living notes and replies per UTC day (`deletedAt` null). Top-level notes
   * and replies count the same. Soft-hidden rows are omitted. Days with no
   * rows are absent. Photo and video bytes are not read.
   *
   * @returns One entry per day that has a living row, oldest day first.
   */
  postCountsByUtcDay(): Promise<PostDayCount[]>;

  /**
   * Newest-hidden-first forum rows for the staff hidden log (`deletedAt`
   * desc, then `id` desc), capped at `limit`. Only rows with `deletedAt`
   * set. Includes top-level notes **and** replies. Rows include `hasPhoto` /
   * `hasVideo` / `videoContentType` but never photo or video bytes.
   *
   * @param limit - Maximum rows to return.
   * @returns Message row copies.
   */
  listHidden(limit: number): Promise<MessageRow[]>;

  /**
   * Up to two stored message ids whose string form starts with `prefix`
   * (case-insensitive). Includes soft-hidden rows (`deletedAt` set). Does
   * not require a UUID.
   *
   * @param prefix - Hex prefix; lowercased, not trimmed.
   * @returns At most two id strings in stored form.
   */
  listIdsByPrefix(prefix: string): Promise<string[]>;

  /**
   * Live top-level notes that have both place coordinates (`parent_id` null,
   * `deleted_at` null, both `place_lat` and `place_lng` set), newest
   * `createdAt` then `id` first, capped at `limit`. Never selects `photo`
   * bytea. Replies and hidden notes are excluded.
   *
   * @param limit - Maximum rows to return.
   * @returns Pin rows (caller-owned copies).
   */
  listPlaces(limit: number): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: Date;
      lat: number;
      lng: number;
      label: string | null;
      accountId: string | null;
    }>
  >;

  /**
   * Persist a new message row and optional photo, video, and extra stills.
   *
   * When `photo` or `video` is present, `row.accountId` is not null, and
   * `row.eventId` is null, stores `content_fp` from
   * {@link forumContentFingerprint} (video bytes win when both exist; extras
   * are hashed only for a still gallery). A live unique-index hit with the
   * same pin returns the existing row instead of inserting a second note and
   * does not insert extras. A different pin throws
   * `place conflicts with live media`.
   * Rows that already carry an `eventId` leave `content_fp` null.
   *
   * `extraPhotos` are indices 1..length (max 9). Empty/omitted = none. When
   * `video` is set, extras are ignored. When extras are non-empty, `photo`
   * (index 0) is required.
   *
   * A non-null `parentId` requires a live parent (`deletedAt` null). A missing
   * or soft-hidden parent throws and does not insert. An existing-id hit still
   * returns the stored row even if that row's parent was later deleted.
   *
   * Top-level rows persist `goalSats` when the value is a positive integer.
   * A non-null `parentId` stores `goalSats` null even when the incoming row
   * carried a positive ask. Top-level rows persist `goalRepayable` as `true`
   * or SQL NULL (never `false`). A non-null `parentId` stores `goalRepayable`
   * null even when the incoming row carried `true`. Top-level rows persist
   * `goalTermDays` as a whole number of days or SQL NULL. A non-null
   * `parentId` stores `goalTermDays` null even when the incoming row carried
   * a term. Top-level rows persist
   * `place` when set. A non-null `parentId` stores `place` null even when the
   * incoming row carried a pin.
   *
   * @param row - Fully formed row (id, account, name snapshot, text, time, hasPhoto).
   * @param photo - Optional decoded photo (copied into storage; index 0).
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9).
   * @returns The stored row (a copy is fine) with `hasPhoto` set from `photo`,
   *   `photoCount` from photo 0 plus extras, and `hasVideo` / `videoContentType`
   *   from `video`. On media collapse, the existing live row (possibly a
   *   different id than `row.id`).
   */
  create(
    row: MessageRow,
    photo?: ForumPhoto,
    video?: ForumVideo,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<MessageRow>;

  /**
   * Oldest live row for the same account, parent, and content fingerprint.
   *
   * Top-level: `parentId === null` matches `parent_id IS NULL`. Soft-deleted
   * rows are ignored. Order is `created_at ASC, id ASC`.
   *
   * @param accountId - Author account id.
   * @param parentId - Parent note id, or `null` for top-level.
   * @param contentFp - {@link forumContentFingerprint} hex.
   * @returns The oldest matching live row, or `undefined`.
   */
  findLiveByAccountContent(
    accountId: string,
    parentId: string | null,
    contentFp: string,
  ): Promise<MessageRow | undefined>;

  /**
   * Whether `accountId` has at least one live forum row that is not `excludeId`.
   * Live = `deletedAt` null and `accountId` equals the argument (Damus-only
   * `accountId: null` rows never match). `excludeId` is the auto profile note
   * id; `null` excludes nothing extra. Replies count.
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live row exists.
   */
  accountHasLivePost(accountId: string, excludeId: string | null): Promise<boolean>;

  /**
   * Whether `accountId` has at least one live **top-level** forum row that
   * is not `excludeId`. Live = `deletedAt` null, `parentId` null, and
   * `accountId` equals the argument (Damus-only `accountId: null` rows
   * never match). `excludeId` is the auto profile note id; `null` excludes
   * nothing extra. Replies do not count.
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level row exists.
   */
  accountHasLiveTopLevelPost(accountId: string, excludeId: string | null): Promise<boolean>;

  /**
   * Whether `accountId` has at least one live **top-level** forum row that
   * is not `excludeId` and has media (photo 0, extra stills, or video).
   * Live = `deletedAt` null, `parentId` null, and `accountId` equals the
   * argument (Damus-only `accountId: null` rows never match). `excludeId`
   * is the auto profile note id; `null` excludes nothing extra. Replies
   * do not count.
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level media row exists.
   */
  accountHasLiveTopLevelMediaPost(accountId: string, excludeId: string | null): Promise<boolean>;

  /**
   * Newest live top-level photo or video for `accountId`, including the
   * About-me note. Not capped by the public list size.
   *
   * @param accountId - Author account id.
   * @returns Message id, or `null` when none.
   */
  latestLiveTopLevelMediaId(accountId: string): Promise<string | null>;

  /**
   * Live post/reply totals for one 21.gifts author.
   *
   * Live = `deletedAt` null and `accountId` equals the argument (Damus-only
   * `accountId: null` rows never match). `postCount` is `parentId === null`;
   * `replyCount` is `parentId !== null`. One query; not derived from a
   * capped list.
   *
   * @param accountId - Author account id.
   * @returns `{ postCount, replyCount }` (zeros when the account has no live rows).
   */
  countByAccount(accountId: string): Promise<AccountMessageCounts>;

  /**
   * Uncapped count of live attributed direct children of `parentId`.
   *
   * Live = `deletedAt` null. Attributed = `accountId` not null, or
   * `authorPubkey` is a recorded zapper. Unknown `parentId` is 0. Not
   * derived from a capped list.
   *
   * @param parentId - Parent message id.
   * @returns Count of matching children (0 when none or the id is unknown).
   */
  countAttributedReplies(parentId: string): Promise<number>;

  /**
   * Newest live top-level notes for `accountId` (`parentId` null,
   * `deletedAt` null), capped at `limit`, with `replyCount` of live
   * attributed children (`deletedAt` null and either an account or a
   * recorded zapper pubkey).
   *
   * @param accountId - Author account id.
   * @param limit - Maximum rows to return.
   * @returns Message list rows (caller-owned copies).
   */
  listPostsByAccount(accountId: string, limit: number): Promise<MessageListRow[]>;

  /**
   * Newest live replies for `accountId` (`parentId` not null, `deletedAt`
   * null), capped at `limit`. No `replyCount` — this is a member history
   * feed, not a thread.
   *
   * @param accountId - Author account id.
   * @param limit - Maximum rows to return.
   * @returns Reply rows (caller-owned copies).
   */
  listRepliesByAccount(accountId: string, limit: number): Promise<MessageRow[]>;

  /**
   * Load photo bytes for a message id.
   *
   * @param id - Message id.
   * @returns A copy of the photo, or `null` when missing / no photo.
   */
  getPhoto(id: string): Promise<ForumPhoto | null>;

  /**
   * Load one extra still (indices 1–9) for a message id.
   *
   * @param id - Message id.
   * @param index - Extra index (1–9). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range.
   */
  getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null>;

  /**
   * Extra stills for a message id, ordered by index ascending.
   *
   * @param id - Message id.
   * @returns Copies of extras (length 0–9). Empty when none.
   */
  listExtraPhotos(id: string): Promise<ForumPhoto[]>;

  /**
   * Delete a note, its direct replies, invoice attempts, zap receipts, photos,
   * and on-disk videos.
   *
   * @param id - Message id.
   * @returns True when a row was removed.
   */
  deleteById(id: string): Promise<boolean>;

  /**
   * Soft-hide a note and its direct replies by stamping `deletedAt` /
   * `deletedBy`. Does not remove rows, media, invoices, or zap receipts.
   *
   * @param id - Message id.
   * @param at - Hide timestamp (cloned onto newly tagged rows).
   * @param byAccountId - Staff account id recorded as `deletedBy`.
   * @returns `false` when no row has that id; `true` when the id exists
   *   (already tagged or newly tagged). An already-tagged target keeps its
   *   original stamps; untagged direct replies get this call's `at`/`by`.
   */
  markDeleted(id: string, at: Date, byAccountId: string): Promise<boolean>;

  /**
   * Unhide a note by clearing `deletedAt` / `deletedBy`. Inverse of
   * {@link MessageStore.markDeleted}'s cascade: when the target is hidden,
   * also clears every **direct** child whose stamps match the target's
   * (same instant and same staff) before the target is cleared. Already-live
   * targets are a no-op for children. Does not remove rows, media, invoices,
   * or zap receipts.
   *
   * @param id - Message id.
   * @returns `false` when no row has that id; `true` when the id exists
   *   (hidden or already live).
   */
  markUndeleted(id: string): Promise<boolean>;

  /**
   * Set, replace, or clear the stored map pin. Writes only `place_lat` /
   * `place_lng` / `place_label` (in-memory `place`). Does not change text,
   * sats, goals, media, hide stamps, event ids, or publish state.
   *
   * @param id - Message id.
   * @param place - Pin to store, or `null` to store SQL NULL / `place: null`.
   * @returns `false` when no row has that id; `true` when the three columns
   *   were written.
   */
  setPlace(id: string, place: ForumPlace | null): Promise<boolean>;

  /**
   * Set, replace, or clear the linked 21.gifts shop account. Writes only
   * `shop_account_id` (in-memory `shopAccount`). Does not change text, sats,
   * goals, place, media, hide stamps, event ids, or publish state.
   *
   * @param id - Message id.
   * @param account - Account snapshot to store, or `null` to clear.
   * @returns `false` when no row has that id; `true` when the column was written.
   */
  setShopAccount(
    id: string,
    account: { id: string; username: string; name: string } | null,
  ): Promise<boolean>;

  /**
   * Direct children of `parentId` (`parentId` match), including hidden,
   * Damus-only (`accountId` null), and gift-only rows. Oldest `createdAt`
   * then `id` first. Missing parent → `[]`.
   *
   * @param parentId - Parent message id.
   * @returns Child row copies (caller-owned).
   */
  listDirectChildren(parentId: string): Promise<MessageRow[]>;

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
   * Rows at or above `MAX_PUBLISH_ATTEMPTS` (5) are excluded so a row that can
   * never satisfy a repair scan is not reset forever.
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
   * Rows at or above `MAX_PUBLISH_ATTEMPTS` (5) are excluded so a row that can
   * never satisfy a repair scan is not reset forever.
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
   * first. Rows at or above `MAX_PUBLISH_ATTEMPTS` (5) are excluded so a row
   * that can never satisfy a repair scan is not reset forever. Includes
   * `nostrEvent === null` and non-string content. One-arg calls still select
   * bitcoin/21gifts only. When `extraHashtagsByAccountId` maps an account id
   * to extra hashtag names (without `#`), those accounts' rows are also
   * listed when content lacks that token. Optional `excludeIds` is applied
   * before the limit so profile notes cannot fill the batch.
   *
   * @param limit - Max rows.
   * @param extraHashtagsByAccountId - Optional extra Damus tokens per account.
   * @param excludeIds - Optional ids dropped before sort/limit (profile notes).
   */
  listSignedMissingHashtags(
    limit: number,
    extraHashtagsByAccountId?: ReadonlyMap<string, readonly string[]>,
    excludeIds?: ReadonlySet<string>,
  ): Promise<MessageRow[]>;

  /**
   * Clear the signed event and park the row `pending` so it is signed again.
   * No-op unless `eventId` still matches `expectedEventId`, `sats` is 0, and
   * the note has no child replies.
   * A successful reset increments `nostrAttempts` and stamps
   * `nostrFirstAttemptAt` once when it is still unset.
   *
   * @param id - Message id.
   * @param expectedEventId - Event id observed when the row was listed.
   */
  resetSignedEvent(id: string, expectedEventId: string | null): Promise<void>;

  /**
   * Replace the stored note body. Does not change sats, photos, or event ids.
   *
   * @param id - Message id.
   * @param text - New body (already normalised; may be empty).
   * @returns The updated row copy, or `undefined` when no row has that id.
   */
  updateText(id: string, text: string): Promise<MessageRow | undefined>;

  /**
   * Replace or clear the stored photo. Does not change text, sats, or event ids.
   * Does not recompute `content_fp` (same as `updateText`).
   *
   * @param id - Message id.
   * @param photo - Decoded photo to store, or `null` to clear.
   * @returns The updated row copy (`hasPhoto` true iff photo is non-null), or
   *   `undefined` when no row has that id.
   */
  updatePhoto(id: string, photo: ForumPhoto | null): Promise<MessageRow | undefined>;

  /** Persist a signed event id + JSON. Returns false on event-id collision. */
  updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean>;

  /** Mark space ACK (park) or published after public quorum. */
  updatePublishState(id: string, state: NostrPublishState, epoch: string | null): Promise<void>;

  /** Add validated zap sats and the matching payment-time fiat delta. */
  addSats(id: string, extraSats: number, delta: FiatAmounts | null): Promise<void>;

  /**
   * Sum of zap sats per 21.gifts payer of one note.
   *
   * @param messageId - Forum note.
   * @returns Positive contributions. External payers without an account are omitted.
   */
  listCreditPayers(messageId: string): Promise<
    {
      accountId: string;
      sats: number;
      usd: string | null;
      chf: string | null;
      eur: string | null;
      php: string | null;
    }[]
  >;

  /**
   * Sats on this note whose zap has no 21.gifts payer account.
   *
   * @param messageId - Forum note.
   * @returns Those sats. They are not part of the repayment plan.
   */
  sumUnassignedCreditSats(messageId: string): Promise<number>;

  /**
   * Repayment shares already paid on one credit.
   *
   * @param messageId - Credit note.
   * @returns One row per paid giver-day.
   */
  listRepayments(
    messageId: string,
  ): Promise<{ dayIndex: number; recipientAccountId: string; dueSats: number; paidAt: Date }[]>;

  /**
   * Record one paid repayment share. A repeat of the same day and giver is a no-op.
   *
   * @param row - Share that a zap just settled.
   */
  markRepaymentPaid(row: {
    messageId: string;
    dayIndex: number;
    recipientAccountId: string;
    dueSats: number;
    paidAt: Date;
  }): Promise<void>;

  /**
   * Claim a lowercase payment hash for one receipt, preserving the claim
   * independently of forum-message deletion.
   *
   * @param paymentHash - BOLT11 payment hash; stored lowercase.
   * @param receiptEventId - Kind:9735 or synthetic receipt event id.
   * @param at - Claim creation time.
   * @returns `true` when inserted or already owned by `receiptEventId`; `false`
   *   when another receipt event id owns the hash.
   * @throws Propagates persistence failures.
   */
  claimZapPayment(paymentHash: string, receiptEventId: string, at: Date): Promise<boolean>;

  /**
   * Persist a zap receipt once and add its sats to the message.
   * Both adapters forget the receipt id when {@link MessageStore.deleteById}
   * removes that message, so the same event id may be recorded again.
   *
   * @param receiptEventId - Kind:9735 event id (unique while held).
   * @param messageId - Forum row to credit.
   * @param sats - Whole sats to add.
   * @returns `true` when the receipt was new and sats were added; `false` on
   *   duplicate receipt id (no second add).
   */
  recordZapReceipt(
    receiptEventId: string,
    messageId: string,
    sats: number,
    delta: FiatAmounts | null,
  ): Promise<boolean>;

  /** Append one POST /messages/:id/invoice attempt (success or failure). */
  recordInvoiceAttempt(row: MessageInvoiceAttempt): Promise<void>;

  /** Newest invoice attempts first, capped at `limit`. */
  listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]>;

  /**
   * Newest `result = 'ok'` invoice attempts created at or after `since`, capped at `limit`.
   * Same sort as {@link MessageStore.listInvoiceAttempts} (`createdAt` DESC, `id` DESC).
   *
   * @param since - Inclusive lower bound on `createdAt`.
   * @param limit - Maximum rows.
   * @returns Matching attempts (caller-owned copies).
   */
  listRecentOkInvoiceAttempts(since: Date, limit: number): Promise<MessageInvoiceAttempt[]>;

  /**
   * Invoice attempts for one payer, newest-first, **no debug cap**.
   * Same sort as {@link MessageStore.listInvoiceAttempts}
   * (`createdAt` DESC, `id` DESC).
   *
   * @param payerAccountId - Payer account id.
   * @returns Every matching attempt (caller-owned copies).
   */
  listInvoiceAttemptsForPayer(payerAccountId: string): Promise<MessageInvoiceAttempt[]>;

  /** Append one kind:9735 ingest decision (indexed or rejected). */
  recordZapIngest(row: ZapIngestRow): Promise<void>;

  /** Newest zap ingest rows first, capped at `limit`. */
  listZapIngests(limit: number): Promise<ZapIngestRow[]>;

  /**
   * Extra still metadata (no photo bytes), newest parent first, capped at
   * `limit`. Operator dump.
   *
   * @param limit - Maximum rows.
   * @returns `{ messageId, idx, photoContentType, bytes, photoTakenAt }` lengths.
   */
  listExtraPhotoMeta?(limit: number): Promise<
    Array<{
      messageId: string;
      idx: number;
      photoContentType: string;
      bytes: number;
      photoTakenAt: string | null;
    }>
  >;

  /**
   * Zap receipts by `eventId` descending, capped at `limit`. Operator dump.
   * `nostr_zap_receipt` has no `created_at`; dump order is the event id.
   *
   * @param limit - Maximum rows.
   * @returns Receipt JSON rows.
   */
  listZapReceipts?(limit: number): Promise<ZapReceiptDumpRow[]>;

  /**
   * Zap payment-hash tombstones newest-first, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Payment JSON rows.
   */
  listZapPayments?(
    limit: number,
  ): Promise<Array<{ paymentHash: string; receiptEventId: string; createdAt: string }>>;

  /**
   * Indexed kind:9735 ingests, newest-first, **no debug cap**.
   * Same sort as {@link MessageStore.listZapIngests}.
   *
   * @returns Every row with `outcome === 'indexed'` (caller-owned copies).
   */
  listIndexedZapIngests(): Promise<ZapIngestRow[]>;

  /**
   * Newest indexed receipt frames that have no payer attribution yet, ordered
   * by ingest creation time then receipt event id descending.
   *
   * @param limit - Maximum rows to return.
   * @param before - Optional strict keyset cursor. Only rows ordered after this
   *   immutable ingest creation time and receipt event id pair are returned.
   *   This avoids skips or repeats when attribution changes between pages,
   *   unlike an `OFFSET` over the changing unattributed result set.
   * @returns Receipt/frame pairs newest-first.
   */
  listUnattributedIndexedReceipts(
    limit: number,
    before?: { createdAt: Date; eventId: string },
  ): Promise<UnattributedIndexedReceipt[]>;

  /**
   * Every forum row this account authored, including hidden notes
   * (`deletedAt` set) and replies. Newest-first (`createdAt` DESC, `id`
   * DESC). **No debug cap.**
   *
   * @param accountId - Author account id.
   * @returns Matching row copies (caller-owned).
   */
  listAuthoredMessages(accountId: string): Promise<MessageRow[]>;

  /**
   * Newest `result === 'ok'` invoice with this payment hash, or `undefined`.
   *
   * @param paymentHash - BOLT11 payment hash (hex).
   */
  findOkInvoiceByPaymentHash(paymentHash: string): Promise<MessageInvoiceAttempt | undefined>;

  /**
   * Newest `result === 'ok'` invoice with this BOLT11 `pr`, or `undefined`.
   *
   * @param pr - BOLT11 payment request.
   */
  findOkInvoiceByPr(pr: string): Promise<MessageInvoiceAttempt | undefined>;

  /**
   * NIP-57 `e`-tag event ids from successful private-conversation invoices,
   * each paired with the predetermined conversation message id. Missing,
   * malformed, and empty tags are omitted. Only ok invoices with a non-null
   * conversation id and a non-null conversation message id. Adapters may
   * pre-filter invoices whose conversation message already exists; callers
   * must still re-check. Event ids may repeat (the `e` tag is the recipient's
   * profile note, shared by every invoice to that recipient): callers dedupe.
   *
   * @returns `{ eventId, conversationMessageId }` pairs for open PN invoices.
   */
  listOpenConversationZapEventIds(): Promise<
    ReadonlyArray<{ eventId: string; conversationMessageId: string }>
  >;

  /**
   * Atomically attach a verified external payer request to a receipt.
   *
   * @param receiptEventId - Receipt to attribute.
   * @param attribution - External pubkey, unique request id, and comment.
   * @returns `false` when the receipt is missing, already holds a different
   *   request id, or another receipt holds the request id; otherwise `true`.
   */
  attributeZapReceipt(
    receiptEventId: string,
    attribution: { payerPubkey: string; zapRequestId: string; comment: string },
  ): Promise<boolean>;

  /**
   * Record permanent external-zapper visibility entitlement, first write wins.
   *
   * @param pubkey - External author pubkey (stored lower-case).
   * @param receiptEventId - Kind:9735 event id that first proved the zap.
   * @param at - Time of the first recording.
   * @returns Resolves once the row exists; an existing row is left unchanged.
   */
  recordZapper(pubkey: string, receiptEventId: string, at: Date): Promise<void>;

  /**
   * List all entitled external pubkeys.
   *
   * @returns Lower-case pubkeys of every recorded external zapper.
   */
  listZapperPubkeys(): Promise<string[]>;

  /**
   * Whether one external pubkey is a recorded zapper (has the read-visibility entitlement).
   *
   * @param pubkey - External author pubkey, compared case-insensitively.
   * @returns `true` when a zapper entitlement row exists for that pubkey.
   */
  isZapperPubkey(pubkey: string): Promise<boolean>;

  /**
   * List newest external-zapper entitlement rows for operator debug.
   *
   * @param limit - Maximum number of rows.
   * @returns Rows newest first, ties broken by pubkey descending.
   */
  listZappers(limit: number): Promise<NostrZapperRow[]>;

  /**
   * Atomically record a staff block for an external pubkey and soft-hide every
   * live null-account row authored by that pubkey. The block is stored in
   * lower-case and remains first-write-wins, while author matching is
   * case-insensitive.
   *
   * @param pubkey - External author pubkey to block and match case-insensitively.
   * @param at - Shared block and hide timestamp for every affected row.
   * @param byAccountId - Staff account that created the block and hid the rows.
   * @param messageId - Message whose deletion caused the block.
   * @returns Number of previously-live rows newly hidden by the cascade. A row
   *   hidden by an earlier `markDeleted` call is not included.
   */
  blockPubkeyAndHideRows(
    pubkey: string,
    at: Date,
    byAccountId: string,
    messageId: string,
  ): Promise<number>;

  /**
   * Remove the block whose own `message_id` equals one restored message. This
   * succeeds only when `messageId` is the row whose hide created the block,
   * not another row hidden by that block's external-author cascade. Restoring
   * such a cascaded row through `markUndeleted` makes that row live but leaves
   * the block in place because its id does not match.
   *
   * @param messageId - Restored message id.
   * @returns `true` when a block was removed.
   */
  unblockPubkeyByMessage(messageId: string): Promise<boolean>;

  /**
   * Whether one external pubkey is currently blocked.
   *
   * @param pubkey - External author pubkey, compared case-insensitively.
   * @returns `true` when a block row exists for that pubkey.
   */
  isPubkeyBlocked(pubkey: string): Promise<boolean>;

  /**
   * List every blocked external pubkey.
   *
   * @returns Lower-case pubkeys of every block row.
   */
  listBlockedPubkeys(): Promise<string[]>;

  /**
   * List newest external-pubkey block rows for operator debug.
   *
   * @param limit - Maximum number of rows.
   * @returns Rows newest first, ties broken by pubkey descending.
   */
  listBlockedPubkeyRows(limit: number): Promise<NostrBlockedPubkeyRow[]>;

  /**
   * Patch payer / gift-reply id / comment on a stored zap receipt in one
   * update. Missing receipts are a no-op. Omitted patch fields are left unchanged.
   *
   * @param receiptEventId - Kind:9735 event id.
   * @param patch - Optional payer, gift-reply id, and comment.
   */
  updateZapReceiptGift(receiptEventId: string, patch: ZapReceiptGiftPatch): Promise<void>;

  /**
   * One stored zap receipt, or `undefined` when missing.
   *
   * @param receiptEventId - Kind:9735 event id.
   */
  getZapReceiptGift(receiptEventId: string): Promise<ZapReceiptGiftState | undefined>;

  /**
   * Receipts with a known payer and no gift reply yet (retry queue).
   *
   * @param limit - Max rows.
   */
  listZapReceiptsAwaitingGiftReply(limit: number): Promise<ZapReceiptGiftRow[]>;
}

/** Patch fields for {@link MessageStore.updateZapReceiptGift}. */
export type ZapReceiptGiftPatch = {
  /** 21.gifts payer account id; null dequeues it from listZapReceiptsAwaitingGiftReply. */
  payerAccountId?: string | null;
  /** External payer pubkey; null dequeues it from listZapReceiptsAwaitingGiftReply. */
  payerPubkey?: string | null;
  /** Gift-reply message id, or null to clear the stored link. */
  giftReplyId?: string | null;
  /** Normalised zap comment to reuse on retry. */
  comment?: string;
};

/** Stored zap receipt including gift-reply link state. */
export interface ZapReceiptGiftState {
  /** Kind:9735 event id. */
  receiptEventId: string;
  /** Parent forum note id. */
  messageId: string;
  /** Whole sats credited on the parent. */
  sats: number;
  /** 21.gifts payer account id, or null when unresolved / abandoned. */
  payerAccountId: string | null;
  /** External payer pubkey, or null. */
  payerPubkey: string | null;
  /** Verified kind:9734 id, or null. */
  zapRequestId: string | null;
  /** Gift-reply message id, or null when not inserted yet. */
  giftReplyId: string | null;
  /** Normalised zap comment to reuse on retry. */
  comment: string;
}

/** Indexed zap receipt that still needs a forum gift-reply row. */
export interface ZapReceiptGiftRow {
  /** Kind:9735 event id. */
  receiptEventId: string;
  /** Parent forum note id. */
  messageId: string;
  /** Whole sats credited on the parent. */
  sats: number;
  /** 21.gifts payer account id. */
  payerAccountId: string | null;
  /** External payer pubkey, or null. */
  payerPubkey: string | null;
  /** Verified kind:9734 id, or null. */
  zapRequestId: string | null;
  /** Receipt event time when available from the indexed frame. */
  receiptCreatedAt: Date | null;
  /** Normalised zap comment to reuse on retry. */
  comment: string;
}

/** Operator dump of one `nostr_zap_receipt` row. */
export interface ZapReceiptDumpRow {
  /** Kind:9735 event id. */
  eventId: string;
  /** Credited forum note id. */
  messageId: string;
  /** Whole sats. */
  sats: number;
  /** 21.gifts payer account id, or `null`. */
  payerAccountId: string | null;
  /** External payer pubkey, or `null`. */
  payerPubkey: string | null;
  /** Zap-request event id, or `null`. */
  zapRequestId: string | null;
  /** Gift-reply message id, or `null`. */
  giftReplyId: string | null;
  /** Normalised zap comment. */
  comment: string;
}

/** External pubkey entitled by its first verified zap. */
export interface NostrZapperRow {
  /** Lowercase external pubkey. */
  pubkey: string;
  /** Receipt that first established entitlement. */
  receiptEventId: string;
  /** Entitlement creation time. */
  createdAt: Date;
}

/** Staff block for one external pubkey. */
export interface NostrBlockedPubkeyRow {
  /** Lowercase external pubkey. */
  pubkey: string;
  /** Block creation time. */
  blockedAt: Date;
  /** Staff account that created the block. */
  blockedBy: string;
  /** External message whose deletion created the block. */
  messageId: string;
}

/** Indexed receipt and its stored frame awaiting payer attribution. */
export interface UnattributedIndexedReceipt {
  /** Receipt event id. */
  receiptEventId: string;
  /** Credited forum message id. */
  messageId: string;
  /** Credited whole sats. */
  sats: number;
  /** Time the indexed frame was persisted. */
  createdAt: Date;
  /** Stored kind:9735 event frame. */
  receipt: Record<string, unknown>;
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
  /** Private conversation receiving the paid message; null/omitted for forum invoices. */
  conversationId?: string | null;
  /** Predetermined private-message row id; null/omitted for forum invoices. */
  conversationMessageId?: string | null;
  /**
   * True when the payer sent the four amounts they were shown.
   * A pinned snapshot is stored as-is, including nulls, and is not replaced by a later spot.
   */
  fiatPinned?: boolean;
  amountUsd?: string | null;
  amountChf?: string | null;
  amountEur?: string | null;
  amountPhp?: string | null;
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
  amountUsd?: string | null;
  amountChf?: string | null;
  amountEur?: string | null;
  amountPhp?: string | null;
  receiptPubkey: string | null;
  receipt: Record<string, unknown>;
}

/**
 * Idempotent SQL for forum messages and their payment records.
 *
 * Includes the no-foreign-key payment-claim tombstone and the boot-time unwrap
 * of `nostr_event` values stored as JSONB string scalars.
 * `docs/schema/message.sql` mirrors the DDL and documents the repair; the
 * `DO $unwrap$` block lives only in this array.
 */
export const MESSAGE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  photo bytea,
  photo_content_type text,
  photo_taken_at text,
  created_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS photo bytea`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS photo_content_type text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS event_id text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_publish_state text NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
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
  `ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS payer_account_id uuid`,
  `ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS payer_pubkey text`,
  `ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS zap_request_id text`,
  `ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS gift_reply_id uuid REFERENCES message (id)`,
  `ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS comment text NOT NULL DEFAULT ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS nostr_zap_receipt_request_uidx ON nostr_zap_receipt (zap_request_id) WHERE zap_request_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS nostr_zap_receipt_gift_reply_id_uidx ON nostr_zap_receipt (gift_reply_id) WHERE gift_reply_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS nostr_zapper (
  pubkey text PRIMARY KEY,
  receipt_event_id text NOT NULL,
  created_at timestamptz NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS nostr_blocked_pubkey (
  pubkey text PRIMARY KEY,
  blocked_at timestamptz NOT NULL,
  blocked_by uuid NOT NULL,
  message_id uuid NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS nostr_zap_payment (
  payment_hash text PRIMARY KEY,
  receipt_event_id text NOT NULL,
  created_at timestamptz NOT NULL
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
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS conversation_id uuid`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS conversation_message_id uuid`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS fiat_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
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
  `ALTER TABLE nostr_zap_ingest ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE nostr_zap_ingest ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE nostr_zap_ingest ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE nostr_zap_ingest ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
  `CREATE INDEX IF NOT EXISTS nostr_zap_ingest_receipt_id_idx
  ON nostr_zap_ingest (receipt_id)`,
  `CREATE INDEX IF NOT EXISTS nostr_zap_ingest_created_at_idx
  ON nostr_zap_ingest (created_at DESC, id DESC)`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_profile_message_id_fkey`,
  `ALTER TABLE account ADD CONSTRAINT account_profile_message_id_fkey
  FOREIGN KEY (profile_message_id) REFERENCES message (id) ON DELETE SET NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_profile_message_uidx
  ON account (profile_message_id) WHERE profile_message_id IS NOT NULL`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_by uuid`,
  `CREATE INDEX IF NOT EXISTS message_nostr_event_unrepaired_idx
  ON message (id)
  WHERE nostr_event IS NOT NULL AND jsonb_typeof(nostr_event) = 'string'`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS content_fp text`,
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  // A photo row can still have a null fingerprint after the indexes exist
  // (`updatePhoto` does not recompute it). Filling that null while the
  // unique indexes are present aborts boot before duplicate salting.
  `DROP INDEX IF EXISTS message_live_top_content_fp_uidx`,
  `DROP INDEX IF EXISTS message_live_reply_content_fp_uidx`,
  `UPDATE message
SET content_fp = encode(
  digest(
    convert_to(text, 'UTF8') || decode('00', 'hex') || digest(photo, 'sha256'),
    'sha256'
  ),
  'hex'
)
WHERE photo IS NOT NULL AND content_fp IS NULL AND video_content_type IS NULL`,
  `WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY account_id, content_fp
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM message
  WHERE deleted_at IS NULL AND parent_id IS NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL
)
UPDATE message
SET content_fp = content_fp || ':' || message.id::text
FROM ranked
WHERE message.id = ranked.id AND ranked.rn > 1`,
  `WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY account_id, parent_id, content_fp
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM message
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL
)
UPDATE message
SET content_fp = content_fp || ':' || message.id::text
FROM ranked
WHERE message.id = ranked.id AND ranked.rn > 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_live_top_content_fp_uidx
  ON message (account_id, content_fp)
  WHERE deleted_at IS NULL AND parent_id IS NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_live_reply_content_fp_uidx
  ON message (account_id, parent_id, content_fp)
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS message_extra_photo (
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  idx smallint NOT NULL,
  photo bytea NOT NULL,
  photo_content_type text NOT NULL,
  photo_taken_at text,
  PRIMARY KEY (message_id, idx),
  CONSTRAINT message_extra_photo_idx_range CHECK (idx >= 1 AND idx <= 9)
)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_sats bigint`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS photo_taken_at text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS video_taken_at text`,
  `ALTER TABLE message_extra_photo ADD COLUMN IF NOT EXISTS photo_taken_at text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS place_lat double precision`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS place_lng double precision`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS place_label text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS shop_account_id uuid REFERENCES account (id) ON DELETE SET NULL`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS mentions jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_currency text`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_amount numeric(20, 8)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_fiat_usd numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_fiat_chf numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_fiat_eur numeric(20, 2)`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_fiat_php numeric(20, 2)`,
  `DO $message_goal_currency$
BEGIN
  ALTER TABLE message DROP CONSTRAINT IF EXISTS message_goal_currency_check;
  ALTER TABLE message ADD CONSTRAINT message_goal_currency_check
    CHECK (goal_currency IS NULL OR goal_currency IN ('BTC','USD','CHF','EUR','PHP'));
END
$message_goal_currency$`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_repayable boolean`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_term_days integer`,
  `ALTER TABLE message ADD COLUMN IF NOT EXISTS goal_funded_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS message_repayment (
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  day_index integer NOT NULL,
  recipient_account_id uuid NOT NULL,
  due_sats bigint NOT NULL,
  paid_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, day_index, recipient_account_id)
)`,
  `DO $message_goal_repayable$
BEGIN
  ALTER TABLE message DROP CONSTRAINT IF EXISTS message_goal_repayable_chk;
  ALTER TABLE message ADD CONSTRAINT message_goal_repayable_chk
    CHECK (goal_repayable IS NOT TRUE OR (parent_id IS NULL AND goal_sats IS NOT NULL));
END
$message_goal_repayable$`,
  `DO $message_goal_term_days$
BEGIN
  ALTER TABLE message DROP CONSTRAINT IF EXISTS message_goal_term_days_chk;
  ALTER TABLE message ADD CONSTRAINT message_goal_term_days_chk
    CHECK (goal_term_days IS NULL OR (goal_repayable IS TRUE AND goal_term_days BETWEEN 1 AND 3650));
END
$message_goal_term_days$`,
  `CREATE INDEX IF NOT EXISTS message_feed_created_idx ON message (created_at DESC, id DESC) WHERE parent_id IS NULL AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS message_feed_popular_idx ON message (sats DESC, created_at DESC, id DESC) WHERE parent_id IS NULL AND deleted_at IS NULL AND sats > 0`,
  TRANSLATION_SCHEMA_SQL,
  `DO $unwrap$
   DECLARE
     repair_row RECORD;
     unwrapped jsonb;
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_trigger
       WHERE tgrelid = 'message'::regclass
         AND tgname = 'trg_db_change'
         AND NOT tgisinternal
     ) THEN
       RETURN;
     END IF;

     FOR repair_row IN
       SELECT id, nostr_event
       FROM message
       WHERE nostr_event IS NOT NULL
         AND jsonb_typeof(nostr_event) = 'string'
     LOOP
       BEGIN
         unwrapped := (repair_row.nostr_event #>> '{}')::jsonb;
       EXCEPTION WHEN data_exception OR statement_too_complex THEN
         RAISE WARNING 'Could not unwrap nostr_event for message id %', repair_row.id;
         CONTINUE;
       END;

       UPDATE message
       SET nostr_event = unwrapped,
           nostr_attempts = 0
       WHERE id = repair_row.id
         AND nostr_event IS NOT NULL
         AND jsonb_typeof(nostr_event) = 'string'
         AND nostr_event = repair_row.nostr_event;
     END LOOP;
   END;
   $unwrap$;`,
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
  await backfillMessageFiat(sql, 'message', 'sats');
  await backfillMessageFiat(sql, 'nostr_zap_ingest', 'amount_sats');
}

interface MessageFiatBackfillRow {
  id: string;
  created_at: Date | string;
  amount_sats: number | string | bigint;
}

interface MessageFiatBackfillRateRow {
  day: Date | string;
  usd_per_btc: string | number;
  quote: string | null;
  rate: string | number | null;
}

/** UTC day, or `null` when the stored instant is not a real timestamp. */
function utcDayOrNull(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Network-free, idempotent stored-fiat backfill for one message payment table. */
async function backfillMessageFiat(
  sql: SqlClient,
  table: 'message' | 'nostr_zap_ingest',
  satsColumn: 'sats' | 'amount_sats',
): Promise<void> {
  const candidates = await sql.query<MessageFiatBackfillRow>(
    `SELECT id, created_at, ${satsColumn} AS amount_sats
     FROM ${table}
     WHERE ${satsColumn} > 0 AND fiat_usd IS NULL`,
  );
  const days = [
    ...new Set(
      candidates.flatMap((row) => {
        const day = utcDayOrNull(row.created_at);
        return day === null ? [] : [day];
      }),
    ),
  ];
  if (days.length === 0) {
    return;
  }
  const placeholders = days.map((_, index) => `$${index + 1}::date`).join(', ');
  const rateRows = await sql.query<MessageFiatBackfillRateRow>(
    `SELECT b.day::text AS day, b.usd_per_btc::text AS usd_per_btc,
            f.quote, f.rate::text AS rate
     FROM btc_usd_daily b
     LEFT JOIN usd_fiat_daily f ON f.day = b.day AND f.quote IN ('CHF', 'EUR', 'PHP')
     WHERE b.day IN (${placeholders})`,
    days,
  );
  const rates = new Map<string, { usdPerBtc: string; crosses: Record<string, string> }>();
  for (const row of rateRows) {
    const day = String(row.day).slice(0, 10);
    const value = rates.get(day) ?? { usdPerBtc: String(row.usd_per_btc), crosses: {} };
    if (row.quote !== null && row.rate !== null) {
      value.crosses[row.quote] = String(row.rate);
    }
    rates.set(day, value);
  }
  for (const row of candidates) {
    const day = utcDayOrNull(row.created_at);
    if (day === null) {
      continue;
    }
    const rate = rates.get(day);
    if (rate === undefined) {
      continue;
    }
    const usdCents = satsToUsdCents(Number(row.amount_sats), rate.usdPerBtc);
    const quote = (code: 'CHF' | 'EUR' | 'PHP'): string | null => {
      const cross = rate.crosses[code];
      return cross === undefined ? null : usdCentsToString(usdCentsToFiatCents(usdCents, cross));
    };
    await sql.execute(
      `UPDATE ${table}
       SET fiat_usd = $2::numeric, fiat_chf = $3::numeric,
           fiat_eur = $4::numeric, fiat_php = $5::numeric
       WHERE id = $1 AND fiat_usd IS NULL`,
      [row.id, usdCentsToString(usdCents), quote('CHF'), quote('EUR'), quote('PHP')],
    );
  }
}

/** Copy a {@link ForumPhoto} so callers cannot mutate store buffers. */
function copyPhoto(photo: ForumPhoto): ForumPhoto {
  const copy: ForumPhoto = { contentType: photo.contentType, bytes: photo.bytes.slice() };
  if (photo.takenAt === null || photo.takenAt === undefined) {
    return copy;
  }
  copy.takenAt = photo.takenAt;
  return copy;
}

/** Civil capture times of length `photoCount` (null slots when omitted). */
function padPhotoTakenAts(
  stored: (string | null)[] | undefined,
  photoCount: number,
): (string | null)[] {
  if (photoCount === 0) {
    return [];
  }
  const times: (string | null)[] = [];
  for (let i = 0; i < photoCount; i += 1) {
    const slot = stored === undefined ? undefined : stored[i];
    times.push(typeof slot === 'string' ? slot : null);
  }
  return times;
}

/** Capture times stored on create (video already cleared extras). */
function photoTakenAtsForCreate(
  photo: ForumPhoto | undefined,
  extras: readonly ForumPhoto[],
): (string | null)[] {
  if (photo === undefined) {
    return [];
  }
  return [photo.takenAt ?? null, ...extras.map((item) => item.takenAt ?? null)];
}

/** Exclusive keyset predicate matching Postgres `(created_at, id) <` / `(sats, created_at, id) <`. */
function matchesFeedCursor(row: MessageRow, query: MessageFeedQuery): boolean {
  const cursor = query.cursor;
  if (cursor === null) {
    return true;
  }
  if (query.mode === 'popular') {
    if (cursor.k !== 's') {
      return true;
    }
    if (row.sats !== cursor.s) {
      return row.sats < cursor.s;
    }
  } else if (cursor.k !== 't') {
    return true;
  }
  const byTime = row.createdAt.getTime() - cursor.c.getTime();
  if (byTime !== 0) {
    return byTime < 0;
  }
  return row.id.localeCompare(cursor.i) < 0;
}

/** Copy a row so callers cannot mutate store internals. */
function copyRow(row: MessageRow): MessageRow {
  const deletedAt = row.deletedAt ?? null;
  const place = row.place;
  const copy: MessageRow = {
    ...row,
    hasPhoto: row.hasPhoto === true,
    hasVideo: row.hasVideo === true,
    videoContentType: row.videoContentType ?? null,
    parentId: row.parentId ?? null,
    authorPubkey: row.authorPubkey ?? null,
    accountId: row.accountId ?? null,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    goalSats: row.goalSats ?? null,
    goalRepayable: row.goalRepayable === true ? true : null,
    goalTermDays: row.goalTermDays ?? null,
    goalFundedAt:
      row.goalFundedAt === undefined || row.goalFundedAt === null
        ? null
        : new Date(row.goalFundedAt.getTime()),
    goalCurrency: row.goalCurrency ?? null,
    goalAmount: row.goalAmount ?? null,
    goalAmountUsd: row.goalAmountUsd ?? null,
    goalAmountChf: row.goalAmountChf ?? null,
    goalAmountEur: row.goalAmountEur ?? null,
    goalAmountPhp: row.goalAmountPhp ?? null,
    createdAt: new Date(row.createdAt.getTime()),
    deletedAt: deletedAt === null ? null : new Date(deletedAt.getTime()),
    deletedBy: row.deletedBy ?? null,
    nostrEvent: row.nostrEvent === null ? null : { ...row.nostrEvent },
    place:
      place === undefined || place === null
        ? null
        : { lat: place.lat, lng: place.lng, label: place.label },
  };
  if (row.mentions !== undefined && row.mentions.length > 0) {
    copy.mentions = row.mentions.map((mark) => ({
      accountId: mark.accountId,
      username: mark.username,
    }));
  }
  // Absent on old rows. Assigning `undefined` breaks exactOptionalPropertyTypes.
  if (row.photoTakenAts !== undefined) {
    copy.photoTakenAts = [...row.photoTakenAts];
  }
  const shopAccount = row.shopAccount;
  copy.shopAccount =
    shopAccount === undefined || shopAccount === null
      ? null
      : { id: shopAccount.id, username: shopAccount.username, name: shopAccount.name };
  return copy;
}

/** Newest `result === 'ok'` invoice matching `predicate`, or `undefined`. */
function newestOkInvoice(
  rows: readonly MessageInvoiceAttempt[],
  predicate: (row: MessageInvoiceAttempt) => boolean,
): MessageInvoiceAttempt | undefined {
  const matches = rows
    .filter((row) => row.result === 'ok' && predicate(row))
    .sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
  const first = matches[0];
  return first === undefined ? undefined : copyInvoiceAttempt(first);
}

function copyInvoiceAttempt(row: MessageInvoiceAttempt): MessageInvoiceAttempt {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    zapRequest: row.zapRequest === null ? null : { ...row.zapRequest },
    lnurlResponse: row.lnurlResponse === null ? null : { ...row.lnurlResponse },
    conversationId: row.conversationId ?? null,
    conversationMessageId: row.conversationMessageId ?? null,
  };
}

/** Return the first non-empty NIP-57 `e` tag from a stored zap request. */
function zapRequestEventId(zapRequest: Record<string, unknown> | null): string | null {
  const tags = zapRequest?.['tags'];
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string' && tag[1] !== '') {
      return tag[1];
    }
  }
  return null;
}

/** Copy a zap ingest row so callers cannot mutate store internals. */
function copyZapIngest(row: ZapIngestRow): ZapIngestRow {
  return {
    ...row,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    createdAt: new Date(row.createdAt.getTime()),
    receipt: { ...row.receipt },
  };
}

function addPayerCents(current: bigint | null, amount: string | null | undefined): bigint | null {
  if (current === null || amount === null || amount === undefined) {
    return null;
  }
  const cents = fiatAmountToCents(amount);
  if (cents === null) {
    return null;
  }
  return current + cents;
}

function centsToAmount(cents: bigint): string {
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

/** In-memory zap receipt (parent credit + optional gift-reply link). */
interface MemoryZapReceipt {
  messageId: string;
  sats: number;
  payerAccountId: string | null;
  payerPubkey: string | null;
  zapRequestId: string | null;
  giftReplyId: string | null;
  comment: string;
}

/**
 * Process-local {@link MessageStore}. Used in tests and when no database URL
 * is configured — the process still boots. Photos live in a private map, not
 * on listed rows.
 */
export class InMemoryMessageStore implements MessageStore {
  readonly #rows: MessageRow[];
  #profileNoteIds: (() => Promise<ReadonlySet<string>> | ReadonlySet<string>) | undefined =
    undefined;
  /** Kind:9735 event id → receipt; cleared when that parent message is deleted. */
  readonly #receipts = new Map<string, MemoryZapReceipt>();
  readonly #repayments: {
    messageId: string;
    dayIndex: number;
    recipientAccountId: string;
    dueSats: number;
    paidAt: Date;
  }[] = [];
  /** Lowercase payment hash → durable-for-process receipt ownership tombstone. */
  readonly #zapPayments = new Map<string, { receiptEventId: string; createdAt: Date }>();
  readonly #photos = new Map<string, ForumPhoto>();
  /** Extra stills; array index 0 = idx 1. */
  readonly #extraPhotos = new Map<string, ForumPhoto[]>();
  readonly #invoiceAttempts: MessageInvoiceAttempt[] = [];
  readonly #zapIngests: ZapIngestRow[] = [];
  readonly #zappers = new Map<string, NostrZapperRow>();
  readonly #blockedPubkeys = new Map<string, NostrBlockedPubkeyRow>();
  readonly #paymentFiat: Required<PaymentFiatStoreOptions>;

  /**
   * @param seed - Optional seed rows; copied into private storage. Seeded rows
   * default to `hasPhoto: false` when omitted on the input object.
   */
  constructor(seed: readonly MessageRow[] = [], options: PaymentFiatStoreOptions = {}) {
    this.#rows = seed.map((row) => copyRow(row));
    this.#paymentFiat = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      fiatRates: options.fiatRates ?? new InMemoryFiatStore(),
      now: options.now ?? Date.now,
    };
  }

  /** Copy a row and set `hasPhoto` / `photoCount` from the photo maps. */
  #withListedMedia(row: MessageRow): MessageRow {
    const copy = copyRow(row);
    const hasPhoto0 = this.#photos.has(row.id) || row.hasPhoto === true;
    copy.hasPhoto = hasPhoto0;
    copy.hasVideo = row.hasVideo === true;
    copy.videoContentType = row.videoContentType ?? null;
    copy.photoCount = (hasPhoto0 ? 1 : 0) + (this.#extraPhotos.get(row.id)?.length ?? 0);
    copy.photoTakenAts = padPhotoTakenAts(row.photoTakenAts, copy.photoCount);
    return copy;
  }

  /**
   * Newest-first top-level notes only, capped at `limit`, with `replyCount`
   * of live attributed children (`deletedAt` null and either an account or a
   * recorded zapper pubkey).
   *
   * @param limit - Maximum rows.
   * @returns A new array of list row copies; mutating it does not change the store.
   * Listed objects include `hasVideo` / `videoContentType` but never expose
   * photo or video bytes (video lives on disk under `MEDIA_DIR`).
   */
  listLatest(limit: number): Promise<MessageListRow[]> {
    const topLevel = this.#rows.filter((row) => row.parentId === null && row.deletedAt === null);
    const sorted = [...topLevel].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(
      sorted.slice(0, limit).map((row) => {
        const copy = this.#withListedMedia(row);
        const replyCount = this.#rows.filter(
          (child) =>
            child.parentId === row.id &&
            child.deletedAt === null &&
            (child.accountId !== null ||
              (child.authorPubkey !== null && this.#zappers.has(child.authorPubkey.toLowerCase()))),
        ).length;
        return { ...copy, replyCount };
      }),
    );
  }

  /**
   * Bind a provider of name-copy profile-note ids omitted by {@link listFeed}.
   * The provider should return name-copy ids, not every profile note. A real
   * About me id is not included.
   *
   * @param provider - Returns name-copy ids stored as `account.profileMessageId`.
   */
  useProfileNoteIds(provider: () => Promise<ReadonlySet<string>> | ReadonlySet<string>): void {
    this.#profileNoteIds = provider;
  }

  /**
   * Live top-level notes for a forum feed page (`parentId` null, `deletedAt`
   * null), capped at `query.limit`, with `replyCount` of live attributed
   * children (`deletedAt` null and either an account or a recorded zapper pubkey).
   * Profile notes are omitted when {@link useProfileNoteIds} was set.
   *
   * @param query - Mode, limit, exclusive keyset cursor, staff ids, and optional hashtag.
   * @returns A new array of list row copies; mutating it does not change the store.
   */
  async listFeed(query: MessageFeedQuery): Promise<MessageListRow[]> {
    const profileNoteIds =
      this.#profileNoteIds === undefined ? undefined : await this.#profileNoteIds();
    const topLevel = this.#rows.filter((row) => {
      if (row.parentId !== null || row.deletedAt !== null) {
        return false;
      }
      if (profileNoteIds !== undefined && profileNoteIds.has(row.id)) {
        return false;
      }
      if (query.mode === 'unpaid') {
        return row.sats === 0;
      }
      if (query.mode === 'active') {
        return (
          row.sats > 0 ||
          (row.accountId !== null && query.staffAccountIds.has(row.accountId)) ||
          (typeof row.goalSats === 'number' && row.goalSats > 0)
        );
      }
      if (query.mode === 'popular') {
        return row.sats > 0;
      }
      return true;
    });
    const hashtag = query.hashtag;
    const tagged =
      typeof hashtag === 'string' && hashtag !== ''
        ? topLevel.filter((row) => textHasHashtagToken(row.text, hashtag))
        : topLevel;
    const sorted = [...tagged].sort((a, b) => {
      if (query.mode === 'popular') {
        const bySats = b.sats - a.sats;
        if (bySats !== 0) {
          return bySats;
        }
      }
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    const afterCursor = sorted.filter((row) => matchesFeedCursor(row, query));
    return afterCursor.slice(0, query.limit).map((row) => {
      const copy = this.#withListedMedia(row);
      const replyCount = this.#rows.filter(
        (child) =>
          child.parentId === row.id &&
          child.deletedAt === null &&
          (child.accountId !== null ||
            (child.authorPubkey !== null && this.#zappers.has(child.authorPubkey.toLowerCase()))),
      ).length;
      return { ...copy, replyCount };
    });
  }

  /**
   * Oldest-first attributed replies for `parentId` (account or zapper
   * pubkey). Live-only unless `includeHidden` is `true`.
   *
   * @param parentId - Parent note id.
   * @param limit - Max rows (default 200).
   * @param includeHidden - When `true`, include hidden children.
   * @returns Reply row copies.
   */
  listReplies(
    parentId: string,
    limit: number = 200,
    includeHidden?: boolean,
  ): Promise<MessageRow[]> {
    const replies = this.#rows
      .filter(
        (row) =>
          row.parentId === parentId &&
          (includeHidden === true || row.deletedAt === null) &&
          (row.accountId !== null ||
            (row.authorPubkey !== null && this.#zappers.has(row.authorPubkey.toLowerCase()))),
      )
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((row) => this.#withListedMedia(row));
    return Promise.resolve(replies);
  }

  /**
   * Direct-child ids of `parentId` (any `deletedAt`).
   *
   * @param parentId - Parent note id.
   * @returns Child ids; empty when unknown or childless.
   */
  listChildIds(parentId: string): Promise<string[]> {
    return Promise.resolve(
      this.#rows.filter((row) => row.parentId === parentId).map((row) => row.id),
    );
  }

  /**
   * Living notes and replies per UTC day. Soft-hidden rows are omitted.
   * Days with no rows are absent.
   *
   * @returns One entry per day that has a living row, oldest day first.
   */
  postCountsByUtcDay(): Promise<PostDayCount[]> {
    const counts = new Map<string, number>();
    for (const row of this.#rows) {
      if (row.deletedAt !== null) {
        continue;
      }
      const day = row.createdAt.toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return Promise.resolve(
      [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([day, postCount]) => ({ day, postCount })),
    );
  }

  /**
   * Newest-first forum rows for operator debug, including replies and
   * soft-hidden notes, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   *   Listed objects never expose photo or video bytes.
   */
  listDebug(limit: number): Promise<MessageRow[]> {
    const sorted = [...this.#rows].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => this.#withListedMedia(row)));
  }

  /**
   * Newest-hidden-first forum rows for the staff hidden log, including
   * replies, capped at `limit`. Live rows (`deletedAt` null) are omitted.
   *
   * @param limit - Maximum rows.
   * @returns A new array of row copies; mutating it does not change the store.
   *   Listed objects never expose photo or video bytes.
   */
  listHidden(limit: number): Promise<MessageRow[]> {
    const hidden = this.#rows.filter((row) => row.deletedAt !== null);
    const sorted = [...hidden].sort((a, b) => {
      const byTime = (b.deletedAt as Date).getTime() - (a.deletedAt as Date).getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(sorted.slice(0, limit).map((row) => this.#withListedMedia(row)));
  }

  /**
   * Up to two stored ids whose string form starts with `prefix`
   * (case-insensitive), including soft-hidden rows.
   *
   * @param prefix - Hex prefix; lowercased, not trimmed.
   * @returns At most two id strings in stored form.
   */
  listIdsByPrefix(prefix: string): Promise<string[]> {
    const needle = prefix.toLowerCase();
    const ids: string[] = [];
    for (const row of this.#rows) {
      if (row.id.toLowerCase().startsWith(needle)) {
        ids.push(row.id);
        if (ids.length === 2) {
          break;
        }
      }
    }
    return Promise.resolve(ids);
  }

  /**
   * Live top-level notes with both place coordinates, newest first.
   *
   * @param limit - Maximum rows.
   * @returns Pin row copies (no photo bytes).
   */
  listPlaces(limit: number): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: Date;
      lat: number;
      lng: number;
      label: string | null;
      accountId: string | null;
    }>
  > {
    const pinned = this.#rows.filter((row) => {
      if (row.parentId !== null || row.deletedAt !== null) {
        return false;
      }
      const place = row.place;
      if (place === undefined || place === null) {
        return false;
      }
      return typeof place.lat === 'number' && typeof place.lng === 'number';
    });
    const sorted = [...pinned].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(
      sorted.slice(0, limit).map((row) => {
        const place = row.place as ForumPlace;
        return {
          id: row.id,
          name: row.name,
          createdAt: new Date(row.createdAt.getTime()),
          lat: place.lat,
          lng: place.lng,
          label: place.label,
          accountId: row.accountId,
        };
      }),
    );
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
      .filter((row) => row.eventId !== null && row.parentId === null && row.deletedAt === null)
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
   * An existing `id` returns the stored row (gift-reply retries), even if that
   * row's parent was later deleted. A non-null `eventId` that already exists
   * returns the stored row (same uniqueness as
   * `message_event_id_uidx` and conversation `appendMessage`). Live unsigned
   * media (`eventId` null) with the same account, parent, fingerprint, and place
   * returns the existing row without appending or writing a second video file.
   * A different place throws `place conflicts with live media`. A reply is
   * compared after its pin is cleared, so an incoming reply pin does not
   * conflict with the stored null.
   * A non-null `parentId` requires a live parent (`deletedAt` null); a missing
   * or soft-hidden parent throws and does not append. Replies store
   * `goalSats` null even when the row carried a positive ask, store
   * `goalRepayable` null even when the row carried `true`, store
   * `goalTermDays` null even when the row carried a term, and store
   * `place` null even when the row carried a pin.
   *
   * @param row - Message to store.
   * @param photo - Optional photo (bytes copied).
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9). Ignored when `video` is set.
   * @returns A copy of the stored row with `hasPhoto` from `photo`,
   *   `photoCount` from photo 0 plus extras, and `hasVideo` / `videoContentType`
   *   from `video`.
   */
  async create(
    row: MessageRow,
    photo?: ForumPhoto,
    video?: ForumVideo,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<MessageRow> {
    const existingById = this.#rows.find((item) => item.id === row.id);
    if (existingById !== undefined) {
      return copyRow(existingById);
    }
    if (row.eventId !== null) {
      const existing = this.#rows.find((item) => item.eventId === row.eventId);
      if (existing !== undefined) {
        return copyRow(existing);
      }
    }
    const extras = video !== undefined ? [] : [...(extraPhotos ?? [])];
    if (extras.length > 0 && photo === undefined) {
      throw new Error('extra photos require photo 0');
    }
    const contentFp =
      (photo !== undefined || video !== undefined) && row.accountId !== null && row.eventId === null
        ? video !== undefined
          ? forumContentFingerprint(row.text, video.bytes)
          : extras.length > 0
            ? forumContentFingerprint(
                row.text,
                photo!.bytes,
                extras.map((item) => item.bytes),
              )
            : forumContentFingerprint(row.text, photo!.bytes)
        : null;
    if (contentFp !== null && row.accountId !== null) {
      const existing = await this.findLiveByAccountContent(
        row.accountId,
        row.parentId ?? null,
        contentFp,
      );
      if (existing !== undefined) {
        const placeForMatch = row.parentId !== null ? null : (row.place ?? null);
        if (!placesMatch(existing.place ?? null, placeForMatch)) {
          throw new Error('place conflicts with live media');
        }
        return existing;
      }
    }
    const hasPhoto = photo !== undefined;
    const hasVideo = video !== undefined;
    const snapshot = await resolvePaymentFiat(row.sats, row.createdAt, fiat, this.#paymentFiat);
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
      hasVideo,
      videoContentType: video === undefined ? null : video.contentType,
      contentFp,
      photoCount: (hasPhoto ? 1 : 0) + extras.length,
      amountUsd: snapshot?.usd ?? null,
      amountChf: snapshot?.chf ?? null,
      amountEur: snapshot?.eur ?? null,
      amountPhp: snapshot?.php ?? null,
      photoTakenAts: photoTakenAtsForCreate(photo, extras),
      ...(typeof video?.takenAt === 'string' ? { videoTakenAt: video.takenAt } : {}),
    });
    applyStoredGoal(stored);
    stored.place = stored.parentId !== null ? null : (stored.place ?? null);
    // Create does not assign a shop account.
    stored.shopAccount = null;
    if (stored.parentId !== null) {
      const parent = this.#rows.find((item) => item.id === stored.parentId);
      if (parent === undefined || parent.deletedAt !== null) {
        throw new Error('parent missing or deleted');
      }
    }
    if (video !== undefined) {
      await writeForumVideo(stored.id, video);
    }
    this.#rows.push(stored);
    if (photo !== undefined) {
      this.#photos.set(stored.id, copyPhoto(photo));
    }
    if (extras.length > 0) {
      this.#extraPhotos.set(
        stored.id,
        extras.map((item) => copyPhoto(item)),
      );
    }
    return this.#withListedMedia(stored);
  }

  /**
   * Oldest live row for the same account, parent, and content fingerprint.
   *
   * @param accountId - Author account id.
   * @param parentId - Parent note id, or `null` for top-level.
   * @param contentFp - Content fingerprint hex.
   * @returns A copy of the oldest matching live row, or `undefined`.
   */
  findLiveByAccountContent(
    accountId: string,
    parentId: string | null,
    contentFp: string,
  ): Promise<MessageRow | undefined> {
    const matches = this.#rows.filter((row) => {
      if (row.accountId !== accountId || row.deletedAt !== null) {
        return false;
      }
      if ((row.contentFp ?? null) !== contentFp) {
        return false;
      }
      if (parentId === null) {
        return row.parentId === null;
      }
      return row.parentId === parentId;
    });
    // Live media collapse keeps at most one match; append order is oldest-first.
    const first = matches[0];
    return Promise.resolve(first === undefined ? undefined : this.#withListedMedia(first));
  }

  /**
   * Whether `accountId` has at least one live forum row that is not `excludeId`.
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live row exists.
   */
  accountHasLivePost(accountId: string, excludeId: string | null): Promise<boolean> {
    const found = this.#rows.some(
      (row) =>
        row.accountId === accountId &&
        row.deletedAt === null &&
        (excludeId === null || row.id !== excludeId),
    );
    return Promise.resolve(found);
  }

  /**
   * Whether `accountId` has at least one live top-level forum row that is
   * not `excludeId`.
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level row exists.
   */
  accountHasLiveTopLevelPost(accountId: string, excludeId: string | null): Promise<boolean> {
    const found = this.#rows.some(
      (row) =>
        row.accountId === accountId &&
        row.deletedAt === null &&
        row.parentId === null &&
        (excludeId === null || row.id !== excludeId),
    );
    return Promise.resolve(found);
  }

  /**
   * Whether `accountId` has at least one live top-level forum row that is
   * not `excludeId` and has media (photo 0, extra stills, or video).
   *
   * @param accountId - Author account id.
   * @param excludeId - Auto profile note id, or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level media row exists.
   */
  accountHasLiveTopLevelMediaPost(accountId: string, excludeId: string | null): Promise<boolean> {
    const found = this.#rows.some(
      (row) =>
        row.accountId === accountId &&
        row.deletedAt === null &&
        row.parentId === null &&
        (excludeId === null || row.id !== excludeId) &&
        ((this.#extraPhotos.get(row.id)?.length ?? 0) > 0 ||
          this.#photos.has(row.id) ||
          row.hasVideo === true),
    );
    return Promise.resolve(found);
  }

  /**
   * Newest live top-level photo or video for `accountId`, including About me.
   *
   * @param accountId - Author account id.
   * @returns Message id, or `null` when none.
   */
  latestLiveTopLevelMediaId(accountId: string): Promise<string | null> {
    const matches = this.#rows.filter(
      (row) =>
        row.accountId === accountId &&
        row.deletedAt === null &&
        row.parentId === null &&
        ((this.#extraPhotos.get(row.id)?.length ?? 0) > 0 ||
          this.#photos.has(row.id) ||
          row.hasVideo === true),
    );
    matches.sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
    });
    return Promise.resolve(matches[0]?.id ?? null);
  }

  /**
   * Live post/reply totals for one 21.gifts author.
   *
   * @param accountId - Author account id.
   * @returns `{ postCount, replyCount }` (zeros when empty).
   */
  countByAccount(accountId: string): Promise<AccountMessageCounts> {
    let postCount = 0;
    let replyCount = 0;
    for (const row of this.#rows) {
      if (row.accountId !== accountId || row.deletedAt !== null) {
        continue;
      }
      if (row.parentId === null) {
        postCount += 1;
      } else {
        replyCount += 1;
      }
    }
    return Promise.resolve({ postCount, replyCount });
  }

  /**
   * Uncapped count of live attributed direct children of `parentId`.
   *
   * @param parentId - Parent message id.
   * @returns Count of matching children (0 when none or the id is unknown).
   */
  countAttributedReplies(parentId: string): Promise<number> {
    const replyCount = this.#rows.filter(
      (child) =>
        child.parentId === parentId &&
        child.deletedAt === null &&
        (child.accountId !== null ||
          (child.authorPubkey !== null && this.#zappers.has(child.authorPubkey.toLowerCase()))),
    ).length;
    return Promise.resolve(replyCount);
  }

  /**
   * Newest-first live top-level notes for `accountId`, capped at `limit`,
   * with `replyCount` of live attributed children (account or recorded zapper
   * pubkey).
   *
   * @param accountId - Author account id.
   * @param limit - Maximum rows.
   * @returns A new array of list row copies.
   */
  listPostsByAccount(accountId: string, limit: number): Promise<MessageListRow[]> {
    const posts = this.#rows.filter(
      (row) => row.parentId === null && row.deletedAt === null && row.accountId === accountId,
    );
    const sorted = [...posts].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.id.localeCompare(a.id);
    });
    return Promise.resolve(
      sorted.slice(0, limit).map((row) => {
        const copy = this.#withListedMedia(row);
        const replyCount = this.#rows.filter(
          (child) =>
            child.parentId === row.id &&
            child.deletedAt === null &&
            (child.accountId !== null ||
              (child.authorPubkey !== null && this.#zappers.has(child.authorPubkey.toLowerCase()))),
        ).length;
        return { ...copy, replyCount };
      }),
    );
  }

  /**
   * Newest-first live replies for `accountId`, capped at `limit`.
   *
   * @param accountId - Author account id.
   * @param limit - Maximum rows.
   * @returns Reply row copies.
   */
  listRepliesByAccount(accountId: string, limit: number): Promise<MessageRow[]> {
    const replies = this.#rows
      .filter(
        (row) => row.parentId !== null && row.deletedAt === null && row.accountId === accountId,
      )
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map((row) => this.#withListedMedia(row));
    return Promise.resolve(replies);
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

  /**
   * Load one extra still (indices 1–9) for a message id.
   *
   * @param id - Message id.
   * @param index - Extra index (1–9). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range.
   */
  async getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null> {
    if (index < 1 || index > 9) {
      return null;
    }
    const list = this.#extraPhotos.get(id);
    const photo = list?.[index - 1];
    return photo === undefined ? null : copyPhoto(photo);
  }

  /**
   * Extra stills for a message id, ordered by index ascending.
   *
   * @param id - Message id.
   * @returns Copies of extras (length 0–9). Empty when none.
   */
  async listExtraPhotos(id: string): Promise<ForumPhoto[]> {
    return (this.#extraPhotos.get(id) ?? []).map(copyPhoto);
  }

  getById(id: string): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.id === id);
    return Promise.resolve(row === undefined ? undefined : this.#withListedMedia(row));
  }

  getByEventId(eventId: string): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.eventId === eventId);
    return Promise.resolve(row === undefined ? undefined : copyRow(row));
  }

  claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<MessageRow[]> {
    return Promise.resolve(
      this.#claim(
        (row) => {
          if (row.deletedAt !== null) {
            return false;
          }
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
        (row) =>
          row.deletedAt === null && row.eventId !== null && row.nostrPublishState === 'pending',
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
          row.deletedAt === null &&
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
          row.deletedAt === null &&
          row.parentId === null &&
          row.eventId !== null &&
          row.hasPhoto &&
          row.hasVideo !== true &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          row.nostrAttempts < MAX_PUBLISH_ATTEMPTS &&
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
          row.deletedAt === null &&
          row.parentId === null &&
          row.eventId !== null &&
          row.hasVideo === true &&
          row.videoContentType !== null &&
          row.videoContentType !== undefined &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          row.nostrAttempts < MAX_PUBLISH_ATTEMPTS &&
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

  listSignedMissingHashtags(
    limit: number,
    extraHashtagsByAccountId?: ReadonlyMap<string, readonly string[]>,
    excludeIds?: ReadonlySet<string>,
  ): Promise<MessageRow[]> {
    const rows = this.#rows
      .filter(
        (row) =>
          row.deletedAt === null &&
          row.parentId === null &&
          row.eventId !== null &&
          row.sats === 0 &&
          row.nostrPublishState === 'published' &&
          row.nostrAttempts < MAX_PUBLISH_ATTEMPTS &&
          !this.#rows.some((child) => child.parentId === row.id) &&
          (excludeIds === undefined || excludeIds.size === 0 || !excludeIds.has(row.id)) &&
          kind1MissingHashtags(
            row.nostrEvent,
            extraHashtagsByAccountId?.get(row.accountId ?? '') ?? [],
          ),
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
      row.nostrAttempts += 1;
      row.nostrFirstAttemptAt = row.nostrFirstAttemptAt ?? Date.now();
      row.nostrPublishEpoch = null;
    }
    return Promise.resolve();
  }

  updateText(id: string, text: string): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    row.text = text;
    return Promise.resolve(copyRow(row));
  }

  updatePhoto(id: string, photo: ForumPhoto | null): Promise<MessageRow | undefined> {
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    if (photo === null) {
      this.#photos.delete(id);
      row.hasPhoto = false;
    } else {
      this.#photos.set(id, copyPhoto(photo));
      row.hasPhoto = true;
    }
    const extras = this.#extraPhotos.get(id) ?? [];
    const hasPhoto0 = this.#photos.has(id);
    row.photoCount = (hasPhoto0 ? 1 : 0) + extras.length;
    row.photoTakenAts = [
      ...(hasPhoto0 ? [typeof photo?.takenAt === 'string' ? photo.takenAt : null] : []),
      ...extras.map((item) => (typeof item.takenAt === 'string' ? item.takenAt : null)),
    ];
    return Promise.resolve(copyRow(row));
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

  addSats(id: string, extraSats: number, delta: FiatAmounts | null): Promise<void> {
    const row = this.#rows.find((item) => item.id === id);
    if (row !== undefined) {
      row.amountUsd = foldFiatColumn(row.amountUsd, delta?.usd ?? null, extraSats);
      row.amountChf = foldFiatColumn(row.amountChf, delta?.chf ?? null, extraSats);
      row.amountEur = foldFiatColumn(row.amountEur, delta?.eur ?? null, extraSats);
      row.amountPhp = foldFiatColumn(row.amountPhp, delta?.php ?? null, extraSats);
      row.sats += extraSats;
      const goalSats = row.goalSats;
      if (
        row.goalRepayable === true &&
        row.goalFundedAt === null &&
        typeof goalSats === 'number' &&
        goalSats > 0 &&
        row.sats >= goalSats
      ) {
        row.goalFundedAt = new Date();
      }
    }
    return Promise.resolve();
  }

  listCreditPayers(messageId: string): Promise<
    {
      accountId: string;
      sats: number;
      usd: string | null;
      chf: string | null;
      eur: string | null;
      php: string | null;
    }[]
  > {
    const totals = new Map<
      string,
      {
        sats: number;
        usd: bigint | null;
        chf: bigint | null;
        eur: bigint | null;
        php: bigint | null;
      }
    >();
    for (const [eventId, receipt] of this.#receipts) {
      if (receipt.messageId !== messageId || receipt.payerAccountId === null) {
        continue;
      }
      const ingest = this.#zapIngests.find(
        (row) =>
          row.receiptId === eventId && row.outcome === 'indexed' && row.messageId === messageId,
      );
      const current = totals.get(receipt.payerAccountId) ?? {
        sats: 0,
        usd: 0n,
        chf: 0n,
        eur: 0n,
        php: 0n,
      };
      current.sats += receipt.sats;
      current.usd = addPayerCents(current.usd, ingest?.amountUsd);
      current.chf = addPayerCents(current.chf, ingest?.amountChf);
      current.eur = addPayerCents(current.eur, ingest?.amountEur);
      current.php = addPayerCents(current.php, ingest?.amountPhp);
      totals.set(receipt.payerAccountId, current);
    }
    return Promise.resolve(
      [...totals.entries()].map(([accountId, total]) => ({
        accountId,
        sats: total.sats,
        usd: total.usd === null ? null : centsToAmount(total.usd),
        chf: total.chf === null ? null : centsToAmount(total.chf),
        eur: total.eur === null ? null : centsToAmount(total.eur),
        php: total.php === null ? null : centsToAmount(total.php),
      })),
    );
  }

  sumUnassignedCreditSats(messageId: string): Promise<number> {
    let sats = 0;
    for (const receipt of this.#receipts.values()) {
      if (receipt.messageId === messageId && receipt.payerAccountId === null) {
        sats += receipt.sats;
      }
    }
    return Promise.resolve(sats);
  }

  listRepayments(
    messageId: string,
  ): Promise<{ dayIndex: number; recipientAccountId: string; dueSats: number; paidAt: Date }[]> {
    return Promise.resolve(
      this.#repayments
        .filter((row) => row.messageId === messageId)
        .map((row) => ({
          dayIndex: row.dayIndex,
          recipientAccountId: row.recipientAccountId,
          dueSats: row.dueSats,
          paidAt: new Date(row.paidAt.getTime()),
        })),
    );
  }

  markRepaymentPaid(row: {
    messageId: string;
    dayIndex: number;
    recipientAccountId: string;
    dueSats: number;
    paidAt: Date;
  }): Promise<void> {
    const existing = this.#repayments.find(
      (item) =>
        item.messageId === row.messageId &&
        item.dayIndex === row.dayIndex &&
        item.recipientAccountId === row.recipientAccountId,
    );
    if (existing === undefined) {
      this.#repayments.push({
        messageId: row.messageId,
        dayIndex: row.dayIndex,
        recipientAccountId: row.recipientAccountId,
        dueSats: row.dueSats,
        paidAt: new Date(row.paidAt.getTime()),
      });
    }
    return Promise.resolve();
  }

  /**
   * Claim a lowercase payment hash once, allowing only its current owner to
   * re-claim it.
   *
   * @param paymentHash - BOLT11 payment hash; stored lowercase.
   * @param receiptEventId - Kind:9735 or synthetic receipt event id.
   * @param at - Claim creation time.
   * @returns `true` for a new or same-owner claim; `false` for another owner.
   */
  claimZapPayment(paymentHash: string, receiptEventId: string, at: Date): Promise<boolean> {
    const normalizedHash = paymentHash.toLowerCase();
    const existing = this.#zapPayments.get(normalizedHash);
    if (existing !== undefined) {
      return Promise.resolve(existing.receiptEventId === receiptEventId);
    }
    this.#zapPayments.set(normalizedHash, {
      receiptEventId,
      createdAt: new Date(at.getTime()),
    });
    return Promise.resolve(true);
  }

  async recordZapReceipt(
    receiptEventId: string,
    messageId: string,
    sats: number,
    delta: FiatAmounts | null,
  ): Promise<boolean> {
    if (this.#receipts.has(receiptEventId)) {
      return false;
    }
    this.#receipts.set(receiptEventId, {
      messageId,
      sats,
      payerAccountId: null,
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
      comment: '',
    });
    await this.addSats(messageId, sats, delta);
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

  listRecentOkInvoiceAttempts(since: Date, limit: number): Promise<MessageInvoiceAttempt[]> {
    const sorted = this.#invoiceAttempts
      .filter((row) => row.result === 'ok' && row.createdAt.getTime() >= since.getTime())
      .sort((a, b) => {
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

  listExtraPhotoMeta(limit: number): Promise<
    Array<{
      messageId: string;
      idx: number;
      photoContentType: string;
      bytes: number;
      photoTakenAt: string | null;
    }>
  > {
    const rows: Array<{
      messageId: string;
      idx: number;
      photoContentType: string;
      bytes: number;
      photoTakenAt: string | null;
    }> = [];
    for (const [messageId, extras] of this.#extraPhotos) {
      extras.forEach((photo, index) => {
        rows.push({
          messageId,
          idx: index + 1,
          photoContentType: photo.contentType,
          bytes: photo.bytes.byteLength,
          photoTakenAt: photo.takenAt ?? null,
        });
      });
    }
    rows.sort((a, b) => {
      const parentA = this.#rows.find((row) => row.id === a.messageId)?.createdAt.getTime();
      const parentB = this.#rows.find((row) => row.id === b.messageId)?.createdAt.getTime();
      if (parentA !== undefined && parentB !== undefined && parentA !== parentB) {
        return parentB - parentA;
      }
      return a.idx - b.idx || a.messageId.localeCompare(b.messageId);
    });
    return Promise.resolve(rows.slice(0, limit));
  }

  listZapReceipts(limit: number): Promise<ZapReceiptDumpRow[]> {
    const rows = [...this.#receipts.entries()]
      .map(([eventId, receipt]) => ({
        eventId,
        messageId: receipt.messageId,
        sats: receipt.sats,
        payerAccountId: receipt.payerAccountId,
        payerPubkey: receipt.payerPubkey,
        zapRequestId: receipt.zapRequestId,
        giftReplyId: receipt.giftReplyId,
        comment: receipt.comment,
      }))
      .sort((a, b) => (a.eventId < b.eventId ? 1 : -1));
    return Promise.resolve(rows.slice(0, limit));
  }

  listZapPayments(
    limit: number,
  ): Promise<Array<{ paymentHash: string; receiptEventId: string; createdAt: string }>> {
    const rows = [...this.#zapPayments.entries()]
      .map(([paymentHash, row]) => ({
        paymentHash,
        receiptEventId: row.receiptEventId,
        createdAt: row.createdAt.toISOString(),
      }))
      .sort((a, b) => {
        const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.paymentHash.localeCompare(a.paymentHash);
      });
    return Promise.resolve(rows.slice(0, limit));
  }

  listInvoiceAttemptsForPayer(payerAccountId: string): Promise<MessageInvoiceAttempt[]> {
    const sorted = this.#invoiceAttempts
      .filter((row) => row.payerAccountId === payerAccountId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      });
    return Promise.resolve(sorted.map((row) => copyInvoiceAttempt(row)));
  }

  listIndexedZapIngests(): Promise<ZapIngestRow[]> {
    const sorted = this.#zapIngests
      .filter((row) => row.outcome === 'indexed')
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      });
    return Promise.resolve(sorted.map((row) => copyZapIngest(row)));
  }

  /**
   * Whether `candidate` is strictly newer than `current` (`createdAt` DESC, then
   * `id` DESC via `localeCompare`).
   */
  #isNewerIndexedIngest(candidate: ZapIngestRow, current: ZapIngestRow): boolean {
    const byTime = candidate.createdAt.getTime() - current.createdAt.getTime();
    return byTime > 0 || (byTime === 0 && candidate.id.localeCompare(current.id) > 0);
  }

  /** Newest `indexed` ingest for `receiptId` (`createdAt` DESC, then `id` DESC). */
  #newestIndexedIngest(receiptId: string): ZapIngestRow | undefined {
    let newest: ZapIngestRow | undefined;
    for (const ingest of this.#zapIngests) {
      if (ingest.receiptId !== receiptId || ingest.outcome !== 'indexed') {
        continue;
      }
      if (newest === undefined || this.#isNewerIndexedIngest(ingest, newest)) {
        newest = ingest;
      }
    }
    return newest;
  }

  listUnattributedIndexedReceipts(
    limit: number,
    before?: { createdAt: Date; eventId: string },
  ): Promise<UnattributedIndexedReceipt[]> {
    const newestByReceiptId = new Map<string, ZapIngestRow>();
    for (const ingest of this.#zapIngests) {
      if (ingest.outcome !== 'indexed') {
        continue;
      }
      const current = newestByReceiptId.get(ingest.receiptId);
      if (current === undefined || this.#isNewerIndexedIngest(ingest, current)) {
        newestByReceiptId.set(ingest.receiptId, ingest);
      }
    }
    const rows: UnattributedIndexedReceipt[] = [];
    for (const ingest of newestByReceiptId.values()) {
      const receipt = this.#receipts.get(ingest.receiptId);
      if (
        receipt === undefined ||
        receipt.payerAccountId !== null ||
        receipt.payerPubkey !== null ||
        receipt.zapRequestId !== null ||
        receipt.giftReplyId !== null
      ) {
        continue;
      }
      rows.push({
        receiptEventId: ingest.receiptId,
        messageId: receipt.messageId,
        sats: receipt.sats,
        createdAt: new Date(ingest.createdAt.getTime()),
        receipt: { ...ingest.receipt },
      });
    }
    rows.sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }
      return b.receiptEventId.localeCompare(a.receiptEventId);
    });
    const page =
      before === undefined
        ? rows
        : rows.filter((row) => {
            const byTime = row.createdAt.getTime() - before.createdAt.getTime();
            return (
              byTime < 0 || (byTime === 0 && row.receiptEventId.localeCompare(before.eventId) < 0)
            );
          });
    return Promise.resolve(page.slice(0, limit));
  }

  listAuthoredMessages(accountId: string): Promise<MessageRow[]> {
    const sorted = this.#rows
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      });
    return Promise.resolve(sorted.map((row) => copyRow(row)));
  }

  findOkInvoiceByPaymentHash(paymentHash: string): Promise<MessageInvoiceAttempt | undefined> {
    return Promise.resolve(
      newestOkInvoice(this.#invoiceAttempts, (row) => row.paymentHash === paymentHash),
    );
  }

  findOkInvoiceByPr(pr: string): Promise<MessageInvoiceAttempt | undefined> {
    return Promise.resolve(newestOkInvoice(this.#invoiceAttempts, (row) => row.pr === pr));
  }

  listOpenConversationZapEventIds(): Promise<
    ReadonlyArray<{ eventId: string; conversationMessageId: string }>
  > {
    const listed: { eventId: string; conversationMessageId: string }[] = [];
    for (const row of this.#invoiceAttempts) {
      if (
        row.result !== 'ok' ||
        row.conversationId === undefined ||
        row.conversationId === null ||
        row.conversationMessageId === undefined ||
        row.conversationMessageId === null
      ) {
        continue;
      }
      const eventId = zapRequestEventId(row.zapRequest);
      if (eventId === null) {
        continue;
      }
      listed.push({ eventId, conversationMessageId: row.conversationMessageId });
    }
    return Promise.resolve(listed);
  }

  attributeZapReceipt(
    receiptEventId: string,
    attribution: { payerPubkey: string; zapRequestId: string; comment: string },
  ): Promise<boolean> {
    const receipt = this.#receipts.get(receiptEventId);
    if (receipt === undefined) {
      return Promise.resolve(false);
    }
    if (receipt.zapRequestId !== null && receipt.zapRequestId !== attribution.zapRequestId) {
      return Promise.resolve(false);
    }
    for (const [otherId, other] of this.#receipts) {
      if (otherId !== receiptEventId && other.zapRequestId === attribution.zapRequestId) {
        return Promise.resolve(false);
      }
    }
    receipt.payerPubkey = attribution.payerPubkey.toLowerCase();
    receipt.zapRequestId = attribution.zapRequestId;
    receipt.comment = attribution.comment;
    return Promise.resolve(true);
  }

  recordZapper(pubkey: string, receiptEventId: string, at: Date): Promise<void> {
    const key = pubkey.toLowerCase();
    if (!this.#zappers.has(key)) {
      this.#zappers.set(key, { pubkey: key, receiptEventId, createdAt: new Date(at.getTime()) });
    }
    return Promise.resolve();
  }

  listZapperPubkeys(): Promise<string[]> {
    return Promise.resolve([...this.#zappers.keys()]);
  }

  /**
   * Whether one external pubkey is a recorded zapper (has the read-visibility entitlement).
   *
   * @param pubkey - External author pubkey, compared case-insensitively.
   * @returns `true` when a zapper entitlement row exists for that pubkey.
   */
  isZapperPubkey(pubkey: string): Promise<boolean> {
    return Promise.resolve(this.#zappers.has(pubkey.toLowerCase()));
  }

  listZappers(limit: number): Promise<NostrZapperRow[]> {
    return Promise.resolve(
      [...this.#zappers.values()]
        .sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }
          return b.pubkey.localeCompare(a.pubkey);
        })
        .slice(0, limit)
        .map((row) => ({ ...row, createdAt: new Date(row.createdAt.getTime()) })),
    );
  }

  blockPubkeyAndHideRows(
    pubkey: string,
    at: Date,
    byAccountId: string,
    messageId: string,
  ): Promise<number> {
    const key = pubkey.toLowerCase();
    if (!this.#blockedPubkeys.has(key)) {
      this.#blockedPubkeys.set(key, {
        pubkey: key,
        blockedAt: new Date(at.getTime()),
        blockedBy: byAccountId,
        messageId,
      });
    }
    let hidden = 0;
    for (const row of this.#rows) {
      if (
        row.deletedAt === null &&
        row.accountId === null &&
        row.authorPubkey?.toLowerCase() === key
      ) {
        row.deletedAt = new Date(at.getTime());
        row.deletedBy = byAccountId;
        hidden += 1;
      }
    }
    return Promise.resolve(hidden);
  }

  unblockPubkeyByMessage(messageId: string): Promise<boolean> {
    for (const [pubkey, row] of this.#blockedPubkeys) {
      if (row.messageId === messageId) {
        this.#blockedPubkeys.delete(pubkey);
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  isPubkeyBlocked(pubkey: string): Promise<boolean> {
    return Promise.resolve(this.#blockedPubkeys.has(pubkey.toLowerCase()));
  }

  listBlockedPubkeys(): Promise<string[]> {
    return Promise.resolve([...this.#blockedPubkeys.keys()]);
  }

  listBlockedPubkeyRows(limit: number): Promise<NostrBlockedPubkeyRow[]> {
    return Promise.resolve(
      [...this.#blockedPubkeys.values()]
        .sort((a, b) => {
          const byTime = b.blockedAt.getTime() - a.blockedAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }
          return b.pubkey.localeCompare(a.pubkey);
        })
        .slice(0, limit)
        .map((row) => ({ ...row, blockedAt: new Date(row.blockedAt.getTime()) })),
    );
  }

  updateZapReceiptGift(receiptEventId: string, patch: ZapReceiptGiftPatch): Promise<void> {
    const receipt = this.#receipts.get(receiptEventId);
    if (receipt === undefined) {
      return Promise.resolve();
    }
    if (patch.payerAccountId !== undefined) {
      receipt.payerAccountId = patch.payerAccountId;
    }
    if (patch.payerPubkey !== undefined) {
      receipt.payerPubkey = patch.payerPubkey;
    }
    if (patch.giftReplyId !== undefined) {
      receipt.giftReplyId = patch.giftReplyId;
    }
    if (patch.comment !== undefined) {
      receipt.comment = patch.comment;
    }
    return Promise.resolve();
  }

  getZapReceiptGift(receiptEventId: string): Promise<ZapReceiptGiftState | undefined> {
    const receipt = this.#receipts.get(receiptEventId);
    if (receipt === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      receiptEventId,
      messageId: receipt.messageId,
      sats: receipt.sats,
      payerAccountId: receipt.payerAccountId,
      payerPubkey: receipt.payerPubkey,
      zapRequestId: receipt.zapRequestId,
      giftReplyId: receipt.giftReplyId,
      comment: receipt.comment,
    });
  }

  listZapReceiptsAwaitingGiftReply(limit: number): Promise<ZapReceiptGiftRow[]> {
    const rows: ZapReceiptGiftRow[] = [];
    for (const [receiptEventId, receipt] of this.#receipts) {
      if (
        (receipt.payerAccountId === null && receipt.payerPubkey === null) ||
        receipt.giftReplyId !== null
      ) {
        continue;
      }
      rows.push({
        receiptEventId,
        messageId: receipt.messageId,
        sats: receipt.sats,
        payerAccountId: receipt.payerAccountId,
        payerPubkey: receipt.payerPubkey,
        zapRequestId: receipt.zapRequestId,
        receiptCreatedAt: (() => {
          const frame = this.#newestIndexedIngest(receiptEventId)?.receipt;
          const seconds = frame?.['created_at'];
          return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
        })(),
        comment: receipt.comment,
      });
    }
    rows.sort((a, b) => a.receiptEventId.localeCompare(b.receiptEventId));
    return Promise.resolve(rows.slice(0, limit));
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
      const mime = item.videoContentType;
      if (item.hasVideo === true && mime !== undefined && mime !== null) {
        await removeForumVideo(item.id, mime);
      }
      this.#photos.delete(item.id);
      this.#extraPhotos.delete(item.id);
    }
    this.#rows.splice(0, this.#rows.length, ...this.#rows.filter((item) => !ids.has(item.id)));
    const kept = this.#invoiceAttempts.filter((item) => !ids.has(item.messageId));
    this.#invoiceAttempts.length = 0;
    this.#invoiceAttempts.push(...kept);
    for (const [receiptEventId, receipt] of this.#receipts) {
      if (ids.has(receipt.messageId)) {
        this.#receipts.delete(receiptEventId);
      }
    }
    return true;
  }

  markDeleted(id: string, at: Date, byAccountId: string): Promise<boolean> {
    const target = this.#rows.find((item) => item.id === id);
    if (target === undefined) {
      return Promise.resolve(false);
    }
    if (target.deletedAt === null) {
      target.deletedAt = new Date(at.getTime());
      target.deletedBy = byAccountId;
    }
    for (const child of this.#rows) {
      if (child.parentId !== id || child.deletedAt !== null) {
        continue;
      }
      child.deletedAt = new Date(at.getTime());
      child.deletedBy = byAccountId;
    }
    return Promise.resolve(true);
  }

  markUndeleted(id: string): Promise<boolean> {
    const target = this.#rows.find((item) => item.id === id);
    if (target === undefined) {
      return Promise.resolve(false);
    }
    if (target.deletedAt === null) {
      return Promise.resolve(true);
    }
    const stampAt = target.deletedAt.getTime();
    const stampBy = target.deletedBy;
    target.deletedAt = null;
    target.deletedBy = null;
    for (const child of this.#rows) {
      if (child.parentId !== id || child.deletedAt === null) {
        continue;
      }
      if (child.deletedAt.getTime() !== stampAt || child.deletedBy !== stampBy) {
        continue;
      }
      child.deletedAt = null;
      child.deletedBy = null;
    }
    return Promise.resolve(true);
  }

  setPlace(id: string, place: ForumPlace | null): Promise<boolean> {
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    row.place = place === null ? null : { lat: place.lat, lng: place.lng, label: place.label };
    return Promise.resolve(true);
  }

  setShopAccount(
    id: string,
    account: { id: string; username: string; name: string } | null,
  ): Promise<boolean> {
    const row = this.#rows.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    row.shopAccount =
      account === null ? null : { id: account.id, username: account.username, name: account.name };
    return Promise.resolve(true);
  }

  /**
   * Direct children of `parentId`, including hidden, Damus-only, and
   * gift-only rows. Oldest `createdAt` then `id` first. Missing parent → `[]`.
   *
   * @param parentId - Parent message id.
   * @returns Child row copies.
   */
  listDirectChildren(parentId: string): Promise<MessageRow[]> {
    const children = this.#rows
      .filter((row) => row.parentId === parentId)
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return a.id.localeCompare(b.id);
      })
      .map((row) => copyRow(row));
    return Promise.resolve(children);
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
  photo_count?: number | string | null;
  video_content_type?: string | null;
  parent_id?: string | null;
  author_pubkey?: string | null;
  event_id?: string | null;
  nostr_publish_state?: string | null;
  sats?: string | number | null;
  fiat_usd?: string | number | null;
  fiat_chf?: string | number | null;
  fiat_eur?: string | number | null;
  fiat_php?: string | number | null;
  goal_sats?: string | number | null;
  goal_repayable?: boolean | string | number | null;
  goal_term_days?: string | number | null;
  goal_funded_at?: Date | string | null;
  goal_currency?: string | null;
  goal_amount?: string | number | null;
  goal_fiat_usd?: string | number | null;
  goal_fiat_chf?: string | number | null;
  goal_fiat_eur?: string | number | null;
  goal_fiat_php?: string | number | null;
  place_lat?: string | number | null;
  place_lng?: string | number | null;
  place_label?: string | null;
  shop_account_id?: string | null;
  shop_username?: string | null;
  shop_name?: string | null;
  mentions?: unknown;
  nostr_event?: Record<string, unknown> | string | null;
  claimed_until?: Date | string | null;
  nostr_first_attempt_at?: Date | string | null;
  nostr_publish_epoch?: string | null;
  nostr_attempts?: number | null;
  content_fp?: string | null;
  deleted_at?: Date | string | null;
  deleted_by?: string | null;
  reply_count?: string | number | null;
  photo_taken_at?: string | null;
  video_taken_at?: string | null;
  extra_photo_taken_ats?: unknown;
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
  photo_taken_at?: string | null;
  video_taken_at?: string | null;
}

const FORUM_PHOTO_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

function parseVideoContentType(value: string | null | undefined): ForumVideoContentType | null {
  if (value === 'video/mp4' || value === 'video/webm' || value === 'video/quicktime') {
    return value;
  }
  return null;
}

/** Map SQL place columns onto {@link ForumPlace}. A null pair (or one side) is no pin. */
function placeFromSql(
  lat: string | number | null | undefined,
  lng: string | number | null | undefined,
  label: string | null | undefined,
): ForumPlace | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return null;
  }
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return null;
  }
  return {
    lat: latN,
    lng: lngN,
    label: label === null || label === undefined || label === '' ? null : label,
  };
}

/** Extra still capture times from `json_agg` (string or already-parsed). */
function parseExtraPhotoTakenAts(value: unknown): (string | null)[] {
  const raw = value ?? [];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item) => (typeof item === 'string' ? item : null));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => (typeof item === 'string' ? item : null));
}

/** Build `photoTakenAts` of length `photoCount` from SQL columns. */
function mapPhotoTakenAts(
  photoCount: number,
  photoTakenAt: string | null | undefined,
  extraRaw: unknown,
): (string | null)[] {
  if (photoCount === 0) {
    return [];
  }
  const extras = parseExtraPhotoTakenAts(extraRaw);
  const slot0 = typeof photoTakenAt === 'string' ? photoTakenAt : null;
  const times: (string | null)[] = [slot0];
  for (let i = 1; i < photoCount; i += 1) {
    const extra = extras[i - 1];
    times.push(typeof extra === 'string' ? extra : null);
  }
  return times;
}

/** Stored `@username` marks. Invalid JSON becomes an empty list. */
function parseStoredMentions(value: unknown): { accountId: string; username: string }[] {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(raw)) {
    return [];
  }
  const marks: { accountId: string; username: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const accountId = 'accountId' in item ? item.accountId : undefined;
    const username = 'username' in item ? item.username : undefined;
    if (typeof accountId === 'string' && typeof username === 'string') {
      marks.push({ accountId, username });
    }
  }
  return marks;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** Shop account columns. A blank joined username is no account. `name` may be empty. */
function shopAccountFromSql(
  row: MessageSqlRow,
): { id: string; username: string; name: string } | null {
  const id = row.shop_account_id;
  const username = row.shop_username;
  if (typeof id !== 'string' || id === '') {
    return null;
  }
  if (typeof username !== 'string' || username.trim() === '') {
    return null;
  }
  const name = row.shop_name;
  return { id, username, name: typeof name === 'string' ? name : '' };
}

/** Map a SQL list row onto {@link MessageRow}. Unexported. */
function mapMessageRow(row: MessageSqlRow): MessageRow {
  const defaults = unsignedNostrDefaults();
  const state = row.nostr_publish_state;
  const photoCount = Number(row.photo_count ?? (row.has_photo ? 1 : 0));
  const mapped: MessageRow = {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    text: row.text,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    hasPhoto: Boolean(row.has_photo),
    photoCount,
    hasVideo:
      row.video_content_type !== null &&
      row.video_content_type !== undefined &&
      row.video_content_type !== '',
    videoContentType: parseVideoContentType(row.video_content_type),
    parentId: row.parent_id ?? null,
    authorPubkey: row.author_pubkey ?? null,
    eventId: row.event_id ?? defaults.eventId,
    nostrPublishState:
      state === 'pending' || state === 'published' || state === 'failed' || state === 'skipped'
        ? state
        : defaults.nostrPublishState,
    sats: Number(row.sats ?? defaults.sats),
    amountUsd: row.fiat_usd === null || row.fiat_usd === undefined ? null : String(row.fiat_usd),
    amountChf: row.fiat_chf === null || row.fiat_chf === undefined ? null : String(row.fiat_chf),
    amountEur: row.fiat_eur === null || row.fiat_eur === undefined ? null : String(row.fiat_eur),
    amountPhp: row.fiat_php === null || row.fiat_php === undefined ? null : String(row.fiat_php),
    goalSats: row.goal_sats === null || row.goal_sats === undefined ? null : Number(row.goal_sats),
    goalRepayable: row.goal_repayable === true ? true : null,
    goalTermDays:
      row.goal_term_days === null || row.goal_term_days === undefined
        ? null
        : Number(row.goal_term_days),
    goalFundedAt:
      row.goal_funded_at === null || row.goal_funded_at === undefined
        ? null
        : row.goal_funded_at instanceof Date
          ? row.goal_funded_at
          : new Date(row.goal_funded_at),
    goalCurrency: mapGoalCurrency(row.goal_currency),
    goalAmount: mapGoalAmountText(row.goal_amount),
    goalAmountUsd: mapGoalFiatText(row.goal_fiat_usd),
    goalAmountChf: mapGoalFiatText(row.goal_fiat_chf),
    goalAmountEur: mapGoalFiatText(row.goal_fiat_eur),
    goalAmountPhp: mapGoalFiatText(row.goal_fiat_php),
    place: placeFromSql(row.place_lat, row.place_lng, row.place_label),
    shopAccount: shopAccountFromSql(row),
    nostrEvent: normalizeSignedEvent(row.nostr_event) ?? null,
    claimedUntil: optionalDate(row.claimed_until),
    nostrFirstAttemptAt: optionalDate(row.nostr_first_attempt_at),
    nostrPublishEpoch: row.nostr_publish_epoch ?? defaults.nostrPublishEpoch,
    nostrAttempts: row.nostr_attempts ?? defaults.nostrAttempts,
    contentFp: row.content_fp ?? null,
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined
        ? null
        : row.deleted_at instanceof Date
          ? row.deleted_at
          : new Date(row.deleted_at),
    deletedBy: row.deleted_by ?? null,
    photoTakenAts: mapPhotoTakenAts(photoCount, row.photo_taken_at, row.extra_photo_taken_ats),
    ...(typeof row.video_taken_at === 'string' && row.video_taken_at !== ''
      ? { videoTakenAt: row.video_taken_at }
      : {}),
  };
  const marks = parseStoredMentions(row.mentions);
  if (marks.length > 0) {
    mapped.mentions = marks;
  }
  return mapped;
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
              ((photo IS NOT NULL)::int + COALESCE((SELECT COUNT(*)::int FROM message_extra_photo e WHERE e.message_id = message.id), 0)) AS photo_count,
              video_content_type,
              parent_id, author_pubkey,
              event_id, nostr_publish_state, sats, goal_sats, goal_repayable, goal_term_days,
              goal_funded_at,
              fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php,
              place_lat, place_lng, place_label,
              shop_account_id,
              (SELECT username FROM account WHERE account.id = message.shop_account_id) AS shop_username,
              (SELECT name FROM account WHERE account.id = message.shop_account_id) AS shop_name,
              mentions,
              nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts,
              content_fp, deleted_at, deleted_by,
              photo_taken_at, video_taken_at,
              goal_currency,
              goal_amount::text AS goal_amount,
              goal_fiat_usd::text AS goal_fiat_usd,
              goal_fiat_chf::text AS goal_fiat_chf,
              goal_fiat_eur::text AS goal_fiat_eur,
              goal_fiat_php::text AS goal_fiat_php,
              COALESCE(
                (
                  SELECT json_agg(e.photo_taken_at ORDER BY e.idx)
                  FROM message_extra_photo e
                  WHERE e.message_id = message.id
                ),
                '[]'::json
              ) AS extra_photo_taken_ats`;

/**
 * Durable {@link MessageStore} backed by Postgres.
 */
export class PostgresMessageStore implements MessageStore {
  readonly #sql: SqlClient;
  readonly #paymentFiat: Required<PaymentFiatStoreOptions>;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient, options: PaymentFiatStoreOptions = {}) {
    this.#sql = sql;
    this.#paymentFiat = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      fiatRates: options.fiatRates ?? new InMemoryFiatStore(),
      now: options.now ?? Date.now,
    };
  }

  /**
   * Newest-first top-level notes from `message`, capped at `limit`, with
   * `replyCount` of live attributed children (`deleted_at IS NULL` and either
   * an account or a recorded zapper pubkey). Selects `(photo IS NOT NULL) AS has_photo`
   * and `video_content_type` (`hasVideo` / `videoContentType`) — never the
   * `photo` bytea column; video bytes live on disk under `MEDIA_DIR`, not as
   * bytea. Replies (`parent_id IS NOT NULL`) are excluded.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped list rows.
   */
  async listLatest(limit: number): Promise<MessageListRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS},
              (SELECT COUNT(*)::int FROM message child
               WHERE child.parent_id = message.id AND child.deleted_at IS NULL
                 AND (child.account_id IS NOT NULL
                   OR (child.author_pubkey IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM nostr_zapper z
                       WHERE z.pubkey = lower(child.author_pubkey))))) AS reply_count
       FROM message
       WHERE parent_id IS NULL AND deleted_at IS NULL
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
   * One keyset page of live top-level notes from `message`, capped at
   * `query.limit`, with `replyCount` of live attributed children
   * (`deleted_at IS NULL` and either an account or a recorded zapper pubkey).
   * Same {@link MESSAGE_SELECT_COLUMNS} as {@link listLatest} — never the
   * `photo` bytea column. Name-copy profile notes without a photo, extra
   * stills, or video are omitted. A real About me stays.
   *
   * @param query - Mode, limit, exclusive keyset cursor, staff ids, and optional hashtag.
   * @returns Mapped list rows.
   */
  async listFeed(query: MessageFeedQuery): Promise<MessageListRow[]> {
    const params: unknown[] = [query.limit];
    const filters: string[] = [
      'parent_id IS NULL',
      'deleted_at IS NULL',
      `NOT EXISTS (
         SELECT 1 FROM account
         WHERE account.profile_message_id = message.id
           AND message.photo IS NULL
           AND (message.video_content_type IS NULL OR trim(message.video_content_type) = '')
           AND NOT EXISTS (
             SELECT 1 FROM message_extra_photo extra
             WHERE extra.message_id = message.id
           )
           AND trim(message.text) <> ''
           AND (
             (trim(coalesce(account.name, '')) <> ''
               AND lower(trim(message.text)) = lower(trim(account.name)))
             OR (trim(coalesce(message.name, '')) <> ''
               AND lower(trim(message.text)) = lower(trim(message.name)))
           )
       )`,
    ];
    let orderBy = 'created_at DESC, id DESC';
    if (query.mode === 'unpaid') {
      filters.push('sats = 0');
    } else if (query.mode === 'active') {
      params.push(postgresTextArrayLiteral([...query.staffAccountIds]));
      filters.push(
        `(sats > 0 OR account_id::text = ANY($${params.length}::text[]) OR COALESCE(goal_sats, 0) > 0)`,
      );
    } else if (query.mode === 'popular') {
      filters.push('sats > 0');
      orderBy = 'sats DESC, created_at DESC, id DESC';
    }
    const hashtag = query.hashtag;
    if (typeof hashtag === 'string' && hashtag !== '') {
      params.push(posixHashtagTokenPattern(hashtag));
      filters.push(`text ~* $${params.length}`);
    }
    if (query.cursor !== null) {
      if (query.mode === 'popular') {
        if (query.cursor.k === 's') {
          params.push(query.cursor.s, query.cursor.c, query.cursor.i);
          filters.push(
            `(sats, created_at, id) < ($${params.length - 2}, $${params.length - 1}, $${params.length})`,
          );
        }
      } else if (query.cursor.k === 't') {
        params.push(query.cursor.c, query.cursor.i);
        filters.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
      }
    }
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS},
              (SELECT COUNT(*)::int FROM message child
               WHERE child.parent_id = message.id AND child.deleted_at IS NULL
                 AND (child.account_id IS NOT NULL
                   OR (child.author_pubkey IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM nostr_zapper z
                       WHERE z.pubkey = lower(child.author_pubkey))))) AS reply_count
       FROM message
       WHERE ${filters.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $1`,
      params,
    );
    return rows.map((row) => ({
      ...mapMessageRow(row),
      replyCount: Number(row.reply_count ?? 0),
    }));
  }

  /**
   * Oldest-first attributed replies for a parent note (account or zapper
   * pubkey). Live-only (`deleted_at IS NULL`) unless `includeHidden` is `true`.
   *
   * @param parentId - Parent message id (`$1`).
   * @param limit - Max rows (`$2`, default 200).
   * @param includeHidden - When `true`, omit the `deleted_at IS NULL` predicate.
   * @returns Mapped reply rows.
   */
  async listReplies(
    parentId: string,
    limit: number = 200,
    includeHidden?: boolean,
  ): Promise<MessageRow[]> {
    const hiddenFilter = includeHidden === true ? '' : ' AND deleted_at IS NULL';
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id = $1${hiddenFilter}
         AND (account_id IS NOT NULL
           OR (author_pubkey IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM nostr_zapper z
               WHERE z.pubkey = lower(message.author_pubkey))))
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [parentId, limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Direct-child ids of `parentId` (any `deleted_at`).
   *
   * @param parentId - Parent message id (`$1`).
   * @returns Child ids; empty when unknown or childless.
   */
  async listChildIds(parentId: string): Promise<string[]> {
    const rows = await this.#sql.query<{ id: string }>(
      `SELECT id FROM message WHERE parent_id = $1`,
      [parentId],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Living notes and replies per UTC day. Soft-hidden rows are omitted.
   * Days with no rows are absent. Never selects photo or video bytes.
   *
   * @returns One entry per day that has a living row, oldest day first.
   */
  async postCountsByUtcDay(): Promise<PostDayCount[]> {
    const rows = await this.#sql.query<{ day: string; post_count: number | string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              count(*)::int AS post_count
       FROM message
       WHERE deleted_at IS NULL
       GROUP BY 1
       ORDER BY 1`,
    );
    return rows.map((row) => ({ day: row.day, postCount: Number(row.post_count) }));
  }

  /**
   * Newest-first forum rows for operator debug (`created_at` desc, `id`
   * desc), including replies and soft-hidden notes. Never selects `photo`
   * bytea.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listDebug(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS} FROM message ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Newest-hidden-first forum rows (`deleted_at` desc, `id` desc). Only
   * rows with `deleted_at IS NOT NULL`. Never selects `photo` bytea.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Mapped rows.
   */
  async listHidden(limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS} FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  /**
   * Up to two stored ids whose `lower(id::text)` starts with `$1`.
   * Includes soft-hidden rows. Never selects `photo` bytea.
   *
   * @param prefix - Hex prefix; lowercased, not trimmed (`$1`).
   * @returns At most two id strings.
   */
  async listIdsByPrefix(prefix: string): Promise<string[]> {
    const rows = await this.#sql.query<{ id: string }>(
      `SELECT id::text AS id FROM message
       WHERE lower(id::text) LIKE $1 || '%'
       LIMIT 2`,
      [prefix.toLowerCase()],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Live top-level notes with both place coordinates, newest `created_at`
   * then `id` first. Never selects `photo` bytea.
   *
   * @param limit - Maximum rows (`$1`).
   * @returns Pin rows (`lat` / `lng` numeric; `label` null when unset).
   */
  async listPlaces(limit: number): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: Date;
      lat: number;
      lng: number;
      label: string | null;
      accountId: string | null;
    }>
  > {
    const rows = await this.#sql.query<{
      id: string;
      name: string;
      created_at: Date | string;
      place_lat: string | number | null;
      place_lng: string | number | null;
      place_label: string | null;
      account_id: string | null;
    }>(
      `SELECT id, name, created_at, place_lat, place_lng, place_label, account_id
       FROM message
       WHERE parent_id IS NULL AND deleted_at IS NULL
         AND place_lat IS NOT NULL AND place_lng IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      lat: Number(row.place_lat),
      lng: Number(row.place_lng),
      label: row.place_label === null || row.place_label === undefined ? null : row.place_label,
      accountId: row.account_id,
    }));
  }

  /**
   * Whether `accountId` has at least one live forum row that is not `excludeId`.
   *
   * @param accountId - Author account id (`$1`).
   * @param excludeId - Auto profile note id (`$2`), or `null` to exclude nothing extra.
   * @returns `true` when a matching live row exists.
   */
  async accountHasLivePost(accountId: string, excludeId: string | null): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `SELECT 1 FROM message
       WHERE account_id = $1
         AND deleted_at IS NULL
         AND ($2::uuid IS NULL OR id <> $2::uuid)
       LIMIT 1`,
      [accountId, excludeId],
    );
    return rows[0] !== undefined;
  }

  /**
   * Whether `accountId` has at least one live top-level forum row that is
   * not `excludeId`.
   *
   * @param accountId - Author account id (`$1`).
   * @param excludeId - Auto profile note id (`$2`), or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level row exists.
   */
  async accountHasLiveTopLevelPost(accountId: string, excludeId: string | null): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `SELECT 1 FROM message
       WHERE account_id = $1
         AND deleted_at IS NULL
         AND parent_id IS NULL
         AND ($2::uuid IS NULL OR id <> $2::uuid)
       LIMIT 1`,
      [accountId, excludeId],
    );
    return rows[0] !== undefined;
  }

  /**
   * Whether `accountId` has at least one live top-level forum row that is
   * not `excludeId` and has media (photo 0, extra stills, or video).
   *
   * @param accountId - Author account id (`$1`).
   * @param excludeId - Auto profile note id (`$2`), or `null` to exclude nothing extra.
   * @returns `true` when a matching live top-level media row exists.
   */
  async accountHasLiveTopLevelMediaPost(
    accountId: string,
    excludeId: string | null,
  ): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `SELECT 1 FROM message
       WHERE account_id = $1
         AND deleted_at IS NULL
         AND parent_id IS NULL
         AND ($2::uuid IS NULL OR id <> $2::uuid)
         AND (
           photo IS NOT NULL
           OR (video_content_type IS NOT NULL AND video_content_type <> '')
           OR EXISTS (SELECT 1 FROM message_extra_photo e WHERE e.message_id = message.id)
         )
       LIMIT 1`,
      [accountId, excludeId],
    );
    return rows[0] !== undefined;
  }

  /**
   * Newest live top-level photo or video id for `accountId`, including About me.
   *
   * @param accountId - Author account id (`$1`).
   * @returns Message id, or `null` when none.
   */
  async latestLiveTopLevelMediaId(accountId: string): Promise<string | null> {
    const rows = await this.#sql.query<{ id?: string }>(
      `SELECT id FROM message
       WHERE account_id = $1
         AND deleted_at IS NULL
         AND parent_id IS NULL
         AND (
           photo IS NOT NULL
           OR (video_content_type IS NOT NULL AND video_content_type <> '')
           OR EXISTS (SELECT 1 FROM message_extra_photo e WHERE e.message_id = message.id)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [accountId],
    );
    const id = rows[0]?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /**
   * Live post/reply totals for one 21.gifts author (`account_id = $1` and
   * `deleted_at IS NULL`). One `COUNT(*) FILTER` query; empty is zeros.
   *
   * @param accountId - Author account id (`$1`).
   * @returns `{ postCount, replyCount }` mapped via `Number`.
   */
  async countByAccount(accountId: string): Promise<AccountMessageCounts> {
    const rows = await this.#sql.query<{
      post_count: string | number | null;
      reply_count: string | number | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS post_count,
         COUNT(*) FILTER (WHERE parent_id IS NOT NULL)::int AS reply_count
       FROM message
       WHERE account_id = $1 AND deleted_at IS NULL`,
      [accountId],
    );
    const row = rows[0];
    return {
      postCount: Number(row?.post_count ?? 0),
      replyCount: Number(row?.reply_count ?? 0),
    };
  }

  /**
   * Uncapped count of live attributed direct children of `parentId`
   * (`parent_id = $1` and `deleted_at IS NULL`, account or recorded zapper
   * pubkey). Unknown id is 0.
   *
   * @param parentId - Parent message id (`$1`).
   * @returns Count of matching children, mapped via `Number` (0 when none).
   */
  async countAttributedReplies(parentId: string): Promise<number> {
    const rows = await this.#sql.query<{
      reply_count: string | number | null;
    }>(
      `SELECT COUNT(*)::int AS reply_count
       FROM message child
       WHERE child.parent_id = $1
         AND child.deleted_at IS NULL
         AND (child.account_id IS NOT NULL
           OR (child.author_pubkey IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM nostr_zapper z
               WHERE z.pubkey = lower(child.author_pubkey))))`,
      [parentId],
    );
    const row = rows[0];
    const count = row === undefined ? undefined : row.reply_count;
    return Number(count === null || count === undefined ? 0 : count);
  }

  /**
   * Newest-first live top-level notes for one account, capped at `limit`,
   * with `replyCount` of live attributed children — a 21.gifts author or an
   * external zapper row with `author_pubkey` (same subquery as
   * {@link listLatest}).
   *
   * @param accountId - Author account id (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped list rows.
   */
  async listPostsByAccount(accountId: string, limit: number): Promise<MessageListRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS},
              (SELECT COUNT(*)::int FROM message child
               WHERE child.parent_id = message.id AND child.deleted_at IS NULL
                 AND (child.account_id IS NOT NULL
                   OR (child.author_pubkey IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM nostr_zapper z
                       WHERE z.pubkey = lower(child.author_pubkey))))) AS reply_count
       FROM message
       WHERE parent_id IS NULL AND deleted_at IS NULL AND account_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((row) => ({
      ...mapMessageRow(row),
      replyCount: Number(row.reply_count ?? 0),
    }));
  }

  /**
   * Newest-first live replies for one account (`parent_id IS NOT NULL`,
   * `deleted_at IS NULL`, `account_id = $1`). No `replyCount`.
   *
   * @param accountId - Author account id (`$1`).
   * @param limit - Maximum rows (`$2`).
   * @returns Mapped reply rows.
   */
  async listRepliesByAccount(accountId: string, limit: number): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND account_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [accountId, limit],
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
       WHERE event_id IS NOT NULL AND parent_id IS NULL AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.event_id);
  }

  /**
   * Insert `row` (and optional photo and video) into `message` and return it.
   *
   * Writes `content_fp` when media is present, `accountId` is not null, and
   * `eventId` is null. A non-null `parentId` requires a live parent
   * (`deletedAt` null): INSERT SELECT WHERE EXISTS. Replies bind `goal_sats`
   * SQL null even when the row carried a positive `goalSats`, bind
   * `goal_repayable` SQL null even when the row carried `true`, bind
   * `goal_term_days` SQL null even when the row carried a term, and bind place
   * columns SQL null even when the row carried a pin. A 0-row insert calls
   * `getById(stored.id)` and returns that row when present (gift-reply retry
   * after the parent was later deleted); otherwise throws, no insert. On unique
   * violation (`23505`), if `getById(stored.id)` matches that id, return that
   * row (no unlink — gift-reply retry). Otherwise unlink any video written for
   * the new id and return the existing live row from
   * {@link findLiveByAccountContent} when its place matches. A different place
   * throws `place conflicts with live media`.
   *
   * @param row - Fully formed message.
   * @param photo - Optional decoded photo.
   * @param video - Optional forum video (MIME on the row; bytes via `writeForumVideo` / disk).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9). Ignored when `video` is set.
   * @returns The stored row after a successful insert (a copy) with `hasPhoto`
   *   from `photo`, `photoCount` from photo 0 plus extras, and `hasVideo` /
   *   `videoContentType` from `video`. INSERT
   *   failure unlinks the video (`removeForumVideo`), except unique violation
   *   when `getById(stored.id)` matches that id (gift-reply retry, no unlink).
   */
  async create(
    row: MessageRow,
    photo?: ForumPhoto,
    video?: ForumVideo,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<MessageRow> {
    const extras = video !== undefined ? [] : [...(extraPhotos ?? [])];
    if (extras.length > 0 && photo === undefined) {
      throw new Error('extra photos require photo 0');
    }
    const hasPhoto = photo !== undefined;
    const hasVideo = video !== undefined;
    const snapshot = await resolvePaymentFiat(row.sats, row.createdAt, fiat, this.#paymentFiat);
    const contentFp =
      (photo !== undefined || video !== undefined) && row.accountId !== null && row.eventId === null
        ? video !== undefined
          ? forumContentFingerprint(row.text, video.bytes)
          : extras.length > 0
            ? forumContentFingerprint(
                row.text,
                photo!.bytes,
                extras.map((item) => item.bytes),
              )
            : forumContentFingerprint(row.text, photo!.bytes)
        : null;
    const stored = copyRow({
      ...unsignedNostrDefaults(),
      ...row,
      hasPhoto,
      hasVideo,
      videoContentType: video === undefined ? null : video.contentType,
      contentFp,
      photoCount: (hasPhoto ? 1 : 0) + extras.length,
      amountUsd: snapshot?.usd ?? null,
      amountChf: snapshot?.chf ?? null,
      amountEur: snapshot?.eur ?? null,
      amountPhp: snapshot?.php ?? null,
      photoTakenAts: photoTakenAtsForCreate(photo, extras),
      ...(typeof video?.takenAt === 'string' ? { videoTakenAt: video.takenAt } : {}),
    });
    applyStoredGoal(stored);
    stored.place = stored.parentId !== null ? null : (stored.place ?? null);
    // Create does not assign a shop account.
    stored.shopAccount = null;
    if (video !== undefined) {
      await writeForumVideo(stored.id, video);
    }
    const params: readonly unknown[] = [
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
      stored.nostrEvent,
      contentFp,
      stored.goalSats ?? null,
      stored.amountUsd ?? null,
      stored.amountChf ?? null,
      stored.amountEur ?? null,
      stored.amountPhp ?? null,
      photo === undefined ? null : (photo.takenAt ?? null),
      typeof video?.takenAt === 'string' ? video.takenAt : null,
      stored.place === null ? null : stored.place.lat,
      stored.place === null ? null : stored.place.lng,
      stored.place === null ? null : stored.place.label,
      stored.goalCurrency ?? null,
      stored.goalAmount ?? null,
      stored.goalAmountUsd ?? null,
      stored.goalAmountChf ?? null,
      stored.goalAmountEur ?? null,
      stored.goalAmountPhp ?? null,
      stored.goalRepayable === true ? true : null,
      stored.goalTermDays ?? null,
    ];
    try {
      if (stored.parentId !== null) {
        const inserted = await this.#sql.query<{ id: string }>(
          `INSERT INTO message (
           id, account_id, name, text, photo, photo_content_type, video_content_type, created_at,
           nostr_publish_state, sats, parent_id, author_pubkey, event_id, nostr_event, content_fp, goal_sats,
           fiat_usd, fiat_chf, fiat_eur, fiat_php, photo_taken_at, video_taken_at,
           place_lat, place_lng, place_label,
           goal_currency, goal_amount, goal_fiat_usd, goal_fiat_chf, goal_fiat_eur, goal_fiat_php, goal_repayable, goal_term_days
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
                $17::numeric,$18::numeric,$19::numeric,$20::numeric,$21,$22,$23,$24,$25,
                $26,$27::numeric,$28::numeric,$29::numeric,$30::numeric,$31::numeric,$32,$33
         WHERE EXISTS (SELECT 1 FROM message p WHERE p.id = $11 AND p.deleted_at IS NULL)
         RETURNING id`,
          params,
        );
        if (inserted.length === 0) {
          const byId = await this.getById(stored.id);
          if (byId !== undefined && byId.id === stored.id) {
            return byId;
          }
          throw new Error('parent missing or deleted');
        }
      } else {
        await this.#sql.execute(
          `INSERT INTO message (
           id, account_id, name, text, photo, photo_content_type, video_content_type, created_at,
           nostr_publish_state, sats, parent_id, author_pubkey, event_id, nostr_event, content_fp, goal_sats,
           fiat_usd, fiat_chf, fiat_eur, fiat_php, photo_taken_at, video_taken_at,
           place_lat, place_lng, place_label,
           goal_currency, goal_amount, goal_fiat_usd, goal_fiat_chf, goal_fiat_eur, goal_fiat_php, goal_repayable, goal_term_days
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
           $17::numeric,$18::numeric,$19::numeric,$20::numeric,$21,$22,$23,$24,$25,
           $26,$27::numeric,$28::numeric,$29::numeric,$30::numeric,$31::numeric,$32,$33
         )`,
          params,
        );
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        const byId = await this.getById(stored.id);
        if (byId !== undefined && byId.id === stored.id) {
          return byId;
        }
      }
      if (video !== undefined) {
        await removeForumVideo(stored.id, video.contentType);
      }
      if (isUniqueViolation(err) && contentFp !== null && stored.accountId !== null) {
        const existing = await this.findLiveByAccountContent(
          stored.accountId,
          stored.parentId ?? null,
          contentFp,
        );
        if (existing !== undefined) {
          if (!placesMatch(existing.place ?? null, stored.place ?? null)) {
            throw new Error('place conflicts with live media');
          }
          return existing;
        }
      }
      throw err;
    }
    for (const [i, extra] of extras.entries()) {
      try {
        await this.#sql.execute(
          `INSERT INTO message_extra_photo (message_id, idx, photo, photo_content_type, photo_taken_at) VALUES ($1,$2,$3,$4,$5)`,
          [stored.id, i + 1, extra.bytes, extra.contentType, extra.takenAt ?? null],
        );
      } catch (err) {
        await this.deleteById(stored.id);
        throw err;
      }
    }
    const marks = stored.mentions ?? [];
    if (marks.length > 0) {
      await this.#sql.execute(`UPDATE message SET mentions = $2::jsonb WHERE id = $1`, [
        stored.id,
        JSON.stringify(marks),
      ]);
    }
    return stored;
  }

  /**
   * Oldest live row for the same account, parent, and content fingerprint.
   *
   * @param accountId - Author account id (`$1`).
   * @param parentId - Parent note id, or `null` for top-level (`$2`).
   * @param contentFp - Content fingerprint hex (`$3`).
   * @returns The oldest matching live row, or `undefined`.
   */
  async findLiveByAccountContent(
    accountId: string,
    parentId: string | null,
    contentFp: string,
  ): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE account_id = $1
         AND content_fp = $3
         AND deleted_at IS NULL
         AND (
           ($2::uuid IS NULL AND parent_id IS NULL)
           OR parent_id IS NOT DISTINCT FROM $2
         )
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [accountId, parentId, contentFp],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const targets = await this.#sql.query<{ id: string; video_content_type: string | null }>(
      `WITH
         targets AS (
           SELECT id, video_content_type
           FROM message
           WHERE id = $1 OR parent_id = $1
         ),
         del_receipts AS (
           DELETE FROM nostr_zap_receipt
           WHERE message_id IN (SELECT id FROM targets)
         ),
         del_invoices AS (
           DELETE FROM message_invoice
           WHERE message_id IN (SELECT id FROM targets)
         ),
         del_rows AS (
           DELETE FROM message
           WHERE id IN (SELECT id FROM targets)
           RETURNING id
         )
       SELECT t.id, t.video_content_type FROM targets t`,
      [id],
    );
    if (targets.length === 0) {
      return false;
    }
    for (const target of targets) {
      const mime = parseVideoContentType(target.video_content_type);
      if (mime !== null) {
        await removeForumVideo(target.id, mime);
      }
    }
    return true;
  }

  async markDeleted(id: string, at: Date, byAccountId: string): Promise<boolean> {
    const rows = await this.#sql.query<{ id: string }>(
      `WITH target AS (
         SELECT id FROM message WHERE id = $1
       ), tagged AS (
         UPDATE message SET deleted_at = $2, deleted_by = $3
         WHERE deleted_at IS NULL AND (id = $1 OR parent_id = $1)
           AND EXISTS (SELECT 1 FROM target)
         RETURNING id
       )
       SELECT id FROM target`,
      [id, at, byAccountId],
    );
    return rows[0] !== undefined;
  }

  async markUndeleted(id: string): Promise<boolean> {
    const rows = await this.#sql.query<{ id: string }>(
      `WITH target AS (
         SELECT id, deleted_at, deleted_by FROM message WHERE id = $1
       ), cleared AS (
         UPDATE message m
         SET deleted_at = NULL, deleted_by = NULL
         FROM target t
         WHERE t.deleted_at IS NOT NULL
           AND (
             m.id = t.id
             OR (
               m.parent_id = t.id
               AND m.deleted_at IS NOT DISTINCT FROM t.deleted_at
               AND m.deleted_by IS NOT DISTINCT FROM t.deleted_by
             )
           )
         RETURNING m.id
       )
       SELECT id FROM target`,
      [id],
    );
    return rows[0] !== undefined;
  }

  async setPlace(id: string, place: ForumPlace | null): Promise<boolean> {
    const rows = await this.#sql.query<{ id: string }>(
      `UPDATE message SET place_lat = $2, place_lng = $3, place_label = $4 WHERE id = $1 RETURNING id`,
      [
        id,
        place === null ? null : place.lat,
        place === null ? null : place.lng,
        place === null ? null : place.label,
      ],
    );
    return rows[0] !== undefined;
  }

  async setShopAccount(
    id: string,
    account: { id: string; username: string; name: string } | null,
  ): Promise<boolean> {
    const rows = await this.#sql.query<{ id: string }>(
      `UPDATE message SET shop_account_id = $2 WHERE id = $1 RETURNING id`,
      [id, account === null ? null : account.id],
    );
    return rows[0] !== undefined;
  }

  /**
   * Direct children of `parentId` (`parent_id = $1`), including hidden,
   * Damus-only, and gift-only rows. Oldest `created_at` then `id` first.
   * Missing parent → `[]`.
   *
   * @param parentId - Parent message id (`$1`).
   * @returns Mapped child rows.
   */
  async listDirectChildren(parentId: string): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS} FROM message WHERE parent_id = $1 ORDER BY created_at ASC, id ASC`,
      [parentId],
    );
    return rows.map((row) => mapMessageRow(row));
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
           AND m.deleted_at IS NULL
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
           AND deleted_at IS NULL
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
         AND deleted_at IS NULL
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
       WHERE parent_id IS NULL AND deleted_at IS NULL
         AND event_id IS NOT NULL AND photo IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND nostr_attempts < ${MAX_PUBLISH_ATTEMPTS}
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
       WHERE parent_id IS NULL AND deleted_at IS NULL AND event_id IS NOT NULL
         AND video_content_type IN ('video/mp4', 'video/webm', 'video/quicktime')
         AND sats = 0
         AND nostr_publish_state = 'published'
         AND nostr_attempts < ${MAX_PUBLISH_ATTEMPTS}
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

  async listSignedMissingHashtags(
    limit: number,
    extraHashtagsByAccountId?: ReadonlyMap<string, readonly string[]>,
    excludeIds?: ReadonlySet<string>,
  ): Promise<MessageRow[]> {
    const extras = extraHashtagBindings(extraHashtagsByAccountId);
    const extraClause =
      extras === null
        ? ''
        : `
           OR EXISTS (
             SELECT 1
             FROM unnest($2::text[], $3::text[]) AS extra(account_id, pattern)
             WHERE message.account_id::text = extra.account_id
               AND NOT (LOWER(COALESCE(nostr_event->>'content', '')) ~ extra.pattern)
           )`;
    const excludeList = excludeIds === undefined || excludeIds.size === 0 ? null : [...excludeIds];
    const excludeParamIndex = extras === null ? 2 : 4;
    const excludeClause =
      excludeList === null
        ? ''
        : `\n         AND NOT (id::text = ANY($${excludeParamIndex}::text[]))`;
    const params: unknown[] =
      extras === null
        ? [limit]
        : [
            limit,
            postgresTextArrayLiteral(extras.accountIds),
            postgresTextArrayLiteral(extras.patterns),
          ];
    if (excludeList !== null) {
      params.push(postgresTextArrayLiteral(excludeList));
    }
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS}
       FROM message
       WHERE parent_id IS NULL AND deleted_at IS NULL AND event_id IS NOT NULL AND sats = 0
         AND nostr_publish_state = 'published'
         AND nostr_attempts < ${MAX_PUBLISH_ATTEMPTS}
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)
         AND (
           nostr_event IS NULL
           OR jsonb_typeof(nostr_event->'content') IS DISTINCT FROM 'string'
           OR NOT (LOWER(COALESCE(nostr_event->>'content', '')) ~ '#21gifts([^a-z0-9_]|$)')
           OR NOT (LOWER(COALESCE(nostr_event->>'content', '')) ~ '#bitcoin([^a-z0-9_]|$)')${extraClause}
         )${excludeClause}
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      params,
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async resetSignedEvent(id: string, expectedEventId: string | null): Promise<void> {
    await this.#sql.execute(
      `UPDATE message SET event_id = NULL, nostr_event = NULL, claimed_until = NULL,
         nostr_publish_state = 'pending', nostr_publish_epoch = NULL,
         nostr_attempts = message.nostr_attempts + 1,
         nostr_first_attempt_at = COALESCE(message.nostr_first_attempt_at, now())
       WHERE id = $1 AND event_id IS NOT DISTINCT FROM $2 AND sats = 0
         AND NOT EXISTS (SELECT 1 FROM message child WHERE child.parent_id = message.id)`,
      [id, expectedEventId],
    );
  }

  async updateText(id: string, text: string): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `UPDATE message SET text = $2 WHERE id = $1 RETURNING ${MESSAGE_SELECT_COLUMNS}`,
      [id, text],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async updatePhoto(id: string, photo: ForumPhoto | null): Promise<MessageRow | undefined> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `UPDATE message SET photo = $2, photo_content_type = $3, photo_taken_at = $4 WHERE id = $1 RETURNING ${MESSAGE_SELECT_COLUMNS}`,
      [
        id,
        photo === null ? null : photo.bytes,
        photo === null ? null : photo.contentType,
        photo === null || typeof photo.takenAt !== 'string' ? null : photo.takenAt,
      ],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessageRow(row);
  }

  async updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const rows = await this.#sql.query<{ id: string }>(
        `UPDATE message SET event_id = $2, nostr_event = $3::jsonb WHERE id = $1 RETURNING id`,
        [id, eventId, nostrEvent],
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

  async addSats(id: string, extraSats: number, delta: FiatAmounts | null): Promise<void> {
    await this.#sql.execute(
      `UPDATE message
       SET sats = sats + $2,
           fiat_usd = CASE
             WHEN $2::bigint = 0 THEN fiat_usd
             WHEN $3::numeric IS NULL THEN fiat_usd
             WHEN fiat_usd IS NULL THEN $3::numeric
             ELSE fiat_usd + $3::numeric
           END,
           fiat_chf = CASE
             WHEN $2::bigint = 0 THEN fiat_chf
             WHEN $4::numeric IS NULL THEN fiat_chf
             WHEN fiat_chf IS NULL THEN $4::numeric
             ELSE fiat_chf + $4::numeric
           END,
           fiat_eur = CASE
             WHEN $2::bigint = 0 THEN fiat_eur
             WHEN $5::numeric IS NULL THEN fiat_eur
             WHEN fiat_eur IS NULL THEN $5::numeric
             ELSE fiat_eur + $5::numeric
           END,
           fiat_php = CASE
             WHEN $2::bigint = 0 THEN fiat_php
             WHEN $6::numeric IS NULL THEN fiat_php
             WHEN fiat_php IS NULL THEN $6::numeric
             ELSE fiat_php + $6::numeric
           END,
           goal_funded_at = CASE
             WHEN goal_repayable IS TRUE
              AND goal_funded_at IS NULL
              AND goal_sats IS NOT NULL
              AND sats + $2::bigint >= goal_sats
             THEN now()
             ELSE goal_funded_at
           END
       WHERE id = $1`,
      [
        id,
        extraSats,
        delta?.usd ?? null,
        delta?.chf ?? null,
        delta?.eur ?? null,
        delta?.php ?? null,
      ],
    );
  }

  async listCreditPayers(messageId: string): Promise<
    {
      accountId: string;
      sats: number;
      usd: string | null;
      chf: string | null;
      eur: string | null;
      php: string | null;
    }[]
  > {
    const rows = await this.#sql.query<{
      account_id: string;
      sats: string | number;
      usd: string | null;
      chf: string | null;
      eur: string | null;
      php: string | null;
    }>(
      `SELECT r.payer_account_id AS account_id,
              SUM(r.sats)::bigint AS sats,
              CASE WHEN COUNT(i.fiat_usd) = COUNT(*) THEN SUM(i.fiat_usd)::text ELSE NULL END AS usd,
              CASE WHEN COUNT(i.fiat_chf) = COUNT(*) THEN SUM(i.fiat_chf)::text ELSE NULL END AS chf,
              CASE WHEN COUNT(i.fiat_eur) = COUNT(*) THEN SUM(i.fiat_eur)::text ELSE NULL END AS eur,
              CASE WHEN COUNT(i.fiat_php) = COUNT(*) THEN SUM(i.fiat_php)::text ELSE NULL END AS php
       FROM nostr_zap_receipt r
       LEFT JOIN LATERAL (
         SELECT fiat_usd, fiat_chf, fiat_eur, fiat_php
         FROM nostr_zap_ingest
         WHERE receipt_id = r.event_id
           AND outcome = 'indexed'
           AND message_id = r.message_id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) i ON true
       WHERE r.message_id = $1 AND r.payer_account_id IS NOT NULL
       GROUP BY r.payer_account_id`,
      [messageId],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      sats: Number(row.sats),
      usd: row.usd,
      chf: row.chf,
      eur: row.eur,
      php: row.php,
    }));
  }

  async sumUnassignedCreditSats(messageId: string): Promise<number> {
    const rows = await this.#sql.query<{ sats: string | number | null }>(
      `SELECT COALESCE(SUM(sats), 0)::bigint AS sats
       FROM nostr_zap_receipt
       WHERE message_id = $1 AND payer_account_id IS NULL`,
      [messageId],
    );
    return Number(rows[0]?.sats ?? 0);
  }

  async listRepayments(
    messageId: string,
  ): Promise<{ dayIndex: number; recipientAccountId: string; dueSats: number; paidAt: Date }[]> {
    const rows = await this.#sql.query<{
      day_index: number;
      recipient_account_id: string;
      due_sats: string | number;
      paid_at: Date | string;
    }>(
      `SELECT day_index, recipient_account_id, due_sats, paid_at
       FROM message_repayment
       WHERE message_id = $1`,
      [messageId],
    );
    return rows.map((row) => ({
      dayIndex: Number(row.day_index),
      recipientAccountId: row.recipient_account_id,
      dueSats: Number(row.due_sats),
      paidAt: row.paid_at instanceof Date ? row.paid_at : new Date(row.paid_at),
    }));
  }

  async markRepaymentPaid(row: {
    messageId: string;
    dayIndex: number;
    recipientAccountId: string;
    dueSats: number;
    paidAt: Date;
  }): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO message_repayment (message_id, day_index, recipient_account_id, due_sats, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, day_index, recipient_account_id) DO NOTHING`,
      [row.messageId, row.dayIndex, row.recipientAccountId, row.dueSats, row.paidAt],
    );
  }

  /**
   * Claim a lowercase payment hash once, allowing only its stored receipt id
   * to re-claim it.
   *
   * @param paymentHash - BOLT11 payment hash; stored lowercase.
   * @param receiptEventId - Kind:9735 or synthetic receipt event id.
   * @param at - Claim creation time.
   * @returns `true` for a new or same-owner claim; `false` for another owner.
   * @throws Propagates SQL insert and lookup failures.
   */
  async claimZapPayment(paymentHash: string, receiptEventId: string, at: Date): Promise<boolean> {
    const normalizedHash = paymentHash.toLowerCase();
    await this.#sql.execute(
      `INSERT INTO nostr_zap_payment (payment_hash, receipt_event_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (payment_hash) DO NOTHING`,
      [normalizedHash, receiptEventId, at],
    );
    const rows = await this.#sql.query<{ receipt_event_id: string }>(
      `SELECT receipt_event_id
       FROM nostr_zap_payment
       WHERE payment_hash = $1`,
      [normalizedHash],
    );
    return rows[0]?.receipt_event_id === receiptEventId;
  }

  async recordZapReceipt(
    receiptEventId: string,
    messageId: string,
    sats: number,
    delta: FiatAmounts | null,
  ): Promise<boolean> {
    const inserted = await this.#sql.query<{ event_id: string }>(
      `WITH inserted AS (
         INSERT INTO nostr_zap_receipt (event_id, message_id, sats)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id, message_id, sats
       )
       UPDATE message
       SET sats = message.sats + inserted.sats,
           fiat_usd = CASE
             WHEN inserted.sats = 0 THEN message.fiat_usd
             WHEN $4::numeric IS NULL THEN message.fiat_usd
             WHEN message.fiat_usd IS NULL THEN $4::numeric
             ELSE message.fiat_usd + $4::numeric
           END,
           fiat_chf = CASE
             WHEN inserted.sats = 0 THEN message.fiat_chf
             WHEN $5::numeric IS NULL THEN message.fiat_chf
             WHEN message.fiat_chf IS NULL THEN $5::numeric
             ELSE message.fiat_chf + $5::numeric
           END,
           fiat_eur = CASE
             WHEN inserted.sats = 0 THEN message.fiat_eur
             WHEN $6::numeric IS NULL THEN message.fiat_eur
             WHEN message.fiat_eur IS NULL THEN $6::numeric
             ELSE message.fiat_eur + $6::numeric
           END,
           fiat_php = CASE
             WHEN inserted.sats = 0 THEN message.fiat_php
             WHEN $7::numeric IS NULL THEN message.fiat_php
             WHEN message.fiat_php IS NULL THEN $7::numeric
             ELSE message.fiat_php + $7::numeric
           END,
           goal_funded_at = CASE
             WHEN message.goal_repayable IS TRUE
              AND message.goal_funded_at IS NULL
              AND message.goal_sats IS NOT NULL
              AND message.sats + inserted.sats >= message.goal_sats
             THEN now()
             ELSE message.goal_funded_at
           END
       FROM inserted
       WHERE message.id = inserted.message_id
       RETURNING inserted.event_id`,
      [
        receiptEventId,
        messageId,
        sats,
        delta?.usd ?? null,
        delta?.chf ?? null,
        delta?.eur ?? null,
        delta?.php ?? null,
      ],
    );
    return inserted[0] !== undefined;
  }

  async recordInvoiceAttempt(row: MessageInvoiceAttempt): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO message_invoice (
         id, created_at, message_id, payer_account_id, author_account_id,
         amount_sats, lightning_address, zap_request, result, http_status,
         pr, payment_hash, description, description_hash, is_nip57_invoice,
         lnurl_response, conversation_id, conversation_message_id,
         fiat_pinned, fiat_usd, fiat_chf, fiat_eur, fiat_php
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,
         $19,$20::numeric,$21::numeric,$22::numeric,$23::numeric
       )`,
      [
        row.id,
        row.createdAt,
        row.messageId,
        row.payerAccountId,
        row.authorAccountId,
        row.amountSats,
        row.lightningAddress,
        row.zapRequest,
        row.result,
        row.httpStatus,
        row.pr,
        row.paymentHash,
        row.description,
        row.descriptionHash,
        row.isNip57Invoice,
        row.lnurlResponse,
        row.conversationId,
        row.conversationMessageId,
        row.fiatPinned === true,
        row.amountUsd ?? null,
        row.amountChf ?? null,
        row.amountEur ?? null,
        row.amountPhp ?? null,
      ],
    );
  }

  async listInvoiceAttempts(limit: number): Promise<MessageInvoiceAttempt[]> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response, conversation_id, conversation_message_id,
              fiat_pinned, fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM message_invoice
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapInvoiceAttemptRow(row));
  }

  async listRecentOkInvoiceAttempts(since: Date, limit: number): Promise<MessageInvoiceAttempt[]> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response, conversation_id, conversation_message_id,
              fiat_pinned, fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM message_invoice
       WHERE result = 'ok' AND created_at >= $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [since, limit],
    );
    return rows.map((row) => mapInvoiceAttemptRow(row));
  }

  async recordZapIngest(row: ZapIngestRow): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO nostr_zap_ingest (
         id, created_at, receipt_id, note_event_id, message_id,
         outcome, reason, amount_sats, receipt_pubkey, receipt,
         fiat_usd, fiat_chf, fiat_eur, fiat_php
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::numeric,$12::numeric,$13::numeric,$14::numeric
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
        row.receipt,
        row.amountUsd ?? null,
        row.amountChf ?? null,
        row.amountEur ?? null,
        row.amountPhp ?? null,
      ],
    );
  }

  async listZapIngests(limit: number): Promise<ZapIngestRow[]> {
    const rows = await this.#sql.query<ZapIngestSqlRow>(
      `SELECT id, created_at, receipt_id, note_event_id, message_id,
              outcome, reason, amount_sats, receipt_pubkey, receipt,
              fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM nostr_zap_ingest
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapZapIngestRow(row));
  }

  async listExtraPhotoMeta(limit: number): Promise<
    Array<{
      messageId: string;
      idx: number;
      photoContentType: string;
      bytes: number;
      photoTakenAt: string | null;
    }>
  > {
    const rows = await this.#sql.query<{
      message_id: string;
      idx: number | string;
      photo_content_type: string;
      bytes: number | string;
      photo_taken_at?: string | null;
      video_taken_at?: string | null;
    }>(
      `SELECT message_id, idx, photo_content_type, octet_length(photo) AS bytes, photo_taken_at
       FROM message_extra_photo
       ORDER BY (SELECT created_at FROM message m WHERE m.id = message_extra_photo.message_id) DESC NULLS LAST,
                idx ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      idx: Number(row.idx),
      photoContentType: row.photo_content_type,
      bytes: Number(row.bytes),
      photoTakenAt: typeof row.photo_taken_at === 'string' ? row.photo_taken_at : null,
    }));
  }

  async listZapReceipts(limit: number): Promise<ZapReceiptDumpRow[]> {
    const rows = await this.#sql.query<{
      event_id: string;
      message_id: string;
      sats: number | string;
      payer_account_id: string | null;
      payer_pubkey: string | null;
      zap_request_id: string | null;
      gift_reply_id: string | null;
      comment: string | null;
    }>(
      `SELECT event_id, message_id, sats, payer_account_id, payer_pubkey, zap_request_id,
              gift_reply_id, comment
       FROM nostr_zap_receipt
       ORDER BY event_id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      eventId: row.event_id,
      messageId: row.message_id,
      sats: Number(row.sats),
      payerAccountId: row.payer_account_id,
      payerPubkey: row.payer_pubkey,
      zapRequestId: row.zap_request_id,
      giftReplyId: row.gift_reply_id,
      comment: row.comment ?? '',
    }));
  }

  async listZapPayments(
    limit: number,
  ): Promise<Array<{ paymentHash: string; receiptEventId: string; createdAt: string }>> {
    const rows = await this.#sql.query<{
      payment_hash: string;
      receipt_event_id: string;
      created_at: Date | string;
    }>(
      `SELECT payment_hash, receipt_event_id, created_at
       FROM nostr_zap_payment
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      paymentHash: row.payment_hash,
      receiptEventId: row.receipt_event_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
    }));
  }

  async listInvoiceAttemptsForPayer(payerAccountId: string): Promise<MessageInvoiceAttempt[]> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response, conversation_id, conversation_message_id,
              fiat_pinned, fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM message_invoice
       WHERE payer_account_id = $1
       ORDER BY created_at DESC, id DESC`,
      [payerAccountId],
    );
    return rows.map((row) => mapInvoiceAttemptRow(row));
  }

  async listIndexedZapIngests(): Promise<ZapIngestRow[]> {
    const rows = await this.#sql.query<ZapIngestSqlRow>(
      `SELECT id, created_at, receipt_id, note_event_id, message_id,
              outcome, reason, amount_sats, receipt_pubkey, receipt,
              fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM nostr_zap_ingest
       WHERE outcome = 'indexed'
       ORDER BY created_at DESC, id DESC`,
    );
    return rows.map((row) => mapZapIngestRow(row));
  }

  async listUnattributedIndexedReceipts(
    limit: number,
    before?: { createdAt: Date; eventId: string },
  ): Promise<UnattributedIndexedReceipt[]> {
    const beforeClause =
      before === undefined ? '' : '\n         AND (i.created_at, r.event_id) < ($2, $3)';
    const params: unknown[] =
      before === undefined ? [limit] : [limit, before.createdAt, before.eventId];
    const rows = await this.#sql.query<{
      event_id: string;
      message_id: string;
      sats: string | number;
      created_at: Date | string;
      receipt: Record<string, unknown> | string;
    }>(
      `SELECT r.event_id, r.message_id, r.sats, i.created_at, i.receipt
       FROM nostr_zap_receipt r
       JOIN LATERAL (
         SELECT created_at, receipt
         FROM nostr_zap_ingest
         WHERE receipt_id = r.event_id AND outcome = 'indexed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) i ON true
       WHERE r.payer_account_id IS NULL AND r.payer_pubkey IS NULL
         AND r.zap_request_id IS NULL AND r.gift_reply_id IS NULL${beforeClause}
       ORDER BY i.created_at DESC, r.event_id DESC
       LIMIT $1`,
      params,
    );
    return rows.map((row) => ({
      receiptEventId: row.event_id,
      messageId: row.message_id,
      sats: Number(row.sats),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      receipt: parseJsonObject(row.receipt) ?? {},
    }));
  }

  /**
   * Every `message` row for `account_id`, including hidden notes and replies.
   * Newest-first, no `LIMIT`.
   *
   * @param accountId - Author account id (`$1`).
   * @returns Mapped rows.
   */
  async listAuthoredMessages(accountId: string): Promise<MessageRow[]> {
    const rows = await this.#sql.query<MessageSqlRow>(
      `SELECT ${MESSAGE_SELECT_COLUMNS} FROM message WHERE account_id = $1 ORDER BY created_at DESC, id DESC`,
      [accountId],
    );
    return rows.map((row) => mapMessageRow(row));
  }

  async findOkInvoiceByPaymentHash(
    paymentHash: string,
  ): Promise<MessageInvoiceAttempt | undefined> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response, conversation_id, conversation_message_id,
              fiat_pinned, fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM message_invoice
       WHERE payment_hash = $1 AND result = 'ok'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [paymentHash],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapInvoiceAttemptRow(row);
  }

  async findOkInvoiceByPr(pr: string): Promise<MessageInvoiceAttempt | undefined> {
    const rows = await this.#sql.query<MessageInvoiceSqlRow>(
      `SELECT id, created_at, message_id, payer_account_id, author_account_id,
              amount_sats, lightning_address, zap_request, result, http_status,
              pr, payment_hash, description, description_hash, is_nip57_invoice,
              lnurl_response, conversation_id, conversation_message_id,
              fiat_pinned, fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
              fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
       FROM message_invoice
       WHERE pr = $1 AND result = 'ok'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [pr],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapInvoiceAttemptRow(row);
  }

  async listOpenConversationZapEventIds(): Promise<
    ReadonlyArray<{ eventId: string; conversationMessageId: string }>
  > {
    const rows = await this.#sql.query<
      Pick<MessageInvoiceSqlRow, 'zap_request' | 'conversation_message_id'>
    >(
      `SELECT zap_request, conversation_message_id
       FROM message_invoice
       WHERE result = 'ok' AND conversation_id IS NOT NULL AND conversation_message_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversation_message m WHERE m.id = message_invoice.conversation_message_id)`,
    );
    const listed: { eventId: string; conversationMessageId: string }[] = [];
    for (const row of rows) {
      const eventId = zapRequestEventId(parseJsonObject(row.zap_request));
      if (eventId === null) {
        continue;
      }
      const conversationMessageId = row.conversation_message_id;
      if (conversationMessageId === undefined || conversationMessageId === null) {
        continue;
      }
      listed.push({ eventId, conversationMessageId });
    }
    return listed;
  }

  async attributeZapReceipt(
    receiptEventId: string,
    attribution: { payerPubkey: string; zapRequestId: string; comment: string },
  ): Promise<boolean> {
    try {
      const rows = await this.#sql.query<{ event_id: string }>(
        `UPDATE nostr_zap_receipt
         SET payer_pubkey = lower($2), zap_request_id = $3, comment = $4
         WHERE event_id = $1
           AND (zap_request_id IS NULL OR zap_request_id = $3)
           AND NOT EXISTS (
             SELECT 1 FROM nostr_zap_receipt other
             WHERE other.zap_request_id = $3 AND other.event_id <> $1
           )
         RETURNING event_id`,
        [receiptEventId, attribution.payerPubkey, attribution.zapRequestId, attribution.comment],
      );
      return rows[0] !== undefined;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async recordZapper(pubkey: string, receiptEventId: string, at: Date): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO nostr_zapper (pubkey, receipt_event_id, created_at)
       VALUES (lower($1), $2, $3)
       ON CONFLICT (pubkey) DO NOTHING`,
      [pubkey, receiptEventId, at],
    );
  }

  async listZapperPubkeys(): Promise<string[]> {
    const rows = await this.#sql.query<{ pubkey: string }>(`SELECT pubkey FROM nostr_zapper`);
    return rows.map((row) => row.pubkey);
  }

  /**
   * Whether one external pubkey is a recorded zapper (has the read-visibility entitlement).
   *
   * @param pubkey - External author pubkey, compared case-insensitively.
   * @returns `true` when a zapper entitlement row exists for that pubkey.
   */
  async isZapperPubkey(pubkey: string): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `SELECT 1 FROM nostr_zapper WHERE pubkey = $1 LIMIT 1`,
      [pubkey.toLowerCase()],
    );
    return rows[0] !== undefined;
  }

  async listZappers(limit: number): Promise<NostrZapperRow[]> {
    const rows = await this.#sql.query<{
      pubkey: string;
      receipt_event_id: string;
      created_at: Date | string;
    }>(
      `SELECT pubkey, receipt_event_id, created_at
       FROM nostr_zapper
       ORDER BY created_at DESC, pubkey DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      pubkey: row.pubkey,
      receiptEventId: row.receipt_event_id,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));
  }

  async blockPubkeyAndHideRows(
    pubkey: string,
    at: Date,
    byAccountId: string,
    messageId: string,
  ): Promise<number> {
    const rows = await this.#sql.query<{ id: string }>(
      `WITH blocked AS (
         INSERT INTO nostr_blocked_pubkey (pubkey, blocked_at, blocked_by, message_id)
         VALUES (lower($1), $2, $3, $4)
         ON CONFLICT (pubkey) DO NOTHING
       ), hidden AS (
         UPDATE message
         SET deleted_at = $2, deleted_by = $3
         WHERE deleted_at IS NULL AND account_id IS NULL AND lower(author_pubkey) = lower($1)
         RETURNING id
       )
       SELECT id FROM hidden`,
      [pubkey, at, byAccountId, messageId],
    );
    return rows.length;
  }

  async unblockPubkeyByMessage(messageId: string): Promise<boolean> {
    const rows = await this.#sql.query<{ pubkey: string }>(
      `DELETE FROM nostr_blocked_pubkey WHERE message_id = $1 RETURNING pubkey`,
      [messageId],
    );
    return rows[0] !== undefined;
  }

  async isPubkeyBlocked(pubkey: string): Promise<boolean> {
    const rows = await this.#sql.query<Record<string, unknown>>(
      `SELECT 1 FROM nostr_blocked_pubkey WHERE pubkey = $1 LIMIT 1`,
      [pubkey.toLowerCase()],
    );
    return rows[0] !== undefined;
  }

  async listBlockedPubkeys(): Promise<string[]> {
    const rows = await this.#sql.query<{ pubkey: string }>(
      `SELECT pubkey FROM nostr_blocked_pubkey`,
    );
    return rows.map((row) => row.pubkey);
  }

  async listBlockedPubkeyRows(limit: number): Promise<NostrBlockedPubkeyRow[]> {
    const rows = await this.#sql.query<{
      pubkey: string;
      blocked_at: Date | string;
      blocked_by: string;
      message_id: string;
    }>(
      `SELECT pubkey, blocked_at, blocked_by, message_id
       FROM nostr_blocked_pubkey
       ORDER BY blocked_at DESC, pubkey DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      pubkey: row.pubkey,
      blockedAt: row.blocked_at instanceof Date ? row.blocked_at : new Date(row.blocked_at),
      blockedBy: row.blocked_by,
      messageId: row.message_id,
    }));
  }

  async updateZapReceiptGift(receiptEventId: string, patch: ZapReceiptGiftPatch): Promise<void> {
    const assignments: string[] = [];
    const params: unknown[] = [receiptEventId];
    if (patch.payerAccountId !== undefined) {
      params.push(patch.payerAccountId);
      assignments.push(`payer_account_id = $${params.length}`);
    }
    if (patch.payerPubkey !== undefined) {
      params.push(patch.payerPubkey);
      assignments.push(`payer_pubkey = $${params.length}`);
    }
    if (patch.giftReplyId !== undefined) {
      params.push(patch.giftReplyId);
      assignments.push(`gift_reply_id = $${params.length}`);
    }
    if (patch.comment !== undefined) {
      params.push(patch.comment);
      assignments.push(`comment = $${params.length}`);
    }
    if (assignments.length === 0) {
      return;
    }
    await this.#sql.execute(
      `UPDATE nostr_zap_receipt SET ${assignments.join(', ')} WHERE event_id = $1`,
      params,
    );
  }

  async getZapReceiptGift(receiptEventId: string): Promise<ZapReceiptGiftState | undefined> {
    const rows = await this.#sql.query<{
      event_id: string;
      message_id: string;
      sats: string | number;
      payer_account_id: string | null;
      payer_pubkey: string | null;
      zap_request_id: string | null;
      gift_reply_id: string | null;
      comment: string | null;
    }>(
      `SELECT event_id, message_id, sats, payer_account_id, payer_pubkey, zap_request_id,
              gift_reply_id, comment
       FROM nostr_zap_receipt
       WHERE event_id = $1`,
      [receiptEventId],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      receiptEventId: row.event_id,
      messageId: row.message_id,
      sats: Number(row.sats),
      payerAccountId: row.payer_account_id,
      payerPubkey: row.payer_pubkey,
      zapRequestId: row.zap_request_id,
      giftReplyId: row.gift_reply_id,
      comment: row.comment ?? '',
    };
  }

  async listZapReceiptsAwaitingGiftReply(limit: number): Promise<ZapReceiptGiftRow[]> {
    const rows = await this.#sql.query<{
      event_id: string;
      message_id: string;
      sats: string | number;
      payer_account_id: string | null;
      payer_pubkey: string | null;
      zap_request_id: string | null;
      receipt_created_at: Date | string | null;
      comment: string | null;
    }>(
      `SELECT r.event_id, r.message_id, r.sats, r.payer_account_id, r.payer_pubkey,
              r.zap_request_id, r.comment,
              CASE WHEN (i.receipt->>'created_at') ~ '^\\d+$'
                THEN to_timestamp((i.receipt->>'created_at')::double precision)
                ELSE NULL END AS receipt_created_at
       FROM nostr_zap_receipt r
       LEFT JOIN LATERAL (
         SELECT receipt FROM nostr_zap_ingest
         WHERE receipt_id = r.event_id AND outcome = 'indexed'
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) i ON true
       WHERE gift_reply_id IS NULL
         AND (payer_account_id IS NOT NULL OR payer_pubkey IS NOT NULL)
       ORDER BY event_id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      receiptEventId: row.event_id,
      messageId: row.message_id,
      sats: Number(row.sats),
      payerAccountId: row.payer_account_id,
      payerPubkey: row.payer_pubkey,
      zapRequestId: row.zap_request_id,
      receiptCreatedAt:
        row.receipt_created_at === null || row.receipt_created_at === undefined
          ? null
          : row.receipt_created_at instanceof Date
            ? row.receipt_created_at
            : new Date(row.receipt_created_at),
      comment: row.comment ?? '',
    }));
  }

  /**
   * Load photo bytes for a message id.
   *
   * @param id - Message id (`$1`).
   * @returns Photo copy, or `null` when missing / null photo / bad type.
   */
  async getPhoto(id: string): Promise<ForumPhoto | null> {
    const rows = await this.#sql.query<MessagePhotoSqlRow>(
      `SELECT photo, photo_content_type, photo_taken_at FROM message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.photo === null || row.photo_content_type === null) {
      return null;
    }
    if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
      return null;
    }
    const photo: ForumPhoto = {
      contentType: row.photo_content_type as ForumPhotoContentType,
      bytes: toUint8Array(row.photo),
    };
    if (typeof row.photo_taken_at === 'string') {
      photo.takenAt = row.photo_taken_at;
    }
    return photo;
  }

  /**
   * Load one extra still (indices 1–9) for a message id.
   *
   * @param id - Message id (`$1`).
   * @param index - Extra index (1–9) (`$2`). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range / bad type.
   */
  async getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null> {
    if (index < 1 || index > 9) {
      return null;
    }
    const rows = await this.#sql.query<MessagePhotoSqlRow>(
      `SELECT photo, photo_content_type, photo_taken_at FROM message_extra_photo WHERE message_id = $1 AND idx = $2`,
      [id, index],
    );
    const row = rows[0];
    if (row === undefined || row.photo === null || row.photo_content_type === null) {
      return null;
    }
    if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
      return null;
    }
    const photo: ForumPhoto = {
      contentType: row.photo_content_type as ForumPhotoContentType,
      bytes: toUint8Array(row.photo),
    };
    if (typeof row.photo_taken_at === 'string') {
      photo.takenAt = row.photo_taken_at;
    }
    return photo;
  }

  /**
   * Extra stills for a message id, ordered by index ascending.
   *
   * @param id - Message id (`$1`).
   * @returns Copies of extras (length 0–9). Empty when none. Skips unrecognized types.
   */
  async listExtraPhotos(id: string): Promise<ForumPhoto[]> {
    const rows = await this.#sql.query<MessagePhotoSqlRow & { idx: number | string }>(
      `SELECT idx, photo, photo_content_type, photo_taken_at FROM message_extra_photo WHERE message_id = $1 ORDER BY idx ASC`,
      [id],
    );
    const extras: ForumPhoto[] = [];
    for (const row of rows) {
      if (row.photo === null || row.photo_content_type === null) {
        continue;
      }
      if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
        continue;
      }
      const photo: ForumPhoto = {
        contentType: row.photo_content_type as ForumPhotoContentType,
        bytes: toUint8Array(row.photo),
      };
      if (typeof row.photo_taken_at === 'string') {
        photo.takenAt = row.photo_taken_at;
      }
      extras.push(photo);
    }
    return extras;
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
  conversation_id?: string | null;
  conversation_message_id?: string | null;
  fiat_pinned?: boolean | null;
  fiat_usd?: string | number | null;
  fiat_chf?: string | number | null;
  fiat_eur?: string | number | null;
  fiat_php?: string | number | null;
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
  fiat_usd: string | number | null;
  fiat_chf: string | number | null;
  fiat_eur: string | number | null;
  fiat_php: string | number | null;
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
    conversationId: row.conversation_id ?? null,
    conversationMessageId: row.conversation_message_id ?? null,
    fiatPinned: row.fiat_pinned === true,
    amountUsd: row.fiat_usd === null || row.fiat_usd === undefined ? null : String(row.fiat_usd),
    amountChf: row.fiat_chf === null || row.fiat_chf === undefined ? null : String(row.fiat_chf),
    amountEur: row.fiat_eur === null || row.fiat_eur === undefined ? null : String(row.fiat_eur),
    amountPhp: row.fiat_php === null || row.fiat_php === undefined ? null : String(row.fiat_php),
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
    amountUsd: row.fiat_usd === null ? null : String(row.fiat_usd),
    amountChf: row.fiat_chf === null ? null : String(row.fiat_chf),
    amountEur: row.fiat_eur === null ? null : String(row.fiat_eur),
    amountPhp: row.fiat_php === null ? null : String(row.fiat_php),
    receiptPubkey: row.receipt_pubkey,
    receipt,
  };
}
