/**
 * Point-of-sale charge domain: public and debug JSON projection.
 *
 * One open amount in whole sats. Settlement goes to the member's receiving
 * address. The api watches the invoices it handed out for a pending charge
 * (a Spark invoice and every BOLT11 at the charge amount) and marks the
 * charge `paid` once one of them settles. Expired charges are not a live
 * invoice.
 */

/** Live, paid, cancelled, or TTL-expired. */
export type PosChargeStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

/** How long a pending charge pins LNURL-pay min/max (five minutes). */
export const POS_CHARGE_TTL_MS = 5 * 60 * 1000;

/** `GET /pos` keeps showing a charge as `charge` this long after it was paid. */
export const POS_PAID_SHOW_MS = 60 * 1000;

/** Persisted point-of-sale row (store-internal; includes `accountId`). */
export interface PosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `paid`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** Creation instant. */
  createdAt: Date;
  /** Instant after which a pending row is expired. */
  expiresAt: Date;
  /** When a payment for this charge was confirmed, or `null`. */
  paidAt: Date | null;
  /** The Spark invoice handed out for this charge (`spark1…`), or `null`. */
  sparkInvoice: string | null;
}

/** Public JSON shape of a charge (no `accountId`, no `sparkInvoice`). */
export interface PublicPosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `paid`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** ISO-8601 instant the payment was confirmed, or `null`. */
  paidAt: string | null;
}

/** Operator JSON shape of a charge (includes `accountId` and `sparkInvoice`). */
export interface DebugPosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `paid`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** ISO-8601 instant the payment was confirmed, or `null`. */
  paidAt: string | null;
  /** The Spark invoice handed out for this charge, or `null`. */
  sparkInvoice: string | null;
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Public fields only (`accountId` and `sparkInvoice` omitted); timestamps as ISO-8601.
 */
export function serializePosCharge(row: PosCharge): PublicPosCharge {
  return {
    id: row.id,
    amountSats: row.amountSats,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
  };
}

/**
 * Project a store row to its operator debug JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Debug fields including `accountId` and `sparkInvoice`; timestamps as ISO-8601.
 */
export function serializeDebugPosCharge(row: PosCharge): DebugPosCharge {
  return {
    id: row.id,
    accountId: row.accountId,
    amountSats: row.amountSats,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
    sparkInvoice: row.sparkInvoice,
  };
}
