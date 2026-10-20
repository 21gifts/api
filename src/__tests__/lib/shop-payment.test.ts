import { bech32 } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import type { ShopPaymentConfig } from '@/lib/config';
import { erc20TransferData } from '@/lib/evm-transfer';
import { InMemoryFxSpotStore, type FxSpotStore } from '@/lib/fx-spot-store';
import * as log from '@/lib/log';
import type {
  OrchestraClient,
  OrchestraQuote,
  OrchestraQuoteRequest,
  OrchestraQuoteResult,
  OrchestraRouteAsset,
  OrchestraRoutesResult,
} from '@/lib/orchestra';
import { POS_CHARGE_TTL_MS, type PosCharge } from '@/lib/pos-charge';
import { InMemoryPosStore } from '@/lib/pos-store';
import {
  InMemoryShopPaymentStore,
  type ShopOffer,
  type ShopPayment,
  type ShopPaymentStore,
  type ShopProof,
  type ShopQuote,
  type ShopTx,
} from '@/lib/shop-payment-store';
import {
  PlainJsonNumber,
  SHOP_ASSETS,
  SHOP_METHODS,
  SHOP_LNURL_HEADERS,
  SHOP_CREATION_INSERT_LIMIT_MS,
  SHOP_PAY_LINK_CREATION_WAIT_MS,
  SHOP_REPLACEMENT_BUDGET_MS,
  SHOP_REPLACEMENT_COMMIT_MARGIN_MS,
  SHOP_SETTLE_FAST_INTERVAL_MS,
  SHOP_SETTLE_SLOW_INTERVAL_MS,
  ShopPayments,
  btcAmount,
  candidatePairs,
  checkOffer,
  decimalAmount,
  dfxPaymentStatus,
  endPayment,
  evaluateProof,
  isExcludedShopUsername,
  lightningTransferAmount,
  lockPaymentForProofs,
  markPaymentPaid,
  noPendingPaymentBody,
  offerDetail,
  offerUri,
  proofUrl,
  proofWithinBounds,
  quoteExpiration,
  recordProofOrder,
  refuseProof,
  shopError,
  shopErrorBody,
  shopJson,
  shopMethodByName,
  shopName,
  shopPairOrder,
  shopPayRequest,
  shopResponse,
  transferAmountsFor,
  waitBody,
  type OfferCheckInput,
  type ShopPair,
  type ShopPayLinkAnswer,
  type ShopPayLinkQuery,
} from '@/lib/shop-payment';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000a1';
const USER = 'shop';
const SATS = 1234;
const CHARGE_SATS = 2100;
/** USD per BTC of the default spot store; the fake Orchestra prices 1 sat at 0.001 USD. */
const SPOT_USD = '100000';
const METADATA = '[["text/plain","shop"]]';
const REFUND = '0x00000000000000000000000000000000000000ff';
const RPC = (chainId: number): string => `https://rpc.test/${chainId}`;

let clock = T0;
let sleepCalls: number[] = [];
/** Default: a poll sleep advances the clock; any other sleep (the creation race) never ends. */
let sleepImpl: (ms: number) => Promise<void> = defaultSleep;
let hashSeq = 0;

function defaultSleep(ms: number): Promise<void> {
  if (ms === 250) {
    clock += ms;
    return Promise.resolve();
  }
  return new Promise<void>(() => undefined);
}

function nextHash(): string {
  hashSeq += 1;
  return hashSeq.toString(16).padStart(64, '0');
}

function words(value: number, length: number): number[] {
  const out: number[] = [];
  for (let i = length - 1; i >= 0; i -= 1) {
    out.push(Math.floor(value / 32 ** i) % 32);
  }
  return out;
}

function tagged(type: number, data: number[]): number[] {
  return [type, ...words(data.length, 2), ...data];
}

/** A BOLT11 that `light-bolt11-decoder` decodes (unsigned: the signature is zeros). */
function bolt11For(sats: number, paymentHash: string, expirySeconds: number | null): string {
  const data = [
    ...words(1_700_000_000, 7),
    ...tagged(1, bech32.toWords(Buffer.from(paymentHash, 'hex'))),
  ];
  if (expirySeconds !== null) {
    let length = 1;
    while (32 ** length <= expirySeconds) {
      length += 1;
    }
    data.push(...tagged(6, words(expirySeconds, length)));
  }
  data.push(...bech32.toWords(new Uint8Array(65)));
  return bech32.encode(`lnbc${sats * 10}n`, data, false);
}

function methodOf(sourceChain: string) {
  const method = SHOP_METHODS.find((row) => row.sourceChain === sourceChain);
  if (method === undefined) {
    throw new Error(`no method ${sourceChain}`);
  }
  return method;
}

function defaultRoutes(): OrchestraRouteAsset[] {
  return SHOP_METHODS.flatMap((method) =>
    SHOP_ASSETS.map((asset) => ({
      chain: method.sourceChain,
      asset,
      contractAddress: method.contracts[asset],
      decimals: method.decimals,
      exactOutToLightning: true,
    })),
  );
}

interface QuoteCall {
  request: OrchestraQuoteRequest;
  key: string;
  deadlineMs: number;
}

/** Plain-object Orchestra fake for routes, quote, and quoteBudgetLeft. */
class FakeOrchestra {
  routesResult: OrchestraRoutesResult = { ok: true, assets: defaultRoutes(), validForMs: 60_000 };
  routesImpl: (() => Promise<OrchestraRoutesResult>) | null = null;
  routesCalls: number[] = [];
  routesLogs: log.LogFields[] = [];
  quoteCalls: QuoteCall[] = [];
  quoteImpl: ((request: OrchestraQuoteRequest) => OrchestraQuoteResult) | null = null;
  onQuote: ((request: OrchestraQuoteRequest) => Promise<void>) | null = null;
  budget = 240;
  deposits = 0;

  async routes(timeoutMs: number, fields: log.LogFields): Promise<OrchestraRoutesResult> {
    this.routesCalls.push(timeoutMs);
    this.routesLogs.push(fields);
    return this.routesImpl === null ? this.routesResult : this.routesImpl();
  }

  async quote(
    request: OrchestraQuoteRequest,
    key: string,
    deadlineMs: number,
  ): Promise<OrchestraQuoteResult> {
    this.quoteCalls.push({ request, key, deadlineMs });
    if (this.onQuote !== null) {
      await this.onQuote(request);
    }
    return this.quoteImpl === null
      ? { ok: true, quote: this.validQuote(request) }
      : this.quoteImpl(request);
  }

  quoteBudgetLeft(): number {
    return this.budget;
  }

  validQuote(request: OrchestraQuoteRequest, over: Partial<OrchestraQuote> = {}): OrchestraQuote {
    const method = methodOf(request.sourceChain);
    this.deposits += 1;
    const deposit = `0x${(0xd0000000 + this.deposits).toString(16).padStart(40, '0')}`;
    const amountIn = (BigInt(request.amountSats) * 10n ** BigInt(method.decimals)) / 1000n;
    return {
      quoteId: `oq-${this.deposits}`,
      depositAddress: deposit,
      amountIn: amountIn.toString(),
      requiredAmountIn: amountIn.toString(),
      maxAcceptedAmountIn: (amountIn + 10n).toString(),
      targetAmountOut: String(request.amountSats),
      expiresAt: new Date(clock + 120_000).toISOString(),
      transaction: {
        chainId: method.chainId,
        to: method.contracts[request.sourceAsset],
        data: erc20TransferData(deposit, amountIn),
        value: '0',
      },
      ...over,
    };
  }
}

/** LNURL server, EVM RPC, and unexpected-host fake behind `fetchImpl`. */
interface FakeNet {
  expirySec: number | null;
  invoiceStatus: number;
  prOverride: string | null;
  satsDelta: number;
  nextHash: string | null;
  issued: { pr: string; hash: string }[];
  onWellKnown: (() => void) | null;
  onInvoice: (() => Promise<void>) | null;
  gas: Map<number, bigint | null>;
  rpcCalls: { chainId: number; method: string }[];
}

function newNet(): FakeNet {
  return {
    expirySec: 3600,
    invoiceStatus: 200,
    prOverride: null,
    satsDelta: 0,
    nextHash: null,
    issued: [],
    onWellKnown: null,
    onInvoice: null,
    gas: new Map(),
    rpcCalls: [],
  };
}

function fakeFetch(net: FakeNet) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${LNURL_SERVER.baseUrl}/.well-known/lnurlp/`)) {
      const user = url.split('/').pop() ?? '';
      net.onWellKnown?.();
      return Response.json({
        tag: 'payRequest',
        callback: `${LNURL_SERVER.publicBaseUrl}/lnurlp/${user}/invoice`,
        metadata: METADATA,
        minSendable: 1000,
        maxSendable: 100_000_000_000,
      });
    }
    if (url.startsWith(`${LNURL_SERVER.baseUrl}/lnurlp/`) && url.includes('/invoice?')) {
      if (net.onInvoice !== null) {
        await net.onInvoice();
      }
      if (net.invoiceStatus !== 200) {
        return new Response('down', { status: net.invoiceStatus });
      }
      const amount = Number(new URL(url).searchParams.get('amount'));
      const hash = net.nextHash ?? nextHash();
      net.nextHash = null;
      const pr = net.prOverride ?? bolt11For(amount / 1000 + net.satsDelta, hash, net.expirySec);
      net.issued.push({ pr, hash });
      return Response.json({ pr });
    }
    if (url.startsWith('https://rpc.test/')) {
      const chainId = Number(url.slice('https://rpc.test/'.length));
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      net.rpcCalls.push({ chainId, method: body.method });
      const gas = net.gas.has(chainId) ? net.gas.get(chainId) : 1_000_000_007n;
      if (gas === null || gas === undefined) {
        return new Response('down', { status: 503 });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${gas.toString(16)}` });
    }
    return new Response('unexpected', { status: 500 });
  };
}

type TxHook = (tx: ShopTx, ...args: never[]) => Promise<unknown>;

/** Store wrapper whose transactions expose `ShopTx` through overridable hooks. */
class HookedStore implements ShopPaymentStore {
  readonly hooks: Partial<Record<keyof ShopTx, TxHook>> = {};
  constructor(readonly inner: InMemoryShopPaymentStore) {}

