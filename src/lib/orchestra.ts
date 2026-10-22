import { IP_RATE_WINDOW_MS } from '@/lib/ip-rate-limit';
import { logEvent, type LogFields } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';

/** Status and history reads per sliding minute, shared by both endpoints. */
export const ORCHESTRA_STATUS_READS_PER_MINUTE = 50;
/** Submits per sliding minute, proof requests and watcher together. */
export const ORCHESTRA_SUBMITS_PER_MINUTE = 30;
/** Submits per sliding minute that proof requests may use; the watcher keeps the rest. */
export const ORCHESTRA_PROOF_SUBMITS_PER_MINUTE = 20;
/** Quote calls per sliding minute. */
export const ORCHESTRA_QUOTES_PER_MINUTE = 240;
/**
 * Route-list fetches per sliding minute in one container, so two containers
 * stay below Orchestra's 60 per address for routes and limits.
 */
export const ORCHESTRA_ROUTES_PER_MINUTE = 25;

/** Orchestra order statuses that end an order. */
export const ORCHESTRA_FINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'refunded',
  'failed',
  'fallback_delivered',
  'expired',
]);

/** Orchestra order statuses of an order that is moving towards delivery. */
export const ORCHESTRA_PROGRESSING_STATUSES: ReadonlySet<string> = new Set([
  'processing',
  'confirming',
  'awaiting_approval',
  'swapping',
  'bridging',
  'delivering',
]);

/** One source asset of `GET /v2/orchestration/routes`. */
export interface OrchestraRouteAsset {
  /** Chain id string, e.g. `polygon`. */
  chain: string;
  /** Asset symbol, e.g. `USDT`. */
  asset: string;
  /** Token contract, lowercase, or `null` for a native asset. */
  contractAddress: string | null;
  /** Token decimals. */
  decimals: number;
  /** Whether the route lists exact-out to `lightning:BTC`. */
  exactOutToLightning: boolean;
}

/** Result of {@link OrchestraClient.routes}. */
export type OrchestraRoutesResult =
  { ok: true; assets: OrchestraRouteAsset[]; validForMs: number } | { ok: false };

/** Input of {@link OrchestraClient.quote}. */
export interface OrchestraQuoteRequest {
  /** Orchestra chain id, e.g. `polygon`. */
  sourceChain: string;
  /** Stablecoin symbol. */
  sourceAsset: 'USDT' | 'USDC';
  /** Sats the BOLT11 asks for; sent as the exact-out amount. */
  amountSats: number;
  /** The payment's BOLT11, sent as `recipientAddress`. */
  bolt11: string;
  /** The shop payment id. */
  tag: string;
  /** `SHOP_REFUND_ADDRESS`. */
  refundAddress: string;
}

/** Parsed 200 answer of `POST /v1/orchestration/quote`. Addresses and calldata are lowercase. */
export interface OrchestraQuote {
  quoteId: string;
  depositAddress: string;
  amountIn: string;
  requiredAmountIn: string | null;
  maxAcceptedAmountIn: string | null;
  targetAmountOut: string | null;
  /** ISO 8601 time as Orchestra sent it. */
  expiresAt: string;
  transaction: { chainId: number; to: string; data: string; value: string } | null;
}

/**
 * Result of {@link OrchestraClient.quote}. A failure names why (`refused`: a
 * final answer other than HTTP 200; `body`: an HTTP 200 whose body does not
 * parse; `unavailable`, `budget`, `paused`) and whether any attempt was sent.
 */
export type OrchestraQuoteResult =
  | { ok: true; quote: OrchestraQuote }
  | {
      ok: false;
      reason: 'refused' | 'body' | 'unavailable' | 'budget' | 'paused';
      sent: boolean;
    };

/** Who asks for a submit; decides which part of the submit budget it may use. */
export type OrchestraSubmitCaller = 'proof-first' | 'proof-repeat' | 'watcher';

