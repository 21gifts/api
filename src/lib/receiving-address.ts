/**
 * The address an account receives in-app payments on.
 *
 * A member receives only on their in-app wallet, at the wallet-backed
 * `<username>@<host of PUBLIC_BASE_URL>`. Without a verified wallet, or with
 * the self-hosted LNURL server off, an account cannot receive. Every money
 * route and the receipt ingest resolve the address through
 * {@link receivingAddress} and fetch LNURL documents through
 * {@link lnurlServerFetch}, which answers the wallet-backed host from the
 * LNURL server directly instead of over the public URL.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { LNURL_SERVER_TIMEOUT_MS, callLnurlServer } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { normalizeUsername } from '@/lib/username';

/**
 * Machine-readable `code` on a 400 when the caller must set up and verify the
 * in-app wallet first. Clients decide by this field, not by status or text.
 */
export const WALLET_REQUIRED = 'wallet_required';

/**
 * Machine-readable `code` on a 400 when the recipient cannot receive: no
 * member account, no verified wallet, or its wallet refuses the zap. Clients
 * decide by this field, not by status or text.
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

/**
 * Wrap `fetchImpl` so LNURL requests to the wallet-backed host stay internal.
 *
 * A request whose URL host equals `lnurlServer.host` (the LUD-16 document of
 * a wallet-backed address and its pay callback) is sent as a `GET` to the
 * LNURL server with {@link callLnurlServer} (path segments and query kept,
 * fixed `Host`, 15 s timeout); every other request goes to `fetchImpl`
 * unchanged. A LUD-16 document request for a username without a verified
 * wallet goes to `fetchImpl` too, like the public
 * `GET /.well-known/lnurlp/:username`, which answers it with 404 because such a
 * member cannot receive. A refused path segment or an unreachable LNURL server
 * rejects like a failed `fetch`.
 *
 * @param lnurlServer - LNURL server config, or `undefined` (returns `fetchImpl`).
 * @param fetchImpl - Fetch for every other host and for the LNURL server itself.
 * @param accounts - Username lookup that tells a wallet-backed username apart.
 * @returns A fetch with the same signature.
 */
export function lnurlServerFetch(
  lnurlServer: LnurlServerConfig | undefined,
  fetchImpl: FetchFn,
  accounts: Pick<AuthStore, 'getAccountByUsername'>,
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
    const result = await callLnurlServer(lnurlServer, fetchImpl, {
      method: 'GET',
      segments,
      search: url.search,
      timeoutMs: LNURL_SERVER_TIMEOUT_MS,
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
