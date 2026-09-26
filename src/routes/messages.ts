import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { roleAtLeast } from '@/lib/auth/roles';
import type { Account, AccountRole, AuthStore } from '@/lib/auth/store';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import {
  canonicalGoalAmount,
  fiatToSats,
  satsToFiatAmount,
  type GoalCurrency,
  type GoalFiatCode,
  type GoalRateDay,
} from '@/lib/goal-rate';
import { eligibleToday } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { logEvent } from '@/lib/log';
import { shownFiatFromBody, type FiatAmounts } from '@/lib/money';
import { buildPostStats } from '@/lib/post-stats';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import {
  MESSAGE_LIST_LIMIT,
  MESSAGE_MAX_LENGTH,
  MESSAGE_PHOTO_MAX_BYTES,
  decodeForumPhoto,
  decodeMessageFeedCursor,
  encodeMessageFeedCursor,
  forumContentFingerprint,
  forumPhotoResponse,
  normalizeForumText,
  normalizePhotoTakenAt,
  serializeHiddenMessage,
  serializeMessage,
  unsignedNostrDefaults,
  type ForumFeedMode,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import {
  textHasHashtagToken,
  type MessageFeedQuery,
  type MessageInvoiceAttempt,
  type MessageInvoiceResult,
  type MessageStore,
} from '@/lib/message-store';
import type { TranslateTarget } from '@/lib/translate-config';
import {
  TranslateNotConfiguredError,
  TranslateUpstreamError,
  translateForumNote,
} from '@/lib/translate-note';
import { InMemoryTranslationStore, type TranslationStore } from '@/lib/translation-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import type { NostrPublisher } from '@/lib/nostr/publish';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { retractHiddenForumNotes } from '@/lib/nostr/retract';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { mentionUsernames } from '@/lib/mention';
import { notifyForumMentions, notifyForumPost, notifyForumReply } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import type { SpendPing } from '@/lib/spend-ping';
import { syncWelcomePing } from '@/lib/welcome-media';
import { normalizePlace, parseMultipartCoord, placesMatch, type ForumPlace } from '@/lib/place';
import { recordFirstShopOcpPlace, type MapPush } from '@/lib/ocp-place';

import { bearerToken } from '@/routes/me';
import {
  MESSAGE_VIDEO_MAX_BYTES,
  decodeForumVideo,
  forumVideoExt,
  forumVideoFilePresent,
  parseBytesRange,
  readForumVideoBytes,
  resolveMediaDir,
  videoFilePath,
  type ForumVideo,
} from '@/lib/video';
import { stat } from 'node:fs/promises';

/**
 * Delete a `hasVideo` row whose file is missing or empty. Notes without video
 * are unchanged.
 *
 * @param store - Message store.
 * @param row - Store row.
 * @returns The row, or `null` when it was deleted.
 */
async function dropMissingVideoRow(
  store: MessageStore,
  row: MessageRow,
): Promise<MessageRow | null> {
  if (
    row.hasVideo !== true ||
    row.videoContentType === undefined ||
    row.videoContentType === null
  ) {
    return row;
  }
  const present = await forumVideoFilePresent(resolveMediaDir(), row.id, row.videoContentType);
  if (present) {
    return row;
  }
  await store.deleteById(row.id);
  logEvent('messages.video.dropped');
  return null;
}

/** True when `err` is a Node errno with `code === 'ENOENT'`. */
function isPathNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Placeholder author id when the message/author is unknown at persist time. */
const UNKNOWN_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

/** Whole-sat ceiling for optional `goalSats` (`GIFT_INVOICE_MAX_MSAT / 1000`). */
const GOAL_SATS_MAX = GIFT_INVOICE_MAX_MSAT / 1000;

/** 400 body when the author's LNURL cannot mint a forum-creditable zap (`noZap` / `not_zap`). */
const AUTHOR_WALLET_CANNOT_RECEIVE = "The author's wallet cannot receive this Bitcoin payment";

/**
 * Whether a forum row can mint a zap: non-empty signed `eventId` plus a
 * non-blank author Lightning Address. Null or empty `eventId` and
 * whitespace-only addresses are not payable.
 *
 * @param row - Forum row (`eventId` is the mint gate).
 * @param author - Author account when known.
 * @returns True when list/get should mark the note payable.
 */
function payableOf(
  row: { eventId: string | null },
  author: { lightningAddress: string | null } | undefined,
): boolean {
  const address = author?.lightningAddress;
  const eventId = row.eventId;
  return eventId !== null && eventId !== '' && typeof address === 'string' && address.trim() !== '';
}

/**
 * Persist an invoice attempt without failing the HTTP payment response.
 *
 * @param store - Forum store.
 * @param row - Attempt row.
 */
async function persistInvoiceAttempt(
  store: MessageStore,
  row: MessageInvoiceAttempt,
): Promise<void> {
  try {
    await store.recordInvoiceAttempt(row);
  } catch {
    logEvent('message.invoice.record_failed');
  }
}

/**
 * Build an invoice-attempt row (caller sets result-specific fields).
 *
 * @param args - Common fields for every attempt after auth.
 */
function invoiceAttemptBase(args: {
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
  lnurlResponse?: Record<string, unknown> | null;
  shown?: { pinned: false } | { pinned: true; fiat: FiatAmounts };
}): MessageInvoiceAttempt {
  const shown = args.shown?.pinned === true ? args.shown : undefined;
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(),
    messageId: args.messageId,
    payerAccountId: args.payerAccountId,
    authorAccountId: args.authorAccountId,
    amountSats: args.amountSats,
    lightningAddress: args.lightningAddress,
    zapRequest: args.zapRequest,
    result: args.result,
    httpStatus: args.httpStatus,
    pr: args.pr,
    paymentHash: args.paymentHash,
    description: args.description,
    descriptionHash: args.descriptionHash,
    isNip57Invoice: args.isNip57Invoice,
    lnurlResponse: args.lnurlResponse ?? null,
    conversationId: null,
    conversationMessageId: null,
    fiatPinned: shown !== undefined,
    amountUsd: shown?.fiat.usd ?? null,
    amountChf: shown?.fiat.chf ?? null,
    amountEur: shown?.fiat.eur ?? null,
    amountPhp: shown?.fiat.php ?? null,
  };
}

/**
 * `/messages` — signed-in member forum: list every message, post text and/or
 * one photo when the account has a display name, serve photo bytes publicly
 * for Nostr clients, and pay a published note. Shares the {@link AuthStore}
 * with `/auth` and `/me`.
 */

/** Collaborators the `/messages` routes need. */
export interface MessagesRouteDeps {
  /** Forum persistence. */
  store: MessageStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Optional AES KEK; without it invoice signing is 503. */
  nostrKek?: Uint8Array;
  /** LNURL fetch (invoice path). */
  fetchImpl?: FetchFn;
  /** Post limiter (tests inject). */
  postLimiter?: PostRateLimiter;
  /** Invoice limiter (tests inject). */
  invoiceLimiter?: InvoiceRateLimiter;
  /** Optional push outbox; also the bell-subscriber list. */
  pushStore?: PushStore;
  /**
   * Optional spend ping. After a new top-level persist with a Lightning
   * Address, the route awaits `ping(address, created.id)` only when
   * `eligibleToday` and the new row has media. A verified account also
   * welcome-pings the newest live top-level photo or video, including an
   * About-me note that already existed, independent of `eligibleToday`.
   * Omitted → skip. Failures are logged and do not fail the 200.
   */
  spendPing?: SpendPing;
  /**
   * Optional push of a first `#21GiftsShop` pin to the OpenCryptoPay map.
   * Omitted → the forum write still succeeds and nothing is sent.
   */
  mapPush?: MapPush;
  /**
   * Funding grants for spend-ping eligibility (default: empty
   * {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
  /**
   * Optional in-app notification store. When present, living-room events
   * fan out via {@link notifyForumPost} / {@link notifyForumReply} to every
   * account except the actor (no-op when the actor is the official platform
   * account); Web Push still uses `pushStore` subscriptions.
   */
  notificationStore?: NotificationStore;
  /** Optional inbox store; forum/zap payloads include listed unread when set. */
  conversationStore?: ConversationStore;
  /**
   * Optional Nostr publisher for staff-hide NIP-09. Omitted (or omitted
   * `nostrKek`) → skip retract after `markDeleted`.
   */
  nostrPublisher?: NostrPublisher;
  /**
   * Optional env slice for retract relays, public media URLs, and Cloudflare
   * purge. Omitted → `{}` on the DELETE retract path.
   */
  env?: Record<string, string | undefined>;
  /**
   * Cached DeepL output per message and locale (default: empty
   * {@link InMemoryTranslationStore}).
   */
  translationStore?: TranslationStore;
  /** Sleep between `sinceSats` polls (tests inject). */
  waitSatsSleep?: (ms: number) => Promise<void>;
  /** Max wait for `sinceSats` (tests inject; default {@link WAIT_SATS_TIMEOUT_MS}). */
  waitSatsTimeoutMs?: number;
  /** Poll interval for `sinceSats` (tests inject; default {@link WAIT_SATS_POLL_MS}). */
  waitSatsPollMs?: number;
  /**
   * Latest gift-day used to freeze a currency ask. Omitted means no day:
   * a BTC ask still posts; a fiat ask is 400. A throw is 503 for a fiat
   * ask; a BTC ask still stores the typed sats.
   */
  goalRateDay?: () => Promise<GoalRateDay | null>;
}

