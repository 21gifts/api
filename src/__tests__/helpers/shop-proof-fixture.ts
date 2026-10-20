import { vi, type Mock } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Account, AuthStore } from '@/lib/auth/store';
import { ERC20_TRANSFER_TOPIC, erc20TransferData } from '@/lib/evm-transfer';
import { InMemoryFxSpotStore } from '@/lib/fx-spot-store';
import type { OrchestraClient } from '@/lib/orchestra';
import { InMemoryPosStore } from '@/lib/pos-store';
import { ShopPayments } from '@/lib/shop-payment';
import {
  InMemoryShopPaymentStore,
  type ShopOffer,
  type ShopPayment,
  type ShopProof,
  type ShopQuote,
} from '@/lib/shop-payment-store';
import { LNURL_SERVER } from './wallet-lnurl';

/** Fixed clock start. */
export const T0 = Date.parse('2026-10-14T12:00:00.000Z');

/**
 * Deterministic lowercase UUID ending in `n`.
 *
 * @param n - Suffix.
 * @returns The UUID.
 */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Id of the shop account. */
export const ACCOUNT_ID = uid(0xa1);
/** Id of another account. */
export const OTHER_ACCOUNT_ID = uid(0xa2);
/** Id of the seeded shop payment. */
export const PAYMENT_ID = uid(1);
/** Id of another shop payment. */
export const OTHER_PAYMENT_ID = uid(2);
/** Id of the seeded quote. */
export const QUOTE_ID = uid(0x101);
/** Id of another quote. */
export const OTHER_QUOTE_ID = uid(0x102);
/** Id of the Polygon USDT offer. */
export const OFFER_USDT = uid(0x201);
/** Id of the Polygon USDC offer. */
export const OFFER_USDC = uid(0x202);
/** Id of the Ethereum USDT offer. */
export const OFFER_ETH = uid(0x203);
/** Id of an offer of the other quote. */
export const OFFER_OTHER = uid(0x204);

/** Fake Polygon RPC endpoint. */
export const POLYGON_RPC = 'https://rpc.polygon.test';
/** Fake Ethereum RPC endpoint. */
export const ETH_RPC = 'https://rpc.eth.test';
/** Polygon USDT contract of the method table. */
export const POLYGON_USDT = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
/** Polygon USDC contract of the method table. */
export const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
/** Ethereum USDT contract of the method table. */
export const ETH_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
/** Deposit address of the USDT offer. */
export const DEPOSIT_USDT = `0x${'11'.repeat(20)}`;
/** Deposit address of the USDC offer. */
export const DEPOSIT_USDC = `0x${'22'.repeat(20)}`;
/** Deposit address of the Ethereum offer. */
export const DEPOSIT_ETH = `0x${'33'.repeat(20)}`;
/** Deposit address of the other quote's offer. */
export const DEPOSIT_OTHER = `0x${'44'.repeat(20)}`;
/** Address of the paying wallet. */
export const PAYER = `0x${'55'.repeat(20)}`;
/** Offer `amountIn` in base units. */
export const AMOUNT_IN = '2100000';
/** Payment hash of the seeded BOLT11. */
export const PAYMENT_HASH = 'ab'.repeat(32);

/**
 * A transaction hash `0x` + 64 hex built from one byte.
 *
 * @param byte - Two hex characters repeated 32 times.
 * @returns The hash.
 */
export function txHash(byte: string): string {
  return `0x${byte.repeat(32)}`;
}

/** The shop account handed to the route. */
export const ACCOUNT = { id: ACCOUNT_ID } as Account;

/** One fake JSON-RPC answer. */
export type RpcAnswer = { result: unknown } | { error: string } | 'transport';

/** A fake RPC handler. */
export type RpcHandler = (params: unknown[], url: string) => RpcAnswer;

/** The fakes and the service under test. */
export interface Harness {
  shop: ShopPayments;
  store: InMemoryShopPaymentStore;
  clock: { now: number };
  rpc: Record<string, RpcHandler>;
  rpcCalls: { method: string; params: unknown[] }[];
  verify: Map<string, 'settled' | 'open' | 'failed'>;
  /** LUD-21 `/verify` reads: total, and the most running at the same time. */
  verifyReads: { calls: number; running: number; maxRunning: number };
  orchestra: { submit: Mock; history: Mock; status: Mock };
}

