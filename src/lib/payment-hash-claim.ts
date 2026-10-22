/**
 * The payment hash claim (`docs/shop-stablecoin-payment.md`, Payment hash
 * claim): a BOLT11 payment hash belongs to one payment only, either a
 * charge's `pos_charge_invoice` row or a `shop_payment`.
 *
 * On Postgres both writers of a payment hash (`PostgresPosStore.recordInvoice`
 * and step 8 of the creation procedure) open their transaction with the
 * two-key advisory lock `SELECT pg_advisory_xact_lock($1, $2)`, `$1` =
 * {@link PAYMENT_HASH_LOCK_NAMESPACE} and `$2` = {@link paymentHashLockKey}.
 * On a memory boot the claim is one in-process {@link PaymentHashClaims}
 * map that `InMemoryPosStore` and `InMemoryShopPaymentStore` share.
 */

/**
 * First key of the payment hash advisory lock: a fixed namespace for payment
 * hashes (the ASCII bytes `SHPH`). The two-key form never meets the one-key
 * lock `admitWithinPlaces` takes in `src/lib/funding-store.ts`.
 */
export const PAYMENT_HASH_LOCK_NAMESPACE = 1_397_248_072;

/** The claim statement each writer runs first in its transaction. */
export const PAYMENT_HASH_CLAIM_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

/**
 * Second key of the payment hash advisory lock: the first 32 bits of the
 * hash as a signed 32-bit integer. Two hashes that share their first 32 bits
 * only wait for each other. Characters that are not hex give `0`.
 *
 * @param paymentHash - Payment hash, lowercase hex.
 * @returns A signed 32-bit integer.
 */
export function paymentHashLockKey(paymentHash: string): number {
  return parseInt(paymentHash.slice(0, 8), 16) | 0;
}

/** Who holds one payment hash in a {@link PaymentHashClaims} map. */
export interface PaymentHashHolder {
  /** The charge whose `pos_charge_invoice` row holds the hash, or `null`. */
  chargeId: string | null;
  /** The shop payment that holds the hash, or `null`. */
  paymentId: string | null;
  /** That shop payment's `pos_charge_id` (`null` for a payer's payment or no payment). */
  paymentChargeId: string | null;
}

/** One side of a claim: the charge invoice row or the shop payment. */
export type PaymentHashSide = 'charge' | 'shop';

/**
 * The in-process payment hash claim of a memory boot: one map from payment
 * hash to the charge invoice row and the shop payment that hold it. Every
 * method is synchronous, so a writer that reads the map and adds its entry
 * without an `await` in between claims the hash atomically.
 */
export class PaymentHashClaims {
  readonly #holders = new Map<string, PaymentHashHolder>();

  /**
   * Who holds `paymentHash`.
   *
   * @param paymentHash - Payment hash.
   * @returns A copy of the holder, or `null` when nobody holds the hash.
   */
  holder(paymentHash: string): PaymentHashHolder | null {
    const entry = this.#holders.get(paymentHash);
    return entry === undefined ? null : { ...entry };
  }

  /**
   * Record that the charge's `pos_charge_invoice` row holds `paymentHash`.
   *
   * @param paymentHash - Payment hash.
   * @param chargeId - The charge.
   */
  claimCharge(paymentHash: string, chargeId: string): void {
    const entry = this.#holders.get(paymentHash);
    if (entry === undefined) {
      this.#holders.set(paymentHash, { chargeId, paymentId: null, paymentChargeId: null });
    } else {
      entry.chargeId = chargeId;
    }
  }

  /**
   * Record that a shop payment holds `paymentHash`.
   *
   * @param paymentHash - Payment hash.
   * @param paymentId - The shop payment.
   * @param paymentChargeId - Its `pos_charge_id`, or `null` for a payer's payment.
   */
  claimShop(paymentHash: string, paymentId: string, paymentChargeId: string | null): void {
    const entry = this.#holders.get(paymentHash);
    if (entry === undefined) {
      this.#holders.set(paymentHash, { chargeId: null, paymentId, paymentChargeId });
    } else {
      entry.paymentId = paymentId;
      entry.paymentChargeId = paymentChargeId;
    }
  }

  /**
   * Drop one side of the claim on `paymentHash`; the entry goes once neither
   * side holds it. A hash nobody holds is left as is.
   *
   * @param paymentHash - Payment hash.
   * @param side - `charge` (the invoice row was deleted) or `shop` (the
   *   payment's insert was rolled back).
   */
  release(paymentHash: string, side: PaymentHashSide): void {
    const entry = this.#holders.get(paymentHash);
    if (entry === undefined) {
      return;
    }
    if (side === 'charge') {
      entry.chargeId = null;
    } else {
      entry.paymentId = null;
      entry.paymentChargeId = null;
    }
    if (entry.chargeId === null && entry.paymentId === null) {
      this.#holders.delete(paymentHash);
    }
  }
}
