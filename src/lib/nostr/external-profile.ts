/**
 * Public profile for a forum author who has no 21.gifts account.
 *
 * The hex pubkey stays on the row. Callers receive a name, an npub, and
 * only those kind:0 strings that pass the checks below.
 */

import { lookup } from 'node:dns/promises';
import { npubEncode } from 'nostr-tools/nip19';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { truncatePubkeyDisplay, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import {
  externalDisplayName,
  resolveExternalProfileFields,
  type ExternalProfileFields,
} from '@/lib/nostr/external';
import type { NostrQuerier } from '@/lib/nostr/query';
import { resolveZapReadRelays } from '@/lib/nostr/relays';
import { RELAY_TIMEOUT_MS } from '@/lib/nostr/worker';

/** One DNS label that is not an IP. */
const NIP05_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/** `user@host` with a dotted hostname. An IP literal fails {@link hostBlocked}. */
const NIP05_ADDRESS_RE = new RegExp(
  `^[a-z0-9._-]{1,64}@${NIP05_LABEL}(?:\\.${NIP05_LABEL})+$`,
  'i',
);

const NIP05_BODY_CAP = 65_536;
const NIP05_TIMEOUT_MS = 5_000;
const NIP05_MAX_REDIRECTS = 2;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

/** Collaborators for {@link publicExternalAuthorProfile}. */
export interface ExternalAuthorProfileDeps {
  /** Forum rows and zapper entitlement. */
  store: MessageStore;
  /** Member names, used only to reject a live name that collides with one. */
  authStore: AuthStore;
  /** Clock for the kind:0 cache. Epoch milliseconds. */
  now: () => number;
  /** Well-known fetch. Omitted → nip05 is left off. Never falls back to global fetch. */
  fetchImpl?: FetchFn;
  /** Relay env when `nostrRelayUrls` is omitted. */
  env?: Record<string, string | undefined>;
  /** Kind:0 querier. Omitted → stored name and npub only. */
  nostrQuerier?: NostrQuerier;
  /** Relay URLs for that querier. Omitted → {@link resolveZapReadRelays}. */
  nostrRelayUrls?: readonly string[];
  /**
   * DNS lookup. Tests inject this. Production resolves A/AAAA and rejects
   * any answer that is not a public address.
   */
  lookupHost?: (hostname: string) => Promise<readonly string[]>;
}

/** JSON body of a public external-author profile. Unknown keys are never added. */
export interface ExternalAuthorProfileBody {
  /** Live kind:0 name when it is safe, otherwise the stored snapshot. */
  name: string;
  /** bech32 npub of the stored author pubkey. */
  npub: string;
  /** NIP-05 identifier whose well-known document names this pubkey. */
  nip05?: string;
  /** Published lightning address. Not fetched and not a payment promise. */
  lud16?: string;
}

/** 200 profile, or a terminal status the route maps to the public error JSON. */
export type ExternalAuthorProfileResult =
  { status: 200; body: ExternalAuthorProfileBody } | { status: 404 } | { status: 503 };

/**
 * Build the public profile for one forum message.
 *
 * 404 when the id is not a UUID, the row is missing, deleted (including a
 * staff caller), withheld from the public read, not an external author, or
 * the pubkey is not 64 hex. Store and account throws are 503. A relay or
 * well-known failure keeps the 200 and drops only the field that failed.
 *
 * @param deps - Store, clock, and optional querier / fetch / DNS.
 * @param id - Path message id.
 * @returns Status and, on 200, the profile body.
 */
export async function publicExternalAuthorProfile(
  deps: ExternalAuthorProfileDeps,
  id: string,
): Promise<ExternalAuthorProfileResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { status: 404 };
  }
  try {
    const row = await deps.store.getById(id);
    if (row === undefined || row.deletedAt !== null) {
      return { status: 404 };
    }
    if (await withheldExternal(deps, row)) {
      return { status: 404 };
    }
    if (row.accountId !== null || row.authorPubkey === null || !PUBKEY_RE.test(row.authorPubkey)) {
      return { status: 404 };
    }
    const pubkey = row.authorPubkey.toLowerCase();
    const live = await liveFields(deps, pubkey);
    const accountNames =
      live?.displayName === null || live?.displayName === undefined
        ? []
        : await memberNames(deps.authStore);
    const body: ExternalAuthorProfileBody = {
      name: displayedName(row.name, pubkey, live?.displayName ?? null, accountNames),
      npub: npubEncode(pubkey),
    };
    const nip05 = await confirmedNip05(deps, live?.nip05 ?? null, pubkey);
    if (nip05 !== null) {
      body.nip05 = nip05;
    }
    const lud16 = publishedLud16(live?.lud16 ?? null);
    if (lud16 !== null) {
      body.lud16 = lud16;
    }
    return { status: 200, body };
  } catch {
    logEvent('messages.external_profile.failed');
    return { status: 503 };
  }
}

