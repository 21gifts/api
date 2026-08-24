import { z } from 'zod';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';

/**
 * LNURL-pay invoice fetch for gift amounts.
 *
 * Unlike verification's `requestPayInvoice`, this does not require a LUD-12
 * comment and does not apply the 10-sat verification cap. Amount must sit
 * inside the provider's minSendable/maxSendable — this function does not
 * raise the amount.
 */

/** Successful gift invoice fetch, or a collapsed failure. */
export type GiftInvoiceFetchResult =
  { ok: true; pr: string } | { ok: false; reason: 'unreachable' };

/** Arguments for {@link requestGiftInvoice}. */
export interface RequestGiftInvoiceArgs {
  /** Already-normalised LUD-16 address. */
  address: string;
  /** Amount in millisatoshis (spend sends the final amount). */
  amountMsat: number;
  /** Optional LUD-12 comment. Omitted from the callback when unset. */
  comment?: string;
  /** Injected `fetch`. */
  fetchImpl: FetchFn;
}

const lnurlpInvoiceSchema = z.object({
  pr: z.string().min(1),
});

/**
 * Resolve a LUD-16 address to a BOLT11 invoice for an exact millisat amount.
 *
 * @param args - Address, amount, optional comment, fetch.
 * @returns `{ ok: true, pr }` or `{ ok: false, reason: 'unreachable' }`.
 */
export async function requestGiftInvoice(
  args: RequestGiftInvoiceArgs,
): Promise<GiftInvoiceFetchResult> {
  const resolved = await resolveLnurlp({
    address: args.address,
    fetchImpl: args.fetchImpl,
  });
  if (!resolved.ok) {
    return { ok: false, reason: 'unreachable' };
  }
  const metadata = resolved.metadata;

  if (args.amountMsat < metadata.minSendable || args.amountMsat > metadata.maxSendable) {
    return { ok: false, reason: 'unreachable' };
  }

  if (args.comment !== undefined) {
    const allowed = metadata.commentAllowed;
    if (allowed === undefined || allowed < args.comment.length) {
      return { ok: false, reason: 'unreachable' };
    }
  }

  const callbackUrl = new URL(metadata.callback);
  callbackUrl.searchParams.set('amount', String(args.amountMsat));
  if (args.comment !== undefined) {
    callbackUrl.searchParams.set('comment', args.comment);
  }

  const invoice = await fetchJson(args.fetchImpl, callbackUrl.toString(), lnurlpInvoiceSchema);
  if (invoice === null) {
    return { ok: false, reason: 'unreachable' };
  }
  return { ok: true, pr: invoice.pr };
}

/**
 * GET `url`, parse JSON, validate with `schema`. Any failure yields `null`.
 *
 * @param fetchImpl - Injected fetch.
 * @param url - Absolute URL.
 * @param schema - Zod schema for the JSON body.
 * @returns Parsed value or `null`.
 */
async function fetchJson<T>(
  fetchImpl: FetchFn,
  url: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'error' });
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