  transaction<T>(run: (tx: ShopTx) => Promise<T>): Promise<T> {
    return this.inner.transaction((tx) =>
      run(
        new Proxy(tx, {
          get: (target, prop) => {
            const hook = this.hooks[prop as keyof ShopTx];
            if (hook !== undefined) {
              return (...args: never[]) => hook(target, ...args);
            }
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      ),
    );
  }
}

interface LogEntry {
  event: string;
  fields: log.LogFields | undefined;
}

interface Harness {
  store: HookedStore;
  pos: InMemoryPosStore;
  auth: InMemoryAuthStore;
  orchestra: FakeOrchestra;
  net: FakeNet;
  svc: ShopPayments;
  account: Account;
  config: ShopPaymentConfig;
}

let events: LogEntry[] = [];

function eventsNamed(name: string): LogEntry[] {
  return events.filter((entry) => entry.event === name);
}

function pubkeyFor(id: string): string {
  return `02${id.replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`;
}

async function addAccount(
  auth: InMemoryAuthStore,
  id: string,
  username: string | null,
  name: string | null = 'Corner Shop',
): Promise<Account> {
  await auth.createAccount({
    id,
    linkingKey: null,
    role: 'verified',
    name,
    username,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${id.replaceAll('-', '')}${'0'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    walletRequired: true,
  });
  if (username !== null) {
    await auth.claimSparkPubkey(id, pubkeyFor(id));
    await auth.markSparkPubkeyVerified(id, pubkeyFor(id), username, 2);
    const account = await auth.getAccountByUsername(username);
    if (account === undefined) {
      throw new Error('account');
    }
    return account;
  }
  return {
    id,
    linkingKey: null,
    role: 'verified',
    name,
    username: null,
    forumLawsDismissed: false,
    location: null,
    viewKey: '0'.repeat(64),
    rulesAgreedAt: 1,
    createdAt: 1,
  };
}

/**
 * A spot store whose USD rate is always 1 s old: 100 000 USD per BTC, the
 * price of the fake Orchestra (1 sat = 0.001 USD), so every fake quote
 * passes the price check.
 */
function freshSpot(now: () => number, usd = SPOT_USD): FxSpotStore {
  return {
    latest: async () => ({ asOf: new Date(now() - 1_000).toISOString(), rates: { USD: usd } }),
  } as unknown as FxSpotStore;
}

async function setup(
  options: {
    config?: 'off';
    orchestra?: 'off';
    fxSpot?: FxSpotStore;
    username?: string;
    sleep?: 'default';
    now?: () => number;
  } = {},
): Promise<Harness> {
  const pos = new InMemoryPosStore();
  const store = new HookedStore(new InMemoryShopPaymentStore(pos));
  const auth = new InMemoryAuthStore();
  const account = await addAccount(auth, ACCOUNT_ID, options.username ?? USER);
  const orchestra = new FakeOrchestra();
  const net = newNet();
  const config: ShopPaymentConfig = {
    orchestraBaseUrl: 'https://orchestration.test',
    orchestraApiKey: 'fn_test',
    evmRpc: new Map(SHOP_METHODS.map((method) => [method.chainId, RPC(method.chainId)])),
    refundAddress: REFUND,
  };
  const now = options.now ?? (() => clock);
  const svc = new ShopPayments({
    store,
    posStore: pos,
    auth,
    lnurlServer: LNURL_SERVER,
    config: options.config === 'off' ? null : config,
    orchestra: options.orchestra === 'off' ? null : (orchestra as unknown as OrchestraClient),
    fxSpot: options.fxSpot ?? freshSpot(now),
    fetchImpl: fakeFetch(net),
    now,
    ...(options.sleep === 'default'
      ? {}
      : {
          sleep: (ms: number) => {
            sleepCalls.push(ms);
            return sleepImpl(ms);
          },
        }),
  });
  return { store, pos, auth, orchestra, net, svc, account, config };
}

function chargeRow(over: Partial<PosCharge> = {}): PosCharge {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    amountSats: CHARGE_SATS,
    status: 'pending',
    createdAt: new Date(clock),
    expiresAt: new Date(clock + POS_CHARGE_TTL_MS),
    paidAt: null,
    sparkInvoice: null,
    ...over,
  };
}

function paymentRow(over: Partial<ShopPayment> = {}): ShopPayment {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    amountSats: SATS,
    posChargeId: null,
    bolt11: 'lnbc-row',
    paymentHash: nextHash(),
    bolt11ExpiresAt: new Date(T0 + 3_600_000),
    status: 'open',
    endReason: null,
    windowEndsAt: new Date(T0 + 300_000),
    replacements: 0,
    nextSettleAt: new Date(T0 + 5_000),
    nextHistoryAt: null,
    historyOffset: 0,
    successorWaitUntil: null,
    createdAt: new Date(T0),
    acceptedAt: null,
    paidAt: null,
    endedAt: null,
    closedAt: null,
    ...over,
  };
}

let offerSeq = 0;

function offerRow(quoteId: string, over: Partial<ShopOffer> = {}): ShopOffer {
  offerSeq += 1;
  return {
    id: crypto.randomUUID(),
    quoteId,
    method: 'Polygon',
    chainId: 137,
    asset: 'USDT',
    tokenAddress: SHOP_METHODS[3]!.contracts.USDT,
    depositAddress: `0x${(0xe0000000 + offerSeq).toString(16).padStart(40, '0')}`,
    amountIn: '1000',
    requiredAmountIn: '990',
    maxAcceptedAmountIn: '1010',
    decimals: 6,
    minFee: '1200000008',
    providerRef: `oq-row-${offerSeq}`,
    idempotencyKey: `key-${offerSeq}`,
    expiresAt: new Date(T0 + 120_000),
    detailIssuedAt: null,
    createdAt: new Date(T0),
    ...over,
  };
}

let proofSeq = 0;

function proofRow(over: Partial<ShopProof> & Pick<ShopProof, 'offerId' | 'paymentId'>): ShopProof {
  proofSeq += 1;
  return {
    id: crypto.randomUUID(),
    source: 'tx',
    chainId: 137,
    txHash: `0x${proofSeq.toString(16).padStart(64, '0')}`,
    logIndex: 0,
    userOpHash: null,
    rawHex: null,
    transferAmount: '1000',
    idempotencyKey: `pk-${proofSeq}`,
    result: null,
    providerOrder: null,
    supersededByOrder: null,
    orderStatus: null,
    orderFoundAt: null,
    refusal: null,
    submitStopped: false,
    sentAt: null,
    lastSubmitAt: null,
    giveUpAt: new Date(T0 + DAY_MS),
    nextSubmitAt: null,
    nextReceiptAt: null,
    nextStatusAt: null,
    tries: 0,
    resolvedAt: null,
    createdAt: new Date(clock + proofSeq),
    ...over,
  };
}

async function readPayment(h: Harness, id: string): Promise<ShopPayment> {
  const row = await h.store.transaction((tx) => tx.getPayment(id));
  if (row === null) {
    throw new Error('payment');
  }
  return row;
}

async function quotesOf(h: Harness, id: string): Promise<ShopQuote[]> {
  return h.store.transaction((tx) => tx.quotesOf(id));
}

async function payerPayment(h: Harness, sats = SATS): Promise<ShopPayment> {
  const created = await h.svc.createForPayer(h.account, USER, sats, clock);
  if (created.kind !== 'payment') {
    throw new Error(`creation ${created.kind}`);
  }
  return created.payment;
}

const NO_QUERY: ShopPayLinkQuery = { timeout: null, method: null, asset: null, repeated: false };

async function bodyOf(
  answer: ShopPayLinkAnswer,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  if (answer.kind !== 'response') {
    throw new Error('not a response');
  }
  const text = await answer.response.text();
  return {
    status: answer.response.status,
    text,
    json: JSON.parse(text) as Record<string, unknown>,
  };
}

async function responseJson(
  response: Response,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  clock = T0;
  sleepCalls = [];
  sleepImpl = defaultSleep;
  events = [];
  vi.spyOn(log, 'logEvent').mockImplementation((event, fields) => {
    events.push({ event, fields });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Methods ───────────────────────────────────────────────────────────────

describe('method table and pair order (Methods)', () => {
  it('is exactly the contract table: names, chain ids, Orchestra chains, contracts, decimals', () => {
    expect(
      SHOP_METHODS.map((row) => [
        row.method,
        row.chainId,
        row.sourceChain,
        row.contracts.USDT,
        row.contracts.USDC,
        row.decimals,
      ]),
    ).toEqual([
      [
        'Ethereum',
        1,
        'ethereum',
        '0xdac17f958d2ee523a2206206994597c13d831ec7',
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        6,
      ],
      [
        'Arbitrum',
        42161,
        'arbitrum',
        '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        6,
      ],
      [
        'Optimism',
        10,
        'optimism',
        '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
        '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
        6,
      ],
      [
        'Polygon',
        137,
        'polygon',
        '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
        6,
      ],
      [
        'Base',
        8453,
        'base',
        '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        6,
      ],
      [
        'BinanceSmartChain',
        56,
        'bsc',
        '0x55d398326f99059ff775485246999027b3197955',
        '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
        18,
      ],
    ]);
    expect(SHOP_ASSETS).toEqual(['USDT', 'USDC']);
  });

  it('requests USDT on Ethereum, Arbitrum, Polygon first, then the rest in table order, USDT before USDC', () => {
    expect(shopPairOrder().map((pair) => `${pair.method.method}/${pair.asset}`)).toEqual([
      'Ethereum/USDT',
      'Arbitrum/USDT',
      'Polygon/USDT',
      'Ethereum/USDC',
      'Arbitrum/USDC',
      'Optimism/USDT',
      'Optimism/USDC',
      'Polygon/USDC',
      'Base/USDT',
      'Base/USDC',
      'BinanceSmartChain/USDT',
      'BinanceSmartChain/USDC',
    ]);
  });

  it('matches a request method without regard to case and knows no other name', () => {
    expect(shopMethodByName('binancesmartchain')?.method).toBe('BinanceSmartChain');
    expect(shopMethodByName('POLYGON')?.chainId).toBe(137);
    expect(shopMethodByName('Tron')).toBeUndefined();
    expect(shopMethodByName('Lightning')).toBeUndefined();
  });

  it('offers a pair only when the route list names it with the table values, lightning:BTC, and an RPC endpoint', () => {
    const rpc = new Map(SHOP_METHODS.map((method) => [method.chainId, RPC(method.chainId)]));
    expect(candidatePairs(defaultRoutes(), rpc, 'pay-1')).toHaveLength(12);

    const routes = defaultRoutes().map((route) => {
      if (route.chain === 'ethereum' && route.asset === 'USDT') {
        return { ...route, contractAddress: '0x0000000000000000000000000000000000000001' };
      }
      if (route.chain === 'arbitrum' && route.asset === 'USDT') {
        return { ...route, decimals: 18 };
      }
      if (route.chain === 'polygon' && route.asset === 'USDT') {
        return { ...route, exactOutToLightning: false };
      }
      if (route.chain === 'base' && route.asset === 'USDC') {
        return { ...route, contractAddress: null };
      }
      return route;
    });
    const withoutBsc = routes.filter((route) => !(route.chain === 'bsc' && route.asset === 'USDC'));
    const noOptimismRpc = new Map(rpc);
    noOptimismRpc.delete(10);
    const pairs = candidatePairs(withoutBsc, noOptimismRpc, 'pay-1');
    expect(pairs.map((pair) => `${pair.method.method}/${pair.asset}`)).toEqual([
      'Ethereum/USDC',
      'Arbitrum/USDC',
      'Polygon/USDC',
      'Base/USDT',
      'BinanceSmartChain/USDT',
    ]);
    expect(eventsNamed('shop.route.mismatch').map((entry) => entry.fields)).toEqual([
      { paymentId: 'pay-1', method: 'Ethereum', asset: 'USDT' },
      { paymentId: 'pay-1', method: 'Arbitrum', asset: 'USDT' },
      { paymentId: 'pay-1', method: 'Base', asset: 'USDC' },
    ]);
  });
});

// ─── Amounts and bodies ────────────────────────────────────────────────────

describe('amounts, pay request, and error bodies (Open amount, Error bodies)', () => {
  it('writes amounts from integers without exponent, trailing zero, or point for a whole number', () => {
    expect(decimalAmount(1000n, 8)).toBe('0.00001');
    expect(decimalAmount(1_500_000n, 6)).toBe('1.5');
    expect(decimalAmount(12_000_000n, 6)).toBe('12');
    expect(decimalAmount(0n, 6)).toBe('0');
    expect(decimalAmount(1_234_000_000_000_000_000n, 18)).toBe('1.234');
    expect(decimalAmount(12n, 0)).toBe('12');
    expect(decimalAmount(0n, 0)).toBe('0');
    expect(decimalAmount(1n, 18)).toBe('0.000000000000000001');
    expect(btcAmount(1)).toBe('0.00000001');
    expect(btcAmount(0)).toBe('0');
    expect(btcAmount(2100)).toBe('0.000021');
    expect(btcAmount(100_000_000)).toBe('1');
    expect(btcAmount(2_100_000_000_000_000)).toBe('21000000');
    expect(() => btcAmount(1.5)).toThrow('sats must be a non-negative integer');
  });

  it('writes requestedAmount as a JSON number in plain notation, never 1e-8', () => {
    const text = shopJson({
      a: new PlainJsonNumber(btcAmount(1)),
      b: 'x',
      c: [new PlainJsonNumber('12')],
    });
    expect(text).toBe('{"a":0.00000001,"b":"x","c":[12]}');
    expect(text).not.toContain('e-');
  });

  it('serves the shop LNURL headers on every response', async () => {
    const response = shopResponse({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(SHOP_LNURL_HEADERS['Cache-Control']).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('uses one error body with statusCode, message, error, status ERROR, and reason', async () => {
    expect(shopErrorBody(400, 'Payment was not accepted')).toEqual({
      statusCode: 400,
      message: 'Payment was not accepted',
      error: 'Payment was not accepted',
      status: 'ERROR',
      reason: 'Payment was not accepted',
    });
    const response = shopError(404, 'Quote expired');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(shopErrorBody(404, 'Quote expired'));
  });

  it('answers no pending payment with the body of the standard example', () => {
    expect(noPendingPaymentBody('shop', 'Corner Shop')).toEqual({
      id: 'shop',
      displayName: 'Corner Shop',
      standard: 'OpenCryptoPay',
      possibleStandards: ['OpenCryptoPay'],
      displayQr: false,
      recipient: { name: 'Corner Shop' },
      statusCode: 404,
      message: 'No pending payment found',
      error: 'Not Found',
      status: 'ERROR',
      reason: 'No pending payment found',
    });
  });

  it('excludes the usernames invoice, cb, and any name ending in a dot', () => {
    expect(isExcludedShopUsername('invoice')).toBe(true);
    expect(isExcludedShopUsername('cb')).toBe(true);
    expect(isExcludedShopUsername('old.')).toBe(true);
    expect(isExcludedShopUsername('tx')).toBe(false);
    expect(isExcludedShopUsername('shop')).toBe(false);
  });

  it('lists Lightning first, then offered methods in table order with USDT before USDC', () => {
    expect(lightningTransferAmount(1000)).toEqual({
      method: 'Lightning',
      minFee: 0,
      assets: [{ asset: 'BTC', amount: '0.00001' }],
      available: true,
    });
    const quoteId = 'q';
    const offers = [
      offerRow(quoteId, {
        method: 'BinanceSmartChain',
        chainId: 56,
        asset: 'USDC',
        decimals: 18,
        amountIn: '1500000000000000000',
        minFee: '7',
      }),
      offerRow(quoteId, {
        method: 'Ethereum',
        chainId: 1,
        asset: 'USDC',
        amountIn: '1234000',
        minFee: '5',
      }),
      offerRow(quoteId, {
        method: 'Ethereum',
        chainId: 1,
        asset: 'USDT',
        amountIn: '1234001',
        minFee: '5',
      }),
      offerRow(quoteId, { method: 'Polygon', asset: 'USDT', amountIn: '12000000', minFee: '3' }),
    ];
    expect(transferAmountsFor(1000, offers)).toEqual([
      lightningTransferAmount(1000),
      {
        method: 'Ethereum',
        minFee: 5,
        assets: [
          { asset: 'USDT', amount: '1.234001' },
          { asset: 'USDC', amount: '1.234' },
        ],
        available: true,
      },
      { method: 'Polygon', minFee: 3, assets: [{ asset: 'USDT', amount: '12' }], available: true },
      {
        method: 'BinanceSmartChain',
        minFee: 7,
        assets: [{ asset: 'USDC', amount: '1.5' }],
        available: true,
      },
    ]);
  });

  it('sets quote.expiration to the earliest of window end and offer expiry minus 30 s; window end when Lightning-only', () => {
    const windowEnds = new Date(T0 + 300_000);
    expect(quoteExpiration(windowEnds, []).toISOString()).toBe(windowEnds.toISOString());
    const offers = [
      offerRow('q', { expiresAt: new Date(T0 + 120_000) }),
      offerRow('q', { expiresAt: new Date(T0 + 100_000) }),
    ];
    expect(quoteExpiration(windowEnds, offers).getTime()).toBe(T0 + 70_000);
    expect(quoteExpiration(new Date(T0 + 50_000), offers).getTime()).toBe(T0 + 50_000);
  });

  it('builds the EIP-681 detail with lowercase contract, decimal chain id, and the proof URL as the last text', () => {
    const offer = offerRow('q', {
      method: 'BinanceSmartChain',
      chainId: 56,
      tokenAddress: '0x55d398326f99059ff775485246999027b3197955',
      depositAddress: '0x00000000000000000000000000000000000000ab',
      amountIn: '1234000000000000000',
    });
    expect(offerUri(offer)).toBe(
      'ethereum:0x55d398326f99059ff775485246999027b3197955@56/transfer?address=0x00000000000000000000000000000000000000ab&uint256=1234000000000000000',
    );
    expect(proofUrl('https://example.test', 'shop')).toBe('https://example.test/lnurlp/tx/shop');
    const quote: ShopQuote = {
      id: 'q',
      paymentId: 'p',
      expiresAt: new Date(T0 + 90_000),
      transferAmounts: [],
      createdAt: new Date(T0),
    };
    const detail = offerDetail(offer, quote, 'https://example.test', 'shop');
    expect(detail).toEqual({
      expiryDate: '2026-10-17T10:01:30.000Z',
      blockchain: 'BinanceSmartChain',
      uri: offerUri(offer),
      hint: 'Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to https://example.test/lnurlp/tx/shop',
    });
    expect(detail.hint.endsWith('/lnurlp/tx/shop')).toBe(true);
  });

  it('builds the complete pay request body of the table', () => {
    const payment = paymentRow({ amountSats: 1000 });
    const quote: ShopQuote = {
      id: 'q-1',
      paymentId: payment.id,
      expiresAt: new Date(T0 + 90_000),
      transferAmounts: [lightningTransferAmount(1000)],
      createdAt: new Date(T0),
    };
    const body = shopPayRequest({
      username: 'shop',
      name: 'Corner Shop',
      metadata: METADATA,
      publicBaseUrl: 'https://example.test',
      payment,
      quote,
    });
    expect(JSON.parse(shopJson(body))).toEqual({
      id: 'shop',
      tag: 'payRequest',
      callback: 'https://example.test/lnurlp/cb/shop',
      minSendable: 1_000_000,
      maxSendable: 1_000_000,
      metadata: METADATA,
      displayName: 'Corner Shop',
      standard: 'OpenCryptoPay',
      possibleStandards: ['OpenCryptoPay'],
      displayQr: false,
      recipient: { name: 'Corner Shop' },
      quote: { id: 'q-1', expiration: '2026-10-17T10:01:30.000Z', payment: payment.id },
      requestedAmount: { asset: 'BTC', amount: 0.00001 },
      transferAmounts: [lightningTransferAmount(1000)],
    });
    expect(shopJson(body)).toContain('"requestedAmount":{"asset":"BTC","amount":0.00001}');
  });

  it('names the shop by its trimmed account name, else its username', () => {
    expect(shopName({ name: '  Corner Shop ' }, 'shop')).toBe('Corner Shop');
    expect(shopName({ name: '   ' }, 'shop')).toBe('shop');
    expect(shopName({ name: null }, 'shop')).toBe('shop');
  });
});

// ─── Offer checks ──────────────────────────────────────────────────────────

describe('offer checks (Offer checks)', () => {
  const polygonUsdt = shopPairOrder()[2]!;
  const deposit = '0x00000000000000000000000000000000000000d1';

  function input(
    over: Partial<OrchestraQuote> = {},
    rest: Partial<OfferCheckInput> = {},
  ): OfferCheckInput {
    return {
      pair: polygonUsdt,
      quote: {
        quoteId: 'oq',
        depositAddress: deposit,
        amountIn: '1234000',
        requiredAmountIn: '1234000',
        maxAcceptedAmountIn: '1234010',
        targetAmountOut: '1234',
        expiresAt: new Date(T0 + 120_000).toISOString(),
        transaction: {
          chainId: 137,
          to: polygonUsdt.method.contracts.USDT,
          data: erc20TransferData(deposit, 1_234_000n),
          value: '0',
        },
        ...over,
      },
      amountSats: 1234,
      bolt11ExpiresAtMs: T0 + 3_600_000,
      batchDeposits: new Set(),
      usdPerBtc: '100000',
      nowMs: T0,
      ...rest,
    };
  }

  it('accepts a quote that passes every check', () => {
    expect(checkOffer(input())).toBeNull();
    expect(checkOffer(input({ requiredAmountIn: null, maxAcceptedAmountIn: null }))).toBeNull();
    expect(
      checkOffer(
        input({
          transaction: {
            ...input().quote.transaction!,
            to: polygonUsdt.method.contracts.USDT.toUpperCase().replace('0X', '0x'),
            value: '000',
          },
        }),
      ),
    ).toBeNull();
  });

  it('requires targetAmountOut to equal the sat count', () => {
    expect(checkOffer(input({ targetAmountOut: '1235' }))).toBe('target');
    expect(checkOffer(input({ targetAmountOut: null }))).toBe('target');
  });

  it('requires amountIn to be a positive integer string', () => {
    expect(checkOffer(input({ amountIn: '0' }))).toBe('amount');
    expect(checkOffer(input({ amountIn: '01234000' }))).toBe('amount');
    expect(checkOffer(input({ amountIn: '1.5' }))).toBe('amount');
  });

  it('requires requiredAmountIn <= amountIn <= maxAcceptedAmountIn when present', () => {
    expect(checkOffer(input({ requiredAmountIn: '1234001' }))).toBe('bounds');
    expect(checkOffer(input({ maxAcceptedAmountIn: '1233999' }))).toBe('bounds');
    expect(checkOffer(input({ requiredAmountIn: 'x' }))).toBe('bounds');
    expect(checkOffer(input({ maxAcceptedAmountIn: '-1' }))).toBe('bounds');
    // Each limit applies on its own.
    expect(checkOffer(input({ requiredAmountIn: '1234001', maxAcceptedAmountIn: null }))).toBe(
      'bounds',
    );
    expect(checkOffer(input({ requiredAmountIn: null, maxAcceptedAmountIn: '1233999' }))).toBe(
      'bounds',
    );
  });

  it('requires the transaction on the table chain id', () => {
    expect(checkOffer(input({ transaction: null }))).toBe('chain');
    expect(checkOffer(input({ transaction: { ...input().quote.transaction!, chainId: 1 } }))).toBe(
      'chain',
    );
  });

  it('requires transaction.to to equal the table contract', () => {
    expect(
      checkOffer(
        input({
          transaction: { ...input().quote.transaction!, to: polygonUsdt.method.contracts.USDC },
        }),
      ),
    ).toBe('token');
  });

  it('requires transaction.value to be zero, decimal or hex', () => {
    const tx = input().quote.transaction!;
    for (const value of ['0', '000', '0x0', '0X00']) {
      expect(checkOffer(input({ transaction: { ...tx, value } }))).toBeNull();
    }
    for (const value of ['1', '0x1', '0x', '']) {
      expect(checkOffer(input({ transaction: { ...tx, value } }))).toBe('value');
    }
  });

  it('requires 68 bytes of transfer(depositAddress, amountIn)', () => {
    const tx = input().quote.transaction!;
    expect(checkOffer(input({ transaction: { ...tx, data: '0x1234' } }))).toBe('data');
    expect(
      checkOffer(
        input({
          transaction: {
            ...tx,
            data: erc20TransferData('0x00000000000000000000000000000000000000d2', 1_234_000n),
          },
        }),
      ),
    ).toBe('data');
    expect(
      checkOffer(input({ transaction: { ...tx, data: erc20TransferData(deposit, 1_234_001n) } })),
    ).toBe('data');
    // 68 bytes with another selector, non-zero address padding, or one byte more.
    const good = erc20TransferData(deposit, 1_234_000n);
    for (const data of [
      `0xffffffff${good.slice(10)}`,
      `0x23b872dd${good.slice(10)}`,
      `${good.slice(0, 10)}ff${good.slice(12)}`,
      `${good}00`,
    ]) {
      expect(checkOffer(input({ transaction: { ...tx, data } }))).toBe('data');
    }
  });

  it('refuses a deposit address already used in the same batch', () => {
    expect(checkOffer(input({}, { batchDeposits: new Set([deposit]) }))).toBe('deposit_shared');
  });

  it('requires expiresAt minus the funding margin to be at least 45 s ahead', () => {
    expect(checkOffer(input({ expiresAt: new Date(T0 + 75_000).toISOString() }))).toBeNull();
    expect(checkOffer(input({ expiresAt: new Date(T0 + 74_999).toISOString() }))).toBe('expiry');
    expect(checkOffer(input({ expiresAt: 'not a date' }))).toBe('expiry');
  });

  it('requires the BOLT11 to expire at least 600 s after expiresAt', () => {
    expect(checkOffer(input({}, { bolt11ExpiresAtMs: T0 + 720_000 }))).toBeNull();
    expect(checkOffer(input({}, { bolt11ExpiresAtMs: T0 + 719_999 }))).toBe('bolt11_margin');
  });

  it('limits amountIn in USD to 5 % above the sats value at a fresh spot', () => {
    // 1234 sats; 1.234 USDT. 1.05 × 1234e-8 × R >= 1.234 ⇔ R >= 95238.095…
    expect(checkOffer(input({}, { usdPerBtc: '95238.1' }))).toBeNull();
    expect(checkOffer(input({}, { usdPerBtc: '95238' }))).toBe('price');
    expect(checkOffer(input({}, { usdPerBtc: '100000' }))).toBeNull();
  });

  it('fails the price check without a fresh rate or with a rate parseUsdPerBtc refuses', () => {
    expect(checkOffer(input({}, { usdPerBtc: null }))).toBe('price');
    for (const usdPerBtc of ['', 'abc', '1e5', '-100000', '100,000']) {
      expect(checkOffer(input({}, { usdPerBtc }))).toBe('price');
    }
  });

  it('passes amountIn exactly at the 5 % bound and fails one unit above, for 6 and 18 decimals', () => {
    const bsc = shopPairOrder().find(
      (pair) => pair.method.method === 'BinanceSmartChain' && pair.asset === 'USDT',
    )!;
    // amountIn × 10^16 × 100 <= sats × rate × 10^decimals × 105, rate = 100000 × 10^8.
    const cases: [ShopPair, bigint][] = [
      [polygonUsdt, 1_295_700n],
      [bsc, 1_295_700_000_000_000_000n],
    ];
    for (const [pair, bound] of cases) {
      for (const [amountIn, expected] of [
        [bound, null],
        [bound + 1n, 'price'],
      ] as const) {
        const quote = {
          amountIn: amountIn.toString(),
          requiredAmountIn: null,
          maxAcceptedAmountIn: null,
          transaction: {
            chainId: pair.method.chainId,
            to: pair.method.contracts[pair.asset],
            data: erc20TransferData(deposit, amountIn),
            value: '0',
          },
        };
        expect(checkOffer(input(quote, { pair, usdPerBtc: '100000' }))).toBe(expected);
      }
    }
  });

  it('parses a rate with more than eight decimals through parseUsdPerBtc (half-up at the ninth)', () => {
    // The bound needs rate × 10^8 >= 9523809523809.52…: the ninth decimal 5 rounds
    // 95238.095238095 up to 9523809523810 (passes), 4 keeps 9523809523809 (fails).
    expect(checkOffer(input({}, { usdPerBtc: '95238.095238095' }))).toBeNull();
    expect(checkOffer(input({}, { usdPerBtc: '95238.095238094' }))).toBe('price');
  });
});

// ─── Proof states ──────────────────────────────────────────────────────────

describe('proof state table (States: evaluateProof, recordProofOrder)', () => {
  interface World {
    h: Harness;
    payment: ShopPayment;
    offer: ShopOffer;
  }

  async function world(
    paymentOver: Partial<ShopPayment> = {},
    offerOver: Partial<ShopOffer> = {},
  ): Promise<World> {
    const h = await setup();
    const payment = paymentRow(paymentOver);
    const quote: ShopQuote = {
      id: crypto.randomUUID(),
      paymentId: payment.id,
      expiresAt: new Date(T0 + 90_000),
      transferAmounts: [lightningTransferAmount(SATS)],
      createdAt: new Date(T0),
    };
    const offer = offerRow(quote.id, offerOver);
    await h.store.transaction(async (tx) => {
      await tx.insertPayment(payment);
      await tx.insertQuote(quote);
      await tx.insertOffers([offer]);
    });
    return { h, payment, offer };
  }

  async function addProof(w: World, over: Partial<ShopProof> = {}): Promise<ShopProof> {
    const proof = proofRow({ offerId: w.offer.id, paymentId: w.payment.id, ...over });
    await w.h.store.transaction(async (tx) => {
      expect(await tx.insertProof(proof)).toBe(true);
    });
    return proof;
  }

  async function evaluate(w: World, id: string): Promise<ShopProof | null> {
    return w.h.store.transaction((tx) => evaluateProof(tx, id, clock));
  }

  async function proof(w: World, id: string): Promise<ShopProof> {
    const row = await w.h.store.transaction((tx) => tx.getProof(id));
    if (row === null) {
      throw new Error('proof');
    }
    return row;
  }

  it('returns null for an unknown proof', async () => {
    const w = await world();
    expect(await evaluate(w, crypto.randomUUID())).toBeNull();
  });

  it('lockPaymentForProofs locks the payment row, then its proof rows ordered by id', async () => {
    const w = await world();
    const ids = [
      '00000000-0000-4000-8000-0000000000f3',
      '00000000-0000-4000-8000-0000000000f1',
      '00000000-0000-4000-8000-0000000000f2',
    ];
    for (const id of ids) {
      await addProof(w, { id });
    }
    const calls: string[] = [];
    for (const name of ['lockPayment', 'lockProofs', 'lockAccount'] as const) {
      w.h.store.hooks[name] = async (tx, ...args) => {
        calls.push(name);
        return (tx[name] as (...a: never[]) => Promise<unknown>).apply(tx, args);
      };
    }
    const locked = await w.h.store.transaction((tx) => lockPaymentForProofs(tx, w.payment.id));
    expect(calls).toEqual(['lockPayment', 'lockProofs']);
    expect(locked?.payment.id).toBe(w.payment.id);
    expect(locked?.proofs.map((row) => row.id)).toEqual([...ids].sort());
    calls.length = 0;
    expect(
      await w.h.store.transaction((tx) => lockPaymentForProofs(tx, crypto.randomUUID())),
    ).toBeNull();
    // No proof row is locked for a payment that does not exist.
    expect(calls).toEqual(['lockPayment']);
  });

  it('evaluateProof, refuseProof, and recordProofOrder take no lock themselves (the caller holds them)', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const accepted = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    const p = await addProof(w);
    const calls: string[] = [];
    for (const name of ['lockPayment', 'lockProofs', 'lockAccount', 'lockCharge'] as const) {
      w.h.store.hooks[name] = async (tx, ...args) => {
        calls.push(name);
        return (tx[name] as (...a: never[]) => Promise<unknown>).apply(tx, args);
      };
    }
    await w.h.store.transaction(async (tx) => {
      await recordProofOrder(tx, p.id, { orderId: 'o2', status: 'completed' }, clock);
      await evaluateProof(tx, accepted.id, clock);
      await refuseProof(tx, accepted.id, 'mismatch', clock);
    });
    expect(calls).toEqual([]);
    expect((await proof(w, p.id)).result).toBe('accepted');
  });

  it.each(['open', 'ended'] as const)(
    'row 1: a superseded proof whose order resumed becomes accepted once no proof is accepted, and the %s payment accepted',
    async (status) => {
      const w = await world(
        status === 'ended' ? { status, endReason: 'window', endedAt: new Date(T0) } : {},
      );
      const p = await addProof(w, {
        result: 'superseded',
        providerOrder: 'o1',
        orderStatus: 'processing',
      });
      clock = T0 + 2_000;
      expect(await evaluate(w, p.id)).toMatchObject({
        result: 'accepted',
        resolvedAt: new Date(T0 + 2_000),
      });
      expect(await readPayment(w.h, w.payment.id)).toMatchObject({
        status: 'accepted',
        acceptedAt: new Date(T0 + 2_000),
        endReason: null,
      });
      expect(eventsNamed('shop.proof.accepted').map((entry) => entry.fields)).toEqual([
        {
          paymentId: w.payment.id,
          proofId: p.id,
          offerId: w.offer.id,
          quoteId: w.offer.quoteId,
          providerRef: w.offer.providerRef,
          orderId: 'o1',
        },
      ]);
    },
  );

  it('row 1: a superseded proof stays superseded without a second log line while another proof is accepted', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    await addProof(w, { result: 'accepted', providerOrder: 'o1', orderStatus: 'swapping' });
    const p = await addProof(w, {
      result: 'superseded',
      resolvedAt: new Date(T0),
      providerOrder: 'o2',
      orderStatus: 'delivering',
    });
    expect(await evaluate(w, p.id)).toMatchObject({
      result: 'superseded',
      resolvedAt: new Date(T0),
    });
    expect(eventsNamed('shop.proof.superseded')).toHaveLength(0);
  });

  it('row 1: a superseded proof stays superseded after a unique-index conflict on the accepted proof', async () => {
    const w = await world();
    const p = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    const after = await w.h.store.transaction((tx) => {
      const conflicting = new Proxy(tx, {
        get: (target, prop) => {
          if (prop === 'updateProof') {
            return async () => 'conflict';
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return evaluateProof(conflicting, p.id, clock);
    });
    expect(after?.result).toBe('superseded');
    expect(eventsNamed('shop.proof.superseded')).toHaveLength(0);
  });

  it('a superseded proof with a progressing order after the payment closed stays superseded (late is reached only from null, refused, stuck)', async () => {
    const w = await world({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0),
      closedAt: new Date(T0),
    });
    const p = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    expect((await evaluate(w, p.id))?.result).toBe('superseded');
    expect(eventsNamed('shop.proof.late')).toHaveLength(0);
  });

  it('logs every final proof event with the payment, proof, offer, quote, provider reference, and order', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    const p = await addProof(w, { providerOrder: 'o2', orderStatus: 'completed' });
    const ids = (proofId: string, orderId: string): Record<string, string> => ({
      paymentId: w.payment.id,
      proofId,
      offerId: w.offer.id,
      quoteId: w.offer.quoteId,
      providerRef: w.offer.providerRef,
      orderId,
    });
    expect((await evaluate(w, p.id))?.result).toBe('accepted');
    expect(eventsNamed('shop.proof.superseded').map((entry) => entry.fields)).toEqual([
      ids(first.id, 'o1'),
    ]);
    expect(eventsNamed('shop.proof.accepted').map((entry) => entry.fields)).toEqual([
      ids(p.id, 'o2'),
    ]);
    const failed = await addProof(w, { providerOrder: 'o3', orderStatus: 'failed' });
    await evaluate(w, failed.id);
    expect(eventsNamed('shop.proof.failed').map((entry) => entry.fields)).toEqual([
      ids(failed.id, 'o3'),
    ]);
    expect(eventsNamed('shop.alert.order_failed').map((entry) => entry.fields)).toEqual([
      ids(failed.id, 'o3'),
    ]);
    const unordered = await addProof(w);
    await w.h.store.transaction((tx) => refuseProof(tx, unordered.id, 'mismatch', clock));
    expect(eventsNamed('shop.proof.refused').map((entry) => entry.fields)).toEqual([
      {
        paymentId: w.payment.id,
        proofId: unordered.id,
        offerId: w.offer.id,
        quoteId: w.offer.quoteId,
        providerRef: w.offer.providerRef,
        refusal: 'mismatch',
      },
    ]);
  });

  it('refuseProof: every refusal stops the submits and the receipt reads; only tx_used also stops the order-status duty', async () => {
    const w = await world();
    const schedule = {
      nextSubmitAt: new Date(T0 + 10_000),
      nextReceiptAt: new Date(T0 + 30_000),
      nextStatusAt: new Date(T0 + 10_000),
    };
    const used = await addProof(w, {
      providerOrder: 'o1',
      orderStatus: 'refunding',
      ...schedule,
    });
    const rejected = await addProof(w, {
      providerOrder: 'o2',
      orderStatus: 'refunding',
      ...schedule,
    });
    expect(
      await w.h.store.transaction((tx) => refuseProof(tx, used.id, 'tx_used', clock)),
    ).toMatchObject({
      result: 'refused',
      refusal: 'tx_used',
      providerOrder: 'o1',
      nextSubmitAt: null,
      nextReceiptAt: null,
      nextStatusAt: null,
    });
    expect(
      await w.h.store.transaction((tx) => refuseProof(tx, rejected.id, 'hex_rejected', clock)),
    ).toMatchObject({
      result: 'refused',
      refusal: 'hex_rejected',
      nextSubmitAt: null,
      nextReceiptAt: null,
      nextStatusAt: schedule.nextStatusAt,
    });
  });

  it.each([null, 'refused', 'stuck'] as const)(
    'moves %s to accepted on a progressing order with an amount within the bounds, and the payment to accepted',
    async (from) => {
      const w = await world({ status: 'ended', endReason: 'window', endedAt: new Date(T0) });
      const p = await addProof(w, {
        result: from,
        refusal: from === 'refused' ? 'mismatch' : null,
        providerOrder: 'o1',
        orderStatus: 'swapping',
      });
      clock = T0 + 1_000;
      const after = await evaluate(w, p.id);
      expect(after).toMatchObject({ result: 'accepted', refusal: null });
      expect(after?.resolvedAt?.getTime()).toBe(T0 + 1_000);
      expect(await readPayment(w.h, w.payment.id)).toMatchObject({
        status: 'accepted',
        acceptedAt: new Date(T0 + 1_000),
        endedAt: null,
        endReason: null,
      });
      expect(eventsNamed('shop.proof.accepted')).toHaveLength(1);
      expect(eventsNamed('shop.payment.accepted')).toHaveLength(1);
    },
  );

  it.each(['processing', 'confirming', 'awaiting_approval', 'swapping', 'bridging', 'delivering'])(
    'treats %s as progressing',
    async (status) => {
      const w = await world();
      const p = await addProof(w, { providerOrder: 'o1', orderStatus: status });
      expect((await evaluate(w, p.id))?.result).toBe('accepted');
    },
  );

  it('moves to superseded when another proof of the payment is accepted', async () => {
    const w = await world();
    await addProof(w, { result: 'accepted', providerOrder: 'o1', orderStatus: 'swapping' });
    const p = await addProof(w, { providerOrder: 'o2', orderStatus: 'swapping' });
    expect((await evaluate(w, p.id))?.result).toBe('superseded');
    expect(eventsNamed('shop.proof.superseded')).toHaveLength(1);
  });

  it('treats a unique-index conflict on the accepted proof as superseded', async () => {
    const w = await world();
    const p = await addProof(w, { providerOrder: 'o1', orderStatus: 'swapping' });
    const after = await w.h.store.transaction((tx) => {
      const conflicting = new Proxy(tx, {
        get: (target, prop) => {
          if (prop === 'updateProof') {
            return async (
              id: string,
              where: Parameters<ShopTx['updateProof']>[1],
              patch: Parameters<ShopTx['updateProof']>[2],
            ) => (patch.result === 'accepted' ? 'conflict' : target.updateProof(id, where, patch));
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return evaluateProof(conflicting, p.id, clock);
    });
    expect(after?.result).toBe('superseded');
  });

  it('moves a proof with a progressing order to late after the payment closed, with shop.alert.late_deposit', async () => {
    const w = await world({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0),
      closedAt: new Date(T0),
    });
    const p = await addProof(w, {
      result: 'stuck',
      providerOrder: 'o1',
      orderStatus: 'delivering',
    });
    expect((await evaluate(w, p.id))?.result).toBe('late');
    expect(eventsNamed('shop.proof.late')).toHaveLength(1);
    expect(eventsNamed('shop.alert.late_deposit')).toHaveLength(1);
    // A closed payment is final.
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'window',
      closedAt: new Date(T0),
      acceptedAt: null,
    });
    expect(eventsNamed('shop.payment.accepted')).toHaveLength(0);
  });

  it('holds a proof whose amount is unknown or outside the bounds', async () => {
    const w = await world();
    const unknown = await addProof(w, {
      transferAmount: null,
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    const below = await addProof(w, {
      transferAmount: '989',
      providerOrder: 'o2',
      orderStatus: 'swapping',
    });
    const above = await addProof(w, {
      transferAmount: '1011',
      providerOrder: 'o3',
      orderStatus: 'swapping',
    });
    for (const p of [unknown, below, above]) {
      expect((await evaluate(w, p.id))?.result).toBeNull();
    }
    expect((await readPayment(w.h, w.payment.id)).status).toBe('open');
  });

  it('uses amountIn as both bounds when required and max are absent', async () => {
    const w = await world({}, { requiredAmountIn: null, maxAcceptedAmountIn: null });
    const p = await addProof(w, { transferAmount: '1000' });
    expect(proofWithinBounds(p, w.offer)).toBe(true);
    expect(proofWithinBounds({ ...p, transferAmount: '999' }, w.offer)).toBe(false);
    expect(proofWithinBounds({ ...p, transferAmount: '1001' }, w.offer)).toBe(false);
    expect(proofWithinBounds({ ...p, transferAmount: null }, w.offer)).toBe(false);
  });

  it('holds a proof on refunding, unfulfilled, an unknown status, or no order', async () => {
    const w = await world();
    const ids = [
      (await addProof(w, { providerOrder: 'o1', orderStatus: 'refunding' })).id,
      (await addProof(w, { providerOrder: 'o2', orderStatus: 'unfulfilled' })).id,
      (await addProof(w, { providerOrder: 'o3', orderStatus: 'teleporting' })).id,
      (await addProof(w)).id,
    ];
    for (const id of ids) {
      expect((await evaluate(w, id))?.result).toBeNull();
    }
  });

  it('keeps an accepted proof accepted through refunding and an unknown status', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'refunding',
    });
    expect((await evaluate(w, p.id))?.result).toBe('accepted');
    await w.h.store.transaction((tx) => tx.updateProof(p.id, {}, { orderStatus: 'mystery' }));
    expect((await evaluate(w, p.id))?.result).toBe('accepted');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('accepted');
  });

  it('holds a progressing proof of a paid payment; only completed accepts it', async () => {
    const w = await world({ status: 'paid', paidAt: new Date(T0) });
    const p = await addProof(w, { providerOrder: 'o1', orderStatus: 'swapping' });
    expect((await evaluate(w, p.id))?.result).toBeNull();
    await w.h.store.transaction((tx) => tx.updateProof(p.id, {}, { orderStatus: 'completed' }));
    expect((await evaluate(w, p.id))?.result).toBe('accepted');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('paid');
  });

  it.each(['superseded', 'late', 'refused', 'stuck', null] as const)(
    'moves %s to accepted when its order completes; the earlier accepted proof moves to superseded first',
    async (from) => {
      const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
      const first = await addProof(w, {
        result: 'accepted',
        providerOrder: 'o1',
        orderStatus: 'swapping',
      });
      const p = await addProof(w, {
        result: from,
        providerOrder: 'o2',
        orderStatus: 'completed',
        transferAmount: '5',
      });
      expect((await evaluate(w, p.id))?.result).toBe('accepted');
      expect((await proof(w, first.id)).result).toBe('superseded');
      expect((await readPayment(w.h, w.payment.id)).status).toBe('accepted');
    },
  );

  it('accepts a completed order of an ended payment and moves the payment to accepted, but never a closed one', async () => {
    const ended = await world({ status: 'ended', endReason: 'replaced', endedAt: new Date(T0) });
    const p1 = await addProof(ended, { providerOrder: 'o1', orderStatus: 'completed' });
    expect((await evaluate(ended, p1.id))?.result).toBe('accepted');
    expect((await readPayment(ended.h, ended.payment.id)).status).toBe('accepted');

    const closed = await world({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0),
      closedAt: new Date(T0),
    });
    const p2 = await addProof(closed, { providerOrder: 'o2', orderStatus: 'completed' });
    expect((await evaluate(closed, p2.id))?.result).toBe('accepted');
    expect((await readPayment(closed.h, closed.payment.id)).status).toBe('ended');
  });

  it('leaves a failed proof failed when its order reports completed (no row allows it)', async () => {
    const w = await world();
    const p = await addProof(w, {
      result: 'failed',
      providerOrder: 'o1',
      orderStatus: 'completed',
    });
    expect((await evaluate(w, p.id))?.result).toBe('failed');
  });

  it('a completed order on a proof that cannot become accepted leaves the accepted proof and the payment alone', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'swapping',
    });
    const failed = await addProof(w, {
      result: 'failed',
      providerOrder: 'o2',
      orderStatus: 'completed',
    });
    expect((await evaluate(w, failed.id))?.result).toBe('failed');
    expect((await proof(w, first.id)).result).toBe('accepted');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('accepted');
    expect(eventsNamed('shop.proof.superseded')).toHaveLength(0);
  });

  it('re-reads the proof when the accepted update of a completed order does not apply', async () => {
    const w = await world();
    const p = await addProof(w, { providerOrder: 'o1', orderStatus: 'completed' });
    const after = await w.h.store.transaction((tx) => {
      const refusing = new Proxy(tx, {
        get: (target, prop) => {
          if (prop === 'updateProof') {
            // Another step wins first: it records the proof refunded.
            return async (id: string) => {
              await target.updateProof(id, {}, { result: 'refunded', resolvedAt: new Date(clock) });
              return 'conflict';
            };
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return evaluateProof(refusing, p.id, clock);
    });
    expect(after?.result).toBe('refunded');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('open');
    expect(eventsNamed('shop.proof.accepted')).toHaveLength(0);
  });

  it('returns an already final proof unchanged', async () => {
    const w = await world();
    const p = await addProof(w, {
      result: 'refunded',
      providerOrder: 'o1',
      orderStatus: 'refunded',
    });
    expect((await evaluate(w, p.id))?.result).toBe('refunded');
  });

  it.each(['accepted', 'superseded', 'late', 'refused', 'stuck', null] as const)(
    'moves %s to refunded when the order is refunded',
    async (from) => {
      const w = await world(
        from === 'accepted' ? { status: 'accepted', acceptedAt: new Date(T0) } : {},
      );
      const p = await addProof(w, { result: from, providerOrder: 'o1', orderStatus: 'refunded' });
      expect((await evaluate(w, p.id))?.result).toBe('refunded');
      expect(eventsNamed('shop.proof.refunded')).toHaveLength(1);
      if (from === 'accepted') {
        expect(await readPayment(w.h, w.payment.id)).toMatchObject({
          status: 'ended',
          endReason: 'orchestra_refunded',
        });
      }
    },
  );

  it.each([
    ['failed', 'orchestra_failed'],
    ['fallback_delivered', 'orchestra_failed'],
  ] as const)(
    'moves an accepted proof to failed on %s with shop.alert.order_failed; the payment ends %s',
    async (status, reason) => {
      const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
      const p = await addProof(w, { result: 'accepted', providerOrder: 'o1', orderStatus: status });
      expect((await evaluate(w, p.id))?.result).toBe('failed');
      expect(eventsNamed('shop.alert.order_failed')).toHaveLength(1);
      expect(await readPayment(w.h, w.payment.id)).toMatchObject({
        status: 'ended',
        endReason: reason,
        endedAt: new Date(clock),
      });
    },
  );

  it.each(['superseded', 'late', 'refused', 'stuck', null] as const)(
    'moves %s to failed on a failed order',
    async (from) => {
      const w = await world();
      const p = await addProof(w, { result: from, providerOrder: 'o1', orderStatus: 'failed' });
      expect((await evaluate(w, p.id))?.result).toBe('failed');
    },
  );

  it.each(['accepted', 'superseded', 'late', 'stuck', null] as const)(
    'moves %s to refused with refusal expired_order on an expired order',
    async (from) => {
      const w = await world(
        from === 'accepted' ? { status: 'accepted', acceptedAt: new Date(T0) } : {},
      );
      const p = await addProof(w, { result: from, providerOrder: 'o1', orderStatus: 'expired' });
      expect(await evaluate(w, p.id)).toMatchObject({
        result: 'refused',
        refusal: 'expired_order',
      });
      if (from === 'accepted') {
        expect(await readPayment(w.h, w.payment.id)).toMatchObject({
          status: 'ended',
          endReason: 'proof_refused',
        });
      }
    },
  );

  it.each([
    ['failed', 'refunded'],
    ['refunded', 'failed'],
    ['refunded', 'fallback_delivered'],
    ['refunded', 'expired'],
    ['failed', 'expired'],
    ['refunded', 'completed'],
  ] as const)(
    'keeps a %s proof when its order reports %s (no row of the table allows it)',
    async (from, status) => {
      const w = await world();
      const p = await addProof(w, { result: from, providerOrder: 'o1', orderStatus: status });
      expect(await evaluate(w, p.id)).toMatchObject({ result: from, refusal: null });
      expect(events.filter((entry) => entry.event.startsWith('shop.proof.'))).toHaveLength(0);
    },
  );

  it('row 3: the oldest superseded proof with a progressing order and an amount within the bounds takes the place of a refunded accepted proof', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'refunded',
    });
    const held = await addProof(w, { providerOrder: 'o2', orderStatus: 'swapping' });
    const unknownAmount = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o3',
      orderStatus: 'swapping',
      transferAmount: null,
    });
    const notProgressing = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o4',
      orderStatus: 'unfulfilled',
    });
    const noStatus = await addProof(w, { result: 'superseded' });
    const taker = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o5',
      orderStatus: 'delivering',
    });
    const younger = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o6',
      orderStatus: 'delivering',
    });
    clock = T0 + 7_000;
    expect((await evaluate(w, first.id))?.result).toBe('refunded');
    // Only a superseded proof takes the place; a held proof is not re-evaluated.
    expect((await proof(w, held.id)).result).toBeNull();
    for (const id of [unknownAmount.id, notProgressing.id, noStatus.id, younger.id]) {
      expect((await proof(w, id)).result).toBe('superseded');
    }
    expect(await proof(w, taker.id)).toMatchObject({
      result: 'accepted',
      resolvedAt: new Date(T0 + 7_000),
    });
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'accepted',
      acceptedAt: new Date(T0),
    });
    expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
    expect(eventsNamed('shop.payment.accepted')).toHaveLength(0);
    expect(eventsNamed('shop.proof.accepted').map((entry) => entry.fields)).toEqual([
      {
        paymentId: w.payment.id,
        proofId: taker.id,
        offerId: w.offer.id,
        quoteId: w.offer.quoteId,
        providerRef: w.offer.providerRef,
        orderId: 'o5',
      },
    ]);
  });

  it('row 3: of two superseded proofs created at the same time the lower id takes the place', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'failed',
    });
    const createdAt = new Date(T0 + 500);
    const ids = ['00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b1'];
    for (const [index, id] of ids.entries()) {
      await addProof(w, {
        id,
        result: 'superseded',
        providerOrder: `t${index}`,
        orderStatus: 'swapping',
        createdAt,
      });
    }
    expect((await evaluate(w, first.id))?.result).toBe('failed');
    expect((await proof(w, ids[1]!)).result).toBe('accepted');
    expect((await proof(w, ids[0]!)).result).toBe('superseded');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('accepted');
  });

  it('row 3: no superseded proof takes the place of the accepted proof of a closed payment', async () => {
    const w = await world({
      status: 'accepted',
      acceptedAt: new Date(T0),
      closedAt: new Date(T0),
    });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'refunded',
    });
    const next = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o2',
      orderStatus: 'swapping',
    });
    expect((await evaluate(w, first.id))?.result).toBe('refunded');
    expect((await proof(w, next.id)).result).toBe('superseded');
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'orchestra_refunded',
    });
  });

  it('ends the payment when no other proof takes the place of the lost accepted proof', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const first = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'refunded',
    });
    await addProof(w, { providerOrder: 'o2', orderStatus: 'refunding' });
    expect((await evaluate(w, first.id))?.result).toBe('refunded');
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'orchestra_refunded',
    });
    expect(eventsNamed('shop.payment.ended').map((entry) => entry.fields)).toEqual([
      { paymentId: w.payment.id, reason: 'orchestra_refunded' },
    ]);
  });

  it('leaves a paid payment paid when its accepted proof is refunded, and no superseded proof takes the place', async () => {
    const w = await world({ status: 'paid', paidAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: 'o1',
      orderStatus: 'refunded',
    });
    const next = await addProof(w, {
      result: 'superseded',
      providerOrder: 'o2',
      orderStatus: 'swapping',
    });
    expect((await evaluate(w, p.id))?.result).toBe('refunded');
    expect((await proof(w, next.id)).result).toBe('superseded');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('paid');
    expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
  });

  it('records an order: id, status, found time, first status read in 10 s, no further submit', async () => {
    const w = await world();
    const p = await addProof(w, { nextSubmitAt: new Date(T0 + 30_000) });
    const after = await w.h.store.transaction((tx) =>
      recordProofOrder(tx, p.id, { orderId: 'o1', status: 'processing' }, clock),
    );
    expect(after).toMatchObject({
      providerOrder: 'o1',
      orderStatus: 'processing',
      orderFoundAt: new Date(T0),
      nextStatusAt: new Date(T0 + 10_000),
      nextSubmitAt: null,
      result: 'accepted',
    });
    clock = T0 + 5_000;
    const again = await w.h.store.transaction((tx) =>
      recordProofOrder(tx, p.id, { orderId: 'o1', status: 'completed' }, clock),
    );
    // A final status ends the status watch.
    expect(again).toMatchObject({
      orderStatus: 'completed',
      orderFoundAt: new Date(T0),
      nextStatusAt: null,
    });
  });

  it('a first order that is already final takes its row at once and is not watched', async () => {
    const w = await world();
    const p = await addProof(w);
    const after = await w.h.store.transaction((tx) =>
      recordProofOrder(tx, p.id, { orderId: crypto.randomUUID(), status: 'refunded' }, clock),
    );
    expect(after).toMatchObject({
      result: 'refunded',
      nextStatusAt: null,
      orderFoundAt: new Date(T0),
    });
  });

  it('returns conflict when another proof holds the order id, and null for an unknown proof', async () => {
    const w = await world();
    await addProof(w, { providerOrder: 'o1', orderStatus: 'refunding' });
    const p = await addProof(w);
    expect(
      await w.h.store.transaction((tx) =>
        recordProofOrder(tx, p.id, { orderId: 'o1', status: 'swapping' }, clock),
      ),
    ).toBe('conflict');
    expect((await proof(w, p.id)).providerOrder).toBeNull();
    expect(
      await w.h.store.transaction((tx) =>
        recordProofOrder(tx, crypto.randomUUID(), { orderId: 'o9', status: 'swapping' }, clock),
      ),
    ).toBeNull();
  });

  it('logs an unknown order status once per order id as shop.orchestra.error and holds the proof (503 path)', async () => {
    const w = await world();
    const p = await addProof(w);
    for (const status of ['refunding', 'unfulfilled', 'swapping', 'completed']) {
      const other = await addProof(w);
      await w.h.store.transaction((tx) =>
        recordProofOrder(tx, other.id, { orderId: crypto.randomUUID(), status }, clock),
      );
    }
    expect(eventsNamed('shop.orchestra.error')).toHaveLength(0);
    const orderId = crypto.randomUUID();
    const held = await w.h.store.transaction((tx) =>
      recordProofOrder(tx, p.id, { orderId, status: 'mystery' }, clock),
    );
    expect(held).toMatchObject({ result: null, orderStatus: 'mystery' });
    for (const status of ['mystery', 'enigma']) {
      await w.h.store.transaction((tx) => recordProofOrder(tx, p.id, { orderId, status }, clock));
    }
    expect(eventsNamed('shop.orchestra.error').map((entry) => entry.fields)).toEqual([
      {
        paymentId: w.payment.id,
        proofId: p.id,
        offerId: w.offer.id,
        orderId,
        reason: 'unknown_status',
        status: 'mystery',
      },
    ]);
    // Another order id is logged again.
    const next = await addProof(w);
    const nextOrder = crypto.randomUUID();
    await w.h.store.transaction((tx) =>
      recordProofOrder(tx, next.id, { orderId: nextOrder, status: 'mystery' }, clock),
    );
    expect(eventsNamed('shop.orchestra.error')).toHaveLength(2);
  });

  it('refuseProof: null for an unknown proof; refuses null, superseded, late, stuck with the given refusal', async () => {
    const w = await world();
    expect(
      await w.h.store.transaction((tx) => refuseProof(tx, crypto.randomUUID(), 'mismatch', clock)),
    ).toBeNull();
    for (const from of [null, 'superseded', 'late', 'stuck'] as const) {
      const p = await addProof(w, { result: from, nextSubmitAt: new Date(T0 + 10_000) });
      const after = await w.h.store.transaction((tx) =>
        refuseProof(tx, p.id, from === null ? 'mismatch' : 'hex_rejected', clock),
      );
      expect(after).toMatchObject({
        result: 'refused',
        refusal: from === null ? 'mismatch' : 'hex_rejected',
        nextSubmitAt: null,
        resolvedAt: new Date(clock),
      });
    }
    expect(eventsNamed('shop.proof.refused')).toHaveLength(4);
    expect((await readPayment(w.h, w.payment.id)).status).toBe('open');
  });

  it.each(['refused', 'refunded', 'failed'] as const)(
    'refuseProof: leaves a %s proof unchanged (no row allows it)',
    async (from) => {
      const w = await world();
      const p = await addProof(w, { result: from, refusal: from === 'refused' ? 'tx_used' : null });
      expect(
        await w.h.store.transaction((tx) => refuseProof(tx, p.id, 'hex_rejected', clock)),
      ).toMatchObject({ result: from, refusal: from === 'refused' ? 'tx_used' : null });
      expect(eventsNamed('shop.proof.refused')).toHaveLength(0);
    },
  );

  it('refuseProof: an accepted proof refused ends the accepted payment with proof_refused', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: crypto.randomUUID(),
      orderStatus: 'refunding',
    });
    const after = await w.h.store.transaction((tx) => refuseProof(tx, p.id, 'hex_rejected', clock));
    expect(after).toMatchObject({ result: 'refused', refusal: 'hex_rejected' });
    expect((await proof(w, p.id)).result).toBe('refused');
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'proof_refused',
    });
  });

  it('refuseProof: tx_used refuses an accepted proof and ends the payment with proof_refused when no other proof takes over', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: crypto.randomUUID(),
      orderStatus: 'refunding',
    });
    const after = await w.h.store.transaction((tx) => refuseProof(tx, p.id, 'tx_used', clock));
    expect(after).toMatchObject({
      result: 'refused',
      refusal: 'tx_used',
      resolvedAt: new Date(clock),
      nextSubmitAt: null,
    });
    expect(await proof(w, p.id)).toMatchObject({ result: 'refused', refusal: 'tx_used' });
    expect(await readPayment(w.h, w.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'proof_refused',
      endedAt: new Date(clock),
    });
    expect(eventsNamed('shop.proof.refused').map((entry) => entry.fields)).toEqual([
      {
        paymentId: w.payment.id,
        proofId: p.id,
        offerId: w.offer.id,
        quoteId: w.offer.quoteId,
        providerRef: w.offer.providerRef,
        orderId: p.providerOrder,
        refusal: 'tx_used',
      },
    ]);
  });

  it('refuseProof: a superseded proof with a progressing order takes over; the payment stays accepted', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: crypto.randomUUID(),
      orderStatus: 'refunding',
    });
    const taker = await addProof(w, {
      result: 'superseded',
      providerOrder: crypto.randomUUID(),
      orderStatus: 'delivering',
    });
    await w.h.store.transaction((tx) => refuseProof(tx, p.id, 'mismatch', clock));
    expect((await proof(w, p.id)).result).toBe('refused');
    expect((await proof(w, taker.id)).result).toBe('accepted');
    expect((await readPayment(w.h, w.payment.id)).status).toBe('accepted');
    expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
  });

  it('refuseProof: a refused proof whose own order is progressing stays refused and the payment ends', async () => {
    const w = await world({ status: 'accepted', acceptedAt: new Date(T0) });
    const p = await addProof(w, {
      result: 'accepted',
      providerOrder: crypto.randomUUID(),
      orderStatus: 'swapping',
    });
    await w.h.store.transaction((tx) => refuseProof(tx, p.id, 'hex_rejected', clock));
    expect(eventsNamed('shop.proof.refused')).toHaveLength(1);
    expect((await proof(w, p.id)).result).toBe('refused');
    const ended = await readPayment(w.h, w.payment.id);
    expect(ended.status).toBe('ended');
    expect(ended.endReason).toBe('proof_refused');
  });
});

