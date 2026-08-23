import type { FetchFn } from '@/lib/btc-usd-rate';
import type { PayoutClient, PayoutPayResult } from '@/lib/payout-client';

/**
 * Official phoenixd HTTP client (ACINQ): GET `/getbalance`, POST `/payinvoice`.
 *
 * Auth is HTTP Basic with an empty username and the phoenixd HTTP password.
 * The password, BOLT11, payment hash, and preimage are never written to logs.
 */

const GET_TIMEOUT_MS = 15_000;
const PAY_TIMEOUT_MS = 90_000;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Normalize a phoenixd base URL.
 *
 * Accepts `http:` / `https:` only, no userinfo (password is a separate env),
 * no query or hash. Trailing slashes on the path are stripped.
 *
 * @param raw - Operator-supplied URL string.
 * @returns Normalized base URL, or `invalid_url`.
 */
export function parsePhoenixdBaseUrl(
  raw: string,
): { ok: true; baseUrl: string } | { ok: false; reason: 'invalid_url' } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'invalid_url' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.hostname === '' || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'invalid_url' };
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` };
}

/**
 * HTTP client for a local or remote phoenixd node.
 *
 * `GET /getbalance` → spendable `balanceSat`. `POST /payinvoice` is
 * `application/x-www-form-urlencoded` with `invoice` only (amount is already
 * in the BOLT11). phoenixd pays synchronously: 2xx with hash+preimage is
 * paid; 4xx (except 408/429) is a clear miss; everything else is uncertain.
 */
export class PhoenixdClient implements PayoutClient {
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly fetchImpl: FetchFn;

  /**
   * @param args - Normalized base URL, HTTP password, injected fetch.
   */
  constructor(args: { baseUrl: string; password: string; fetchImpl: FetchFn }) {
    this.baseUrl = args.baseUrl;
    this.password = args.password;
    this.fetchImpl = args.fetchImpl;
  }

  /**
   * Read spendable balance in satoshis (`balanceSat`; fee credit is ignored).
   *
   * @returns Integer sats, or a failure reason string (no secrets).
   */
  async getBalanceSats(): Promise<{ ok: true; sats: number } | { ok: false; reason: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/getbalance`, {
        method: 'GET',
        headers: { Authorization: basicAuth(this.password) },
        signal: AbortSignal.timeout(GET_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'http_' + String(response.status) };
    }
    const body = await readJson(response);
    if (body === undefined) {
      return { ok: false, reason: 'invalid_json' };
    }
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'invalid_schema' };
    }
    const sats = (body as Record<string, unknown>)['balanceSat'];
    if (typeof sats !== 'number' || !Number.isFinite(sats) || sats < 0) {
      return { ok: false, reason: 'invalid_schema' };
    }
    return { ok: true, sats: Math.floor(sats) };
  }

  /**
   * Pay a BOLT11 invoice via `POST /payinvoice`.
   *
   * Paid only on HTTP 2xx with 64-hex `paymentHash` and `paymentPreimage`.
   * Client 4xx (except 408/429) is `failed`. Timeouts, 5xx, 408/429, and
   * inconclusive 2xx are `uncertain`.
   *
   * @param bolt11 - Invoice string (never logged).
   * @returns Paid, failed, or uncertain outcome.
   */
  async payInvoice(bolt11: string): Promise<PayoutPayResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/payinvoice`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(this.password),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `invoice=${encodeURIComponent(bolt11)}`,
        signal: AbortSignal.timeout(PAY_TIMEOUT_MS),
      });
    } catch {
      return { status: 'uncertain', reason: 'network' };
    }

    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }
    if (response.status >= 400) {
      return {
        status: 'failed',
        reason: await errorMessage(response, 'http_' + String(response.status)),
      };
    }
    /* v8 ignore next 3 — 1xx/3xx after 2xx/4xx/5xx gates */
    if (!response.ok) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }

    const body = await readJson(response);
    if (body === undefined) {
      return { status: 'uncertain', reason: 'invalid_json' };
    }
    if (typeof body !== 'object' || body === null) {
      return { status: 'uncertain', reason: 'invalid_schema' };
    }
    const record = body as Record<string, unknown>;
    const paymentHash = record['paymentHash'];
    const preimage = record['paymentPreimage'];
    if (typeof paymentHash !== 'string' || !HEX_64.test(paymentHash)) {
      return { status: 'uncertain', reason: 'invalid_schema' };
    }
    if (typeof preimage !== 'string' || !HEX_64.test(preimage)) {
      return { status: 'uncertain', reason: 'invalid_schema' };
    }
    return { status: 'paid', paymentHash, preimage };
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`:${password}`, 'utf8').toString('base64')}`;
}

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await readJson(response);
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ['reason', 'error', 'message'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') {
        return value;
      }
    }
  }
  return fallback;
}
