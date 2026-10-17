/**
 * Shop payment in USDT and USDC (`docs/shop-stablecoin-payment.md`):
 * the method table, amounts, the OpenCryptoPay pay request and error body,
 * offer checks, the creation procedure, quote replacement, the pay link,
 * the callback, the wait route, the till hooks, settlement, and the proof
 * state rules.
 *
 * Every row change goes through {@link ShopPaymentStore.transaction}. Every
 * external call (LNURL server, Orchestra, EVM RPC) runs outside a database
 * transaction.
 */

import type { AuthStore, Account } from '@/lib/auth/store';
import { bolt11ExpiresAtMs, decodeBolt11 } from '@/lib/bolt11';
import type { LnurlServerConfig, ShopPaymentConfig } from '@/lib/config';
import { erc20TransferData, parseErc20TransferData, recommendedMinFee } from '@/lib/evm-transfer';
import { evmGasPrice } from '@/lib/evm-rpc';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent, type LogFields } from '@/lib/log';
import type {
  OrchestraClient,
  OrchestraQuote,
  OrchestraRouteAsset,
} from '@/lib/orchestra';
import {
  ORCHESTRA_FINAL_STATUSES,
  ORCHESTRA_PROGRESSING_STATUSES,
} from '@/lib/orchestra';
import type { PosCharge } from '@/lib/pos-charge';
import { lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import type {
  ShopAsset,
  ShopEndReason,
  ShopOffer,
  ShopPayment,
  ShopPaymentStore,
  ShopProof,
  ShopProofPatch,
  ShopProofResult,
  ShopQuote,
  ShopTransferAmount,
  ShopTx,
} from '@/lib/shop-payment-store';
import { normalizeUuid } from '@/lib/uuid';
import { WAIT_SATS_POLL_MS } from '@/routes/messages';

// ─── Lifetimes ────────────────────────────────────────────────────────────

/** Window of a payer-opened payment (the charge TTL, five minutes). */
export const SHOP_WINDOW_MS = 5 * 60_000;
/** A transfer sent at `quote.expiration` has this long before Orchestra's `expiresAt`. */
export const SHOP_FUNDING_MARGIN_MS = 30_000;
/** A fetch replaces a quote with less than this left, and never in the window's last stretch. */
export const SHOP_REPLACE_BEFORE_MS = 45_000;
/** Replacements per payment. */
export const SHOP_MAX_REPLACEMENTS = 4;
/** An offer commits only when the BOLT11 outlives its `expiresAt` by this much. */
export const SHOP_BOLT11_MARGIN_MS = 600_000;
/** The final settlement read runs this long after the BOLT11 expiry. */
export const SHOP_FINAL_SETTLE_DELAY_MS = 10 * 60_000;
/** An offer with an issued detail is checked for an order until this long after its `expiresAt`. */
export const SHOP_ORDER_WATCH_MS = 30 * 60_000;
/** An unresolved proof becomes `stuck` this long after it was stored. */
export const SHOP_UNRESOLVED_LIMIT_MS = 24 * 60 * 60_000;
/** Budget of the creation procedure: route list, mint, quotes. */
export const SHOP_ROUTES_TIMEOUT_MS = 1_000;
/** Mint budget inside the creation procedure (both LNURL calls). */
export const SHOP_MINT_TIMEOUT_MS = 4_000;
/** Quote budget inside the creation procedure (gas prices and Orchestra quotes). */
export const SHOP_QUOTES_TIMEOUT_MS = 3_000;
/** Whole creation procedure. */
export const SHOP_CREATION_BUDGET_MS =
  SHOP_ROUTES_TIMEOUT_MS + SHOP_MINT_TIMEOUT_MS + SHOP_QUOTES_TIMEOUT_MS;
/** Whole replacement (route list and quotes). */
export const SHOP_REPLACEMENT_BUDGET_MS = 4_000;
/** After a creation with no committed pair, the account's next creation waits this long. */
export const SHOP_NO_PAIR_WAIT_MS = 60_000;
/** Largest honoured `timeout` on the pay link, in seconds. */
export const SHOP_MAX_TIMEOUT_SECONDS = 10;
/** Pay-link requests that may wait at the same time in one process. */
export const SHOP_MAX_WAITING_REQUESTS = 50;
/** Creations one account may start per minute. */
export const SHOP_ACCOUNT_CREATIONS_PER_MINUTE = 10;
/** Creations the api may start per minute. */
export const SHOP_API_CREATIONS_PER_MINUTE = 60;
/** Spot quotes older than this are not used for the price check. */
export const SHOP_SPOT_MAX_AGE_MS = 10 * 60_000;
/** Settlement reads every 5 s for this long after creation, then every 30 s. */
export const SHOP_FAST_SETTLE_MS = 15 * 60_000;

// ─── Method table ─────────────────────────────────────────────────────────

/** One row of the method table. */
export interface ShopMethod {
  /** OpenCryptoPay method name, as written in responses. */
  method: string;
  /** EVM chain id. */
  chainId: number;
  /** Orchestra `sourceChain`. */
  sourceChain: string;
  /** Token contract per asset, lowercase. */
  contracts: Readonly<Record<ShopAsset, string>>;
  /** Token decimals of both assets. */
  decimals: number;
}

/** The method table of the contract. Adding a method is a change to this table and its tests. */
export const SHOP_METHODS: readonly ShopMethod[] = [
  {
    method: 'Ethereum',
    chainId: 1,
    sourceChain: 'ethereum',
    contracts: {
      USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
    decimals: 6,
  },
  {
    method: 'Arbitrum',
    chainId: 42161,
    sourceChain: 'arbitrum',
    contracts: {
      USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    },
    decimals: 6,
  },
  {
    method: 'Optimism',
    chainId: 10,
    sourceChain: 'optimism',
    contracts: {
      USDT: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
      USDC: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    },
    decimals: 6,
  },
  {
    method: 'Polygon',
    chainId: 137,
    sourceChain: 'polygon',
    contracts: {
      USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    },
    decimals: 6,
  },
  {
    method: 'Base',
    chainId: 8453,
    sourceChain: 'base',
    contracts: {
      USDT: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
      USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    },
    decimals: 6,
  },
  {
    method: 'BinanceSmartChain',
    chainId: 56,
    sourceChain: 'bsc',
    contracts: {
      USDT: '0x55d398326f99059ff775485246999027b3197955',
      USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    },
    decimals: 18,
  },
];

/** The assets of the table, USDT first. */
export const SHOP_ASSETS: readonly ShopAsset[] = ['USDT', 'USDC'];

/** One method and asset of the table. */
export interface ShopPair {
  /** The table row. */
  method: ShopMethod;
  /** `USDT` or `USDC`. */
  asset: ShopAsset;
}

/**
 * Pairs in request order: USDT on `Ethereum`, `Arbitrum`, and `Polygon`
 * first (what Tether Wallet 1.11.0 pays), then the remaining pairs in table
 * order, USDT before USDC within a method.
 *
 * @returns Every pair of the table, in request order.
 */
export function shopPairOrder(): ShopPair[] {
  const first = ['Ethereum', 'Arbitrum', 'Polygon'];
  const ordered: ShopPair[] = [];
  for (const name of first) {
    const method = SHOP_METHODS.find((row) => row.method === name);
    /* v8 ignore next 3 -- the three names are rows of the constant table */
    if (method === undefined) {
      continue;
    }
    ordered.push({ method, asset: 'USDT' });
  }
  for (const method of SHOP_METHODS) {
    for (const asset of SHOP_ASSETS) {
      if (!ordered.some((pair) => pair.method === method && pair.asset === asset)) {
        ordered.push({ method, asset });
      }
    }
  }
  return ordered;
}

/**
 * The table row of a method name, matched without regard to case.
 *
 * @param name - Method name from a request.
 * @returns The row, or `undefined`.
 */
export function shopMethodByName(name: string): ShopMethod | undefined {
  const lower = name.toLowerCase();
  return SHOP_METHODS.find((row) => row.method.toLowerCase() === lower);
}

/**
 * Pairs that a quote may request: in the table, named by Orchestra's route
 * list with `exactOutTo` admitting `lightning:BTC`, the table contract and
 * decimals, and an RPC endpoint for the chain. A route-list pair whose
 * contract or decimals differ from the table logs `shop.route.mismatch`.
 *
 * @param routes - Orchestra route list.
 * @param evmRpc - Configured RPC endpoints by chain id.
 * @returns Candidate pairs in request order.
 */
export function candidatePairs(
  routes: readonly OrchestraRouteAsset[],
  evmRpc: ReadonlyMap<number, string>,
): ShopPair[] {
  const candidates: ShopPair[] = [];
  for (const pair of shopPairOrder()) {
    const route = routes.find(
      (asset) => asset.chain === pair.method.sourceChain && asset.asset === pair.asset,
    );
    if (route === undefined) {
      continue;
    }
    if (
      route.contractAddress !== pair.method.contracts[pair.asset] ||
      route.decimals !== pair.method.decimals
    ) {
      logEvent('shop.route.mismatch', { method: pair.method.method, asset: pair.asset });
      continue;
    }
    if (!route.exactOutToLightning || !evmRpc.has(pair.method.chainId)) {
      continue;
    }
    candidates.push(pair);
  }
  return candidates;
}

// ─── Amounts and bodies ───────────────────────────────────────────────────

/**
 * Decimal string of `units / 10^decimals`, built from integers: no
 * exponent, no trailing zero after the point, no point for a whole number.
 *
 * @param units - Non-negative integer amount in base units.
 * @param decimals - Decimal places of the unit.
 * @returns For example `0.00001`, `1.5`, or `12`.
 */
export function decimalAmount(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Bitcoin amount of a sat count (`sats / 100000000`) as a plain decimal string.
 *
 * @param sats - Whole sats.
 * @returns For example `0.00001`.
 */
export function btcAmount(sats: number): string {
  return decimalAmount(BigInt(sats), 8);
}

/** Marker for a JSON number that {@link shopJson} writes in plain notation. */
export class PlainJsonNumber {
  /** The number's digits, already in plain notation. */
  readonly text: string;

  /**
   * @param text - Digits in plain notation, for example `0.00000001`.
   */
  constructor(text: string) {
    this.text = text;
  }
}

/**
 * Serialise a response body; every {@link PlainJsonNumber} becomes a JSON
 * number written as its plain digits (never `1e-8`).
 *
 * @param body - Response body.
 * @returns JSON text.
 */
export function shopJson(body: unknown): string {
  const text = JSON.stringify(body, (_key, value: unknown) =>
    value instanceof PlainJsonNumber ? `\u0000plain:${value.text}\u0000` : value,
  );
  return text.replace(/"\\u0000plain:([0-9.]+)\\u0000"/g, '$1');
}

/** Response headers of the pay link and the LNURL shop routes. */
export const SHOP_LNURL_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

/**
 * JSON response for the shop LNURL routes.
 *
 * @param body - Response body.
 * @param status - HTTP status.
 * @returns The response with the shop LNURL headers.
 */
export function shopResponse(body: unknown, status: number): Response {
  return new Response(shopJson(body), {
    status,
    headers: { ...SHOP_LNURL_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** The one error body of the callback, proof, wait route, and new pay-link errors. */
export interface ShopErrorBody {
  /** HTTP status. */
  statusCode: number;
  /** Text (DFX-built wallets and Tether read it). */
  message: string;
  /** Text (this repository's clients read it). */
  error: string;
  /** Always `ERROR` (LUD-06). */
  status: 'ERROR';
  /** Text (LUD-06). */
  reason: string;
}

/**
 * Build the shared error body.
 *
 * @param statusCode - HTTP status.
 * @param text - Error text.
 * @returns `{ statusCode, message, error, status: 'ERROR', reason }`.
 */
export function shopErrorBody(statusCode: number, text: string): ShopErrorBody {
  return { statusCode, message: text, error: text, status: 'ERROR', reason: text };
}

/**
 * Error response with the shared body.
 *
 * @param statusCode - HTTP status.
 * @param text - Error text.
 * @returns The response.
 */
export function shopError(statusCode: number, text: string): Response {
  return shopResponse(shopErrorBody(statusCode, text), statusCode);
}

/**
 * The standard's 404 for no pending payment.
 *
 * @param username - Pay-link username.
 * @param name - Shop name.
 * @returns The body of the standard's example.
 */
export function noPendingPaymentBody(username: string, name: string): Record<string, unknown> {
  return {
    id: username,
    displayName: name,
    standard: 'OpenCryptoPay',
    possibleStandards: ['OpenCryptoPay'],
    displayQr: false,
    recipient: { name },
    statusCode: 404,
    message: 'No pending payment found',
    error: 'Not Found',
    status: 'ERROR',
    reason: 'No pending payment found',
  };
}

/**
 * Whether a username never gets stablecoin rows: `invoice` and `cb`
 * collide with the invoice forward and Tether's `cb` → `tx` rewrite, and a
 * final `.` is cut off a hint URL by Tether.
 *
 * @param username - Stored username.
 * @returns `true` for `invoice`, `cb`, or a name ending in `.`.
 */
export function isExcludedShopUsername(username: string): boolean {
  return username === 'invoice' || username === 'cb' || username.endsWith('.');
}

/**
 * The Lightning entry of `transferAmounts`.
 *
 * @param sats - Payment sats.
 * @returns `{ method: 'Lightning', minFee: 0, assets: [BTC], available: true }`.
 */
export function lightningTransferAmount(sats: number): ShopTransferAmount {
  return {
    method: 'Lightning',
    minFee: 0,
    assets: [{ asset: 'BTC', amount: btcAmount(sats) }],
    available: true,
  };
}

/**
 * `transferAmounts` of a quote: Lightning first, then each offered method
 * in table order, USDT before USDC inside a method.
 *
 * @param sats - Payment sats.
 * @param offers - Offers stored on the quote.
 * @returns The array the quote serves.
 */
export function transferAmountsFor(
  sats: number,
  offers: readonly ShopOffer[],
): ShopTransferAmount[] {
  const amounts: ShopTransferAmount[] = [lightningTransferAmount(sats)];
  for (const method of SHOP_METHODS) {
    const ofMethod = SHOP_ASSETS.flatMap((asset) =>
      offers.filter((offer) => offer.method === method.method && offer.asset === asset),
    );
    const first = ofMethod[0];
    if (first === undefined) {
      continue;
    }
    amounts.push({
      method: method.method,
      minFee: Number(first.minFee),
      assets: ofMethod.map((offer) => ({
        asset: offer.asset,
        amount: decimalAmount(BigInt(offer.amountIn), offer.decimals),
      })),
      available: true,
    });
  }
  return amounts;
}

/**
 * `quote.expiration`: with offers, the earliest of `window_ends_at` and
 * every offer's `expiresAt` minus the funding margin; Lightning-only,
 * `window_ends_at`.
 *
 * @param windowEndsAt - Payment window end.
 * @param offers - Offers of the quote.
 * @returns The expiry instant.
 */
export function quoteExpiration(windowEndsAt: Date, offers: readonly ShopOffer[]): Date {
  let expires = windowEndsAt.getTime();
  for (const offer of offers) {
    expires = Math.min(expires, offer.expiresAt.getTime() - SHOP_FUNDING_MARGIN_MS);
  }
  return new Date(expires);
}

/**
 * The EIP-681 URI of an offer's detail.
 *
 * @param offer - Stored offer.
 * @returns `ethereum:<token>@<chainId>/transfer?address=<deposit>&uint256=<amountIn>`.
 */
export function offerUri(offer: ShopOffer): string {
  return `ethereum:${offer.tokenAddress}@${offer.chainId}/transfer?address=${offer.depositAddress}&uint256=${offer.amountIn}`;
}

/**
 * Proof URL of a username.
 *
 * @param publicBaseUrl - `PUBLIC_BASE_URL` without a trailing slash.
 * @param username - Pay-link username.
 * @returns `<PUBLIC_BASE_URL>/lnurlp/tx/<username>`.
 */
export function proofUrl(publicBaseUrl: string, username: string): string {
  return `${publicBaseUrl}/lnurlp/tx/${username}`;
}

/**
 * The stablecoin detail of an offer.
 *
 * @param offer - Stored offer.
 * @param quote - Its quote.
 * @param publicBaseUrl - `PUBLIC_BASE_URL`.
 * @param username - Pay-link username.
 * @returns `{ expiryDate, blockchain, uri, hint }`.
 */
export function offerDetail(
  offer: ShopOffer,
  quote: ShopQuote,
  publicBaseUrl: string,
  username: string,
): { expiryDate: string; blockchain: string; uri: string; hint: string } {
  return {
    expiryDate: quote.expiresAt.toISOString(),
    blockchain: offer.method,
    uri: offerUri(offer),
    hint: `Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to ${proofUrl(publicBaseUrl, username)}`,
  };
}

/** Fields of the pay request for an open amount. */
export interface ShopPayRequestInput {
  /** Pay-link username. */
  username: string;
  /** Shop name (`GET /pay/:username`). */
  name: string;
  /** Metadata of today's pay request, unchanged. */
  metadata: string;
  /** `PUBLIC_BASE_URL`. */
  publicBaseUrl: string;
  /** The open payment. */
  payment: ShopPayment;
  /** Its current quote. */
  quote: ShopQuote;
}

/**
 * The OpenCryptoPay pay request of an open amount. The table of the
 * contract is the complete body.
 *
 * @param input - Username, name, metadata, base URL, payment, and quote.
 * @returns The body; serialise it with {@link shopJson}.
 */
export function shopPayRequest(input: ShopPayRequestInput): Record<string, unknown> {
  const millisats = input.payment.amountSats * 1000;
  return {
    id: input.username,
    tag: 'payRequest',
    callback: `${input.publicBaseUrl}/lnurlp/cb/${input.username}`,
    minSendable: millisats,
    maxSendable: millisats,
    metadata: input.metadata,
    displayName: input.name,
    standard: 'OpenCryptoPay',
    possibleStandards: ['OpenCryptoPay'],
    displayQr: false,
    recipient: { name: input.name },
    quote: {
      id: input.quote.id,
      expiration: input.quote.expiresAt.toISOString(),
      payment: input.payment.id,
    },
    requestedAmount: { asset: 'BTC', amount: new PlainJsonNumber(btcAmount(input.payment.amountSats)) },
    transferAmounts: input.quote.transferAmounts,
  };
}

/**
 * Shop display name: the trimmed account name, else the username (as
 * `GET /pay/:username`).
 *
 * @param account - Shop account.
 * @param username - Its username.
 * @returns The name.
 */
export function shopName(account: Pick<Account, 'name'>, username: string): string {
  const trimmed = account.name?.trim() ?? '';
  return trimmed === '' ? username : trimmed;
}

// ─── Offer checks ─────────────────────────────────────────────────────────

/** Why a committed Orchestra quote is not offered (logged as `check`). */
export type OfferCheck =
  | 'target'
  | 'amount'
  | 'bounds'
  | 'chain'
  | 'token'
  | 'value'
  | 'data'
  | 'deposit_shared'
  | 'expiry'
  | 'bolt11_margin'
  | 'price';

/** Inputs of {@link checkOffer}. */
export interface OfferCheckInput {
  /** The pair. */
  pair: ShopPair;
  /** Orchestra quote. */
  quote: OrchestraQuote;
  /** Payment sats. */
  amountSats: number;
  /** BOLT11 expiry (epoch ms). */
  bolt11ExpiresAtMs: number;
  /** Deposit addresses already used in this batch. */
  batchDeposits: ReadonlySet<string>;
  /** USD per BTC from a spot quote younger than ten minutes, or `null`. */
  usdPerBtc: string | null;
  /** Clock (epoch ms). */
  nowMs: number;
}

/** Positive integer string. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Whether `amountIn` in USD is at most 5 % above the sats' value at
 * `usdPerBtc` (stablecoins count one unit as one dollar).
 *
 * @param amountIn - Base units.
 * @param decimals - Token decimals.
 * @param sats - Payment sats.
 * @param usdPerBtc - Decimal string.
 * @returns `true` when within the bound.
 */
function withinPriceBound(amountIn: bigint, decimals: number, sats: number, usdPerBtc: string): boolean {
  const point = usdPerBtc.indexOf('.');
  const fraction = point === -1 ? '' : usdPerBtc.slice(point + 1);
  const rate = BigInt(point === -1 ? usdPerBtc : `${usdPerBtc.slice(0, point)}${fraction}`);
  const rateScale = 10n ** BigInt(fraction.length);
  // amountIn / 10^d <= 1.05 * sats / 1e8 * rate / rateScale
  const left = amountIn * 100_000_000n * 100n * rateScale;
  const right = 105n * BigInt(sats) * rate * 10n ** BigInt(decimals);
  return left <= right;
}

/**
 * Apply the offer checks of the contract to one committed Orchestra quote.
 *
 * @param input - Pair, quote, sats, BOLT11 expiry, batch deposits, spot, clock.
 * @returns `null` when every check holds, otherwise the failed check.
 */
export function checkOffer(input: OfferCheckInput): OfferCheck | null {
  const { quote, pair } = input;
  if (quote.targetAmountOut !== String(input.amountSats)) {
    return 'target';
  }
  if (!POSITIVE_INTEGER.test(quote.amountIn)) {
    return 'amount';
  }
  const amountIn = BigInt(quote.amountIn);
  if (
    (quote.requiredAmountIn !== null &&
      (!/^[0-9]+$/.test(quote.requiredAmountIn) || amountIn < BigInt(quote.requiredAmountIn))) ||
    (quote.maxAcceptedAmountIn !== null &&
      (!/^[0-9]+$/.test(quote.maxAcceptedAmountIn) ||
        amountIn > BigInt(quote.maxAcceptedAmountIn)))
  ) {
    return 'bounds';
  }
  const transaction = quote.transaction;
  if (transaction === null || transaction.chainId !== pair.method.chainId) {
    return 'chain';
  }
  if (transaction.to.toLowerCase() !== pair.method.contracts[pair.asset]) {
    return 'token';
  }
  if (!/^(0x)?0+$/i.test(transaction.value)) {
    return 'value';
  }
  const transfer = parseErc20TransferData(transaction.data);
  const deposit = quote.depositAddress.toLowerCase();
  if (
    transfer === null ||
    transfer.recipient !== deposit ||
    transfer.amount !== amountIn ||
    transaction.data.toLowerCase() !== erc20TransferData(deposit, amountIn)
  ) {
    return 'data';
  }
  if (input.batchDeposits.has(deposit)) {
    return 'deposit_shared';
  }
  const expiresAtMs = Date.parse(quote.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs - SHOP_FUNDING_MARGIN_MS - input.nowMs < SHOP_REPLACE_BEFORE_MS
  ) {
    return 'expiry';
  }
  if (input.bolt11ExpiresAtMs - expiresAtMs < SHOP_BOLT11_MARGIN_MS) {
    return 'bolt11_margin';
  }
  if (
    input.usdPerBtc !== null &&
    !withinPriceBound(amountIn, pair.method.decimals, input.amountSats, input.usdPerBtc)
  ) {
    return 'price';
  }
  return null;
}

// ─── Proof state rules ────────────────────────────────────────────────────

/** Results a proof may move to `accepted` or `superseded` from on a progressing order. */
const OPEN_RESULTS: readonly (ShopProofResult | null)[] = [null, 'refused', 'stuck'];

/** Final order status → proof result. */
const FINAL_RESULT: Readonly<Record<string, ShopProofResult>> = {
  completed: 'accepted',
  refunded: 'refunded',
  failed: 'failed',
  fallback_delivered: 'failed',
  expired: 'refused',
};

/** Results a final status may move a proof from, per target (the States table). */
const FINAL_FROM: Readonly<Record<ShopProofResult, readonly (ShopProofResult | null)[]>> = {
  accepted: ['superseded', 'late', 'refused', 'stuck', null],
  refunded: ['accepted', 'superseded', 'late', 'refused', 'stuck', null],
  failed: ['accepted', 'superseded', 'late', 'refused', 'stuck', null],
  refused: ['accepted', 'superseded', 'late', 'stuck', null],
  superseded: [],
  late: [],
  stuck: [],
};

/** End reason of an `accepted` payment whose accepted proof left `accepted`. */
const LOSS_REASON: Readonly<Partial<Record<ShopProofResult, ShopEndReason>>> = {
  refunded: 'orchestra_refunded',
  failed: 'orchestra_failed',
  refused: 'proof_refused',
};

/**
 * Whether a proof's transferred value lies within its offer's bounds:
 * `requiredAmountIn` (or `amountIn`) up to `maxAcceptedAmountIn` (or `amountIn`).
 *
 * @param proof - Stored proof.
 * @param offer - Its offer.
 * @returns `false` while the value is unknown.
 */
export function proofWithinBounds(proof: ShopProof, offer: ShopOffer): boolean {
  if (proof.transferAmount === null) {
    return false;
  }
  const value = BigInt(proof.transferAmount);
  const lower = BigInt(offer.requiredAmountIn ?? offer.amountIn);
  const upper = BigInt(offer.maxAcceptedAmountIn ?? offer.amountIn);
  return value >= lower && value <= upper;
}

/**
 * Log one shop event (never a key, an RPC URL, raw hex, or a BOLT11).
 *
 * @param event - Event name.
 * @param fields - Ids that apply.
 */
function shopLog(event: string, fields: LogFields): void {
  logEvent(event, fields);
}

/**
 * Move a payment to `accepted` from `open` or `ended` (not closed).
 *
 * @param tx - Transaction.
 * @param payment - Locked payment.
 * @param nowMs - Clock.
 */
async function acceptPayment(tx: ShopTx, payment: ShopPayment, nowMs: number): Promise<void> {
  const moved = await tx.updatePayment(
    payment.id,
    { statuses: ['open', 'ended'], notClosed: true },
    { status: 'accepted', acceptedAt: new Date(nowMs), endedAt: null, endReason: null },
  );
  if (moved !== null) {
    shopLog('shop.payment.accepted', { paymentId: payment.id });
  }
}

/**
 * Re-evaluate one proof after its order status, value, or payment changed
 * ([States] of the contract). Runs inside `tx`; the caller has locked the
 * account of the payment.
 *
 * @param tx - Transaction.
 * @param proofId - Proof id.
 * @param nowMs - Clock.
 * @returns The proof as it is now, or `null` when it does not exist.
 */
export async function evaluateProof(
  tx: ShopTx,
  proofId: string,
  nowMs: number,
): Promise<ShopProof | null> {
  const proof = await tx.getProof(proofId);
  if (proof === null) {
    return null;
  }
  const payment = await tx.lockPayment(proof.paymentId);
  const offer = await tx.getOffer(proof.offerId);
  /* v8 ignore next 3 -- foreign keys keep both rows */
  if (payment === null || offer === null) {
    return proof;
  }
  const status = proof.orderStatus;
  const ids = { paymentId: payment.id, proofId: proof.id, offerId: offer.id };
  if (status !== null && ORCHESTRA_FINAL_STATUSES.has(status)) {
    const target = FINAL_RESULT[status];
    /* v8 ignore next 3 -- every final status has a row in FINAL_RESULT */
    if (target === undefined || proof.result === target) {
      return proof;
    }
    if (!FINAL_FROM[target].includes(proof.result)) {
      return proof;
    }
    if (target === 'accepted') {
      for (const other of await tx.proofsOf(payment.id)) {
        if (other.id !== proof.id && other.result === 'accepted') {
          await tx.updateProof(other.id, { results: ['accepted'] }, { result: 'superseded', resolvedAt: new Date(nowMs) });
          shopLog('shop.proof.superseded', { paymentId: payment.id, proofId: other.id });
        }
      }
      const updated = await tx.updateProof(
        proof.id,
        { results: ['superseded', 'late', 'refused', 'stuck', null] },
        { result: 'accepted', refusal: null, resolvedAt: new Date(nowMs) },
      );
      if (updated !== null && updated !== 'conflict') {
        shopLog('shop.proof.accepted', ids);
        await acceptPayment(tx, payment, nowMs);
        return updated;
      }
      return tx.getProof(proof.id);
    }
    const patch: ShopProofPatch = { result: target, resolvedAt: new Date(nowMs) };
    if (target === 'refused') {
      patch.refusal = 'expired_order';
    }
    const updated = await tx.updateProof(proof.id, { results: FINAL_FROM[target] }, patch);
    /* v8 ignore next 3 -- the row is locked through its payment and its result was just checked */
    if (updated === null || updated === 'conflict') {
      return tx.getProof(proof.id);
    }
    shopLog(`shop.proof.${target}`, ids);
    if (target === 'failed') {
      shopLog('shop.alert.order_failed', ids);
    }
    if (proof.result === 'accepted') {
      await paymentLostAcceptance(tx, payment.id, target, nowMs);
    }
    return updated;
  }
  if (
    status === null ||
    !ORCHESTRA_PROGRESSING_STATUSES.has(status) ||
    !OPEN_RESULTS.includes(proof.result)
  ) {
    return proof;
  }
  if (payment.closedAt !== null) {
    const late = await tx.updateProof(proof.id, { results: OPEN_RESULTS }, { result: 'late', resolvedAt: new Date(nowMs) });
    shopLog('shop.proof.late', ids);
    shopLog('shop.alert.late_deposit', ids);
    /* v8 ignore next -- the row is locked through its payment */
    return late === 'conflict' ? proof : late;
  }
  if (payment.status === 'paid' || !proofWithinBounds(proof, offer)) {
    return proof;
  }
  const others = await tx.proofsOf(payment.id);
  const taken = others.some((other) => other.id !== proof.id && other.result === 'accepted');
  if (!taken) {
    const accepted = await tx.updateProof(
      proof.id,
      { results: OPEN_RESULTS },
      { result: 'accepted', refusal: null, resolvedAt: new Date(nowMs) },
    );
    if (accepted !== null && accepted !== 'conflict') {
      shopLog('shop.proof.accepted', ids);
      await acceptPayment(tx, payment, nowMs);
      return accepted;
    }
  }
  const superseded = await tx.updateProof(proof.id, { results: OPEN_RESULTS }, { result: 'superseded', resolvedAt: new Date(nowMs) });
  shopLog('shop.proof.superseded', ids);
  /* v8 ignore next -- the row is locked through its payment */
  return superseded === 'conflict' ? proof : superseded;
}

/**
 * The accepted proof of a payment left `accepted`: another proof that may
 * take its place is accepted; otherwise an `accepted` payment ends.
 *
 * @param tx - Transaction.
 * @param paymentId - Payment id.
 * @param result - The result the accepted proof moved to.
 * @param nowMs - Clock.
 */
async function paymentLostAcceptance(
  tx: ShopTx,
  paymentId: string,
  result: ShopProofResult,
  nowMs: number,
): Promise<void> {
  for (const other of await tx.proofsOf(paymentId)) {
    if (OPEN_RESULTS.includes(other.result) && other.orderStatus !== null) {
      const evaluated = await evaluateProof(tx, other.id, nowMs);
      if (evaluated?.result === 'accepted') {
        return;
      }
    }
  }
  const reason = LOSS_REASON[result];
  /* v8 ignore next 3 -- only refunded, failed, and refused leave accepted without completing */
  if (reason === undefined) {
    return;
  }
  const ended = await tx.updatePayment(
    paymentId,
    { statuses: ['accepted'] },
    { status: 'ended', endReason: reason, endedAt: new Date(nowMs) },
  );
  if (ended !== null) {
    shopLog('shop.payment.ended', { paymentId, reason });
  }
}

/** Orders whose unknown status was already logged in this process. */
const UNKNOWN_STATUS_LOGGED = new Set<string>();

/**
 * Whether Orchestra reported a status the api does not know (neither final,
 * progressing, `refunding`, nor `unfulfilled`).
 *
 * @param status - `order.status`.
 * @returns `true` for an unknown status.
 */
function isUnknownOrderStatus(status: string): boolean {
  return (
    !ORCHESTRA_FINAL_STATUSES.has(status) &&
    !ORCHESTRA_PROGRESSING_STATUSES.has(status) &&
    status !== 'refunding' &&
    status !== 'unfulfilled'
  );
}

/**
 * Record a proof `refused` (a `hex` transaction rejected or reverted, or a
 * submit refused with `xchain_deposit_mismatch`), from the results the
 * States table allows, and end an `accepted` payment that loses its only
 * accepted proof. Runs inside `tx` with the payment's account locked.
 *
 * @param tx - Transaction.
 * @param proofId - Proof id.
 * @param refusal - Why it was refused.
 * @param nowMs - Clock.
 * @returns The refused proof, or the unchanged proof when its result does
 *   not allow the move, or `null` when it does not exist.
 */
export async function refuseProof(
  tx: ShopTx,
  proofId: string,
  refusal: 'mismatch' | 'hex_rejected',
  nowMs: number,
): Promise<ShopProof | null> {
  const proof = await tx.getProof(proofId);
  if (proof === null) {
    return null;
  }
  if (!FINAL_FROM.refused.includes(proof.result)) {
    return proof;
  }
  await tx.lockPayment(proof.paymentId);
  const refused = await tx.updateProof(
    proofId,
    { results: FINAL_FROM.refused },
    { result: 'refused', refusal, resolvedAt: new Date(nowMs), nextSubmitAt: null },
  );
  /* v8 ignore next 3 -- the row is locked through its payment and its result was just checked */
  if (refused === null || refused === 'conflict') {
    return tx.getProof(proofId);
  }
  shopLog('shop.proof.refused', { paymentId: proof.paymentId, proofId, refusal });
  if (proof.result === 'accepted') {
    await paymentLostAcceptance(tx, proof.paymentId, 'refused', nowMs);
  }
  return refused;
}

/**
 * Store an Orchestra order on a proof and re-evaluate it.
 *
 * @param tx - Transaction (account of the payment locked).
 * @param proofId - Proof id.
 * @param order - Order id and status.
 * @param nowMs - Clock.
 * @returns The proof after evaluation, or `'conflict'` when another row
 *   already holds that order id (nothing changed).
 */
export async function recordProofOrder(
  tx: ShopTx,
  proofId: string,
  order: { orderId: string; status: string },
  nowMs: number,
): Promise<ShopProof | null | 'conflict'> {
  const proof = await tx.getProof(proofId);
  if (proof === null) {
    return null;
  }
  const patch: ShopProofPatch = {
    providerOrder: order.orderId,
    orderStatus: order.status,
    nextSubmitAt: null,
  };
  if (proof.providerOrder === null) {
    patch.orderFoundAt = new Date(nowMs);
    patch.nextStatusAt = new Date(nowMs + 10_000);
  }
  if (ORCHESTRA_FINAL_STATUSES.has(order.status)) {
    patch.nextStatusAt = null;
  }
  const updated = await tx.updateProof(proofId, {}, patch);
  if (updated === 'conflict') {
    return 'conflict';
  }
  if (isUnknownOrderStatus(order.status) && !UNKNOWN_STATUS_LOGGED.has(order.orderId)) {
    UNKNOWN_STATUS_LOGGED.add(order.orderId);
    shopLog('shop.orchestra.error', {
      paymentId: proof.paymentId,
      proofId,
      orderId: order.orderId,
      reason: 'unknown_status',
      status: order.status,
    });
  }
  return evaluateProof(tx, proofId, nowMs);
}

// ─── Wait and till views ──────────────────────────────────────────────────

/** DFX `PaymentLinkPaymentStatus` of a payment. */
export type DfxPaymentStatus = 'Pending' | 'Completed' | 'Cancelled' | 'Expired';

/**
 * The DFX status of a payment: `Completed` when paid; for an ended and closed
 * payment `Cancelled` (superseded, replaced, cancelled) or `Expired`;
 * otherwise `Pending`.
 *
 * @param payment - Stored payment.
 * @returns The DFX status.
 */
export function dfxPaymentStatus(payment: ShopPayment): DfxPaymentStatus {
  if (payment.status === 'paid') {
    return 'Completed';
  }
  if (payment.status === 'ended' && payment.closedAt !== null) {
    return payment.endReason === 'superseded' ||
      payment.endReason === 'replaced' ||
      payment.endReason === 'cancelled'
      ? 'Cancelled'
      : 'Expired';
  }
  return 'Pending';
}

/**
 * Body of `GET /lnurlp/wait/:payment`.
 *
 * @param payment - Stored payment.
 * @returns `{ status, paymentStatus, invoiceExpiresAt }`.
 */
export function waitBody(payment: ShopPayment): {
  status: DfxPaymentStatus;
  paymentStatus: ShopPayment['status'];
  invoiceExpiresAt: string;
} {
  return {
    status: dfxPaymentStatus(payment),
    paymentStatus: payment.status,
    invoiceExpiresAt: payment.bolt11ExpiresAt.toISOString(),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────

/** Collaborators of {@link ShopPayments}. */
export interface ShopPaymentsDeps {
  /** Shop payment rows (and charge rows through the same transaction). */
  store: ShopPaymentStore;
  /** Accounts by username. */
  auth: AuthStore;
  /** LNURL server (the shop routes exist only while it resolves). */
  lnurlServer: LnurlServerConfig;
  /** Orchestra, RPC, and refund configuration, or `null` when off. */
  config: ShopPaymentConfig | null;
  /** Orchestra client, or `null` when `config` is `null`. */
  orchestra: OrchestraClient | null;
  /** Spot quotes for the price check; omitted → no price check. */
  fxSpot?: FxSpotStore;
  /** Fetch for the LNURL server and the EVM RPC endpoints. */
  fetchImpl: FetchFn;
  /** Clock in epoch milliseconds. */
  now: () => number;
  /** Id source; default `crypto.randomUUID`. */
  newId?: () => string;
  /** Pause; default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Result of the creation procedure. */
export type ShopCreation =
  | { kind: 'payment'; payment: ShopPayment }
  | { kind: 'pending_charge' }
  | { kind: 'unavailable' }
  | { kind: 'mint_failed' }
  | { kind: 'skipped' };

/** What the pay link answers. */
export type ShopPayLinkAnswer =
  | { kind: 'today'; pinSats: number | null }
  | { kind: 'response'; response: Response };

/** Pay-link query values the route read (each `null` when absent). */
export interface ShopPayLinkQuery {
  /** Raw `timeout`, or `null` when the key is absent. */
  timeout: string | null;
  /** `method`, or `null`. */
  method: string | null;
  /** `asset`, or `null`. */
  asset: string | null;
  /** `true` when `quote`, `method`, or `asset` is repeated. */
  repeated: boolean;
}

/** Callback query values (each `null` when absent). */
export interface ShopCallbackQuery {
  /** `amount` in millisats. */
  amount: string | null;
  /** `quote`. */
  quote: string | null;
  /** `method`. */
  method: string | null;
  /** `asset`. */
  asset: string | null;
  /** `true` when a key is repeated. */
  repeated: boolean;
}

/** A pending charge as seen by the pay link, with its shop payment. */
type LinkState =
  | { kind: 'open'; payment: ShopPayment }
  | { kind: 'charge'; charge: PosCharge; payment: ShopPayment | null }
  | { kind: 'none' };

/**
 * Shop payment service: one instance per process, created at boot when the
 * LNURL server resolves. Holds the per-account creation locks, the two
 * creation counters, the no-pair waits, and the cached route list.
 */
export class ShopPayments {
  readonly #deps: ShopPaymentsDeps;
  readonly #newId: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #noPairUntil = new Map<string, number>();
  readonly #apiCreations = new IpRateLimiter(SHOP_API_CREATIONS_PER_MINUTE);
  readonly #accountCreations = new IpRateLimiter(SHOP_ACCOUNT_CREATIONS_PER_MINUTE);
  #routes: { assets: OrchestraRouteAsset[]; untilMs: number } | null = null;
  #waiting = 0;

  /**
   * @param deps - Store, auth, LNURL server, config, Orchestra, spot, fetch, clock.
   */
  constructor(deps: ShopPaymentsDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** The store (routes and the watcher share it). */
  get store(): ShopPaymentStore {
    return this.#deps.store;
  }

  /** The service's collaborators (read-only view for the proof and watcher modules). */
  get deps(): Readonly<ShopPaymentsDeps> {
    return this.#deps;
  }

  /** A fresh UUID. */
  newId(): string {
    return this.#newId();
  }

  /**
   * Whether stablecoin rows can be served for a username: config and
   * Orchestra present, and the username not excluded.
   *
   * @param username - Stored username.
   * @returns `true` when a creation may run.
   */
  offersStablecoins(username: string): boolean {
    return (
      this.#deps.config !== null &&
      this.#deps.orchestra !== null &&
      !isExcludedShopUsername(username)
    );
  }

  /**
   * Run `run` under the account's in-process creation lock. A second caller
   * waits for the first and then runs.
   *
   * @param accountId - Account id.
   * @param run - Work.
   * @returns The work's result.
   */
  async #withLock<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(accountId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(accountId, settled);
    try {
      return await next;
    } finally {
      if (this.#locks.get(accountId) === settled) {
        this.#locks.delete(accountId);
      }
    }
  }

  /**
   * The route list, reused for its `validForMs`; fetched with a 1 s timeout.
   *
   * @param deadlineMs - Absolute deadline for the fetch.
   * @returns Route assets, or `null` when the fetch failed.
   */
  async #routeList(deadlineMs: number): Promise<OrchestraRouteAsset[] | null> {
    const nowMs = this.#deps.now();
    if (this.#routes !== null && nowMs < this.#routes.untilMs) {
      return this.#routes.assets;
    }
    const orchestra = this.#deps.orchestra;
    /* v8 ignore next 3 -- callers check offersStablecoins first */
    if (orchestra === null) {
      return null;
    }
    const timeoutMs = Math.min(SHOP_ROUTES_TIMEOUT_MS, deadlineMs - nowMs);
    if (timeoutMs <= 0) {
      return null;
    }
    const result = await orchestra.routes(timeoutMs);
    if (!result.ok) {
      this.#routes = null;
      return null;
    }
    this.#routes = { assets: result.assets, untilMs: this.#deps.now() + result.validForMs };
    return result.assets;
  }

  /**
   * Request one Orchestra quote per candidate pair (and the gas price of each
   * chain) in parallel until `deadlineMs`, and keep the quotes that pass the
   * offer checks. Pairs beyond the quote budget are skipped in request order.
   *
   * @param pairs - Candidate pairs in request order.
   * @param target - Payment id, sats, BOLT11, and its expiry.
   * @param deadlineMs - Absolute deadline.
   * @returns Offers not yet tied to a quote row (`quoteId` is `''`).
   */
  async #requestOffers(
    pairs: readonly ShopPair[],
    target: { paymentId: string; amountSats: number; bolt11: string; bolt11ExpiresAtMs: number },
    deadlineMs: number,
  ): Promise<ShopOffer[]> {
    const { orchestra, config } = this.#deps;
    /* v8 ignore next 3 -- callers check offersStablecoins first */
    if (orchestra === null || config === null) {
      return [];
    }
    const allowed = pairs.slice(0, Math.max(0, orchestra.quoteBudgetLeft()));
    if (allowed.length === 0) {
      return [];
    }
    const chainIds = [...new Set(allowed.map((pair) => pair.method.chainId))];
    const gasByChain = new Map<number, Promise<bigint | null>>();
    for (const chainId of chainIds) {
      const url = config.evmRpc.get(chainId);
      /* v8 ignore next 3 -- candidatePairs keeps only chains with an endpoint */
      if (url === undefined) {
        continue;
      }
      const timeoutMs = Math.max(1, deadlineMs - this.#deps.now());
      gasByChain.set(
        chainId,
        evmGasPrice(url, this.#deps.fetchImpl, timeoutMs).then((result) =>
          result.ok ? result.value : null,
        ),
      );
    }
    const quotes = await Promise.all(
      allowed.map(async (pair) => {
        const idempotencyKey = this.#newId();
        const result = await orchestra.quote(
          {
            sourceChain: pair.method.sourceChain,
            sourceAsset: pair.asset,
            amountSats: target.amountSats,
            bolt11: target.bolt11,
            tag: target.paymentId,
            refundAddress: config.refundAddress,
          },
          idempotencyKey,
          deadlineMs,
        );
        return { pair, result, idempotencyKey };
      }),
    );
    const spot = await this.#usdPerBtc();
    const offers: ShopOffer[] = [];
    const batchDeposits = new Set<string>();
    for (const { pair, result, idempotencyKey } of quotes) {
      if (!result.ok) {
        continue;
      }
      const nowMs = this.#deps.now();
      const check = checkOffer({
        pair,
        quote: result.quote,
        amountSats: target.amountSats,
        bolt11ExpiresAtMs: target.bolt11ExpiresAtMs,
        batchDeposits,
        usdPerBtc: spot,
        nowMs,
      });
      const fields = { paymentId: target.paymentId, method: pair.method.method, asset: pair.asset };
      if (check !== null) {
        logEvent('shop.offer.rejected', { ...fields, check });
        if (check === 'deposit_shared') {
          logEvent('shop.alert.shared_deposit_address', fields);
        }
        continue;
      }
      const gas = await gasByChain.get(pair.method.chainId);
      if (gas === null || gas === undefined) {
        logEvent('shop.offer.rejected', { ...fields, check: 'gas' });
        continue;
      }
      const deposit = result.quote.depositAddress.toLowerCase();
      batchDeposits.add(deposit);
      offers.push({
        id: this.#newId(),
        quoteId: '',
        method: pair.method.method,
        chainId: pair.method.chainId,
        asset: pair.asset,
        tokenAddress: pair.method.contracts[pair.asset],
        depositAddress: deposit,
        amountIn: result.quote.amountIn,
        requiredAmountIn: result.quote.requiredAmountIn,
        maxAcceptedAmountIn: result.quote.maxAcceptedAmountIn,
        decimals: pair.method.decimals,
        minFee: recommendedMinFee(gas, pair.method.chainId).toString(),
        providerRef: result.quote.quoteId,
        idempotencyKey,
        expiresAt: new Date(Date.parse(result.quote.expiresAt)),
        detailIssuedAt: null,
        createdAt: new Date(nowMs),
      });
    }
    return offers;
  }

  /**
   * USD per BTC from the stored spot quote when it is younger than ten
   * minutes; never waits for a fetch.
   *
   * @returns The decimal string, or `null`.
   */
  async #usdPerBtc(): Promise<string | null> {
    if (this.#deps.fxSpot === undefined) {
      return null;
    }
    try {
      const spot = await this.#deps.fxSpot.latest();
      const usd = spot?.rates.USD;
      if (spot === null || usd === undefined) {
        return null;
      }
      const asOfMs = Date.parse(spot.asOf);
      return Number.isFinite(asOfMs) && this.#deps.now() - asOfMs < SHOP_SPOT_MAX_AGE_MS
        ? usd
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Insert a quote and its offers in `tx`; the quote's array and expiry
   * follow the offers that were inserted (a shared deposit address drops an
   * offer and logs `shop.alert.shared_deposit_address`).
   *
   * @param tx - Transaction.
   * @param payment - The payment.
   * @param offers - Offers to insert (any `quoteId`).
   * @param nowMs - Clock.
   * @returns The stored quote.
   */
  async #insertQuote(
    tx: ShopTx,
    payment: ShopPayment,
    offers: readonly ShopOffer[],
    nowMs: number,
  ): Promise<ShopQuote> {
    const quote: ShopQuote = {
      id: this.#newId(),
      paymentId: payment.id,
      expiresAt: payment.windowEndsAt,
      transferAmounts: [lightningTransferAmount(payment.amountSats)],
      createdAt: new Date(nowMs),
    };
    await tx.insertQuote(quote);
    if (offers.length === 0) {
      return quote;
    }
    const inserted = await tx.insertOffers(offers.map((offer) => ({ ...offer, quoteId: quote.id })));
    for (const offer of offers) {
      if (!inserted.some((row) => row.id === offer.id)) {
        logEvent('shop.offer.rejected', { paymentId: payment.id, method: offer.method, asset: offer.asset, check: 'deposit_shared' });
        logEvent('shop.alert.shared_deposit_address', { paymentId: payment.id, method: offer.method, asset: offer.asset });
      }
    }
    const patch = {
      expiresAt: quoteExpiration(payment.windowEndsAt, inserted),
      transferAmounts: transferAmountsFor(payment.amountSats, inserted),
    };
    const updated = await tx.updateQuote(quote.id, patch);
    /* v8 ignore next -- the quote was inserted in this transaction */
    return updated ?? { ...quote, ...patch };
  }

  /**
   * Start the creation procedure for a pending charge in the background
   * (after `POST /pos`), so the first scan finds the payment ready.
   *
   * @param account - Shop account.
   * @param charge - The new charge.
   */
  startForCharge(account: Account, charge: PosCharge): void {
    const username = account.username ?? '';
    if (!this.offersStablecoins(username)) {
      return;
    }
    void this.createForCharge(account, username, charge).catch((error: unknown) => {
      logEvent('shop.creation.failed', { accountId: account.id, error: String(error) });
    });
  }

  /**
   * The creation procedure for a pending charge.
   *
   * @param account - Shop account.
   * @param username - Its username.
   * @param charge - The pending charge.
   * @returns The outcome.
   */
  createForCharge(account: Account, username: string, charge: PosCharge): Promise<ShopCreation> {
    return this.#create({ kind: 'charge', account, username, charge, amountSats: charge.amountSats });
  }

  /**
   * The creation procedure for an amount the payer entered
   * (`POST /pay/:username/payment`, orders 4 and 6 to 9).
   *
   * @param account - Shop account.
   * @param username - Its username.
   * @param amountSats - Accepted sats.
   * @returns The outcome.
   */
  createForPayer(account: Account, username: string, amountSats: number): Promise<ShopCreation> {
    return this.#create({ kind: 'payer', account, username, amountSats });
  }

  /**
   * Steps 1 to 8 of the creation procedure.
   *
   * @param input - Charge or payer creation.
   * @returns The outcome.
   */
  #create(
    input:
      | { kind: 'charge'; account: Account; username: string; charge: PosCharge; amountSats: number }
      | { kind: 'payer'; account: Account; username: string; amountSats: number },
  ): Promise<ShopCreation> {
    const { account } = input;
    return this.#withLock(account.id, async () => {
      const startMs = this.#deps.now();
      // Step 2: re-check under the lock.
      const recheck = await this.#deps.store.transaction(async (tx) => {
        const open = await tx.openPayment(account.id);
        if (open !== null && open.windowEndsAt.getTime() <= startMs) {
          await endPayment(tx, open, 'window', startMs);
        }
        if (input.kind === 'charge') {
          const existing = await tx.paymentForCharge(input.charge.id);
          if (existing !== null) {
            return { kind: 'payment', payment: existing } as const;
          }
          const charge = await tx.lockCharge(input.charge.id);
          if (charge === null || charge.status !== 'pending' || charge.expiresAt.getTime() <= startMs) {
            return { kind: 'skipped' } as const;
          }
          return null;
        }
        const pending = await tx.pendingCharge(account.id, startMs);
        return pending === null ? null : ({ kind: 'pending_charge' } as const);
      });
      if (recheck !== null) {
        return recheck;
      }
      if (!this.offersStablecoins(input.username)) {
        return { kind: 'unavailable' };
      }
      const waitUntil = this.#noPairUntil.get(account.id);
      if (waitUntil !== undefined && startMs < waitUntil) {
        return { kind: 'unavailable' };
      }
      // Order 7: api-wide counter first, then the account counter.
      if (
        !this.#apiCreations.allow('api', startMs) ||
        !this.#accountCreations.allow(account.id, startMs)
      ) {
        return { kind: 'unavailable' };
      }
      const config = this.#deps.config;
      /* v8 ignore next 3 -- offersStablecoins checked the config */
      if (config === null) {
        return { kind: 'unavailable' };
      }
      // Step 3: route list.
      const routes = await this.#routeList(startMs + SHOP_ROUTES_TIMEOUT_MS);
      if (routes === null) {
        // No stablecoin until a route-list fetch succeeds; the next creation fetches again.
        return { kind: 'unavailable' };
      }
      const pairs = candidatePairs(routes, config.evmRpc);
      if (pairs.length === 0) {
        this.#noPairUntil.set(account.id, this.#deps.now() + SHOP_NO_PAIR_WAIT_MS);
        return { kind: 'unavailable' };
      }
      // Step 4: mint.
      const paymentId = this.#newId();
      const minted = await this.#mint(account, input.amountSats);
      if (minted === null) {
        return { kind: 'mint_failed' };
      }
      const held = await this.#deps.store.transaction((tx) => tx.paymentForHash(minted.paymentHash));
      if (held !== null) {
        logEvent('shop.alert.duplicate_invoice', { paymentId: held.id });
        return { kind: 'mint_failed' };
      }
      let recordedByUs = false;
      if (input.kind === 'charge') {
        const recorded = await this.#deps.store.transaction(async (tx) => {
          if (await tx.recordChargeInvoice(input.charge.id, minted.paymentHash, minted.requestedAtMs)) {
            return 'recorded' as const;
          }
          const owner = await tx.chargeIdForInvoice(minted.paymentHash);
          if (owner === null) {
            return 'gone' as const;
          }
          return owner === input.charge.id ? ('own' as const) : ('other' as const);
        });
        if (recorded === 'other') {
          logEvent('shop.alert.duplicate_invoice', { accountId: account.id });
          return { kind: 'mint_failed' };
        }
        if (recorded === 'gone') {
          return { kind: 'skipped' };
        }
        recordedByUs = recorded === 'recorded';
      }
      // Steps 5 and 6: quotes and offer checks.
      const offers = await this.#requestOffers(
        pairs,
        {
          paymentId,
          amountSats: input.amountSats,
          bolt11: minted.bolt11,
          bolt11ExpiresAtMs: minted.expiresAtMs,
        },
        this.#deps.now() + SHOP_QUOTES_TIMEOUT_MS,
      );
      // Step 7: no committed pair.
      if (offers.length === 0) {
        this.#noPairUntil.set(account.id, this.#deps.now() + SHOP_NO_PAIR_WAIT_MS);
        return { kind: 'unavailable' };
      }
      // Step 8: insert under the account row lock.
      return this.#insertPayment(input, paymentId, minted, offers, recordedByUs);
    });
  }

  /**
   * Mint the payment's BOLT11 with one 4 s deadline for both LNURL calls,
   * and check its amount.
   *
   * @param account - Shop account.
   * @param amountSats - Sats.
   * @returns The BOLT11, its hash, its expiry, and the request time, or
   *   `null` when the mint failed or the amount differs.
   */
  async #mint(
    account: Account,
    amountSats: number,
  ): Promise<{ bolt11: string; paymentHash: string; expiresAtMs: number; requestedAtMs: number } | null> {
    const receiving = receivingAddress(account, this.#deps.lnurlServer);
    /* v8 ignore next 3 -- callers resolved the verified wallet first */
    if (receiving === null) {
      return null;
    }
    const requestedAtMs = this.#deps.now();
    const deadline = { deadlineMs: requestedAtMs + SHOP_MINT_TIMEOUT_MS, now: this.#deps.now };
    const invoice = await requestGiftInvoice({
      address: receiving.address,
      amountMsat: amountSats * 1000,
      fetchImpl: lnurlServerFetch(this.#deps.lnurlServer, this.#deps.fetchImpl, this.#deps.auth, deadline),
      deadlineMs: deadline.deadlineMs,
      now: this.#deps.now,
    });
    if (!invoice.ok) {
      logEvent('shop.mint.failed', { accountId: account.id });
      return null;
    }
    const decoded = decodeBolt11(invoice.pr);
    if (decoded === null || decoded.amountMsat !== amountSats * 1000) {
      logEvent('shop.mint.failed', { accountId: account.id });
      return null;
    }
    return {
      bolt11: invoice.pr,
      paymentHash: decoded.paymentHash,
      expiresAtMs: bolt11ExpiresAtMs(invoice.pr, requestedAtMs),
      requestedAtMs,
    };
  }

  /**
   * Step 8: insert the payment, its first quote, and its offers in one
   * transaction under the account row lock (and the charge row lock).
   *
   * @param input - Charge or payer creation.
   * @param paymentId - Id chosen before the quotes (their `tag`).
   * @param minted - The BOLT11.
   * @param offers - Offers that passed the checks.
   * @param recordedByUs - Whether step 4 inserted the charge invoice row.
   * @returns The outcome.
   */
  async #insertPayment(
    input:
      | { kind: 'charge'; account: Account; username: string; charge: PosCharge; amountSats: number }
      | { kind: 'payer'; account: Account; username: string; amountSats: number },
    paymentId: string,
    minted: { bolt11: string; paymentHash: string; expiresAtMs: number },
    offers: readonly ShopOffer[],
    recordedByUs: boolean,
  ): Promise<ShopCreation> {
    return this.#deps.store.transaction(async (tx): Promise<ShopCreation> => {
      const nowMs = this.#deps.now();
      const accountId = input.account.id;
      await tx.lockAccount(accountId);
      let windowEndsAt: Date;
      if (input.kind === 'charge') {
        const charge = await tx.lockCharge(input.charge.id);
        if (charge === null || charge.status !== 'pending' || charge.expiresAt.getTime() <= nowMs) {
          return { kind: 'skipped' };
        }
        windowEndsAt = charge.expiresAt;
      } else {
        if ((await tx.pendingCharge(accountId, nowMs)) !== null) {
          return { kind: 'pending_charge' };
        }
        windowEndsAt = new Date(nowMs + SHOP_WINDOW_MS);
      }
      const payment: ShopPayment = {
        id: paymentId,
        accountId,
        amountSats: input.amountSats,
        posChargeId: input.kind === 'charge' ? input.charge.id : null,
        bolt11: minted.bolt11,
        paymentHash: minted.paymentHash,
        bolt11ExpiresAt: new Date(minted.expiresAtMs),
        status: 'open',
        endReason: null,
        windowEndsAt,
        replacements: 0,
        nextSettleAt: new Date(nowMs + 5_000),
        nextHistoryAt: null,
        historyOffset: 0,
        createdAt: new Date(nowMs),
        acceptedAt: null,
        paidAt: null,
        endedAt: null,
        closedAt: null,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const open = await tx.openPayment(accountId);
        if (open !== null && input.kind === 'charge' && open.posChargeId === input.charge.id) {
          return { kind: 'payment', payment: open };
        }
        if (open !== null) {
          const reason: ShopEndReason =
            open.windowEndsAt.getTime() <= nowMs
              ? 'window'
              : input.kind === 'charge'
                ? 'superseded'
                : 'replaced';
          await endPayment(tx, open, reason, nowMs);
        }
        if (await tx.insertPayment(payment)) {
          await this.#insertQuote(tx, payment, offers, nowMs);
          logEvent('shop.payment.opened', { paymentId: payment.id });
          return { kind: 'payment', payment };
        }
        const holder = await tx.paymentForHash(payment.paymentHash);
        if (holder !== null) {
          if (input.kind === 'charge' && holder.posChargeId === input.charge.id) {
            return { kind: 'payment', payment: holder };
          }
          logEvent('shop.alert.duplicate_invoice', { paymentId: holder.id });
          if (input.kind === 'charge' && recordedByUs) {
            await tx.deleteChargeInvoice(payment.paymentHash);
          }
          return { kind: 'mint_failed' };
        }
        if (input.kind === 'charge') {
          const own = await tx.paymentForCharge(input.charge.id);
          if (own !== null) {
            return { kind: 'payment', payment: own };
          }
        }
      }
      /* v8 ignore next -- a second conflict needs a third writer between two statements under the account lock */
      return { kind: 'unavailable' };
    });
  }

  // ─── Pay link ───────────────────────────────────────────────────────────

  /**
   * Where the account's sticker stands: an open amount, a pending charge
   * with its shop payment (if any), or nothing.
   *
   * @param accountId - Shop account id.
   * @param nowMs - Clock.
   * @returns The state.
   */
  async #linkState(accountId: string, nowMs: number): Promise<LinkState> {
    return this.#deps.store.transaction(async (tx): Promise<LinkState> => {
      const open = await tx.openPayment(accountId);
      if (open !== null && nowMs < open.windowEndsAt.getTime()) {
        return { kind: 'open', payment: open };
      }
      const charge = await tx.pendingCharge(accountId, nowMs);
      if (charge === null) {
        return { kind: 'none' };
      }
      return { kind: 'charge', charge, payment: await tx.paymentForCharge(charge.id) };
    });
  }

  /**
   * Answer `GET /.well-known/lnurlp/:username` once today's wallet pay
   * request resolved: the no-open-amount, open-amount, `timeout`, and
   * simplified-flow rules of the contract.
   *
   * @param account - Shop account (verified wallet).
   * @param username - Its username.
   * @param metadata - Metadata of today's pay request.
   * @param query - `timeout`, `method`, `asset`, and repeated keys.
   * @returns Today's request (with an optional pin) or a full response.
   */
  async payLink(
    account: Account,
    username: string,
    metadata: string,
    query: ShopPayLinkQuery,
  ): Promise<ShopPayLinkAnswer> {
    const startMs = this.#deps.now();
    const name = shopName(account, username);
    let state = await this.#linkState(account.id, startMs);
    if (query.timeout !== null) {
      const parsed = /^[0-9]+$/.test(query.timeout) ? Number(query.timeout) : 0;
      const waitMs = Math.min(parsed, SHOP_MAX_TIMEOUT_SECONDS) * 1000;
      const ready = (s: LinkState): boolean =>
        s.kind === 'open' ||
        (s.kind === 'charge' && (s.payment === null || s.payment.status === 'open'));
      if (!ready(state) && waitMs > 0 && this.#waiting < SHOP_MAX_WAITING_REQUESTS) {
        this.#waiting += 1;
        try {
          while (!ready(state) && this.#deps.now() - startMs < waitMs) {
            await this.#sleep(WAIT_SATS_POLL_MS);
            state = await this.#linkState(account.id, this.#deps.now());
          }
        } finally {
          this.#waiting -= 1;
        }
      }
      if (!ready(state)) {
        return { kind: 'response', response: shopResponse(noPendingPaymentBody(username, name), 404) };
      }
    }
    if (state.kind === 'charge' && state.payment === null && this.offersStablecoins(username)) {
      const created = await Promise.race([
        this.createForCharge(account, username, state.charge).catch(() => null),
        this.#sleep(SHOP_CREATION_BUDGET_MS).then(() => null),
      ]);
      if (created?.kind === 'payment') {
        state = await this.#linkState(account.id, this.#deps.now());
      }
    }
    if (state.kind === 'open') {
      return this.#openAmountAnswer(account, username, name, metadata, state.payment, query);
    }
    if (state.kind === 'charge') {
      const status = state.payment?.status;
      const pinned = status === undefined || status === 'ended' || status === 'open';
      if (query.method !== null) {
        return { kind: 'response', response: shopResponse(noPendingPaymentBody(username, name), 404) };
      }
      return { kind: 'today', pinSats: pinned ? state.charge.amountSats : null };
    }
    if (query.method !== null) {
      return { kind: 'response', response: shopResponse(noPendingPaymentBody(username, name), 404) };
    }
    return { kind: 'today', pinSats: null };
  }

  /**
   * The pay request (or the simplified-flow detail) for an open amount.
   *
   * @param account - Shop account.
   * @param username - Its username.
   * @param name - Shop name.
   * @param metadata - Today's metadata.
   * @param payment - The open payment.
   * @param query - Pay-link query.
   * @returns The answer.
   */
  async #openAmountAnswer(
    account: Account,
    username: string,
    name: string,
    metadata: string,
    payment: ShopPayment,
    query: ShopPayLinkQuery,
  ): Promise<ShopPayLinkAnswer> {
    const current = await this.currentQuote(account, username, payment);
    if (current === null) {
      // The payment left `open` meanwhile: answer as without an open amount.
      return query.method === null && query.timeout === null
        ? { kind: 'today', pinSats: null }
        : { kind: 'response', response: shopResponse(noPendingPaymentBody(username, name), 404) };
    }
    if (query.method !== null) {
      const response = await this.callback(account, username, {
        amount: null,
        quote: current.quote.id,
        method: query.method,
        asset: query.asset,
        repeated: query.repeated,
      });
      return { kind: 'response', response };
    }
    const body = shopPayRequest({
      username,
      name,
      metadata,
      publicBaseUrl: this.#deps.lnurlServer.publicBaseUrl,
      payment: current.payment,
      quote: current.quote,
    });
    return { kind: 'response', response: shopResponse(body, 200) };
  }

  /**
   * The current quote of an open payment, after the replacement rule and the
   * Lightning-only fallback for an expired quote.
   *
   * @param account - Shop account.
   * @param username - Its username.
   * @param payment - The open payment.
   * @returns The payment and its current quote, or `null` when the payment
   *   is no longer open.
   */
  async currentQuote(
    account: Account,
    username: string,
    payment: ShopPayment,
  ): Promise<{ payment: ShopPayment; quote: ShopQuote } | null> {
    let read = await this.#readCurrent(payment.id);
    if (read === null) {
      return null;
    }
    if (this.#replaceable(read.payment, read.quote, this.#deps.now()) && this.offersStablecoins(username)) {
      read = await this.#replace(account, read.payment.id);
      if (read === null) {
        return null;
      }
    }
    if (read.quote.expiresAt.getTime() > this.#deps.now()) {
      return read;
    }
    return this.#deps.store.transaction(async (tx) => {
      const nowMs = this.#deps.now();
      await tx.lockAccount(account.id);
      const locked = await tx.lockPayment(payment.id);
      if (locked === null || locked.status !== 'open' || nowMs >= locked.windowEndsAt.getTime()) {
        return null;
      }
      const quotes = await tx.quotesOf(locked.id);
      const latest = quotes[quotes.length - 1];
      if (latest !== undefined && latest.expiresAt.getTime() > nowMs) {
        return { payment: locked, quote: latest };
      }
      const quote = await this.#insertQuote(tx, locked, [], nowMs);
      return { payment: locked, quote };
    });
  }

  /**
   * Read a payment that is still the open amount, with its newest quote.
   *
   * @param paymentId - Payment id.
   * @returns The rows, or `null` when the payment is no longer open.
   */
  async #readCurrent(paymentId: string): Promise<{ payment: ShopPayment; quote: ShopQuote } | null> {
    return this.#deps.store.transaction(async (tx) => {
      const payment = await tx.getPayment(paymentId);
      if (
        payment === null ||
        payment.status !== 'open' ||
        this.#deps.now() >= payment.windowEndsAt.getTime()
      ) {
        return null;
      }
      const quotes = await tx.quotesOf(paymentId);
      const quote = quotes[quotes.length - 1];
      /* v8 ignore next 3 -- every payment is inserted with its first quote */
      if (quote === undefined) {
        return null;
      }
      return { payment, quote };
    });
  }

  /**
   * The replacement rule: less than 45 s left on the quote, at least 45 s
   * left in the window, fewer than 4 replacements, and not Lightning-only.
   *
   * @param payment - Open payment.
   * @param quote - Its current quote.
   * @param nowMs - Clock.
   * @returns Whether a fetch replaces the quote.
   */
  #replaceable(payment: ShopPayment, quote: ShopQuote, nowMs: number): boolean {
    return (
      quote.transferAmounts.length > 1 &&
      quote.expiresAt.getTime() - nowMs < SHOP_REPLACE_BEFORE_MS &&
      payment.windowEndsAt.getTime() - nowMs >= SHOP_REPLACE_BEFORE_MS &&
      payment.replacements < SHOP_MAX_REPLACEMENTS
    );
  }

  /**
   * Replace the current quote under the creation lock: route list, quotes,
   * and offer checks for the same sats and BOLT11 within 4 s, then one
   * transaction that increments `replacements` conditionally and inserts the
   * quote (Lightning-only when no offer passes).
   *
   * @param account - Shop account.
   * @param paymentId - Payment id.
   * @returns The current payment and quote afterwards, or `null` when the
   *   payment is no longer open.
   */
  #replace(
    account: Account,
    paymentId: string,
  ): Promise<{ payment: ShopPayment; quote: ShopQuote } | null> {
    return this.#withLock(account.id, async () => {
      const startMs = this.#deps.now();
      const read = await this.#readCurrent(paymentId);
      if (read === null || !this.#replaceable(read.payment, read.quote, startMs)) {
        return read;
      }
      const deadlineMs = startMs + SHOP_REPLACEMENT_BUDGET_MS;
      const config = this.#deps.config;
      /* v8 ignore next 3 -- callers checked offersStablecoins */
      if (config === null) {
        return read;
      }
      const routes = await this.#routeList(Math.min(deadlineMs, startMs + SHOP_ROUTES_TIMEOUT_MS));
      const pairs = routes === null ? [] : candidatePairs(routes, config.evmRpc);
      const offers =
        pairs.length === 0
          ? []
          : await this.#requestOffers(
              pairs,
              {
                paymentId,
                amountSats: read.payment.amountSats,
                bolt11: read.payment.bolt11,
                bolt11ExpiresAtMs: read.payment.bolt11ExpiresAt.getTime(),
              },
              deadlineMs,
            );
      return this.#deps.store.transaction(async (tx) => {
        const nowMs = this.#deps.now();
        await tx.lockAccount(account.id);
        const counted = await tx.updatePayment(
          paymentId,
          {
            statuses: ['open'],
            replacements: read.payment.replacements,
            windowEndsAfter: new Date(nowMs + SHOP_REPLACE_BEFORE_MS - 1),
          },
          { replacements: read.payment.replacements + 1 },
        );
        if (counted === null) {
          const payment = await tx.getPayment(paymentId);
          if (payment === null || payment.status !== 'open' || nowMs >= payment.windowEndsAt.getTime()) {
            return null;
          }
          const quotes = await tx.quotesOf(paymentId);
          const quote = quotes[quotes.length - 1];
          /* v8 ignore next -- every payment has its first quote */
          return quote === undefined ? null : { payment, quote };
        }
        const quote = await this.#insertQuote(tx, counted, offers, nowMs);
        return { payment: counted, quote };
      });
    });
  }

  // ─── Callback ───────────────────────────────────────────────────────────

  /**
   * `GET /lnurlp/cb/:username` after the rate limit: the LNURL amount path
   * without `method`, otherwise the detail table of the contract.
   *
   * @param account - Shop account.
   * @param username - Its username.
   * @param query - Callback query.
   * @returns The response.
   */
  async callback(account: Account, username: string, query: ShopCallbackQuery): Promise<Response> {
    const nowMs = this.#deps.now();
    const state = await this.#linkState(account.id, nowMs);
    const open = state.kind === 'open' ? state.payment : null;
    if (query.method === null) {
      if (open !== null && query.amount === String(open.amountSats * 1000)) {
        return shopResponse({ pr: open.bolt11, routes: [] }, 200);
      }
      return shopError(400, 'Amount does not match this payment');
    }
    if (query.quote === null || query.asset === null || query.repeated) {
      return shopError(400, 'That payment is not offered');
    }
    if (open === null) {
      return shopError(404, 'Quote expired');
    }
    const quoteId = normalizeUuid(query.quote);
    if (quoteId === null) {
      return shopError(404, 'Quote expired');
    }
    const found = await this.#deps.store.transaction(async (tx) => {
      const quotes = await tx.quotesOf(open.id);
      const recent = quotes.slice(-2);
      const quote = recent.find((row) => row.id === quoteId);
      if (quote === undefined) {
        return null;
      }
      return { quote, offers: await tx.offersOf(quote.id) };
    });
    if (found === null || found.quote.expiresAt.getTime() <= nowMs) {
      return shopError(404, 'Quote expired');
    }
    const method = query.method.toLowerCase();
    const asset = query.asset.toLowerCase();
    if (method === 'lightning' && asset === 'btc') {
      return shopResponse({ pr: open.bolt11 }, 200);
    }
    const offer = found.offers.find(
      (row) => row.method.toLowerCase() === method && row.asset.toLowerCase() === asset,
    );
    const served = found.quote.transferAmounts.some(
      (entry) =>
        entry.available &&
        entry.method.toLowerCase() === method &&
        entry.assets.some((item) => item.asset.toLowerCase() === asset),
    );
    if (offer === undefined || !served) {
      return shopError(400, 'That payment is not offered');
    }
    await this.#deps.store.transaction(async (tx) => {
      if (await tx.markDetailIssued(offer.id, nowMs)) {
        const payment = await tx.getPayment(open.id);
        if (payment !== null && payment.nextHistoryAt === null) {
          await tx.updatePayment(payment.id, {}, { nextHistoryAt: new Date(nowMs + 10_000) });
        }
      }
    });
    return shopResponse(
      offerDetail(offer, found.quote, this.#deps.lnurlServer.publicBaseUrl, username),
      200,
    );
  }

  // ─── Wait ───────────────────────────────────────────────────────────────

  /**
   * `GET /lnurlp/wait/:payment` after the rate limit and the id check.
   *
   * @param paymentId - Lowercase payment id.
   * @param since - `since` query, or `null`.
   * @param timeoutMs - Hold limit (`WAIT_SATS_TIMEOUT_MS`).
   * @returns The body, or `null` when the payment does not exist.
   */
  async wait(
    paymentId: string,
    since: string | null,
    timeoutMs: number,
  ): Promise<ReturnType<typeof waitBody> | null> {
    const startMs = this.#deps.now();
    const read = (): Promise<ShopPayment | null> =>
      this.#deps.store.transaction((tx) => tx.getPayment(paymentId));
    let payment = await read();
    if (payment === null) {
      return null;
    }
    while (
      since !== null &&
      dfxPaymentStatus(payment).toString() === 'Pending' &&
      payment.status === since &&
      this.#deps.now() - startMs < timeoutMs
    ) {
      await this.#sleep(WAIT_SATS_POLL_MS);
      const next = await read();
      /* v8 ignore next 3 -- payments are never deleted */
      if (next === null) {
        return null;
      }
      payment = next;
    }
    return waitBody(payment);
  }

  // ─── Till ───────────────────────────────────────────────────────────────

  /**
   * `POST /pos`: insert the charge and end the account's `open` shop payment
   * (`superseded`, or `window` when its window passed) in one transaction
   * under the account row lock, then start the creation in the background.
   *
   * @param account - Shop account.
   * @param row - The new charge.
   * @returns `false` when a pending charge already exists (nothing written).
   */
  async createCharge(account: Account, row: PosCharge): Promise<boolean> {
    const created = await this.#deps.store.transaction(async (tx) => {
      await tx.lockAccount(account.id);
      if (!(await tx.insertCharge(row))) {
        return false;
      }
      const open = await tx.openPayment(account.id);
      if (open !== null) {
        const nowMs = row.createdAt.getTime();
        await endPayment(tx, open, open.windowEndsAt.getTime() <= nowMs ? 'window' : 'superseded', nowMs);
      }
      return true;
    });
    if (created) {
      this.startForCharge(account, row);
    }
    return created;
  }

  /**
   * `DELETE /pos`: cancel the pending charge and end its `open` shop payment
   * with `cancelled`, in one transaction under the account row lock.
   *
   * @param accountId - Shop account id.
   * @param nowMs - Clock.
   * @returns The cancelled charge, or `null` when nothing was open.
   */
  cancelCharge(accountId: string, nowMs: number): Promise<PosCharge | null> {
    return this.#deps.store.transaction(async (tx) => {
      await tx.lockAccount(accountId);
      const cancelled = await tx.cancelPendingCharge(accountId, nowMs);
      if (cancelled === null) {
        return null;
      }
      const payment = await tx.paymentForCharge(cancelled.id);
      if (payment !== null && payment.status === 'open') {
        await endPayment(tx, payment, 'cancelled', nowMs);
      }
      return cancelled;
    });
  }

  /**
   * The charge watch found an invoice of a charge settled: mark the charge
   * paid and settle its shop payment in the same transaction under the
   * account row lock. The payment's own hash moves it to `paid`; the Spark
   * invoice or another BOLT11 ends an `open` payment with `charge_paid`.
   *
   * @param charge - The watched charge.
   * @param settled - The settled payment hash, or `null` for the Spark invoice.
   * @param nowMs - Clock.
   * @returns The paid charge, or `null` when this call did not change it.
   */
  chargePaid(charge: PosCharge, settled: string | null, nowMs: number): Promise<PosCharge | null> {
    return this.#deps.store.transaction(async (tx) => {
      await tx.lockAccount(charge.accountId);
      const paid = await tx.markChargePaid(charge.id, nowMs);
      const payment = await tx.paymentForCharge(charge.id);
      if (payment === null) {
        return paid;
      }
      if (settled !== null && settled === payment.paymentHash) {
        await markPaymentPaid(tx, payment, nowMs, false);
      } else if (payment.status === 'open') {
        await endPayment(tx, payment, 'charge_paid', nowMs);
      }
      return paid;
    });
  }

  /**
   * `shopPayment` of a charge for `GET /pos`.
   *
   * @param chargeId - Charge id.
   * @returns `{ id, status }`, or `null` when the charge has none.
   */
  async shopPaymentOfCharge(chargeId: string): Promise<{ id: string; status: ShopPayment['status'] } | null> {
    const payment = await this.#deps.store.transaction((tx) => tx.paymentForCharge(chargeId));
    return payment === null ? null : { id: payment.id, status: payment.status };
  }

  // ─── Settlement ─────────────────────────────────────────────────────────

  /**
   * Apply one settlement read of a payment's BOLT11 (watcher duty 2).
   * Settled: `paid`, and `markPaid` for its charge. Unpaid: the next read is
   * scheduled; the final read, 10 minutes after the BOLT11 expiry, closes the
   * payment (an `accepted` one ends with `expired_unpaid`).
   *
   * @param paymentId - Payment id.
   * @param settled - Read result: `true` settled, `false` unpaid, `null` failed.
   * @param nowMs - Clock.
   */
  async applySettlement(paymentId: string, settled: boolean | null, nowMs: number): Promise<void> {
    await this.#deps.store.transaction(async (tx) => {
      const peek = await tx.getPayment(paymentId);
      if (peek === null) {
        return;
      }
      await tx.lockAccount(peek.accountId);
      const payment = await tx.lockPayment(paymentId);
      /* v8 ignore next 3 -- the row was just read */
      if (payment === null || payment.status === 'paid' || payment.closedAt !== null) {
        return;
      }
      if (settled === true) {
        await markPaymentPaid(tx, payment, nowMs, true);
        return;
      }
      const finalAtMs = payment.bolt11ExpiresAt.getTime() + SHOP_FINAL_SETTLE_DELAY_MS;
      if (settled === false && nowMs >= finalAtMs) {
        await closePayment(tx, payment, nowMs);
        return;
      }
      const cadence = nowMs - payment.createdAt.getTime() < SHOP_FAST_SETTLE_MS ? 5_000 : 30_000;
      const next = nowMs >= finalAtMs ? nowMs + cadence : Math.min(nowMs + cadence, finalAtMs);
      await tx.updatePayment(payment.id, {}, { nextSettleAt: new Date(next) });
    });
  }
}