// ─── Wait view ─────────────────────────────────────────────────────────────

describe('wait route statuses (Wait)', () => {
  it.each([
    [{ status: 'paid', paidAt: new Date(T0) }, 'Completed'],
    [
      { status: 'ended', endReason: 'superseded', endedAt: new Date(T0), closedAt: new Date(T0) },
      'Cancelled',
    ],
    [
      { status: 'ended', endReason: 'replaced', endedAt: new Date(T0), closedAt: new Date(T0) },
      'Cancelled',
    ],
    [
      { status: 'ended', endReason: 'cancelled', endedAt: new Date(T0), closedAt: new Date(T0) },
      'Cancelled',
    ],
    [
      { status: 'ended', endReason: 'window', endedAt: new Date(T0), closedAt: new Date(T0) },
      'Expired',
    ],
    [
      {
        status: 'ended',
        endReason: 'expired_unpaid',
        endedAt: new Date(T0),
        closedAt: new Date(T0),
      },
      'Expired',
    ],
    [{ status: 'ended', endReason: 'superseded', endedAt: new Date(T0) }, 'Pending'],
    [{ status: 'open' }, 'Pending'],
    [{ status: 'accepted', acceptedAt: new Date(T0) }, 'Pending'],
  ] as [Partial<ShopPayment>, string][])('maps %o to %s', (over, status) => {
    const payment = paymentRow(over);
    expect(dfxPaymentStatus(payment)).toBe(status);
    expect(waitBody(payment)).toEqual({
      status,
      paymentStatus: payment.status,
      invoiceExpiresAt: '2026-10-17T11:00:00.000Z',
    });
  });

  it('answers null for an unknown payment and at once without since', async () => {
    const h = await setup();
    expect(await h.svc.wait(crypto.randomUUID(), null, 25_000)).toBeNull();
    const payment = paymentRow();
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect(await h.svc.wait(payment.id, null, 25_000)).toMatchObject({
      status: 'Pending',
      paymentStatus: 'open',
    });
    expect(await h.svc.wait(payment.id, 'accepted', 25_000)).toMatchObject({
      paymentStatus: 'open',
    });
    expect(sleepCalls).toEqual([]);
  });

  it('waits every 250 ms while paymentStatus equals since, then answers the new state', async () => {
    const h = await setup();
    const payment = paymentRow();
    await h.store.transaction((tx) => tx.insertPayment(payment));
    sleepImpl = async (ms) => {
      clock += ms;
      if (sleepCalls.length === 3) {
        await h.store.transaction((tx) =>
          tx.updatePayment(payment.id, {}, { status: 'accepted', acceptedAt: new Date(clock) }),
        );
      }
    };
    expect(await h.svc.wait(payment.id, 'open', 25_000)).toMatchObject({
      status: 'Pending',
      paymentStatus: 'accepted',
    });
    expect(sleepCalls).toEqual([250, 250, 250]);
  });

  it('answers the state on hand after the hold, and at once for a final status', async () => {
    const h = await setup();
    const open = paymentRow();
    const paid = paymentRow({ status: 'paid', paidAt: new Date(T0) });
    await h.store.transaction(async (tx) => {
      await tx.insertPayment(open);
      await tx.insertPayment({ ...paid, accountId: crypto.randomUUID() });
    });
    expect(await h.svc.wait(open.id, 'open', 1_000)).toMatchObject({ paymentStatus: 'open' });
    expect(sleepCalls).toHaveLength(4);
    expect(await h.svc.wait(paid.id, 'paid', 25_000)).toMatchObject({ status: 'Completed' });
    expect(sleepCalls).toHaveLength(4);
  });

  it('uses setTimeout when no sleep is injected', async () => {
    const h = await setup({ sleep: 'default', now: () => Date.now() });
    const payment = paymentRow();
    await h.store.transaction((tx) => tx.insertPayment(payment));
    const started = Date.now();
    expect(await h.svc.wait(payment.id, 'open', 1)).toMatchObject({ paymentStatus: 'open' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});

// ─── Creation procedure ────────────────────────────────────────────────────

describe('creation procedure steps 1–8 (Creation procedure, By the payer, By a till charge)', () => {
  it('creates a payer payment: one BOLT11, one quote per offered pair, a five-minute window', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const issued = h.net.issued[0]!;
    expect(payment).toMatchObject({
      accountId: ACCOUNT_ID,
      amountSats: SATS,
      posChargeId: null,
      bolt11: issued.pr,
      paymentHash: issued.hash,
      status: 'open',
      replacements: 0,
      windowEndsAt: new Date(T0 + 300_000),
      bolt11ExpiresAt: new Date(T0 + 3_600_000),
      nextSettleAt: new Date(T0 + 5_000),
      createdAt: new Date(T0),
    });
    expect(h.net.issued).toHaveLength(1);
    expect(h.orchestra.routesCalls).toEqual([1_000]);
    expect(
      h.orchestra.quoteCalls.map(
        (call) => `${call.request.sourceChain}/${call.request.sourceAsset}`,
      ),
    ).toEqual(shopPairOrder().map((pair) => `${pair.method.sourceChain}/${pair.asset}`));
    for (const call of h.orchestra.quoteCalls) {
      expect(call.request).toMatchObject({
        amountSats: SATS,
        bolt11: issued.pr,
        tag: payment.id,
        refundAddress: REFUND,
      });
      expect(call.deadlineMs).toBe(T0 + 3_000);
    }
    expect(new Set(h.orchestra.quoteCalls.map((call) => call.key)).size).toBe(12);
    // One eth_gasPrice per chain.
    expect(h.net.rpcCalls.map((call) => call.method)).toEqual(Array(6).fill('eth_gasPrice'));
    const [quote] = await quotesOf(h, payment.id);
    expect(quote!.expiresAt.getTime()).toBe(T0 + 90_000);
    expect(quote!.transferAmounts.map((entry) => entry.method)).toEqual([
      'Lightning',
      'Ethereum',
      'Arbitrum',
      'Optimism',
      'Polygon',
      'Base',
      'BinanceSmartChain',
    ]);
    expect(quote!.transferAmounts[1]).toEqual({
      method: 'Ethereum',
      minFee: 1_200_000_008,
      assets: [
        { asset: 'USDT', amount: '1.234' },
        { asset: 'USDC', amount: '1.234' },
      ],
      available: true,
    });
    // floor(floor(g × 12 / 10) × 20 / 12) on BinanceSmartChain.
    expect(quote!.transferAmounts[6]!.minFee).toBe(2_000_000_013);
    const offers = await h.store.transaction((tx) => tx.offersOf(quote!.id));
    expect(offers).toHaveLength(12);
    expect(
      offers.find((offer) => offer.method === 'Ethereum' && offer.asset === 'USDT'),
    ).toMatchObject({
      providerRef: 'oq-1',
      chainId: 1,
      tokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      amountIn: '1234000',
      requiredAmountIn: '1234000',
      maxAcceptedAmountIn: '1234010',
      decimals: 6,
      minFee: '1200000008',
      idempotencyKey: h.orchestra.quoteCalls[0]!.key,
      expiresAt: new Date(T0 + 120_000),
      detailIssuedAt: null,
    });
    expect(await h.pos.findChargeForPayment({ paymentHash: issued.hash })).toBeUndefined();
    expect(eventsNamed('shop.payment.opened')).toHaveLength(1);
  });

  it('creates a charge payment with the charge window and records its BOLT11 against the charge', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    expect(created.kind).toBe('payment');
    const payment = created.kind === 'payment' ? created.payment : null;
    expect(payment).toMatchObject({
      posChargeId: charge.id,
      amountSats: CHARGE_SATS,
      windowEndsAt: charge.expiresAt,
    });
    expect((await h.pos.findChargeForPayment({ paymentHash: payment!.paymentHash }))?.id).toBe(
      charge.id,
    );
  });

  it('serialises creations of one account under the lock; a second charge caller joins the first in-flight creation', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const [a, b] = await Promise.all([
      h.svc.createForCharge(h.account, USER, charge, clock),
      h.svc.createForCharge(h.account, USER, charge, clock),
    ]);
    expect(a.kind === 'payment' && b.kind === 'payment' && a.payment.id === b.payment.id).toBe(
      true,
    );
    expect(h.net.issued).toHaveLength(1);
    expect(h.orchestra.routesCalls).toHaveLength(1);
    // A later run for the same charge re-reads under the lock and returns its payment.
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual(a);
    expect(h.net.issued).toHaveLength(1);
    expect(h.orchestra.routesCalls).toHaveLength(1);
  });

  it('replaces an open payer payment with end_reason replaced; two payers run one after the other', async () => {
    const h = await setup();
    const [first, second] = await Promise.all([
      h.svc.createForPayer(h.account, USER, 1000, clock),
      h.svc.createForPayer(h.account, USER, 2000, clock),
    ]);
    expect(first.kind).toBe('payment');
    expect(second.kind).toBe('payment');
    const firstId = first.kind === 'payment' ? first.payment.id : '';
    const secondId = second.kind === 'payment' ? second.payment.id : '';
    expect(firstId).not.toBe(secondId);
    expect(await readPayment(h, firstId)).toMatchObject({
      amountSats: 1000,
      status: 'ended',
      endReason: 'replaced',
      endedAt: new Date(T0),
    });
    expect(await readPayment(h, secondId)).toMatchObject({
      amountSats: 2000,
      status: 'open',
      endReason: null,
    });
    expect((await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID)))?.id).toBe(secondId);
    expect(h.net.issued).toHaveLength(2);
  });

  it('step 2 ends a lapsed open payment with window and stops for a charge that is no longer pending', async () => {
    const h = await setup();
    const old = await payerPayment(h);
    clock = T0 + 300_000;
    await payerPayment(h);
    expect(await readPayment(h, old.id)).toMatchObject({ status: 'ended', endReason: 'window' });

    const cancelled = chargeRow({ status: 'cancelled' });
    expect(await h.svc.createForCharge(h.account, USER, cancelled, clock)).toEqual({
      kind: 'skipped',
    });
    const expired = chargeRow({ expiresAt: new Date(clock) });
    await h.pos.create({ ...expired, status: 'expired' });
    expect(await h.svc.createForCharge(h.account, USER, expired, clock)).toEqual({
      kind: 'skipped',
    });
    expect(h.net.issued).toHaveLength(2);
  });

  it('step 2 answers order 4 for a payer while a charge is pending', async () => {
    const h = await setup();
    await h.pos.create(chargeRow());
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'pending_charge',
    });
    expect(h.net.issued).toHaveLength(0);
  });

  it('order 6 runs again under the lock: no config, no Orchestra, or an excluded username', async () => {
    for (const options of [{ config: 'off' as const }, { orchestra: 'off' as const }]) {
      const h = await setup(options);
      expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
        kind: 'unavailable',
      });
      expect(h.svc.offersStablecoins(USER)).toBe(false);
    }
    const h = await setup();
    expect(await h.svc.createForPayer(h.account, 'cb', SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.svc.offersStablecoins('invoice')).toBe(false);
    expect(h.svc.offersStablecoins(USER)).toBe(true);
  });

  it('order 7: an account starts at most 10 creations a minute', async () => {
    const h = await setup();
    for (let i = 0; i < 10; i += 1) {
      expect((await h.svc.createForPayer(h.account, USER, SATS, clock)).kind).toBe('payment');
    }
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.net.issued).toHaveLength(10);
    clock = T0 + 60_000;
    expect((await h.svc.createForPayer(h.account, USER, SATS, clock)).kind).toBe('payment');
  });

  it('order 7: the api starts at most 60 a minute; the api counter is asked first, so an account refusal costs one api hit', async () => {
    const h = await setup();
    for (let i = 0; i < 10; i += 1) {
      await h.svc.createForPayer(h.account, USER, SATS, clock);
    }
    // Refused by the account counter after the api counter recorded it: 11 api hits.
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    let made = 0;
    for (let n = 2; n <= 7; n += 1) {
      const id = `00000000-0000-4000-8000-0000000000b${n}`;
      const username = `shop${n}`;
      const other = await addAccount(h.auth, id, username);
      const count = n === 6 ? 9 : 10;
      for (let i = 0; i < count && n < 7; i += 1) {
        const created = await h.svc.createForPayer(other, username, SATS, clock);
        expect(created.kind).toBe('payment');
        made += 1;
      }
      if (n === 7) {
        expect(await h.svc.createForPayer(other, username, SATS, clock)).toEqual({
          kind: 'unavailable',
        });
      }
    }
    expect(made).toBe(49);
  });

  it('step 3: a failed route list offers nothing until a fetch succeeds; the list is reused for validForMs', async () => {
    const h = await setup();
    h.orchestra.routesResult = { ok: false };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.net.issued).toHaveLength(0);
    h.orchestra.routesResult = { ok: true, assets: defaultRoutes(), validForMs: 30_000 };
    clock = T0 + 1_000;
    expect((await h.svc.createForPayer(h.account, USER, SATS, clock)).kind).toBe('payment');
    expect(h.orchestra.routesCalls).toHaveLength(2);
    clock = T0 + 30_999;
    await payerPayment(h);
    expect(h.orchestra.routesCalls).toHaveLength(2);
    clock = T0 + 31_000;
    await payerPayment(h);
    expect(h.orchestra.routesCalls).toHaveLength(3);
  });

  it('step 3: the route list is reused only until validForMs has passed since its request started', async () => {
    const h = await setup();
    // The fetch takes 900 ms; validForMs counts from its start, not its answer.
    h.orchestra.routesImpl = async () => {
      clock += 900;
      return { ok: true, assets: defaultRoutes(), validForMs: 60_000 };
    };
    await payerPayment(h);
    expect(h.orchestra.routesCalls).toHaveLength(1);
    clock = T0 + 59_999;
    await payerPayment(h);
    expect(h.orchestra.routesCalls).toHaveLength(1);
    clock = T0 + 60_000;
    await payerPayment(h);
    expect(h.orchestra.routesCalls).toHaveLength(2);
  });

  it('step 3: no candidate pair offers nothing, and the account’s next creation waits 60 s', async () => {
    const h = await setup();
    h.orchestra.routesResult = { ok: true, assets: [], validForMs: 0 };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    h.orchestra.routesResult = { ok: true, assets: defaultRoutes(), validForMs: 0 };
    clock = T0 + 59_999;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.routesCalls).toHaveLength(1);
    expect(h.net.issued).toHaveLength(0);
    clock = T0 + 60_000;
    expect((await h.svc.createForPayer(h.account, USER, SATS, clock)).kind).toBe('payment');
  });

  it('step 3: no route list once its 1 s share is used up', async () => {
    const h = await setup();
    const original = h.pos.currentPending.bind(h.pos);
    h.pos.currentPending = async (accountId, nowMs) => {
      clock += 2_000;
      return original(accountId, nowMs);
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.routesCalls).toHaveLength(0);
  });

  it('step 3: route-list pairs that do not match the table are not requested', async () => {
    const h = await setup();
    h.orchestra.routesResult = {
      ok: true,
      validForMs: 60_000,
      assets: defaultRoutes().filter((route) => route.chain === 'polygon'),
    };
    const payment = await payerPayment(h);
    expect(h.orchestra.quoteCalls.map((call) => call.request.sourceAsset)).toEqual([
      'USDT',
      'USDC',
    ]);
    const [quote] = await quotesOf(h, payment.id);
    expect(quote!.transferAmounts.map((entry) => entry.method)).toEqual(['Lightning', 'Polygon']);
  });

  it('step 4: a failed mint, a wrong amount, or an undecodable BOLT11 stops with order 8 and records nothing', async () => {
    const h = await setup();
    h.net.invoiceStatus = 500;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
    h.net.invoiceStatus = 200;
    h.net.satsDelta = 1;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
    h.net.satsDelta = 0;
    h.net.prOverride = 'lnbc1garbage';
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
    const mintFailed = eventsNamed('shop.mint.failed').map((entry) => entry.fields);
    expect(mintFailed).toHaveLength(3);
    // Each creation's payment id, chosen before the route list (Logging).
    // The route list is fetched once and reused; its call carries the first id.
    expect(h.orchestra.routesLogs).toEqual([{ paymentId: expect.any(String) }]);
    expect(mintFailed[0]).toEqual({ accountId: ACCOUNT_ID, ...h.orchestra.routesLogs[0] });
    expect(new Set(mintFailed.map((fields) => fields?.['paymentId'])).size).toBe(3);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
  });

  it('step 4: one 4 s deadline covers both LNURL calls', async () => {
    const h = await setup();
    h.net.onWellKnown = () => {
      clock += 4_000;
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(h.net.issued).toHaveLength(0);
  });

  it('step 4: computes the BOLT11 expiry from the request time plus the expiry tag, or one hour', async () => {
    const h = await setup();
    h.net.expirySec = 1800;
    h.net.onWellKnown = () => {
      clock += 100;
    };
    expect((await payerPayment(h)).bolt11ExpiresAt.getTime()).toBe(T0 + 1_800_000);
    h.net.expirySec = null;
    h.net.onWellKnown = null;
    expect((await payerPayment(h)).bolt11ExpiresAt.getTime()).toBe(T0 + 100 + 3_600_000);
  });

  it('step 4: a payment hash a shop payment holds stops as order 8 with shop.alert.duplicate_invoice, before recording', async () => {
    const h = await setup();
    const held = await payerPayment(h);
    const charge = chargeRow();
    // A charge is pending now; make the next mint return the held hash.
    await h.store.transaction((tx) =>
      tx.updatePayment(held.id, {}, { status: 'paid', paidAt: new Date(clock) }),
    );
    await h.pos.create(charge);
    h.net.nextHash = held.paymentHash;
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderPaymentId: held.id },
    ]);
    expect(eventsNamed('shop.alert.duplicate_invoice')[0]?.fields?.['paymentId']).not.toBe(held.id);
    expect(await h.pos.findChargeForPayment({ paymentHash: held.paymentHash })).toBeUndefined();
  });

  it('step 4: a hash held by another charge’s shop payment names that charge too', async () => {
    const h = await setup();
    const otherCharge = crypto.randomUUID();
    const hash = nextHash();
    await h.store.transaction((tx) =>
      tx.insertPayment(
        paymentRow({ accountId: crypto.randomUUID(), posChargeId: otherCharge, paymentHash: hash }),
      ),
    );
    const charge = chargeRow();
    await h.pos.create(charge);
    h.net.nextHash = hash;
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice')[0]?.fields).toMatchObject({
      holderChargeId: otherCharge,
    });
  });

  it('step 4: the charge’s own shop payment holding the minted hash is used, and the procedure ends', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const hash = nextHash();
    h.net.nextHash = hash;
    const own = paymentRow({
      posChargeId: charge.id,
      paymentHash: hash,
      windowEndsAt: charge.expiresAt,
    });
    // The charge's own payment appears after step 2, during the mint.
    h.net.onInvoice = async () => {
      h.net.onInvoice = null;
      await h.store.transaction((tx) => tx.insertPayment(own));
    };
    const record = vi.spyOn(h.pos, 'recordInvoice');
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'payment',
      payment: own,
    });
    expect(record).not.toHaveBeenCalled();
    expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.pos.findChargeForPayment({ paymentHash: hash })).toBeUndefined();
  });

  it('step 4: a hash recorded against another charge stops as order 8; against this charge goes on', async () => {
    const h = await setup();
    const other = chargeRow({ accountId: crypto.randomUUID() });
    await h.pos.create(other);
    const hash = nextHash();
    await h.pos.recordInvoice(other.id, hash, clock);
    const charge = chargeRow();
    await h.pos.create(charge);
    h.net.nextHash = hash;
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderChargeId: other.id },
    ]);
    expect(h.orchestra.quoteCalls).toHaveLength(0);

    const own = nextHash();
    await h.pos.recordInvoice(charge.id, own, clock);
    h.net.nextHash = own;
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    expect(created.kind === 'payment' && created.payment.paymentHash === own).toBe(true);
  });

  it('step 4: recordInvoice runs as its own claim transaction, outside any shop transaction', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    let inShopTx = false;
    const transaction = h.store.transaction.bind(h.store);
    h.store.transaction = async (run) =>
      transaction(async (tx) => {
        inShopTx = true;
        try {
          return await run(tx);
        } finally {
          inShopTx = false;
        }
      });
    const seen: boolean[] = [];
    const record = h.pos.recordInvoice.bind(h.pos);
    h.pos.recordInvoice = async (...args) => {
      seen.push(inShopTx);
      return record(...args);
    };
    expect((await h.svc.createForCharge(h.account, USER, charge, clock)).kind).toBe('payment');
    expect(seen).toEqual([false]);
  });

  it('step 4: other_payment from recordInvoice stops as order 8 with the holder in the alert', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.pos.recordInvoice = async () => ({
      outcome: 'other_payment',
      holderChargeId: 'charge-x',
      holderPaymentId: 'payment-x',
    });
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderPaymentId: 'payment-x', holderChargeId: 'charge-x' },
    ]);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
  });

  it('step 4: a recordInvoice error logs pos.invoice.record_failed, writes nothing, and the pay link stays pinned', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.pos.recordInvoice = async () => {
      throw new Error('db');
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'skipped',
    });
    expect(eventsNamed('pos.invoice.record_failed').map((entry) => entry.fields)).toEqual([
      { accountId: ACCOUNT_ID, paymentId: expect.any(String) },
    ]);
    expect(eventsNamed('shop.creation.failed')).toHaveLength(0);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
    expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
  });

  it('step 4: a payer creation stops as order 8 when findChargeForPayment finds the hash recorded against a charge', async () => {
    const h = await setup();
    const other = chargeRow({ accountId: crypto.randomUUID() });
    await h.pos.create(other);
    const hash = nextHash();
    await h.pos.recordInvoice(other.id, hash, clock);
    h.net.nextHash = hash;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderChargeId: other.id },
    ]);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.store.transaction((tx) => tx.paymentForHash(hash))).toBeNull();
  });

  it('step 4: a findChargeForPayment error makes a payer creation write nothing and answer order 9', async () => {
    const h = await setup();
    h.pos.findChargeForPayment = async () => {
      throw new Error('db');
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
    expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
  });

  it('step 4: a charge that stopped being open during the mint ends without shop.alert.duplicate_invoice', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.net.onInvoice = async () => {
      await h.pos.cancelPending(ACCOUNT_ID, clock);
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'skipped',
    });
    expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
    expect(h.orchestra.quoteCalls).toHaveLength(0);
  });

  it('step 4: a payer creation never records against a charge, also not one that appeared after step 2', async () => {
    const h = await setup();
    h.net.onInvoice = async () => {
      h.net.onInvoice = null;
      await h.pos.create(chargeRow());
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'pending_charge',
    });
    const hash = h.net.issued[0]!.hash;
    expect(await h.pos.findChargeForPayment({ paymentHash: hash })).toBeUndefined();
    expect(await h.store.transaction((tx) => tx.paymentForHash(hash))).toBeNull();
  });

  it('step 5: pairs beyond the quote budget are skipped in request order; no budget requests none', async () => {
    const h = await setup();
    h.orchestra.budget = 2;
    const payment = await payerPayment(h);
    expect(h.orchestra.quoteCalls.map((call) => call.request.sourceChain)).toEqual([
      'ethereum',
      'arbitrum',
    ]);
    expect(h.net.rpcCalls.map((call) => call.chainId)).toEqual([1, 42161]);
    const [quote] = await quotesOf(h, payment.id);
    expect(quote!.transferAmounts.map((entry) => entry.method)).toEqual([
      'Lightning',
      'Ethereum',
      'Arbitrum',
    ]);

    h.orchestra.budget = -3;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.quoteCalls).toHaveLength(2);
  });

  it('step 6: keeps only quotes that commit and pass the checks, logging shop.offer.rejected with the check', async () => {
    const h = await setup();
    h.net.gas.set(10, null);
    let shared: string | null = null;
    h.orchestra.quoteImpl = (request) => {
      if (request.sourceChain === 'base') {
        return { ok: false, reason: 'refused' };
      }
      if (request.sourceChain === 'ethereum' && request.sourceAsset === 'USDC') {
        return { ok: true, quote: h.orchestra.validQuote(request, { targetAmountOut: '1' }) };
      }
      const quote = h.orchestra.validQuote(request);
      if (request.sourceChain === 'arbitrum') {
        // Both Arbitrum quotes name one deposit address.
        shared ??= quote.depositAddress;
        const amountIn = BigInt(quote.amountIn);
        return {
          ok: true,
          quote: {
            ...quote,
            depositAddress: shared,
            transaction: { ...quote.transaction!, data: erc20TransferData(shared, amountIn) },
          },
        };
      }
      return { ok: true, quote };
    };
    const payment = await payerPayment(h);
    const rejected = eventsNamed('shop.offer.rejected').map((entry) => entry.fields);
    expect(rejected).toEqual(
      expect.arrayContaining([
        {
          paymentId: payment.id,
          providerRef: expect.stringMatching(/^oq-/),
          method: 'Ethereum',
          asset: 'USDC',
          check: 'target',
        },
        {
          paymentId: payment.id,
          providerRef: expect.stringMatching(/^oq-/),
          method: 'Arbitrum',
          asset: 'USDC',
          check: 'deposit_shared',
        },
        {
          paymentId: payment.id,
          providerRef: expect.stringMatching(/^oq-/),
          method: 'Optimism',
          asset: 'USDT',
          check: 'gas',
        },
        {
          paymentId: payment.id,
          providerRef: expect.stringMatching(/^oq-/),
          method: 'Optimism',
          asset: 'USDC',
          check: 'gas',
        },
      ]),
    );
    expect(rejected).toHaveLength(4);
    expect(eventsNamed('shop.alert.shared_deposit_address').map((entry) => entry.fields)).toEqual([
      {
        paymentId: payment.id,
        providerRef: expect.stringMatching(/^oq-/),
        method: 'Arbitrum',
        asset: 'USDC',
      },
    ]);
    const [quote] = await quotesOf(h, payment.id);
    expect(
      quote!.transferAmounts.map(
        (entry) => `${entry.method}:${entry.assets.map((a) => a.asset).join('+')}`,
      ),
    ).toEqual([
      'Lightning:BTC',
      'Ethereum:USDT',
      'Arbitrum:USDT',
      'Polygon:USDT+USDC',
      'BinanceSmartChain:USDT+USDC',
    ]);
  });

  it('step 6 / offer checks: a deposit address another stored offer holds drops only that offer', async () => {
    const h = await setup();
    const first = await payerPayment(h);
    const firstOffers = await h.store.transaction(async (tx) =>
      tx.offersOf((await tx.quotesOf(first.id))[0]!.id),
    );
    const taken = firstOffers.find(
      (offer) => offer.method === 'Polygon' && offer.asset === 'USDT',
    )!;
    h.orchestra.quoteImpl = (request) => {
      const quote = h.orchestra.validQuote(request);
      if (request.sourceChain === 'polygon' && request.sourceAsset === 'USDT') {
        return {
          ok: true,
          quote: {
            ...quote,
            depositAddress: taken.depositAddress,
            transaction: {
              ...quote.transaction!,
              data: erc20TransferData(taken.depositAddress, BigInt(quote.amountIn)),
            },
          },
        };
      }
      return { ok: true, quote };
    };
    events = [];
    const second = await payerPayment(h);
    const [quote] = await quotesOf(h, second.id);
    const shared = {
      paymentId: second.id,
      quoteId: quote!.id,
      offerId: expect.any(String),
      providerRef: expect.stringMatching(/^oq-/),
      method: 'Polygon',
      asset: 'USDT',
    };
    expect(eventsNamed('shop.offer.rejected').map((entry) => entry.fields)).toEqual([
      { ...shared, check: 'deposit_shared' },
    ]);
    expect(eventsNamed('shop.alert.shared_deposit_address').map((entry) => entry.fields)).toEqual([
      shared,
    ]);
    expect(quote!.transferAmounts.find((entry) => entry.method === 'Polygon')!.assets).toEqual([
      { asset: 'USDC', amount: '1.234' },
    ]);
    expect(await h.store.transaction((tx) => tx.offersOf(quote!.id))).toHaveLength(11);
  });

  it('step 6 / price check: a fresh spot rejects an offer more than 5 % above the sats value', async () => {
    const fx = new InMemoryFxSpotStore({
      asOf: new Date(T0 - 60_000).toISOString(),
      source: 'test',
      rates: { USD: '95238' },
    } as unknown as Parameters<InMemoryFxSpotStore['save']>[0]);
    const h = await setup({ fxSpot: fx });
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    const rejected = eventsNamed('shop.offer.rejected');
    expect(rejected).toHaveLength(12);
    expect(rejected.every((entry) => entry.fields?.['check'] === 'price')).toBe(true);

    // The last millisecond of the fresh window still applies the spot.
    const edge = await setup({ fxSpot: freshSpot(() => T0 + 1_000 - 599_999, '95238') });
    const before = eventsNamed('shop.offer.rejected').length;
    expect(await edge.svc.createForPayer(edge.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(edge.orchestra.quoteCalls).toHaveLength(12);
    const edgeRejected = eventsNamed('shop.offer.rejected').slice(before);
    expect(edgeRejected).toHaveLength(12);
    expect(edgeRejected.every((entry) => entry.fields?.['check'] === 'price')).toBe(true);

    // Exactly within the bound at a spot 599 999 ms old: offered.
    const fresh = await setup({ fxSpot: freshSpot(() => T0 + 1_000 - 599_999, '95238.1') });
    expect((await fresh.svc.createForPayer(fresh.account, USER, SATS, clock)).kind).toBe('payment');
  });

  it('step 5 / price check: without a stored USD spot younger than 10 min no Orchestra call is sent and no pair is offered', async () => {
    const cases: FxSpotStore[] = [
      // Exactly 10 minutes old.
      {
        latest: async () => ({
          asOf: new Date(T0 - 600_000).toISOString(),
          rates: { USD: '100000' },
        }),
      } as unknown as FxSpotStore,
      {
        latest: async () => ({ asOf: 'later', rates: { USD: '100000' } }),
      } as unknown as FxSpotStore,
      {
        latest: async () => ({ asOf: new Date(T0).toISOString(), rates: {} }),
      } as unknown as FxSpotStore,
      { latest: async () => null } as unknown as FxSpotStore,
      {
        latest: async () => {
          throw new Error('db');
        },
      } as unknown as FxSpotStore,
      new InMemoryFxSpotStore(),
    ];
    for (const fxSpot of cases) {
      events = [];
      const h = await setup({ fxSpot });
      h.orchestra.budget = 3;
      expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
        kind: 'unavailable',
      });
      expect(h.orchestra.quoteCalls).toHaveLength(0);
      expect(h.net.rpcCalls).toHaveLength(0);
      // One rejection per pair the quote budget allows, in request order.
      expect(eventsNamed('shop.offer.rejected').map((entry) => entry.fields)).toEqual(
        shopPairOrder()
          .slice(0, 3)
          .map((pair) => ({
            paymentId: expect.any(String),
            method: pair.method.method,
            asset: pair.asset,
            check: 'price',
          })),
      );
      // Step 7: nothing written; the payer gets order 9.
      expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
    }
  });

  it('step 6 / price check: a spot that turns 10 min old while the quotes run offers nothing', async () => {
    const h = await setup({ fxSpot: freshSpot(() => T0 - 599_000 + 1_000) });
    h.orchestra.onQuote = async () => {
      clock = T0 + 1_000;
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    const rejected = eventsNamed('shop.offer.rejected');
    expect(rejected).toHaveLength(12);
    expect(rejected.every((entry) => entry.fields?.['check'] === 'price')).toBe(true);
  });

  it('price check: with a stale spot the pay link of a charge answers today’s pinned request', async () => {
    const stale = {
      latest: async () => ({
        asOf: new Date(T0 - 600_000).toISOString(),
        rates: { USD: '100000' },
      }),
    } as unknown as FxSpotStore;
    const h = await setup({ fxSpot: stale });
    const charge = chargeRow();
    await h.pos.create(charge);
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
    expect(h.orchestra.quoteCalls).toHaveLength(0);
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
  });

  it('step 7: no kept quote writes nothing; the next creation of the account waits 60 s', async () => {
    const h = await setup();
    h.orchestra.quoteImpl = () => ({ ok: false, reason: 'unavailable' });
    const charge = chargeRow();
    await h.pos.create(charge);
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'unavailable',
    });
    // The losing BOLT11 stays recorded against the charge.
    expect((await h.pos.findChargeForPayment({ paymentHash: h.net.issued[0]!.hash }))?.id).toBe(
      charge.id,
    );
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
    h.orchestra.quoteImpl = null;
    clock = T0 + 59_999;
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(h.net.issued).toHaveLength(1);
    clock = T0 + 60_000;
    expect((await h.svc.createForCharge(h.account, USER, charge, clock)).kind).toBe('payment');
  });

  it('step 8: a charge cancelled during the quotes gets no shop payment', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.orchestra.onQuote = async () => {
      await h.pos.cancelPending(ACCOUNT_ID, clock);
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'skipped',
    });
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
  });

  it('step 8: a payer finds a pending charge at insert: nothing written, order 4', async () => {
    const h = await setup();
    const open = await payerPayment(h);
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.pos.create(chargeRow());
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'pending_charge',
    });
    expect((await readPayment(h, open.id)).status).toBe('open');
  });

  it('step 8: a charge ends another open payment with superseded, or window when it lapsed meanwhile', async () => {
    const h = await setup();
    const payer = await payerPayment(h);
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    expect(created).toMatchObject({
      kind: 'payment',
      payment: { posChargeId: charge.id, status: 'open', amountSats: CHARGE_SATS },
    });
    expect(created.kind === 'payment' && created.payment.id).not.toBe(payer.id);
    expect(await readPayment(h, payer.id)).toMatchObject({
      status: 'ended',
      endReason: 'superseded',
    });

    // The payer's window lapses while the charge's quotes run: `window`.
    const h2 = await setup();
    const lapsing = await payerPayment(h2);
    const charge2 = chargeRow({ expiresAt: new Date(T0 + 299_000 + POS_CHARGE_TTL_MS) });
    clock = T0 + 299_000;
    await h2.pos.create(charge2);
    h2.orchestra.onQuote = async () => {
      h2.orchestra.onQuote = null;
      clock = T0 + 300_000;
    };
    const created2 = await h2.svc.createForCharge(h2.account, USER, charge2, clock);
    expect(created2).toMatchObject({
      kind: 'payment',
      payment: { posChargeId: charge2.id, status: 'open' },
    });
    expect(await readPayment(h2, lapsing.id)).toMatchObject({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0 + 300_000),
    });
  });

  it('step 8: a hash conflict with this charge’s own (non-open) payment uses that payment', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    let own: ShopPayment | null = null;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      own = paymentRow({
        posChargeId: charge.id,
        paymentHash: h.net.issued[0]!.hash,
        status: 'accepted',
        acceptedAt: new Date(clock),
      });
      await h.store.transaction((tx) => tx.insertPayment(own!));
    };
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    expect(created).toEqual({ kind: 'payment', payment: own });
  });

  it.each(['same hash', 'other hash'] as const)(
    'step 8: a lost insert whose winner is this charge’s own open payment (%s) uses it and does not end it',
    async (variant) => {
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      let own: ShopPayment | null = null;
      h.orchestra.onQuote = async () => {
        h.orchestra.onQuote = null;
        own = paymentRow({
          posChargeId: charge.id,
          windowEndsAt: charge.expiresAt,
          ...(variant === 'same hash' ? { paymentHash: h.net.issued[0]!.hash } : {}),
        });
        await h.store.transaction((tx) => tx.insertPayment(own!));
      };
      const created = await h.svc.createForCharge(h.account, USER, charge, clock);
      expect(created).toEqual({ kind: 'payment', payment: own });
      expect((await readPayment(h, own!.id)).status).toBe('open');
      expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
      expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
    },
  );

  it('step 8: a lost insert on posChargeId reads this charge’s own payment and uses it', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    let own: ShopPayment | null = null;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      own = paymentRow({ posChargeId: charge.id, status: 'accepted', acceptedAt: new Date(clock) });
      await h.store.transaction((tx) => tx.insertPayment(own!));
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'payment',
      payment: own,
    });
  });

  it.each([true, false])(
    'step 8: a hash another payment holds stops as order 8; the charge invoice row is deleted only when this attempt inserted it (%s)',
    async (insertedByUs) => {
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      const hash = nextHash();
      if (!insertedByUs) {
        await h.pos.recordInvoice(charge.id, hash, clock);
      }
      h.net.nextHash = hash;
      // The claim keeps a holder from appearing on a memory boot; the backstop
      // still answers one that the read finds after step 4.
      const holder = paymentRow({
        accountId: crypto.randomUUID(),
        paymentHash: hash,
        status: 'paid',
        paidAt: new Date(clock),
      });
      h.orchestra.onQuote = async () => {
        h.orchestra.onQuote = null;
        h.store.hooks.paymentForHash = async () => holder;
      };
      expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
        kind: 'mint_failed',
      });
      delete h.store.hooks.paymentForHash;
      expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(1);
      expect((await h.pos.findChargeForPayment({ paymentHash: hash }))?.id).toBe(
        insertedByUs ? undefined : charge.id,
      );
    },
  );

  it('step 8: a payer whose hash another payment holds stops as order 8', async () => {
    const h = await setup();
    const hash = nextHash();
    h.net.nextHash = hash;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.store.transaction((tx) =>
        tx.insertPayment(
          paymentRow({
            accountId: crypto.randomUUID(),
            paymentHash: hash,
            status: 'paid',
            paidAt: new Date(clock),
          }),
        ),
      );
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'mint_failed',
    });
  });

  it('step 8: a held hash writes nothing else: the payer’s earlier open payment stays open', async () => {
    const h = await setup();
    const earlier = await payerPayment(h);
    const hash = nextHash();
    h.net.nextHash = hash;
    const holder = paymentRow({
      accountId: crypto.randomUUID(),
      paymentHash: hash,
      status: 'paid',
      paidAt: new Date(clock),
    });
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.store.transaction((tx) => tx.insertPayment(holder));
    };
    expect(await h.svc.createForPayer(h.account, USER, 2000, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(await readPayment(h, earlier.id)).toMatchObject({
      status: 'open',
      endReason: null,
      endedAt: null,
    });
    expect((await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID)))?.id).toBe(earlier.id);
    expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderPaymentId: holder.id },
    ]);
    expect(eventsNamed('shop.alert.duplicate_invoice')[0]?.fields?.['paymentId']).not.toBe(
      holder.id,
    );
  });

  it.each([true, false])(
    'step 8: a hash another account takes after the check rolls back the end of the open payment (charge invoice inserted by us: %s)',
    async (insertedByUs) => {
      const h = await setup();
      const earlier = await payerPayment(h);
      const charge = chargeRow();
      await h.pos.create(charge);
      const hash = nextHash();
      if (!insertedByUs) {
        await h.pos.recordInvoice(charge.id, hash, clock);
      }
      h.net.nextHash = hash;
      const holder = paymentRow({ accountId: crypto.randomUUID(), paymentHash: hash });
      let visible = false;
      h.store.hooks.insertPayment = async () => {
        // The other account's insert commits between the check and this insert.
        visible = true;
        return false;
      };
      h.store.hooks.paymentForHash = async (tx, ...args) =>
        visible ? holder : tx.paymentForHash(...(args as unknown as [string]));
      expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
        kind: 'mint_failed',
      });
      delete h.store.hooks.insertPayment;
      delete h.store.hooks.paymentForHash;
      expect(await readPayment(h, earlier.id)).toMatchObject({ status: 'open', endReason: null });
      expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
      expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
        { paymentId: expect.any(String), holderPaymentId: holder.id },
      ]);
      expect((await h.pos.findChargeForPayment({ paymentHash: hash }))?.id).toBe(
        insertedByUs ? undefined : charge.id,
      );
    },
  );

  it('step 8: any other failure of the insert transaction is rethrown and rolls back', async () => {
    const h = await setup();
    const earlier = await payerPayment(h);
    h.store.hooks.insertPayment = async () => {
      throw new Error('disk');
    };
    await expect(h.svc.createForPayer(h.account, USER, 2000, clock)).rejects.toThrow('disk');
    delete h.store.hooks.insertPayment;
    expect(await readPayment(h, earlier.id)).toMatchObject({ status: 'open', endReason: null });
    expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
  });

  it('step 8: this charge’s own payment taking the hash after the check is used', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    let own: ShopPayment | null = null;
    h.store.hooks.insertPayment = async (tx, ...args) => {
      const [row] = args as unknown as [ShopPayment];
      own = paymentRow({
        posChargeId: charge.id,
        paymentHash: row.paymentHash,
        status: 'accepted',
        acceptedAt: new Date(clock),
      });
      await tx.insertPayment(own);
      return false;
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'payment',
      payment: own,
    });
    expect(eventsNamed('shop.alert.duplicate_invoice')).toHaveLength(0);
  });

  it.each(['payer', 'charge'] as const)(
    'step 8: any other lost insert runs the insert once more (%s)',
    async (kind) => {
      const h = await setup();
      let refused = false;
      h.store.hooks.insertPayment = async (tx, ...args) => {
        if (!refused) {
          refused = true;
          return false;
        }
        return tx.insertPayment(...(args as unknown as [ShopPayment]));
      };
      if (kind === 'payer') {
        expect((await h.svc.createForPayer(h.account, USER, SATS, clock)).kind).toBe('payment');
      } else {
        const charge = chargeRow();
        await h.pos.create(charge);
        expect((await h.svc.createForCharge(h.account, USER, charge, clock)).kind).toBe('payment');
      }
      expect(refused).toBe(true);
    },
  );
  it('step 8: takes the hash claim first, then the account row, then the charge row', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const calls: string[] = [];
    for (const name of [
      'claimPaymentHash',
      'lockAccount',
      'lockCharge',
      'chargeIdForInvoice',
      'openPayment',
      'insertPayment',
    ] as const) {
      h.store.hooks[name] = async (tx, ...args) => {
        calls.push(name);
        return (tx[name] as (...a: never[]) => Promise<unknown>).apply(tx, args);
      };
    }
    expect((await h.svc.createForCharge(h.account, USER, charge, clock)).kind).toBe('payment');
    const step8 = calls.slice(calls.indexOf('claimPaymentHash'));
    expect(step8).toEqual([
      'claimPaymentHash',
      'lockAccount',
      'lockCharge',
      'chargeIdForInvoice',
      'openPayment',
      'insertPayment',
    ]);
    expect(calls.filter((name) => name === 'claimPaymentHash')).toHaveLength(1);
  });

  it('step 8: a payer whose hash a charge recorded after step 4 ends nothing and inserts nothing', async () => {
    const h = await setup();
    const earlier = await payerPayment(h);
    const other = chargeRow({ accountId: crypto.randomUUID() });
    await h.pos.create(other);
    const hash = nextHash();
    h.net.nextHash = hash;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      expect(await h.pos.recordInvoice(other.id, hash, clock)).toEqual({ outcome: 'recorded' });
    };
    events = [];
    expect(await h.svc.createForPayer(h.account, USER, 2000, clock)).toEqual({
      kind: 'mint_failed',
    });
    expect(await readPayment(h, earlier.id)).toMatchObject({ status: 'open', endReason: null });
    expect(await h.store.transaction((tx) => tx.paymentForHash(hash))).toBeNull();
    expect(eventsNamed('shop.payment.ended')).toHaveLength(0);
    expect(eventsNamed('shop.alert.duplicate_invoice').map((entry) => entry.fields)).toEqual([
      { paymentId: expect.any(String), holderChargeId: other.id },
    ]);
  });

  it('step 8: a charge whose hash another charge holds at the insert stops before writing', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      h.store.hooks.chargeIdForInvoice = async () => 'other-charge';
    };
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'mint_failed',
    });
    delete h.store.hooks.chargeIdForInvoice;
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
    expect(eventsNamed('shop.alert.duplicate_invoice')[0]?.fields).toMatchObject({
      holderChargeId: 'other-charge',
    });
  });

  it.each([
    [SHOP_CREATION_INSERT_LIMIT_MS - 1, 'payment'],
    [SHOP_CREATION_INSERT_LIMIT_MS, 'unavailable'],
  ] as const)('step 8: a payer request %i ms old at the insert gives %s', async (ageMs, kind) => {
    const h = await setup();
    const arrivedMs = clock;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      clock = arrivedMs + ageMs;
    };
    expect((await h.svc.createForPayer(h.account, USER, SATS, arrivedMs)).kind).toBe(kind);
    expect((await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))) !== null).toBe(
      kind === 'payment',
    );
  });

  it('step 8: the 16 s check runs after the locks, so a lock wait counts', async () => {
    const h = await setup();
    const arrivedMs = clock;
    h.store.hooks.lockAccount = async (tx, ...args) => {
      clock = arrivedMs + SHOP_CREATION_INSERT_LIMIT_MS;
      return tx.lockAccount(...(args as unknown as [string]));
    };
    expect(await h.svc.createForPayer(h.account, USER, SATS, arrivedMs)).toEqual({
      kind: 'unavailable',
    });
    delete h.store.hooks.lockAccount;
    expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
  });

  it('step 8: a payer whose client disconnected writes nothing and answers order 9', async () => {
    const h = await setup();
    const earlier = await payerPayment(h);
    const controller = new AbortController();
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      controller.abort();
    };
    expect(await h.svc.createForPayer(h.account, USER, 2000, clock, controller.signal)).toEqual({
      kind: 'unavailable',
    });
    expect(await readPayment(h, earlier.id)).toMatchObject({ status: 'open', endReason: null });
    const live = new AbortController();
    expect((await h.svc.createForPayer(h.account, USER, 2000, clock, live.signal)).kind).toBe(
      'payment',
    );
  });

  it('step 8: the background creation of POST /pos writes nothing 16 s after its request; the pay link stays pinned', async () => {
    const h = await setup();
    const arrivedMs = clock;
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      clock = arrivedMs + SHOP_CREATION_INSERT_LIMIT_MS;
    };
    const charge = chargeRow();
    expect(await h.svc.createCharge(h.account, charge, arrivedMs)).toBe(true);
    // A later caller joins the running creation, which keeps the first arrival.
    expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
    // The pay link's own creation runs late too: today's request, pinned to the charge.
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      clock += SHOP_CREATION_INSERT_LIMIT_MS;
    };
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
  });

  it('step 8: a second lost insert in a row gives up without writing', async () => {
    const h = await setup();
    h.store.hooks.insertPayment = async () => false;
    expect(await h.svc.createForPayer(h.account, USER, SATS, clock)).toEqual({
      kind: 'unavailable',
    });
    expect(await h.store.transaction((tx) => tx.openPayment(ACCOUNT_ID))).toBeNull();
  });
});

