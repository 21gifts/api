/**
 * Round profile photo. Separate from the wide image and from the About me note.
 * `PUT/GET /pictures/me` is the signed-in account.
 * `GET /pictures/:accountId.jpg` is public so a Nostr client can fetch it.
 */

import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { InMemoryBannerStore, isProfilePhoto, type BannerStore } from '@/lib/banner-store';
import type { AuthStore } from '@/lib/auth/store';
import { decodeForumPhoto, forumPhotoResponse, type ForumPhotoContentType } from '@/lib/message';
import { bearerToken } from '@/routes/me';

const ACCOUNT_FILE_RE = /^([0-9A-Za-z_-]{1,80})\.(jpg|png|webp)$/;

const PHOTO_ERROR = 'Profile photo must be a JPEG, PNG, or WebP';

/** Collaborators for {@link pictureRoutes}. */
export interface PictureRouteDeps {
  /** Account sessions. */
  auth: AuthStore;
  /** Image store (default: empty memory). The picture slot only. */
  banners?: BannerStore;
  /** Clock for session expiry. */
  now?: () => number;
}

/**
 * Routes for the round profile photo.
 *
 * @param deps - Auth store and image store.
 * @returns Hono app. Mount at `/pictures`.
 */
export function pictureRoutes(deps: PictureRouteDeps): Hono {
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
      const photo = await banners.get(account.id, 'picture');
      if (photo === null) {
        return c.json({ error: 'Profile photo not found' }, 404);
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
        await banners.set(account.id, 'picture', null);
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
      if (decoded === null || !isProfilePhoto(decoded.bytes, decoded.contentType)) {
        return c.json({ error: PHOTO_ERROR }, 400);
      }
      await banners.set(account.id, 'picture', decoded);
      return c.body(null, 204);
    })
    .get('/:file', async (c) => {
      const match = ACCOUNT_FILE_RE.exec(c.req.param('file'));
      if (match === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      const accountId = match[1] as string;
      const ext = match[2] as string;
      const photo = await banners.get(accountId, 'picture');
      if (photo === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (ext !== extFor(photo.contentType)) {
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
