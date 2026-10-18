/**
 * Stand-ins of the `shop-payment` Playwright project, in one Bun process so
 * that they share state (`docs/shop-stablecoin-payment.md`, Implementation ›
 * Tests):
 *
 * - a TLS front on {@link FRONT_PORT} that forwards every request to the
 *   api, so that `PUBLIC_BASE_URL` (and with it every callback, hint, and
 *   pay-request URL) is `https`;
 * - Orchestra on {@link ORCHESTRA_PORT}: `/v2/orchestration/routes`,
 *   `/v1/orchestration/quote`, `/submit`, `/history`, `/status`;
 * - one EVM JSON-RPC endpoint per Tether 1.11.0 rail ({@link RPC_PORTS}):
 *   `eth_gasPrice`, `eth_getTransactionReceipt`,
 *   `eth_getUserOperationReceipt`, `eth_getTransactionByHash`,
 *   `eth_sendRawTransaction`;
 * - the LNURL server on {@link LNURL_PORT}: `/.well-known/lnurlp/<name>`,
 *   `/lnurlp/<name>/invoice`, `/verify/<hash>`, `/lnurlpay/<pubkey>`;
 * - the control endpoint on {@link CONTROL_PORT}.
 *
 * Every request the api makes is checked against the contract; a deviation
 * is recorded and served at `GET /__control/violations`.
 *
 * Run: `bun e2e/shop-payment/stand-ins/server.ts`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from 'viem';
import { mintBolt11 } from './bolt11';
import type {
  Broadcast,
  ControlOrder,
  ControlQuote,
  DetectMode,
  ShopBehaviour,
  ShopState,
  TransferRequest,
  TransferResult,
} from './control-types';
import {
  API_PORT,
  CONTROL_PORT,
  FRONT_PORT,
  HOST,
  LNURL_PORT,
  ORCHESTRA_API_KEY,
  ORCHESTRA_PORT,
  PUBLIC_BASE_URL,
  REFUND_ADDRESS,
  RPC_PORTS,
} from './ports';
import { selfSignedPair } from './tls';

// ---------------------------------------------------------------------------
// Constants of the method table (docs/shop-stablecoin-payment.md, Methods).

interface ChainRow {
  chain: string;
  chainId: number;
  usdt: string;
  usdc: string;
  decimals: number;
}

const TABLE: readonly ChainRow[] = [
  {
    chain: 'ethereum',
    chainId: 1,
    usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  {
    chain: 'arbitrum',
    chainId: 42161,
    usdt: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    decimals: 6,
  },
  {
    chain: 'optimism',
    chainId: 10,
    usdt: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
    usdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    decimals: 6,
  },
  {
    chain: 'polygon',
    chainId: 137,
    usdt: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    decimals: 6,
  },
  {
    chain: 'base',
    chainId: 8453,
    usdt: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
  },
  {
    chain: 'bsc',
    chainId: 56,
    usdt: '0x55d398326f99059ff775485246999027b3197955',
    usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    decimals: 18,
  },
];

const RPC_CHAIN_IDS = new Set(Object.keys(RPC_PORTS).map(Number));
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** ERC-4337 EntryPoint v0.7 and its `UserOperationEvent` topic. */
const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const USER_OPERATION_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const GAS_PRICE = '0x3b9aca00';
/** USD per BTC of the stand-in's price: 1 sat is 0.001 USD, i.e. 1000 units of a 6-decimals coin. */
const UNITS_PER_SAT_6 = 1000n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINAL = new Set(['completed', 'refunded', 'failed', 'fallback_delivered', 'expired']);

const DEFAULT_BEHAVIOUR: ShopBehaviour = {
  submit: 'accept',
  completeAfterMs: 500,
  quoteTtlMs: 120_000,
  refusePairs: [],
};

// ---------------------------------------------------------------------------
// State.

interface Invoice {
  pr: string;
  paymentHash: string;
  preimage: string;
  amountMsat: number;
  username: string;
  settled: boolean;
}

interface Quote extends ControlQuote {
  bolt11: string;
  username: string;
  submitCount: number;
}