/**
 * Build the service with an in-memory store, a fake RPC, a fake LNURL
 * `/verify`, and a fake Orchestra client.
 *
 * @param options - `config: false` turns the shop config off;
 *   `orchestra: false` leaves the Orchestra client out.
 * @returns The harness.
 */
export function harness(options: { config?: boolean; orchestra?: boolean } = {}): Harness {
  const clock = { now: T0 };
  let next = 0x1000;
  const rpcCalls: Harness['rpcCalls'] = [];
  const rpc: Record<string, RpcHandler> = {
    eth_getTransactionReceipt: () => ({ result: null }),
    eth_getUserOperationReceipt: () => ({ result: null }),
    eth_gasPrice: () => ({ result: '0x3b9aca00' }),
    eth_sendRawTransaction: () => ({ result: txHash('ee') }),
    eth_getTransactionByHash: () => ({ result: null }),
  };
  const verify = new Map<string, 'settled' | 'open' | 'failed'>();
  const verifyReads = { calls: 0, running: 0, maxRunning: 0 };
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.startsWith(`${LNURL_SERVER.baseUrl}/verify/`)) {
      verifyReads.calls += 1;
      verifyReads.running += 1;
      verifyReads.maxRunning = Math.max(verifyReads.maxRunning, verifyReads.running);
      // Let every read the duty started in parallel begin before this one ends.
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
      verifyReads.running -= 1;
      const outcome = verify.get(url.slice(`${LNURL_SERVER.baseUrl}/verify/`.length)) ?? 'open';
      return outcome === 'failed'
        ? new Response('no', { status: 500 })
        : Response.json({ settled: outcome === 'settled' });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    rpcCalls.push({ method: body.method, params: body.params });
    const handler = rpc[body.method];
    if (handler === undefined) {
      throw new TypeError('no handler');
    }
    const answer = handler(body.params, url);
    if (answer === 'transport') {
      throw new TypeError('fetch failed');
    }
    return Response.json(
      'result' in answer
        ? { jsonrpc: '2.0', id: 1, result: answer.result }
        : { jsonrpc: '2.0', id: 1, error: { code: -32000, message: answer.error } },
    );
  };
  const orchestra = {
    submit: vi.fn(async () => ({ kind: 'unresolved', retryable: true })),
    history: vi.fn(async () => ({ ok: true, orders: [], full: false })),
    status: vi.fn(async () => ({ ok: false, reason: 'error' })),
  };
  const posStore = new InMemoryPosStore();
  const store = new InMemoryShopPaymentStore(posStore);
  const shop = new ShopPayments({
    store,
    posStore,
    auth: {} as AuthStore,
    lnurlServer: LNURL_SERVER,
    config:
      options.config === false
        ? null
        : {
            orchestraBaseUrl: 'https://orchestra.test',
            orchestraApiKey: 'fn_test',
            evmRpc: new Map([
              [137, POLYGON_RPC],
              [1, ETH_RPC],
            ]),
            refundAddress: `0x${'99'.repeat(20)}`,
          },
    orchestra: options.orchestra === false ? null : (orchestra as unknown as OrchestraClient),
    fxSpot: new InMemoryFxSpotStore(),
    fetchImpl,
    now: () => clock.now,
    newId: () => uid((next += 1)),
  });
  return { shop, store, clock, rpc, rpcCalls, verify, verifyReads, orchestra };
}

/**
 * A payment row.
 *
 * @param partial - Overrides.
 * @returns The row.
 */
export function paymentRow(partial: Partial<ShopPayment> = {}): ShopPayment {
  return {
    id: PAYMENT_ID,
    accountId: ACCOUNT_ID,
    amountSats: 2100,
    posChargeId: null,
    bolt11: 'lnbc21u1test',
    paymentHash: PAYMENT_HASH,
    bolt11ExpiresAt: new Date(T0 + 3_600_000),
    status: 'open',
    endReason: null,
    windowEndsAt: new Date(T0 + 300_000),
    replacements: 0,
    nextSettleAt: null,
    nextHistoryAt: null,
    historyOffset: 0,
    successorWaitUntil: null,
    createdAt: new Date(T0),
    acceptedAt: null,
    paidAt: null,
    endedAt: null,
    closedAt: null,
    ...partial,
  };
}

/**
 * A quote row.
 *
 * @param partial - Overrides.
 * @returns The row.
 */
