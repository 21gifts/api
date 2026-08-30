import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import {
  MESSAGE_LIST_LIMIT,
  MESSAGE_PHOTO_MAX_BYTES,
  decodeForumPhoto,
  normalizeForumText,
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
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import type { PushStore } from '@/lib/push-store';
import { enqueueForumPushes } from '@/lib/push-worker';
import { bearerToken } from '@/routes/me';
import {
  MESSAGE_VIDEO_MAX_BYTES,
  decodeForumVideo,
  forumVideoExt,
  parseBytesRange,
  resolveMediaDir,
  streamForumVideo,
  videoFilePath,
  type ForumVideo,
} from '@/lib/video';
import { stat } from 'node:fs/promises';

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
  /** Optional push outbox; forum create enqueues when present. */
  pushStore?: PushStore;
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

/** Hex UUID as stored on `message.id` (rejects values Postgres would error on). */
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public photo bytes for Nostr clients. Same handler for `/photo` and
 * `/photo.jpg` (Damus only embeds URLs with an image extension).
 *
 * @param deps - Message store.
 * @param id - Path id.
 * @returns 200 bytes, 404, or 503.
 */
async function serveForumPhoto(deps: MessagesRouteDeps, id: string): Promise<Response> {
  if (!MESSAGE_ID_RE.test(id)) {
    return Response.json({ error: 'Photo not found' }, { status: 404 });
  }
  try {
    const photo = await deps.store.getPhoto(id);
    if (photo === null) {
      return Response.json({ error: 'Photo not found' }, { status: 404 });
    }
    const ext =
      photo.contentType === 'image/png'
        ? 'png'
        : photo.contentType === 'image/webp'
          ? 'webp'
          : 'jpg';
    return new Response(photo.bytes, {
      status: 200,
      headers: {
        'Content-Type': photo.contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `inline; filename="photo.${ext}"`,
      },
    });
  } catch {
    logEvent('messages.photo.failed');
    return Response.json({ error: 'Messages are unavailable' }, { status: 503 });
  }
}

/**
 * Stream public video bytes with Range support so Damus can seek.
 *
 * Reads metadata via `stat` and streams with {@link streamForumVideo} (never
 * loads the whole file into RAM). Missing / empty / non-file paths are 404;
 * unsatisfiable ranges are 416; other I/O is 503.
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
    if (forumVideoExt(mime) !== ext) {
      return Response.json({ error: 'Video not found' }, { status: 404 });
    }
    const path = videoFilePath(resolveMediaDir(), id, mime);
    let size: number;
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile() || fileStat.size === 0) {
        return Response.json({ error: 'Video not found' }, { status: 404 });
      }
      size = fileStat.size;
    } catch (err) {
      if (isPathNotFound(err)) {
        return Response.json({ error: 'Video not found' }, { status: 404 });
      }
      throw err;
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
    if (range.type === 'full') {
      headers['Content-Length'] = String(size);
      return new Response(streamForumVideo(path, 0, size - 1), { status: 200, headers });
    }
    headers['Content-Length'] = String(range.end - range.start + 1);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    return new Response(streamForumVideo(path, range.start, range.end), {
      status: 206,
      headers,
    });
  } catch {
    logEvent('messages.video.failed');
    return Response.json({ error: 'Messages are unavailable' }, { status: 503 });
  }
}

/**
 * `POST /messages` as multipart (`video` file + optional `poster` + `text`).
 *
 * @param deps - Store and clock.
 * @param c - Request.
 * @param account - Authenticated account (already named).
 * @param postLimiter - Create limiter.
 * @returns 200 / 400 / 429 / 503.
 */
async function postMultipartMessage(
  deps: MessagesRouteDeps,
  c: Context,
  account: Account,
): Promise<Response> {
  /* v8 ignore next 3 -- named accounts; trim-empty is the same 400 as JSON POST */
  if (account.name === null || account.name.trim() === '') {
    return c.json({ error: 'Set a name before posting' }, 400);
  }
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
  const row: MessageRow = {
    id: crypto.randomUUID(),
    accountId: account.id,
    name: account.name.trim(),
    text,
    createdAt: new Date(deps.now()),
    hasPhoto: photo !== undefined,
    hasVideo: video !== undefined,
    videoContentType: video === undefined ? null : video.contentType,
    ...unsignedNostrDefaults(),
  };
  try {
    const created = await deps.store.create(row, photo, video);
    if (deps.pushStore !== undefined) {
      try {
        await enqueueForumPushes(deps.pushStore, account.id, created.id, deps.now());
      } catch {
        logEvent('push.enqueue.failed');
      }
    }
    return c.json(serializeMessage(created, false, account.role), 200);
  } catch {
    logEvent('messages.create.failed');
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
}

/** Body schema for posting a forum message (text and/or photo). */
const postBody = z
  .object({
    text: z.string().optional(),
    photo: z
      .object({
        contentType: z.string(),
        data: z.string(),
      })
      .optional(),
  })
  .refine((body) => body.text !== undefined || body.photo !== undefined);

/** Body schema for a note invoice. */
const invoiceBody = z.object({ sats: z.number().int().positive() });

/**
 * Build the `/messages` route group.
 *
 * Mounted at `/messages` so the public paths are `GET /messages`,
 * `POST /messages` (JSON photo or multipart `video` + optional `poster`),
 * `GET /messages/:id/photo` (and `.jpg` / `.jpeg` / `.png` / `.webp`),
 * `GET /messages/:id/video.mp4|.webm|.mov`, and `POST /messages/:id/invoice`.
 *
 * @param deps - Message store, auth store, clock, and optional `pushStore`.
 * @returns A Hono app with `GET /`, `POST /`, `GET /:id/photo` plus `.jpg` /
 * `.jpeg` / `.png` / `.webp`, `GET /:id/video.mp4|.webm|.mov`, and
 * `POST /:id/invoice`.
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
      try {
        const rows = await deps.store.listLatest(MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          const author = await deps.authStore.getAccount(row.accountId);
          const payable =
            row.eventId !== null && author !== undefined && author.lightningAddress !== null;
          const role = author?.role ?? 'basis';
          messages.push(serializeMessage(row, payable, role));
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
      if (!postLimiter.allow(account.id, deps.now())) {
        logEvent('messages.rate_limited', { accountId: account.id });
        c.header('Retry-After', '10');
        return c.json({ error: 'Too many messages' }, 429);
      }
      /* v8 ignore next -- missing content-type is JSON parse 400 */
      const requestType = c.req.header('content-type') ?? '';
      if (requestType.toLowerCase().includes('multipart/form-data')) {
        return postMultipartMessage(deps, c, account);
      }
      const parsed = postBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with text and/or photo' }, 400);
      }
      if (account.name === null || account.name.trim() === '') {
        return c.json({ error: 'Set a name before posting' }, 400);
      }
      const rawText = parsed.data.text ?? '';
      const text = normalizeForumText(rawText);
      if (text === null) {
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
      }
      let photo: ForumPhoto | undefined;
      if (parsed.data.photo !== undefined) {
        const decoded = decodeForumPhoto(parsed.data.photo.contentType, parsed.data.photo.data);
        if (decoded === null) {
          return c.json({ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }, 400);
        }
        photo = decoded;
      }
      if (text === '' && photo === undefined) {
        return c.json({ error: 'Text must be 1–500 characters or include a photo' }, 400);
      }
      const row: MessageRow = {
        id: crypto.randomUUID(),
        accountId: account.id,
        name: account.name.trim(),
        text,
        createdAt: new Date(deps.now()),
        hasPhoto: photo !== undefined,
        ...unsignedNostrDefaults(),
      };
      try {
        const created =
          photo === undefined ? await deps.store.create(row) : await deps.store.create(row, photo);
        if (deps.pushStore !== undefined) {
          try {
            await enqueueForumPushes(deps.pushStore, account.id, created.id, deps.now());
          } catch {
            logEvent('push.enqueue.failed');
          }
        }
        return c.json(serializeMessage(created, false, account.role), 200);
      } catch {
        logEvent('messages.create.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id/photo.jpg', (c) => serveForumPhoto(deps, c.req.param('id')))
    .get('/:id/photo.jpeg', (c) => serveForumPhoto(deps, c.req.param('id')))
    .get('/:id/photo.png', (c) => serveForumPhoto(deps, c.req.param('id')))
    .get('/:id/photo.webp', (c) => serveForumPhoto(deps, c.req.param('id')))
    .get('/:id/photo', (c) => serveForumPhoto(deps, c.req.param('id')))
    .get('/:id/video.mp4', (c) => serveForumVideo(deps, c, c.req.param('id'), 'mp4'))
    .get('/:id/video.webm', (c) => serveForumVideo(deps, c, c.req.param('id'), 'webm'))
    .get('/:id/video.mov', (c) => serveForumVideo(deps, c, c.req.param('id'), 'mov'))
    .post('/:id/invoice', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
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
      if (row === undefined) {
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
      if (row.eventId === null) {
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
      if (author === undefined || author.lightningAddress === null) {
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
        }),
      );
      return c.json({ pr: zap.pr, amountSats: zap.amountSats }, 200);
    });
}
