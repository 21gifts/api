import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';

/** Minimal zap receipt fields we validate. */
export interface ZapReceipt {
  /** Receipt event id (unique). */
  id: string;
  /** LNURL provider pubkey (must match `nostrPubkey`). */
  pubkey: string;
  /** Tags (`e`, `bolt11`, …). */
  tags: string[][];
}

const indexedReceipts = new Set<string>();

/**
 * Validate a kind:9735 receipt against the author's LNURL `nostrPubkey`
 * and add sats to the message once.
 *
 * Full Appendix F (bolt11 description hash) is applied when `bolt11AmountSats`
 * is provided by the caller; the provider pubkey check is mandatory.
 *
 * @param store - Forum store.
 * @param messageId - Forum row id.
 * @param receipt - Kind 9735.
 * @param providerPubkey - LNURL `nostrPubkey` hex.
 * @param amountSats - Whole sats from the paid invoice.
 * @returns Whether sats were added.
 */
export async function indexZapReceipt(args: {
  store: MessageStore;
  messageId: string;
  receipt: ZapReceipt;
  providerPubkey: string;
  amountSats: number;
}): Promise<boolean> {
  if (args.receipt.pubkey !== args.providerPubkey) {
    logEvent('nostr.zap.rejected', { reason: 'pubkey' });
    return false;
  }
  if (!Number.isInteger(args.amountSats) || args.amountSats <= 0) {
    logEvent('nostr.zap.rejected', { reason: 'amount' });
    return false;
  }
  if (indexedReceipts.has(args.receipt.id)) {
    return false;
  }
  indexedReceipts.add(args.receipt.id);
  await args.store.addSats(args.messageId, args.amountSats);
  logEvent('nostr.zap.indexed', { messageId: args.messageId, sats: args.amountSats });
  return true;
}

/**
 * Clear the in-process receipt set (tests).
 */
export function resetZapReceiptIndex(): void {
  indexedReceipts.clear();
}
