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
  normalizeForumText,
  serializeMessage,
  unsignedNostrDefaults,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveWriteSet } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import { bearerToken } from '@/routes/me';

/**
 * `/messages` — signed-in member forum: list, post, and pay a note.
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

async function isPayable(deps: MessagesRouteDeps, row: MessageRow): Promise<boolean> {
  if (row.eventId === null) {
    return false;
  }
  const author = await deps.authStore.getAccount(row.accountId);
  return author !== undefined && author.lightningAddress !== null;
}

/** Body schema for posting a forum message. */
const textBody = z.object({ text: z.string() });

/** Body schema for a note invoice. */
const invoiceBody = z.object({ sats: z.number().int().positive() });

/**
 * Build the `/messages` route group.
 *
 * @param deps - Message store, auth store, and clock.
 * @returns A Hono app with `GET /`, `POST /`, and `POST /:id/invoice`.
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
          messages.push(serializeMessage(row, await isPayable(deps, row)));
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
      const parsed = textBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
      }
      if (account.name === null || account.name.trim() === '') {
        return c.json({ error: 'Set a name before posting' }, 400);
      }
      const text = normalizeForumText(parsed.data.text);
      if (text === null) {
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
      }
      const row: MessageRow = {
        id: crypto.randomUUID(),
        accountId: account.id,
        name: account.name.trim(),
        text,
        createdAt: new Date(deps.now()),
        ...unsignedNostrDefaults(),
      };
      try {
        const created = await deps.store.create(row);
        return c.json(serializeMessage(created, false), 200);
      } catch {
        logEvent('messages.create.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/:id/invoice', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!invoiceLimiter.allow(account.id, deps.now())) {
        c.header('Retry-After', '10');
        return c.json({ error: 'Too many payments' }, 429);
      }
      const kek = deps.nostrKek;
      if (kek === undefined) {
        return c.json({ error: 'Messages are unavailable' }, 503);
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
      const writeSet = resolveWriteSet(process.env);
      const relays = [writeSet.spaceUrl, ...writeSet.publicUrls];
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