// ─── Payment transitions ──────────────────────────────────────────────────

/**
 * End an `open` payment with a reason.
 *
 * @param tx - Transaction.
 * @param payment - The payment.
 * @param reason - End reason.
 * @param nowMs - Clock.
 * @returns The ended row, or `null` when it was no longer `open`.
 */
export async function endPayment(
  tx: ShopTx,
  payment: ShopPayment,
  reason: ShopEndReason,
  nowMs: number,
): Promise<ShopPayment | null> {
  const ended = await tx.updatePayment(
    payment.id,
    { statuses: ['open'] },
    { status: 'ended', endReason: reason, endedAt: new Date(nowMs) },
  );
  if (ended !== null) {
    logEvent('shop.payment.ended', { paymentId: payment.id, reason });
  }
  return ended;
}

/**
 * Move a payment to `paid` (its BOLT11 settled). With `settleCharge`, also
 * run `markPaid` for its charge: a charge already paid (by another invoice,
 * since this payment was still unpaid) logs `shop.alert.double_settled`; a
 * cancelled charge logs `shop.alert.cancelled_settled` and stays cancelled.
 *
 * @param tx - Transaction (account locked).
 * @param payment - The payment.
 * @param nowMs - Clock.
 * @param settleCharge - `false` when the caller (the charge watch) already
 *   marked the charge paid in this transaction.
 */
