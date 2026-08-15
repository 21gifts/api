import { z } from 'zod';
import { VERIFICATION_AMOUNT_CAP_MSAT } from '@/lib/config';

/**
 * LNURL-pay (LUD-06) invoice request for a Lightning Address (LUD-16), with
 * an optional LUD-12 comment. Used by receiver address verification to obtain
 * a BOLT11 invoice the api can pay with a one-time nonce in the comment.
 *
 * Expected provider failures collapse to a single `unreachable` reason so the
 * caller does not leak provider internals to the client.
 */

/** Successful invoice fetch, or a collapsed failure reason. */
export type LnurlPayResult =
  { ok: true; pr: string; payMsat: number } | { ok: false; reason: 'unreachable' };

/** Minimal fetch used by LNURL-pay (tests inject a stub). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Arguments for {@link requestPayInvoice}. */
export interface RequestPayInvoiceArgs {
  /** Already-normalised LUD-16 address (`name@domain`). */
  address: string;
  /** Preferred amount in millisatoshis (may be raised to `minSendable`). */
  amountMsat: number;
  /** LUD-12 comment attached to the payment (e.g. the verification nonce). */
  comment: string;
  /** Injected `fetch` (tests supply a fake; production uses `globalThis.fetch`). */
  fetchImpl: FetchFn;
}

/** LNURL-pay metadata from `/.well-known/lnurlp/...`. */
const lnurlpMetadataSchema = z.object({
  callback: z.string().url(),
  minSendable: z.number().int().min(0),
  commentAllowed: z.number().int().optional(),
});

/** LNURL-pay invoice response from the callback. */
const lnurlpInvoiceSchema = z.object({
  pr: z.string().min(1),
});

/**
 * Resolve a LUD-16 address to a BOLT11 invoice for the given amount and comment.
 *
 * Steps: well-known LNURL-pay metadata → amount/`commentAllowed` checks →
 * callback with `amount` and `comment` → return `pr` and the paid amount.
 *
 * @param args - Address, amount, comment, and injected fetch.
 * @returns `{ ok: true, pr, payMsat }` or `{ ok: false, reason: 'unreachable' }`.
 */
export async function requestPayInvoice(args: RequestPayInvoiceArgs): Promise<LnurlPayResult> {
  const at = args.address.lastIndexOf('@');
  if (at <= 0 || at === args.address.length - 1) {
    return { ok: false, reason: 'unreachable' };
  }
  const name = args.address.slice(0, at);
  const domain = args.address.slice(at + 1);
  // Reject path-like domains so we never build a non-HTTPS or multi-path host.
  if (domain.includes('/')) {
    return { ok: false, reason: 'unreachable' };
  }

  const metadataUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const metadata = await fetchJson(args.fetchImpl, metadataUrl, lnurlpMetadataSchema);
  if (metadata === null) {
    return { ok: false, reason: 'unreachable' };
  }

  const commentAllowed = metadata.commentAllowed;
  if (commentAllowed === undefined || commentAllowed < args.comment.length) {
    return { ok: false, reason: 'unreachable' };
  }

  const payMsat = Math.max(args.amountMsat, metadata.minSendable);
  if (payMsat > VERIFICATION_AMOUNT_CAP_MSAT) {
    return { ok: false, reason: 'unreachable' };
  }

  // callback is schema-validated as a URL; amount/comment are LUD-06 / LUD-12.
  const callbackUrl = new URL(metadata.callback);
  callbackUrl.searchParams.set('amount', String(payMsat));
  callbackUrl.searchParams.set('comment', args.comment);

  const invoice = await fetchJson(args.fetchImpl, callbackUrl.toString(), lnurlpInvoiceSchema);
  if (invoice === null) {
    return { ok: false, reason: 'unreachable' };
  }

  return { ok: true, pr: invoice.pr, payMsat };
}

/**
 * GET `url`, parse JSON, and validate with `schema`. Any network, HTTP, JSON,
 * or schema failure yields `null` (mapped to `unreachable` by the caller).
 */
async function fetchJson<T>(
  fetchImpl: FetchFn,
  url: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetchImpl(url);
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
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
