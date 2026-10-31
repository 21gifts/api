/**
 * `GET /shops` and `GET /shops/:npub`: the public shop directory and one
 * shop by its Nostr identity (`docs/shop-identity.md` S3). Mounted after
 * `/shops/activity`.
 */

import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { logEvent } from '@/lib/log';
import type { ForumPhoto } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { forumExtraPhotoUrl, forumPhotoUrl } from '@/lib/nostr/event';
import { imageHeaderSize } from '@/lib/nostr/image';
import { resolvePublicApiBase } from '@/lib/nostr/relays';
import { nip05Directory, nip05Domain } from '@/lib/nip05';
import { shopNpub, type ShopDirectoryCursor, type ShopIdentityStore } from '@/lib/shop-identity';
import { receivingAddress } from '@/lib/receiving-address';
import { publicShop, shopDescription, shopListingFingerprint } from '@/lib/shop-place';

/** Collaborators for `GET /shops/:npub`. */
export interface ShopRouteDeps {
  /** Accounts: the till account's pay username and the NIP-05 allocation. */
  authStore: AuthStore;
  /** Forum notes and their photos. */
  messages: MessageStore;
  /** Shop identities. */
  identities: ShopIdentityStore;
  /** Process env (`PUBLIC_BASE_URL` for the NIP-05 domain and the photo URLs). Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Clock in epoch milliseconds for the NIP-05 directory cache. Default `Date.now`. */
  now?: () => number;
  /** LNURL server; without it no till account can receive, so `payUsername` is `null`. */
  lnurlServer?: LnurlServerConfig;
}

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=60' } as const;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;
const DIRECTORY_DEFAULT_LIMIT = 20;
const DIRECTORY_LIMIT_RE = /^(?:[1-9]\d?|100)$/;
const DIRECTORY_CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const DIRECTORY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Page size of `GET /shops`. Absent means 20. Present must be the canonical
 * decimal of an integer from 1 to 100.
 *
 * @param raw - The `limit` query, or `undefined` when it was omitted.
 * @returns The page size, or null when `raw` is not canonical.
 */
function directoryLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DIRECTORY_DEFAULT_LIMIT;
  if (!DIRECTORY_LIMIT_RE.test(raw)) return null;
  return Number(raw);
}

/**
 * Cursor of `GET /shops`. Absent means the first page. Present is base64url
 * JSON of exactly `{ c, i }`, `c` a timestamp that round-trips through
 * `Date.toISOString`, and `i` a UUID.
 *
 * @param raw - The `cursor` query, or `undefined` when it was omitted.
 * @returns The cursor, null for the first page, or false when `raw` is not a page token.
 */
function directoryCursor(raw: string | undefined): ShopDirectoryCursor | null | false {
  if (raw === undefined) return null;
  if (!DIRECTORY_CURSOR_RE.test(raw)) return false;
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.toString('base64url') !== raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, 'c') ||
    !Object.hasOwn(parsed, 'i')
  ) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const createdAtText = record['c'];
  const idText = record['i'];
  if (typeof createdAtText !== 'string' || typeof idText !== 'string') return false;
  // Some engines let $ match before one trailing line terminator. Length
  // 36 keeps that character out. The limit regex already rejects it here.
  if (!DIRECTORY_UUID_RE.test(idText) || idText.length !== 36) return false;
  const createdAt = new Date(createdAtText);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== createdAtText) return false;
  return { createdAt, id: idText.toLowerCase() };
}

/**
 * `nextCursor` for one examined note.
 *
 * @param cursor - Last examined note.
 * @returns Base64url JSON `{ c, i }` without padding.
 */
