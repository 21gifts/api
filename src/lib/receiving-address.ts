/**
 * The address an account receives in-app payments on.
 *
 * With a verified wallet and the self-hosted LNURL server configured, that is
 * the wallet-backed `<username>@<host of PUBLIC_BASE_URL>`; otherwise the
 * linked external Lightning address. Every money route and the receipt ingest
 * resolve the address through {@link receivingAddress} and fetch LNURL
 * documents through {@link lnurlServerFetch}, which answers wallet-backed
 * addresses from the LNURL server directly instead of over the public URL.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { LNURL_SERVER_TIMEOUT_MS, callLnurlServer } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { normalizeUsername } from '@/lib/username';

/** Where an account receives: its wallet, or an external Lightning address. */
export type ReceivingAddress =
  | {
      kind: 'wallet';
      /** `<username>@<host of PUBLIC_BASE_URL>`. */
      address: string;
      /** Verified wallet identity key (66 lower-case hex). */
      sparkPubkey: string;
    }
  | {
      kind: 'external';
      /** Linked Lightning address, trimmed. */
      address: string;
    };

/** Account fields the resolver reads. */
export type ReceivingAccount = Pick<
  Account,
  'lightningAddress' | 'username' | 'sparkPubkey' | 'sparkPubkeyVerifiedAt'
>;

/**
 * Resolve the address an account receives on.
 *
 * A verified wallet (`sparkPubkeyVerifiedAt` a number, `sparkPubkey` and
 * `username` set) wins when `lnurlServer` is configured. Otherwise the
 * trimmed linked Lightning address, or `null` when it is blank.
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
    lnurlServer !== undefined &&
    typeof account.sparkPubkeyVerifiedAt === 'number' &&
    sparkPubkey !== null &&
    username !== ''
  ) {
    return { kind: 'wallet', address: `${username}@${lnurlServer.host}`, sparkPubkey };
  }
  const linked = account.lightningAddress?.trim() ?? '';
  return linked === '' ? null : { kind: 'external', address: linked };
}

/**
 * Wrap `fetchImpl` so LNURL requests to the wallet-backed host stay internal.
 *
 * A request whose URL host equals `lnurlServer.host` (the LUD-16 document of
 * a wallet-backed address and its pay callback) is sent as a `GET` to the
 * LNURL server with {@link callLnurlServer} (path segments and query kept,
 * fixed `Host`, 15 s timeout); every other request goes to `fetchImpl`
 * unchanged. Like the public `GET /.well-known/lnurlp/:username`, a LUD-16
 * document request for a username without a verified wallet goes to
 * `fetchImpl` too, so an external address on that host keeps resolving over
 * the public URL. A refused path segment or an unreachable LNURL server
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
