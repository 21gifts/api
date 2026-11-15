/**
 * Webhook the self-hosted LNURL server calls when a member's lightning
 * address receives a payment. Mounted only when `LNURL_WEBHOOK_SECRET` is set.
 */

import { Hono } from 'hono';
import { readCappedText } from '@/lib/capped-body';
import { errorLogFields, logEvent } from '@/lib/log';
import {
  breezSignatureValid,
  notifyPaymentReceived,
  parsePaymentReceived,
  type PaymentReceivedDeps,
} from '@/lib/payment-received';

/** Largest webhook body accepted, in bytes. */
const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

/** Collaborators of {@link webhookRoutes}. */
export interface WebhookRouteDeps extends PaymentReceivedDeps {
  /** Secret shared with the LNURL server (`LNURL_WEBHOOK_SECRET`). */
  secret: string;
  /**
   * Read the receiving wallet now (the wallet transfer worker's bounded read).
   * Called with `data.user_pubkey` of a signed, usable notice; it must not
   * throw and its outcome never changes the answer. Omitted → nothing is read.
   */
  readWallet?: (walletPubkey: string) => void;
}

/**
 * Build the `/webhooks` route group.
 *
 * `POST /webhooks/lnurl` answers 401 when `X-Breez-Signature` does not
 * match. A body above 64 KiB, and a signed body that is not a usable
 * `spark_payment_received`, answer 200 `ignored` without writing anything,
 * because the LNURL server retries every other answer without end. A failed store call answers 503, so it retries; the push is
 * enqueued at most once per payment hash. A signed, usable notice also asks
 * `readWallet` to read the receiving wallet now; that request never changes
 * the answer.
 *
 * @param deps - Secret, stores, and clock.
 * @returns A Hono app exposing `POST /lnurl`.
 */
export function webhookRoutes(deps: WebhookRouteDeps): Hono {
  return new Hono().post('/lnurl', async (c) => {
    const body = await readCappedText(c.req.raw, WEBHOOK_BODY_LIMIT_BYTES);
    if (body === null) {
      logEvent('payment_received.ignored');
      return c.json({ outcome: 'ignored' }, 200);
    }
    if (!breezSignatureValid(deps.secret, body, c.req.header('x-breez-signature') ?? null)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const payment = parsePaymentReceived(body);
    if (payment === null) {
      logEvent('payment_received.ignored');
      return c.json({ outcome: 'ignored' }, 200);
    }
    try {
      deps.readWallet?.(payment.userPubkey);
    } catch {
      logEvent('payment_received.read_failed');
    }
    try {
      const outcome = await notifyPaymentReceived(deps, payment);
      logEvent('payment_received', { outcome });
      return c.json({ outcome }, 200);
    } catch (error) {
      logEvent('payment_received.failed', errorLogFields(error));
      return c.json({ error: 'Notifications are unavailable' }, 503);
    }
  });
}