/** Result of {@link OrchestraClient.submit}. */
export type OrchestraSubmitResult =
  | { kind: 'order'; orderId: string; status: string }
  | { kind: 'mismatch' }
  | { kind: 'quote_expired' }
  /**
   * No order and no refusal. `retryable` is true for a transport error or
   * timeout, a 5xx, HTTP 429, and HTTP 409 `idempotency_in_progress` (retry
   * with the same key and body); after any other answer Orchestra cached the
   * answer under the key, so a new attempt needs a new key.
   */
  | { kind: 'unresolved'; retryable: boolean }
  | { kind: 'budget' };

/** The fields of an Orchestra `OperationRecord` the api uses. */
export interface OrchestraOrder {
  id: string;
  quoteId: string | null;
  /** `''` when Orchestra sent no status string. */
  status: string;
  sourceTxHash: string | null;
  recoveredFromOperationId: string | null;
  supersededByOperationId: string | null;
}

/** Result of {@link OrchestraClient.history}. `full` is true when the page had 200 entries. */
export type OrchestraHistoryResult =
  { ok: true; orders: OrchestraOrder[]; full: boolean } | { ok: false; reason: 'budget' | 'error' };

/** Result of {@link OrchestraClient.status}. `order` is `null` for 404 `not_found`. */
export type OrchestraStatusResult =
  { ok: true; order: OrchestraOrder | null } | { ok: false; reason: 'budget' | 'error' };

/** Dependencies of {@link OrchestraClient}. */
export interface OrchestraClientDeps {
  /** `ORCHESTRA_BASE_URL`: origin without a trailing slash. */
  baseUrl: string;
  /** `ORCHESTRA_API_KEY`. Never logged. */
  apiKey: string;
  fetchImpl: FetchFn;
  /** Clock in epoch ms. */
  now: () => number;
  /** Wait before a quote retry whose 429 paused the endpoint; default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Page size (raw entries) of a history read. */
export const ORCHESTRA_HISTORY_PAGE_SIZE = 200;
/** Length of a budget window: {@link IP_RATE_WINDOW_MS}, as for the IP rate limiters. */
const WINDOW_MS = IP_RATE_WINDOW_MS;

type Endpoint = 'routes' | 'quote' | 'submit' | 'history' | 'status';
type Group = 'routes' | 'quote' | 'submit' | 'read';
type Gate = 'ok' | 'budget' | 'paused';

type Sent = { kind: 'transport' } | { kind: 'answer'; status: number; body: unknown; code: string };

interface Attempt {
  at: number;
  proof: boolean;
}

const GROUP_OF: Readonly<Record<Endpoint, Group>> = {
  routes: 'routes',
  quote: 'quote',
  submit: 'submit',
  history: 'read',
  status: 'read',
};

/** Narrow `value` to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string, `null` for missing or `null`, or `undefined` for any other type. */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

/** `error.code` of an Orchestra error body, or `''`. */
function errorCode(body: unknown): string {
  const code = asRecord(asRecord(body)?.['error'])?.['code'];
  return typeof code === 'string' ? code : '';
}

/** Whether `exactOutTo` of a route lists `lightning:BTC`. */
function listsLightning(exactOutTo: unknown): boolean {
  if (exactOutTo === 'all') {
    return true;
  }
  if (Array.isArray(exactOutTo)) {
    return exactOutTo.includes('lightning:BTC');
  }
  const except = asRecord(exactOutTo)?.['except'];
  return Array.isArray(except) && !except.includes('lightning:BTC');
}

/** One route asset, or `null` when a required field is missing or ill-typed. */
function parseRouteAsset(value: unknown): OrchestraRouteAsset | null {
  const row = asRecord(value);
  if (row === null) {
    return null;
  }
  const { chain, asset, decimals } = row;
  const contract = optionalString(row['contractAddress']);
  if (
    typeof chain !== 'string' ||
    typeof asset !== 'string' ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    contract === undefined
  ) {
    return null;
  }
  return {
    chain,
    asset,
    contractAddress: contract === null ? null : contract.toLowerCase(),
    decimals,
    exactOutToLightning: listsLightning(asRecord(row['route'])?.['exactOutTo']),
  };
}

/** The funding transaction of a quote: `null` when absent, `undefined` when ill-typed. */
function parseTransaction(value: unknown): OrchestraQuote['transaction'] | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const tx = asRecord(value);
  if (tx === null) {
    return undefined;
  }
  const { chainId, to, data } = tx;
  const txValue = tx['value'];
  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    typeof to !== 'string' ||
    typeof data !== 'string' ||
    typeof txValue !== 'string'
  ) {
    return undefined;
  }
  return { chainId, to: to.toLowerCase(), data: data.toLowerCase(), value: txValue };
}

