import type { FetchFn } from '@/lib/btc-usd-rate';

/**
 * lightning.space LNDHub client (`auth` → `getbalance` / `payinvoice`).
 *
 * Host is pinned to `lightning.space` over HTTPS. Login, password, token,
 * preimage, and bolt11 are never written to logs.
 */

const LNDHUB_HOST = 'lightning.space';
const AUTH_TIMEOUT_MS = 15_000;
const BALANCE_TIMEOUT_MS = 15_000;
const PAY_TIMEOUT_MS = 90_000;

/**
 * Parse and validate an LNDHub base URL.
 *
 * Requires `https:` and host exactly `lightning.space`. Trailing slashes on
 * the pathname are stripped. Any other host or protocol yields `null`.
 *
 * @param raw - Operator-supplied base URL string.
 * @returns A normalised `URL`, or `null` when rejected.
 */
export function parseLndhubBaseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.hostname !== LNDHUB_HOST) {
    return null;
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

/** Outcome of paying a BOLT11 invoice through LNDHub. */
export type LndhubPayResult =
  | { status: 'paid'; preimage: string; paymentHash: string }
  | { status: 'failed'; reason: string }
  | { status: 'uncertain'; reason: string; paymentHash?: string };

/**
 * HTTP client for a lightning.space LNDHub wallet.
 *
 * Caches the bearer token from `POST /auth` and re-authenticates once on 401.
 */
export class LndhubClient {
  private readonly base: string;
  private readonly login: string;
  private readonly password: string;
  private readonly fetchImpl: FetchFn;
  private token: string | null = null;

  /**
   * @param args - Base URL (must pass {@link parseLndhubBaseUrl}), credentials,
   *   injected fetch, and optional clock (reserved for tests).
   */
  constructor(args: {
    baseUrl: string;
    login: string;
    password: string;
    fetchImpl: FetchFn;
    clock?: () => number;
  }) {
    const parsed = parseLndhubBaseUrl(args.baseUrl);
    if (parsed === null) {
      throw new Error('invalid_lndhub_url');
    }
    this.base = parsed.toString().replace(/\/+$/, '');
    this.login = args.login;
    this.password = args.password;
    this.fetchImpl = args.fetchImpl;
    void args.clock;
  }

  /**
   * Read the wallet's available balance in satoshis.
   *
   * @returns Integer sats, or a failure reason string (no secrets).
   */
  async getBalanceSats(): Promise<{ ok: true; sats: number } | { ok: false; reason: string }> {
    let response: Response;
    try {
      response = await this.authorizedFetch(`${this.base}/getbalance`, {
        method: 'GET',
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'http_' + String(response.status) };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'invalid_schema' };
    }
    const btc = (body as Record<string, unknown>)['BTC'];
    if (typeof btc !== 'object' || btc === null) {
      return { ok: false, reason: 'invalid_schema' };
    }
    const raw = (btc as Record<string, unknown>)['AvailableBalance'];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return { ok: false, reason: 'invalid_schema' };
    }
    return { ok: true, sats: raw };
  }

  /**
   * Pay a BOLT11 invoice via `POST /payinvoice`.
   *
   * Paid only on HTTP 2xx with an empty/absent `payment_error` and a non-empty
   * `payment_preimage`. Exact `payment_error === 'Invalid invoice'` is `failed`;
   * other errors, timeouts, 5xx, and inconclusive 2xx are `uncertain`.
   *
   * @param bolt11 - Invoice string (never logged).
   * @returns Paid, failed, or uncertain outcome.
   */
  async payInvoice(bolt11: string): Promise<LndhubPayResult> {
    let response: Response;
    try {
      response = await this.authorizedFetch(`${this.base}/payinvoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invoice: bolt11 }),
        signal: AbortSignal.timeout(PAY_TIMEOUT_MS),
      });
    } catch {
      return { status: 'uncertain', reason: 'network' };
    }

    if (response.status >= 500) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }
    if (response.status === 401) {
      return { status: 'uncertain', reason: 'unauthorized' };
    }
    if (response.status >= 400) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }
    /* v8 ignore next 3 — 1xx/3xx after 2xx/4xx/5xx gates */
    if (!response.ok) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'uncertain', reason: 'invalid_json' };
    }
    if (typeof body !== 'object' || body === null) {
      return { status: 'uncertain', reason: 'invalid_schema' };
    }
    const record = body as Record<string, unknown>;
    const paymentError = record['payment_error'];
    const preimageRaw = record['payment_preimage'];
    const hashRaw = record['payment_hash'];
    const paymentHash = typeof hashRaw === 'string' ? hashRaw : '';

    if (typeof paymentError === 'string' && paymentError !== '') {
      if (paymentError === 'Invalid invoice') {
        return { status: 'failed', reason: paymentError };
      }
      if (paymentHash !== '') {
        return { status: 'uncertain', reason: paymentError, paymentHash };
      }
      return { status: 'uncertain', reason: paymentError };
    }
    if (paymentError !== undefined && paymentError !== null && paymentError !== '') {
      return { status: 'uncertain', reason: 'payment_error' };
    }

    if (typeof preimageRaw !== 'string' || preimageRaw === '') {
      return { status: 'uncertain', reason: 'missing_preimage' };
    }

    return { status: 'paid', preimage: preimageRaw, paymentHash };
  }

  /**
   * Ensure a bearer token, then fetch; on 401 clear the cache, re-auth once, retry.
   */
  private async authorizedFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await this.ensureToken();
    if (token === null) {
      return new Response(null, { status: 401 });
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetchImpl(url, { ...init, headers });
    if (response.status !== 401) {
      return response;
    }
    this.token = null;
    const retried = await this.ensureToken();
    if (retried === null) {
      return new Response(null, { status: 401 });
    }
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set('Authorization', `Bearer ${retried}`);
    return await this.fetchImpl(url, { ...init, headers: retryHeaders });
  }

  /** Authenticate and cache `access_token` or `token`. */
  private async ensureToken(): Promise<string | null> {
    if (this.token !== null) {
      return this.token;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: this.login, password: this.password }),
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const record = body as Record<string, unknown>;
    const access = record['access_token'];
    const tokenField = record['token'];
    const value =
      typeof access === 'string' && access !== ''
        ? access
        : typeof tokenField === 'string' && tokenField !== ''
          ? tokenField
          : null;
    if (value === null) {
      return null;
    }
    this.token = value;
    return value;
  }
}
