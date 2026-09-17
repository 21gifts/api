import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT, GIFT_INVOICE_MIN_MSAT, GIFT_INVOICE_TTL_MS } from '@/lib/config';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { newInvoiceId, type GiftInvoice, type InvoiceStore } from '@/lib/invoice-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import { MESSAGE_LIST_LIMIT, unsignedNostrDefaults } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { notifyForumReply } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { preimageMatchesHash } from '@/lib/proof';
import type { PushStore } from '@/lib/push-store';
import { checkSpendAuth } from '@/lib/spend-auth';
import {
  NoopGiftRecorder,
  recipientHandleFromAddress,
  type GiftRecorder,
} from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Spend-worker invoice routes: check passkey eligibility and a live
 * top-level forum post, fetch a recipient BOLT11 via LNURL-pay, then accept
 * the payment preimage as proof. A proof with `messageId` attaches a platform
 * gift-reply under that post. The api does not pay.
 */

/** Collaborators the invoice routes need. */
export interface InvoiceRouteDeps {
  /** `SPEND_API_TOKEN` (blank/undefined → 503). */
  spendApiToken: string | undefined;
  /** Issued-invoice store. */
  store: InvoiceStore;
  /**
   * Auth store for Lightning Address → account, passkey, platform, and
   * custodial pubkey lookup. Distinct from {@link InvoiceStore} (`store`).
   */
  authStore: Pick<
    AuthStore,
    | 'getAccountByLightningAddress'
    | 'accountHasPasskey'
    | 'listAccounts'
    | 'getNostrPublicKey'
    | 'getAccount'
  >;
  /**
   * Forum store for live top-level post lookup, gift-reply insert, and
   * GET `/posted` `messageId`. Distinct from {@link InvoiceStore} (`store`).
   */
  messageStore: Pick<
    MessageStore,
    'accountHasLiveTopLevelPost' | 'getById' | 'addSats' | 'create' | 'listPostsByAccount'
  >;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for LNURL-pay. */
  fetchImpl: FetchFn;
  /**
   * Persist a proven gift into `gift` for `/gifts/stats`. Default no-op.
   * Insert failures are logged; proof still returns 200.
   */
  giftRecorder?: GiftRecorder;
  /**
   * Optional in-app notification store. When present with `pushStore`, a spend
   * gift-reply fans out via {@link notifyForumReply} with `auth` so
   * `notificationLevel` filters in-app rows and Web Push.
   */
  notificationStore?: NotificationStore;
  /**
   * Optional push outbox; also the bell-subscriber list.
   */
  pushStore?: PushStore;
}

const ISSUE_ERROR = 'Lightning Address did not issue an invoice';

const issueBodySchema = z.object({
  address: z.string(),
  amountMsat: z.number().int(),
  comment: z.string().max(255).optional(),
  messageId: z.string().optional(),
});

const proofBodySchema = z.object({
  id: z.string().min(1),
  preimage: z.string(),
});

/**
 * Deterministic gift-reply id for a spend invoice so a retry of the same
 * proof is idempotent on `message.id`.
 *
 * @param invoiceId - Gift invoice id.
 * @returns UUID derived from SHA-256 of the spend-gift prefix and invoice id.
 */