/** The flat 200 body of a quote, or `null` when a field the api uses is missing or ill-typed. */
function parseQuote(body: unknown): OrchestraQuote | null {
  const row = asRecord(body);
  if (row === null) {
    return null;
  }
  const { quoteId, depositAddress, amountIn, expiresAt } = row;
  const requiredAmountIn = optionalString(row['requiredAmountIn']);
  const maxAcceptedAmountIn = optionalString(row['maxAcceptedAmountIn']);
  const targetAmountOut = optionalString(row['targetAmountOut']);
  const transaction = parseTransaction(row['transaction']);
  if (
    typeof quoteId !== 'string' ||
    quoteId === '' ||
    typeof depositAddress !== 'string' ||
    typeof amountIn !== 'string' ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    requiredAmountIn === undefined ||
    maxAcceptedAmountIn === undefined ||
    targetAmountOut === undefined ||
    transaction === undefined
  ) {
    return null;
  }
  return {
    quoteId,
    depositAddress: depositAddress.toLowerCase(),
    amountIn,
    requiredAmountIn,
    maxAcceptedAmountIn,
    targetAmountOut,
    expiresAt,
    transaction,
  };
}

/** One `OperationRecord`, or `null` when it has no string `id`. */
function parseOrder(value: unknown): OrchestraOrder | null {
  const row = asRecord(value);
  const id = row?.['id'];
  if (row === null || typeof id !== 'string' || id === '') {
    return null;
  }
  const status = row['status'];
  return {
    id,
    quoteId: optionalString(row['quoteId']) ?? null,
    status: typeof status === 'string' ? status : '',
    sourceTxHash: optionalString(row['sourceTxHash']) ?? null,
    recoveredFromOperationId: optionalString(row['recoveredFromOperationId']) ?? null,
    supersededByOperationId: optionalString(row['supersededByOperationId']) ?? null,
  };
}

/** Pause end from a 429: `Retry-After` seconds, else `X-RateLimit-Reset` epoch ms, else `null`. */
function pauseUntil(headers: Headers, now: number): number | null {
  const retryAfter = (headers.get('retry-after') ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return now + Number(retryAfter) * 1000;
  }
  const reset = Number((headers.get('x-ratelimit-reset') ?? '').trim());
  return Number.isFinite(reset) && reset > 0 ? reset : null;
}

/**
 * Client for the Orchestra calls of the shop stablecoin payment.
 *
 * Every call sends `Authorization: Bearer <apiKey>`, refuses redirects, and
 * aborts after its timeout. Calls with a body also send
 * `Content-Type: application/json` and `X-Idempotency-Key`. Each endpoint
 * group has an in-process budget over a sliding 60 s window: quotes
 * {@link ORCHESTRA_QUOTES_PER_MINUTE}, submits
 * {@link ORCHESTRA_SUBMITS_PER_MINUTE}, status plus history together
 * {@link ORCHESTRA_STATUS_READS_PER_MINUTE}, and route-list fetches
 * {@link ORCHESTRA_ROUTES_PER_MINUTE}. Every attempt
 * sent counts, retries included. A call its budget refuses is not sent and
 * logs `shop.orchestra.budget_exhausted`. An HTTP 429 pauses only the
 * endpoint that answered it, even where endpoints share a budget, until
 * `Retry-After` (seconds) or else `X-RateLimit-Reset` (epoch ms) and logs
 * `shop.orchestra.rate_limited`; a 429 with neither header does not pause.
 * Every non-2xx answer and every transport error logs `shop.orchestra.error`
 * with `endpoint` and `status` (`timeout` or `transport` without an answer),
 * except the 404 `not_found` of a status read. Every log line of a call also
 * carries the ids the caller passes (`paymentId`, and `proofId`, `offerId`,
 * `quoteId`, `providerRef`, or `orderId` where they apply; Logging). No log
 * carries the key, a URL, or a body.
 *
 * Submit budget: proof requests (`proof-first`, `proof-repeat`) together use
 * at most {@link ORCHESTRA_PROOF_SUBMITS_PER_MINUTE} of the window, and the
 * watcher may use whatever the window has left, so it always keeps at least
 * 10. A first submit of a new proof goes before a repeat: a `proof-repeat`
 * is sent only while a first submit would still find a slot after it, that
 * is, while fewer than 19 proof submits and fewer than 29 submits in all
 * are in the window.
 */
