/**
 * Operator debug surface for forum notes. List and fetch every persisted
 * row (including soft-hidden notes and replies), serve hidden photo bytes,
 * and restore a missing forum-video file for an already-existing message
 * with `hasVideo`. Authenticated by `DEBUG_TOKEN` (Bearer), not by an
 * end-user session. Does not create rows. Video restore does not change DB.
 */

import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT, serializeDebugMessage } from '@/lib/message';
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

/** Shared 503/401 gate matching other `/debug/*` routes. */
function gateDebugToken(
  debugToken: string | undefined,
  authorization: string | undefined,
): { ok: true } | { ok: false; status: 503 | 401; body: { error: string } } {
  if (debugToken === undefined || debugToken.trim() === '') {
    return { ok: false, status: 503, body: { error: 'Debug is not configured' } };
  }
  if (!bearerMatchesDebugToken(debugToken, authorization)) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  return { ok: true };
}

/**
 * Build the `/debug/messages` route group.
 *
 * Mounted at `/debug/messages` so the public paths are `GET /debug/messages`,
 * `GET /debug/messages/:id`, `GET /debug/messages/:id/photo`, and
 * `PUT /debug/messages/:id/video`.
 *
 * @param deps - Message store and optional debug token.
 * @returns A Hono app exposing the debug message GETs and `PUT /:id/video`.
 */
export function debugMessagesRoutes(deps: DebugMessagesRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      try {
        const rows = await deps.store.listDebug(MESSAGE_LIST_LIMIT);
        logEvent('debug.messages.listed', { count: rows.length });
        return c.json({ messages: rows.map(serializeDebugMessage) }, 200);
      } catch {
        logEvent('debug.messages.list_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
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
        logEvent('debug.messages.get', { messageId: row.id });
        return c.json(serializeDebugMessage(row), 200);
      } catch {
        logEvent('debug.messages.get_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:id/photo', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      const id = c.req.param('id');
      if (!MESSAGE_ID_RE.test(id)) {
        return c.json({ error: 'Photo not found' }, 404);
      }
      try {
        const row = await deps.store.getById(id);
        if (row === undefined) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const photo = await deps.store.getPhoto(id);
        if (photo === null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const ext =
          photo.contentType === 'image/png'
            ? 'png'
            : photo.contentType === 'image/webp'
              ? 'webp'
              : 'jpg';
        logEvent('debug.messages.photo.get', { messageId: row.id });
        return new Response(photo.bytes, {
          status: 200,
          headers: {
            'Content-Type': photo.contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            'Content-Disposition': `inline; filename="photo.${ext}"`,
          },
        });
      } catch {
        logEvent('debug.messages.photo.get_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .put('/:id/video', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
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
