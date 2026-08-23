import type { FetchFn } from '@/lib/btc-usd-rate';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { LndhubClient, parseLndhubBaseUrl } from '@/lib/lndhub';
import { logEvent } from '@/lib/log';

/**
 * {@link InvoicePayer} backed by a lightning.space {@link LndhubClient}.
 *
 * Maps LNDHub paid → success; failed and uncertain both collapse to
 * `payment_failed` so address-verification callers stay fail-closed.
 */
export class LndhubInvoicePayer implements InvoicePayer {
  private readonly client: LndhubClient;

  /**
   * @param client - Authenticated LNDHub client for the operator wallet.
   */
  constructor(client: LndhubClient) {
    this.client = client;
  }

  /**
   * Always true — this adapter is only constructed when LNDHub env is present.
   *
   * @returns `true`.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Pay a BOLT11 invoice through LNDHub.
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
 * When `LNDHUB_URL`, `LNDHUB_LOGIN`, and `LNDHUB_PASSWORD` are all non-empty
 * and the URL parses as lightning.space HTTPS, returns a
 * {@link LndhubInvoicePayer}. Otherwise returns {@link UnconfiguredInvoicePayer}
 * and emits `lndhub.unconfigured` (no secrets in the event).
 *
 * @param env - Environment slice (injected for tests).
 * @param fetchImpl - Injected fetch for the LNDHub client.
 * @returns A configured or unconfigured payer.
 */
export function invoicePayerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): InvoicePayer {
  const url = env['LNDHUB_URL'];
  const login = env['LNDHUB_LOGIN'];
  const password = env['LNDHUB_PASSWORD'];
  if (
    url === undefined ||
    url.trim() === '' ||
    login === undefined ||
    login.trim() === '' ||
    password === undefined ||
    password.trim() === ''
  ) {
    logEvent('lndhub.unconfigured', { reason: 'missing_env' });
    return new UnconfiguredInvoicePayer();
  }
  const parsed = parseLndhubBaseUrl(url);
  if (parsed === null) {
    logEvent('lndhub.unconfigured', { reason: 'invalid_url' });
    return new UnconfiguredInvoicePayer();
  }
  const client = new LndhubClient({
    baseUrl: url,
    login,
    password,
    fetchImpl,
  });
  return new LndhubInvoicePayer(client);
}
