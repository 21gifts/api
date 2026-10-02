/**
 * LNURL-pay relay for addresses on other hosts.
 *
 * Many LNURL servers send no CORS headers, so the app cannot read their pay
 * request or invoice from the browser. The api fetches both on the member's
 * behalf and validates them before returning them. Every outbound URL is
 * checked as input: `https`, a DNS name with at least two labels, no
 * address literal, no `localhost` / `.localhost` / `.local` / `.internal`,
 * no port, no credentials, and a name that resolves to public addresses
 * only. The relay waits at most {@link LNURL_RELAY_TIMEOUT_MS} for each host
 * lookup and each fetch; fetches do not follow redirects and read at most
 * {@link LNURL_RELAY_BODY_CAP_BYTES}.
 */

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { inspectBolt11 } from '@/lib/bolt11';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import { isPublicIp } from '@/lib/public-ip';

/** Longest wait for one host lookup or one outbound LNURL fetch (headers and body), in milliseconds. */
export const LNURL_RELAY_TIMEOUT_MS = 5_000;

/** Largest LNURL response body read, in bytes. */
export const LNURL_RELAY_BODY_CAP_BYTES = 64 * 1024;

/** Sliding window of the per-member relay limit. */
export const LNURL_RELAY_WINDOW_MS = 60_000;

/** Relay requests per member per {@link LNURL_RELAY_WINDOW_MS}. */
export const LNURL_RELAY_CAP = 30;

/** Longest target accepted, in UTF-16 code units, checked before parsing. */
export const LNURL_RELAY_TARGET_MAX_LENGTH = 2048;

/** Longest comment accepted, in UTF-16 code units, checked before any request. */
export const LNURL_RELAY_COMMENT_MAX_LENGTH = 2000;

/** 400 body for a target that cannot be paid through the relay. */
export const NOT_PAYABLE_ERROR = 'Not a payable address';

/** 404 body when the LNURL server does not know the address. */
export const NOT_FOUND_ERROR = 'Address not found';

/** 502 body when the LNURL server fails or answers with an invalid response. */
export const UNREACHABLE_ERROR = 'Address could not be reached';

/** 400 body for an amount outside the bounds or not a whole number of millisatoshis. */
export const AMOUNT_ERROR = 'Amount out of range';

/**
 * 400 body for a comment that is not a string, not well-formed Unicode, longer
 * than {@link LNURL_RELAY_COMMENT_MAX_LENGTH}, or longer than `commentAllowed`.
 */
export const COMMENT_ERROR = 'Comment too long';

/** Validated pay request returned to the app. */
export interface RelayPayRequest {
  /** Normalised target (lowercase address or lowercase bech32 LNURL). */
  target: string;
  /** Smallest amount in millisatoshis. */
  minSendableMsat: number;
  /** Largest amount in millisatoshis. */
  maxSendableMsat: number;
  /** Longest comment in characters; `0` when comments are not accepted. */
  commentAllowed: number;
  /** `text/plain` entry of the metadata, or an empty string. */
  description: string;
  /** Host that served the pay request. */
  domain: string;
}

/** Relay failure with the HTTP status and body the route returns. */
export interface RelayFailure {
  ok: false;
  status: 400 | 404 | 502;
  error: string;
  /** Short reason for the operator log (never the URL, comment, or invoice). */
  reason: string;
}

/** Collaborators of the relay calls. */
export interface RelayDeps {
  /** Injected fetch (tests supply a fake). */
  fetchImpl: FetchFn;
  /** Host of `PUBLIC_BASE_URL` (lowercase), or `null` when unset. */
  ownHost: string | null;
  /** Lookup and fetch timeout override (tests); defaults to {@link LNURL_RELAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Host name resolver (tests supply a fake); defaults to the system resolver. */
  lookupImpl?: RelayLookup | undefined;
}

/** Resolve a host name to its IP addresses. */
export type RelayLookup = (host: string) => Promise<string[]>;

/** Pay request plus the raw metadata needed to check the invoice. */
type LoadedPayRequest = {
  ok: true;
  payRequest: RelayPayRequest;
  callback: URL;
  metadata: string;
};

