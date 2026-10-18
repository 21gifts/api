/**
 * TypeScript port of the OpenCryptoPay client of Tether Wallet for Android
 * 1.11.0 (build 134), as `docs/shop-stablecoin-payment.md` section
 * "Tether Wallet 1.11.0" states it. Line references point into the
 * decompiled Hermes modules of that build (`ocp-api-module.js`,
 * `ocp-route-module.js`, `ocp-pending-proof-module.js`, `ocp-prove.js`,
 * `eip681-module.js`).
 *
 * The port talks HTTP through {@link WalletHttp} and pays through
 * {@link WalletBundler}; the e2e fixtures back both with Playwright's request
 * context and the chain stand-in. Pauses go through {@link WalletClock} so a
 * unit check can run them instantly; the scenarios use real time.
 */

import { bech32 } from '@scure/base';

/** `OPEN_CRYPTO_PAY_STANDARD` (ocp-api-module.js:1437). */
export const OPEN_CRYPTO_PAY_STANDARD = 'OpenCryptoPay';

/** Pay-request GET and detail GET timeout: the axios instance's 20 s (ocp-api-module.js:1333). */
export const PAY_REQUEST_TIMEOUT_MS = 20_000;
/** Plain LNURL path timeout. */
export const LNURL_TIMEOUT_MS = 10_000;
/** Pauses before attempts 2 and 3 of a proof (ocp-pending-proof-module.js:1613). */
export const PROOF_RETRY_PAUSES_MS: readonly number[] = [1_000, 3_000];
/** Settlement poll interval (ocp-pending-proof-module.js:1565-1567). */
export const SETTLEMENT_POLL_MS = 3_000;
/** Settlement poll total wait (ocp-pending-proof-module.js:1565-1567). */
export const SETTLEMENT_WAIT_MS = 30_000;

/** One rail of `OPEN_CRYPTO_PAY_RAILS` (tether-methods.md, D:1561889-1561949). */
export interface Rail {
  id: string;
  method: string;
  asset: string;
  networkName: 'spark' | 'polygon' | 'arbitrum' | 'ethereum' | 'tron';
  tokenName: 'btc' | 'usdt';
  proof: 'tx' | 'invoice';
  supported: boolean;
  withheld?: boolean;
  experimental?: boolean;
}

/** The wallet's fixed rail list. */
export const OPEN_CRYPTO_PAY_RAILS: readonly Rail[] = [
  {
    id: 'spark-btc',
    method: 'Spark',
    asset: 'BTC',
    networkName: 'spark',
    tokenName: 'btc',
    proof: 'tx',
    supported: true,
  },
  {
    id: 'lightning-btc',
    method: 'Lightning',
    asset: 'BTC',
    networkName: 'spark',
    tokenName: 'btc',
    proof: 'invoice',
    supported: true,
  },
  {
    id: 'polygon-usdt',
    method: 'Polygon',
    asset: 'USDT',
    networkName: 'polygon',
    tokenName: 'usdt',
    proof: 'tx',
    supported: true,
  },
  {
    id: 'arbitrum-usdt',
    method: 'Arbitrum',
    asset: 'USDT',
    networkName: 'arbitrum',
    tokenName: 'usdt',
    proof: 'tx',
    supported: true,
  },
  {
    id: 'ethereum-usdt',
    method: 'Ethereum',
    asset: 'USDT',
    networkName: 'ethereum',
    tokenName: 'usdt',
    proof: 'tx',
    supported: true,
  },
  {
    id: 'tron-usdt',
    method: 'Tron',
    asset: 'USDT',
    networkName: 'tron',
    tokenName: 'usdt',
    proof: 'tx',
    supported: true,
    withheld: true,
  },
];

/** `EVM_CHAIN_TO_NETWORK` (tether-methods.md, D:911454-911463). */
export const EVM_CHAIN_TO_NETWORK: Readonly<Record<number, string>> = {
  1: 'ethereum',
  137: 'polygon',
  42161: 'arbitrum',
  9745: 'plasma',
};

