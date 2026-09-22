/**
 * Point-of-sale charge domain: public and debug JSON projection.
 *
 * One open amount in whole sats. There is no paid or completed status —
 * this API cannot see the wallet payment. Settlement stays at Wallet of
 * Satoshi. Expired charges are not a live invoice.
 */

/** Live, cancelled, or TTL-expired. Never paid/completed. */
export type PosChargeStatus = 'pending' | 'cancelled' | 'expired';

/** How long a pending charge pins LNURL-pay min/max (five minutes). */
export const POS_CHARGE_TTL_MS = 5 * 60 * 1000;

/** Persisted point-of-sale row (store-internal; includes `accountId`). */
export interface PosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** Creation instant. */
  createdAt: Date;
  /** Instant after which a pending row is expired. */
  expiresAt: Date;
}

/** Public JSON shape of a charge (no `accountId`). */
export interface PublicPosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

/** Operator JSON shape of a charge (includes `accountId`). */
export interface DebugPosCharge {
  /** Opaque unique charge id. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Requested amount in whole sats. */
  amountSats: number;
  /** `pending`, `cancelled`, or `expired`. */
  status: PosChargeStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Public fields only (`accountId` omitted); timestamps as ISO-8601.
 */
export function serializePosCharge(row: PosCharge): PublicPosCharge {
  return {
    id: row.id,
    amountSats: row.amountSats,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Project a store row to its operator debug JSON shape.
 *
 * @param row - Persisted charge.
 * @returns Debug fields including `accountId`; timestamps as ISO-8601.
 */
export function serializeDebugPosCharge(row: PosCharge): DebugPosCharge {
  return {
    id: row.id,
    accountId: row.accountId,
    amountSats: row.amountSats,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