const defaultPostLimiter = new PostRateLimiter();
const defaultInvoiceLimiter = new InvoiceRateLimiter();

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MessagesRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** True when the bearer is a founder or moderator session. */
async function staffMayReadHidden(
  deps: MessagesRouteDeps,
  header: string | undefined,
): Promise<boolean> {
  const account = await authedAccount(deps, header);
  return account !== null && roleAtLeast(account.role, 'moderator');
}

/**
 * Resolve `{ id, name, role }` for a hide stamp. Same rules as `GET /hidden`.
 *
 * @param authStore - Account lookup.
 * @param row - Hidden forum row.
 * @returns Deleter object; missing account keeps the id with null name/role.
 */
async function resolveDeletedBy(
  authStore: AuthStore,
  row: MessageRow,
): Promise<{ id: string | null; name: string | null; role: AccountRole | null }> {
  if (row.deletedBy === null) {
    return { id: null, name: null, role: null };
  }
  const deleter = await authStore.getAccount(row.deletedBy);
  return deleter === undefined
    ? { id: row.deletedBy, name: null, role: null }
    : { id: deleter.id, name: deleter.name, role: deleter.role };
}

/** Hex UUID as stored on `message.id` (rejects values Postgres would error on). */
export const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max wait for `GET /messages/:id?sinceSats=` before returning the current body. */
export const WAIT_SATS_TIMEOUT_MS = 25_000;

/** Poll interval while waiting for `sats` to exceed `sinceSats`. */
export const WAIT_SATS_POLL_MS = 250;

/**
 * Default sleep between `sinceSats` polls when no test inject is provided.
 *
 * @param ms - Milliseconds to wait.
 */
async function defaultWaitSatsSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a live row is withheld from the public read paths (`GET /:id`,
 * photo and video bytes). A reply without an account is public only while
 * its author pubkey holds a zapper entitlement; a reply with neither an
 * account nor an author pubkey is never public. Top-level notes and rows
 * with an account are always public.
 *
 * @param deps - Message store.
 * @param row - Live message row.
 * @returns `true` when the row must answer 404 on a public read.
 */
async function withheldFromPublic(deps: MessagesRouteDeps, row: MessageRow): Promise<boolean> {
  if (row.parentId === null || row.accountId !== null) {
    return false;
  }
  return row.authorPubkey === null || !(await deps.store.isZapperPubkey(row.authorPubkey));
}

/**
 * Public photo bytes for Nostr clients. Same handler for `/photo` and
 * `/photo.jpg` (Damus only embeds URLs with an image extension). Extra stills
 * (indices 1–9) use `/photo/1.jpg` … `/photo/9.webp`.
 *
 * @param deps - Message store.
 * @param c - Request (Authorization for staff hidden reads).
 * @param id - Path id.
 * @param index - Extra still index (1–9). Omitted = photo 0 (`getPhoto`).
 * @returns 200 bytes, 404, or 503.
 */
async function serveForumPhoto(
  deps: MessagesRouteDeps,
  c: Context,
  id: string,
  index?: number,
): Promise<Response> {
  if (!MESSAGE_ID_RE.test(id)) {
    return Response.json({ error: 'Photo not found' }, { status: 404 });
  }
  try {
    const row = await deps.store.getById(id);
    if (row === undefined) {
      return Response.json({ error: 'Photo not found' }, { status: 404 });
    }
    if (
      row.deletedAt !== null &&
      !(await staffMayReadHidden(deps, c.req.header('authorization')))
    ) {
      return Response.json({ error: 'Photo not found' }, { status: 404 });
    }
    if (row.deletedAt === null && (await withheldFromPublic(deps, row))) {
      return Response.json({ error: 'Photo not found' }, { status: 404 });
    }
    const photo =
      index === undefined
        ? await deps.store.getPhoto(id)
        : await deps.store.getExtraPhoto(id, index);
    if (photo === null) {
      return Response.json({ error: 'Photo not found' }, { status: 404 });
    }
    const res = forumPhotoResponse(photo);
    if (row.deletedAt !== null) {
      res.headers.set('Cache-Control', 'private, no-store');
      res.headers.set('Vary', 'Authorization');
    }
    return res;
  } catch {
    logEvent('messages.photo.failed');
    return Response.json({ error: 'Messages are unavailable' }, { status: 503 });
  }
}

/**
 * Serve public video bytes with Range support so Damus can seek.
 *
 * Loads bytes via {@link readForumVideoBytes} (heal-on-read faststart) and
 * returns a sized `Uint8Array` body so `Content-Length` is kept. Missing /
 * empty / non-file paths are 404; unsatisfiable ranges are 416; other I/O is
 * 503.
 *
 * @param deps - Message store.
 * @param c - Request (Range header).
 * @param id - Message id.
 * @param ext - Path extension (`mp4` / `webm` / `mov`).
 * @returns 200, 206, 404, 416, or 503.
 */
async function serveForumVideo(
  deps: MessagesRouteDeps,
  c: Context,
  id: string,
  ext: 'mp4' | 'webm' | 'mov',
): Promise<Response> {
  if (!MESSAGE_ID_RE.test(id)) {
    return Response.json({ error: 'Video not found' }, { status: 404 });
  }
  try {
    const row = await deps.store.getById(id);
    const mime = row?.videoContentType ?? null;
    if (row === undefined || row.hasVideo !== true || mime === null) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    if (
      row.deletedAt !== null &&
      !(await staffMayReadHidden(deps, c.req.header('authorization')))
    ) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    if (row.deletedAt === null && (await withheldFromPublic(deps, row))) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    if (forumVideoExt(mime) !== ext) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    const path = videoFilePath(resolveMediaDir(), id, mime);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile() || fileStat.size === 0) {
        return Response.json({ error: 'Video not found' }, { status: 404 });
      }
    } catch (err) {
      if (isPathNotFound(err)) {
        return Response.json({ error: 'Video not found' }, { status: 404 });
      }
      throw err;
    }
    const remuxed = await readForumVideoBytes(path);
    const size = remuxed.byteLength;
    if (size === 0) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    const range = parseBytesRange(c.req.header('range') ?? undefined, size);
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': row.deletedAt !== null ? 'private, no-store' : 'public, max-age=86400',
      ...(row.deletedAt !== null ? { Vary: 'Authorization' } : {}),
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `inline; filename="video.${ext}"`,
    };
    if (range.type === 'unsatisfiable') {
      headers['Content-Range'] = `bytes */${size}`;
      return new Response(null, { status: 416, headers });
    }
    const body = range.type === 'full' ? remuxed : remuxed.slice(range.start, range.end + 1);
    const status = range.type === 'full' ? 200 : 206;
    headers['Content-Length'] = String(body.byteLength);
    if (range.type === 'partial') {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    }
    return new Response(body, { status, headers });
  } catch {
    logEvent('messages.video.failed');
    return Response.json({ error: 'Messages are unavailable' }, { status: 503 });
  }
}

const GOAL_PAIR_ERROR = 'Send either goalSats or both goalCurrency and goalAmount';
const ASK_UNAVAILABLE = 'Ask amount is unavailable';

/** Frozen ask stored on a top-level note. All null when there is no goal. */
interface FrozenAsk {
  goalSats: number | null;
  goalCurrency: GoalCurrency | null;
  goalAmount: string | null;
  goalAmountUsd: string | null;
  goalAmountChf: string | null;
  goalAmountEur: string | null;
  goalAmountPhp: string | null;
}

const NO_ASK: FrozenAsk = {
  goalSats: null,
  goalCurrency: null,
  goalAmount: null,
  goalAmountUsd: null,
  goalAmountChf: null,
  goalAmountEur: null,
  goalAmountPhp: null,
};

