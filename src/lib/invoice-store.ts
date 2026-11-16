import { GIFT_INVOICE_TTL_MS } from '@/lib/config';

/**
 * In-memory gift invoices issued for Fond payouts.
 *
 * Same persistence story as auth: process-local, gone on restart. Unpaid
 * invoices expire after `GIFT_INVOICE_TTL_MS` (checked at read time). `sweep`
 * drops unpaid rows after expiry plus one extra TTL so the in-memory map stays
 * bounded; rows marked paid are kept.
 */

/** One BOLT11 fetched from a recipient Lightning Address for a payout. */
export interface GiftInvoice {
  /** 32 hex chars, unguessable invoice id. */
  id: string;
  /** Recipient Lightning Address used to fetch `pr`. */
  address: string;
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
  /** Forum post to attach a gift-reply under on settlement. */
  messageId?: string;
  /** Moderator-group conversation message to attach the stipend gift under on settlement. */
  groupMessageId?: string;
  /** LUD-12 comment / gift-reply text (may be `''`). */
  comment?: string;
  /**
   * Decided USD amount already normalized to two decimals (`"5.00"`).
   * Absent when the issue request did not send `amountUsd`.
   */
  amountUsd?: string;
  /** Internal durable welcome-exception lease owner; never accepted from HTTP. */
  welcomeReservationAccountId?: string;
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
   * Look up by id. Does not hide expired rows; the caller checks `expiresAt`.
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
   * Drop unpaid rows whose expiry plus one extra TTL has elapsed.
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
      ...current,
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
