import { z } from 'zod';

/**
 * LUD-16 / LNURL-pay (LUD-06) well-known metadata resolve.
 *
 * Shared by public `GET /lightning-address` and verification's invoice
 * request so the HTTPS well-known fetch is not duplicated.
 */

/** Minimal fetch used by LNURL-pay (tests inject a stub). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** LNURL-pay metadata fields needed by callers (callback + amount bounds). */
export interface LnurlpMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
}

/** Successful metadata resolve, or a collapsed failure reason. */
export type ResolveLnurlpResult =
  { ok: true; metadata: LnurlpMetadata } | { ok: false; reason: 'unreachable' };

/** LNURL-pay metadata from `/.well-known/lnurlp/...`. */
const lnurlpMetadataSchema = z
  .object({
    callback: z.string().url(),
    minSendable: z.number().int().min(0),
    maxSendable: z.number().int().min(0),
    commentAllowed: z.number().int().optional(),
  })
  .refine((m) => m.maxSendable >= m.minSendable);

/**
 * Resolve a LUD-16 address to LNURL-pay metadata via the well-known endpoint.
 *
 * GETs `https://<domain>/.well-known/lnurlp/<name>` without following
 * redirects (`redirect: 'error'`). Any network, HTTP, JSON, schema, or
 * non-HTTPS callback failure collapses to `unreachable`.
 *
 * @param args - Address (`name@domain`) and injected fetch.
 * @returns Metadata on success, or `{ ok: false, reason: 'unreachable' }`.
 */
export async function resolveLnurlp(args: {
  address: string;
  fetchImpl: FetchFn;
}): Promise<ResolveLnurlpResult> {
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

  let response: Response;
  try {
    response = await args.fetchImpl(metadataUrl, { redirect: 'error' });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'unreachable' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  const parsed = lnurlpMetadataSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'unreachable' };
  }

  // callback is schema-validated as a URL; require https for the public resolve.
  const callbackUrl = new URL(parsed.data.callback);
  if (callbackUrl.protocol !== 'https:') {
    return { ok: false, reason: 'unreachable' };
  }

  const metadata: LnurlpMetadata = {
    callback: parsed.data.callback,
    minSendable: parsed.data.minSendable,
    maxSendable: parsed.data.maxSendable,
  };
  if (parsed.data.commentAllowed !== undefined) {
    metadata.commentAllowed = parsed.data.commentAllowed;
  }
  return { ok: true, metadata };
}