interface Order extends ControlOrder {
  bolt11: string;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

interface ChainTx {
  hash: string;
  from: string;
  to: string;
  status: '0x1' | '0x0';
  logs: Log[];
  blockNumber: number;
  /** Raw transactions sent through `eth_sendRawTransaction` have no receipt until mined. */
  mined: boolean;
}

interface UserOp {
  userOpHash: string;
  bundleHash: string;
  success: boolean;
  logs: Log[];
}

const violations: string[] = [];
const behaviours = new Map<string, ShopBehaviour>();
const registrations = new Map<string, string>();
const invoicesByHash = new Map<string, Invoice>();
const invoicesByPr = new Map<string, Invoice>();
const quotes = new Map<string, Quote>();
const quotesByDeposit = new Map<string, Quote>();
const orders = new Map<string, Order>();
const submits: Array<{ username: string; quoteId: string; txHash: string; status: number }> = [];
const statusReads = new Map<string, number>();
const historyReads = new Map<string, number>();
const receiptReads = new Map<string, number>();
/**
 * Orchestra's idempotency store per `<endpoint>:<key>`: the body the key was
 * first used with, and its stored answer, or `null` while that first request
 * still runs.
 */
const idempotency = new Map<
  string,
  { body: string; stored: { status: number; answer: unknown } | null }
>();
/** Every `eth_sendRawTransaction` the api sent, in order, with the hash of its raw transaction. */
const broadcasts: Broadcast[] = [];
const chains = new Map<number, { txs: Map<string, ChainTx>; userOps: Map<string, UserOp> }>();
for (const chainId of RPC_CHAIN_IDS) {
  chains.set(chainId, { txs: new Map(), userOps: new Map() });
}
let blockNumber = 1000;

function violation(text: string): void {
  violations.push(`${new Date().toISOString()} ${text}`);
  console.error(`[stand-in violation] ${text}`);
}

function behaviourOf(username: string): ShopBehaviour {
  return behaviours.get(username) ?? DEFAULT_BEHAVIOUR;
}

function hex32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function address(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function orchestraError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(req: Request): Promise<{ text: string; value: unknown }> {
  const text = await req.text();
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return { text, value: undefined };
  }
}

// ---------------------------------------------------------------------------
// Orders and settlement.

function orderJson(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    type: 'order',
    status: order.status,
    quoteId: order.quoteId,
    sourceTxHash: order.sourceTxHash,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    amountOut: order.status === 'completed' ? 'paid' : null,
    errorCode: order.errorCode,
    supersededByOperationId: null,
    recoveredFromOperationId: null,
  };
}

function setStatus(order: Order, status: string, errorCode: string | null = null): void {
  order.status = status;
  order.errorCode = errorCode;
  order.updatedAt = new Date().toISOString();
}

/** An order completes: it pays the BOLT11, or fails with `duplicate_lightning_invoice`. */
function completeOrder(order: Order): void {
  if (FINAL.has(order.status)) {
    return;
  }
  const invoice = invoicesByPr.get(order.bolt11);
  if (invoice === undefined) {
    setStatus(order, 'failed', 'invoice_unknown');
    return;
  }
  if (invoice.settled) {
    setStatus(order, 'failed', 'duplicate_lightning_invoice');
    return;
  }
  invoice.settled = true;
  setStatus(order, 'completed');
}

/**
 * After the api has read a completed order, every other order on the same
 * BOLT11 that is still in flight fails with `duplicate_lightning_invoice`,
 * as Orchestra's would when it tries to pay a paid invoice.
 */
function failDuplicatesAfterRead(seen: readonly Order[]): void {
  for (const order of seen) {
    if (order.status !== 'completed') {
      continue;
    }
    for (const other of orders.values()) {
      if (other.id !== order.id && other.bolt11 === order.bolt11 && !FINAL.has(other.status)) {
        setStatus(other, 'failed', 'duplicate_lightning_invoice');
      }
    }
  }
}

function createOrder(quote: Quote, txHash: string, viaSubmit: boolean): Order {
  const now = new Date().toISOString();
  const order: Order = {
    id: `ord_${randomUUID()}`,
    quoteId: quote.quoteId,
    status: 'processing',
    sourceTxHash: txHash,
    viaSubmit,
    bolt11: quote.bolt11,
    createdAt: now,
    updatedAt: now,
    errorCode: null,
  };
  orders.set(order.id, order);
  return order;
}

function orderFor(quoteId: string, txHash: string): Order | undefined {
  for (const order of orders.values()) {
    if (order.quoteId === quoteId && order.sourceTxHash === txHash) {
      return order;
    }
  }
  return undefined;
}

/** The deposit of `txHash` to `quote` on its chain, from the chain stand-in. */
function depositOf(quote: Quote, txHash: string): { found: boolean; matches: boolean } {
  const tx = chains.get(quote.chainId)?.txs.get(txHash);
  if (tx === undefined || !tx.mined) {
    return { found: false, matches: false };
  }
  const matches =
    tx.status === '0x1' &&
    tx.logs.some(
      (log) =>
        log.address === quote.token &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[2] === `0x${pad32(quote.depositAddress.slice(2))}` &&
        BigInt(log.data) > 0n,
    );
  return { found: true, matches };
}

