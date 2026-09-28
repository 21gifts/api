/**
 * Wide profile image. `PUT/GET /banners/me` is the signed-in account.
 * `GET /banners/:accountId.jpg` is public so a Nostr client can fetch it.
 * The About me photo is never accepted here.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { resolveSession } from '@/lib/auth/service';
import { InMemoryBannerStore, wideBannerSize, type BannerStore } from '@/lib/banner-store';
import { decodeForumPhoto, forumPhotoResponse, type ForumPhotoContentType } from '@/lib/message';
import { bearerToken } from '@/routes/me';

const ACCOUNT_FILE_RE = /^([0-9A-Za-z_-]{1,80})\.(jpg|png|webp)$/;

const WIDE_IMAGE_ERROR =
  'Wide image must be at least 640 px wide and at least 1.5 times as wide as it is tall';

/** Collaborators for {@link bannerRoutes}. */
export interface BannerRouteDeps {
  /** Account sessions. */
  auth: AuthStore;
  /** Wide-image store (default: empty memory). */
  banners?: BannerStore;
  /** Clock for session expiry. */
  now?: () => number;
}

/**
 * Routes for the wide profile image.
 *
 * @param deps - Auth store and banner store.
 * @returns Hono app. Mount at `/banners`.
 */
export function bannerRoutes(deps: BannerRouteDeps): Hono {
  const banners = deps.banners ?? new InMemoryBannerStore();
  const now = deps.now ?? Date.now;

  return new Hono()
    .get('/me', async (c) => {
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.auth, now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const photo = await banners.get(account.id);
      if (photo === null) {
        return c.json({ error: 'Wide image not found' }, 404);
      }
      return forumPhotoResponse(photo);
    })
    .put('/me', async (c) => {
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.auth, now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('photo' in raw)) {
        return c.json({ error: 'Expected a JSON body with a "photo" field' }, 400);
      }
      const incoming = (raw as { photo?: unknown }).photo;
      if (incoming === null) {
        await banners.set(account.id, null);
        return c.body(null, 204);
      }
      if (
        incoming === undefined ||
        typeof incoming !== 'object' ||
        Array.isArray(incoming) ||
        typeof (incoming as { contentType?: unknown }).contentType !== 'string' ||
        typeof (incoming as { data?: unknown }).data !== 'string'
      ) {
        return c.json({ error: 'Expected a JSON body with a "photo" field' }, 400);
      }
      const body = incoming as { contentType: string; data: string };
      const decoded = decodeForumPhoto(body.contentType, body.data);
      if (decoded === null) {
        return c.json({ error: WIDE_IMAGE_ERROR }, 400);
      }
      if (wideBannerSize(decoded.bytes, decoded.contentType) === null) {
        return c.json({ error: WIDE_IMAGE_ERROR }, 400);
      }
      await banners.set(account.id, decoded);
      return c.body(null, 204);
    })
    .get('/:file', async (c) => {
      const match = ACCOUNT_FILE_RE.exec(c.req.param('file'));
      if (match === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      const accountId = match[1] as string;
      const ext = match[2] as string;
      const photo = await banners.get(accountId);
      if (photo === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      const expected = extFor(photo.contentType);
      if (ext !== expected) {
        return c.json({ error: 'Not found' }, 404);
      }
      return forumPhotoResponse(photo);
    });
}

function extFor(mime: ForumPhotoContentType): 'jpg' | 'png' | 'webp' {
  if (mime === 'image/png') {
    return 'png';
  }
  if (mime === 'image/webp') {
    return 'webp';
  }
  return 'jpg';
}