function isGoalCurrency(value: unknown): value is GoalCurrency {
  return (
    value === 'BTC' || value === 'USD' || value === 'CHF' || value === 'EUR' || value === 'PHP'
  );
}

function goalFieldPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

type GoalPair =
  | { ok: true; legacy: number | null; currency: GoalCurrency | null; amount: string | null }
  | { ok: false; error: string };

/** Legacy `goalSats` alone, or both new fields. Anything else is 400. */
function readGoalPair(legacy: number | null, currency: unknown, amount: unknown): GoalPair {
  const currencyPresent = goalFieldPresent(currency);
  const amountPresent = goalFieldPresent(amount);
  if (!currencyPresent && !amountPresent) {
    return { ok: true, legacy, currency: null, amount: null };
  }
  if (
    legacy !== null ||
    !currencyPresent ||
    !amountPresent ||
    !isGoalCurrency(currency) ||
    typeof amount !== 'string'
  ) {
    return { ok: false, error: GOAL_PAIR_ERROR };
  }
  return { ok: true, legacy: null, currency, amount };
}

function readFormGoalField(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return 'invalid';
  }
  if (value.trim() === '') {
    return null;
  }
  return value;
}

function freezeSnapshots(
  sats: number,
  currency: GoalCurrency,
  amount: string,
  day: GoalRateDay | null,
): FrozenAsk {
  const quote = (code: GoalFiatCode): string | null => satsToFiatAmount(sats, day, code);
  return {
    goalSats: sats,
    goalCurrency: currency,
    goalAmount: amount,
    goalAmountUsd: quote('USD'),
    goalAmountChf: quote('CHF'),
    goalAmountEur: quote('EUR'),
    goalAmountPhp: quote('PHP'),
  };
}

type AskOutcome = { ok: true; goal: FrozenAsk } | { ok: false; status: 400 | 503; error: string };

/**
 * Freeze a top-level ask. Legacy sats skip the loader. A BTC ask still stores
 * the typed sats when the loader throws or returns no day. A fiat ask is 503
 * when the loader throws and 400 when the day cannot price it.
 */
async function freezeAsk(
  deps: MessagesRouteDeps,
  legacy: number | null,
  currency: GoalCurrency | null,
  amount: string | null,
): Promise<AskOutcome> {
  if (currency === null || amount === null) {
    return { ok: true, goal: { ...NO_ASK, goalSats: legacy } };
  }
  const canonical = canonicalGoalAmount(amount);
  if (canonical === null) {
    return { ok: false, status: 400, error: GOAL_PAIR_ERROR };
  }
  let day: GoalRateDay | null = null;
  if (deps.goalRateDay !== undefined) {
    try {
      day = await deps.goalRateDay();
    } catch {
      if (currency !== 'BTC') {
        return { ok: false, status: 503, error: 'Messages are unavailable' };
      }
    }
  }
  if (currency === 'BTC') {
    const sats = Number(canonical);
    if (!/^\d+$/.test(canonical) || !Number.isInteger(sats) || sats < 1 || sats > GOAL_SATS_MAX) {
      return { ok: false, status: 400, error: 'Goal must be a positive whole-sat amount' };
    }
    return { ok: true, goal: freezeSnapshots(sats, 'BTC', canonical, day) };
  }
  const sats = fiatToSats(Number(canonical), day, currency);
  if (sats === null || !Number.isInteger(sats) || sats < 1 || sats > GOAL_SATS_MAX) {
    return { ok: false, status: 400, error: ASK_UNAVAILABLE };
  }
  return { ok: true, goal: freezeSnapshots(sats, currency, canonical, day) };
}

async function frozenAskResponse(
  deps: MessagesRouteDeps,
  c: Context,
  legacy: number | null,
  currency: GoalCurrency | null,
  amount: string | null,
): Promise<{ goal: FrozenAsk } | Response> {
  const frozen = await freezeAsk(deps, legacy, currency, amount);
  if (!frozen.ok) {
    if (frozen.status === 503) {
      logEvent('messages.create.failed');
    }
    return c.json({ error: frozen.error }, frozen.status);
  }
  return { goal: frozen.goal };
}

/**
 * Media collapse → burst limiter → create → optional {@link notifyForumPost}
 * (every account except the actor; no-op when the actor is the official
 * platform account) for a top-level note, or {@link notifyForumReply} (same
 * skip) when `parentId` is set. Web Push still uses `pushStore` subscriptions.
 * Shared by JSON and multipart after body parse / normalize / decode.
 *
 * @param deps - Store, clock, optional push / spend ping / notification stores.
 * @param postLimiter - Per-account burst limiter.
 * @param c - Request context (JSON / headers).
 * @param account - Authenticated account.
 * @param authorName - Display name snapshot.
 * @param text - Normalised forum text.
 * @param parentId - Reply parent, or `null` for top-level (multipart is always null).
 * @param photo - Optional decoded photo / poster.
 * @param video - Optional decoded video.
 * @param extraPhotos - Optional extra stills (indices 1..n). Omit when empty.
 * @param goal - Frozen ask. Default is no goal. Stored null when `parentId` is set.
 * @param place - Optional map pin for a top-level note. Default `null`.
 *   Stored as `null` when `parentId` is set.
 * @returns 200 / 403 (unpaid text-only below verified) / 409 (same live
 *   media, different pin) / 429 / 503.
 */