export function quoteRow(partial: Partial<ShopQuote> = {}): ShopQuote {
  return {
    id: QUOTE_ID,
    paymentId: PAYMENT_ID,
    expiresAt: new Date(T0 + 90_000),
    transferAmounts: [],
    createdAt: new Date(T0),
    ...partial,
  };
}

/**
 * An offer row (USDT on Polygon by default).
 *
 * @param partial - Overrides.
 * @returns The row.
 */
export function offerRow(partial: Partial<ShopOffer> = {}): ShopOffer {
  return {
    id: OFFER_USDT,
    quoteId: QUOTE_ID,
    method: 'Polygon',
    chainId: 137,
    asset: 'USDT',
    tokenAddress: POLYGON_USDT,
    depositAddress: DEPOSIT_USDT,
    amountIn: AMOUNT_IN,
    requiredAmountIn: '2000000',
    maxAcceptedAmountIn: '2200000',
    decimals: 6,
    minFee: '1200000000',
    providerRef: 'q-usdt-pol',
    idempotencyKey: uid(0x301),
    expiresAt: new Date(T0 + 120_000),
    detailIssuedAt: null,
    createdAt: new Date(T0),
    ...partial,
  };
}

/**
 * A proof row (a `tx` proof on the USDT Polygon offer by default).
 *
 * @param partial - Overrides.
 * @returns The row.
 */
export function proofRow(partial: Partial<ShopProof> = {}): ShopProof {
  return {
    id: uid(0x401),
    offerId: OFFER_USDT,
    paymentId: PAYMENT_ID,
    source: 'tx',
    chainId: 137,
    txHash: txHash('a1'),
    logIndex: 3,
    userOpHash: null,
    rawHex: null,
    transferAmount: AMOUNT_IN,
    idempotencyKey: uid(0x402),
    result: null,
    providerOrder: null,
    supersededByOrder: null,
    orderStatus: null,
    orderFoundAt: null,
    refusal: null,
    submitStopped: false,
    sentAt: null,
    lastSubmitAt: null,
    giveUpAt: new Date(T0 + 86_400_000),
    nextSubmitAt: null,
    nextReceiptAt: null,
    nextStatusAt: null,
    tries: 0,
    resolvedAt: null,
    createdAt: new Date(T0),
    ...partial,
  };
}

/**
 * Seed the shop payment with one quote and three offers (USDT and USDC on
 * Polygon, USDT on Ethereum), and another account's payment with one quote
 * and one USDT Polygon offer.
 *
 * @param h - Harness.
 * @param payment - Overrides of the shop payment.
 */
export async function seed(h: Harness, payment: Partial<ShopPayment> = {}): Promise<void> {
  await h.store.transaction(async (tx) => {
    await tx.insertPayment(paymentRow(payment));
    await tx.insertQuote(quoteRow());
    await tx.insertOffers([
      offerRow(),
      offerRow({
        id: OFFER_USDC,
        asset: 'USDC',
        tokenAddress: POLYGON_USDC,
        depositAddress: DEPOSIT_USDC,
        requiredAmountIn: null,
        maxAcceptedAmountIn: null,
        providerRef: 'q-usdc-pol',
        createdAt: new Date(T0 + 1),
      }),
      offerRow({
        id: OFFER_ETH,
        method: 'Ethereum',
        chainId: 1,
        tokenAddress: ETH_USDT,
        depositAddress: DEPOSIT_ETH,
        providerRef: 'q-usdt-eth',
        createdAt: new Date(T0 + 2),
      }),
    ]);
    await tx.insertPayment(
      paymentRow({
        id: OTHER_PAYMENT_ID,
        accountId: OTHER_ACCOUNT_ID,
        paymentHash: 'cd'.repeat(32),
        bolt11: 'lnbc21u1other',
      }),
    );
    await tx.insertQuote(quoteRow({ id: OTHER_QUOTE_ID, paymentId: OTHER_PAYMENT_ID }));
    await tx.insertOffers([
      offerRow({
        id: OFFER_OTHER,
        quoteId: OTHER_QUOTE_ID,
        depositAddress: DEPOSIT_OTHER,
        providerRef: 'q-other',
      }),
    ]);
  });
}

/**
 * Insert proof rows.
 *
 * @param h - Harness.
 * @param rows - Rows.
 * @throws Error when a row clashes with a unique index.
 */
export async function insertProofs(h: Harness, ...rows: ShopProof[]): Promise<void> {
  await h.store.transaction(async (tx) => {
    for (const row of rows) {
      if (!(await tx.insertProof(row))) {
        throw new Error(`seed proof ${row.id} clashed`);
      }
    }
  });
}