/** The wallet's own USDT contracts (`getTokenAddress('usdt', network)`). */
export const WALLET_USDT: Readonly<Record<string, string>> = {
  ethereum: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  polygon: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  arbitrum: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
};

/** Decimals of the wallet's USDT. */
const USDT_DECIMALS = 6;

/** One HTTP answer. */
export interface WalletResponse {
  status: number;
  body: unknown;
}

/** The wallet's HTTP: a GET that throws on transport failure or timeout. */
export interface WalletHttp {
  get(url: string, timeoutMs: number): Promise<WalletResponse>;
}

/** The bundler the wallet's ERC-4337 account pays through. */
export interface WalletBundler {
  /**
   * Send one ERC-20 transfer as a user operation and wait for inclusion.
   *
   * @returns The user-operation hash and the receipt the bundler returned.
   */
  transfer(input: {
    chainId: number;
    token: string;
    recipient: string;
    amount: bigint;
  }): Promise<{ userOpHash: string; receipt: { hash?: string; transactionHash?: string } }>;
}

/** Sleep and clock. */
export interface WalletClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Real time. */
export const REAL_CLOCK: WalletClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Scan.

/**
 * Scan rule: an `http` or `https` URL whose query has a key `lightning`
 * (compared without case) holding a valid LNURL. Anything else (a bare
 * LNURL, a `lightning:` link) is not OpenCryptoPay.
 *
 * @returns The decoded pay-link URL, or `null`.
 */
export function parseOpenCryptoPayLink(text: string): { lnurl: string; url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() !== 'lightning') {
      continue;
    }
    const url = decodeLnurl(value);
    if (url !== null) {
      return { lnurl: value, url };
    }
  }
  return null;
}

/** Decode an LNURL (bech32, hrp `lnurl`) to its URL, or `null`. */
export function decodeLnurl(lnurl: string): string | null {
  try {
    const decoded = bech32.decode(lnurl.toLowerCase() as `${string}1${string}`, false);
    if (decoded.prefix !== 'lnurl') {
      return null;
    }
    const url = new TextDecoder().decode(bech32.fromWords(decoded.words));
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Encode a URL as an uppercase LNURL, as the sticker carries it. */
export function encodeLnurl(url: string): string {
  return bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false).toUpperCase();
}

/**
 * `withQuery` (ocp-api-module.js:69-140): `key=encodeURIComponent(value)`
 * joined by `&`, appended with `&` when the URL already has a `?`, else `?`.
 */
export function withQuery(url: string, params: Readonly<Record<string, string>>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** `isOpenCryptoPayPayment` (ocp-api-module.js:143-180). */
export function isOpenCryptoPayPayment(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body['standard'] === OPEN_CRYPTO_PAY_STANDARD) {
    return true;
  }
  const possible = body['possibleStandards'];
  return Array.isArray(possible) && possible.includes(OPEN_CRYPTO_PAY_STANDARD);
}

/** An OpenCryptoPay pay request as the wallet reads it. */
export interface OcpPayment {
  raw: Record<string, unknown>;
  callback: string | null;
  quoteId: string | null;
  quoteExpiration: string | null;
  /** `quote.payment`: the sale the register is on (`saleId`). */
  saleId: string | null;
  transferAmounts: unknown[];
}

/** Outcome of one pay-request fetch (`getOpenCryptoPayPayment`). */
export type PayRequestResult =
  | { kind: 'payment'; payment: OcpPayment }
  | { kind: 'lnurl'; body: Record<string, unknown> }
  | { kind: 'no-pending-payment' }
  | { kind: 'not-found' };

function readPayment(body: Record<string, unknown>): OcpPayment {
  const quote = isRecord(body['quote']) ? body['quote'] : {};
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    raw: body,
    callback: str(body['callback']),
    quoteId: str(quote['id']),
    quoteExpiration: str(quote['expiration']),
    saleId: str(quote['payment']),
    transferAmounts: Array.isArray(body['transferAmounts']) ? body['transferAmounts'] : [],
  };
}