// ─── Pay link ──────────────────────────────────────────────────────────────

describe('pay link without and with timeout (Pay link: No open amount, Open amount)', () => {
  it('answers today’s unpinned request with no open amount and no timeout', async () => {
    const h = await setup();
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: null,
    });
  });

  it('a pending charge without a payment starts or joins the creation and answers the open amount', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const { status, json, text } = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock),
    );
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(
      [
        'id',
        'tag',
        'callback',
        'minSendable',
        'maxSendable',
        'metadata',
        'displayName',
        'standard',
        'possibleStandards',
        'displayQr',
        'recipient',
        'quote',
        'requestedAmount',
        'transferAmounts',
      ].sort(),
    );
    const payment = (await h.store.transaction((tx) => tx.paymentForCharge(charge.id)))!;
    expect(json).toMatchObject({
      id: USER,
      callback: 'https://example.test/lnurlp/cb/shop',
      minSendable: CHARGE_SATS * 1000,
      maxSendable: CHARGE_SATS * 1000,
      metadata: METADATA,
      displayName: 'Corner Shop',
      recipient: { name: 'Corner Shop' },
      quote: { expiration: '2026-10-17T10:01:30.000Z', payment: payment.id },
    });
    expect(text).toContain('"requestedAmount":{"asset":"BTC","amount":0.000021}');
    expect(sleepCalls).toEqual([8_000]);
  });

  it('answers today’s pinned request when the creation offers nothing, throws, or outlasts the 8 s budget', async () => {
    const h = await setup();
    await h.pos.create(chargeRow());
    h.orchestra.routesResult = { ok: false };
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });

    const thrown = await setup();
    await thrown.pos.create(chargeRow());
    thrown.orchestra.routesImpl = () => Promise.reject(new Error('boom'));
    expect(await thrown.svc.payLink(thrown.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
    // The thrown creation is no longer in flight: the next request starts a new one.
    expect(await thrown.svc.payLink(thrown.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
    expect(thrown.orchestra.routesCalls).toHaveLength(2);

    const slow = await setup();
    await slow.pos.create(chargeRow());
    slow.orchestra.routesImpl = () => new Promise(() => undefined);
    sleepImpl = (ms) => (ms === 8_000 ? Promise.resolve() : defaultSleep(ms));
    expect(await slow.svc.payLink(slow.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
  });

  it('joining a running creation waits until 8 s after the fetch arrived, whatever that procedure’s budget, with or without timeout', async () => {
    expect(SHOP_PAY_LINK_CREATION_WAIT_MS).toBe(8_000);
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      h.orchestra.routesImpl = () => new Promise(() => undefined);
      h.svc.startForCharge(h.account, charge, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
      clock = T0 + 5_000;
      sleepImpl = (ms) => (ms === 8_000 || ms === 4_000 ? Promise.resolve() : defaultSleep(ms));
      // Arrived now: the full 8 s, although the joined run started 5 s ago.
      expect(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      ).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      // Arrived 1 s after the run started (4 s spent resolving the wallet): 4 s left.
      expect(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, T0 + 1_000),
      ).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      expect(sleepCalls).toEqual([8_000, 4_000]);

      // A fetch that reaches this point 8 s or more after it arrived does not wait.
      sleepCalls = [];
      for (const arrivedMs of [T0 - 3_000, T0 - 3_001]) {
        expect(
          await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, arrivedMs),
        ).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      }
      expect(sleepCalls).toEqual([]);
      expect(h.orchestra.routesCalls).toHaveLength(1);
      sleepImpl = defaultSleep;
    }
  });

  it('a wallet resolve of 3 s and a creation of 6 s: answers today’s pinned request 8 s after the arrival, and the payment exists afterwards', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    let releaseRoutes = (_result: OrchestraRoutesResult): void => undefined;
    h.orchestra.routesImpl = () =>
      new Promise((resolve) => {
        releaseRoutes = resolve;
      });
    let endWait = (): void => undefined;
    sleepImpl = (ms) =>
      ms === 5_000
        ? new Promise<void>((resolve) => {
            endWait = resolve;
          })
        : defaultSleep(ms);
    clock = T0 + 3_000;
    const answer = h.svc.payLink(h.account, USER, METADATA, NO_QUERY, T0);
    await vi.waitFor(() => expect(sleepCalls).toEqual([5_000]));
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
    clock = T0 + 8_000;
    endWait();
    expect(await answer).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
    // The creation goes on in the background and ends at 9 s.
    clock = T0 + 9_000;
    releaseRoutes({ ok: true, assets: defaultRoutes(), validForMs: 60_000 });
    await vi.waitFor(async () =>
      expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).not.toBeNull(),
    );
  });

  it('a creation that ends 7 s after the arrival answers the open amount', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.orchestra.routesImpl = async () => {
      clock = T0 + 7_000;
      return { ok: true, assets: defaultRoutes(), validForMs: 60_000 };
    };
    clock = T0 + 3_000;
    const { status, json } = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, T0),
    );
    expect(status).toBe(200);
    expect(json['minSendable']).toBe(CHARGE_SATS * 1000);
    expect(sleepCalls).toEqual([5_000]);
  });

  it('a creation queued 7 s behind a held lock still answers at most 8 s after the arrival', async () => {
    const h = await setup();
    const release = heldRoutes(h);
    const payer = h.svc.createForPayer(h.account, USER, SATS, clock);
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
    await h.pos.create(chargeRow());
    // Arrived at T0 + 1 s, reaches the creation at T0 + 3 s (wallet resolve).
    clock = T0 + 3_000;
    let endWait = (): void => undefined;
    sleepImpl = (ms) =>
      ms === 6_000
        ? new Promise<void>((resolve) => {
            endWait = resolve;
          })
        : defaultSleep(ms);
    const answer = h.svc.payLink(h.account, USER, METADATA, NO_QUERY, T0 + 1_000);
    await vi.waitFor(() => expect(sleepCalls).toEqual([6_000]));
    // The lock is held until T0 + 8 s (7 s after the arrival); the run then
    // takes it, and its route list does not answer before the wait ends.
    clock = T0 + 8_000;
    release({ ok: false });
    expect(await payer).toEqual({ kind: 'unavailable' });
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
    clock = T0 + 9_000;
    endWait();
    expect(await answer).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
    expect(sleepCalls).toEqual([6_000]);
  });

  /**
   * Route-list fetches that wait until released; the first release answers
   * the first fetch, later fetches never answer.
   */
  function heldRoutes(h: Harness): (result: OrchestraRoutesResult) => void {
    const releases: ((result: OrchestraRoutesResult) => void)[] = [];
    h.orchestra.routesImpl = () =>
      new Promise((resolve) => {
        releases.push(resolve);
      });
    return (result) => releases[0]?.(result);
  }

  it('a lock holder that never releases: the request answers today’s pinned request 8 s after its arrival, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      h.orchestra.routesImpl = () => new Promise(() => undefined);
      void h.svc.createForPayer(h.account, USER, SATS, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
      await h.pos.create(chargeRow());
      clock = T0 + 5_000;
      sleepImpl = (ms) => (ms === 8_000 ? Promise.resolve() : defaultSleep(ms));
      expect(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      ).toEqual({
        kind: 'today',
        pinSats: CHARGE_SATS,
      });
      // One wait of 8 s from the arrival; the charge's creation is still queued.
      expect(sleepCalls).toEqual([8_000]);
      expect(h.orchestra.routesCalls).toHaveLength(1);
      sleepImpl = defaultSleep;
    }
  });

  it('a charge creation queued behind a payer creation that holds the lock 7 s answers 8 s after the arrival at the latest, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const release = heldRoutes(h);
      const payer = h.svc.createForPayer(h.account, USER, SATS, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
      const charge = chargeRow();
      await h.pos.create(charge);
      clock = T0 + 5_000;
      let endWait = (): void => undefined;
      sleepImpl = (ms) =>
        ms === 8_000
          ? new Promise<void>((resolve) => {
              endWait = resolve;
            })
          : defaultSleep(ms);
      const answer = h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock);
      // Still queued, the request already waits 8 s from its arrival.
      await vi.waitFor(() => expect(sleepCalls).toEqual([8_000]));
      clock = T0 + 12_000;
      release({ ok: false });
      expect(await payer).toEqual({ kind: 'unavailable' });
      // The charge's run took the lock at T0 + 12 s; its route list does not answer.
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
      clock = T0 + 13_000;
      endWait();
      expect(await answer).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      expect(sleepCalls).toEqual([8_000]);
      sleepImpl = defaultSleep;
    }
  });

  it('two simultaneous requests for one charge queued behind a held lock share one creation run and answer within 8 s of their arrival, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      let releasePayer = (_result: OrchestraRoutesResult): void => undefined;
      h.orchestra.routesImpl = () =>
        h.orchestra.routesCalls.length === 1
          ? new Promise((resolve) => {
              releasePayer = resolve;
            })
          : Promise.resolve({ ok: false });
      const payer = h.svc.createForPayer(h.account, USER, SATS, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
      await h.pos.create(chargeRow());
      clock = T0 + 5_000;
      // The 8 s waits never end: only the shared creation ends both requests.
      const first = h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock);
      const second = h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock);
      await vi.waitFor(() => expect(sleepCalls).toEqual([8_000, 8_000]));
      clock = T0 + 12_000;
      releasePayer({ ok: false });
      expect(await payer).toEqual({ kind: 'unavailable' });
      expect(await first).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      expect(await second).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      // One route-list fetch for the payer, one for the charge's single run.
      expect(h.orchestra.routesCalls).toHaveLength(2);
    }
  });

  it('a charge creation queued behind a quote replacement answers 8 s after the arrival at the latest, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const payment = await payerPayment(h);
      // The cached route list expired, so the replacement reads it again.
      clock = T0 + 60_001;
      const release = heldRoutes(h);
      const replacement = h.svc.currentQuote(h.account, USER, payment);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
      await h.store.transaction((tx) =>
        tx.updatePayment(
          payment.id,
          {},
          { status: 'ended', endReason: 'cancelled', endedAt: new Date(clock) },
        ),
      );
      await h.pos.create(chargeRow());
      clock = T0 + 62_000;
      sleepImpl = (ms) => (ms === 8_000 ? Promise.resolve() : defaultSleep(ms));
      // Answered while the replacement still holds the lock.
      expect(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      ).toEqual({
        kind: 'today',
        pinSats: CHARGE_SATS,
      });
      expect(sleepCalls).toEqual([4_000, 8_000]);
      expect(h.orchestra.routesCalls).toHaveLength(2);
      // The charge's creation goes on in the background once the lock is free.
      release({ ok: false });
      expect(await replacement).toBeNull();
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(3));
      sleepImpl = defaultSleep;
    }
  });

  it('a queued charge creation that re-reads and stops at once ends the wait right away, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const release = heldRoutes(h);
      const payer = h.svc.createForPayer(h.account, USER, SATS, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
      const charge = chargeRow();
      await h.pos.create(charge);
      // The budget sleep never ends: only the stopped run ends the wait.
      const answer = h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.pos.cancelPending(ACCOUNT_ID, clock);
      release({ ok: false });
      expect(await payer).toEqual({ kind: 'unavailable' });
      const result = await answer;
      if (timeout === null) {
        expect(result).toEqual({ kind: 'today', pinSats: null });
      } else {
        expect((await bodyOf(result)).status).toBe(404);
      }
      expect(h.orchestra.routesCalls).toHaveLength(1);
      expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
    }
  });

  it('an earlier creation for the same charge that ended gives the next fetch its own 8 s, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      h.orchestra.routesResult = { ok: false };
      expect(await h.svc.createForCharge(h.account, USER, charge, clock)).toEqual({
        kind: 'unavailable',
      });
      clock = T0 + 5_000;
      h.orchestra.routesImpl = () => new Promise(() => undefined);
      sleepImpl = (ms) => (ms === 8_000 ? Promise.resolve() : defaultSleep(ms));
      expect(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      ).toEqual({
        kind: 'today',
        pinSats: CHARGE_SATS,
      });
      expect(sleepCalls).toEqual([8_000]);
      sleepImpl = defaultSleep;
    }
  });

  it('keeps the pin for a waiting charge: no payment (excluded username) or an ended one; no pin for accepted or paid', async () => {
    const h = await setup({ username: 'cb' });
    const charge = chargeRow();
    await h.pos.create(charge);
    expect(await h.svc.payLink(h.account, 'cb', METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
    expect(h.orchestra.routesCalls).toHaveLength(0);

    const payment = paymentRow({
      posChargeId: charge.id,
      status: 'ended',
      endReason: 'orchestra_refunded',
      endedAt: new Date(T0),
    });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect(await h.svc.payLink(h.account, 'cb', METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
    for (const status of ['accepted', 'paid'] as const) {
      await h.store.transaction((tx) =>
        tx.updatePayment(
          payment.id,
          {},
          {
            status,
            endedAt: null,
            endReason: null,
            acceptedAt: new Date(T0),
            paidAt: status === 'paid' ? new Date(T0) : null,
          },
        ),
      );
      expect(await h.svc.payLink(h.account, 'cb', METADATA, NO_QUERY, clock)).toEqual({
        kind: 'today',
        pinSats: null,
      });
    }
  });

  it('answers the open amount with or without timeout', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    for (const timeout of [null, '0', '5']) {
      const { status, json } = await bodyOf(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      );
      expect(status).toBe(200);
      expect((json['quote'] as Record<string, unknown>)['payment']).toBe(payment.id);
    }
    expect(sleepCalls).toEqual([]);
  });

  it('timeout: waits every 250 ms up to the timeout, then answers 404 with the standard body', async () => {
    const h = await setup();
    const { status, json } = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '3' }, clock),
    );
    expect(status).toBe(404);
    expect(json).toEqual(noPendingPaymentBody(USER, 'Corner Shop'));
    expect(sleepCalls).toEqual(Array(12).fill(250));
  });

  it('timeout: values above 10 count as 10; empty or unparseable count as 0', async () => {
    const h = await setup();
    await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '99' }, clock);
    expect(sleepCalls).toHaveLength(40);
    sleepCalls = [];
    for (const timeout of ['', 'abc', '-1', '1.5']) {
      expect(
        (
          await bodyOf(
            await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
          )
        ).status,
      ).toBe(404);
    }
    expect(sleepCalls).toEqual([]);
  });

  it('timeout: a charge whose payment is accepted, paid, or ended counts as nothing waiting', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const payment = paymentRow({
      posChargeId: charge.id,
      status: 'accepted',
      acceptedAt: new Date(T0),
    });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect(
      (
        await bodyOf(
          await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '0' }, clock),
        )
      ).status,
    ).toBe(404);
    // LNURL wallets (no timeout) still get today's request.
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: null,
    });
  });

  it('timeout: a pending charge that appears while waiting answers as without timeout, starting the creation', async () => {
    const h = await setup();
    sleepImpl = async (ms) => {
      if (ms !== 250) {
        return new Promise(() => undefined);
      }
      clock += ms;
      if (sleepCalls.length === 2) {
        await h.pos.create(chargeRow());
      }
    };
    const { status, json } = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '10' }, clock),
    );
    expect(status).toBe(200);
    expect(json['minSendable']).toBe(CHARGE_SATS * 1000);
  });

  it('timeout: a pending charge without payment and an excluded username answers today’s pinned request', async () => {
    const h = await setup({ username: 'cb' });
    await h.pos.create(chargeRow());
    expect(
      await h.svc.payLink(h.account, 'cb', METADATA, { ...NO_QUERY, timeout: '3' }, clock),
    ).toEqual({
      kind: 'today',
      pinSats: CHARGE_SATS,
    });
  });

  it('timeout: at most 50 requests wait at the same time; a further request is answered at once', async () => {
    const h = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sleepImpl = (ms) => (ms === 250 ? gate : new Promise(() => undefined));
    const waiting = Array.from({ length: 50 }, () =>
      h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '10' }, clock),
    );
    await vi.waitFor(() => expect(sleepCalls).toHaveLength(50));
    const extra = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '10' }, clock),
    );
    expect(extra.status).toBe(404);
    expect(sleepCalls).toHaveLength(50);
    clock += 11_000;
    release();
    for (const answer of await Promise.all(waiting)) {
      expect((await bodyOf(answer)).status).toBe(404);
    }
    sleepImpl = defaultSleep;
    await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '1' }, clock);
    expect(sleepCalls).toHaveLength(54);
  });

  it('answers as without an open amount when the payment leaves open during the fetch', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    let reads = 0;
    h.store.hooks.getPayment = async (tx, ...args) => {
      const row = await tx.getPayment(...(args as unknown as [string]));
      reads += 1;
      return row === null ? null : { ...row, status: 'ended' };
    };
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: null,
    });
    expect(reads).toBe(1);
    expect((await h.store.inner.transaction((tx) => tx.getPayment(payment.id)))?.status).toBe(
      'open',
    );
    // The simplified flow without an open amount is the 404.
    const simplified = await bodyOf(
      await h.svc.payLink(
        h.account,
        USER,
        METADATA,
        {
          ...NO_QUERY,
          method: 'Polygon',
          asset: 'USDT',
        },
        clock,
      ),
    );
    expect(simplified.status).toBe(404);
    expect(simplified.json).toEqual(noPendingPaymentBody(USER, 'Corner Shop'));
  });

  it('answers from the state after a creation that was skipped: a charge cancelled meanwhile is unpinned', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.pos.cancelPending(ACCOUNT_ID, clock);
    };
    expect(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock)).toEqual({
      kind: 'today',
      pinSats: null,
    });
    expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).toBeNull();
  });

  it('answers from the state after the 8 s budget: a charge paid meanwhile is unpinned, and the 404 with timeout', async () => {
    for (const timeout of [null, '1'] as const) {
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      h.orchestra.routesImpl = () => new Promise(() => undefined);
      sleepImpl = async (ms) => {
        if (ms !== 8_000) {
          return defaultSleep(ms);
        }
        await h.pos.markPaid(charge.id, clock);
      };
      const answer = await h.svc.payLink(
        h.account,
        USER,
        METADATA,
        { ...NO_QUERY, timeout },
        clock,
      );
      if (timeout === null) {
        expect(answer).toEqual({ kind: 'today', pinSats: null });
      } else {
        expect((await bodyOf(answer)).status).toBe(404);
      }
    }
  });

  it('keeps the pin when the charge’s open payment ends during the fetch while the charge still waits', async () => {
    for (const query of [
      NO_QUERY,
      { ...NO_QUERY, timeout: '0' },
      { ...NO_QUERY, method: 'Polygon', asset: 'USDT' },
    ]) {
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      const created = await h.svc.createForCharge(h.account, USER, charge, clock);
      expect(created.kind).toBe('payment');
      let ended = false;
      h.store.hooks.getPayment = async (tx, ...args) => {
        const row = await tx.getPayment(...(args as unknown as [string]));
        if (!ended && row !== null) {
          ended = true;
          // Another request ends it (`window`) between the state read and the quote read.
          return endPayment(tx, row, 'window', clock);
        }
        return row;
      };
      const answer = await h.svc.payLink(h.account, USER, METADATA, query, clock);
      expect(ended).toBe(true);
      if (query === NO_QUERY) {
        expect(answer).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
      } else {
        // With `timeout` an ended payment is nothing waiting; the simplified flow has no open amount.
        const { status, json } = await bodyOf(answer);
        expect(status).toBe(404);
        expect(json).toEqual(noPendingPaymentBody(USER, 'Corner Shop'));
      }
    }
  });

  it('answers the 404 to a request with timeout whose payment left open during the fetch', async () => {
    const h = await setup();
    await payerPayment(h);
    h.store.hooks.getPayment = async (tx, ...args) => {
      const row = await tx.getPayment(...(args as unknown as [string]));
      return row === null ? null : { ...row, status: 'ended' };
    };
    const answer = await bodyOf(
      await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout: '0' }, clock),
    );
    expect(answer.status).toBe(404);
    expect(answer.json).toEqual(noPendingPaymentBody(USER, 'Corner Shop'));
  });

  it('timeout: a charge found 8.5 s after the arrival starts the creation without waiting and answers today’s pinned request', async () => {
    const h = await setup();
    const charge = chargeRow();
    sleepImpl = async (ms) => {
      if (ms !== 250) {
        return new Promise(() => undefined);
      }
      clock += ms;
      // 8.5 s into a 10 s wait the till opens a charge.
      if (sleepCalls.length === 34) {
        await h.pos.create(charge);
      }
    };
    const answer = await h.svc.payLink(
      h.account,
      USER,
      METADATA,
      { ...NO_QUERY, timeout: '10' },
      clock,
    );
    expect(answer).toEqual({ kind: 'today', pinSats: CHARGE_SATS });
    expect(sleepCalls.filter((ms) => ms !== 250)).toEqual([]);
    // The creation it started goes on in the background.
    await vi.waitFor(async () =>
      expect(await h.store.transaction((tx) => tx.paymentForCharge(charge.id))).not.toBeNull(),
    );
  });
});