export class OrchestraClient {
  private readonly deps: OrchestraClientDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: Record<Group, Attempt[]> = {
    routes: [],
    quote: [],
    submit: [],
    read: [],
  };
  /** Pause end per endpoint: a 429 pauses only the endpoint that answered it. */
  private readonly pausedUntil: Record<Endpoint, number> = {
    routes: 0,
    quote: 0,
    submit: 0,
    history: 0,
    status: 0,
  };

  /**
   * Create a client.
   *
   * @param deps - Base URL, server key, fetch, and clock.
   */
  constructor(deps: OrchestraClientDeps) {
    this.deps = deps;
    this.sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /**
   * Read `GET /v2/orchestration/routes` with the server key.
   *
   * `exactOutToLightning` is true when `route.exactOutTo` is `all`, an array
   * with `lightning:BTC`, or `{ except: [...] }` without it. An asset with a
   * missing or ill-typed `chain`, `asset`, `decimals`, or `contractAddress`
   * is left out.
   *
   * @param timeoutMs - Timeout of the call.
   * @param log - Ids of the payment the list is read for, on every log line.
   * @returns The assets and `validForMs`, or `{ ok: false }` on any failure.
   */
  async routes(timeoutMs: number, log: LogFields): Promise<OrchestraRoutesResult> {
    if (this.gate('routes', null, log) !== 'ok') {
      return { ok: false };
    }
    const sent = await this.send(
      'routes',
      'GET',
      '/v2/orchestration/routes',
      null,
      null,
      timeoutMs,
      log,
    );
    if (sent.kind !== 'answer' || sent.status < 200 || sent.status > 299) {
      return { ok: false };
    }
    const body = asRecord(sent.body);
    const rawAssets = body?.['assets'];
    const validForMs = body?.['validForMs'];
    if (!Array.isArray(rawAssets) || typeof validForMs !== 'number' || !(validForMs >= 0)) {
      return { ok: false };
    }
    const assets: OrchestraRouteAsset[] = [];
    for (const raw of rawAssets) {
      const asset = parseRouteAsset(raw);
      if (asset !== null) {
        assets.push(asset);
      }
    }
    return { ok: true, assets, validForMs };
  }

  /**
   * Request an exact-out quote to the payment's BOLT11.
   *
   * A transport error or timeout, HTTP 429, HTTP 409
   * `idempotency_in_progress`, and any 5xx are retried once with the same
   * key and body while `deadlineMs` has not passed; each attempt's timeout
   * is the time left. When a 429 paused the endpoint, the retry waits for
   * the pause to end if it ends before `deadlineMs`, and is not sent
   * otherwise. A retry that the budget blocks is not sent. Log lines carry
   * the request's `tag` as `paymentId`.
   *
   * @param request - Pair, sat amount, BOLT11, tag, and refund address.
   * @param idempotencyKey - `X-Idempotency-Key`, kept for the retry.
   * @param deadlineMs - Absolute epoch ms after which no attempt starts.
   * @returns The parsed quote of an HTTP 200; `body` for a 200 whose body
   *   does not parse; `refused` for any other final answer (another 2xx
   *   included); `unavailable` when the retryable attempts or the time ran
   *   out; `budget` or `paused` when an attempt could not be sent. A failure
   *   says whether any attempt was sent (`sent`).
   */
  async quote(
    request: OrchestraQuoteRequest,
    idempotencyKey: string,
    deadlineMs: number,
  ): Promise<OrchestraQuoteResult> {
    const body = {
      sourceChain: request.sourceChain,
      sourceAsset: request.sourceAsset,
      destinationChain: 'lightning',
      destinationAsset: 'BTC',
      amount: String(request.amountSats),
      amountMode: 'exact_out',
      recipientAddress: request.bolt11,
      tag: request.tag,
      refundAddress: request.refundAddress,
      includeCalldata: true,
    };
    const log: LogFields = { paymentId: request.tag };
    let anySent = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resumeAtMs = this.pausedUntil.quote;
      if (attempt > 0 && resumeAtMs > this.deps.now()) {
        if (resumeAtMs >= deadlineMs) {
          return { ok: false, reason: 'paused', sent: anySent };
        }
        await this.sleep(resumeAtMs - this.deps.now());
      }
      const left = deadlineMs - this.deps.now();
      if (left <= 0) {
        break;
      }
      const gate = this.gate('quote', null, log);
      if (gate !== 'ok') {
        return { ok: false, reason: gate, sent: anySent };
      }
      anySent = true;
      const sent = await this.send(
        'quote',
        'POST',
        '/v1/orchestration/quote',
        body,
        idempotencyKey,
        left,
        log,
      );
      if (sent.kind === 'transport') {
        continue;
      }
      if (sent.status === 200) {
        const quote = parseQuote(sent.body);
        return quote === null ? { ok: false, reason: 'body', sent: true } : { ok: true, quote };
      }
      const retryable =
        sent.status === 429 ||
        sent.status >= 500 ||
        (sent.status === 409 && sent.code === 'idempotency_in_progress');
      if (!retryable) {
        return { ok: false, reason: 'refused', sent: true };
      }
    }
    return { ok: false, reason: 'unavailable', sent: anySent };
  }