/**
 * Read one proof.
 *
 * @param h - Harness.
 * @param id - Proof id.
 * @returns The row, or `null`.
 */
export function getProof(h: Harness, id: string): Promise<ShopProof | null> {
  return h.store.transaction((tx) => tx.getProof(id));
}

/**
 * Read one payment.
 *
 * @param h - Harness.
 * @param id - Payment id.
 * @returns The row, or `null`.
 */
export function getPayment(h: Harness, id: string = PAYMENT_ID): Promise<ShopPayment | null> {
  return h.store.transaction((tx) => tx.getPayment(id));
}

/**
 * Every proof of a payment.
 *
 * @param h - Harness.
 * @param paymentId - Payment id.
 * @returns The rows, oldest first.
 */
export function proofsOf(h: Harness, paymentId: string = PAYMENT_ID): Promise<ShopProof[]> {
  return h.store.transaction((tx) => tx.proofsOf(paymentId));
}

/**
 * A 32-byte topic holding an address.
 *
 * @param address - `0x` + 40 hex.
 * @returns The topic.
 */
function addressTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

/**
 * A raw ERC-20 `Transfer` log as an RPC node returns it.
 *
 * @param token - Emitting contract.
 * @param to - Recipient.
 * @param value - Amount.
 * @param logIndex - Log index.
 * @returns The JSON log.
 */
export function transferLog(
  token: string,
  to: string,
  value: bigint,
  logIndex: number,
): Record<string, unknown> {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

/** A log that is not an ERC-20 transfer. */
export const OTHER_LOG = {
  address: POLYGON_USDT,
  topics: [`0x${'01'.repeat(32)}`],
  data: '0x',
  logIndex: '0x9',
};

/**
 * A transaction receipt as an RPC node returns it.
 *
 * @param hash - Transaction hash.
 * @param status - `0x1` or `0x0`.
 * @param logs - Logs.
 * @returns The JSON receipt.
 */
export function receiptJson(
  hash: string,
  status: string,
  logs: readonly unknown[],
): Record<string, unknown> {
  return { transactionHash: hash, status, logs };
}

/**
 * A user-operation receipt as a bundler returns it.
 *
 * @param bundleHash - Bundle transaction hash.
 * @param success - User-operation success.
 * @param logs - The user operation's logs.
 * @param bundle - The nested bundle receipt's `status` and `logs`, when the
 *   bundler sends them.
 * @returns The JSON receipt.
 */
export function userOpReceiptJson(
  bundleHash: string,
  success: boolean,
  logs: readonly unknown[],
  bundle: { status: string; logs: readonly unknown[] } | null = null,
): Record<string, unknown> {
  return { success, receipt: { transactionHash: bundleHash, ...bundle }, logs };
}

const signer = privateKeyToAccount(`0x${'42'.repeat(32)}`);

/**
 * Sign an ERC-20 transfer to an offer.
 *
 * @param options - Overrides of chain, token, recipient, amount, value, and fees.
 * @returns Signed bytes as hex without `0x`.
 */
export async function signedTransfer(
  options: {
    type?: 'legacy' | 'eip1559';
    chainId?: number;
    to?: string;
    deposit?: string;
    amount?: bigint;
    value?: bigint;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    nonce?: number;
  } = {},
): Promise<string> {
  const base = {
    chainId: options.chainId ?? 137,
    to: (options.to ?? POLYGON_USDT) as Hex,
    data: erc20TransferData(
      options.deposit ?? DEPOSIT_USDT,
      options.amount ?? BigInt(AMOUNT_IN),
    ) as Hex,
    value: options.value ?? 0n,
    gas: 100_000n,
    nonce: options.nonce ?? 0,
  };
  const signed =
    options.type === 'legacy'
      ? await signer.signTransaction({
          ...base,
          type: 'legacy',
          gasPrice: options.gasPrice ?? 2_000_000_000n,
        })
      : await signer.signTransaction({
          ...base,
          type: 'eip1559',
          maxFeePerGas: options.maxFeePerGas ?? 5_000_000_000n,
          maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? 1_000_000_000n,
        });
  return signed.slice(2);
}

/**
 * Collect the event names that `logEvent` printed through `console.warn`.
 *
 * @param warn - The `console.warn` spy.
 * @returns The spy's calls as `{ event, ...fields }`.
 */
export function loggedEvents(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}