describe('quote replacement and the Lightning-only fallback (Lifetimes, Quotes)', () => {
  it('keeps the current quote while 45 s or more remain', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    clock = T0 + 45_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.id).toBe(first!.id);
    expect(h.orchestra.quoteCalls).toHaveLength(12);
  });

  it('replaces a quote with less than 45 s left: same payment and BOLT11, conditional increment, previous quote kept', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    clock = T0 + 45_001;
    const answer = await bodyOf(await h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock));
    const quote = answer.json['quote'] as Record<string, string>;
    expect(quote['payment']).toBe(payment.id);
    expect(quote['id']).not.toBe(first!.id);
    expect(quote['expiration']).toBe(new Date(T0 + 45_001 + 90_000).toISOString());
    expect(h.orchestra.quoteCalls).toHaveLength(24);
    for (const call of h.orchestra.quoteCalls.slice(12)) {
      expect(call.request).toMatchObject({
        bolt11: payment.bolt11,
        tag: payment.id,
        amountSats: SATS,
      });
      // The calls end the commit margin before the fetch's 4 s wait.
      expect(call.deadlineMs).toBe(
        T0 + 45_001 + SHOP_REPLACEMENT_BUDGET_MS - SHOP_REPLACEMENT_COMMIT_MARGIN_MS,
      );
    }
    // The route list's own 1 s ends before that deadline.
    expect(
      T0 + 45_001 + SHOP_REPLACEMENT_BUDGET_MS - SHOP_REPLACEMENT_COMMIT_MARGIN_MS,
    ).toBeGreaterThan(T0 + 45_001 + 1_000);
    expect(h.orchestra.routesCalls).toEqual([1_000]);
    expect((await readPayment(h, payment.id)).replacements).toBe(1);
    expect(h.net.issued).toHaveLength(1);
    // The previous quote still serves its detail until its own expiration.
    const detail = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: first!.id,
      method: 'Polygon',
      asset: 'USDT',
      repeated: false,
    });
    expect(detail.status).toBe(200);
  });

  it('a second fetch in the same container waits for the replacement and returns it', async () => {
    const h = await setup();
    await payerPayment(h);
    clock = T0 + 50_000;
    const [a, b] = await Promise.all([
      h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock),
      h.svc.payLink(h.account, USER, METADATA, NO_QUERY, clock),
    ]);
    const qa = (await bodyOf(a)).json['quote'] as Record<string, string>;
    const qb = (await bodyOf(b)).json['quote'] as Record<string, string>;
    expect(qa['id']).toBe(qb['id']);
    expect(h.orchestra.quoteCalls).toHaveLength(24);
  });

  it('a replacement with no committed offer is a Lightning-only quote and counts as a replacement', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    h.orchestra.quoteImpl = () => ({ ok: false, reason: 'refused' });
    clock = T0 + 50_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt.getTime()).toBe(T0 + 300_000);
    expect((await readPayment(h, payment.id)).replacements).toBe(1);
    // A Lightning-only quote is never replaced.
    clock = T0 + 280_000;
    h.orchestra.quoteImpl = null;
    expect((await h.svc.currentQuote(h.account, USER, payment))?.quote.id).toBe(read?.quote.id);
  });

  it('a failed route list during a replacement gives a Lightning-only replacement', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    h.orchestra.routesResult = { ok: false };
    clock = T0 + 60_001;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    // The cached list expired, so the replacement read the route list again.
    expect(h.orchestra.routesCalls).toHaveLength(2);
    expect(read?.quote.transferAmounts).toHaveLength(1);
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    expect((await readPayment(h, payment.id)).replacements).toBe(1);
  });

  it('never replaces in the last 45 s of the window; an expired quote then gets a Lightning-only row that is not a replacement', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    clock = T0 + 255_001;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt.getTime()).toBe(T0 + 300_000);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    // The next fetch returns that row unchanged.
    expect((await h.svc.currentQuote(h.account, USER, payment))?.quote.id).toBe(read?.quote.id);
    expect(await quotesOf(h, payment.id)).toHaveLength(2);
  });

  it('allows at most 4 replacements', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    await h.store.transaction((tx) => tx.updatePayment(payment.id, {}, { replacements: 4 }));
    clock = T0 + 50_000;
    const [first] = await quotesOf(h, payment.id);
    expect((await h.svc.currentQuote(h.account, USER, payment))?.quote.id).toBe(first!.id);
    clock = T0 + 90_000;
    const fallback = await h.svc.currentQuote(h.account, USER, payment);
    expect(fallback?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(fallback?.quote.expiresAt).toEqual(payment.windowEndsAt);
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    expect((await readPayment(h, payment.id)).replacements).toBe(4);
  });

  it('does not replace when stablecoins are off for the username; an expired quote falls back to Lightning-only', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    clock = T0 + 90_000;
    const read = await h.svc.currentQuote(h.account, 'cb', payment);
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt).toEqual(payment.windowEndsAt);
    expect(h.orchestra.quoteCalls).toHaveLength(12);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
  });

  it('a replacement that loses the conditional increment inserts nothing and answers the quote that is current now', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    // Another container's replacement wins meanwhile: it counts and inserts a newer quote.
    const newer: ShopQuote = {
      id: crypto.randomUUID(),
      paymentId: payment.id,
      expiresAt: new Date(T0 + 140_000),
      transferAmounts: [lightningTransferAmount(SATS)],
      createdAt: new Date(T0 + 50_000),
    };
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.store.transaction(async (tx) => {
        await tx.updatePayment(payment.id, {}, { replacements: 1 });
        await tx.insertQuote(newer);
      });
    };
    clock = T0 + 50_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.id).toBe(newer.id);
    expect((await quotesOf(h, payment.id)).map((quote) => quote.id)).toEqual([first!.id, newer.id]);
    expect((await readPayment(h, payment.id)).replacements).toBe(1);
  });

  it('a replacement whose slow pair runs into its call deadline still commits inside the fetch wait and is answered, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const payment = await payerPayment(h);
      const [first] = await quotesOf(h, payment.id);
      // One timeline: the fetch's 4 s wait and the slow pair's deadline are
      // timers, and the earlier one fires first (the fetch's on a tie).
      const timers: { atMs: number; fetch: boolean; fire: () => void }[] = [];
      sleepImpl = (ms) =>
        ms === SHOP_REPLACEMENT_BUDGET_MS
          ? new Promise((resolve) => {
              timers.push({ atMs: clock + ms, fetch: true, fire: resolve });
            })
          : defaultSleep(ms);
      // Polygon USDT answers only at its deadline, without a quote.
      const slow = (request: OrchestraQuoteRequest): boolean =>
        request.sourceChain === 'polygon' && request.sourceAsset === 'USDT';
      h.orchestra.onQuote = (request) => {
        const call = h.orchestra.quoteCalls[h.orchestra.quoteCalls.length - 1]!;
        return slow(request)
          ? new Promise((resolve) => {
              timers.push({ atMs: call.deadlineMs, fetch: false, fire: resolve });
            })
          : Promise.resolve();
      };
      h.orchestra.quoteImpl = (request) =>
        slow(request)
          ? { ok: false, reason: 'unavailable' }
          : { ok: true, quote: h.orchestra.validQuote(request) };
      // The quote read expires at T0 + 90 s, 2 s into the fetch's wait.
      const arrivalMs = T0 + 88_000;
      clock = arrivalMs;
      const answering = h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock);
      await vi.waitFor(() => expect(timers).toHaveLength(2));
      timers.sort((x, y) => x.atMs - y.atMs || Number(y.fetch) - Number(x.fetch));
      const [earliest, later] = timers as [(typeof timers)[0], (typeof timers)[0]];
      expect(earliest.fetch).toBe(false);
      expect(earliest.atMs).toBe(
        arrivalMs + SHOP_REPLACEMENT_BUDGET_MS - SHOP_REPLACEMENT_COMMIT_MARGIN_MS,
      );
      expect(later.atMs).toBe(arrivalMs + SHOP_REPLACEMENT_BUDGET_MS);
      clock = earliest.atMs;
      earliest.fire();
      const answer = await bodyOf(await answering);
      const quote = answer.json['quote'] as Record<string, string>;
      const stored = await quotesOf(h, payment.id);
      expect(stored.map((row) => row.id)).toEqual([first!.id, quote['id']]);
      // The replacement's quote with the 11 pairs that answered in time.
      const offers = await h.store.transaction((tx) => tx.offersOf(quote['id']!));
      expect(offers).toHaveLength(11);
      expect(offers.some((offer) => offer.method === 'Polygon' && offer.asset === 'USDT')).toBe(
        false,
      );
      expect((await readPayment(h, payment.id)).replacements).toBe(1);
      // The fetch's wait never ended: the replacement did.
      expect(sleepCalls).toEqual([4_000]);
      sleepImpl = defaultSleep;
    }
  });

  it('a replacement that took the lock after the fetch arrived and commits after the fetch inserted the Lightning-only row inserts nothing', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    // A payer creation holds the creation lock; the cached route list
    // expired, so it reads the list again, which answers on release.
    clock = T0 + 88_000;
    let releaseCreation = (_result: OrchestraRoutesResult): void => undefined;
    h.orchestra.routesImpl = () =>
      new Promise((resolve) => {
        releaseCreation = resolve;
      });
    const payer = h.svc.createForPayer(h.account, USER, SATS + 1, clock);
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
    // The fetch's replacement queues behind it, so the fetch waits 4 s from
    // its arrival; that wait ends on wake.
    let wake = (): void => undefined;
    sleepImpl = (ms) =>
      ms === SHOP_REPLACEMENT_BUDGET_MS
        ? new Promise((resolve) => {
            wake = resolve;
          })
        : defaultSleep(ms);
    const reading = h.svc.currentQuote(h.account, USER, payment);
    await vi.waitFor(() => expect(sleepCalls).toEqual([4_000]));
    // 3 s after the arrival the creation ends and the replacement takes the
    // lock; its route list answers on release.
    let releaseReplacement = (_result: OrchestraRoutesResult): void => undefined;
    h.orchestra.routesImpl = () =>
      new Promise((resolve) => {
        releaseReplacement = resolve;
      });
    const startMs = T0 + 91_000;
    clock = startMs;
    releaseCreation({ ok: false });
    expect(await payer).toEqual({ kind: 'unavailable' });
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(3));
    // The fetch's wait ends at arrival + 4 s, before the replacement's calls
    // end; the quote read expired at T0 + 90 s, so the fetch inserts the
    // Lightning-only row.
    const callsEndMs = startMs + SHOP_REPLACEMENT_BUDGET_MS - SHOP_REPLACEMENT_COMMIT_MARGIN_MS;
    expect(callsEndMs).toBeGreaterThan(T0 + 92_000);
    clock = T0 + 92_000;
    wake();
    const read = await reading;
    sleepImpl = defaultSleep;
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt).toEqual(payment.windowEndsAt);
    const fallback = read!.quote;
    // The replacement's calls end and it takes the account row lock.
    let locked = false;
    h.store.hooks.lockAccount = async (tx, ...args) => {
      const [accountId] = args as unknown as [string];
      locked = true;
      return tx.lockAccount(accountId);
    };
    clock = callsEndMs;
    releaseReplacement(h.orchestra.routesResult);
    await vi.waitFor(() => expect(locked).toBe(true));
    // Transactions run in call order: this one starts after the replacement's.
    await h.store.transaction(async () => undefined);
    delete h.store.hooks.lockAccount;
    for (const call of h.orchestra.quoteCalls.slice(12)) {
      expect(call.deadlineMs).toBe(callsEndMs);
    }
    expect(h.orchestra.quoteCalls).toHaveLength(24);
    expect((await quotesOf(h, payment.id)).map((quote) => quote.id)).toEqual([
      first!.id,
      fallback.id,
    ]);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
    const again = await h.svc.currentQuote(h.account, USER, payment);
    expect(again?.quote.id).toBe(fallback.id);
  });

  it('a replacement whose window shrank below 45 s meanwhile inserts nothing', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      clock = T0 + 255_001;
    };
    clock = T0 + 50_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    // The old quote expired at T0 + 90 s: the fallback row answers.
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt).toEqual(payment.windowEndsAt);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
  });

  it('a payment that left open during the replacement answers as ended, also for a fetch waiting on the lock', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    h.orchestra.onQuote = async () => {
      h.orchestra.onQuote = null;
      await h.store.transaction((tx) => endPayment(tx, payment, 'replaced', clock));
    };
    clock = T0 + 50_000;
    const [a, b] = await Promise.all([
      h.svc.currentQuote(h.account, USER, payment),
      h.svc.currentQuote(h.account, USER, payment),
    ]);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it('the Lightning-only fallback re-reads under the lock: a payment no longer open, or a newer valid quote', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    clock = T0 + 260_000;
    let lockReads = 0;
    h.store.hooks.lockPayment = async (tx, ...args) => {
      lockReads += 1;
      const row = await tx.lockPayment(...(args as unknown as [string]));
      return row === null ? null : { ...row, status: 'ended' };
    };
    expect(await h.svc.currentQuote(h.account, USER, payment)).toBeNull();
    expect(lockReads).toBe(1);
    delete h.store.hooks.lockPayment;

    const newer: ShopQuote = {
      id: crypto.randomUUID(),
      paymentId: payment.id,
      expiresAt: new Date(T0 + 290_000),
      transferAmounts: [lightningTransferAmount(SATS)],
      createdAt: new Date(T0 + 1),
    };
    let first = true;
    h.store.hooks.quotesOf = async (tx, ...args) => {
      const rows = await tx.quotesOf(...(args as unknown as [string]));
      if (first) {
        first = false;
        return rows;
      }
      return [...rows, newer];
    };
    expect((await h.svc.currentQuote(h.account, USER, payment))?.quote.id).toBe(newer.id);
  });

  /** Hold the account's creation lock: a payer creation whose route list never answers. */
  async function holdLock(h: Harness): Promise<void> {
    h.orchestra.routesImpl = () => new Promise(() => undefined);
    const before = h.orchestra.routesCalls.length;
    void h.svc.createForPayer(h.account, USER, SATS + 1, clock);
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(before + 1));
  }

  it('a replacement queued behind a held lock: the fetch answers the still-valid quote 4 s after its arrival, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const payment = await payerPayment(h);
      const [first] = await quotesOf(h, payment.id);
      // The cached route list expired, so the lock holder reads it again and hangs.
      clock = T0 + 61_000;
      await holdLock(h);
      sleepImpl = (ms) => (ms === 4_000 ? Promise.resolve() : defaultSleep(ms));
      const answer = await bodyOf(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      );
      expect(answer.status).toBe(200);
      expect((answer.json['quote'] as Record<string, string>)['id']).toBe(first!.id);
      expect(sleepCalls).toEqual([4_000]);
      expect((await readPayment(h, payment.id)).replacements).toBe(0);
      expect(await quotesOf(h, payment.id)).toHaveLength(1);
      sleepImpl = defaultSleep;
    }
  });

  it('a replacement queued behind a held lock: an expired quote gets the Lightning-only row after 4 s', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    clock = T0 + 95_000;
    await holdLock(h);
    sleepImpl = (ms) => (ms === 4_000 ? Promise.resolve() : defaultSleep(ms));
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.transferAmounts).toEqual([lightningTransferAmount(SATS)]);
    expect(read?.quote.expiresAt).toEqual(payment.windowEndsAt);
    expect(sleepCalls).toEqual([4_000]);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
  });

  it('a replacement that ends within the wait answers its new quote, with or without timeout', async () => {
    for (const timeout of [null, '5']) {
      sleepCalls = [];
      clock = T0;
      const h = await setup();
      const payment = await payerPayment(h);
      const [first] = await quotesOf(h, payment.id);
      clock = T0 + 50_000;
      const answer = await bodyOf(
        await h.svc.payLink(h.account, USER, METADATA, { ...NO_QUERY, timeout }, clock),
      );
      const quote = answer.json['quote'] as Record<string, string>;
      expect(quote['id']).not.toBe(first!.id);
      expect(quote['expiration']).toBe(new Date(T0 + 50_000 + 90_000).toISOString());
      // The 4 s wait never ended: the replacement did.
      expect(sleepCalls).toEqual([4_000]);
      expect((await readPayment(h, payment.id)).replacements).toBe(1);
    }
  });

  it('a fetch that joins a replacement running for 4 s or more answers the current state at once', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    clock = T0 + 61_000;
    h.orchestra.routesImpl = () => new Promise(() => undefined);
    const held = h.svc.currentQuote(h.account, USER, payment);
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
    clock = T0 + 65_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    expect(read?.quote.id).toBe(first!.id);
    // Only the first fetch waited; the second joined the same replacement.
    expect(sleepCalls).toEqual([4_000]);
    expect(h.orchestra.routesCalls).toHaveLength(2);
    void held;
  });

  it('a queued replacement re-reads under the lock: a payment no longer open, or one no longer replaceable, is answered as it stands', async () => {
    for (const change of ['ended', 'used up'] as const) {
      clock = T0;
      const h = await setup();
      const payment = await payerPayment(h);
      const [first] = await quotesOf(h, payment.id);
      clock = T0 + 61_000;
      let release = (_result: OrchestraRoutesResult): void => undefined;
      h.orchestra.routesImpl = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const payer = h.svc.createForPayer(h.account, USER, SATS + 1, clock);
      await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(2));
      // The fetch's replacement is queued behind the payer creation.
      const read = h.svc.currentQuote(h.account, USER, payment);
      await vi.waitFor(() => expect(sleepCalls).toEqual([4_000]));
      await h.store.transaction((tx) =>
        change === 'ended'
          ? tx.updatePayment(
              payment.id,
              {},
              { status: 'ended', endReason: 'cancelled', endedAt: new Date(clock) },
            )
          : tx.updatePayment(payment.id, {}, { replacements: 4 }),
      );
      release({ ok: false });
      expect(await payer).toEqual({ kind: 'unavailable' });
      const answer = await read;
      expect(answer === null ? null : answer.quote.id).toBe(change === 'ended' ? null : first!.id);
      // The replacement read nothing more from Orchestra.
      expect(h.orchestra.routesCalls).toHaveLength(2);
      sleepCalls = [];
    }
  });

  it('a replacement that throws: the fetch answers the current quote', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const [first] = await quotesOf(h, payment.id);
    h.store.hooks.updatePayment = async () => {
      throw new Error('store down');
    };
    clock = T0 + 50_000;
    const read = await h.svc.currentQuote(h.account, USER, payment);
    delete h.store.hooks.updatePayment;
    expect(read?.quote.id).toBe(first!.id);
    expect((await readPayment(h, payment.id)).replacements).toBe(0);
  });

  it('answers null for a payment that is no longer open', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    clock = T0 + 300_000;
    expect(await h.svc.currentQuote(h.account, USER, payment)).toBeNull();
  });
});

