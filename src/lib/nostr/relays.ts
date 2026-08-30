/**
 * Resolve the Nostr write set from environment helpers.
 *
 * `NOSTR_PUBLISH=1` gates WebSocket fan-out. `NOSTR_PUBLISH_PUBLIC=1` adds
 * Damus / Primal-operated / nos.lol. Space is always the durability target
 * when publishing.
 */

/** Default PRD durability relay. */
export const DEFAULT_RELAY_SPACE_PRD = 'wss://relay.nostr.space';

/** Default DEV durability relay. */
export const DEFAULT_RELAY_SPACE_DEV = 'wss://dev-relay.nostr.space';

/** Default public write relays (viral). */
export const DEFAULT_RELAY_PUBLIC: readonly string[] = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
];

/** Resolved write-set for one worker tick. */
export interface ResolvedWriteSet {
  /** Durability relay (nostr.space or DEV substitute). */
  spaceUrl: string;
  /** Public viral relays when `NOSTR_PUBLISH_PUBLIC=1`; otherwise empty. */
  publicUrls: string[];
  /** Whether WebSocket fan-out is enabled. */
  publishEnabled: boolean;
  /** Whether public relays are intended this tick. */
  publicEnabled: boolean;
}

/**
 * Whether `NOSTR_PUBLISH` enables WebSocket fan-out.
 *
 * @param env - Environment slice.
 * @returns `true` only when the value is exactly `"1"`.
 */
export function isNostrPublishEnabled(env: Record<string, string | undefined>): boolean {
  return env['NOSTR_PUBLISH'] === '1';
}

/**
 * Whether `NOSTR_PUBLISH_PUBLIC` adds public write relays.
 *
 * @param env - Environment slice.
 * @returns `true` only when the value is exactly `"1"`.
 */
export function isNostrPublishPublicEnabled(env: Record<string, string | undefined>): boolean {
  return env['NOSTR_PUBLISH_PUBLIC'] === '1';
}

/**
 * Resolve the durability (space) relay URL.
 *
 * Prefers `NOSTR_RELAY_SPACE`, then the existing compose name
 * `NOSTR_RELAY_URL`, then the PRD nostr.space default.
 *
 * @param env - Environment slice.
 * @returns Trimmed relay WebSocket URL.
 */
export function resolveRelaySpace(env: Record<string, string | undefined>): string {
  for (const key of ['NOSTR_RELAY_SPACE', 'NOSTR_RELAY_URL'] as const) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return DEFAULT_RELAY_SPACE_PRD;
}

/**
 * Resolve the public write relay list.
 *
 * @param env - Environment slice.
 * @returns Comma-separated `NOSTR_RELAY_PUBLIC` entries, or the default three.
 */
export function resolveRelayPublic(env: Record<string, string | undefined>): string[] {
  const raw = env['NOSTR_RELAY_PUBLIC'];
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_RELAY_PUBLIC];
  }
  return raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
}

/**
 * Resolve the full write set for the current env.
 *
 * @param env - Environment slice.
 * @returns Space URL, public URLs (empty when public off), and flags.
 */
export function resolveWriteSet(env: Record<string, string | undefined>): ResolvedWriteSet {
  const publishEnabled = isNostrPublishEnabled(env);
  const publicEnabled = isNostrPublishPublicEnabled(env);
  const spaceUrl = resolveRelaySpace(env);
  const publicUrls = publicEnabled ? resolveRelayPublic(env) : [];
  return { spaceUrl, publicUrls, publishEnabled, publicEnabled };
}

/**
 * Resolve relays for zap ingest and kind:9734 invoice `relays` tags.
 *
 * Always space plus the public list, independent of `NOSTR_PUBLISH` /
 * `NOSTR_PUBLISH_PUBLIC`.
 *
 * @param env - Environment slice.
 * @returns Space first, then unique public URLs.
 */
export function resolveZapRelays(env: Record<string, string | undefined>): string[] {
  const spaceUrl = resolveRelaySpace(env);
  const seen = new Set<string>([spaceUrl]);
  const urls = [spaceUrl];
  for (const url of resolveRelayPublic(env)) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * URLs the worker writes kind:0 / kind:1 / kind:10002 to this tick.
 *
 * @param writeSet - Resolved flags and relays.
 * @returns Space, plus public URLs when public write is on.
 */
export function writeRelayUrls(writeSet: ResolvedWriteSet): string[] {
  return writeSet.publicEnabled ? [writeSet.spaceUrl, ...writeSet.publicUrls] : [writeSet.spaceUrl];
}

/**
 * Public HTTP origin for photo URLs in kind:1.
 *
 * Maps the site `PUBLIC_BASE_URL` to the API host. Tests that point
 * `PUBLIC_BASE_URL` at the API itself keep that origin.
 *
 * @param env - Environment slice.
 * @returns Origin without a trailing slash, or empty when unset.
 */
export function resolvePublicApiBase(env: Record<string, string | undefined>): string {
  const raw = (env['PUBLIC_BASE_URL'] ?? '').trim().replace(/\/$/, '');
  if (raw === 'https://21.gifts') {
    return 'https://api.21.gifts';
  }
  if (raw === 'https://dev.21.gifts') {
    return 'https://dev-api.21.gifts';
  }
  return raw;
}
