import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT, GIFT_INVOICE_MIN_MSAT, GIFT_INVOICE_TTL_MS } from '@/lib/config';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { newInvoiceId, type GiftInvoice, type InvoiceStore } from '@/lib/invoice-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import type { MessageStore } from '@/lib/message-store';
import { preimageMatchesHash } from '@/lib/proof';
import { checkSpendAuth } from '@/lib/spend-auth';
import {
  NoopGiftRecorder,
  recipientHandleFromAddress,
  type GiftRecorder,
} from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';

/**
 * Spend-worker invoice routes: check passkey eligibility and a live forum
 * post, fetch a recipient BOLT11 via LNURL-pay, then accept the payment
 * preimage as proof. The api does not pay.
 */

/** Collaborators the invoice routes need. */
export interface InvoiceRouteDeps {
  /** `SPEND_API_TOKEN` (blank/undefined → 503). */
  spendApiToken: string | undefined;
  /** Issued-invoice store. */
  store: InvoiceStore;
  /**
   * Auth store for Lightning Address → account and passkey credential lookup.
   * Distinct from {@link InvoiceStore} (`store`).
   */
  authStore: Pick<AuthStore, 'getAccountByLightningAddress' | 'accountHasPasskey'>;
  /**
   * Forum store for Lightning Address → live non-profile post lookup.
   * Distinct from {@link InvoiceStore} (`store`).
   */
  messageStore: Pick<MessageStore, 'accountHasLivePost'>;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for LNURL-pay. */
  fetchImpl: FetchFn;
  /**
   * Persist a proven gift into `gift` for `/gifts/stats`. Default no-op.
   * Insert failures are logged; proof still returns 200.
   */
  giftRecorder?: GiftRecorder;
}

const ISSUE_ERROR = 'Lightning Address did not issue an invoice';

const issueBodySchema = z.object({
  address: z.string(),
  amountMsat: z.number().int(),
  comment: z.string().max(255).optional(),
});

const proofBodySchema = z.object({
  id: z.string().min(1),
  preimage: z.string(),
});

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
 * least one live forum row that is not the auto-created profile note.
 * Missing account → false (fail closed).
 *
 * @param authStore - Account lookup.
 * @param messageStore - Live-post lookup.
 * @param address - Normalised `local@domain`.
 * @returns `true` only when the account has a live non-profile forum row.
 */
async function addressHasPosted(
  authStore: InvoiceRouteDeps['authStore'],
  messageStore: InvoiceRouteDeps['messageStore'],
  address: string,
): Promise<boolean> {
  const account = await authStore.getAccountByLightningAddress(address);
  return (
    account !== undefined &&
    (await messageStore.accountHasLivePost(account.id, account.profileMessageId ?? null))
  );
}

/**
 * Build the `/invoices` route group.
 *
 * @param deps - Token, invoice store, auth store, message store, clock, fetch,
 *   optional gift recorder.
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

      const hasPosted = await addressHasPosted(deps.authStore, deps.messageStore, address);
      return c.json({ hasPosted }, 200);
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

      const address = normalizeLightningAddress(parsed.data.address);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }
      const amountMsat = parsed.data.amountMsat;
      if (amountMsat < GIFT_INVOICE_MIN_MSAT || amountMsat > GIFT_INVOICE_MAX_MSAT) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }

      const hasPasskey = await addressHasPasskey(deps.authStore, address);
      if (!hasPasskey) {
        logEvent('invoice.passkey_required', { address });
        return c.json({ error: 'Passkey required' }, 403);
      }

      const hasPosted = await addressHasPosted(deps.authStore, deps.messageStore, address);
      if (!hasPosted) {
        logEvent('invoice.forum_post_required', { address });
        return c.json({ error: 'Forum post required' }, 403);
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
          await persistProvenGift(invoice, invoice.paidAt);
          return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
        }
        return c.json({ error: 'Invoice already paid' }, 409);
      }
      if (preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)) {
        const preimage = parsed.data.preimage.trim().toLowerCase();
        deps.store.markPaid(invoice.id, preimage, now);
        logEvent('invoice.paid', { id: invoice.id, paymentHash: invoice.paymentHash });
        await persistProvenGift(invoice, now);
        return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
      }
      if (now >= invoice.expiresAt) {
        return c.json({ error: 'Invoice expired' }, 409);
      }
      return c.json({ error: 'Proof does not match invoice' }, 400);
    });
}