describe('simplified flow (Pay link: Simplified flow)', () => {
  it('answers like the callback with the current quote when method and asset are given', async () => {
    const h = await setup();
    const payment = await payerPayment(h);
    const ln = await bodyOf(
      await h.svc.payLink(
        h.account,
        USER,
        METADATA,
        {
          ...NO_QUERY,
          method: 'Lightning',
          asset: 'BTC',
        },
        clock,
      ),
    );
    expect(ln).toMatchObject({ status: 200, json: { pr: payment.bolt11 } });
    const usdt = await bodyOf(
      await h.svc.payLink(
        h.account,
        USER,
        METADATA,
        {
          ...NO_QUERY,
          method: 'Polygon',
          asset: 'USDT',
        },
        clock,
      ),
    );
    expect(usdt.status).toBe(200);
    expect(usdt.json['blockchain']).toBe('Polygon');
    const repeated = await bodyOf(
      await h.svc.payLink(
        h.account,
        USER,
        METADATA,
        {
          ...NO_QUERY,
          method: 'Polygon',
          asset: 'USDT',
          repeated: true,
        },
        clock,
      ),
    );
    expect(repeated.status).toBe(400);
  });

  it('answers the 404 without an open amount, also for a waiting charge', async () => {
    const h = await setup({ username: 'cb' });
    expect(
      (
        await bodyOf(
          await h.svc.payLink(
            h.account,
            'cb',
            METADATA,
            {
              ...NO_QUERY,
              method: 'Polygon',
              asset: 'USDT',
            },
            clock,
          ),
        )
      ).status,
    ).toBe(404);
    await h.pos.create(chargeRow());
    const answer = await bodyOf(
      await h.svc.payLink(
        h.account,
        'cb',
        METADATA,
        {
          ...NO_QUERY,
          method: 'Polygon',
          asset: 'USDT',
        },
        clock,
      ),
    );
    expect(answer.status).toBe(404);
    expect(answer.json['standard']).toBe('OpenCryptoPay');
  });
});