  /**
   * Quote calls the current window still allows.
   *
   * @returns The count left, or 0 while quotes are paused by a 429.
   */
  quoteBudgetLeft(): number {
    const now = this.deps.now();
    if (now < this.pausedUntil.quote) {
      return 0;
    }
    return Math.max(0, ORCHESTRA_QUOTES_PER_MINUTE - this.window('quote', now).length);
  }

  /**
   * Submit a deposit transaction for a quote with body `{ quoteId, txHash }`.
   *
   * HTTP 401, 403, and a 400 other than `xchain_deposit_mismatch` also log
   * `shop.alert.orchestra_request` with `endpoint`, `status`, and `code`.
   *
   * @param quoteId - Orchestra quote id.
   * @param txHash - Deposit transaction hash.
   * @param idempotencyKey - `X-Idempotency-Key`.
   * @param caller - Which part of the submit budget the call uses.
   * @param timeoutMs - Timeout of the call.
   * @param log - Ids of the proof (`paymentId`, `proofId`, `offerId`,
   *   `quoteId`, `providerRef`), on every log line.
   * @returns `order` for a 200 with a string `orderId` (`status` `''` when
   *   missing), `mismatch` for 400 `xchain_deposit_mismatch`,
   *   `quote_expired` for 409 `quote_expired`, `budget` when not sent, and
   *   `unresolved` for everything else.
   */
  async submit(
    quoteId: string,
    txHash: string,
    idempotencyKey: string,
    caller: OrchestraSubmitCaller,
    timeoutMs: number,
    log: LogFields,
  ): Promise<OrchestraSubmitResult> {
    if (this.gate('submit', caller, log) !== 'ok') {
      return { kind: 'budget' };
    }
    const sent = await this.send(
      'submit',
      'POST',
      '/v1/orchestration/submit',
      { quoteId, txHash },
      idempotencyKey,
      timeoutMs,
      log,
      caller !== 'watcher',
    );
    if (sent.kind === 'transport') {
      return { kind: 'unresolved', retryable: true };
    }
    if (sent.status >= 200 && sent.status <= 299) {
      const row = asRecord(sent.body);
      const orderId = row?.['orderId'];
      const status = row?.['status'];
      return typeof orderId === 'string' && orderId !== ''
        ? { kind: 'order', orderId, status: typeof status === 'string' ? status : '' }
        : { kind: 'unresolved', retryable: false };
    }
    if (sent.status === 400 && sent.code === 'xchain_deposit_mismatch') {
      return { kind: 'mismatch' };
    }
    if (sent.status === 409 && sent.code === 'quote_expired') {
      return { kind: 'quote_expired' };
    }
    this.alertOnRequestProblem('submit', sent, log);
    return {
      kind: 'unresolved',
      retryable:
        sent.status >= 500 ||
        sent.status === 429 ||
        (sent.status === 409 && sent.code === 'idempotency_in_progress'),
    };
  }

