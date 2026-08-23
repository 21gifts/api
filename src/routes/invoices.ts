import { Hono } from 'hono';
import { z } from 'zod';
import { decodeBolt11 } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT, GIFT_INVOICE_MIN_MSAT, GIFT_INVOICE_TTL_MS } from '@/lib/config';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { newInvoiceId, type InvoiceStore } from '@/lib/invoice-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { preimageMatchesHash } from '@/lib/proof';
import { checkSpendAuth } from '@/lib/spend-auth';

/**
 * Spend-worker invoice routes: fetch a recipient BOLT11 via LNURL-pay, then
 * accept the payment preimage as proof. The api does not pay.
 */

/** Collaborators the invoice routes need. */
export interface InvoiceRouteDeps {
  /** `SPEND_API_TOKEN` (blank/undefined → 503). */
  spendApiToken: string | undefined;
  /** Issued-invoice store. */
  store: InvoiceStore;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for LNURL-pay. */
  fetchImpl: FetchFn;
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
 * Build the `/invoices` route group.
 *
 * @param deps - Token, store, clock, fetch.
 * @returns Hono app mounted at `/invoices`.
 */
export function invoiceRoutes(deps: InvoiceRouteDeps): Hono {
  return new Hono()
    .post('/', async (c) => {
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
          return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
        }
        return c.json({ error: 'Invoice already paid' }, 409);
      }
      if (now >= invoice.expiresAt) {
        return c.json({ error: 'Invoice expired' }, 409);
      }
      if (!preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)) {
        return c.json({ error: 'Proof does not match invoice' }, 400);
      }
      const preimage = parsed.data.preimage.trim().toLowerCase();
      deps.store.markPaid(invoice.id, preimage, now);
      logEvent('invoice.paid', { id: invoice.id, paymentHash: invoice.paymentHash });
      return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
    });
}