/**
 * Same public gate as `GET /messages/:id` for a live row: a reply with no
 * account is public only while its pubkey is a recorded zapper.
 *
 * @param deps - Message store.
 * @param row - Live row (`deletedAt` already excluded).
 * @returns `true` when the profile must be 404.
 */
async function withheldExternal(
  deps: ExternalAuthorProfileDeps,
  row: MessageRow,
): Promise<boolean> {
  if (row.parentId === null || row.accountId !== null) {
    return false;
  }
  return row.authorPubkey === null || !(await deps.store.isZapperPubkey(row.authorPubkey));
}

/**
 * Kind:0 fields, or `null` when the querier or the relay list is absent.
 * The resolver itself swallows relay errors.
 *
 * @param deps - Optional querier and relay list.
 * @param pubkey - Lowercase author pubkey.
 * @returns Profile fields, or `null`.
 */
async function liveFields(
  deps: ExternalAuthorProfileDeps,
  pubkey: string,
): Promise<ExternalProfileFields | null> {
  if (deps.nostrQuerier === undefined) {
    return null;
  }
  const urls = deps.nostrRelayUrls ?? resolveZapReadRelays(deps.env ?? {});
  if (urls.length === 0) {
    return null;
  }
  return resolveExternalProfileFields({
    querier: deps.nostrQuerier,
    urls,
    pubkey,
    nowMs: deps.now(),
    timeoutMs: RELAY_TIMEOUT_MS,
  });
}

/**
 * Non-empty member display names.
 *
 * @param authStore - Account list.
 * @returns Names that {@link externalDisplayName} must not collide with.
 */
async function memberNames(authStore: AuthStore): Promise<string[]> {
  const accounts = await authStore.listAccounts();
  const names: string[] = [];
  for (const account of accounts) {
    if (typeof account.name === 'string' && account.name.trim() !== '') {
      names.push(account.name);
    }
  }
  return names;
}

/**
 * Prefer a live kind:0 name only when {@link externalDisplayName} accepts it.
 * Otherwise keep the stored snapshot, or a truncated pubkey when that is empty.
 *
 * @param storedName - Name on the forum row.
 * @param pubkey - Lowercase author pubkey.
 * @param liveName - Trimmed kind:0 display name, or `null`.
 * @param accountNames - Current member names.
 * @returns The name to publish.
 */
function displayedName(
  storedName: string,
  pubkey: string,
  liveName: string | null,
  accountNames: readonly string[],
): string {
  const stored = storedName.trim();
  const fallback = stored === '' ? truncatePubkeyDisplay(pubkey) : stored;
  if (liveName === null) {
    return fallback;
  }
  /* v8 ignore next 3 -- kind:0 display names are null or already non-empty */
  if (liveName.trim() === '') {
    return fallback;
  }
  const safe = externalDisplayName({ profileName: liveName, pubkey, accountNames });
  if (safe === truncatePubkeyDisplay(pubkey)) {
    return fallback;
  }
  return safe;
}

/**
 * Lightning address as published on the profile. Pattern only; no HTTP.
 *
 * @param raw - Kind:0 `lud16`, or `null`.
 * @returns The address, or `null` when it is not `user@host`.
 */
