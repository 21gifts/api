/**
 * `GET /shops/:npub`: public lookup of a shop by its Nostr identity
 * (`docs/shop-identity.md` S3). Mounted after `/shops/activity`.
 */

import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { ForumPhoto, MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { forumExtraPhotoUrl, forumPhotoUrl } from '@/lib/nostr/event';
import { imageHeaderSize } from '@/lib/nostr/image';
import { resolvePublicApiBase } from '@/lib/nostr/relays';
import { listShopNip05Entries, nip05Domain } from '@/lib/nip05';
import { shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { listedShop, shopDescription } from '@/lib/shop-place';

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
}

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=60' } as const;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;

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
 * the NIP-05 entry, reads the photo set and re-reads the note. Two rounds
 * read the note at most three times, build the NIP-05 directory at most
 * twice and read the photo set at most twice.
 */
const READ_ROUNDS = 2;

/**
 * The note fields that make up a `GET /shops/:npub` answer: text (listing tag
 * and description), pin (name and place), till account id (pay username) and
 * `deletedAt` (listed). The same fields as the in-memory place fingerprint in
 * `src/lib/shop-identity.ts`; `parentId`, `createdAt` and the id do not change.
 */
function answerFields(note: MessageRow | undefined): string {
  if (note === undefined) return 'missing';
  return JSON.stringify([note.text, note.place, note.shopAccount?.id, note.deletedAt]);
}

/**
 * Build the `/shops` route group with `GET /:npub`.
 *
 * 200 `{ shop }` for a listed shop's npub, 301 to `/shops/{npub}` for the
 * hex form of a known key, 410 for a known key whose note is not listed,
 * 404 for anything else, 503 on a store failure (`shops.detail.failed`).
 *
 * One answer comes from one state of the note. The photos come from one read
 * of the whole set ({@link MessageStore.getPhotoSet}); each URL carries the
 * still's stored index, and a still the set leaves out (an unrecognized
 * type, photo 0 included) drops only itself. While the NIP-05
 * domain is set, the allocation's entry must carry the name of the note this
 * round read; a missing entry or another name (renamed or unlisted between
 * the two reads) goes round once more with a re-read of the note, and on the
 * last round the answer is 503 (`shops.detail.failed` with
 * `reason: 'nip05_stale'`), so a 200 never pairs a name with another name's
 * NIP-05 or a listed shop with a null NIP-05. After the photo set the note is
 * read again; when its text, pin, till account or `deletedAt` differ from the
 * round's note (a rename, text or pin change inside the gap), the route goes
 * round once more with that re-read, and on the last round the answer is 503
 * (`shops.detail.failed` with `reason: 'note_changed'`), so a 200 never pairs
 * the old name with photos set after the change. At most {@link READ_ROUNDS}
 * rounds: three note reads, two NIP-05 directories, two photo set reads.
 *
 * @param deps - Stores and env.
 * @returns Hono sub-app mounted at `/shops`.
 */
export function shopRoutes(deps: ShopRouteDeps): Hono {
  const env = deps.env ?? process.env;
  return new Hono().get('/:npub', async (c) => {
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
      for (let round = 1; ; round += 1) {
        const note = read;
        const shop = listedShop(note);
        if (note === undefined || shop === null) {
          return c.json({ error: 'Shop is no longer listed', npub }, 410, PUBLIC_CACHE);
        }
        let nip05: string | null = null;
        if (domain !== null) {
          const entry = (
            await listShopNip05Entries(deps.authStore, deps.identities, deps.messages)
          ).find((row) => row.messageId === note.id);
          if (entry === undefined || entry.name !== shop.name) {
            // Renamed or unlisted between the note read and the allocation.
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
        if (answerFields(after) !== answerFields(note)) {
          // Renamed, rewritten, re-pinned or unlisted while the photos were read.
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
        const address = till?.lightningAddress?.trim() ?? '';
        return c.json(
          {
            shop: {
              npub,
              messageId: note.id,
              name: shop.name,
              description: shopDescription(note.text),
              place: shop.place,
              photos,
              payUsername: username !== '' && address !== '' ? username : null,
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
