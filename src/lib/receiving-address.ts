/**
 * The address an account receives on.
 *
 * A verified in-app wallet, with the self-hosted LNURL server on, receives
 * only at `<username>@<host of PUBLIC_BASE_URL>` ({@link receivingAddress}).
 * The till, the public pay link, and the payout list use {@link payableAddress}:
 * that wallet address, or, when the wallet is not ready, the lightning address
 * stored on the account. Zaps, conversations, repayment, and the public
 * account JSON stay on the verified wallet only. LNURL documents are fetched
 * through {@link lnurlServerFetch}, which answers the wallet-backed host from
 * the LNURL server directly instead of over the public URL.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { LNURL_SERVER_TIMEOUT_MS, callLnurlServer } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { normalizeUsername } from '@/lib/username';

/**
 * Machine-readable `code` on a 400 when the caller must set up and verify the
 * in-app wallet first. Clients decide by this field, not by status or text.
 */
export const WALLET_REQUIRED = 'wallet_required';

/**
 * Machine-readable `code` when the recipient cannot receive: no member
 * account, no verified wallet, or its wallet refuses the zap. It comes on a
 * 400 (the forum, conversation, and repayment invoices) or on a 409 (the habit
 * donation). On the conversation invoice it also covers a counterpart whose
 * profile note is not signed yet or who has no Nostr key. Clients decide by
 * this field, not by status or text.
 */
export const CANNOT_RECEIVE = 'cannot_receive';

/** Where an account receives: its verified in-app wallet. */
export interface ReceivingAddress {
  /** `<username>@<host of PUBLIC_BASE_URL>`. */
  address: string;
  /** Verified wallet identity key (66 lower-case hex). */
  sparkPubkey: string;
}

/** Account fields the resolver reads. */
export type ReceivingAccount = Pick<Account, 'username' | 'sparkPubkey' | 'sparkPubkeyVerifiedAt'>;

/**
 * Resolve the address an account receives on.
 *
 * Only a verified wallet (`sparkPubkeyVerifiedAt` a number, `sparkPubkey` and
 * `username` set) with `lnurlServer` configured receives.
 *
 * @param account - Account fields.
 * @param lnurlServer - LNURL server config, or `undefined` when the feature is off.
 * @returns The receiving address, or `null` when the account cannot receive.
 */
export function receivingAddress(
  account: ReceivingAccount,
  lnurlServer: LnurlServerConfig | undefined,
): ReceivingAddress | null {
  const username = account.username?.trim().toLowerCase() ?? '';
  const sparkPubkey = account.sparkPubkey ?? null;
  if (
    lnurlServer === undefined ||
    typeof account.sparkPubkeyVerifiedAt !== 'number' ||
    sparkPubkey === null ||
    username === ''
  ) {
    return null;
  }
  return { address: `${username}@${lnurlServer.host}`, sparkPubkey };
}

/**
 * Find the member who receives on a wallet-backed address.
 *
 * The address must be `<username>@<host of PUBLIC_BASE_URL>` (trimmed, compared
 * case-insensitively). The username is looked up, and the account must resolve
 * to that same address through {@link receivingAddress}, so a member without a
 * verified wallet is not found. Any other domain, a blank local part, or the
 * LNURL server being off is not found either.
 *
 * @param store - Auth store with a username lookup.
 * @param address - Address as given by the caller.
 * @param lnurlServer - LNURL server config, or `undefined` when the feature is off.
 * @returns The receiving account and its address, or `undefined` when none.
 */
export async function accountByReceivingAddress(
  store: Pick<AuthStore, 'getAccountByUsername'>,
  address: string,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<{ account: Account; receiving: ReceivingAddress } | undefined> {
  if (lnurlServer === undefined) {
    return undefined;
  }
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0 || lower.slice(at + 1) !== lnurlServer.host.toLowerCase()) {
    return undefined;
  }
  const account = await store.getAccountByUsername(lower.slice(0, at));
  if (account === undefined) {
    return undefined;
  }
  const receiving = receivingAddress(account, lnurlServer);
  if (receiving === null || receiving.address.toLowerCase() !== lower) {
    return undefined;
  }
  return { account, receiving };
}

/** Account fields {@link payableAddress} reads. */
export type PayableAccount = ReceivingAccount & { legacyLightningAddress?: string | null };

/**
 * Address the till, the public pay link, and the payout list use.
 *
 * A verified wallet with the LNURL server on wins: the stored lightning
 * address is not also paid. Otherwise the stored address is used when it is
 * a Lightning Address. Neither is `null`.
 *
 * @param account - Account fields.
 * @param lnurlServer - LNURL server config, or `undefined` when the feature is off.
 * @returns The payable address, or `null` when the account cannot be paid.
 */
