/**
 * Resolves the identity an IP rate limiter should key on.
 *
 * The limiter key must be something the caller cannot freely choose. The only
 * value with that property is the transport peer address of the TCP connection
 * (Bun `server.requestIP(req)`). The `cf-connecting-ip` request header is
 * attacker-controlled on any connection that does not actually originate from
 * the trusted proxy, so it is trusted only when the transport peer is a known
 * proxy egress address (by default the published Cloudflare ranges); otherwise
 * the header is ignored and the peer address is used.
 *
 * {@link clientRateLimitKey} is the entry point for request handlers; the rest
 * of this module is the pure, unit-tested machinery behind it.
 *
 * The trusted-proxy allowlist is configured by the non-secret
 * `TRUSTED_PROXY_CIDRS` environment variable:
 *
 * - unset: the built-in {@link DEFAULT_CLOUDFLARE_CIDRS} are trusted;
 * - a comma-separated CIDR list: those ranges are trusted instead;
 * - `off`, `none`, or empty: no proxy is trusted and the header is never used.
 */

import { readClientRequestMeta } from '@/lib/request-meta';

/**
 * A parsed CIDR block, pre-computed for fast membership tests. `bits` is 32 for
 * IPv4 and 128 for IPv6; `network` is the masked base address and `mask` the
 * prefix mask, both as unsigned big integers of `bits` width.
 */
interface Cidr {
  readonly bits: number;
  readonly network: bigint;
  readonly mask: bigint;
}

/** A parsed IP address: its family width in `bits` and numeric `value`. */
interface IpBits {
  readonly bits: number;
  readonly value: bigint;
}

/**
 * Published Cloudflare edge egress ranges (IPv4 and IPv6), the documented
 * default trust anchor. Source: https://www.cloudflare.com/ips/. Override with
 * `TRUSTED_PROXY_CIDRS` for other proxies or to disable header trust entirely.
 */
const DEFAULT_CLOUDFLARE_CIDRS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** Prefix for keys derived from a header client IP forwarded by a trusted proxy. */
const TRUSTED_HEADER_KEY_PREFIX = 'ip:';
/** Prefix for keys derived from the raw transport peer address. */
const PEER_KEY_PREFIX = 'peer:';

function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBig(ip: string): bigint | null {
  if (ip.includes('%') || !/^[0-9a-fA-F:.]+$/.test(ip)) {
    return null;
  }
  let address = ip;
  // Fold an embedded IPv4 tail (e.g. "::ffff:1.2.3.4") into two hextets.
  if (address.includes('.')) {
    // Reached only from ipToBits, which calls this with a colon present, so
    // lastIndexOf(':') is always >= 0 here.
    const lastColon = address.lastIndexOf(':');
    const v4 = ipv4ToBig(address.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    const high = ((v4 >> 16n) & 0xffffn).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sides = address.split('::');
  if (sides.length > 2) {
    return null;
  }
  const head = sides[0] === '' || sides[0] === undefined ? [] : sides[0].split(':');
  let groups: string[];
  if (sides.length === 1) {
    groups = head;
  } else {
    const tail = sides[1] === '' || sides[1] === undefined ? [] : sides[1].split(':');
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return null;
    }
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) {
    return null;
  }
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null;
    }
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Parses an IPv4 or IPv6 literal into its numeric value and family width.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are reduced to their IPv4 form
 * so they match IPv4 trust ranges.
 *
 * @param ip - Address literal.
 * @returns The parsed address, or `null` when it is not a valid literal.
 */
function ipToBits(ip: string): IpBits | null {
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    const value = ipv6ToBig(trimmed);
    if (value === null) {
      return null;
    }
    // ::ffff:0:0/96 — an IPv4-mapped address; compare it as IPv4.
    if (value >> 32n === 0xffffn) {
      return { bits: 32, value: value & 0xffffffffn };
    }
    return { bits: 128, value };
  }
  const value = ipv4ToBig(trimmed);
  return value === null ? null : { bits: 32, value };
}

function maskFor(bits: number, prefix: number): bigint {
  const full = (1n << BigInt(bits)) - 1n;
  const hostBits = BigInt(bits - prefix);
  return (full << hostBits) & full;
}

/**
 * Parses a `address` or `address/prefix` CIDR string.
 *
 * @param spec - CIDR string; a bare address is treated as a host route.
 * @returns The parsed block, or `null` when it is malformed.
 */
function parseCidr(spec: string): Cidr | null {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf('/');
  const addrPart = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const ip = ipToBits(addrPart);
  if (ip === null) {
    return null;
  }
  let prefix: number;
  if (slash < 0) {
    prefix = ip.bits;
  } else {
    const rest = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(rest)) {
      return null;
    }
    prefix = Number(rest);
    if (prefix > ip.bits) {
      return null;
    }
  }
  const mask = maskFor(ip.bits, prefix);
  return { bits: ip.bits, network: ip.value & mask, mask };
}

function cidrContains(cidr: Cidr, ip: IpBits): boolean {
  return cidr.bits === ip.bits && (ip.value & cidr.mask) === cidr.network;
}

function resolveCidrSpecs(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return DEFAULT_CLOUDFLARE_CIDRS;
  }
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (trimmed === '' || lowered === 'off' || lowered === 'none') {
    return [];
  }
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Parses a CIDR allowlist spec into usable blocks, dropping malformed entries.
 *
 * @param raw - Raw `TRUSTED_PROXY_CIDRS` value, or `undefined` for the default.
 * @returns The trusted blocks.
 */
