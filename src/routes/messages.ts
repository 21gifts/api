import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { roleAtLeast } from '@/lib/auth/roles';
import type { Account, AccountRole, AuthStore } from '@/lib/auth/store';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import {
  MESSAGE_LIST_LIMIT,
  MESSAGE_PHOTO_MAX_BYTES,
  decodeForumPhoto,
  forumContentFingerprint,
  forumPhotoResponse,
  normalizeForumText,
  serializeHiddenMessage,
  serializeMessage,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import type {
  MessageInvoiceAttempt,
  MessageInvoiceResult,
  MessageStore,
} from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import type { NostrPublisher } from '@/lib/nostr/publish';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { retractHiddenForumNotes } from '@/lib/nostr/retract';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { notifyForumPost, notifyForumReply } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import type { SpendPing } from '@/lib/spend-ping';
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
}): MessageInvoiceAttempt {
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
   * Address, the route awaits `ping(address, created.id)`. Omitted → skip.
   * Failures are logged and do not fail the 200.
   */
  spendPing?: SpendPing;
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
  /** Sleep between `sinceSats` polls (tests inject). */
  waitSatsSleep?: (ms: number) => Promise<void>;
  /** Max wait for `sinceSats` (tests inject; default {@link WAIT_SATS_TIMEOUT_MS}). */
  waitSatsTimeoutMs?: number;
  /** Poll interval for `sinceSats` (tests inject; default {@link WAIT_SATS_POLL_MS}). */
  waitSatsPollMs?: number;
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
    return forumPhotoResponse(photo);
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
      'Cache-Control': 'public, max-age=86400',
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
 * @returns 200 / 429 / 503.
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
  if (!postLimiter.allow(account.id, deps.now())) {
    logEvent('messages.rate_limited', { accountId: account.id });
    c.header('Retry-After', '10');
    return c.json({ error: 'Too many messages' }, 429);
  }
  const id = crypto.randomUUID();
  const row: MessageRow = {
    id,
    accountId: account.id,
    name: authorName,
    text,
    createdAt: new Date(deps.now()),
    hasPhoto: photo !== undefined,
    hasVideo: video !== undefined,
    videoContentType: video === undefined ? null : video.contentType,
    ...unsignedNostrDefaults(),
    parentId,
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
        await deps.spendPing.ping(account.lightningAddress, created.id);
      } catch {
        logEvent('spend.ping.failed');
      }
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
    return c.json(
      serializeMessage(created, payableOf(created, account), account.role, undefined, true),
      200,
    );
  } catch {
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
    return c.json({ error: 'Text must be 1–500 characters' }, 400);
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
    return c.json({ error: 'Text must be 1–500 characters or include a photo or video' }, 400);
  }
  return persistForumPost(deps, postLimiter, c, account, authorName, text, null, photo, video);
}

