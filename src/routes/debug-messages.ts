/**
 * Operator debug surface. Restore a missing forum-video file for an
 * already-existing message with `hasVideo`. Authenticated by `DEBUG_TOKEN`
 * (Bearer), not by an end-user session. Does not create rows or change DB.
 */

import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import {
  MESSAGE_VIDEO_MAX_BYTES,
  decodeForumVideo,
  forumVideoExt,
  writeForumVideo,
} from '@/lib/video';
import { MESSAGE_ID_RE } from '@/routes/messages';

/** Collaborators the debug message routes need. */
export interface DebugMessagesRouteDeps {
  /** Message persistence port. */
  store: MessageStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build the `/debug/messages` route group.
 *
 * Mounted at `/debug/messages` so the public path is `PUT /debug/messages/:id/video`.
 *
 * @param deps - Message store and optional debug token.
 * @returns A Hono app exposing `PUT /:id/video`.
 */
export function debugMessagesRoutes(deps: DebugMessagesRouteDeps): Hono {
  return new Hono().put('/:id/video', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const id = c.req.param('id');
    if (!MESSAGE_ID_RE.test(id)) {
      return c.json({ error: 'Not found' }, 404);
    }

    try {
      const row = await deps.store.getById(id);
      if (row === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (
        row.hasVideo !== true ||
        row.videoContentType === null ||
        row.videoContentType === undefined
      ) {
        return c.json({ error: 'Message has no video' }, 409);
      }

      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MESSAGE_VIDEO_MAX_BYTES) {
        return c.json({ error: 'Expected a video body' }, 400);
      }
      const decoded = decodeForumVideo(bytes);
      if (decoded === null) {
        return c.json({ error: 'Expected a video body' }, 400);
      }
      if (forumVideoExt(decoded.contentType) !== forumVideoExt(row.videoContentType)) {
        return c.json({ error: 'Video type does not match' }, 409);
      }

      await writeForumVideo(row.id, decoded);
      logEvent('debug.messages.video.put', {
        messageId: row.id,
        bytes: decoded.bytes.byteLength,
      });
      return c.body(null, 204);
    } catch {
      logEvent('debug.messages.video.put_failed');
      return c.json({ error: 'Messages are unavailable' }, 503);
    }
  });
}