function spendGiftReplyId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-gift:${invoiceId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Map {@link checkSpendAuth} to a Hono JSON response, or `null` when ok.
 *
 * @param status - Auth check result.
 * @param json - Hono `c.json` bound to the request.
 * @returns 503/401 response, or `null` to continue.
 */
function authGate(
  status: ReturnType<typeof checkSpendAuth>,
  json: (body: { error: string }, status: 401 | 503) => Response,
): Response | null {
  if (status === 'unconfigured') {
    return json({ error: 'Spend invoices are not configured' }, 503);
  }
  if (status === 'unauthorized') {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

/**
 * Whether a normalised Lightning Address belongs to an account that already
 * has a passkey credential. Missing account → false (fail closed).
 *
 * @param authStore - Account and credential lookup.
 * @param address - Normalised `local@domain`.
 * @returns `true` only when both account and credential exist.
 */
async function addressHasPasskey(
  authStore: InvoiceRouteDeps['authStore'],
  address: string,
): Promise<boolean> {
  const account = await authStore.getAccountByLightningAddress(address);
  return account !== undefined && (await authStore.accountHasPasskey(account.id));
}

/**
 * Whether a normalised Lightning Address belongs to an account that has at
 * least one live top-level forum row that is not the auto-created profile
 * note. Replies do not count. Missing account → false (fail closed).
 *
 * @param authStore - Account lookup.
 * @param messageStore - Live top-level post lookup.
 * @param address - Normalised `local@domain`.
 * @returns `true` only when the account has a live top-level non-profile forum row.
 */
async function addressHasPosted(
  authStore: InvoiceRouteDeps['authStore'],
  messageStore: InvoiceRouteDeps['messageStore'],
  address: string,
): Promise<boolean> {
  const account = await authStore.getAccountByLightningAddress(address);
  return (
    account !== undefined &&
    (await messageStore.accountHasLiveTopLevelPost(account.id, account.profileMessageId ?? null))
  );
}

/**
 * Build the `/invoices` route group.
 *
 * @param deps - Token, invoice store, auth store, message store, clock, fetch,
 *   optional gift recorder, optional notification and push stores.
 * @returns Hono app mounted at `/invoices`.
 */
export function invoiceRoutes(deps: InvoiceRouteDeps): Hono {
  const giftRecorder = deps.giftRecorder ?? new NoopGiftRecorder();

  async function persistProvenGift(invoice: GiftInvoice, paidAtMs: number): Promise<void> {
    try {
      await giftRecorder.recordOutbound({
        paidAt: new Date(paidAtMs),
        amountSats: Math.floor(invoice.amountMsat / 1000),
        feeSats: 0,
        recipientWosUser: recipientHandleFromAddress(invoice.address),
        lightningInvoice: invoice.pr,
        description: '21gifts daily',
        sourceWallet: 'lightning.space',
      });
    } catch {
      logEvent('gifts.record_failed', { id: invoice.id });
    }
  }

  async function attachSpendGiftReply(invoice: GiftInvoice, paidAtMs: number): Promise<void> {
    if (invoice.messageId === undefined) {
      return;
    }
    try {
      const replyId = spendGiftReplyId(invoice.id);
      const existing = await deps.messageStore.getById(replyId);
      if (existing !== undefined) {
        return;
      }
      const parent = await deps.messageStore.getById(invoice.messageId);
      const accounts = await deps.authStore.listAccounts();
      const platform = accounts.find((item) => item.isPlatform === true);
      if (parent === undefined || parent.deletedAt !== null || platform === undefined) {
        logEvent('invoice.gift_reply.failed');
        return;
      }
      const sats = Math.floor(invoice.amountMsat / 1000);
      const nameTrim = platform.name?.trim() ?? '';
      const name = nameTrim !== '' ? nameTrim : '21.gifts';
      const text = invoice.comment ?? '';
      const authorPubkey = (await deps.authStore.getNostrPublicKey(platform.id)) ?? null;
      const created = await deps.messageStore.create({
        id: replyId,
        accountId: platform.id,
        name,
        text,
        createdAt: new Date(paidAtMs),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        contentFp: null,
        ...unsignedNostrDefaults(),
        parentId: invoice.messageId,
        sats,
        nostrPublishState: text === '' ? 'skipped' : 'pending',
        authorPubkey,
      });
      await deps.messageStore.addSats(invoice.messageId, sats);
      try {
        await notifyForumReply({
          messages: deps.messageStore as MessageStore,
          account: platform,
          created,
          parentId: invoice.messageId,
          auth: deps.authStore,
          /* v8 ignore next 4 -- createApp always injects notificationStore and pushStore */
          ...(deps.notificationStore === undefined
            ? {}
            : { notifications: deps.notificationStore }),
          ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
        });
      } catch {
        logEvent('messages.reply.notify.failed');
      }
    } catch {
      logEvent('invoice.gift_reply.failed');
    }
  }

  async function finishPaid(invoice: GiftInvoice, paidAtMs: number): Promise<void> {
    await persistProvenGift(invoice, paidAtMs);
    await attachSpendGiftReply(invoice, paidAtMs);
  }

  return new Hono()
    .get('/passkey', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      const address = normalizeLightningAddress(c.req.query('address') ?? '');
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }

      const hasPasskey = await addressHasPasskey(deps.authStore, address);
      return c.json({ hasPasskey }, 200);
    })
    .get('/posted', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      const address = normalizeLightningAddress(c.req.query('address') ?? '');
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }

      const account = await deps.authStore.getAccountByLightningAddress(address);
      if (account === undefined) {
        return c.json({ hasPosted: false, messageId: null, postedAt: null }, 200);
      }
      const hasPosted = await deps.messageStore.accountHasLiveTopLevelPost(
        account.id,
        account.profileMessageId ?? null,
      );
      if (!hasPosted) {
        return c.json({ hasPosted: false, messageId: null, postedAt: null }, 200);
      }
      const posts = await deps.messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
      const profileId = account.profileMessageId ?? null;
      const newest = posts.find((row) => row.id !== profileId);
      return c.json(
        {
          hasPosted: true,
          messageId: newest === undefined ? null : newest.id,
          postedAt: newest === undefined ? null : newest.createdAt.toISOString(),
        },
        200,
      );
    })
    .post('/', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }
      deps.store.sweep(deps.now());

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }
      const parsed = issueBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }
      if (parsed.data.messageId !== undefined && !MESSAGE_ID_RE.test(parsed.data.messageId)) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }

      const address = normalizeLightningAddress(parsed.data.address);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }
      const amountMsat = parsed.data.amountMsat;
      if (amountMsat < GIFT_INVOICE_MIN_MSAT || amountMsat > GIFT_INVOICE_MAX_MSAT) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }

      const account = await deps.authStore.getAccountByLightningAddress(address);
      if (account === undefined || !(await deps.authStore.accountHasPasskey(account.id))) {
        logEvent('invoice.passkey_required', { address });
        return c.json({ error: 'Passkey required' }, 403);
      }

      if (parsed.data.messageId !== undefined) {
        const message = await deps.messageStore.getById(parsed.data.messageId);
        if (
          message === undefined ||
          message.deletedAt !== null ||
          message.parentId !== null ||
          message.id === (account.profileMessageId ?? null) ||
          message.accountId === null ||
          message.accountId !== account.id
        ) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
        const author = await deps.authStore.getAccount(message.accountId);
        const authorAddress =
          author === undefined ? null : normalizeLightningAddress(author.lightningAddress ?? '');
        if (author === undefined || authorAddress !== address) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
        const accounts = await deps.authStore.listAccounts();
        const platform = accounts.find((item) => item.isPlatform === true);
        if (platform === undefined) {
          return c.json({ error: 'Platform account is not configured' }, 503);
        }
      } else {
        const hasPosted = await addressHasPosted(deps.authStore, deps.messageStore, address);
        if (!hasPosted) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
      }

      const fetchArgs: {
        address: string;
        amountMsat: number;
        comment?: string;
        fetchImpl: FetchFn;
      } = {
        address,
        amountMsat,
        fetchImpl: deps.fetchImpl,
      };
      if (parsed.data.comment !== undefined) {
        fetchArgs.comment = parsed.data.comment;
      }
      const fetched = await requestGiftInvoice(fetchArgs);
      if (!fetched.ok) {
        logEvent('invoice.issue_failed', { address });
        return c.json({ error: ISSUE_ERROR }, 502);
      }

      const decoded = decodeBolt11(fetched.pr);
      if (decoded === null || decoded.amountMsat !== amountMsat) {
        logEvent('invoice.issue_failed', { address });
        return c.json({ error: ISSUE_ERROR }, 502);
      }

      const now = deps.now();
      const id = newInvoiceId();
      deps.store.put({
        id,
        address,
        pr: fetched.pr,
        paymentHash: decoded.paymentHash,
        amountMsat,
        createdAt: now,
        expiresAt: now + GIFT_INVOICE_TTL_MS,
        ...(parsed.data.messageId === undefined
          ? {}
          : {
              messageId: parsed.data.messageId,
              comment: parsed.data.comment ?? '',
            }),
      });
      logEvent('invoice.issued', { id, address, amountMsat });
      return c.json(
        {
          id,
          pr: fetched.pr,
          paymentHash: decoded.paymentHash,
          amountMsat,
        },
        200,
      );
    })
    .post('/proof', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'Expected a JSON body with id and preimage' }, 400);
      }
      const parsed = proofBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with id and preimage' }, 400);
      }

      const invoice = deps.store.get(parsed.data.id);
      if (invoice === undefined) {
        return c.json({ error: 'Invoice not found' }, 404);
      }
      const now = deps.now();
      if (invoice.paidAt !== undefined) {
        if (
          invoice.preimage !== undefined &&
          invoice.preimage === parsed.data.preimage.trim().toLowerCase() &&
          preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)
        ) {
          await finishPaid(invoice, invoice.paidAt);
          return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
        }
        return c.json({ error: 'Invoice already paid' }, 409);
      }
      if (preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)) {
        const preimage = parsed.data.preimage.trim().toLowerCase();
        deps.store.markPaid(invoice.id, preimage, now);
        logEvent('invoice.paid', { id: invoice.id, paymentHash: invoice.paymentHash });
        await finishPaid(invoice, now);
        return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
      }
      if (now >= invoice.expiresAt) {
        return c.json({ error: 'Invoice expired' }, 409);
      }
      return c.json({ error: 'Proof does not match invoice' }, 400);
    });
}