/**
 * GET the pay link (no query on the first fetch), 20 s. 2xx with an
 * OpenCryptoPay body is a payment, another 2xx the plain LNURL path; 404
 * with an OpenCryptoPay body means nothing is pending, any other 404 an
 * invalid link ('payment: link not found', fn-getOCPPayment.txt:62-64);
 * every other status throws.
 */
export async function getOpenCryptoPayPayment(
  http: WalletHttp,
  url: string,
): Promise<PayRequestResult> {
  const answer = await http.get(url, PAY_REQUEST_TIMEOUT_MS);
  if (answer.status >= 200 && answer.status < 300 && isRecord(answer.body)) {
    return isOpenCryptoPayPayment(answer.body)
      ? { kind: 'payment', payment: readPayment(answer.body) }
      : { kind: 'lnurl', body: answer.body };
  }
  if (answer.status === 404) {
    return isOpenCryptoPayPayment(answer.body)
      ? { kind: 'no-pending-payment' }
      : { kind: 'not-found' };
  }
  throw new Error(`pay request: HTTP ${answer.status}`);
}

// ---------------------------------------------------------------------------
// Rails.

/** `acceptsRail` (ocp-route-module.js:47-107): exact method, `available`, asset by name. */
export function acceptsRail(entry: unknown, rail: Rail): boolean {
  if (!isRecord(entry) || entry['method'] !== rail.method || entry['available'] !== true) {
    return false;
  }
  const assets = entry['assets'];
  return Array.isArray(assets) && assets.some((a) => isRecord(a) && a['asset'] === rail.asset);
}

/** `payableOptions` (ocp-options-module.js:97-121): supported, not experimental, not withheld. */
export function isPayable(rail: Rail): boolean {
  return rail.supported && rail.experimental !== true && rail.withheld !== true;
}

/** One rail the wallet can offer for a payment, with the advertised amount. */
export interface RailOption {
  rail: Rail;
  /** `assets[].amount` of the matching entry (`advertisedAmount`, ocp-route-module.js:109). */
  amount: string;
}

/** `listOpenCryptoPayOptions` (ocp-route-module.js:748). */
export function listOpenCryptoPayOptions(payment: OcpPayment): RailOption[] {
  const options: RailOption[] = [];
  for (const rail of OPEN_CRYPTO_PAY_RAILS) {
    if (!isPayable(rail)) {
      continue;
    }
    const entry = payment.transferAmounts.find((candidate) => acceptsRail(candidate, rail));
    if (!isRecord(entry) || !Array.isArray(entry['assets'])) {
      continue;
    }
    const asset = entry['assets'].find((a) => isRecord(a) && a['asset'] === rail.asset);
    const amount = isRecord(asset) ? asset['amount'] : undefined;
    options.push({
      rail,
      amount: typeof amount === 'number' ? String(amount) : String(amount ?? ''),
    });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Detail.

/** A complete EIP-681 ERC-20 transfer (`parseEip681`, eip681-module.js:209-452). */
export interface Eip681Transfer {
  tokenAddress: string;
  chainId: number;
  recipient: string;
  amountSmallest: bigint;
}

/**
 * Parse `ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<amount>`.
 * Only a complete request (token, chain id, `transfer`, recipient, and
 * amount) is returned; anything else is `null`.
 */
export function parseEip681(uri: string): Eip681Transfer | null {
  const match =
    /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@([0-9]+))?(?:\/([A-Za-z0-9_]+))?(?:\?(.*))?$/.exec(
      uri,
    );
  if (match === null) {
    return null;
  }
  const [, token, chainRaw, fn, query] = match;
  if (token === undefined || chainRaw === undefined || fn !== 'transfer' || query === undefined) {
    return null;
  }
  const params = new URLSearchParams(query);
  const recipient = params.get('address');
  const amount = params.get('uint256') ?? params.get('value');
  if (recipient === null || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return null;
  }
  if (amount === null || !/^\d+$/.test(amount)) {
    return null;
  }
  return {
    tokenAddress: token,
    chainId: Number(chainRaw),
    recipient,
    amountSmallest: BigInt(amount),
  };
}

/**
 * `parseTransferUri` (ocp-route-module.js:385-536): the URI must be a
 * complete EIP-681 transfer, its chain id must map to the rail's network
 * ('provider uri names a different chain than the rail'), and its token
 * must be the wallet's own contract for that network ('… different token
 * than the rail pays').
 */
export function parseTransferUri(
  uri: string,
  rail: Rail,
): { recipient: string; amountSmallest: bigint; chainId: number; token: string } | null {
  const parsed = parseEip681(uri);
  if (parsed === null) {
    return null;
  }
  if (EVM_CHAIN_TO_NETWORK[parsed.chainId] !== rail.networkName) {
    return null;
  }
  const expected = WALLET_USDT[rail.networkName];
  if (expected === undefined || expected.toLowerCase() !== parsed.tokenAddress.toLowerCase()) {
    return null;
  }
  return {
    recipient: parsed.recipient,
    amountSmallest: parsed.amountSmallest,
    chainId: parsed.chainId,
    token: parsed.tokenAddress,
  };
}

/** `earliestExpiry` (ocp-route-module.js:317-383): the earliest parseable ISO, unparseable ones skipped. */
export function earliestExpiry(...values: Array<string | null | undefined>): string | null {
  let best: { iso: string; at: number } | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
      continue;
    }
    if (best === null || at < best.at) {
      best = { iso: value, at };
    }
  }
  return best === null ? null : best.iso;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * `resolveSubmitUrl` (ocp-route-module.js:192-315). The first `http(s)` URL
 * in `hint` (`/https?:\/\/[^\s"'<>]+/`), trailing `[.,;:!?)\]}]+` cut off,
 * is the proof URL when its path has a segment `tx` and its host equals the
 * callback's. Otherwise the callback with every path segment `cb` replaced
 * by `tx`, query kept; `null` when the callback has no `cb` segment.
 */