async function persistForumPost(
  deps: MessagesRouteDeps,
  postLimiter: PostRateLimiter,
  c: Context,
  account: Account,
  authorName: string,
  text: string,
  parentId: string | null,
  photo?: ForumPhoto,
  video?: ForumVideo,
  extraPhotos?: readonly ForumPhoto[],
  goal: FrozenAsk = NO_ASK,
  place: ForumPlace | null = null,
): Promise<Response> {
  const extras = video !== undefined ? [] : [...(extraPhotos ?? [])];
  if (photo !== undefined || video !== undefined) {
    const fp =
      video !== undefined
        ? forumContentFingerprint(text, video.bytes)
        : extras.length > 0
          ? forumContentFingerprint(
              text,
              photo!.bytes,
              extras.map((item) => item.bytes),
            )
          : forumContentFingerprint(text, photo!.bytes);
    try {
      const existing = await deps.store.findLiveByAccountContent(account.id, parentId, fp);
      if (existing !== undefined) {
        if (!placesMatch(existing.place ?? null, place)) {
          return c.json({ error: 'A live note with this media already exists' }, 409);
        }
        return c.json(
          serializeMessage(existing, payableOf(existing, account), account.role, undefined, true),
          200,
        );
      }
    } catch {
      logEvent('messages.create.failed');
      return c.json({ error: 'Messages are unavailable' }, 503);
    }
  }
  if (!roleAtLeast(account.role, 'verified') && photo === undefined && video === undefined) {
    return c.json(
      {
        error:
          parentId === null ? 'A post needs a Bitcoin payment' : 'A reply needs a Bitcoin payment',
      },
      403,
    );
  }
  if (!postLimiter.allow(account.id, deps.now())) {
    logEvent('messages.rate_limited', { accountId: account.id });
    c.header('Retry-After', '10');
    return c.json({ error: 'Too many messages' }, 429);
  }
  const id = crypto.randomUUID();
  const mentions: { accountId: string; username: string }[] = [];
  for (const username of mentionUsernames(text)) {
    const marked = await deps.authStore.getAccountByUsername(username);
    if (marked !== undefined) {
      mentions.push({ accountId: marked.id, username });
    }
  }
  const row: MessageRow = {
    id,
    accountId: account.id,
    name: authorName,
    text,
    mentions,
    createdAt: new Date(deps.now()),
    hasPhoto: photo !== undefined,
    hasVideo: video !== undefined,
    videoContentType: video === undefined ? null : video.contentType,
    ...unsignedNostrDefaults(),
    parentId,
    goalSats: parentId === null ? goal.goalSats : null,
    goalCurrency: parentId === null ? goal.goalCurrency : null,
    goalAmount: parentId === null ? goal.goalAmount : null,
    goalAmountUsd: parentId === null ? goal.goalAmountUsd : null,
    goalAmountChf: parentId === null ? goal.goalAmountChf : null,
    goalAmountEur: parentId === null ? goal.goalAmountEur : null,
    goalAmountPhp: parentId === null ? goal.goalAmountPhp : null,
    place: parentId === null ? place : null,
  };
  try {
    const created =
      extras.length > 0
        ? await deps.store.create(row, photo, video, extras)
        : photo === undefined && video === undefined
          ? await deps.store.create(row)
          : await deps.store.create(row, photo, video);
    const isReplay = created.id !== id;
    if (!isReplay && parentId === null) {
      try {
        await notifyForumPost({
          account,
          created,
          auth: deps.authStore,
          ...(deps.notificationStore === undefined
            ? {}
            : { notifications: deps.notificationStore }),
          ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
          /* v8 ignore next 5 -- createApp always injects conversationStore */
          ...(deps.conversationStore === undefined
            ? {}
            : {
                inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.authStore),
              }),
        });
      } catch {
        logEvent('push.enqueue.failed');
      }
    }
    if (
      !isReplay &&
      parentId === null &&
      account.lightningAddress !== null &&
      deps.spendPing !== undefined
    ) {
      try {
        const grant = await (deps.fundingStore ?? new InMemoryFundingStore()).getByAccountId(
          account.id,
        );
        if (!eligibleToday(account.role, grant, deps.now())) {
          logEvent('spend.ping.skipped', { reason: 'not_eligible' });
        } else if (
          created.hasPhoto === true ||
          created.hasVideo === true ||
          Number(created.photoCount) > 0
        ) {
          await deps.spendPing.ping(account.lightningAddress, created.id);
        } else {
          logEvent('spend.ping.skipped', { reason: 'no_media' });
        }
      } catch {
        logEvent('spend.ping.failed');
      }
      await syncWelcomePing({
        spendPing: deps.spendPing,
        messages: deps.store,
        account,
      });
    }
    if (!isReplay && parentId !== null) {
      try {
        await notifyForumReply({
          messages: deps.store,
          account,
          created,
          parentId,
          auth: deps.authStore,
          ...(deps.notificationStore === undefined
            ? {}
            : { notifications: deps.notificationStore }),
          ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
          /* v8 ignore next 5 -- createApp always injects conversationStore */
          ...(deps.conversationStore === undefined
            ? {}
            : {
                inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.authStore),
              }),
        });
      } catch {
        logEvent('messages.reply.notify.failed');
      }
    }
    if (!isReplay && (created.mentions ?? []).length > 0) {
      try {
        let isActive = created.sats > 0;
        let threadId = created.id;
        if (parentId !== null) {
          const parent = await deps.store.getById(parentId);
          isActive = parent !== undefined && parent.sats > 0;
          threadId = parent?.id ?? parentId;
        }
        await notifyForumMentions({
          account,
          created,
          parentId: threadId,
          isActive,
          auth: deps.authStore,
          ...(deps.notificationStore === undefined
            ? {}
            : { notifications: deps.notificationStore }),
          ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
          ...(deps.conversationStore === undefined
            ? {}
            : {
                inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.authStore),
              }),
        });
      } catch {
        logEvent('messages.mention.notify.failed');
      }
    }
    if (!isReplay) {
      await recordFirstShopOcpPlace({
        ...(deps.mapPush === undefined ? {} : { mapPush: deps.mapPush }),
        messageId: created.id,
        text: created.text,
        parentId: created.parentId ?? null,
        place: created.place ?? null,
        authorName: created.name,
        hadPlaceBefore: false,
        textHasHashtagToken,
      });
    }
    return c.json(
      serializeMessage(created, payableOf(created, account), account.role, undefined, true),
      200,
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'place conflicts with live media') {
      return c.json({ error: 'A live note with this media already exists' }, 409);
    }
    logEvent('messages.create.failed');
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
}

/**
 * `POST /messages` as multipart (`video` file + optional `poster` + `text`).
 * Always top-level (`parentId` null). Applies media collapse and `postLimiter`
 * after form parse (same order as JSON).
 *
 * @param deps - Store and clock.
 * @param postLimiter - Per-account burst limiter.
 * @param c - Request.
 * @param account - Authenticated account (already named).
 * @param authorName - Display name snapshot.
 * @returns 200 / 400 / 429 / 503.
 */
async function postMultipartMessage(
  deps: MessagesRouteDeps,
  postLimiter: PostRateLimiter,
  c: Context,
  account: Account,
  authorName: string,
): Promise<Response> {
  const form = await c.req.formData();
  /* v8 ignore next -- form.get is string or File */
  const rawText = String(form.get('text') ?? '');
  const text = normalizeForumText(rawText);
  if (text === null) {
    return c.json({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` }, 400);
  }
  const videoPart = form.get('video');
  let video: ForumVideo | undefined;
  if (videoPart instanceof File && videoPart.size > 0) {
    if (videoPart.size > MESSAGE_VIDEO_MAX_BYTES) {
      return c.json({ error: 'Video must be an MP4, WebM, or MOV under 32 MiB' }, 400);
    }
    const decoded = decodeForumVideo(new Uint8Array(await videoPart.arrayBuffer()));
    if (decoded === null) {
      return c.json({ error: 'Video must be an MP4, WebM, or MOV under 32 MiB' }, 400);
    }
    video = decoded;
  }
  const posterPart = form.get('poster');
  let photo: ForumPhoto | undefined;
  if (posterPart instanceof File && posterPart.size > 0) {
    if (posterPart.size > MESSAGE_PHOTO_MAX_BYTES) {
      return c.json({ error: 'Poster must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
    }
    const raw = new Uint8Array(await posterPart.arrayBuffer());
    const decoded = decodeForumPhoto('image/jpeg', Buffer.from(raw).toString('base64'));
    if (decoded === null) {
      return c.json({ error: 'Poster must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
    }
    photo = decoded;
  }
  if (text === '' && photo === undefined && video === undefined) {
    return c.json(
      { error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo or video` },
      400,
    );
  }
  const rawGoal = form.get('goalSats');
  let legacySats: number | null = null;
  if (rawGoal !== null && rawGoal !== '') {
    if (typeof rawGoal !== 'string' || !/^\d+$/.test(rawGoal)) {
      return c.json({ error: 'Goal must be a positive whole-sat amount' }, 400);
    }
    const parsedGoal = Number(rawGoal);
    if (parsedGoal < 1 || parsedGoal > GOAL_SATS_MAX) {
      return c.json({ error: 'Goal must be a positive whole-sat amount' }, 400);
    }
    legacySats = parsedGoal;
  }
  const currencyField = readFormGoalField(form.get('goalCurrency'));
  const amountField = readFormGoalField(form.get('goalAmount'));
  if (currencyField === 'invalid' || amountField === 'invalid') {
    return c.json({ error: GOAL_PAIR_ERROR }, 400);
  }
  const shaped = readGoalPair(legacySats, currencyField, amountField);
  if (!shaped.ok) {
    return c.json({ error: shaped.error }, 400);
  }
  let place: ForumPlace | null = null;
  const placeLat = form.get('placeLat');
  const placeLng = form.get('placeLng');
  const placeLabel = form.get('placeLabel');
  const latParsed = parseMultipartCoord(placeLat);
  const lngParsed = parseMultipartCoord(placeLng);
  const latMissing = latParsed === 'missing';
  const lngMissing = lngParsed === 'missing';
  if (!latMissing || !lngMissing) {
    if (latMissing || lngMissing || latParsed === 'invalid' || lngParsed === 'invalid') {
      return c.json({ error: 'Place must be a latitude and longitude' }, 400);
    }
    const parsedPlace = normalizePlace({
      lat: latParsed,
      lng: lngParsed,
      ...(placeLabel === null || placeLabel === '' ? {} : { label: placeLabel }),
    });
    if (!parsedPlace.ok) {
      return c.json({ error: parsedPlace.error }, 400);
    }
    place = parsedPlace.value;
  }
  const frozen = await frozenAskResponse(deps, c, shaped.legacy, shaped.currency, shaped.amount);
  if (frozen instanceof Response) {
    return frozen;
  }
  return persistForumPost(
    deps,
    postLimiter,
    c,
    account,
    authorName,
    text,
    null,
    photo,
    video,
    undefined,
    frozen.goal,
    place,
  );
}

