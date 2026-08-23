import { createHmac, randomBytes } from 'node:crypto';
import type { FetchFn } from '@/lib/btc-usd-rate';

/**
 * Wallet of Satoshi unofficial v1 REST client (read balance, pay BOLT11).
 *
 * Host is pinned to `www.livingroomofsatoshi.com`. Token, secret, nonce,
 * signature, and bolt11 are never written to logs.
 */

export const WOS_BASE_URL = 'https://www.livingroomofsatoshi.com';
const GET_TIMEOUT_MS = 15_000;
const PAY_TIMEOUT_MS = 90_000;

/** Outcome of paying a BOLT11 invoice. */
export type PayoutPayResult =
  | { status: 'paid'; paymentHash: string }
  | { status: 'failed'; reason: string }
  | { status: 'uncertain'; reason: string; paymentHash?: string };

/**
 * Minimal payout backend used by the daily-gifts worker.
 */
export interface PayoutClient {
  getBalanceSats(): Promise<{ ok: true; sats: number } | { ok: false; reason: string }>;
  payInvoice(bolt11: string): Promise<PayoutPayResult>;
}

/**
 * HMAC-SHA256 signature for a WoS POST: `endpoint + nonce + apiToken + body`.
 *
 * @param apiSecret - Shared HMAC secret.
 * @param endpoint - Path beginning with `/api/`.
 * @param nonce - Request nonce (base64).
 * @param apiToken - Bearer API token.
 * @param body - Raw JSON body string.
 * @returns Lower-case hex digest.
 */
export function signWosRequest(
  apiSecret: string,
  endpoint: string,
  nonce: string,
  apiToken: string,
  body: string,
): string {
  return createHmac('sha256', apiSecret)
    .update(endpoint + nonce + apiToken + body)
    .digest('hex');
}

/**
 * HTTP client for a Wallet of Satoshi account.
 *
 * GET endpoints use `Api-Token` only. POST `/api/v1/wallet/payment` is signed
 * with HMAC-SHA256 over `endpoint + nonce + apiToken + body`.
 */
export class WosClient implements PayoutClient {
  private readonly apiToken: string;
  private readonly apiSecret: string;
  private readonly fetchImpl: FetchFn;
  private readonly nonce: () => string;

  /**
   * @param args - Token + secret, injected fetch, optional nonce factory (tests).
   */
  constructor(args: {
    apiToken: string;
    apiSecret: string;
    fetchImpl: FetchFn;
    nonce?: () => string;
  }) {
    this.apiToken = args.apiToken;
    this.apiSecret = args.apiSecret;
    this.fetchImpl = args.fetchImpl;
    this.nonce = args.nonce ?? (() => randomBytes(16).toString('base64'));
  }

  /**
   * Read the confirmed wallet balance in satoshis.
   *
   * WoS reports BTC as a float (`btc`). Values are rounded to integer sats.
   *
   * @returns Integer sats, or a failure reason string (no secrets).
   */
  async getBalanceSats(): Promise<{ ok: true; sats: number } | { ok: false; reason: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${WOS_BASE_URL}/api/v1/wallet/balance`, {
        method: 'GET',
        headers: { 'Api-Token': this.apiToken, 'User-Agent': '' },
        signal: AbortSignal.timeout(GET_TIMEOUT_MS),
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
    const btc = (body as Record<string, unknown>)['btc'];
    if (typeof btc !== 'number' || !Number.isFinite(btc) || btc < 0) {
      return { ok: false, reason: 'invalid_schema' };
    }
    return { ok: true, sats: Math.round(btc * 100_000_000) };
  }

  /**
   * Pay a BOLT11 invoice via `POST /api/v1/wallet/payment`.
   *
   * Paid only on HTTP 200 with `status === "PAID"`. HTTP 400 is a clear
   * pre-dispatch rejection (`failed`). Timeouts, 5xx, `PENDING`, and
   * inconclusive 2xx are `uncertain`.
   *
   * @param bolt11 - Invoice string (never logged).
   * @returns Paid, failed, or uncertain outcome.
   */
  async payInvoice(bolt11: string): Promise<PayoutPayResult> {
    const endpoint = '/api/v1/wallet/payment';
    const payload = JSON.stringify({ address: bolt11, currency: 'LIGHTNING' });
    const nonce = this.nonce();
    const signature = signWosRequest(this.apiSecret, endpoint, nonce, this.apiToken, payload);

    let response: Response;
    try {
      response = await this.fetchImpl(`${WOS_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Token': this.apiToken,
          Nonce: nonce,
          Signature: signature,
          'User-Agent': '',
        },
        body: payload,
        signal: AbortSignal.timeout(PAY_TIMEOUT_MS),
      });
    } catch {
      return { status: 'uncertain', reason: 'network' };
    }

    if (response.status >= 500) {
      return { status: 'uncertain', reason: 'http_' + String(response.status) };
    }
    if (response.status === 400) {
      return { status: 'failed', reason: await errorMessage(response, 'http_400') };
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
    const status = record['status'];
    const txid = record['transactionId'];
    const paymentHash = typeof txid === 'string' ? txid : '';

    if (status === 'PAID') {
      return { status: 'paid', paymentHash };
    }
    if (status === 'PENDING') {
      return paymentHash !== ''
        ? { status: 'uncertain', reason: 'pending', paymentHash }
        : { status: 'uncertain', reason: 'pending' };
    }
    return { status: 'uncertain', reason: 'unknown_status' };
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const message = (body as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message !== '') {
        return message;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}
