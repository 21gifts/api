/**
 * HTTP client for the self-hosted LNURL server.
 *
 * Builds the upstream URL, forwards a fixed header allow-list, and never
 * logs a URL, query string, header value, or body. Used by the forwarded
 * LNURL routes and the wallet-backed `/.well-known/lnurlp/:username` branch.
 */

import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';

/** Abort the pay-request fetch after this many milliseconds. */
export const LNURL_PAY_REQUEST_TIMEOUT_MS = 5_000;
/** Abort every other LNURL server call after this many milliseconds. */
export const LNURL_SERVER_TIMEOUT_MS = 15_000;
/** Largest request body the forwarded routes accept, in bytes. */
export const LNURL_BODY_LIMIT_BYTES = 1024 * 1024;

/** One call to the LNURL server. */
export interface LnurlServerCall {
  method: 'GET' | 'POST';
  /** Path segments after the base URL. Each is percent-encoded with `encodeURIComponent`. */
  segments: readonly string[];
  /** Raw query string, `''` or starting with `?`. Appended unchanged. Default `''`. */
  search?: string;
  /** Inbound request headers. Only `content-type`, `x-breez-signature`, `x-breez-timestamp` are forwarded. */
  headers?: { get(name: string): string | null };
  /** Request body, forwarded unchanged (POST only). */
  body?: string;
  /** Abort after this many milliseconds. */
  timeoutMs: number;
}

/** Outcome of {@link callLnurlServer}. */
export type LnurlServerResult =
  { ok: true; status: number; body: string; headers: Record<string, string> } | { ok: false };

/** Inbound header names that may be forwarded to the LNURL server. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'x-breez-signature', 'x-breez-timestamp'] as const;

/** Upstream response header names that may be returned to the client. */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;

/**
 * Call the self-hosted LNURL server once.
 *
 * Refuses path segments that are empty, `.`, or `..` without fetching.
 * Always sends `Host: config.host`. Never logs the URL, query, headers, or body.
 *
 * @param config - Resolved LNURL server configuration.
 * @param fetchImpl - Injected `fetch` (tests stub this).
 * @param call - Method, path segments, optional search/headers/body, and timeout.
 * @returns Upstream status/body/headers, or `{ ok: false }` on network/timeout/redirect/`text()` failure.
 */
export async function callLnurlServer(
  config: LnurlServerConfig,
  fetchImpl: FetchFn,
  call: LnurlServerCall,
): Promise<LnurlServerResult> {
  for (const segment of call.segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false };
    }
  }

  const url = `${config.baseUrl}/${call.segments.map(encodeURIComponent).join('/')}${call.search ?? ''}`;
  const headers: Record<string, string> = { host: config.host };
  if (call.headers !== undefined) {
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = call.headers.get(name);
      if (value !== null) {
        headers[name] = value;
      }
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: call.method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(call.timeoutMs),
      ...(call.body === undefined ? {} : { body: call.body }),
    });
  } catch {
    return { ok: false };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false };
  }

  const outHeaders: Record<string, string> = {};
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      outHeaders[name] = value;
    }
  }

  return { ok: true, status: response.status, body, headers: outHeaders };
}

/**
 * Validate a wallet-backed LNURL-pay document for this api's callback.
 *
 * @param body - Parsed JSON from the LNURL server.
 * @param expectedCallback - Exact callback URL this api expects.
 * @returns The same object when valid; otherwise `null`.
 */
export function walletPayRequest(
  body: unknown,
  expectedCallback: string,
): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const doc = body as Record<string, unknown>;
  if (doc['tag'] !== 'payRequest') {
    return null;
  }
  if (doc['callback'] !== expectedCallback) {
    return null;
  }
  if (typeof doc['metadata'] !== 'string') {
    return null;
  }
  const minSendable = doc['minSendable'];
  const maxSendable = doc['maxSendable'];
  if (typeof minSendable !== 'number' || typeof maxSendable !== 'number') {
    return null;
  }
  if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable)) {
    return null;
  }
  if (!(minSendable >= 1 && minSendable <= maxSendable)) {
    return null;
  }
  return doc;
}