function parseTrustedProxyCidrs(raw: string | undefined): Cidr[] {
  const cidrs: Cidr[] = [];
  for (const spec of resolveCidrSpecs(raw)) {
    const cidr = parseCidr(spec);
    if (cidr !== null) {
      cidrs.push(cidr);
    }
  }
  return cidrs;
}

const DEFAULT_SPEC_KEY = '\u0000default';
const cidrCache = new Map<string, Cidr[]>();

/**
 * Returns the trusted-proxy allowlist for the given environment, memoized by
 * the raw `TRUSTED_PROXY_CIDRS` value so parsing happens at most once per spec.
 *
 * @param env - Environment variables.
 * @returns The trusted proxy CIDR blocks.
 */
function loadTrustedProxyCidrs(env: Record<string, string | undefined>): Cidr[] {
  const raw = env['TRUSTED_PROXY_CIDRS'];
  const key = raw === undefined ? DEFAULT_SPEC_KEY : raw;
  const cached = cidrCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseTrustedProxyCidrs(raw);
  cidrCache.set(key, parsed);
  return parsed;
}

function isTrustedProxyPeer(peer: IpBits, trusted: readonly Cidr[]): boolean {
  for (const cidr of trusted) {
    if (cidrContains(cidr, peer)) {
      return true;
    }
  }
  return false;
}

/** Transport peer address of a request, and whether the runtime exposes one. */
interface PeerAddress {
  /** `false` when the runtime has no peer lookup at all (e.g. a test harness). */
  readonly supported: boolean;
  /** The peer address literal, or `null` when unavailable. */
  readonly address: string | null;
}

/**
 * Reads the transport peer address from a Bun server object without assuming
 * its type (the Hono app runs with the default, untyped environment binding).
 *
 * Mirrors Hono's own Bun adapter: the server is `env.server` when present,
 * otherwise `env` itself (the second argument Bun passes to `fetch`).
 *
 * @param env - The value Hono exposes as `c.env`; under Bun this carries, or is,
 * the server object with `requestIP`.
 * @param req - The raw request.
 * @returns Whether a peer lookup exists and the address it returned.
 */
function extractPeerAddress(env: unknown, req: Request): PeerAddress {
  if (env === null || (typeof env !== 'object' && typeof env !== 'function')) {
    return { supported: false, address: null };
  }
  const server =
    'server' in (env as object) ? (env as { server: unknown }).server : (env as unknown);
  if (
    server === null ||
    (typeof server !== 'object' && typeof server !== 'function') ||
    typeof (server as { requestIP?: unknown }).requestIP !== 'function'
  ) {
    return { supported: false, address: null };
  }
  const lookup = (server as { requestIP: (r: Request) => unknown }).requestIP;
  const socket = lookup(req);
  if (
    socket !== null &&
    typeof socket === 'object' &&
    typeof (socket as { address?: unknown }).address === 'string'
  ) {
    const address = (socket as { address: string }).address;
    return { supported: true, address: address === '' ? null : address };
  }
  return { supported: true, address: null };
}

/**
 * Derives the rate-limit key from the transport peer and the (validated)
 * `cf-connecting-ip` header value.
 *
 * - When a peer address is present, the header is used only if the peer is a
 *   trusted proxy; otherwise the peer address is the key. This is the normal
 *   path under Bun, where a transport peer always exists.
 * - When the peer address is present but unreadable, the request is treated as
 *   unknown (`null`): it is not given an unlimited, uncounted allowance.
 * - When the runtime exposes no peer lookup at all (a non-Bun test harness),
 *   the validated header is used as a best effort since no transport identity
 *   is available; this branch cannot occur under `Bun.serve`.
 *
 * @param peer - Transport peer address and lookup support.
 * @param headerIp - Validated `cf-connecting-ip` value, or `null`.
 * @param trustedProxies - Trusted proxy egress ranges.
 * @returns A stable key, or `null` when the client cannot be identified.
 */
function resolveRateLimitKey(
  peer: PeerAddress,
  headerIp: string | null,
  trustedProxies: readonly Cidr[],
): string | null {
  if (!peer.supported) {
    return headerIp === null ? null : `${TRUSTED_HEADER_KEY_PREFIX}${headerIp}`;
  }
  if (peer.address === null) {
    return null;
  }
  const peerBits = ipToBits(peer.address);
  if (peerBits === null) {
    return null;
  }
  if (headerIp !== null && isTrustedProxyPeer(peerBits, trustedProxies)) {
    return `${TRUSTED_HEADER_KEY_PREFIX}${headerIp}`;
  }
  return `${PEER_KEY_PREFIX}${peer.address}`;
}

/** Minimal shape of a request handler context used by {@link clientRateLimitKey}. */
interface RateLimitContext {
  readonly env: unknown;
  readonly req: { readonly raw: Request };
}

/**
 * Resolves the per-client rate-limit key for a request handler.
 *
 * This replaces keying a limiter on the raw `cf-connecting-ip` header: it reads
 * the transport peer address and trusts the header only when that peer is a
 * configured trusted proxy. The returned key is opaque and must only be used as
 * a limiter bucket identifier, never echoed back as the client's IP.
 *
 * @param c - The request handler context (`c.env` is the Bun server, `c.req.raw`
 * the request). `env` is read for the trusted-proxy allowlist.
 * @param env - Environment variables; defaults to `process.env`.
 * @returns A stable key, or `null` when the client cannot be identified.
 */
export function clientRateLimitKey(
  c: RateLimitContext,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const peer = extractPeerAddress(c.env, c.req.raw);
  const headerIp = readClientRequestMeta(c.req.raw.headers).clientIp;
  return resolveRateLimitKey(peer, headerIp, loadTrustedProxyCidrs(env));
}