/** Outcome of one capped JSON fetch. */
type FetchedJson = { ok: true; body: unknown } | { ok: false; status: number | null };

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function fail(status: 400 | 404 | 502, error: string, reason: string): RelayFailure {
  return { ok: false, status, error, reason };
}

/**
 * Whether `host` is a DNS name the relay may fetch from.
 *
 * Expects a hostname already parsed by `URL` (IPv4 shorthands are then in
 * dotted form, IPv6 in brackets). Refuses address literals, `localhost`,
 * single labels, a trailing dot, and `.local` / `.internal` / `.localhost`
 * names.
 *
 * @param host - Lowercase hostname.
 * @returns `true` when the host is an outside DNS name.
 */
function isRelayDnsHost(host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 2) {
    return false;
  }
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return false;
  }
  const last = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(last)) {
    return false;
  }
  return !['localhost', 'local', 'internal'].includes(last);
}

/**
 * Decode a bech32 string (checksum and canonical padding verified; the caller
 * limits the length).
 *
 * @param raw - Lowercase bech32 string.
 * @returns Human-readable part and decoded bytes, or `null`.
 */
function bech32Decode(raw: string): { hrp: string; bytes: Uint8Array } | null {
  const sep = raw.lastIndexOf('1');
  if (sep < 1 || raw.length - sep < 7) {
    return null;
  }
  const hrp = raw.slice(0, sep);
  const words: number[] = [];
  for (const ch of raw.slice(sep + 1)) {
    const value = BECH32_CHARSET.indexOf(ch);
    if (value === -1) {
      return null;
    }
    words.push(value);
  }
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  const expanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
    ...words,
  ];
  for (const value of expanded) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    generators.forEach((g, i) => {
      if ((top >> i) & 1) {
        chk ^= g;
      }
    });
  }
  if (chk !== 1) {
    return null;
  }
  const data = words.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of data) {
    acc = (acc << 5) | word;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // Canonical padding only: fewer than 5 leftover bits, all zero.
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) {
    return null;
  }
  return { hrp, bytes: Uint8Array.from(bytes) };
}

/**
 * Parse and check one outbound URL.
 *
 * @param raw - URL text.
 * @param ownHost - Host of `PUBLIC_BASE_URL`, or `null`.
 * @returns The URL, or `null` when it is not an outside `https` URL.
 */
function outsideUrl(raw: string, ownHost: string | null): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!isRelayDnsHost(host)) {
    return null;
  }
  if (host === ownHost) {
    return null;
  }
  return url;
}

/**
 * Normalise a relay target and build its pay-request URL.
 *
 * Accepts a Lightning Address (`name@domain`) or a bech32 `lnurl1…` string,
 * each with an optional `lightning:` prefix. The URL must be an outside
 * `https` URL ({@link isRelayDnsHost}) and not on `ownHost`.
 *
 * @param raw - Target from the request body.
 * @param ownHost - Host of `PUBLIC_BASE_URL`, or `null`.
 * @returns Normalised target and URL, or `null` when not payable here.
 */