export function resolveSubmitUrl(hint: string | null, callback: string | null): string | null {
  const callbackUrl = callback === null ? null : parseHttpUrl(callback);
  const found = hint === null ? null : (/https?:\/\/[^\s"'<>]+/.exec(hint)?.[0] ?? null);
  const trimmed = found === null ? null : found.replace(/[.,;:!?)\]}]+$/, '');
  const hintUrl = trimmed === null ? null : parseHttpUrl(trimmed);
  if (hintUrl !== null && hintUrl.pathname.split('/').includes('tx')) {
    if (callbackUrl !== null && hintUrl.host === callbackUrl.host) {
      return hintUrl.href;
    }
    // 'resolve: ignoring a hint endpoint on a different host than the callback'
  }
  if (callbackUrl === null || !callbackUrl.pathname.split('/').includes('cb')) {
    return null;
  }
  const rewritten = new URL(callbackUrl.href);
  rewritten.pathname = callbackUrl.pathname
    .split('/')
    .map((segment) => (segment === 'cb' ? 'tx' : segment))
    .join('/');
  return rewritten.href;
}

/** The proof the wallet keeps after a detail (ocp-route-module.js ~1180-1185). */
export interface PendingProof {
  submitUrl: string;
  /** The pay-link URL the wallet first fetched. */
  paymentUrl: string;
  quoteId: string;
  saleId: string | null;
  method: string;
  asset: string;
}

/** Outcome of `resolveOpenCryptoPayRail`. */
export type RailResult =
  | { kind: 'invoice'; invoice: string; deadline: string | null }
  | {
      kind: 'transfer';
      chainId: number;
      token: string;
      recipient: string;
      amountSmallest: bigint;
      deadline: string | null;
      proof: PendingProof;
    }
  | { kind: 'error'; error: 'RAIL_UNAVAILABLE' | 'QUOTE_EXPIRED'; detail: string };