/** Body schema for posting a forum message (text and/or photo; optional reply). */
const postBody = z
  .object({
    text: z.string().optional(),
    inReplyTo: z.string().optional(),
    photo: z
      .object({
        contentType: z.string(),
        data: z.string(),
      })
      .optional(),
    photos: z
      .array(
        z.object({
          contentType: z.string(),
          data: z.string(),
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
});

/**
 * Build the `/messages` route group.
 *
 * Mounted at `/messages` so the public paths are `GET /messages`,
 * `POST /messages` (JSON photo or multipart `video` + optional `poster`),
 * `GET /messages/:id/photo` (and `.jpg` / `.jpeg` / `.png` / `.webp`),
 * `GET /messages/:id/video.mp4|.webm|.mov`, public `GET /messages/:id/replies`
 * (optional Bearer for `accountId`), staff `DELETE /messages/:id` (soft-hide
 * plus best-effort NIP-09 and Cloudflare media purge when publisher+kek are
 * set),
 * staff `GET /messages/hidden` (moderator session log), public
 * `GET /messages/:id` (optional `?sinceSats=` non-negative integer
 * long-polls until `sats` is strictly greater; timeout still returns 200 with
 * the current body; invalid value 400), and `POST /messages/:id/invoice`.
 * Photo, video, replies, DELETE, and `GET /hidden` register before the public
 * single-note `GET /:id`. Soft-hidden rows (`deletedAt`) are omitted from
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
 * `notificationStore` / `conversationStore` / `nostrPublisher` / `env`, and
 * test injects `waitSatsSleep` / `waitSatsTimeoutMs` / `waitSatsPollMs`
 * (defaults `defaultWaitSatsSleep` / `WAIT_SATS_TIMEOUT_MS` /
 * `WAIT_SATS_POLL_MS`).
 * @returns A Hono app with `GET /`, `POST /`, `GET /:id/photo` plus `.jpg` /
 * `.jpeg` / `.png` / `.webp`, `GET /:id/video.mp4|.webm|.mov`,
 * public `GET /:id/replies` (optional Bearer for `accountId`), `DELETE /:id`,
 * staff `GET /hidden` (moderator session; no `forum.read`),
 * public `GET /:id` (optional `?sinceSats=`), and `POST /:id/invoice`.
 */
export function messagesRoutes(deps: MessagesRouteDeps): Hono {
  const postLimiter = deps.postLimiter ?? defaultPostLimiter;
  const invoiceLimiter = deps.invoiceLimiter ?? defaultInvoiceLimiter;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const gate = requireAction(account, 'forum.read');
      if (!gate.ok) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
      }
      try {
        const rows = await deps.store.listLatest(MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          const author =
            row.accountId === null ? undefined : await deps.authStore.getAccount(row.accountId);
          const payable = payableOf(row, author);
          const role = row.accountId === null ? undefined : (author?.role ?? 'basis');
          const kept = await dropMissingVideoRow(deps.store, row);
          if (kept === null) {
            continue;
          }
          const children = await deps.store.listReplies(kept.id, MESSAGE_LIST_LIMIT);
          let dropped = 0;
          for (const child of children) {
            const keptChild = await dropMissingVideoRow(deps.store, child);
            if (keptChild === null) {
              dropped += 1;
            }
          }
          messages.push(
            serializeMessage(kept, payable, role, Math.max(0, row.replyCount - dropped), true),
          );
        }
        return c.json({ messages }, 200);
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
      const rawText = parsed.data.text ?? '';
      const text = normalizeForumText(rawText);
      if (text === null) {
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
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
          decodedGallery.push(decoded);
        }
        photo = decodedGallery[0];
        extraPhotos = decodedGallery.slice(1);
      } else if (parsed.data.photo !== undefined) {
        const decoded = decodeForumPhoto(parsed.data.photo.contentType, parsed.data.photo.data);
        if (decoded === null) {
          return c.json({ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
        }
        photo = decoded;
      }
      if (text === '' && photo === undefined) {
        return c.json({ error: 'Text must be 1–500 characters or include a photo' }, 400);
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
        const exempt = account.id === parent.accountId || roleAtLeast(account.role, 'verified');
        if (!exempt) {
          return c.json({ error: 'A reply needs a Bitcoin payment' }, 403);
        }
        parentId = parent.id;
      }
      return extraPhotos.length > 0
        ? persistForumPost(
            deps,
            postLimiter,
            c,
            account,
            authorName,
            text,
            parentId,
            photo,
            undefined,
            extraPhotos,
          )
        : persistForumPost(deps, postLimiter, c, account, authorName, text, parentId, photo);
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
        const staffHidden =
          parent.deletedAt !== null && account !== null && roleAtLeast(account.role, 'moderator');
        if (parent.deletedAt !== null && !staffHidden) {
          return c.json({ error: 'Not found' }, 404);
        }
        const rows = await deps.store.listReplies(id, MESSAGE_LIST_LIMIT, staffHidden);
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
              serializeMessage(row, false, role, undefined, true, {
                deletedAt: row.deletedAt,
                deletedBy,
              }),
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
          return c.json(serializeMessage(kept, payable, role), 200);
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
      if (!parsed.success) {
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
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
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