export async function markPaymentPaid(
  tx: ShopTx,
  payment: ShopPayment,
  nowMs: number,
  settleCharge: boolean,
): Promise<void> {
  const paid = await tx.updatePayment(
    payment.id,
    { statuses: ['open', 'ended', 'accepted'], notClosed: true },
    { status: 'paid', paidAt: new Date(nowMs), endedAt: null, endReason: null, nextSettleAt: null },
  );
  if (paid === null) {
    return;
  }
  logEvent('shop.payment.paid', { paymentId: payment.id });
  if (!settleCharge || payment.posChargeId === null) {
    return;
  }
  const charge = await tx.lockCharge(payment.posChargeId);
  if (charge === null) {
    return;
  }
  if (charge.status === 'cancelled') {
    logEvent('shop.alert.cancelled_settled', { paymentId: payment.id });
    return;
  }
  if (charge.status === 'paid') {
    logEvent('shop.alert.double_settled', { paymentId: payment.id });
    return;
  }
  await tx.markChargePaid(charge.id, nowMs);
}

/**
 * The final settlement read found the BOLT11 unpaid: close the payment.
 *
 * @param tx - Transaction (account locked).
 * @param payment - The payment (not paid, not closed).
 * @param nowMs - Clock.
 */
async function closePayment(tx: ShopTx, payment: ShopPayment, nowMs: number): Promise<void> {
  const patch = { closedAt: new Date(nowMs), nextSettleAt: null };
  if (payment.status === 'ended') {
    await tx.updatePayment(payment.id, { statuses: ['ended'], notClosed: true }, patch);
  } else {
    const reason: ShopEndReason = payment.status === 'accepted' ? 'expired_unpaid' : 'window';
    await tx.updatePayment(
      payment.id,
      { statuses: [payment.status], notClosed: true },
      { ...patch, status: 'ended', endReason: reason, endedAt: new Date(nowMs) },
    );
    if (payment.status === 'accepted') {
      logEvent('shop.alert.accepted_unpaid', { paymentId: payment.id });
    }
  }
  logEvent('shop.payment.closed', { paymentId: payment.id });
}