/**
 * Detail request (`getOpenCryptoPayTransaction`, ocp-api-module.js:684-945,
 * called from ocp-route-module.js:1529): `callback` + `?`/`&` + `quote`,
 * `method`, `asset`. HTTP 400 is `RAIL_UNAVAILABLE`, 404 `QUOTE_EXPIRED`,
 * any other error throws. Lightning reads `pr`; a `tx` rail reads `uri`,
 * `hint`, and `expiryDate`.
 */
export async function resolveOpenCryptoPayRail(
  http: WalletHttp,
  paymentUrl: string,
  payment: OcpPayment,
  rail: Rail,
): Promise<RailResult> {
  if (payment.callback === null || payment.quoteId === null) {
    throw new Error('resolve: payment has no callback or quote id');
  }
  const url = withQuery(payment.callback, {
    quote: payment.quoteId,
    method: rail.method,
    asset: rail.asset,
  });
  const answer = await http.get(url, PAY_REQUEST_TIMEOUT_MS);
  if (answer.status === 400) {
    return { kind: 'error', error: 'RAIL_UNAVAILABLE', detail: 'HTTP 400' };
  }
  if (answer.status === 404) {
    return { kind: 'error', error: 'QUOTE_EXPIRED', detail: 'HTTP 404' };
  }
  if (answer.status < 200 || answer.status > 299 || !isRecord(answer.body)) {
    throw new Error(`getOpenCryptoPayTransaction: HTTP ${answer.status}`);
  }
  const body = answer.body;
  const expiryDate = typeof body['expiryDate'] === 'string' ? body['expiryDate'] : null;
  const deadline = earliestExpiry(payment.quoteExpiration, expiryDate);
  if (rail.proof === 'invoice') {
    const pr = body['pr'];
    if (typeof pr !== 'string' || pr === '') {
      return { kind: 'error', error: 'RAIL_UNAVAILABLE', detail: 'no pr' };
    }
    return { kind: 'invoice', invoice: pr, deadline };
  }
  const uri = typeof body['uri'] === 'string' ? body['uri'] : '';
  const hint = typeof body['hint'] === 'string' ? body['hint'] : null;
  const transfer = parseTransferUri(uri, rail);
  if (transfer === null) {
    return { kind: 'error', error: 'RAIL_UNAVAILABLE', detail: `uri not payable: ${uri}` };
  }
  const submitUrl = resolveSubmitUrl(hint, payment.callback);
  if (submitUrl === null) {
    return { kind: 'error', error: 'RAIL_UNAVAILABLE', detail: 'no proof url' };
  }
  return {
    kind: 'transfer',
    ...transfer,
    deadline,
    proof: {
      submitUrl,
      paymentUrl,
      quoteId: payment.quoteId,
      saleId: payment.saleId,
      method: rail.method,
      asset: rail.asset,
    },
  };
}

// ---------------------------------------------------------------------------
// Send.

/** Advertised decimal amount to token units (`amountSmallest`), or `null`. */
export function advertisedUnits(amount: string, decimals = USDT_DECIMALS): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return null;
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * The hash the wallet proves with: the bundle transaction's (`hash` or
 * `transactionHash` of the bundler receipt), and the user-operation hash
 * only when the receipt has neither.
 */
export function proofHash(result: {
  userOpHash: string;
  receipt: { hash?: string; transactionHash?: string };
}): string {
  return result.receipt.hash ?? result.receipt.transactionHash ?? result.userOpHash;
}

// ---------------------------------------------------------------------------
// Proof.

/** Outcome of one proof submit (`submitOpenCryptoPayTransaction`, ocp-api-module.js:946-1200). */
export type SubmitResult =
  | { kind: 'accepted'; status: number; txId: string }
  | { kind: 'rejected'; status: number; message: string };

/**
 * One submit: GET `submitUrl` with `quote`, `method`, `asset`, `tx`
 * (ocp-api-module.js:1194). HTTP 5xx or no answer throws ('submit: no
 * answer, retrying'); any status below 500 is final. Success is a 2xx with
 * a non-empty string `txId` ('submit: accepted without a txId' otherwise).
 */
