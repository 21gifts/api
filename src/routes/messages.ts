import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { GIFT_INVOICE_MAX_MSAT, GIFT_INVOICE_MIN_MSAT } from '@/lib/config';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import {
  MESSAGE_LIST_LIMIT,
  decodeForumPhoto,
  normalizeForumText,
  serializeMessage,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import { bearerToken } from '@/routes/me';

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
 * `POST /messages`, `GET /messages/:id/photo`, and `POST /messages/:id/invoice`.
 *
 * @param deps - Message store, auth store, and clock.
 * @returns A Hono app with `GET /`, `POST /`, `GET /:id/photo`, and `POST /:id/invoice`.
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
        return c.json(serializeMessage(created, false, account.role), 200);
      } catch {
        logEvent('messages.create.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id/photo', async (c) => {
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Photo not found' }, 404);
      }
      try {
        const photo = await deps.store.getPhoto(id);
        if (photo === null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        return new Response(photo.bytes, {
          status: 200,
          headers: {
            'Content-Type': photo.contentType,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch {
        logEvent('messages.photo.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/:id/invoice', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = invoiceBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      const amountMsat = parsed.data.sats * 1000;
      /* v8 ignore next 3 -- zod already requires positive int; cap is extra */
      if (amountMsat < GIFT_INVOICE_MIN_MSAT || amountMsat > GIFT_INVOICE_MAX_MSAT) {
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      const row = await deps.store.getById(c.req.param('id'));
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (row.eventId === null) {
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      const author = await deps.authStore.getAccount(row.accountId);
      if (author === undefined || author.lightningAddress === null) {
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      const recipientPubkey = await deps.authStore.getNostrPublicKey(author.id);
      /* v8 ignore next 3 -- payable notes have keys after the worker */
      if (recipientPubkey === undefined) {
        return c.json({ error: 'This message cannot be paid yet' }, 400);
      }
      const kek = deps.nostrKek;
      if (kek === undefined) {
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      if (!invoiceLimiter.allow(account.id, deps.now())) {
        c.header('Retry-After', '10');
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
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      const zap = await requestZapInvoice({
        address: author.lightningAddress,
        amountMsat,
        zapRequestJson: JSON.stringify(signed),
        fetchImpl,
      });
      /* v8 ignore next 3 -- LNURL/zap collapsed failure */
      if (!zap.ok) {
        return c.json({ error: 'Could not start the Bitcoin payment' }, 400);
      }
      return c.json({ pr: zap.pr, amountSats: zap.amountSats }, 200);
    });
}