function parseRelayTarget(
  raw: string,
  ownHost: string | null,
): { target: string; url: URL } | null {
  if (raw.length > LNURL_RELAY_TARGET_MAX_LENGTH) {
    return null;
  }
  let text = raw.trim().toLowerCase();
  if (text.startsWith('lightning:')) {
    text = text.slice('lightning:'.length);
  }
  if (text.includes('@')) {
    const address = normalizeLightningAddress(text);
    if (address === null) {
      return null;
    }
    const at = address.lastIndexOf('@');
    const name = address.slice(0, at);
    const domain = address.slice(at + 1);
    // A name of only dots would turn the well-known path into a parent path.
    if (/^\.+$/.test(name)) {
      return null;
    }
    const url = outsideUrl(
      `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
      ownHost,
    );
    return url === null ? null : { target: address, url };
  }
  const decoded = bech32Decode(text);
  if (decoded === null || decoded.hrp !== 'lnurl') {
    return null;
  }
  let decodedUrl: string;
  try {
    decodedUrl = new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes);
  } catch {
    return null;
  }
  const url = outsideUrl(decodedUrl, ownHost);
  return url === null ? null : { target: text, url };
}

/**
 * Resolve `host` with the system resolver.
 *
 * @param host - DNS name.
 * @returns Every address the name resolves to.
 */
async function systemLookup(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Whether the relay may connect to one resolved address.
 *
 * The address must pass {@link isPublicIp}. An IPv6 answer must also lie in
 * global unicast `2000::/3` or the well-known NAT64 prefix `64:ff9b::/96`.
 *
 * @param ip - Address text from the resolver.
 * @returns `true` when the relay may connect.
 */
function isRelayAddress(ip: string): boolean {
  if (!isPublicIp(ip)) {
    return false;
  }
  const lower = ip.trim().toLowerCase();
  return (
    !lower.includes(':') ||
    /^[23][0-9a-f]{3}:/.test(lower) ||
    /^64:ff9b::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(lower) ||
    /^64:ff9b(?::0{1,4}){4}(?::[0-9a-f]{1,4}){2}$/.test(lower)
  );
}

/**
 * Resolve the URL's host and require public addresses only.
 *
 * The relay waits for the lookup no longer than the fetch time limit; an
 * answer that does not arrive in time counts as `unresolved`. The system
 * resolver may still finish the lookup in the background.
 *
 * @param url - Checked outbound URL.
 * @param deps - Resolver and timeout.
 * @returns `ok`, `private` (some address is not public), or `unresolved`.
 */
async function hostAddresses(url: URL, deps: RelayDeps): Promise<'ok' | 'private' | 'unresolved'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? LNURL_RELAY_TIMEOUT_MS);
  });
  let addresses: string[] | null;
  try {
    addresses = await Promise.race([(deps.lookupImpl ?? systemLookup)(url.hostname), late]);
  } catch {
    addresses = null;
  }
  clearTimeout(timer);
  if (addresses === null || addresses.length === 0) {
    return 'unresolved';
  }
  return addresses.every(isRelayAddress) ? 'ok' : 'private';
}

/**
 * Read a response body up to `cap` bytes.
 *
 * @param response - Fetch response.
 * @param cap - Byte cap.
 * @returns The body text, or `null` when it is larger than `cap`.
 */
async function readCapped(response: Response, cap: number): Promise<string | null> {
  if (Number(response.headers.get('content-length') ?? '0') > cap) {
    return null;
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * GET `url` without redirects, with timeout and body cap, and parse JSON.
 *
 * The request is aborted when the status is not 2xx or the body is too
 * large, so an unread body does not keep the connection busy.
 *
 * @param url - Checked outbound URL.
 * @param deps - Fetch and timeout.
 * @returns Parsed body, or the HTTP status (`null` for network, size, or JSON failure).
 */
async function fetchRelayJson(url: URL, deps: RelayDeps): Promise<FetchedJson> {
  const done = new AbortController();
  const result = await fetchAndParse(url, deps, done.signal);
  done.abort();
  return result;
}

/**
 * One GET for {@link fetchRelayJson}; the caller aborts `stop` afterwards.
 *
 * @param url - Checked outbound URL.
 * @param deps - Fetch and timeout.
 * @param stop - Signal the caller aborts once the result is known.
 * @returns Parsed body, or the HTTP status (`null` for network, size, or JSON failure).
 */
async function fetchAndParse(url: URL, deps: RelayDeps, stop: AbortSignal): Promise<FetchedJson> {
  try {
    const response = await deps.fetchImpl(url.toString(), {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([
        stop,
        AbortSignal.timeout(deps.timeoutMs ?? LNURL_RELAY_TIMEOUT_MS),
      ]),
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status };
    }
    const text = await readCapped(response, LNURL_RELAY_BODY_CAP_BYTES);
    if (text === null) {
      return { ok: false, status: null };
    }
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: null };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLnurlError(body: Record<string, unknown>): boolean {
  return typeof body['status'] === 'string' && body['status'].toUpperCase() === 'ERROR';
}

/**
 * `text/plain` entry of LUD-06 metadata, or an empty string.
 *
 * @param metadata - Metadata JSON string.
 * @returns Description text.
 */
function plainDescription(metadata: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed)) {
    return '';
  }
  for (const entry of parsed) {
    if (Array.isArray(entry) && entry[0] === 'text/plain' && typeof entry[1] === 'string') {
      return entry[1];
    }
  }
  return '';
}

/**
 * Load and validate the pay request for `rawTarget`.
 *
 * @param rawTarget - Target from the request body.
 * @param deps - Fetch, own host, timeout.
 * @returns Pay request with callback and metadata, or a failure.
 */
async function loadPayRequest(
  rawTarget: string,
  deps: RelayDeps,
): Promise<LoadedPayRequest | RelayFailure> {
  const parsed = parseRelayTarget(rawTarget, deps.ownHost);
  if (parsed === null) {
    return fail(400, NOT_PAYABLE_ERROR, 'target');
  }
  const domain = parsed.url.hostname.toLowerCase();
  const targetHost = await hostAddresses(parsed.url, deps);
  if (targetHost === 'private') {
    return fail(400, NOT_PAYABLE_ERROR, 'address');
  }
  if (targetHost === 'unresolved') {
    return fail(502, UNREACHABLE_ERROR, 'dns');
  }
  const fetched = await fetchRelayJson(parsed.url, deps);
  if (!fetched.ok) {
    if (fetched.status === 404 || fetched.status === 410) {
      return fail(404, NOT_FOUND_ERROR, 'not_found');
    }
    return fail(502, UNREACHABLE_ERROR, fetched.status === null ? 'fetch' : 'status');
  }
  const body = fetched.body;
  if (!isRecord(body)) {
    return fail(502, UNREACHABLE_ERROR, 'shape');
  }
  if (isLnurlError(body)) {
    return fail(404, NOT_FOUND_ERROR, 'lnurl_error');
  }
  const { tag, callback, metadata, minSendable, maxSendable, commentAllowed } = body;
  if (tag !== 'payRequest' || typeof callback !== 'string' || typeof metadata !== 'string') {
    return fail(400, NOT_PAYABLE_ERROR, 'shape');
  }
  if (
    typeof minSendable !== 'number' ||
    typeof maxSendable !== 'number' ||
    !Number.isSafeInteger(minSendable) ||
    !Number.isSafeInteger(maxSendable) ||
    minSendable < 1 ||
    maxSendable < minSendable
  ) {
    return fail(400, NOT_PAYABLE_ERROR, 'bounds');
  }
  let allowed = 0;
  if (commentAllowed !== undefined && commentAllowed !== null) {
    if (
      typeof commentAllowed !== 'number' ||
      !Number.isSafeInteger(commentAllowed) ||
      commentAllowed < 0
    ) {
      return fail(400, NOT_PAYABLE_ERROR, 'comment_allowed');
    }
    allowed = commentAllowed;
  }
  const callbackUrl = outsideUrl(callback, deps.ownHost);
  if (callbackUrl === null) {
    return fail(400, NOT_PAYABLE_ERROR, 'callback');
  }
  const callbackHost = await hostAddresses(callbackUrl, deps);
  if (callbackHost === 'private') {
    return fail(400, NOT_PAYABLE_ERROR, 'callback_address');
  }
  if (callbackHost === 'unresolved') {
    return fail(502, UNREACHABLE_ERROR, 'callback_dns');
  }
  return {
    ok: true,
    payRequest: {
      target: parsed.target,
      minSendableMsat: minSendable,
      maxSendableMsat: maxSendable,
      commentAllowed: allowed,
      description: plainDescription(metadata),
      domain,
    },
    callback: callbackUrl,
    metadata,
  };
}

/**
 * Fetch and validate the LNURL pay request of an outside target.
 *
 * @param args - Raw target plus fetch, own host, optional timeout, and optional resolver.
 * @returns `{ ok: true, payRequest }` or a {@link RelayFailure}.
 */
export async function resolveRelayPayRequest(
  args: RelayDeps & { target: string },
): Promise<{ ok: true; payRequest: RelayPayRequest } | RelayFailure> {
  const loaded = await loadPayRequest(args.target, args);
  if (!loaded.ok) {
    return loaded;
  }
  return { ok: true, payRequest: loaded.payRequest };
}

/**
 * Resolve the target again, check amount and comment, and fetch a BOLT11.
 *
 * The invoice must decode to exactly `amountMsat` and carry a description
 * hash equal to SHA-256 of the pay request's metadata.
 *
 * @param args - Raw target, amount, optional comment, plus fetch, own host, optional timeout, and optional resolver.
 * @returns `{ ok: true, pr }` or a {@link RelayFailure}.
 */
export async function requestRelayInvoice(
  args: RelayDeps & { target: string; amountMsat: number; comment?: string },
): Promise<{ ok: true; pr: string } | RelayFailure> {
  // A non-whole amount is refused before any outbound request.
  if (!Number.isSafeInteger(args.amountMsat)) {
    return fail(400, AMOUNT_ERROR, 'amount');
  }
  // An oversized comment, or one that is not well-formed Unicode (a lone
  // surrogate), is refused before any outbound request.
  if (
    args.comment !== undefined &&
    (args.comment.length > LNURL_RELAY_COMMENT_MAX_LENGTH || /\p{Surrogate}/u.test(args.comment))
  ) {
    return fail(400, COMMENT_ERROR, 'comment');
  }
  const loaded = await loadPayRequest(args.target, args);
  if (!loaded.ok) {
    return loaded;
  }
  const { payRequest, callback, metadata } = loaded;
  if (
    args.amountMsat < payRequest.minSendableMsat ||
    args.amountMsat > payRequest.maxSendableMsat
  ) {
    return fail(400, AMOUNT_ERROR, 'amount');
  }
  const comment = args.comment ?? '';
  if ([...comment].length > payRequest.commentAllowed) {
    return fail(400, COMMENT_ERROR, 'comment');
  }
  // LUD-06: append to the callback's query as received, without re-encoding it.
  const extra = [`amount=${args.amountMsat}`];
  if (comment !== '') {
    extra.push(`comment=${encodeURIComponent(comment)}`);
  }
  const invoiceUrl = new URL(callback);
  invoiceUrl.search =
    invoiceUrl.search === '' ? `?${extra.join('&')}` : `${invoiceUrl.search}&${extra.join('&')}`;
  const fetched = await fetchRelayJson(invoiceUrl, args);
  if (!fetched.ok) {
    return fail(
      502,
      UNREACHABLE_ERROR,
      fetched.status === null ? 'invoice_fetch' : 'invoice_status',
    );
  }
  const body = fetched.body;
  if (!isRecord(body) || isLnurlError(body) || typeof body['pr'] !== 'string') {
    return fail(502, UNREACHABLE_ERROR, 'invoice_shape');
  }
  const pr = body['pr'];
  const inspected = inspectBolt11(pr);
  if (inspected === null || inspected.amountMsat !== args.amountMsat) {
    return fail(502, UNREACHABLE_ERROR, 'invoice_amount');
  }
  const expected = createHash('sha256').update(metadata, 'utf8').digest('hex');
  if (inspected.descriptionHash !== expected) {
    return fail(502, UNREACHABLE_ERROR, 'invoice_description');
  }
  return { ok: true, pr };
}

/**
 * In-process per-member limit for the relay routes ({@link LNURL_RELAY_CAP}
 * per sliding {@link LNURL_RELAY_WINDOW_MS}). Idle members are evicted.
 * Single-process only.
 */
export class LnurlRelayRateLimiter {
  readonly #byAccount = new Map<string, number[]>();

  /**
   * Check and record one relay request.
   *
   * @param accountId - Account id.
   * @param nowMs - Current time (epoch ms).
   * @returns `true` when allowed; `false` when over the limit (not recorded).
   */
  allow(accountId: string, nowMs: number): boolean {
    for (const [id, hits] of this.#byAccount) {
      if (hits.every((t) => nowMs - t >= LNURL_RELAY_WINDOW_MS)) {
        this.#byAccount.delete(id);
      }
    }
    const hits = (this.#byAccount.get(accountId) ?? []).filter(
      (t) => nowMs - t < LNURL_RELAY_WINDOW_MS,
    );
    if (hits.length >= LNURL_RELAY_CAP) {
      return false;
    }
    hits.push(nowMs);
    this.#byAccount.set(accountId, hits);
    return true;
  }
}