export async function submitOpenCryptoPayTransaction(
  http: WalletHttp,
  proof: PendingProof,
  txHash: string,
): Promise<SubmitResult> {
  const url = withQuery(proof.submitUrl, {
    quote: proof.quoteId,
    method: proof.method,
    asset: proof.asset,
    tx: txHash,
  });
  const answer = await http.get(url, PAY_REQUEST_TIMEOUT_MS);
  if (answer.status >= 500) {
    throw new Error(`submit: HTTP ${answer.status}`);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  if (answer.status >= 200 && answer.status < 300) {
    const txId = body['txId'];
    if (typeof txId === 'string' && txId !== '') {
      return { kind: 'accepted', status: answer.status, txId };
    }
    return {
      kind: 'rejected',
      status: answer.status,
      message: 'Provider returned no transaction id',
    };
  }
  const message = typeof body['message'] === 'string' ? body['message'] : `HTTP ${answer.status}`;
  return { kind: 'rejected', status: answer.status, message };
}

/** One proof attempt as the driver records it. */
export interface AttemptLog {
  attempt: number;
  outcome: 'accepted' | 'rejected' | 'thrown';
  status: number | null;
  detail: string;
}

/**
 * `submitWithRetries` (ocp-pending-proof-module.js:627-868): up to 3
 * attempts, pauses 1 s and 3 s, retrying only a thrown submit.
 */
export async function submitWithRetries(
  http: WalletHttp,
  clock: WalletClock,
  proof: PendingProof,
  txHash: string,
  log: AttemptLog[],
): Promise<SubmitResult | null> {
  for (let attempt = 1; attempt <= PROOF_RETRY_PAUSES_MS.length + 1; attempt += 1) {
    try {
      const result = await submitOpenCryptoPayTransaction(http, proof, txHash);
      log.push({
        attempt,
        outcome: result.kind,
        status: result.status,
        detail: result.kind === 'accepted' ? result.txId : result.message,
      });
      return result;
    } catch (error) {
      log.push({ attempt, outcome: 'thrown', status: null, detail: String(error) });
      const pause = PROOF_RETRY_PAUSES_MS[attempt - 1];
      if (pause === undefined) {
        return null;
      }
      await clock.sleep(pause);
    }
  }
  return null;
}

/**
 * `waitForSettlement` (ocp-pending-proof-module.js:246-626): poll the URL
 * first fetched with `timeout=0`, every 3 s for 30 s. Settled on a 404 with
 * an OpenCryptoPay body ('the register cleared its pending sale') or an
 * answer naming a different `quote.payment` ('the register has moved on to
 * another sale', `isAnotherSale`); otherwise unconfirmed.
 */
export async function waitForSettlement(
  http: WalletHttp,
  clock: WalletClock,
  proof: PendingProof,
  polls: Array<{ kind: string; saleId: string | null }>,
): Promise<'settled' | 'unconfirmed'> {
  const deadline = clock.now() + SETTLEMENT_WAIT_MS;
  const url = withQuery(proof.paymentUrl, { timeout: '0' });
  for (;;) {
    try {
      const result = await getOpenCryptoPayPayment(http, url);
      polls.push({
        kind: result.kind,
        saleId: result.kind === 'payment' ? result.payment.saleId : null,
      });
      if (result.kind === 'no-pending-payment') {
        return 'settled';
      }
      if (result.kind === 'payment' && result.payment.saleId !== proof.saleId) {
        return 'settled';
      }
    } catch (error) {
      polls.push({ kind: `thrown: ${String(error)}`, saleId: null });
    }
    if (clock.now() + SETTLEMENT_POLL_MS >= deadline) {
      return 'unconfirmed';
    }
    await clock.sleep(SETTLEMENT_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// The whole flow.

/** Screen the wallet ends on. */
export type WalletOutcome =
  | 'OPEN_CRYPTO_PAY_SETTLED'
  | 'OPEN_CRYPTO_PAY_UNCONFIRMED'
  | 'OPEN_CRYPTO_PAY_NOT_SETTLED'
  | 'OPEN_CRYPTO_PAY_REJECTED'
  | 'OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT'
  | 'OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE'
  | 'OPEN_CRYPTO_PAY_QUOTE_EXPIRED'
  | 'OPEN_CRYPTO_PAY_AMOUNT_CHANGED'
  | 'OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS'
  | 'LNURL_PLAIN'
  | 'INVALID_LINK'
  | 'INVOICE';

/** Everything one run of the flow saw, for assertions and failure messages. */
export interface WalletRun {
  outcome: WalletOutcome;
  payment?: OcpPayment;
  options?: RailOption[];
  rail?: RailResult;
  sentHash?: string;
  bundle?: { userOpHash: string; receipt: { hash?: string; transactionHash?: string } };
  attempts: AttemptLog[];
  polls: Array<{ kind: string; saleId: string | null }>;
  plain?: Record<string, unknown>;
  detail?: string;
}

/** Options of {@link TetherWallet.pay}. */
export interface PayOptions {
  /** Rail id of {@link OPEN_CRYPTO_PAY_RAILS} the payer picks. */
  railId: string;
  /** Called after the pay request and before the detail; lets a test wait for a quote to expire. */
  beforeDetail?: (payment: OcpPayment) => Promise<void>;
  /** Called after the detail and before sending; lets a test wait or change state. */
  beforeSend?: (rail: Extract<RailResult, { kind: 'transfer' }>) => Promise<void>;
  /** Units the payer actually sends; default the URI amount. */
  amountOverride?: bigint;
}

/** The port of the wallet's OpenCryptoPay flow. */
export class TetherWallet {
  constructor(
    private readonly http: WalletHttp,
    private readonly bundler: WalletBundler,
    private readonly clock: WalletClock = REAL_CLOCK,
    /** USDT balance in units per network; the wallet asks for a detail only when it covers the amount. */
    private readonly balances: Readonly<Record<string, bigint>> = {
      ethereum: 10n ** 12n,
      polygon: 10n ** 12n,
      arbitrum: 10n ** 12n,
    },
  ) {}

  /** Scan a QR text and fetch the pay request. */
  async scan(
    text: string,
  ): Promise<{ url: string; result: PayRequestResult } | { url: null; result: null }> {
    const link = parseOpenCryptoPayLink(text);
    if (link === null) {
      return { url: null, result: null };
    }
    return { url: link.url, result: await getOpenCryptoPayPayment(this.http, link.url) };
  }

  /**
   * Scan, pick `railId`, fetch the detail, pay, prove, and wait for
   * settlement, ending on the screen the wallet would show.
   */
  async pay(sticker: string, options: PayOptions): Promise<WalletRun> {
    const run: WalletRun = { outcome: 'INVALID_LINK', attempts: [], polls: [] };
    const scanned = await this.scan(sticker);
    if (scanned.url === null) {
      return run;
    }
    const result = scanned.result;
    if (result.kind === 'no-pending-payment') {
      run.outcome = 'OPEN_CRYPTO_PAY_NO_PENDING_PAYMENT';
      return run;
    }
    if (result.kind === 'not-found') {
      return run;
    }
    if (result.kind === 'lnurl') {
      run.outcome = 'LNURL_PLAIN';
      run.plain = result.body;
      return run;
    }
    run.payment = result.payment;
    run.options = listOpenCryptoPayOptions(result.payment);
    const rail = OPEN_CRYPTO_PAY_RAILS.find((candidate) => candidate.id === options.railId);
    if (rail === undefined) {
      throw new Error(`unknown rail ${options.railId}`);
    }
    // The payer may only pick a rail the screen lists; a test that forces an
    // unlisted rail still runs the detail request, which is what the api sees
    // from a wallet whose list is stale.
    const option = run.options.find((candidate) => candidate.rail.id === rail.id);
    if (option !== undefined && rail.proof === 'tx') {
      const units = advertisedUnits(option.amount);
      const balance = this.balances[rail.networkName] ?? 0n;
      if (units === null || balance < units) {
        run.outcome = 'OPEN_CRYPTO_PAY_INSUFFICIENT_FUNDS';
        return run;
      }
    }
    if (options.beforeDetail !== undefined) {
      await options.beforeDetail(result.payment);
    }
    const resolved = await resolveOpenCryptoPayRail(this.http, scanned.url, result.payment, rail);
    run.rail = resolved;
    if (resolved.kind === 'error') {
      run.outcome =
        resolved.error === 'QUOTE_EXPIRED'
          ? 'OPEN_CRYPTO_PAY_QUOTE_EXPIRED'
          : 'OPEN_CRYPTO_PAY_RAIL_UNAVAILABLE';
      run.detail = resolved.detail;
      return run;
    }
    if (resolved.kind === 'invoice') {
      run.outcome = 'INVOICE';
      return run;
    }
    if (options.beforeSend !== undefined) {
      await options.beforeSend(resolved);
    }
    // Send: the amount the payer confirmed must still match the URI, and the
    // deadline (earlier of quote.expiration and expiryDate) must not have passed.
    const confirmed = option === undefined ? null : advertisedUnits(option.amount);
    if (confirmed !== null && confirmed !== resolved.amountSmallest) {
      run.outcome = 'OPEN_CRYPTO_PAY_AMOUNT_CHANGED';
      run.detail = `advertised ${String(confirmed)} uri ${String(resolved.amountSmallest)}`;
      return run;
    }
    if (resolved.deadline !== null && this.clock.now() >= Date.parse(resolved.deadline)) {
      run.outcome = 'OPEN_CRYPTO_PAY_QUOTE_EXPIRED';
      run.detail = 'deadline passed before sending';
      return run;
    }
    const bundle = await this.bundler.transfer({
      chainId: resolved.chainId,
      token: resolved.token,
      recipient: resolved.recipient,
      amount: options.amountOverride ?? resolved.amountSmallest,
    });
    run.bundle = bundle;
    run.sentHash = proofHash(bundle);
    const submitted = await submitWithRetries(
      this.http,
      this.clock,
      resolved.proof,
      run.sentHash,
      run.attempts,
    );
    if (submitted === null) {
      // Only a background run could still prove it; the screen says not settled.
      run.outcome = 'OPEN_CRYPTO_PAY_NOT_SETTLED';
      return run;
    }
    if (submitted.kind === 'rejected') {
      run.outcome = 'OPEN_CRYPTO_PAY_REJECTED';
      run.detail = submitted.message;
      return run;
    }
    const settled = await waitForSettlement(this.http, this.clock, resolved.proof, run.polls);
    run.outcome = settled === 'settled' ? 'OPEN_CRYPTO_PAY_SETTLED' : 'OPEN_CRYPTO_PAY_UNCONFIRMED';
    return run;
  }

  /**
   * Plain LNURL path (10 s): pay `amountSats` through the LUD-06 callback.
   * A fixed request (`minSendable === maxSendable`) takes its own amount;
   * an amount outside the bounds is `LNURL_AMOUNT_RANGE`.
   */
  async payPlainLnurl(
    body: Record<string, unknown>,
    amountSats: number | null,
  ): Promise<{ kind: 'invoice'; pr: string; amountMsat: number } | { kind: 'LNURL_AMOUNT_RANGE' }> {
    const min = Number(body['minSendable']);
    const max = Number(body['maxSendable']);
    const msat = min === max ? min : (amountSats ?? 0) * 1000;
    if (!(msat >= min && msat <= max)) {
      return { kind: 'LNURL_AMOUNT_RANGE' };
    }
    const callback = String(body['callback']);
    const answer = await this.http.get(
      withQuery(callback, { amount: String(msat) }),
      LNURL_TIMEOUT_MS,
    );
    const pr = isRecord(answer.body) ? answer.body['pr'] : undefined;
    if (answer.status !== 200 || typeof pr !== 'string') {
      throw new Error(`lnurl callback: HTTP ${answer.status}`);
    }
    return { kind: 'invoice', pr, amountMsat: msat };
  }
}
