import type { FetchFn } from '@/lib/btc-usd-rate';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { logEvent } from '@/lib/log';
import { WosClient } from '@/lib/wos';

/**
 * {@link InvoicePayer} backed by a Wallet of Satoshi {@link WosClient}.
 *
 * Maps paid → success; failed and uncertain both collapse to
 * `payment_failed` so address-verification callers stay fail-closed.
 */
export class WosInvoicePayer implements InvoicePayer {
  private readonly client: WosClient;

  /**
   * @param client - Signed WoS client for the operator wallet.
   */
  constructor(client: WosClient) {
    this.client = client;
  }

  /**
   * Always true — this adapter is only constructed when WoS env is present.
   *
   * @returns `true`.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Pay a BOLT11 invoice through Wallet of Satoshi.
   *
   * @param bolt11 - Invoice string (never logged).
   * @returns `{ ok: true }` when paid; otherwise `{ ok: false, reason: 'payment_failed' }`.
   */
  async payInvoice(bolt11: string): Promise<PayInvoiceResult> {
    const result = await this.client.payInvoice(bolt11);
    if (result.status === 'paid') {
      return { ok: true };
    }
    return { ok: false, reason: 'payment_failed' };
  }
}

/**
 * Build an {@link InvoicePayer} from environment variables.
 *
 * When `WOS_API_TOKEN` and `WOS_API_SECRET` are both non-empty, returns a
 * {@link WosInvoicePayer}. Otherwise returns {@link UnconfiguredInvoicePayer}
 * and emits `wos.unconfigured` (no secrets in the event).
 *
 * @param env - Environment slice (injected for tests).
 * @param fetchImpl - Injected fetch for the WoS client.
 * @returns A configured or unconfigured payer.
 */
export function invoicePayerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): InvoicePayer {
  const apiToken = env['WOS_API_TOKEN'];
  const apiSecret = env['WOS_API_SECRET'];
  if (
    apiToken === undefined ||
    apiToken.trim() === '' ||
    apiSecret === undefined ||
    apiSecret.trim() === ''
  ) {
    logEvent('wos.unconfigured', { reason: 'missing_env' });
    return new UnconfiguredInvoicePayer();
  }
  const client = new WosClient({
    apiToken: apiToken.trim(),
    apiSecret: apiSecret.trim(),
    fetchImpl,
  });
  return new WosInvoicePayer(client);
}
