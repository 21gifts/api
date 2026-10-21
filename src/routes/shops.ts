/**
 * `GET /shops/:npub`: public lookup of a shop by its Nostr identity
 * (`docs/shop-identity.md` S3). Mounted after `/shops/activity`.
 */

import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { ForumPhoto } from '@/lib/message';
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
  /** Process env (`PUBLIC_BASE_URL`, `PUBLIC_API_BASE_URL`). Default `process.env`. */
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
 * Reads of the note before a NIP-05 entry that does not carry the shop's
 * name ends in 503: the first read, and one re-read.
 */
const NOTE_READS = 2;

/**
 * Build the `/shops` route group with `GET /:npub`.
 *
 * 200 `{ shop }` for a listed shop's npub, 301 to `/shops/{npub}` for the
 * hex form of a known key, 410 for a known key whose note is not listed,
 * 404 for anything else, 503 on a store failure (`shops.detail.failed`).
 *
 * The photos come from one read of the whole set
 * ({@link MessageStore.getPhotoSet}). While the NIP-05 domain is set, the
 * allocation's entry must carry the name of the note this request read; a
 * missing entry or another name (renamed or unlisted between the two reads)
 * re-reads the note and allocates once more, and when that still does not
 * match the answer is 503 (`shops.detail.failed` with
 * `reason: 'nip05_stale'`), so a 200 never pairs a name with another name's
 * NIP-05 or a listed shop with a null NIP-05.
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
      for (let read = 1; ; read += 1) {
        const note = await deps.messages.getById(identity.messageId);
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
            if (read < NOTE_READS) continue;
            logEvent('shops.detail.failed', { reason: 'nip05_stale' });
            return c.json({ error: 'Shops are unavailable' }, 503, NO_STORE);
          }
          nip05 = `${entry.local}@${domain}`;
        }
        const set = await deps.messages.getPhotoSet(note.id);
        const apiBase = resolvePublicApiBase(env);
        const photos = (set.photo === null ? [] : [set.photo, ...set.extras])
          .slice(0, 10)
          .map((photo, index) => photoRow(apiBase, note.id, index, photo));
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