function encodeDirectoryCursor(cursor: ShopDirectoryCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Hex public key of a path segment, or `null` when it is neither 64
 * lowercase hex nor a valid npub.
 */
function segmentPubkey(segment: string): string | null {
  if (HEX_PUBKEY.test(segment)) return segment;
  if (!NPUB.test(segment)) return null;
  try {
    return nip19.decode(segment as nip19.NPub).data;
  } catch {
    return null;
  }
}

/**
 * One `photos` entry: photo 0 is `photo.<ext>`, the extra still stored at
 * `index` n ≥ 1 is `photo/<n>.<ext>`.
 */
function photoRow(
  apiBase: string,
  messageId: string,
  index: number,
  photo: ForumPhoto,
): { url: string; width: number | null; height: number | null } {
  return {
    url:
      index === 0
        ? forumPhotoUrl(apiBase, messageId, photo.contentType)
        : forumExtraPhotoUrl(apiBase, messageId, index, photo.contentType),
    ...imageHeaderSize(photo.bytes, photo.contentType),
  };
}

/**
 * Rounds of `GET /shops/:npub` before a changing note ends in 503. A round
 * reads the note (round 1) or takes the re-read of the round before, checks
 * the NIP-05 entry of the shared directory, reads the photo set and re-reads
 * the note. Two rounds read the note at most three times and the photo set at
 * most twice; the directory is read from the shared cache
 * ({@link nip05Directory}), and a request asks for at most one forced refresh.
 */
const READ_ROUNDS = 2;

/**
 * Build the `/shops` route group with `GET /` and `GET /:npub`.
 *
 * `GET /` is the public directory. No session; a bearer is ignored. `limit`
 * defaults to 20 and, when present, must be a canonical base-10 integer from
 * 1 to 100. `cursor`, when present, is base64url JSON `{ c, i }` of the
 * previous page. 200 `{ shops, nextCursor? }` lists keyed public shops,
 * newest note first, each `{ npub, name, place }`. A bad limit or cursor is
 * 400 with the public cache header and does not read the store. A store
 * failure is 503 (`shops.list.failed`, `no-store`).
 *
 * `GET /:npub`: 200 `{ shop }` for a public shop's npub, 301 to
 * `/shops/{npub}` for the hex form of a known key, 410 for a known key whose
 * note is not public, 404 for anything else, 503 on a store failure
 * (`shops.detail.failed`).
 *
 * One answer comes from one state of the note. The photos come from one read
 * of the whole set ({@link MessageStore.getPhotoSet}); each URL carries the
 * still's stored index, and a still the set leaves out (an unrecognized
 * type, photo 0 included) drops only itself. While the NIP-05
 * domain is set, the entry of the shared NIP-05 directory
 * ({@link nip05Directory}, cached per store set for 60 s, the same names as
 * `/.well-known/nostr.json` and the shop kind 0) must carry the name of the
 * note this round read. On the first missing entry or other name the request
 * asks once for a forced refresh of the directory (rate-limited per store
 * set, so a stream of requests for a renamed shop cannot each force one) and
 * checks again; when it still does not match (renamed or not public between
 * the two reads) it goes round once more with a re-read of the note, and on
 * the last round the answer is 503 (`shops.detail.failed` with
 * `reason: 'nip05_stale'`), so a 200 never pairs a name with another name's
 * NIP-05 or a public shop with a null NIP-05. After the photo set the note is
 * read again; when its text, pin, till account or `deletedAt` differ from the
 * round's note (a rename, text or pin change inside the gap), the route goes
 * round once more with that re-read, and on the last round the answer is 503
 * (`shops.detail.failed` with `reason: 'note_changed'`), so a 200 never pairs
 * the old name with photos set after the change. At most {@link READ_ROUNDS}
 * rounds: three note reads, two photo set reads, and at most one forced
 * directory refresh (the cached directory otherwise).
 *
 * @param deps - Stores and env.
 * @returns Hono sub-app mounted at `/shops`.
 */
export function shopRoutes(deps: ShopRouteDeps): Hono {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const stores = { identities: deps.identities, messages: deps.messages };
  const routes = new Hono();
  routes.get('/', async (c) => {
    const limit = directoryLimit(c.req.query('limit'));
    if (limit === null) return c.json({ error: 'Invalid limit' }, 400, PUBLIC_CACHE);
    const cursor = directoryCursor(c.req.query('cursor'));
    if (cursor === false) return c.json({ error: 'Invalid cursor' }, 400, PUBLIC_CACHE);
    try {
      const page = await deps.identities.listDirectory(cursor, limit);
      const shops = page.shops.map((shop) => ({
        npub: shop.npub,
        name: shop.name,
        place: shop.place,
      }));
      if (page.next === null) return c.json({ shops }, 200, PUBLIC_CACHE);
      return c.json({ shops, nextCursor: encodeDirectoryCursor(page.next) }, 200, PUBLIC_CACHE);
    } catch {
      logEvent('shops.list.failed');
      return c.json({ error: 'Shops are unavailable' }, 503, NO_STORE);
    }
  });
  return routes.get('/:npub', async (c) => {
    const segment = c.req.param('npub');
    const pubkey = segmentPubkey(segment);
    if (pubkey === null) return c.json({ error: 'Not found' }, 404, PUBLIC_CACHE);
    try {
      const identity = await deps.identities.getByPubkey(pubkey);
      if (identity === undefined) return c.json({ error: 'Not found' }, 404, PUBLIC_CACHE);
      const npub = shopNpub(identity);
      if (segment !== npub) {
        return c.body(null, 301, { ...PUBLIC_CACHE, Location: `/shops/${npub}` });
      }
      const domain = nip05Domain(env);
      let read = await deps.messages.getById(identity.messageId);
      let refreshed = false;
      for (let round = 1; ; round += 1) {
        const note = read;
        const shop = publicShop(note);
        if (note === undefined || shop === null) {
          return c.json({ error: 'Shop is no longer listed', npub }, 410, PUBLIC_CACHE);
        }
        let nip05: string | null = null;
        if (domain !== null) {
          let entry = (await nip05Directory(deps.authStore, stores, now())).shops.get(note.id);
          if (entry?.name !== shop.name && !refreshed) {
            // The cached directory may predate this note: ask once for a fresh one.
            refreshed = true;
            entry = (await nip05Directory(deps.authStore, stores, now(), true)).shops.get(note.id);
          }
          if (entry === undefined || entry.name !== shop.name) {
            // Renamed or no longer public between the note read and the allocation.
            if (round < READ_ROUNDS) {
              read = await deps.messages.getById(identity.messageId);
              continue;
            }
            logEvent('shops.detail.failed', { reason: 'nip05_stale' });
            return c.json({ error: 'Shops are unavailable' }, 503, NO_STORE);
          }
          nip05 = `${entry.local}@${domain}`;
        }
        const set = await deps.messages.getPhotoSet(note.id);
        const after = await deps.messages.getById(identity.messageId);
        if (shopListingFingerprint(after) !== shopListingFingerprint(note)) {
          // Renamed, rewritten, re-pinned or no longer public while the photos were read.
          if (round < READ_ROUNDS) {
            read = after;
            continue;
          }
          logEvent('shops.detail.failed', { reason: 'note_changed' });
          return c.json({ error: 'Shops are unavailable' }, 503, NO_STORE);
        }
        const apiBase = resolvePublicApiBase(env);
        // Each still keeps its stored index in its URL; one that the set
        // leaves out (an unrecognized type) drops only itself.
        const photos = [
          ...(set.photo === null ? [] : [{ index: 0, photo: set.photo }]),
          ...set.extras,
        ]
          .slice(0, 10)
          .map(({ index, photo }) => photoRow(apiBase, note.id, index, photo));
        const till = await deps.authStore.getAccount(shop.tillAccountId);
        const username = till?.username?.trim() ?? '';
        const canReceive = till !== undefined && receivingAddress(till, deps.lnurlServer) !== null;
        return c.json(
          {
            shop: {
              npub,
              messageId: note.id,
              name: shop.name,
              description: shopDescription(note.text),
              place: shop.place,
              photos,
              payUsername: username !== '' && canReceive ? username : null,
              nip05,
              createdAt: note.createdAt.toISOString(),
            },
          },
          200,
          PUBLIC_CACHE,
        );
      }
    } catch {
      logEvent('shops.detail.failed');
      return c.json({ error: 'Shops are unavailable' }, 503, NO_STORE);
    }
  });
}