  /**
   * Read one page of `GET /v1/orchestration/history` for a recipient address.
   *
   * The answer is `{ orders: OperationRecord[] }`. An entry without a string
   * `id` is left out; `full` counts the raw page. HTTP 400, 401, and 403 also
   * log `shop.alert.orchestra_request`.
   *
   * @param bolt11 - The payment's BOLT11, sent as `address`.
   * @param offset - Paging offset; `limit` is always 200.
   * @param timeoutMs - Timeout of the call.
   * @param log - Ids of the payment read (`paymentId`), on every log line.
   * @returns The orders and whether the page was full, or a failure reason.
   */
  async history(
    bolt11: string,
    offset: number,
    timeoutMs: number,
    log: LogFields,
  ): Promise<OrchestraHistoryResult> {
    if (this.gate('history', null, log) !== 'ok') {
      return { ok: false, reason: 'budget' };
    }
    const query = new URLSearchParams({
      address: bolt11,
      limit: String(ORCHESTRA_HISTORY_PAGE_SIZE),
      offset: String(offset),
    });
    const sent = await this.send(
      'history',
      'GET',
      `/v1/orchestration/history?${query.toString()}`,
      null,
      null,
      timeoutMs,
      log,
    );
    if (sent.kind === 'transport') {
      return { ok: false, reason: 'error' };
    }
    if (sent.status < 200 || sent.status > 299) {
      this.alertOnRequestProblem('history', sent, log);
      return { ok: false, reason: 'error' };
    }
    const raw = asRecord(sent.body)?.['orders'];
    if (!Array.isArray(raw)) {
      return { ok: false, reason: 'error' };
    }
    const orders: OrchestraOrder[] = [];
    for (const entry of raw) {
      const order = parseOrder(entry);
      if (order !== null) {
        orders.push(order);
      }
    }
    return { ok: true, orders, full: raw.length >= ORCHESTRA_HISTORY_PAGE_SIZE };
  }

  /**
   * Read `GET /v1/orchestration/status?id=<orderId>` for a known order.
   *
   * HTTP 400, 401, and 403 also log `shop.alert.orchestra_request`.
   *
   * @param orderId - Orchestra order id.
   * @param timeoutMs - Timeout of the call.
   * @param log - Ids of the proof whose order is read (`paymentId`,
   *   `proofId`, `offerId`, its offer's `quoteId` and `providerRef`, and
   *   `orderId`), on every log line.
   * @returns The order; `order: null` for 404 `not_found` or a `null`
   *   order; `budget` when not sent; `error` for every other failure.
   */
  async status(orderId: string, timeoutMs: number, log: LogFields): Promise<OrchestraStatusResult> {
    if (this.gate('status', null, log) !== 'ok') {
      return { ok: false, reason: 'budget' };
    }
    const query = new URLSearchParams({ id: orderId });
    const sent = await this.send(
      'status',
      'GET',
      `/v1/orchestration/status?${query.toString()}`,
      null,
      null,
      timeoutMs,
      log,
    );
    if (sent.kind === 'transport') {
      return { ok: false, reason: 'error' };
    }
    if (sent.status === 404 && sent.code === 'not_found') {
      return { ok: true, order: null };
    }
    if (sent.status < 200 || sent.status > 299) {
      this.alertOnRequestProblem('status', sent, log);
      return { ok: false, reason: 'error' };
    }
    const body = asRecord(sent.body);
    if (body === null || !('order' in body)) {
      return { ok: false, reason: 'error' };
    }
    if (body['order'] === null) {
      return { ok: true, order: null };
    }
    const order = parseOrder(body['order']);
    return order === null ? { ok: false, reason: 'error' } : { ok: true, order };
  }