// ---------------------------------------------------------------------------
// Orchestra.

function checkAuth(req: Request, endpoint: string): boolean {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${ORCHESTRA_API_KEY}`) {
    violation(`orchestra ${endpoint}: Authorization is not the server key`);
    return false;
  }
  return true;
}

function routesResponse(): Response {
  const assets: Array<Record<string, unknown>> = [];
  for (const row of TABLE) {
    for (const [asset, contract] of [
      ['USDT', row.usdt],
      ['USDC', row.usdc],
    ] as const) {
      assets.push({
        chain: row.chain,
        asset,
        // Orchestra answers checksummed contracts; the api compares in lowercase.
        contractAddress: getAddress(contract),
        decimals: row.decimals,
        chainId: String(row.chainId),
        route: { to: 'all', exactOutTo: ['lightning:BTC'] },
      });
    }
  }
  assets.push({
    chain: 'tron',
    asset: 'USDT',
    contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    chainId: null,
    route: { to: 'all', exactOutTo: ['lightning:BTC'] },
  });
  assets.push({
    chain: 'lightning',
    asset: 'BTC',
    contractAddress: null,
    decimals: 8,
    chainId: null,
    route: { to: 'all' },
  });
  return json({ assets, validForMs: 60_000 });
}

async function idempotent(
  req: Request,
  endpoint: string,
  text: string,
  run: () => Promise<{ status: number; answer: unknown }>,
): Promise<Response> {
  const key = req.headers.get('x-idempotency-key');
  if (key === null || !/^[\x20-\x7e]{1,255}$/.test(key)) {
    violation(`orchestra ${endpoint}: X-Idempotency-Key missing or not 1-255 printable ASCII`);
    return orchestraError(400, 'missing_idempotency_key', 'X-Idempotency-Key is required');
  }
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) {
    violation(`orchestra ${endpoint}: Content-Type is not application/json`);
  }
  const scoped = `${endpoint}:${key}`;
  const entry = idempotency.get(scoped);
  if (entry !== undefined) {
    if (entry.body !== text) {
      violation(`orchestra ${endpoint}: body changed under one idempotency key`);
      return orchestraError(409, 'idempotency_conflict', 'Body differs for this key');
    }
    if (entry.stored === null) {
      return orchestraError(409, 'idempotency_in_progress', 'A request with this key is running');
    }
    return json(entry.stored.answer, entry.stored.status, { 'x-idempotency-replayed': 'true' });
  }
  // The key is claimed before the request runs, so a second request with it
  // meanwhile gets 409 idempotency_in_progress.
  idempotency.set(scoped, { body: text, stored: null });
  let result: { status: number; answer: unknown };
  try {
    result = await run();
  } catch (error) {
    idempotency.delete(scoped);
    throw error;
  }
  // A 5xx and a 429 are retried with the same key and are not stored.
  if (result.status >= 500 || result.status === 429) {
    idempotency.delete(scoped);
  } else {
    idempotency.set(scoped, { body: text, stored: result });
  }
  return json(result.answer, result.status);
}

async function quoteRoute(req: Request): Promise<Response> {
  checkAuth(req, 'quote');
  const { text, value } = await readJson(req);
  return idempotent(req, 'quote', text, async () => {
    if (!isRecord(value)) {
      violation('orchestra quote: body is not a JSON object');
      return { status: 400, answer: { error: { code: 'invalid_request', message: 'body' } } };
    }
    const b = value;
    const row = TABLE.find((candidate) => candidate.chain === b['sourceChain']);
    const asset = b['sourceAsset'];
    const expect: Array<[boolean, string]> = [
      [row !== undefined, `sourceChain ${String(b['sourceChain'])} is not in the table`],
      [asset === 'USDT' || asset === 'USDC', 'sourceAsset is not USDT or USDC'],
      [b['destinationChain'] === 'lightning', 'destinationChain is not lightning'],
      [b['destinationAsset'] === 'BTC', 'destinationAsset is not BTC'],
      [b['amountMode'] === 'exact_out', 'amountMode is not exact_out'],
      [b['includeCalldata'] === true, 'includeCalldata is not true'],
      [!('slippageBps' in b), 'slippageBps is sent'],
      [b['refundAddress'] === REFUND_ADDRESS, 'refundAddress is not SHOP_REFUND_ADDRESS'],
      [typeof b['tag'] === 'string' && UUID_RE.test(b['tag']), 'tag is not a shop payment id'],
      [typeof b['amount'] === 'string' && /^[0-9]+$/.test(b['amount']), 'amount is not digits'],
      [row === undefined || RPC_CHAIN_IDS.has(row.chainId), 'quote for a chain without RPC'],
    ];
    for (const [ok, message] of expect) {
      if (!ok) {
        violation(`orchestra quote: ${message}`);
      }
    }
    const invoice =
      typeof b['recipientAddress'] === 'string'
        ? invoicesByPr.get(b['recipientAddress'])
        : undefined;
    if (invoice === undefined) {
      violation('orchestra quote: recipientAddress is not a BOLT11 the LNURL server minted');
      return { status: 400, answer: { error: { code: 'invalid_address', message: 'unknown' } } };
    }
    if (String(invoice.amountMsat / 1000) !== b['amount']) {
      violation('orchestra quote: amount is not the BOLT11 amount in sats');
    }
    if (row === undefined || (asset !== 'USDT' && asset !== 'USDC')) {
      return { status: 400, answer: { error: { code: 'unsupported_route', message: 'route' } } };
    }
    const behaviour = behaviourOf(invoice.username);
    if (behaviour.refusePairs.includes(`${row.chain}:${asset}`)) {
      return { status: 400, answer: { error: { code: 'unsupported_route', message: 'off' } } };
    }
    const sats = BigInt(invoice.amountMsat / 1000);
    const base = sats * UNITS_PER_SAT_6 * 10n ** BigInt(row.decimals - 6);
    const amountIn = (base * 1005n) / 1000n + 1n;
    const deposit = address();
    const token = asset === 'USDT' ? row.usdt : row.usdc;
    const expiresAt = new Date(Date.now() + behaviour.quoteTtlMs).toISOString();
    const quote: Quote = {
      quoteId: `q_${randomUUID()}`,
      sourceChain: row.chain,
      chainId: row.chainId,
      asset,
      token,
      depositAddress: deposit,
      amountIn: amountIn.toString(),
      tag: String(b['tag']),
      expiresAt,
      bolt11: invoice.pr,
      username: invoice.username,
      submitCount: 0,
    };
    quotes.set(quote.quoteId, quote);
    quotesByDeposit.set(deposit, quote);
    const data = `0xa9059cbb${pad32(deposit.slice(2))}${pad32(amountIn.toString(16))}`;
    return {
      status: 200,
      answer: {
        quoteId: quote.quoteId,
        depositAddress: getAddress(deposit),
        amountIn: quote.amountIn,
        estimatedOut: sats.toString(),
        feeAmount: (amountIn - base).toString(),
        totalFeeAmount: (amountIn - base).toString(),
        feeAsset: asset,
        feeBps: 50,
        route: [`${row.chain}:${asset}`, 'lightning:BTC'],
        expiresAt,
        amountMode: 'exact_out',
        targetAmountOut: sats.toString(),
        requiredAmountIn: quote.amountIn,
        maxAcceptedAmountIn: ((amountIn * 102n) / 100n).toString(),
        inputBufferBps: 200,
        tag: quote.tag,
        transaction: { chainId: row.chainId, to: getAddress(token), data, value: '0' },
      },
    };
  });
}

async function submitRoute(req: Request): Promise<Response> {
  checkAuth(req, 'submit');
  const { text, value } = await readJson(req);
  return idempotent(req, 'submit', text, async () => {
    if (!isRecord(value)) {
      violation('orchestra submit: body is not a JSON object');
      return { status: 400, answer: { error: { code: 'invalid_request', message: 'body' } } };
    }
    if ('sourceAddress' in value) {
      violation('orchestra submit: sourceAddress is sent');
    }
    const quoteId = value['quoteId'];
    const txHash = value['txHash'];
    const quote = typeof quoteId === 'string' ? quotes.get(quoteId) : undefined;
    if (quote === undefined || typeof txHash !== 'string') {
      violation('orchestra submit: unknown quoteId or missing txHash');
      return { status: 404, answer: { error: { code: 'not_found', message: 'quote' } } };
    }
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      violation('orchestra submit: txHash is not 0x + 64 lowercase hex');
    }
    quote.submitCount += 1;
    const record = (status: number) => {
      submits.push({ username: quote.username, quoteId: quote.quoteId, txHash, status });
    };
    const existing = orderFor(quote.quoteId, txHash);
    if (existing !== undefined) {
      record(200);
      return { status: 200, answer: { orderId: existing.id, status: existing.status } };
    }
    const deposit = depositOf(quote, txHash);
    if (!deposit.found) {
      record(503);
      return {
        status: 503,
        answer: { error: { code: 'xchain_deposit_pending', message: 'not seen yet' } },
      };
    }
    if (!deposit.matches) {
      record(400);
      return {
        status: 400,
        answer: { error: { code: 'xchain_deposit_mismatch', message: 'no matching deposit' } },
      };
    }
    const behaviour = behaviourOf(quote.username);
    if (behaviour.submit === 'fail-first' && quote.submitCount === 1) {
      record(503);
      return {
        status: 503,
        answer: { error: { code: 'xchain_deposit_pending', message: 'confirming' } },
      };
    }
    const order = createOrder(quote, txHash, true);
    if (behaviour.completeAfterMs !== null) {
      setTimeout(() => completeOrder(order), behaviour.completeAfterMs);
    }
    record(200);
    return { status: 200, answer: { orderId: order.id, status: order.status } };
  });
}

function historyRoute(req: Request, url: URL): Response {
  checkAuth(req, 'history');
  const bolt11 = url.searchParams.get('address') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  if (limit !== 200) {
    violation(`orchestra history: limit is ${limit}, not 200`);
  }
  const invoice = invoicesByPr.get(bolt11);
  if (invoice === undefined) {
    violation('orchestra history: address is not a minted BOLT11');
    return json({ orders: [], total: 0 });
  }
  historyReads.set(invoice.username, (historyReads.get(invoice.username) ?? 0) + 1);
  const all = [...orders.values()].filter((order) => order.bolt11 === bolt11);
  const page = all.slice(offset, offset + limit);
  const body = { orders: page.map(orderJson), total: all.length };
  failDuplicatesAfterRead(page);
  return json(body);
}

function statusRoute(req: Request, url: URL): Response {
  checkAuth(req, 'status');
  const id = url.searchParams.get('id') ?? '';
  const order = orders.get(id);
  if (order === undefined) {
    return orchestraError(404, 'not_found', 'No order');
  }
  statusReads.set(id, (statusReads.get(id) ?? 0) + 1);
  const body = { order: orderJson(order), stages: [] };
  failDuplicatesAfterRead([order]);
  return json(body);
}

async function orchestra(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/v2/orchestration/routes') {
    checkAuth(req, 'routes');
    return routesResponse();
  }
  if (req.method === 'POST' && url.pathname === '/v1/orchestration/quote') {
    return quoteRoute(req);
  }
  if (req.method === 'POST' && url.pathname === '/v1/orchestration/submit') {
    return submitRoute(req);
  }
  if (req.method === 'GET' && url.pathname === '/v1/orchestration/history') {
    return historyRoute(req, url);
  }
  if (req.method === 'GET' && url.pathname === '/v1/orchestration/status') {
    return statusRoute(req, url);
  }
  violation(`orchestra: unexpected ${req.method} ${url.pathname}`);
  return orchestraError(404, 'not_found', 'No such endpoint');
}

// ---------------------------------------------------------------------------
// EVM JSON-RPC.

function logJson(log: Log, tx: ChainTx): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    logIndex: `0x${log.logIndex.toString(16)}`,
    transactionHash: tx.hash,
    blockNumber: `0x${tx.blockNumber.toString(16)}`,
    blockHash: `0x${pad32(tx.blockNumber.toString(16))}`,
    transactionIndex: '0x0',
    removed: false,
  };
}

function receiptJson(tx: ChainTx): Record<string, unknown> {
  return {
    transactionHash: tx.hash,
    transactionIndex: '0x0',
    blockHash: `0x${pad32(tx.blockNumber.toString(16))}`,
    blockNumber: `0x${tx.blockNumber.toString(16)}`,
    from: tx.from,
    to: tx.to,
    cumulativeGasUsed: '0x1d4c0',
    gasUsed: '0x1d4c0',
    effectiveGasPrice: GAS_PRICE,
    contractAddress: null,
    logs: tx.logs.map((log) => logJson(log, tx)),
    logsBloom: `0x${'0'.repeat(512)}`,
    status: tx.status,
    type: '0x2',
  };
}

function rpc(chainId: number) {
  return async (req: Request): Promise<Response> => {
    const chain = chains.get(chainId);
    const { value } = await readJson(req);
    if (req.method !== 'POST' || !isRecord(value) || chain === undefined) {
      violation(`rpc ${chainId}: not a JSON-RPC POST`);
      return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid' } });
    }
    const id = value['id'] ?? null;
    const method = value['method'];
    const params = Array.isArray(value['params']) ? (value['params'] as unknown[]) : [];
    const result = (r: unknown) => json({ jsonrpc: '2.0', id, result: r });
    const first = typeof params[0] === 'string' ? params[0].toLowerCase() : '';
    switch (method) {
      case 'eth_gasPrice':
        return result(GAS_PRICE);
      case 'eth_getTransactionReceipt': {
        receiptReads.set(first, (receiptReads.get(first) ?? 0) + 1);
        const tx = chain.txs.get(first);
        return result(tx === undefined || !tx.mined ? null : receiptJson(tx));
      }
      case 'eth_getUserOperationReceipt': {
        receiptReads.set(first, (receiptReads.get(first) ?? 0) + 1);
        const op = chain.userOps.get(first);
        const bundle = op === undefined ? undefined : chain.txs.get(op.bundleHash);
        if (op === undefined || bundle === undefined) {
          return result(null);
        }
        return result({
          userOpHash: op.userOpHash,
          entryPoint: ENTRY_POINT,
          sender: bundle.from,
          nonce: '0x1',
          paymaster: '0x0000000000000000000000000000000000000000',
          actualGasCost: '0x1',
          actualGasUsed: '0x1',
          success: op.success,
          logs: op.logs.map((log) => logJson(log, bundle)),
          receipt: receiptJson(bundle),
        });
      }
      case 'eth_getTransactionByHash': {
        const tx = chain.txs.get(first);
        if (tx === undefined) {
          return result(null);
        }
        return result({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          blockNumber: tx.mined ? `0x${tx.blockNumber.toString(16)}` : null,
          value: '0x0',
          input: '0x',
          nonce: '0x0',
        });
      }
      case 'eth_sendRawTransaction': {
        if (!/^0x([0-9a-f]{2})+$/i.test(first)) {
          return json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid raw' } });
        }
        const raw = first as `0x${string}`;
        const hash = keccak256(raw);
        broadcasts.push({ chainId, hash });
        const known = chain.txs.get(hash);
        if (known !== undefined) {
          return json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'already known' } });
        }
        // Mined at once: a token transfer gets its Transfer log from the signer.
        let parsed: ReturnType<typeof parseTransaction>;
        let from: string;
        try {
          parsed = parseTransaction(raw);
          from = (
            await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })
          ).toLowerCase();
        } catch {
          return json({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'invalid transaction' },
          });
        }
        if (parsed.chainId !== chainId) {
          return json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'invalid chain id' } });
        }
        const data = (parsed.data ?? '0x').toLowerCase();
        const to = (parsed.to ?? address()).toLowerCase();
        const logs: Log[] = [];
        if (data.startsWith('0xa9059cbb') && data.length === 2 + 8 + 128) {
          logs.push({
            address: to,
            topics: [TRANSFER_TOPIC, `0x${pad32(from.slice(2))}`, `0x${data.slice(10, 74)}`],
            data: `0x${data.slice(74)}`,
            logIndex: 0,
          });
        }
        chain.txs.set(hash, {
          hash,
          from,
          to,
          status: '0x1',
          logs,
          blockNumber: (blockNumber += 1),
          mined: true,
        });
        return result(hash);
      }
      default:
        violation(`rpc ${chainId}: unexpected method ${String(method)}`);
        return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }
  };
}

// ---------------------------------------------------------------------------
// The payer's bundler (control): one ERC-20 transfer as an ERC-4337 user operation.

function transfer(request: TransferRequest): TransferResult {
  const chain = chains.get(request.chainId);
  if (chain === undefined) {
    throw new Error(`no chain ${request.chainId}`);
  }
  const from = (request.from ?? address()).toLowerCase();
  const token = request.token.toLowerCase();
  const to = request.to.toLowerCase();
  const txHash = hex32();
  const userOpHash = hex32();
  blockNumber += 1;
  const transferLog: Log = {
    address: token,
    topics: [TRANSFER_TOPIC, `0x${pad32(from.slice(2))}`, `0x${pad32(to.slice(2))}`],
    data: `0x${pad32(BigInt(request.amount).toString(16))}`,
    logIndex: 1,
  };
  const userOpLog: Log = {
    address: ENTRY_POINT,
    topics: [USER_OPERATION_EVENT, userOpHash, `0x${pad32(from.slice(2))}`, `0x${'0'.repeat(64)}`],
    data: `0x${pad32('1')}${pad32('1')}${pad32('1')}${pad32('1')}`,
    logIndex: 2,
  };
  const bundler = address();
  chain.txs.set(txHash, {
    hash: txHash,
    from: bundler,
    to: ENTRY_POINT,
    status: '0x1',
    logs: [transferLog, userOpLog],
    blockNumber,
    mined: true,
  });
  chain.userOps.set(userOpHash, {
    userOpHash,
    bundleHash: txHash,
    success: true,
    logs: [transferLog],
  });
  let orderId: string | null = null;
  const detect: DetectMode = request.detect ?? 'none';
  const quote = quotesByDeposit.get(to);
  if (detect !== 'none' && quote !== undefined && quote.chainId === request.chainId) {
    const order = orderFor(quote.quoteId, txHash) ?? createOrder(quote, txHash, false);
    if (detect === 'completed') {
      completeOrder(order);
    }
    orderId = order.id;
  }
  return {
    txHash,
    userOpHash,
    receipt: request.userOpOnly === true ? {} : { transactionHash: txHash },
    orderId,
  };
}

// ---------------------------------------------------------------------------
// LNURL server (the Breez LNURL server API the api forwards to).

const PUBLIC_HOST = new URL(PUBLIC_BASE_URL).host;

function lnurlError(status: number, reason: string): Response {
  return json({ status: 'ERROR', reason }, status);
}

async function lnurl(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if ((req.headers.get('host') ?? '') !== PUBLIC_HOST) {
    violation(`lnurl: Host header is ${req.headers.get('host') ?? '(none)'}, not ${PUBLIC_HOST}`);
  }
  if (req.method === 'POST' && parts[0] === 'lnurlpay' && parts.length === 2) {
    const { value } = await readJson(req);
    const username = isRecord(value) ? value['username'] : undefined;
    if (typeof username !== 'string' || username === '') {
      return lnurlError(400, 'username required');
    }
    registrations.set(username, parts[1] ?? '');
    return json({
      lnurl: `${PUBLIC_BASE_URL}/.well-known/lnurlp/${username}`,
      lightning_address: `${username}@${PUBLIC_HOST}`,
    });
  }
  if (req.method !== 'GET') {
    return lnurlError(404, 'Not found');
  }
  if (parts[0] === '.well-known' && parts[1] === 'lnurlp' && parts.length === 3) {
    const name = parts[2] ?? '';
    if (!registrations.has(name)) {
      return lnurlError(404, 'Not found');
    }
    return json({
      tag: 'payRequest',
      callback: `${PUBLIC_BASE_URL}/lnurlp/${name}/invoice`,
      minSendable: 1000,
      maxSendable: 100_000_000_000,
      metadata: JSON.stringify([
        ['text/plain', `Pay to ${name}`],
        ['text/identifier', `${name}@${PUBLIC_HOST}`],
      ]),
      commentAllowed: 255,
    });
  }
  if (parts[0] === 'lnurlp' && parts[2] === 'invoice' && parts.length === 3) {
    const name = parts[1] ?? '';
    if (!registrations.has(name)) {
      return lnurlError(404, 'Not found');
    }
    const amount = Number(url.searchParams.get('amount'));
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount % 1000 !== 0) {
      return lnurlError(400, 'Invalid amount');
    }
    const minted = await mintBolt11(amount, `Pay to ${name}`, 1200);
    const invoice: Invoice = {
      pr: minted.pr,
      paymentHash: minted.paymentHash,
      preimage: minted.preimage,
      amountMsat: amount,
      username: name,
      settled: false,
    };
    invoicesByHash.set(invoice.paymentHash, invoice);
    invoicesByPr.set(invoice.pr, invoice);
    return json({
      pr: minted.pr,
      routes: [],
      verify: `${PUBLIC_BASE_URL}/verify/${minted.paymentHash}`,
    });
  }
  if (parts[0] === 'verify' && parts.length === 2) {
    const invoice = invoicesByHash.get(parts[1] ?? '');
    if (invoice === undefined) {
      return lnurlError(404, 'Not found');
    }
    return json({
      status: 'OK',
      settled: invoice.settled,
      preimage: invoice.settled ? invoice.preimage : null,
      pr: invoice.pr,
    });
  }
  return lnurlError(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Control.

function shopState(username: string): ShopState {
  const shopQuotes = [...quotes.values()].filter((quote) => quote.username === username);
  const quoteIds = new Set(shopQuotes.map((quote) => quote.quoteId));
  const shopOrders = [...orders.values()].filter((order) => quoteIds.has(order.quoteId));
  const deposits = new Set(shopQuotes.map((quote) => quote.depositAddress));
  const reads: Record<string, number> = {};
  for (const chain of chains.values()) {
    for (const tx of chain.txs.values()) {
      const toDeposit = tx.logs.some((log) =>
        deposits.has(`0x${(log.topics[2] ?? '').slice(-40)}`),
      );
      if (toDeposit) {
        reads[tx.hash] = receiptReads.get(tx.hash) ?? 0;
      }
    }
    for (const op of chain.userOps.values()) {
      if (reads[op.bundleHash] !== undefined) {
        reads[op.userOpHash] = receiptReads.get(op.userOpHash) ?? 0;
      }
    }
  }
  return {
    behaviour: behaviourOf(username),
    quotes: shopQuotes.map((quote) => ({
      quoteId: quote.quoteId,
      sourceChain: quote.sourceChain,
      chainId: quote.chainId,
      asset: quote.asset,
      token: quote.token,
      depositAddress: quote.depositAddress,
      amountIn: quote.amountIn,
      tag: quote.tag,
      expiresAt: quote.expiresAt,
    })),
    orders: shopOrders.map((order) => ({
      id: order.id,
      quoteId: order.quoteId,
      status: order.status,
      sourceTxHash: order.sourceTxHash,
      viaSubmit: order.viaSubmit,
    })),
    submits: submits
      .filter((entry) => entry.username === username)
      .map(({ quoteId, txHash, status }) => ({ quoteId, txHash, status })),
    statusReads: Object.fromEntries(
      shopOrders.map((order) => [order.id, statusReads.get(order.id) ?? 0]),
    ),
    historyReads: historyReads.get(username) ?? 0,
    invoices: [...invoicesByHash.values()]
      .filter((invoice) => invoice.username === username)
      .map(({ paymentHash, amountMsat, settled }) => ({ paymentHash, amountMsat, settled })),
    receiptReads: reads,
  };
}

async function control(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (url.pathname === '/__health') {
    return json({ ok: true });
  }
  if (parts[0] !== '__control') {
    return json({ error: 'Not found' }, 404);
  }
  try {
    if (parts[1] === 'violations' && req.method === 'GET') {
      return json({ violations });
    }
    if (parts[1] === 'broadcasts' && req.method === 'GET') {
      return json({ broadcasts });
    }
    if (parts[1] === 'shops' && parts.length === 3) {
      const username = parts[2] ?? '';
      if (req.method === 'POST') {
        const { value } = await readJson(req);
        behaviours.set(username, {
          ...behaviourOf(username),
          ...(isRecord(value) ? (value as Partial<ShopBehaviour>) : {}),
        });
        return json({ behaviour: behaviourOf(username) });
      }
      return json(shopState(username));
    }
    if (parts[1] === 'transfer' && req.method === 'POST') {
      const { value } = await readJson(req);
      return json(transfer(value as TransferRequest));
    }
    if (parts[1] === 'invoices' && parts[3] === 'settle' && req.method === 'POST') {
      const invoice = invoicesByHash.get(parts[2] ?? '');
      if (invoice === undefined) {
        return json({ error: 'Not found' }, 404);
      }
      invoice.settled = true;
      return json({ settled: true });
    }
    if (parts[1] === 'orders' && parts.length === 3 && req.method === 'POST') {
      const order = orders.get(parts[2] ?? '');
      const { value } = await readJson(req);
      if (order === undefined || !isRecord(value) || typeof value['status'] !== 'string') {
        return json({ error: 'Not found' }, 404);
      }
      if (value['status'] === 'completed') {
        completeOrder(order);
      } else {
        setStatus(order, value['status']);
      }
      return json(orderJson(order));
    }
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
  return json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// TLS front of the api.

async function front(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://${HOST}:${API_PORT}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete('host');
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
  try {
    const answer = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    const out = new Headers(answer.headers);
    // fetch already decoded the body.
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(await answer.arrayBuffer(), { status: answer.status, headers: out });
  } catch {
    return json({ error: 'front: api unreachable' }, 502);
  }
}

// ---------------------------------------------------------------------------
// Start.

const tls = selfSignedPair();
const servers = [
  Bun.serve({ hostname: HOST, port: FRONT_PORT, tls, fetch: front }),
  Bun.serve({ hostname: HOST, port: ORCHESTRA_PORT, tls, fetch: orchestra }),
  ...Object.entries(RPC_PORTS).map(([chainId, port]) =>
    Bun.serve({ hostname: HOST, port, tls, fetch: rpc(Number(chainId)) }),
  ),
  Bun.serve({ hostname: HOST, port: LNURL_PORT, fetch: lnurl }),
  Bun.serve({ hostname: HOST, port: CONTROL_PORT, fetch: control }),
];
console.warn(`shop-payment stand-ins listening on ${servers.map((s) => s.port).join(', ')}`);
