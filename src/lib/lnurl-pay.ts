import { z } from 'zod';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';

/**
 * LNURL-pay (LUD-06) zap invoice request for a Lightning Address (LUD-16).
 *
 * Expected provider failures collapse to a single `unreachable` reason so the
 * caller does not leak provider internals to the client.
 */

/** Re-export shared fetch type so existing importers keep working. */
export type { FetchFn };

/** LNURL-pay invoice response from the callback. */
const lnurlpInvoiceSchema = z.object({
  pr: z.string().min(1),
});

/** Zap invoice fetch: success with bolt11, or collapsed failure. */
export type ZapInvoiceResult =
  | {
      ok: true;
      pr: string;
      amountSats: number;
      /** Raw LNURL callback JSON object when the body was JSON; else null. */
      lnurlResponse: Record<string, unknown> | null;
    }
  | {
      ok: false;
      reason: 'unreachable' | 'noZap';
      /** Raw LNURL callback JSON when a JSON body was received; else null. */
      lnurlResponse: Record<string, unknown> | null;
    };

/**
 * Fetch a BOLT11 invoice for a NIP-57 zap (`nostr=` query, not `comment=`).
 *
 * Captures the raw LNURL callback JSON body (even when schema-invalid) so
 * callers can persist it on invoice-attempt rows. Never pays the invoice.
 *
 * When the first attempt is `{ ok: false, reason: 'unreachable' }`, the same
 * attempt runs once more and that second result is returned. `ok` and `noZap`
 * are not retried.
 *
 * @param args - Address, amount millisats, signed 9734 JSON, fetch.
 * @returns Invoice or a collapsed reason (`noZap` when `allowsNostr` is not true or `nostrPubkey` is missing). Every result includes `lnurlResponse` (callback JSON object or `null`).
 */
export async function requestZapInvoice(args: {
  address: string;
  amountMsat: number;
  zapRequestJson: string;
  fetchImpl: FetchFn;
}): Promise<ZapInvoiceResult> {
  const attempt = async (): Promise<ZapInvoiceResult> => {
    const resolved = await resolveLnurlp({
      address: args.address,
      fetchImpl: args.fetchImpl,
    });
    if (!resolved.ok) {
      return { ok: false, reason: 'unreachable', lnurlResponse: null };
    }
    const metadata = resolved.metadata;
    if (metadata.allowsNostr !== true || metadata.nostrPubkey === undefined) {
      return { ok: false, reason: 'noZap', lnurlResponse: null };
    }
    if (args.amountMsat < metadata.minSendable || args.amountMsat > metadata.maxSendable) {
      return { ok: false, reason: 'unreachable', lnurlResponse: null };
    }
    const callbackUrl = new URL(metadata.callback);
    callbackUrl.searchParams.set('amount', String(args.amountMsat));
    callbackUrl.searchParams.set('nostr', args.zapRequestJson);
    const fetched = await fetchJsonRaw(args.fetchImpl, callbackUrl.toString());
    if (fetched === null) {
      return { ok: false, reason: 'unreachable', lnurlResponse: null };
    }
    if (!fetched.ok) {
      return { ok: false, reason: 'unreachable', lnurlResponse: fetched.asObject };
    }
    const parsed = lnurlpInvoiceSchema.safeParse(fetched.body);
    if (!parsed.success) {
      return { ok: false, reason: 'unreachable', lnurlResponse: fetched.asObject };
    }
    return {
      ok: true,
      pr: parsed.data.pr,
      amountSats: Math.floor(args.amountMsat / 1000),
      lnurlResponse: fetched.asObject,
    };
  };

  const first = await attempt();
  if (first.ok === false && first.reason === 'unreachable') {
    return attempt();
  }
  return first;
}

/**
 * GET `url` and parse JSON without schema enforcement.
 *
 * @returns Raw body plus object form and HTTP ok; `null` on network/JSON failure.
 */
async function fetchJsonRaw(
  fetchImpl: FetchFn,
  url: string,
): Promise<{ body: unknown; asObject: Record<string, unknown> | null; ok: boolean } | null> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const asObject =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  return { body, asObject, ok: response.ok };
}
