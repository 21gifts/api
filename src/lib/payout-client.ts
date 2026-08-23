/**
 * Vendor-neutral payout port used by the daily-gifts worker.
 *
 * Implementations talk to a programmable Lightning backend (phoenixd today).
 * The worker only needs a satoshi balance and a BOLT11 pay result.
 */

/** Outcome of paying a BOLT11 invoice. */
export type PayoutPayResult =
  | { status: 'paid'; paymentHash: string; preimage: string }
  | { status: 'failed'; reason: string }
  | { status: 'uncertain'; reason: string; paymentHash?: string };

/**
 * Minimal payout backend: read spendable sats, pay one BOLT11 invoice.
 */
export interface PayoutClient {
  getBalanceSats(): Promise<{ ok: true; sats: number } | { ok: false; reason: string }>;
  payInvoice(bolt11: string): Promise<PayoutPayResult>;
}