/** Body schema for posting a forum message (text and/or photo; optional reply / goal). */
const postBody = z
  .object({
    text: z.string().optional(),
    inReplyTo: z.string().optional(),
    goalSats: z.number().int().positive().max(GOAL_SATS_MAX).nullish(),
    goalCurrency: z.unknown().nullish(),
    goalAmount: z.unknown().nullish(),
    place: z.unknown().nullish(),
    photo: z
      .object({
        contentType: z.string(),
        data: z.string(),
        takenAt: z.unknown().nullish(),
      })
      .optional(),
    photos: z
      .array(
        z.object({
          contentType: z.string(),
          data: z.string(),
          takenAt: z.unknown().nullish(),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine(
    (body) =>
      body.text !== undefined ||
      body.photo !== undefined ||
      (Array.isArray(body.photos) && body.photos.length > 0),
  );

/** Body schema for a note invoice. Optional `text` is the NIP-57 comment. */
const invoiceBody = z.object({
  sats: z.number().int().positive(),
  text: z.string().optional(),
  amountUsd: z.string().nullable().optional(),
  amountChf: z.string().nullable().optional(),
  amountEur: z.string().nullable().optional(),
  amountPhp: z.string().nullable().optional(),
});

const translateBody = z.object({
  target: z.enum(['en', 'de', 'es', 'fil']),
});

/**
 * Build the `/messages` route group.
 *
 * Mounted at `/messages` so the public paths are `GET /messages`,
 * `POST /messages` (JSON photo or multipart `video` + optional `poster`,
 * optional `goalSats` whole-sat ask on a top-level note; replies 400),
 * `GET /messages/places` (live top-level map pins),
 * `GET /messages/compose-target` (platform profile note for a 1-sat write),
 * `GET /messages/:id/photo` (and `.jpg` / `.jpeg` / `.png` / `.webp`),
 * `GET /messages/:id/video.mp4|.webm|.mov`, public `GET /messages/:id/replies`
 * (optional Bearer for `accountId`), staff `DELETE /messages/:id` (soft-hide
 * plus best-effort NIP-09 and Cloudflare media purge when publisher+kek are
 * set),
 * staff `GET /messages/hidden` (moderator session log), public
 * `GET /messages/stats` (no session; living notes and replies as one count),
 * public `GET /messages/:id` (optional `?sinceSats=` non-negative integer
 * long-polls until `sats` is strictly greater; timeout still returns 200 with
 * the current body; invalid value 400), `POST /messages/:id/invoice`, and
 * `POST /:id/translate` / `POST /messages/:id/translate`.
 * Photo, video, replies, DELETE, `GET /stats`, `GET /hidden`, and `GET /places`
 * register before the public single-note `GET /:id`. Soft-hidden rows (`deletedAt`) are omitted from
 * lists and 404 on unsigned/non-staff reads; a founder/moderator session may
 * GET the hidden permalink, its replies (including hidden children), and
 * photo/video bytes. `getById` still returns hidden rows for workers. Public
 * `GET /:id` of a live reply with `accountId` null returns 200 with
 * `via: 'nostr'` only while its `authorPubkey` holds a zapper entitlement
 * (`isZapperPubkey`); without the entitlement, or with neither an account
 * nor an author pubkey, it is 404, and the photo and video routes answer
 * 404 for the same live rows. Top-level Damus-only notes stay 200. Public
 * `GET /:id/replies` lists live children with either an account or an
 * author pubkey that is a recorded zapper; Bearer is optional (`accountId`
 * present only when signed in). Staff hide retracts in-app notifications
 * for the note and its direct children. Deleting an external row
 * (`accountId` null with `authorPubkey` set) also blocks that pubkey,
 * soft-hides its other live external rows, and logs
 * `messages.external.blocked` with the target `messageId` and total
 * `hidden` count.
 *
 * @param deps - Message store, auth store, clock, optional `pushStore` /
 * `notificationStore` / `conversationStore` / `nostrPublisher` / `env`,
 * optional `translationStore` (default `InMemoryTranslationStore`), and
 * test injects `waitSatsSleep` / `waitSatsTimeoutMs` / `waitSatsPollMs`
 * (defaults `defaultWaitSatsSleep` / `WAIT_SATS_TIMEOUT_MS` /
 * `WAIT_SATS_POLL_MS`).
 * @returns A Hono app with `GET /`, `POST /`, `GET /compose-target`,
 * `GET /places`, `GET /:id/photo` plus `.jpg` / `.jpeg` / `.png` / `.webp`,
 * `GET /:id/video.mp4|.webm|.mov`, public `GET /:id/replies` (optional Bearer
 * for `accountId`), `DELETE /:id`, staff `PATCH /:id/place` (moderator session;
 * no `forum.read`), staff `GET /hidden` (moderator session; no
 * `forum.read`), public `GET /:id` (optional `?sinceSats=`), and
 * `POST /:id/invoice`, `POST /:id/translate`, and public `GET /stats`.
 */
/**
 * Unsigned `GET /messages` window: `mode=active` only, first 200 raw rows.
 *
 * A cursor that points at the 200th row is 401. A cursor whose id is gone
 * continues at the first row strictly older than its timestamp, or is 401
 * when nothing in the window is older. Anything other than `mode=active`
 * without a hashtag is 401.
 * Malformed limit or cursor stays 400.
 *
 * @param deps - Route collaborators.
 * @param c - Hono context (no bearer).
 * @returns The public page, 400, or 401.
 */
async function servePublicActiveList(deps: MessagesRouteDeps, c: Context): Promise<Response> {
  if (c.req.query('mode') !== 'active' || c.req.query('hashtag') !== undefined) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const limitQuery = c.req.query('limit');
  let limit: number;
  if (limitQuery === undefined) {
    limit = MESSAGE_LIST_LIMIT;
  } else if (/^\d+$/.test(limitQuery)) {
    const n = Number(limitQuery);
    if (n < 1 || n > MESSAGE_LIST_LIMIT) {
      return c.json({ error: 'Invalid limit' }, 400);
    }
    limit = n;
  } else {
    return c.json({ error: 'Invalid limit' }, 400);
  }
  const cursorQuery = c.req.query('cursor');
  let cursorId: string | null = null;
  let cursorAtMs = Number.NaN;
  if (cursorQuery !== undefined) {
    const decoded = decodeMessageFeedCursor(cursorQuery);
    if (decoded === null || decoded.k !== 't' || !MESSAGE_ID_RE.test(decoded.i)) {
      return c.json({ error: 'Invalid cursor' }, 400);
    }
    cursorId = decoded.i;
    cursorAtMs = Date.parse(decoded.c);
  }
  try {
    const staffAccountIds = new Set(await deps.authStore.listStaffAccountIds());
    const rows = await deps.store.listFeed({
      limit: MESSAGE_LIST_LIMIT + 1,
      mode: 'active',
      cursor: null,
      staffAccountIds,
    });
    const window = rows.slice(0, MESSAGE_LIST_LIMIT);
    const more = rows.length > MESSAGE_LIST_LIMIT;
    let start = 0;
    if (cursorId !== null) {
      const index = window.findIndex((row) => row.id === cursorId);
      if (index === MESSAGE_LIST_LIMIT - 1) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (index >= 0) {
        start = index + 1;
      } else {
        const older = window.findIndex((row) => row.createdAt.getTime() < cursorAtMs);
        if (older < 0) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        start = older;
      }
    }
    const page = window.slice(start, start + limit);
    const maybeKept = await Promise.all(
      page.map(async (row) => {
        const kept = await dropMissingVideoRow(deps.store, row);
        return kept === null ? null : { ...kept, replyCount: row.replyCount };
      }),
    );
    const kept = maybeKept.filter((row): row is NonNullable<typeof row> => row !== null);
    const authors = await Promise.all(
      kept.map((row) =>
        row.accountId === null
          ? Promise.resolve(undefined)
          : deps.authStore.getAccount(row.accountId),
      ),
    );
    const messages = kept.map((row, i) => {
      const author = authors[i];
      const payable = payableOf(row, author);
      const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
      return serializeMessage(row, payable, role, row.replyCount);
    });
    const last = page[page.length - 1];
    const anchor = kept.length > 0 ? kept[kept.length - 1] : last;
    let nextCursor: string | undefined;
    if (anchor !== undefined) {
      const lastIndex = window.findIndex((row) => row.id === anchor.id);
      const pageFull = page.length === limit;
      const reachesEnd = lastIndex === window.length - 1;
      const includesBoundary = lastIndex === MESSAGE_LIST_LIMIT - 1;
      if ((pageFull && !reachesEnd) || (includesBoundary && more)) {
        nextCursor = encodeMessageFeedCursor({
          k: 't',
          c: anchor.createdAt.toISOString(),
          i: anchor.id,
        });
      }
    }
    return c.json(nextCursor === undefined ? { messages } : { messages, nextCursor }, 200);
  } catch {
    logEvent('messages.list.failed');
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
}

/**
 * Build the `/messages` route group.
 *
 * `GET /` with no Authorization header and `mode=active` and no hashtag is
 * the public window (`servePublicActiveList`). Any present Authorization
 * header must be a live session, or the response is 401. A session still
 * needs `forum.read`.
 *
 * @param deps - Stores, clock, and optional push, notification, and inbox
 * dependencies.
 * @returns Hono app mounted at `/messages`.
 */
export function messagesRoutes(deps: MessagesRouteDeps): Hono {
  const postLimiter = deps.postLimiter ?? defaultPostLimiter;
  const invoiceLimiter = deps.invoiceLimiter ?? defaultInvoiceLimiter;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const translationStore = deps.translationStore ?? new InMemoryTranslationStore();

  return new Hono()
    .get('/', async (c) => {
      const header = c.req.header('authorization');
      if (header === undefined) {
        return servePublicActiveList(deps, c);
      }
      const token = bearerToken(header);
      const account =
        token === null ? null : await resolveSession(deps.authStore, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const gate = requireAction(account, 'forum.read');
      if (!gate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
      }
      const modeQuery = c.req.query('mode');
      let mode: ForumFeedMode;
      if (modeQuery === undefined) {
        mode = 'all';
      } else if (
        modeQuery === 'all' ||
        modeQuery === 'active' ||
        modeQuery === 'unpaid' ||
        modeQuery === 'popular'
      ) {
        mode = modeQuery;
      } else {
        return c.json({ error: 'Invalid mode' }, 400);
      }
      const limitQuery = c.req.query('limit');
      let limit: number;
      if (limitQuery === undefined) {
        limit = MESSAGE_LIST_LIMIT;
      } else if (/^\d+$/.test(limitQuery)) {
        const n = Number(limitQuery);
        if (n < 1 || n > MESSAGE_LIST_LIMIT) {
          return c.json({ error: 'Invalid limit' }, 400);
        }
        limit = n;
      } else {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      const cursorQuery = c.req.query('cursor');
      let cursor: MessageFeedQuery['cursor'] = null;
      if (cursorQuery !== undefined) {
        const decoded = decodeMessageFeedCursor(cursorQuery);
        if (decoded === null) {
          return c.json({ error: 'Invalid cursor' }, 400);
        }
        if (!MESSAGE_ID_RE.test(decoded.i)) {
          return c.json({ error: 'Invalid cursor' }, 400);
        }
        if (mode === 'popular') {
          if (decoded.k !== 's') {
            return c.json({ error: 'Invalid cursor' }, 400);
          }
          cursor = { k: 's', s: decoded.s, c: new Date(decoded.c), i: decoded.i };
        } else if (decoded.k !== 't') {
          return c.json({ error: 'Invalid cursor' }, 400);
        } else {
          cursor = { k: 't', c: new Date(decoded.c), i: decoded.i };
        }
      }
      const hashtagQuery = c.req.query('hashtag');
      if (hashtagQuery !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(hashtagQuery)) {
        return c.json({ error: 'Invalid hashtag' }, 400);
      }
      try {
        const staffAccountIds =
          mode === 'active'
            ? new Set(await deps.authStore.listStaffAccountIds())
            : new Set<string>();
        const rows = await deps.store.listFeed({
          limit,
          mode,
          cursor,
          staffAccountIds,
          ...(hashtagQuery === undefined ? {} : { hashtag: hashtagQuery }),
        });
        const maybeKept = await Promise.all(
          rows.map(async (row) => {
            const kept = await dropMissingVideoRow(deps.store, row);
            return kept === null ? null : { ...kept, replyCount: row.replyCount };
          }),
        );
        const kept = maybeKept.filter((row): row is NonNullable<typeof row> => row !== null);
        const authors = await Promise.all(
          kept.map((row) =>
            row.accountId === null
              ? Promise.resolve(undefined)
              : deps.authStore.getAccount(row.accountId),
          ),
        );
        const messages = kept.map((row, i) => {
          const author = authors[i];
          const payable = payableOf(row, author);
          const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
          return serializeMessage(row, payable, role, row.replyCount, true);
        });
        let nextCursor: string | undefined;
        if (rows.length === limit) {
          const last = rows[rows.length - 1];
          if (last !== undefined) {
            nextCursor =
              mode === 'popular'
                ? encodeMessageFeedCursor({
                    k: 's',
                    s: last.sats,
                    c: last.createdAt.toISOString(),
                    i: last.id,
                  })
                : encodeMessageFeedCursor({
                    k: 't',
                    c: last.createdAt.toISOString(),
                    i: last.id,
                  });
          }
        }
        return c.json(nextCursor === undefined ? { messages } : { messages, nextCursor }, 200);
      } catch {
        logEvent('messages.list.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const gate = requireAction(account, 'forum.post');
      if (!gate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
      }
      /* v8 ignore next -- requireAction already rejected a missing name */
      const authorName = (account.name ?? '').trim();
      /* v8 ignore next -- missing content-type is JSON parse 400 */
      const requestType = c.req.header('content-type') ?? '';
      if (requestType.toLowerCase().includes('multipart/form-data')) {
        return postMultipartMessage(deps, postLimiter, c, account, authorName);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      if (
        raw !== null &&
        typeof raw === 'object' &&
        Array.isArray((raw as { photos?: unknown }).photos) &&
        (raw as { photos: unknown[] }).photos.length > 10
      ) {
        return c.json({ error: 'At most 10 photos' }, 400);
      }
      const parsed = postBody.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with text and/or photo' }, 400);
      }
      const parsedPlace = normalizePlace(parsed.data.place);
      if (!parsedPlace.ok) {
        return c.json({ error: parsedPlace.error }, 400);
      }
      if (parsedPlace.value !== null && parsed.data.inReplyTo !== undefined) {
        return c.json({ error: 'A reply cannot include a place' }, 400);
      }
      const place = parsedPlace.value;
      const rawText = parsed.data.text ?? '';
      const text = normalizeForumText(rawText);
      if (text === null) {
        return c.json({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` }, 400);
      }
      let photo: ForumPhoto | undefined;
      let extraPhotos: ForumPhoto[] = [];
      const gallery = parsed.data.photos;
      if (gallery !== undefined && gallery.length > 0) {
        const decodedGallery: ForumPhoto[] = [];
        for (const item of gallery) {
          const decoded = decodeForumPhoto(item.contentType, item.data);
          if (decoded === null) {
            return c.json({ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
          }
          decoded.takenAt = normalizePhotoTakenAt(item.takenAt);
          decodedGallery.push(decoded);
        }
        photo = decodedGallery[0];
        extraPhotos = decodedGallery.slice(1);
      } else if (parsed.data.photo !== undefined) {
        const decoded = decodeForumPhoto(parsed.data.photo.contentType, parsed.data.photo.data);
        if (decoded === null) {
          return c.json({ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
        }
        decoded.takenAt = normalizePhotoTakenAt(parsed.data.photo.takenAt);
        photo = decoded;
      }
      if (text === '' && photo === undefined) {
        return c.json(
          { error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo` },
          400,
        );
      }
      if (
        parsed.data.inReplyTo !== undefined &&
        (typeof parsed.data.goalSats === 'number' ||
          goalFieldPresent(parsed.data.goalCurrency) ||
          goalFieldPresent(parsed.data.goalAmount))
      ) {
        return c.json({ error: 'A reply cannot ask for a goal' }, 400);
      }
      let parentId: string | null = null;
      if (parsed.data.inReplyTo !== undefined) {
        if (!MESSAGE_ID_RE.test(parsed.data.inReplyTo)) {
          return c.json({ error: 'Not found' }, 404);
        }
        const parent = await deps.store.getById(parsed.data.inReplyTo);
        // One-level only: replies to replies are not parents. Soft-hidden parents are missing.
        if (parent === undefined || parent.parentId !== null || parent.deletedAt !== null) {
          return c.json({ error: 'Not found' }, 404);
        }
        parentId = parent.id;
      }
      const shaped = readGoalPair(
        parsed.data.goalSats ?? null,
        parsed.data.goalCurrency,
        parsed.data.goalAmount,
      );
      if (!shaped.ok) {
        return c.json({ error: shaped.error }, 400);
      }
      const frozen = await frozenAskResponse(
        deps,
        c,
        shaped.legacy,
        shaped.currency,
        shaped.amount,
      );
      if (frozen instanceof Response) {
        return frozen;
      }
      return persistForumPost(
        deps,
        postLimiter,
        c,
        account,
        authorName,
        text,
        parentId,
        photo,
        undefined,
        extraPhotos.length > 0 ? extraPhotos : undefined,
        frozen.goal,
        place,
      );
    })
    .get('/compose-target', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const gate = requireAction(account, 'forum.post');
      if (!gate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
      }
      try {
        const accounts = await deps.authStore.listAccounts();
        const platform = accounts.find((row) => row.isPlatform === true);
        if (platform === undefined) {
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        const live = await ensureProfileMessage({
          auth: deps.authStore,
          messages: deps.store,
          account: platform,
          now: deps.now,
        });
        const messageId = live.profileMessageId;
        if (typeof messageId !== 'string' || messageId.trim() === '') {
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        const row = await deps.store.getById(messageId);
        if (row === undefined) {
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        /* v8 ignore next 3 -- ensureProfileMessage returns a live id; deletedAt is a hide race */
        if (row.deletedAt !== null) {
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        if (!payableOf(row, live) || row.eventId === null || row.eventId === '') {
          return c.json({ error: 'This message cannot be paid yet' }, 400);
        }
        return c.json({ messageId: row.id, sats: row.sats }, 200);
      } catch {
        logEvent('messages.compose_target.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id/photo/:file', (c) => {
      const match = /^([1-9])\.(jpg|jpeg|png|webp)$/.exec(c.req.param('file'));
      if (match === null) {
        return c.json({ error: 'Photo not found' }, 404);
      }
      return serveForumPhoto(deps, c, c.req.param('id'), Number(match[1]));
    })
    .get('/:id/photo.jpg', (c) => serveForumPhoto(deps, c, c.req.param('id')))
    .get('/:id/photo.jpeg', (c) => serveForumPhoto(deps, c, c.req.param('id')))
    .get('/:id/photo.png', (c) => serveForumPhoto(deps, c, c.req.param('id')))
    .get('/:id/photo.webp', (c) => serveForumPhoto(deps, c, c.req.param('id')))
    .get('/:id/photo', (c) => serveForumPhoto(deps, c, c.req.param('id')))
    .get('/:id/video.mp4', (c) => serveForumVideo(deps, c, c.req.param('id'), 'mp4'))
    .get('/:id/video.webm', (c) => serveForumVideo(deps, c, c.req.param('id'), 'webm'))
    .get('/:id/video.mov', (c) => serveForumVideo(deps, c, c.req.param('id'), 'mov'))
    .get('/:id/replies', async (c) => {
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const account = await authedAccount(deps, c.req.header('authorization'));
      const includeAccountId = account !== null;
      try {
        const parent = await deps.store.getById(id);
        if (parent === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const isStaff = account !== null && roleAtLeast(account.role, 'moderator');
        if (parent.deletedAt !== null && !isStaff) {
          return c.json({ error: 'Not found' }, 404);
        }
        const rows = await deps.store.listReplies(id, MESSAGE_LIST_LIMIT, isStaff);
        const messages = [];
        for (const row of rows) {
          if (row.deletedAt !== null) {
            try {
              const author =
                row.accountId === null ? undefined : await deps.authStore.getAccount(row.accountId);
              const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
              const deletedBy = await resolveDeletedBy(deps.authStore, row);
              messages.push(
                serializeMessage(row, false, role, undefined, true, {
                  deletedAt: row.deletedAt,
                  deletedBy,
                }),
              );
            } catch {
              // One child must not 503 the thread (invalid createdAt, author lookup).
              continue;
            }
            continue;
          }
          const kept = await dropMissingVideoRow(deps.store, row);
          if (kept === null) {
            continue;
          }
          try {
            const author =
              row.accountId === null ? undefined : await deps.authStore.getAccount(row.accountId);
            const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
            const payable = row.accountId === null ? false : payableOf(kept, author);
            messages.push(serializeMessage(kept, payable, role, undefined, includeAccountId));
          } catch {
            // One child must not 503 the thread (invalid createdAt, author lookup).
            continue;
          }
        }
        return c.json({ messages }, 200);
      } catch {
        logEvent('messages.replies.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .delete('/:id', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(account.role, 'moderator')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const target = await deps.store.getById(id);
        if (target === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const at = new Date(deps.now());
        const tagged = await deps.store.markDeleted(id, at, account.id);
        if (!tagged) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (target.accountId === null && target.authorPubkey !== null) {
          const cascaded = await deps.store.blockPubkeyAndHideRows(
            target.authorPubkey,
            at,
            account.id,
            id,
          );
          logEvent('messages.external.blocked', { messageId: id, hidden: cascaded + 1 });
        }
        if (deps.nostrPublisher && deps.nostrKek) {
          try {
            await retractHiddenForumNotes(
              {
                store: deps.store,
                authStore: deps.authStore,
                publisher: deps.nostrPublisher,
                kek: deps.nostrKek,
                now: deps.now,
                env: deps.env ?? {},
                fetchImpl,
              },
              id,
            );
          } catch {
            logEvent('messages.delete.retract_failed', { messageId: id });
          }
        }
        logEvent('messages.deleted', {
          messageId: id,
          accountId: account.id,
          role: account.role,
        });
        try {
          const childIds = await deps.store.listChildIds(id);
          if (deps.notificationStore !== undefined) {
            await deps.notificationStore.deleteByMessageIds([id, ...childIds]);
          }
        } catch {
          logEvent('messages.delete.notifications_failed', { messageId: id });
        }
        return c.body(null, 204);
      } catch {
        logEvent('messages.delete.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .patch('/:id/place', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(account.role, 'moderator')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      if (
        raw === null ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !Object.prototype.hasOwnProperty.call(raw, 'place')
      ) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      const parsed = normalizePlace((raw as { place: unknown }).place);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      try {
        const row = await deps.store.getById(id);
        if (row === undefined || row.deletedAt !== null) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (row.parentId !== null) {
          return c.json({ error: 'A reply cannot include a place' }, 400);
        }
        if (!textHasHashtagToken(row.text, '21GiftsShop')) {
          return c.json({ error: 'Only a shop note can set a place' }, 400);
        }
        const hadPlaceBefore = row.place !== null && row.place !== undefined;
        const written = await deps.store.setPlace(id, parsed.value);
        if (!written) {
          return c.json({ error: 'Not found' }, 404);
        }
        const updated = await deps.store.getById(id);
        if (updated === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const author =
          updated.accountId === null
            ? undefined
            : await deps.authStore.getAccount(updated.accountId);
        const payable = updated.accountId === null ? false : payableOf(updated, author);
        const role = updated.accountId === null ? undefined : (author?.role ?? 'basis');
        logEvent('messages.place.updated', {
          messageId: id,
          accountId: account.id,
          role: account.role,
        });
        if (!hadPlaceBefore && parsed.value !== null) {
          await recordFirstShopOcpPlace({
            ...(deps.mapPush === undefined ? {} : { mapPush: deps.mapPush }),
            messageId: updated.id,
            text: updated.text,
            parentId: updated.parentId ?? null,
            place: parsed.value,
            authorName: updated.name,
            hadPlaceBefore: false,
            textHasHashtagToken,
          });
        }
        return c.json(
          serializeMessage(
            updated,
            payable,
            role,
            await deps.store.countAttributedReplies(updated.id),
          ),
          200,
        );
      } catch {
        logEvent('messages.place.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/stats', async (c) => {
      try {
        const rows = await deps.store.postCountsByUtcDay();
        return c.json(buildPostStats(rows, deps.now()), 200);
      } catch {
        logEvent('posts.stats.failed');
        return c.json({ error: 'Post stats are unavailable' }, 503);
      }
    })
    .get('/hidden', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(account.role, 'moderator')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      try {
        const rows = await deps.store.listHidden(MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          messages.push(serializeHiddenMessage(row, await resolveDeletedBy(deps.authStore, row)));
        }
        logEvent('messages.hidden.listed', { count: messages.length });
        return c.json({ messages }, 200);
      } catch {
        logEvent('messages.hidden.list_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/places', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const gate = requireAction(account, 'forum.read');
      if (!gate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
      }
      const limitQuery = c.req.query('limit');
      let limit: number;
      if (limitQuery === undefined) {
        limit = 1000;
      } else if (/^\d+$/.test(limitQuery)) {
        const n = Number(limitQuery);
        if (n < 1 || n > 1000) {
          return c.json({ error: 'Invalid limit' }, 400);
        }
        limit = n;
      } else {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      try {
        const rows = await deps.store.listPlaces(limit);
        return c.json(
          {
            places: rows.map((row) => ({
              id: row.id,
              name: row.name,
              createdAt: row.createdAt.toISOString(),
              lat: row.lat,
              lng: row.lng,
              label: row.label,
              ...(row.accountId === null ? {} : { accountId: row.accountId }),
            })),
          },
          200,
        );
      } catch {
        logEvent('messages.places.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/:id/translate', async (c) => {
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = translateBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      const target: TranslateTarget = parsed.data.target;
      try {
        let row = await deps.store.getById(id);
        if (row === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (row.deletedAt !== null) {
          const account = await authedAccount(deps, c.req.header('authorization'));
          if (account === null || !roleAtLeast(account.role, 'moderator')) {
            return c.json({ error: 'Not found' }, 404);
          }
        } else if (await withheldFromPublic(deps, row)) {
          return c.json({ error: 'Not found' }, 404);
        } else {
          const kept = await dropMissingVideoRow(deps.store, row);
          if (kept === null) {
            return c.json({ error: 'Not found' }, 404);
          }
          row = kept;
        }
        if (row.text.trim() === '') {
          return c.json({ error: 'Invalid body' }, 400);
        }
        const result = await translateForumNote(
          translationStore,
          deps.env ?? {},
          id,
          row.text,
          target,
          fetchImpl,
        );
        return c.json({ translatedText: result.translatedText, cached: result.cached }, 200);
      } catch (err) {
        if (err instanceof TranslateNotConfiguredError) {
          return c.json({ error: 'Translate is not configured' }, 503);
        }
        if (err instanceof TranslateUpstreamError) {
          return c.json({ error: 'Translate upstream failed' }, 502);
        }
        logEvent('messages.translate.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id', async (c) => {
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const sinceSatsRaw = c.req.query('sinceSats');
      let sinceSats: number | undefined;
      if (sinceSatsRaw !== undefined) {
        if (!/^\d+$/.test(sinceSatsRaw)) {
          return c.json({ error: 'Expected sinceSats to be a non-negative integer' }, 400);
        }
        sinceSats = Number(sinceSatsRaw);
      }
      const viewer = await authedAccount(deps, c.req.header('authorization'));
      const started = deps.now();
      const timeoutMs = deps.waitSatsTimeoutMs ?? WAIT_SATS_TIMEOUT_MS;
      const pollMs = deps.waitSatsPollMs ?? WAIT_SATS_POLL_MS;
      const sleep = deps.waitSatsSleep ?? defaultWaitSatsSleep;
      try {
        for (;;) {
          const row = await deps.store.getById(id);
          if (row === undefined) {
            return c.json({ error: 'Not found' }, 404);
          }
          if (row.deletedAt !== null) {
            const account = await authedAccount(deps, c.req.header('authorization'));
            if (account === null || !roleAtLeast(account.role, 'moderator')) {
              return c.json({ error: 'Not found' }, 404);
            }
            const author =
              row.accountId === null ? undefined : await deps.authStore.getAccount(row.accountId);
            const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
            const deletedBy = await resolveDeletedBy(deps.authStore, row);
            return c.json(
              serializeMessage(
                row,
                false,
                role,
                row.parentId === null ? await deps.store.countAttributedReplies(row.id) : undefined,
                true,
                {
                  deletedAt: row.deletedAt,
                  deletedBy,
                },
              ),
              200,
            );
          }
          if (await withheldFromPublic(deps, row)) {
            return c.json({ error: 'Not found' }, 404);
          }
          if (
            sinceSats !== undefined &&
            row.sats <= sinceSats &&
            deps.now() - started < timeoutMs
          ) {
            await sleep(pollMs);
            continue;
          }
          const author =
            row.accountId === null ? undefined : await deps.authStore.getAccount(row.accountId);
          const payable = row.accountId === null ? false : payableOf(row, author);
          const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
          const kept = await dropMissingVideoRow(deps.store, row);
          if (kept === null) {
            return c.json({ error: 'Not found' }, 404);
          }
          return c.json(
            serializeMessage(
              kept,
              payable,
              role,
              kept.parentId === null ? await deps.store.countAttributedReplies(kept.id) : undefined,
              viewer !== null,
            ),
            200,
          );
        }
      } catch {
        logEvent('messages.get.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/:id/invoice', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const payGate = requireAction(account, 'forum.pay');
      if (!payGate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: payGate.missing }, 409);
      }
      const messageIdParam = c.req.param('id');
      if (!MESSAGE_ID_RE.test(messageIdParam)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = invoiceBody.safeParse(await c.req.json().catch(() => null));
      const shown = parsed.success ? shownFiatFromBody(parsed.data) : { pinned: false as const };
      if (!parsed.success || shown === null) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: messageIdParam,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: 0,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      const amountMsat = parsed.data.sats * 1000;
      const invoiceText = normalizeForumText(parsed.data.text ?? '');
      if (invoiceText === null) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: messageIdParam,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` }, 400);
      }
      if (amountMsat > GIFT_INVOICE_MAX_MSAT) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: messageIdParam,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: 0,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      const row = await deps.store.getById(messageIdParam);
      if (row === undefined || row.deletedAt !== null) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: messageIdParam,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: null,
            zapRequest: null,
            result: 'not_found',
            httpStatus: 404,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Not found' }, 404);
      }
      if (row.accountId === null) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: account.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: null,
            zapRequest: null,
            result: 'no_author',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: "The author's wallet cannot receive this Bitcoin payment" }, 400);
      }
      if (row.eventId === null || row.eventId === '') {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: row.accountId,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: null,
            zapRequest: null,
            result: 'no_event',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      const author = await deps.authStore.getAccount(row.accountId);
      if (
        author === undefined ||
        author.lightningAddress === null ||
        author.lightningAddress.trim() === ''
      ) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: row.accountId,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author?.lightningAddress ?? null,
            zapRequest: null,
            result: 'no_author',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      const recipientPubkey = await deps.authStore.getNostrPublicKey(author.id);
      /* v8 ignore start -- payable notes have keys after the worker */
      if (recipientPubkey === undefined) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest: null,
            result: 'no_key',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      /* v8 ignore stop */
      const kek = deps.nostrKek;
      if (kek === undefined) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest: null,
            result: 'no_key',
            httpStatus: 503,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      if (!invoiceLimiter.allow(account.id, deps.now())) {
        c.header('Retry-After', '10');
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest: null,
            result: 'rate_limited',
            httpStatus: 429,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Too many payments' }, 429);
      }
      const relays = resolveZapRelays(process.env);
      const unsigned = buildZapRequest({
        recipientPubkey,
        eventId: row.eventId,
        amountMsat,
        relays,
        content: invoiceText,
      });
      let signed;
      try {
        await ensureAccountNostrKey(deps.authStore, account.id, kek);
        signed = await signEventForAccount(deps.authStore, account.id, kek, unsigned);
        /* v8 ignore next 4 -- keygen or sign failure */
      } catch {
        logEvent('nostr.sign.failed', { messageId: row.id });
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest: null,
            result: 'sign_failed',
            httpStatus: 503,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
          }),
        );
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      const zapRequestJson = JSON.stringify(signed);
      const zapRequest =
        signed !== null && typeof signed === 'object'
          ? (signed as unknown as Record<string, unknown>)
          : null;
      const zap = await requestZapInvoice({
        address: author.lightningAddress,
        amountMsat,
        zapRequestJson,
        fetchImpl,
      });
      if (!zap.ok) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest,
            result: zap.reason,
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            lnurlResponse: zap.lnurlResponse,
          }),
        );
        if (zap.reason === 'noZap') {
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        return c.json({ error: 'Could not start the Bitcoin payment' }, 400);
      }
      const inspected = inspectBolt11(zap.pr);
      const description = inspected?.description ?? null;
      const descriptionHash = inspected?.descriptionHash ?? null;
      const nip57 = isNip57Invoice(descriptionHash, zapRequestJson);
      if (!nip57) {
        await persistInvoiceAttempt(
          deps.store,
          invoiceAttemptBase({
            messageId: row.id,
            payerAccountId: account.id,
            authorAccountId: author.id,
            amountSats: parsed.data.sats,
            shown,
            lightningAddress: author.lightningAddress,
            zapRequest,
            result: 'not_zap',
            httpStatus: 400,
            pr: zap.pr, // keep for debug; this is the exception to "failure rows have pr null"
            paymentHash: inspected?.paymentHash ?? null,
            description,
            descriptionHash,
            isNip57Invoice: false,
            lnurlResponse: zap.lnurlResponse,
          }),
        );
        return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
      }
      await persistInvoiceAttempt(
        deps.store,
        invoiceAttemptBase({
          messageId: row.id,
          payerAccountId: account.id,
          authorAccountId: author.id,
          amountSats: parsed.data.sats,
          shown,
          lightningAddress: author.lightningAddress,
          zapRequest,
          result: 'ok',
          httpStatus: 200,
          pr: zap.pr,
          paymentHash: inspected?.paymentHash ?? null,
          description,
          descriptionHash,
          isNip57Invoice: true,
          lnurlResponse: zap.lnurlResponse,
        }),
      );
      return c.json({ pr: zap.pr, amountSats: zap.amountSats }, 200);
    });
}