// ─── Callback ──────────────────────────────────────────────────────────────

describe('callback order table (Callback)', () => {
  async function opened() {
    const h = await setup();
    const payment = await payerPayment(h);
    const [quote] = await quotesOf(h, payment.id);
    return { h, payment, quote: quote! };
  }

  it('LNURL amount path: the open amount’s BOLT11 for its millisats, otherwise 400; never mints', async () => {
    const { h, payment } = await opened();
    const ok = await responseJson(
      await h.svc.callback(h.account, USER, {
        amount: String(SATS * 1000),
        quote: null,
        method: null,
        asset: null,
        repeated: false,
      }),
    );
    expect(ok).toEqual({ status: 200, json: { pr: payment.bolt11, routes: [] } });
    const wrong = await responseJson(
      await h.svc.callback(h.account, USER, {
        amount: '1000',
        quote: null,
        method: null,
        asset: null,
        repeated: false,
      }),
    );
    expect(wrong).toEqual({
      status: 400,
      json: shopErrorBody(400, 'Amount does not match this payment'),
    });
    clock = T0 + 300_000;
    const none = await h.svc.callback(h.account, USER, {
      amount: String(SATS * 1000),
      quote: null,
      method: null,
      asset: null,
      repeated: false,
    });
    expect(none.status).toBe(400);
    expect(h.net.issued).toHaveLength(1);
  });

  it('order 1: quote or asset missing, or a repeated key, is 400 That payment is not offered', async () => {
    const { h, quote } = await opened();
    for (const query of [
      { quote: null, asset: 'USDT', repeated: false },
      { quote: quote.id, asset: null, repeated: false },
      { quote: quote.id, asset: 'USDT', repeated: true },
    ]) {
      const response = await responseJson(
        await h.svc.callback(h.account, USER, { amount: null, method: 'Polygon', ...query }),
      );
      expect(response).toEqual({
        status: 400,
        json: shopErrorBody(400, 'That payment is not offered'),
      });
    }
  });

  it('order 2: a quote value that is not a UUID is unknown: 404 Quote expired', async () => {
    const { h, quote } = await opened();
    for (const q of ['not-a-uuid', `${quote.id}x`, quote.id.replaceAll('-', '')]) {
      const response = await h.svc.callback(h.account, USER, {
        amount: null,
        quote: q,
        method: 'Polygon',
        asset: 'USDT',
        repeated: false,
      });
      expect(await responseJson(response)).toEqual({
        status: 404,
        json: shopErrorBody(404, 'Quote expired'),
      });
    }
  });

  it('order 2: a quote that is not current or previous, expired, or without an open amount is 404 Quote expired', async () => {
    const { h, payment, quote } = await opened();
    const ask = (q: string) =>
      h.svc.callback(h.account, USER, {
        amount: null,
        quote: q,
        method: 'Polygon',
        asset: 'USDT',
        repeated: false,
      });
    expect(await responseJson(await ask(crypto.randomUUID()))).toEqual({
      status: 404,
      json: shopErrorBody(404, 'Quote expired'),
    });
    // Two replacements push the first quote out of current and previous.
    clock = T0 + 50_000;
    await h.svc.currentQuote(h.account, USER, payment);
    expect((await ask(quote.id)).status).toBe(200);
    clock = T0 + 100_000;
    await h.svc.currentQuote(h.account, USER, payment);
    expect((await ask(quote.id)).status).toBe(404);
    const quotes = await quotesOf(h, payment.id);
    // The previous quote expired at T0 + 50 s + 90 s.
    clock = T0 + 140_000;
    expect((await ask(quotes[1]!.id)).status).toBe(404);
    expect((await ask(quotes[2]!.id.toUpperCase())).status).toBe(200);
    clock = T0 + 300_000;
    expect((await ask(quotes[2]!.id)).status).toBe(404);
  });

  it('order 3: Lightning and BTC answer the BOLT11, matched without regard to case', async () => {
    const { h, payment, quote } = await opened();
    const response = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'lightning',
      asset: 'btc',
      repeated: false,
    });
    expect(await responseJson(response)).toEqual({ status: 200, json: { pr: payment.bolt11 } });
  });

  it('order 4: an offered stablecoin answers its detail; the first detail sets detail_issued_at and next_history_at', async () => {
    const { h, payment, quote } = await opened();
    clock = T0 + 1_000;
    const response = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'polygon',
      asset: 'usdt',
      repeated: false,
    });
    const offers = await h.store.transaction((tx) => tx.offersOf(quote.id));
    const offer = offers.find((row) => row.method === 'Polygon' && row.asset === 'USDT')!;
    const detail = await responseJson(response);
    expect(detail).toEqual({
      status: 200,
      json: {
        expiryDate: quote.expiresAt.toISOString(),
        blockchain: 'Polygon',
        uri: `ethereum:0xc2132d05d31c914a87c6611c10748aeb04b58e8f@137/transfer?address=${offer.depositAddress}&uint256=1234000`,
        hint: 'Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to https://example.test/lnurlp/tx/shop',
      },
    });
    expect(offer.detailIssuedAt?.getTime()).toBe(T0 + 1_000);
    expect((await readPayment(h, payment.id)).nextHistoryAt?.getTime()).toBe(T0 + 11_000);

    // A repeat returns the same detail and keeps both times.
    clock = T0 + 2_000;
    const again = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'Polygon',
      asset: 'USDT',
      repeated: false,
    });
    expect(await responseJson(again)).toEqual(detail);
    // Another offer's first detail keeps next_history_at.
    await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'Ethereum',
      asset: 'USDT',
      repeated: false,
    });
    expect((await readPayment(h, payment.id)).nextHistoryAt?.getTime()).toBe(T0 + 11_000);
    const after = await h.store.transaction((tx) => tx.offersOf(quote.id));
    expect(after.find((row) => row.id === offer.id)!.detailIssuedAt?.getTime()).toBe(T0 + 1_000);
  });

  it('order 5: anything else is 400 That payment is not offered', async () => {
    const { h, quote } = await opened();
    for (const [method, asset] of [
      ['Tron', 'USDT'],
      ['Lightning', 'USDT'],
      ['Polygon', 'BTC'],
      ['Spark', 'BTC'],
    ]) {
      const response = await h.svc.callback(h.account, USER, {
        amount: null,
        quote: quote.id,
        method: method!,
        asset: asset!,
        repeated: false,
      });
      expect(await responseJson(response)).toEqual({
        status: 400,
        json: shopErrorBody(400, 'That payment is not offered'),
      });
    }
  });

  it('order 5: an offer that the quote does not serve with available true is not offered', async () => {
    const { h, quote } = await opened();
    await h.store.transaction((tx) =>
      tx.updateQuote(quote.id, {
        expiresAt: quote.expiresAt,
        transferAmounts: quote.transferAmounts.map((entry) =>
          entry.method === 'Polygon' ? { ...entry, available: false } : entry,
        ),
      }),
    );
    const response = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'Polygon',
      asset: 'USDT',
      repeated: false,
    });
    expect(response.status).toBe(400);
  });

  it('sets no next_history_at when the payment cannot be read in the detail step', async () => {
    const { h, payment, quote } = await opened();
    let calls = 0;
    h.store.hooks.markDetailIssued = async (tx, ...args) => {
      const set = await tx.markDetailIssued(...(args as unknown as [string, number]));
      h.store.hooks.getPayment = async () => null;
      calls += 1;
      return set;
    };
    const response = await h.svc.callback(h.account, USER, {
      amount: null,
      quote: quote.id,
      method: 'Polygon',
      asset: 'USDT',
      repeated: false,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(
      (await h.store.inner.transaction((tx) => tx.getPayment(payment.id)))?.nextHistoryAt,
    ).toBeNull();
  });
});