  /** Attempts of `group` inside the window ending at `now`, after dropping older ones. */
  private window(group: Group, now: number): Attempt[] {
    const kept = this.attempts[group].filter((attempt) => attempt.at > now - WINDOW_MS);
    this.attempts[group] = kept;
    return kept;
  }

  /** Whether a call of `endpoint` may be sent now; logs a budget refusal with the caller's ids. */
  private gate(endpoint: Endpoint, caller: OrchestraSubmitCaller | null, log: LogFields): Gate {
    const group = GROUP_OF[endpoint];
    const now = this.deps.now();
    if (now < this.pausedUntil[endpoint]) {
      return 'paused';
    }
    const window = this.window(group, now);
    let allowed: boolean;
    if (group === 'quote') {
      allowed = window.length < ORCHESTRA_QUOTES_PER_MINUTE;
    } else if (group === 'read') {
      allowed = window.length < ORCHESTRA_STATUS_READS_PER_MINUTE;
    } else if (group === 'routes') {
      allowed = window.length < ORCHESTRA_ROUTES_PER_MINUTE;
    } else {
      const proof = window.filter((attempt) => attempt.proof).length;
      // A repeat leaves one proof slot and one overall slot for a first submit.
      const reserve = caller === 'proof-repeat' ? 1 : 0;
      allowed =
        window.length + reserve < ORCHESTRA_SUBMITS_PER_MINUTE &&
        (caller === 'watcher' || proof + reserve < ORCHESTRA_PROOF_SUBMITS_PER_MINUTE);
    }
    if (!allowed) {
      logEvent('shop.orchestra.budget_exhausted', { ...log, endpoint });
      return 'budget';
    }
    return 'ok';
  }

  /** Log `shop.alert.orchestra_request` for HTTP 400, 401, and 403, with the caller's ids. */
  private alertOnRequestProblem(
    endpoint: Endpoint,
    sent: { status: number; code: string },
    log: LogFields,
  ): void {
    if (sent.status === 400 || sent.status === 401 || sent.status === 403) {
      logEvent('shop.alert.orchestra_request', {
        ...log,
        endpoint,
        status: sent.status,
        code: sent.code,
      });
    }
  }

  /** Send one attempt, count it, and log errors and rate limits with the caller's ids. */
  private async send(
    endpoint: Endpoint,
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | null,
    idempotencyKey: string | null,
    timeoutMs: number,
    log: LogFields,
    proof = false,
  ): Promise<Sent> {
    const group = GROUP_OF[endpoint];
    this.attempts[group].push({ at: this.deps.now(), proof });
    const headers: Record<string, string> = { Authorization: `Bearer ${this.deps.apiKey}` };
    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    };
    if (body !== null && idempotencyKey !== null) {
      headers['Content-Type'] = 'application/json';
      headers['X-Idempotency-Key'] = idempotencyKey;
      init.body = JSON.stringify(body);
    }
    let response: Response;
    let parsed: unknown;
    try {
      response = await this.deps.fetchImpl(`${this.deps.baseUrl}${path}`, init);
      const text = await response.text();
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const status = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport';
      logEvent('shop.orchestra.error', { ...log, endpoint, status });
      return { kind: 'transport' };
    }
    const code = errorCode(parsed);
    if (response.status === 404 && endpoint === 'status' && code === 'not_found') {
      return { kind: 'answer', status: response.status, body: parsed, code };
    }
    if (response.status < 200 || response.status > 299) {
      logEvent('shop.orchestra.error', { ...log, endpoint, status: response.status });
    }
    if (response.status === 429) {
      const until = pauseUntil(response.headers, this.deps.now());
      if (until !== null) {
        this.pausedUntil[endpoint] = Math.max(this.pausedUntil[endpoint], until);
      }
      logEvent('shop.orchestra.rate_limited', { ...log, endpoint });
    }
    return { kind: 'answer', status: response.status, body: parsed, code };
  }
}