function publishedLud16(raw: string | null): string | null {
  if (raw === null || !NIP05_ADDRESS_RE.test(raw) || splitAddress(raw) === null) {
    return null;
  }
  return raw;
}

/**
 * NIP-05 when the well-known document names `pubkey`. Any failure omits it.
 *
 * @param deps - Fetch and DNS. Missing fetch omits the field.
 * @param raw - Kind:0 `nip05`, or `null`.
 * @param pubkey - Lowercase author pubkey.
 * @returns The original address, or `null`.
 */
async function confirmedNip05(
  deps: ExternalAuthorProfileDeps,
  raw: string | null,
  pubkey: string,
): Promise<string | null> {
  if (raw === null || deps.fetchImpl === undefined) {
    return null;
  }
  const parts = splitAddress(raw);
  if (parts === null) {
    return null;
  }
  const text = await readNostrJson(deps.fetchImpl, deps.lookupHost ?? defaultLookupHost, parts);
  if (text === null || !documentNamesPubkey(text, parts.local, pubkey)) {
    return null;
  }
  return raw;
}

/**
 * Split a `user@host` that is not an IP, localhost, or a link-local name.
 *
 * @param value - Candidate address.
 * @returns Lowercase local-part and host, or `null`.
 */
function splitAddress(value: string): { local: string; host: string } | null {
  if (!NIP05_ADDRESS_RE.test(value)) {
    return null;
  }
  const at = value.lastIndexOf('@');
  const host = value.slice(at + 1).toLowerCase();
  if (hostBlocked(host)) {
    return null;
  }
  return { local: value.slice(0, at).toLowerCase(), host };
}

/**
 * Hosts that must never be fetched, including names the address pattern still accepts.
 *
 * @param host - Lowercase hostname.
 * @returns `true` when the host is blocked before DNS.
 */
function hostBlocked(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return (
    name === '' ||
    name === 'localhost' ||
    name === 'metadata.google.internal' ||
    name.endsWith('.local') ||
    name.endsWith('.localhost') ||
    name.includes(':') ||
    parseIpv4(name) !== null
  );
}

/**
 * Follow at most two HTTPS redirects. DNS must be public before every request.
 *
 * @param fetchImpl - Injected fetch.
 * @param lookupHost - Injected DNS.
 * @param parts - Lowercase local-part and host.
 * @returns Document text, or `null`.
 */
