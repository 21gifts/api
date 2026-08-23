import type { FetchFn } from '@/lib/btc-usd-rate';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { logEvent } from '@/lib/log';
import { parsePhoenixdBaseUrl, PhoenixdClient } from '@/lib/phoenixd';

/**
 * {@link InvoicePayer} backed by a phoenixd {@link PhoenixdClient}.
 *
 * Maps paid → success; failed and uncertain both collapse to
 * `payment_failed` so address-verification callers stay fail-closed.
 */
export class PhoenixdInvoicePayer implements InvoicePayer {
  private readonly client: PhoenixdClient;

  /**
   * @param client - phoenixd HTTP client for the operator node.
   */
  constructor(client: PhoenixdClient) {
    this.client = client;
  }

  /**
   * Always true — this adapter is only constructed when phoenixd env is present.
   *
   * @returns `true`.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Pay a BOLT11 invoice through phoenixd.
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
 * When `PHOENIXD_URL` and `PHOENIXD_PASSWORD` are both non-empty and the URL
 * parses, returns a {@link PhoenixdInvoicePayer}. Otherwise returns
 * {@link UnconfiguredInvoicePayer} and emits `phoenixd.unconfigured`
 * (no secrets in the event).
 *
 * @param env - Environment slice (injected for tests).
 * @param fetchImpl - Injected fetch for the phoenixd client.
 * @returns A configured or unconfigured payer.
 */
export function invoicePayerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): InvoicePayer {
  const rawUrl = env['PHOENIXD_URL'];
  const password = env['PHOENIXD_PASSWORD'];
  if (
    rawUrl === undefined ||
    rawUrl.trim() === '' ||
    password === undefined ||
    password.trim() === ''
  ) {
    logEvent('phoenixd.unconfigured', { reason: 'missing_env' });
    return new UnconfiguredInvoicePayer();
  }
  const parsed = parsePhoenixdBaseUrl(rawUrl);
  if (!parsed.ok) {
    logEvent('phoenixd.unconfigured', { reason: 'invalid_url' });
    return new UnconfiguredInvoicePayer();
  }
  const client = new PhoenixdClient({
    baseUrl: parsed.baseUrl,
    password: password.trim(),
    fetchImpl,
  });
  return new PhoenixdInvoicePayer(client);
}
