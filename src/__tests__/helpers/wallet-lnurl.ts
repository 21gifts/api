import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';

/** Wallet identity key from the Spark invoice test vector. */
export const WALLET_PUBKEY = '0209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5';

/** LNURL server config used by wallet tests. */
export const LNURL_SERVER: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};

/** Env that resolves the LNURL server and free payments (nsec `11`×32 test vector). */
export const FREE_PAYMENTS_ENV: Record<string, string> = {
  LNURL_SERVER_URL: LNURL_SERVER.baseUrl,
  PUBLIC_BASE_URL: LNURL_SERVER.publicBaseUrl,
  LNURL_ZAP_NSEC_HEX: '11'.repeat(32),
};

/** BOLT11 spec example re-encoded for 21 sats (decodes; its signature does not verify). */
export const BOLT11 =
  'lnbc210n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspc3jnwk';

/** The unmodified BOLT11 spec example (250 000 sats, same payment hash). */
export const BOLT11_250K =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

/** Payment hash of {@link BOLT11}. */
export const BOLT11_PAYMENT_HASH =
  '0001020304050607080900010203040506070809000102030405060708090102';

/**
 * Create an account with a verified wallet and no external address.
 *
 * @param store - Auth store.
 * @param id - Account id.
 * @param username - Lower-case username.
 * @param extra - Optional `lightningAddress` and `rulesAgreedAt`.
 * @returns Resolves when the account is created, claimed, and verified.
 * @throws Error when the wallet key cannot be marked verified.
 */
export async function createWalletAccount(
  store: AuthStore,
  id: string,
  username: string,
  extra: { lightningAddress?: string | null; rulesAgreedAt?: number | null } = {},
): Promise<void> {
  await store.createAccount({
    id,
    linkingKey: null,
    role: 'verified',
    name: username,
    username,
    lightningAddress: extra.lightningAddress ?? null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${id.replaceAll('-', '')}${'0'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: extra.rulesAgreedAt ?? 1,
    walletRequired: true,
  });
  await store.claimSparkPubkey(id, WALLET_PUBKEY);
  if (!(await store.markSparkPubkeyVerified(id, WALLET_PUBKEY, username, 2))) {
    throw new Error('wallet not verified');
  }
}

/** One request seen by {@link walletLnurlFetch}. */
export interface SeenRequest {
  url: string;
  host: string | null;
}

/**
 * Fake LNURL server for a wallet-backed username. Any other URL is recorded and
 * answered with 500 so a public round trip would fail the test.
 *
 * @param username - Wallet-backed username.
 * @param pr - Invoice the callback returns.
 * @returns The fake fetch and the requests it saw.
 */
export function walletLnurlFetch(
  username: string,
  pr: string = BOLT11,
): {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, host: headers['host'] ?? null });
    if (url === `${LNURL_SERVER.baseUrl}/.well-known/lnurlp/${username}`) {
      return Response.json({
        tag: 'payRequest',
        callback: `${LNURL_SERVER.publicBaseUrl}/lnurlp/${username}/invoice`,
        metadata: '[["text/plain","x"]]',
        minSendable: 1000,
        maxSendable: 1_000_000_000,
        allowsNostr: true,
        nostrPubkey: 'bb'.repeat(32),
      });
    }
    if (url.startsWith(`${LNURL_SERVER.baseUrl}/lnurlp/${username}/invoice?`)) {
      return Response.json({ pr });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { fetchImpl, seen };
}

/**
 * Assert-friendly summary: every request went to the LNURL server with the public host.
 *
 * @param seen - Requests recorded by {@link walletLnurlFetch}.
 * @returns `true` when there was at least one request and all of them were internal.
 */
export function allInternal(seen: readonly SeenRequest[]): boolean {
  return (
    seen.length > 0 &&
    seen.every(
      (request) =>
        request.url.startsWith(`${LNURL_SERVER.baseUrl}/`) && request.host === LNURL_SERVER.host,
    )
  );
}