async function readNostrJson(
  fetchImpl: FetchFn,
  lookupHost: (hostname: string) => Promise<readonly string[]>,
  parts: { local: string; host: string },
): Promise<string | null> {
  let current: URL;
  /* v8 ignore start -- splitAddress only yields a host the URL parser accepts */
  try {
    current = new URL(
      `https://${parts.host}/.well-known/nostr.json?name=${encodeURIComponent(parts.local)}`,
    );
  } catch {
    return null;
  }
  /* v8 ignore stop */
  for (let followed = 0; followed <= NIP05_MAX_REDIRECTS; followed += 1) {
    if (current.protocol !== 'https:' || !(await hostIsPublic(current.hostname, lookupHost))) {
      return null;
    }
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(NIP05_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch {
      return null;
    }
    if (isRedirect(response.status)) {
      if (followed < NIP05_MAX_REDIRECTS) {
        const location = response.headers.get('location');
        if (location === null || location.trim() === '') {
          return null;
        }
        try {
          current = new URL(location, current);
        } catch {
          return null;
        }
        continue;
      }
      // The next loop test fails; the function returns null without another fetch.
    } else {
      if (!response.ok) {
        return null;
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > NIP05_BODY_CAP) {
        return null;
      }
      try {
        const text = await response.text();
        return text.length > NIP05_BODY_CAP ? null : text;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * @param status - HTTP status.
 * @returns `true` for the redirect statuses this lookup follows.
 */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * @param text - `nostr.json` body.
 * @param local - Lowercase local-part.
 * @param pubkey - Lowercase author pubkey.
 * @returns `true` when `names[local]` is that pubkey.
 */
function documentNamesPubkey(text: string, local: string, pubkey: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const names = (parsed as { names?: unknown }).names;
    if (names === null || typeof names !== 'object' || Array.isArray(names)) {
      return false;
    }
    const value = (names as Record<string, unknown>)[local];
    return typeof value === 'string' && value.toLowerCase() === pubkey;
  } catch {
    return false;
  }
}

/**
 * Resolve `hostname` and require every address to be public.
 *
 * @param hostname - URL hostname.
 * @param lookupHost - DNS.
 * @returns `false` when lookup fails or any address is not public.
 */
async function hostIsPublic(
  hostname: string,
  lookupHost: (hostname: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (hostBlocked(hostname.toLowerCase())) {
    return false;
  }
  let addresses: readonly string[];
  try {
    addresses = await lookupHost(hostname);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((address) => isPublicIp(address));
}

/**
 * Production DNS. One failed family fails the whole lookup (`node:dns` throws).
 *
 * @param hostname - Hostname from the well-known URL.
 * @returns Address strings.
 */
async function defaultLookupHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * @param address - DNS answer.
 * @returns `true` when the address is a public unicast IP.
 */
function isPublicIp(address: string): boolean {
  const value = address.trim().toLowerCase();
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) {
    return !isNonPublicIpv4(ipv4);
  }
  const mapped = mappedIpv4(value);
  if (mapped !== null) {
    return !isNonPublicIpv4(mapped);
  }
  if (!value.includes(':')) {
    return false;
  }
  return isPublicIpv6(value);
}

/**
 * @param address - Candidate IPv4.
 * @returns Four octets, or `null` when it is not a canonical dotted quad.
 */
function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Ranges the profile lookup must not contact.
 *
 * @param octets - Parsed IPv4.
 * @returns `true` for the blocked ranges.
 */
function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 192 && b === 0 && c === 2) {
    return true;
  }
  if (a === 198 && b === 51 && c === 100) {
    return true;
  }
  return a === 203 && b === 0 && c === 113;
}

/**
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d` and the hex form).
 *
 * @param address - Lowercase address.
 * @returns The embedded IPv4, or `null`.
 */
function mappedIpv4(address: string): [number, number, number, number] | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted !== null) {
    return parseIpv4(dotted[1]!);
  }
  const short = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (short !== null) {
    return ipv4FromHalves(parseInt(short[1]!, 16), parseInt(short[2]!, 16));
  }
  const groups = expandIpv6(address);
  if (
    groups === null ||
    groups[0] !== 0 ||
    groups[1] !== 0 ||
    groups[2] !== 0 ||
    groups[3] !== 0 ||
    groups[4] !== 0 ||
    groups[5] !== 0xffff
  ) {
    return null;
  }
  return ipv4FromHalves(groups[6]!, groups[7]!);
}

/**
 * @param hi - High 16 bits.
 * @param lo - Low 16 bits.
 * @returns Four octets.
 */
function ipv4FromHalves(hi: number, lo: number): [number, number, number, number] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/**
 * @param address - IPv6 text without a zone id.
 * @returns Eight groups, or `null`.
 */
function expandIpv6(address: string): number[] | null {
  if (address.includes('.')) {
    return null;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (side: string): number[] | null => {
    if (side === '') {
      return [];
    }
    const groups: number[] = [];
    for (const part of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      groups.push(parseInt(part, 16));
    }
    return groups;
  };
  const left = parseSide(halves[0]!);
  if (left === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1]!);
  if (right === null) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * @param address - IPv6 text.
 * @returns `false` for unspecified, loopback, unique-local, link-local, and multicast.
 */
function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (groups === null) {
    return false;
  }
  if (groups.every((group) => group === 0)) {
    return false;
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return false;
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) {
    return false;
  }
  if ((first & 0xffc0) === 0xfe80) {
    return false;
  }
  return (first & 0xff00) !== 0xff00;
}
