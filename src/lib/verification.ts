import { timingSafeEqual } from 'node:crypto';
import { randomHex } from '@/lib/auth/lnurl';
import type { Account, AuthStore } from '@/lib/auth/store';
import { VERIFICATION_AMOUNT_MSAT, VERIFICATION_TTL_MS } from '@/lib/config';
import type { InvoicePayer } from '@/lib/invoice-payer';
import { requestPayInvoice, type FetchFn } from '@/lib/lnurl-pay';

/**
 * Receiver Lightning Address proof-of-control: pay a micro-amount with a
 * one-time nonce in the LUD-12 comment, then confirm when the user posts the
 * nonce back from their wallet history.
 */

/** Failure codes from {@link startVerification}; routes map these to HTTP. */
export type StartVerificationCode =
  'no_address' | 'already_verified' | 'unreachable' | 'not_configured';

/** Outcome of starting a verification payment. */
export type StartVerificationResult =
  { ok: true; expiresInSeconds: number; sats: number } | { ok: false; code: StartVerificationCode };

/** Failure codes from {@link confirmVerification}; routes map these to HTTP. */
export type ConfirmVerificationCode = 'bad_nonce' | 'no_pending' | 'expired' | 'mismatch';

/** Outcome of confirming a verification nonce. */
export type ConfirmVerificationResult =
  { ok: true; account: Account } | { ok: false; code: ConfirmVerificationCode };

/** Collaborators for {@link startVerification}. */
export interface StartVerificationArgs {
  /** Auth store holding the pending verification record. */
  store: AuthStore;
  /** Pays the LNURL-pay invoice. */
  payer: InvoicePayer;
  /** Injected fetch for LNURL-pay HTTP. */
  fetchImpl: FetchFn;
  /** Current time in epoch milliseconds. */
  now: number;
  /** The authenticated account whose address is being verified. */
  account: Account;
}

/**
 * Start proof-of-control: request an LNURL-pay invoice with a nonce comment,
 * pay it, and store the pending verification record.
 *
 * The nonce is never returned to the client — the user must read it from the
 * wallet payment history (LUD-12 comment: `21gifts <nonce>`).
 *
 * @param args - Store, payer, fetch, clock, and account.
 * @returns Success with TTL and sats paid, or a tagged failure code.
 */
export async function startVerification(
  args: StartVerificationArgs,
): Promise<StartVerificationResult> {
  const { store, payer, fetchImpl, now, account } = args;

  if (account.lightningAddress === null) {
    return { ok: false, code: 'no_address' };
  }
  if (account.lightningAddressVerified) {
    return { ok: false, code: 'already_verified' };
  }

  const nonce = randomHex(16);
  const comment = `21gifts ${nonce}`;

  const invoice = await requestPayInvoice({
    address: account.lightningAddress,
    amountMsat: VERIFICATION_AMOUNT_MSAT,
    comment,
    fetchImpl,
  });
  if (!invoice.ok) {
    return { ok: false, code: 'unreachable' };
  }

  const paid = await payer.payInvoice(invoice.pr);
  if (!paid.ok) {
    if (paid.reason === 'not_configured') {
      return { ok: false, code: 'not_configured' };
    }
    return { ok: false, code: 'unreachable' };
  }

  store.putVerification({
    accountId: account.id,
    address: account.lightningAddress,
    nonce,
    createdAt: now,
  });

  return {
    ok: true,
    expiresInSeconds: Math.floor(VERIFICATION_TTL_MS / 1000),
    sats: invoice.payMsat / 1000,
  };
}

/**
 * Confirm proof-of-control with the nonce the user read from their wallet.
 *
 * On success the account's `lightningAddressVerified` flag is set and the
 * pending record is deleted. A changed or unlinked address invalidates any
 * pending record (address mismatch → `no_pending`).
 *
 * Nonce comparison uses `crypto.timingSafeEqual` over the UTF-8 bytes of the
 * fixed-length 32-char hex strings so a timing oracle cannot scan the nonce.
 *
 * @param store - Auth store holding accounts and verification records.
 * @param now - Current time in epoch milliseconds.
 * @param account - The authenticated account.
 * @param nonceRaw - Nonce as submitted by the client (trimmed before check).
 * @returns Success with the updated account, or a tagged failure code.
 */
export function confirmVerification(
  store: AuthStore,
  now: number,
  account: Account,
  nonceRaw: string,
): ConfirmVerificationResult {
  const nonce = nonceRaw.trim();
  if (nonce === '') {
    return { ok: false, code: 'bad_nonce' };
  }

  const record = store.getVerification(account.id);
  if (record === undefined || record.address !== account.lightningAddress) {
    return { ok: false, code: 'no_pending' };
  }

  if (now - record.createdAt > VERIFICATION_TTL_MS) {
    store.deleteVerification(account.id);
    return { ok: false, code: 'expired' };
  }

  if (!noncesEqual(nonce, record.nonce)) {
    return { ok: false, code: 'mismatch' };
  }

  const updated: Account = {
    ...account,
    lightningAddressVerified: true,
  };
  store.updateAccount(updated);
  store.deleteVerification(account.id);
  return { ok: true, account: updated };
}

/**
 * Constant-time equality for fixed-length hex nonces.
 *
 * Length is checked first (both sides are 32 hex chars on the happy path);
 * unequal lengths cannot use `timingSafeEqual` and are a mismatch.
 */
function noncesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