export function payableAddress(
  account: PayableAccount,
  lnurlServer: LnurlServerConfig | undefined,
): string | null {
  const wallet = receivingAddress(account, lnurlServer);
  if (wallet !== null) {
    return wallet.address;
  }
  const raw = account.legacyLightningAddress;
  if (typeof raw !== 'string') {
    return null;
  }
  return normalizeLightningAddress(raw);
}

/**
 * Find the member who is paid on `address`.
 *
 * A wallet-backed address is resolved first ({@link accountByReceivingAddress}).
 * Any other Lightning Address matches the address stored on the account, and
 * only when that account is not already receiving on a verified wallet. A
 * verified wallet is therefore not paid on its old address.
 *
 * @param store - Username lookup and stored-address lookup.
 * @param address - Address as given by the caller.
 * @param lnurlServer - LNURL server config, or `undefined` when the feature is off.
 * @returns The account and the address it is paid on, or `undefined`.
 */
export async function accountForPayableAddress(
  store: Pick<AuthStore, 'getAccountByUsername' | 'getAccountByLegacyLightningAddress'>,
  address: string,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<{ account: Account; address: string } | undefined> {
  const wallet = await accountByReceivingAddress(store, address, lnurlServer);
  if (wallet !== undefined) {
    return { account: wallet.account, address: wallet.receiving.address };
  }
  const normalized = normalizeLightningAddress(address);
  if (normalized === null) {
    return undefined;
  }
  const legacy = await store.getAccountByLegacyLightningAddress(normalized);
  if (legacy === undefined || receivingAddress(legacy, lnurlServer) !== null) {
    return undefined;
  }
  const payable = payableAddress(legacy, lnurlServer);
  if (payable === null || payable.toLowerCase() !== normalized.toLowerCase()) {
    return undefined;
  }
  return { account: legacy, address: payable };
}

/**
 * Wrap `fetchImpl` so LNURL requests to the wallet-backed host stay internal.
 *
 * A request whose URL host equals `lnurlServer.host` (the LUD-16 document of
 * a wallet-backed address and its pay callback) is sent as a `GET` to the
 * LNURL server with {@link callLnurlServer} (path segments and query kept,
 * fixed `Host`, 15 s timeout); every other request goes to `fetchImpl`
 * unchanged. A LUD-16 document request for a username without a verified
 * wallet goes to `fetchImpl` too, like the public
 * `GET /.well-known/lnurlp/:username`. That route answers 404 when the member
 * also has no stored lightning address. A refused path segment or an unreachable LNURL server
 * rejects like a failed `fetch`.
 *
 * @param lnurlServer - LNURL server config, or `undefined` (returns `fetchImpl`).
 * @param fetchImpl - Fetch for every other host and for the LNURL server itself.
 * @param accounts - Username lookup that tells a wallet-backed username apart.
 * @param deadline - Optional absolute deadline: each LNURL server call gets
 *   the time left until `deadlineMs` instead of {@link LNURL_SERVER_TIMEOUT_MS},
 *   and a call at or after it rejects without a request.
 * @returns A fetch with the same signature.
 */
export function lnurlServerFetch(
  lnurlServer: LnurlServerConfig | undefined,
  fetchImpl: FetchFn,
  accounts: Pick<AuthStore, 'getAccountByUsername'>,
  deadline?: { deadlineMs: number; now: () => number },
): FetchFn {
  if (lnurlServer === undefined) {
    return fetchImpl;
  }
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== lnurlServer.host) {
      return fetchImpl(input, init);
    }
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    if (segments[0] === '.well-known' && segments[1] === 'lnurlp') {
      const username = normalizeUsername(segments[2] ?? '');
      const account = username === null ? undefined : await accounts.getAccountByUsername(username);
      if (account === undefined || typeof account.sparkPubkeyVerifiedAt !== 'number') {
        return fetchImpl(input, init);
      }
    }
    const timeoutMs =
      deadline === undefined ? LNURL_SERVER_TIMEOUT_MS : deadline.deadlineMs - deadline.now();
    if (timeoutMs <= 0) {
      throw new TypeError('LNURL server request failed');
    }
    const result = await callLnurlServer(lnurlServer, fetchImpl, {
      method: 'GET',
      segments,
      search: url.search,
      timeoutMs,
    });
    if (!result.ok) {
      throw new TypeError('LNURL server request failed');
    }
    return new Response(result.body === '' ? null : result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
}
