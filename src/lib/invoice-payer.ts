/**
 * Port for paying a BOLT11 invoice (used by receiver address verification).
 *
 * v1 has no real payer wired in production yet: {@link UnconfiguredInvoicePayer}
 * is the default so the process boots without fail-loud env. Starting
 * verification returns 503 until a real adapter is injected.
 */

/** Outcome of attempting to pay a BOLT11 invoice. */
export type PayInvoiceResult =
  { ok: true } | { ok: false; reason: 'not_configured' | 'payment_failed' };

/**
 * Pays a BOLT11 invoice. Implementations may talk to LNDHub, LND, or any
 * other backend; the verification domain only needs success or a reason.
 */
export interface InvoicePayer {
  /**
   * Whether this payer can actually send payments.
   * UnconfiguredInvoicePayer returns false so startVerification can
   * fail closed with not_configured without calling LNURL.
   */
  isConfigured(): boolean;

  /**
   * Attempt to pay the given BOLT11 invoice.
   *
   * @param bolt11 - The invoice string (`pr` from LNURL-pay).
   * @returns Success, or a typed failure reason.
   */
  payInvoice(bolt11: string): Promise<PayInvoiceResult>;
}

/**
 * Default payer when no Lightning backend is configured. Always reports
 * `not_configured` so the process can boot without a payment provider.
 */
export class UnconfiguredInvoicePayer implements InvoicePayer {
  /**
   * Always false — no Lightning backend is wired.
   *
   * @returns `false`.
   */
  isConfigured(): boolean {
    return false;
  }

  /**
   * Refuse every payment as not configured.
   *
   * @param _bolt11 - Ignored invoice string.
   * @returns Always `{ ok: false, reason: 'not_configured' }`.
   */
  async payInvoice(_bolt11: string): Promise<PayInvoiceResult> {
    return { ok: false, reason: 'not_configured' };
  }
}
