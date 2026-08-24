import { GIFT_INVOICE_TTL_MS } from '@/lib/config';

/**
 * In-memory gift invoices issued for the spend worker.
 *
 * Same persistence story as auth: process-local, gone on restart. Unpaid
 * invoices expire after `GIFT_INVOICE_TTL_MS` (checked at read time). `sweep`
 * drops unpaid rows after expiry plus one extra TTL so 409 still works in
 * that window; paid rows stay for proof idempotency.
 */

/** One BOLT11 fetched from a recipient Lightning Address, awaiting proof. */
export interface GiftInvoice {
  /** 32 hex chars, unguessable id returned to the spend worker. */
  id: string;
  /** BOLT11 payment request (`pr`). */
  pr: string;
  /** 32-byte payment hash, lowercase hex. */
  paymentHash: string;
  /** Invoice amount in millisatoshis. */
  amountMsat: number;
  /** Epoch milliseconds when the invoice was stored. */
  createdAt: number;
  /** Epoch milliseconds after which an unpaid invoice is expired. */
  expiresAt: number;
  /** Epoch milliseconds when a matching preimage was accepted. */
  paidAt?: number;
  /** Preimage that settled the invoice, lowercase hex. */
  preimage?: string;
}

/**
 * Persistence port for gift invoices.
 */
export interface InvoiceStore {
  /**
   * Insert a newly issued invoice.
   *
   * @param invoice - Record to store.
   */
  put(invoice: GiftInvoice): void;
  /**
   * Look up by id. Does not hide expired rows — the route decides 409 vs 404.
   *
   * @param id - Invoice id.
   * @returns The record, or `undefined`.
   */
  get(id: string): GiftInvoice | undefined;
  /**
   * Mark an existing invoice paid with the given preimage.
   *
   * @param id - Invoice id.
   * @param preimage - Settling preimage, lowercase hex.
   * @param now - Clock, epoch milliseconds.
   */
  markPaid(id: string, preimage: string, now: number): void;
  /**
   * Drop unpaid rows whose 409 tombstone window has elapsed.
   *
   * @param now - Clock, epoch milliseconds.
   */
  sweep(now: number): void;
}

/**
 * Process-local {@link InvoiceStore}.
 */
export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly byId = new Map<string, GiftInvoice>();

  /**
   * Store `invoice`, replacing any previous row with the same id.
   *
   * @param invoice - Record to store.
   */
  put(invoice: GiftInvoice): void {
    this.byId.set(invoice.id, invoice);
  }

  /**
   * Return the row for `id`, if any.
   *
   * @param id - Invoice id.
   * @returns The record, or `undefined`.
   */
  get(id: string): GiftInvoice | undefined {
    return this.byId.get(id);
  }

  /**
   * Copy the row, set `paidAt` and `preimage`, and replace it.
   *
   * @param id - Invoice id. No-op when missing.
   * @param preimage - Settling preimage, lowercase hex.
   * @param now - Clock, epoch milliseconds.
   */
  markPaid(id: string, preimage: string, now: number): void {
    const current = this.byId.get(id);
    if (current === undefined) {
      return;
    }
    const paid: GiftInvoice = {
      id: current.id,
      pr: current.pr,
      paymentHash: current.paymentHash,
      amountMsat: current.amountMsat,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
      paidAt: now,
      preimage,
    };
    this.byId.set(id, paid);
  }

  /**
   * Delete unpaid rows with `now >= expiresAt + GIFT_INVOICE_TTL_MS`.
   *
   * @param now - Clock, epoch milliseconds.
   */
  sweep(now: number): void {
    for (const [id, row] of this.byId) {
      if (row.paidAt !== undefined) {
        continue;
      }
      if (now >= row.expiresAt + GIFT_INVOICE_TTL_MS) {
        this.byId.delete(id);
      }
    }
  }
}

/**
 * Allocate a 16-byte random invoice id as 32 lowercase hex characters.
 *
 * @returns Unguessable id.
 */
export function newInvoiceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