// ─── Till ──────────────────────────────────────────────────────────────────

describe('till hooks (By a till charge, Till)', () => {
  it('POST /pos inserts the charge, ends the open payment with superseded, and starts the creation', async () => {
    const h = await setup();
    const payer = await payerPayment(h);
    const charge = chargeRow();
    expect(await h.svc.createCharge(h.account, charge, clock)).toBe(true);
    expect(await readPayment(h, payer.id)).toMatchObject({
      status: 'ended',
      endReason: 'superseded',
    });
    await vi.waitFor(async () => {
      expect(await h.svc.shopPaymentOfCharge(charge.id)).toMatchObject({ status: 'open' });
    });
    const own = await h.svc.shopPaymentOfCharge(charge.id);
    expect(own?.id).not.toBe(payer.id);
    expect(await readPayment(h, payer.id)).toMatchObject({
      status: 'ended',
      endReason: 'superseded',
    });
    expect(await readPayment(h, own!.id)).toMatchObject({
      posChargeId: charge.id,
      amountSats: CHARGE_SATS,
    });
  });

  it('POST /pos ends a lapsed open payment with window', async () => {
    const h = await setup({ username: 'cb' });
    const payment = paymentRow();
    await h.store.transaction((tx) => tx.insertPayment(payment));
    clock = T0 + 300_000;
    const charge = chargeRow();
    expect(await h.svc.createCharge(h.account, charge, clock)).toBe(true);
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0 + 300_000),
    });
    // An excluded username starts no background creation: give one a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.orchestra.routesCalls).toHaveLength(0);
    expect(h.net.issued).toHaveLength(0);
    expect(await h.svc.shopPaymentOfCharge(charge.id)).toBeNull();
  });

  it('POST /pos refuses a second pending charge and changes nothing', async () => {
    const h = await setup({ username: 'cb' });
    await h.pos.create(chargeRow());
    const payment = paymentRow();
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect(await h.svc.createCharge(h.account, chargeRow(), clock)).toBe(false);
    expect((await readPayment(h, payment.id)).status).toBe('open');
  });

  it('logs shop.creation.failed when the background creation throws', async () => {
    const h = await setup();
    h.orchestra.routesImpl = () => Promise.reject(new Error('boom'));
    const charge = chargeRow();
    await h.svc.createCharge(h.account, charge, clock);
    await vi.waitFor(() => {
      expect(eventsNamed('shop.creation.failed')).toEqual([
        {
          event: 'shop.creation.failed',
          fields: { accountId: ACCOUNT_ID, chargeId: charge.id, name: 'Error' },
        },
      ]);
    });
  });

  it('starts no creation for an account without a username', async () => {
    const h = await setup();
    const anonymous = await addAccount(h.auth, '00000000-0000-4000-8000-0000000000c1', null);
    const charge = chargeRow({ accountId: anonymous.id });
    await h.pos.create(charge);
    h.svc.startForCharge(anonymous, charge, clock);
    await vi.waitFor(() => expect(h.orchestra.routesCalls).toHaveLength(1));
    expect(eventsNamed('shop.payment.opened')).toHaveLength(0);
    expect(await h.svc.shopPaymentOfCharge(charge.id)).toBeNull();
  });

  it('DELETE /pos cancels the charge and ends its open payment with cancelled', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    const id = created.kind === 'payment' ? created.payment.id : '';
    clock = T0 + 10_000;
    expect((await h.svc.cancelCharge(ACCOUNT_ID, clock))?.id).toBe(charge.id);
    expect(await readPayment(h, id)).toMatchObject({
      status: 'ended',
      endReason: 'cancelled',
      endedAt: new Date(T0 + 10_000),
    });
    expect(await h.svc.cancelCharge(ACCOUNT_ID, clock)).toBeNull();
  });

  it('DELETE /pos leaves an accepted payment and a charge without payment alone', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const payment = paymentRow({
      posChargeId: charge.id,
      status: 'accepted',
      acceptedAt: new Date(T0),
    });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect((await h.svc.cancelCharge(ACCOUNT_ID, clock))?.status).toBe('cancelled');
    expect((await readPayment(h, payment.id)).status).toBe('accepted');

    await h.pos.create(chargeRow());
    expect((await h.svc.cancelCharge(ACCOUNT_ID, clock))?.status).toBe('cancelled');
  });

  it('charge watch: the payment’s own hash moves the payment to paid in the same step', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    const payment = created.kind === 'payment' ? created.payment : paymentRow();
    clock = T0 + 20_000;
    const paid = await h.svc.chargePaid(charge, payment.paymentHash, clock);
    expect(paid).toMatchObject({ status: 'paid' });
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'paid',
      paidAt: new Date(T0 + 20_000),
      nextSettleAt: null,
    });
    expect(eventsNamed('shop.alert.double_settled')).toHaveLength(0);
  });

  it('charge watch: locks the account, then the charge, then the payment, and alerts on neither', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    const payment = created.kind === 'payment' ? created.payment : paymentRow();
    const calls: string[] = [];
    for (const name of ['lockAccount', 'lockCharge', 'markChargePaid', 'lockPayment'] as const) {
      h.store.hooks[name] = async (tx, ...args) => {
        calls.push(name);
        return (tx[name] as (...a: never[]) => Promise<unknown>).apply(tx, args);
      };
    }
    expect(await h.svc.chargePaid(charge, payment.paymentHash, clock)).toMatchObject({
      status: 'paid',
    });
    expect(calls).toEqual(['lockAccount', 'lockCharge', 'markChargePaid', 'lockPayment']);
    expect(eventsNamed('shop.alert.double_settled')).toHaveLength(0);
    expect(eventsNamed('shop.alert.cancelled_settled')).toHaveLength(0);
  });

  it('charge watch: the payment’s own hash after the Spark invoice paid the charge logs shop.alert.double_settled', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const payment = paymentRow({
      posChargeId: charge.id,
      status: 'ended',
      endReason: 'charge_paid',
    });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    // The Spark invoice paid the charge after the watch listed it.
    await h.pos.markPaid(charge.id, T0);
    clock = T0 + 20_000;
    expect(await h.svc.chargePaid(charge, payment.paymentHash, clock)).toBeNull();
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'paid',
      paidAt: new Date(T0 + 20_000),
    });
    expect(eventsNamed('shop.alert.double_settled').map((entry) => entry.fields)).toEqual([
      { paymentId: payment.id, chargeId: charge.id },
    ]);
    expect(eventsNamed('shop.alert.cancelled_settled')).toHaveLength(0);
  });

  it('charge watch: the payment’s own hash after DELETE /pos logs shop.alert.cancelled_settled and keeps the charge cancelled', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const created = await h.svc.createForCharge(h.account, USER, charge, clock);
    const payment = created.kind === 'payment' ? created.payment : paymentRow();
    expect((await h.svc.cancelCharge(ACCOUNT_ID, clock))?.status).toBe('cancelled');
    expect(await h.svc.chargePaid(charge, payment.paymentHash, clock)).toBeNull();
    expect((await readPayment(h, payment.id)).status).toBe('paid');
    expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('cancelled');
    expect(eventsNamed('shop.alert.cancelled_settled').map((entry) => entry.fields)).toEqual([
      { paymentId: payment.id, chargeId: charge.id },
    ]);
    expect(eventsNamed('shop.alert.double_settled')).toHaveLength(0);
    // A payment already paid moves no more and alerts no more.
    expect(await h.svc.chargePaid(charge, payment.paymentHash, clock)).toBeNull();
    expect(eventsNamed('shop.alert.cancelled_settled')).toHaveLength(1);
  });

  it.each([null, 'ff'.repeat(32)])(
    'charge watch: the Spark invoice or another BOLT11 (%s) ends an open payment with charge_paid',
    async (settled) => {
      const h = await setup();
      const charge = chargeRow();
      await h.pos.create(charge);
      const created = await h.svc.createForCharge(h.account, USER, charge, clock);
      const id = created.kind === 'payment' ? created.payment.id : '';
      expect((await h.svc.chargePaid(charge, settled, clock))?.status).toBe('paid');
      expect(await readPayment(h, id)).toMatchObject({ status: 'ended', endReason: 'charge_paid' });
      expect((await h.svc.shopPaymentOfCharge(charge.id))?.status).toBe('ended');
    },
  );

  it('charge watch: an accepted payment stays accepted when another invoice pays the charge; a charge without payment is just paid', async () => {
    const h = await setup();
    const charge = chargeRow();
    await h.pos.create(charge);
    const payment = paymentRow({
      posChargeId: charge.id,
      status: 'accepted',
      acceptedAt: new Date(T0),
    });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect((await h.svc.chargePaid(charge, null, clock))?.status).toBe('paid');
    expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('paid');
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'accepted',
      endReason: null,
      endedAt: null,
      paidAt: null,
    });

    const lone = chargeRow({ accountId: crypto.randomUUID() });
    await h.pos.create(lone);
    expect((await h.svc.chargePaid(lone, null, clock))?.status).toBe('paid');
    expect(await h.svc.shopPaymentOfCharge(lone.id)).toBeNull();
  });
});

// ─── Settlement ────────────────────────────────────────────────────────────

describe('charge watch settling and settlement cadence (Watcher duty 2, Rows)', () => {
  async function withPayment(over: Partial<ShopPayment> = {}, charge?: PosCharge) {
    const h = await setup();
    if (charge !== undefined) {
      await h.pos.create(charge);
    }
    const payment = paymentRow({ posChargeId: charge?.id ?? null, ...over });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    return { h, payment };
  }

  it('ignores an unknown payment', async () => {
    const h = await setup();
    await h.svc.applySettlement(crypto.randomUUID(), true, clock);
    expect(eventsNamed('shop.payment.paid')).toHaveLength(0);
  });

  it('a payment a merge moved before the lock: locks the account it moved to, then settles', async () => {
    const { h, payment } = await withPayment({}, chargeRow());
    const stale = crypto.randomUUID();
    let reads = 0;
    h.store.hooks.getPayment = async (tx, ...args) => {
      const row = await tx.getPayment(...(args as unknown as [string]));
      reads += 1;
      // The unlocked peek still sees the merged account.
      return reads === 1 && row !== null ? { ...row, accountId: stale } : row;
    };
    const locked: string[] = [];
    h.store.hooks.lockAccount = async (tx, ...args) => {
      const [accountId] = args as unknown as [string];
      locked.push(accountId);
      return tx.lockAccount(accountId);
    };
    await h.svc.applySettlement(payment.id, true, clock);
    expect(locked).toEqual([stale, ACCOUNT_ID]);
    expect((await readPayment(h, payment.id)).status).toBe('paid');
  });

  it('a payment that keeps moving after two account locks is left for the next tick', async () => {
    const { h, payment } = await withPayment({}, chargeRow());
    h.store.hooks.getPayment = async (tx, ...args) => {
      const row = await tx.getPayment(...(args as unknown as [string]));
      return row === null ? null : { ...row, accountId: crypto.randomUUID() };
    };
    const locked: string[] = [];
    h.store.hooks.lockAccount = async (tx, ...args) => {
      const [accountId] = args as unknown as [string];
      locked.push(accountId);
      return tx.lockAccount(accountId);
    };
    let rowLocks = 0;
    h.store.hooks.lockPayment = async (tx, ...args) => {
      rowLocks += 1;
      return tx.lockPayment(...(args as unknown as [string]));
    };
    await h.svc.applySettlement(payment.id, true, clock);
    expect(locked).toHaveLength(2);
    expect(rowLocks).toBe(0);
    delete h.store.hooks.getPayment;
    expect(await readPayment(h, payment.id)).toEqual(payment);
  });

  it('a payment gone after the peek is left alone', async () => {
    const { h, payment } = await withPayment({}, chargeRow());
    let reads = 0;
    h.store.hooks.getPayment = async (tx, ...args) => {
      reads += 1;
      return reads === 1 ? tx.getPayment(...(args as unknown as [string])) : null;
    };
    await h.svc.applySettlement(payment.id, true, clock);
    expect(reads).toBe(2);
    delete h.store.hooks.getPayment;
    expect(await readPayment(h, payment.id)).toEqual(payment);
  });

  it('a payment already paid is left unchanged', async () => {
    const { h, payment } = await withPayment({
      status: 'paid',
      paidAt: new Date(T0),
      nextSettleAt: null,
    });
    await h.svc.applySettlement(payment.id, false, T0 + 10_000_000);
    expect(await readPayment(h, payment.id)).toEqual(payment);
    expect(eventsNamed('shop.payment.closed')).toHaveLength(0);
  });

  it.each(['open', 'accepted', 'ended'] as const)(
    'a settled read moves %s to paid and runs markPaid for the charge',
    async (status) => {
      const charge = chargeRow();
      const { h, payment } = await withPayment(
        {
          status,
          acceptedAt: status === 'accepted' ? new Date(T0) : null,
          endedAt: status === 'ended' ? new Date(T0) : null,
          endReason: status === 'ended' ? 'window' : null,
        },
        charge,
      );
      clock = T0 + 1_000_000;
      await h.svc.applySettlement(payment.id, true, clock);
      expect(await readPayment(h, payment.id)).toMatchObject({
        status: 'paid',
        paidAt: new Date(clock),
        endedAt: null,
        endReason: null,
        nextSettleAt: null,
      });
      expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('paid');
    },
  );

  it('a settled payer payment has no charge to mark', async () => {
    const { h, payment } = await withPayment();
    await h.svc.applySettlement(payment.id, true, clock);
    expect((await readPayment(h, payment.id)).status).toBe('paid');
    expect(eventsNamed('shop.payment.paid')).toHaveLength(1);
  });

  /** Record the lock calls of every transaction from now on. */
  function recordLocks(h: Harness): string[] {
    const calls: string[] = [];
    for (const name of [
      'lockAccount',
      'lockCharge',
      'lockPayment',
      'lockProofs',
      'markChargePaid',
    ] as const) {
      h.store.hooks[name] = async (tx, ...args) => {
        calls.push(name);
        return (tx[name] as (...a: never[]) => Promise<unknown>).apply(tx, args);
      };
    }
    return calls;
  }

  it('settlement of a charge-backed payment locks the account, then the charge, then the payment, and no proof row', async () => {
    const charge = chargeRow();
    const { h, payment } = await withPayment({}, charge);
    const calls = recordLocks(h);
    await h.svc.applySettlement(payment.id, true, clock);
    expect(calls).toEqual(['lockAccount', 'lockCharge', 'lockPayment', 'markChargePaid']);
    expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('paid');
  });

  it('settlement of a payer payment locks only its shop_payment row', async () => {
    const { h, payment } = await withPayment();
    const calls = recordLocks(h);
    await h.svc.applySettlement(payment.id, false, clock);
    expect(calls).toEqual(['lockPayment']);
    await h.svc.applySettlement(payment.id, true, clock);
    expect(calls).toEqual(['lockPayment', 'lockPayment']);
    expect((await readPayment(h, payment.id)).status).toBe('paid');
  });

  it('logs shop.alert.double_settled when the charge was already paid by another invoice', async () => {
    const charge = chargeRow();
    const { h, payment } = await withPayment(
      { status: 'ended', endReason: 'charge_paid', endedAt: new Date(T0) },
      charge,
    );
    await h.pos.markPaid(charge.id, T0);
    await h.svc.applySettlement(payment.id, true, clock);
    expect(eventsNamed('shop.alert.double_settled').map((entry) => entry.fields)).toEqual([
      { paymentId: payment.id, chargeId: charge.id },
    ]);
    expect((await readPayment(h, payment.id)).status).toBe('paid');
  });

  it('logs shop.alert.cancelled_settled and keeps the charge cancelled', async () => {
    const charge = chargeRow();
    const { h, payment } = await withPayment(
      { status: 'ended', endReason: 'cancelled', endedAt: new Date(T0) },
      charge,
    );
    await h.pos.cancelPending(ACCOUNT_ID, clock);
    clock = T0 + 30_000;
    await h.svc.applySettlement(payment.id, true, clock);
    expect(eventsNamed('shop.alert.cancelled_settled').map((entry) => entry.fields)).toEqual([
      { paymentId: payment.id, chargeId: charge.id },
    ]);
    expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('cancelled');
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'paid',
      paidAt: new Date(T0 + 30_000),
      endedAt: null,
      endReason: null,
      nextSettleAt: null,
    });
  });

  it('markPaymentPaid returns the paid row and leaves a charge the caller already marked', async () => {
    const charge = chargeRow();
    const { h, payment } = await withPayment({}, charge);
    const before = await h.pos.findChargeForPayment({ chargeId: charge.id });
    const paid = await h.store.transaction((tx) =>
      markPaymentPaid(tx, payment, clock, { before: before ?? null, marked: true }),
    );
    expect(paid).toMatchObject({ id: payment.id, status: 'paid', paidAt: new Date(clock) });
    // marked: the caller already ran markPaid, so the charge is not touched here.
    expect((await h.pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('pending');
    expect(eventsNamed('shop.alert.double_settled')).toHaveLength(0);
  });

  it('settles a payment whose charge row is gone', async () => {
    const { h, payment } = await withPayment({ posChargeId: crypto.randomUUID() });
    await h.svc.applySettlement(payment.id, true, clock);
    expect((await readPayment(h, payment.id)).status).toBe('paid');
  });

  it('reads every 5 s for 15 min after creation, then every 30 s, and the final read 10 min after the BOLT11 expiry', async () => {
    const { h, payment } = await withPayment({ bolt11ExpiresAt: new Date(T0 + 1_020_000) });
    await h.svc.applySettlement(payment.id, false, T0 + 10_000);
    expect((await readPayment(h, payment.id)).nextSettleAt?.getTime()).toBe(T0 + 15_000);
    await h.svc.applySettlement(payment.id, false, T0 + 900_000);
    expect((await readPayment(h, payment.id)).nextSettleAt?.getTime()).toBe(T0 + 930_000);
    // Capped at the final read: T0 + 1020 s + 600 s.
    await h.svc.applySettlement(payment.id, false, T0 + 1_610_000);
    expect((await readPayment(h, payment.id)).nextSettleAt?.getTime()).toBe(T0 + 1_620_000);
    await h.svc.applySettlement(payment.id, null, T0 + 1_000);
    expect((await readPayment(h, payment.id)).nextSettleAt?.getTime()).toBe(T0 + 6_000);
    expect(SHOP_SETTLE_FAST_INTERVAL_MS).toBe(5_000);
    expect(SHOP_SETTLE_SLOW_INTERVAL_MS).toBe(30_000);
  });

  it('a failed final read is retried at the same cadence and does not close', async () => {
    const { h, payment } = await withPayment();
    const finalAt = T0 + 3_600_000 + 600_000;
    await h.svc.applySettlement(payment.id, null, finalAt + 1);
    expect(await readPayment(h, payment.id)).toMatchObject({
      closedAt: null,
      nextSettleAt: new Date(finalAt + 1 + 30_000),
    });
  });

  it('the final unpaid read closes: open ends with window, ended keeps its reason', async () => {
    const finalAt = T0 + 3_600_000 + 600_000;
    const { h, payment } = await withPayment();
    await h.svc.applySettlement(payment.id, false, finalAt);
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'window',
      closedAt: new Date(finalAt),
      nextSettleAt: null,
    });
    const ended = await withPayment({
      status: 'ended',
      endReason: 'replaced',
      endedAt: new Date(T0),
    });
    await ended.h.svc.applySettlement(ended.payment.id, false, finalAt);
    expect(await readPayment(ended.h, ended.payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'replaced',
      endedAt: new Date(T0),
      closedAt: new Date(finalAt),
    });
    expect(eventsNamed('shop.payment.closed')).toHaveLength(2);
    // Closed is final.
    await ended.h.svc.applySettlement(ended.payment.id, true, finalAt + 1);
    expect((await readPayment(ended.h, ended.payment.id)).status).toBe('ended');
  });

  it('closing an accepted payment ends it with expired_unpaid and logs shop.alert.accepted_unpaid', async () => {
    const { h, payment } = await withPayment({ status: 'accepted', acceptedAt: new Date(T0) });
    await h.svc.applySettlement(payment.id, false, T0 + 4_200_000);
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'expired_unpaid',
      endedAt: new Date(T0 + 4_200_000),
      closedAt: new Date(T0 + 4_200_000),
      nextSettleAt: null,
    });
    expect(eventsNamed('shop.alert.accepted_unpaid')).toHaveLength(1);
    // Closed is final: a later settled read changes nothing.
    await h.svc.applySettlement(payment.id, true, T0 + 4_300_000);
    expect(await readPayment(h, payment.id)).toMatchObject({
      status: 'ended',
      endReason: 'expired_unpaid',
      paidAt: null,
    });
  });

  it('markPaymentPaid and endPayment change nothing on a closed or non-open payment', async () => {
    const { h, payment } = await withPayment({
      status: 'ended',
      endReason: 'window',
      endedAt: new Date(T0),
      closedAt: new Date(T0),
    });
    expect(
      await h.store.transaction((tx) =>
        markPaymentPaid(tx, payment, clock, { before: null, marked: false }),
      ),
    ).toBeNull();
    expect((await readPayment(h, payment.id)).status).toBe('ended');
    expect(await h.store.transaction((tx) => endPayment(tx, payment, 'window', clock))).toBeNull();
    expect(eventsNamed('shop.payment.paid')).toHaveLength(0);
  });
});

// ─── Service plumbing ──────────────────────────────────────────────────────

describe('service plumbing', () => {
  it('exposes the store, the deps, and fresh UUIDs', async () => {
    const h = await setup();
    expect(h.svc.store).toBe(h.store);
    expect(h.svc.deps.config).toBe(h.config);
    expect(h.svc.newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(h.svc.newId()).not.toBe(h.svc.newId());
  });

  it('shopPaymentOfCharge answers { id, status } or null', async () => {
    const h = await setup();
    expect(await h.svc.shopPaymentOfCharge(crypto.randomUUID())).toBeNull();
    const payment = paymentRow({ posChargeId: crypto.randomUUID() });
    await h.store.transaction((tx) => tx.insertPayment(payment));
    expect(await h.svc.shopPaymentOfCharge(payment.posChargeId!)).toEqual({
      id: payment.id,
      status: 'open',
    });
  });
});
