/**
 * Public OCP place list and authenticated ingest.
 *
 * `GET /places` is open. `POST /places` requires `OCP_PLACE_INGEST_TOKEN`.
 * A new place may be pushed once to BTC Map; duplicates skip the push.
 */

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { BtcMapPush } from '@/lib/btcmap-push';
import { logEvent } from '@/lib/log';
import { normalizeOcpPlace } from '@/lib/ocp-place';
import type { OcpPlaceStore } from '@/lib/ocp-place-store';

/** Default list cap when `limit` is omitted. */
const DEFAULT_LIST_LIMIT = 1000;

/**
 * Compare a Bearer token to the configured ingest secret.
 *
 * Different lengths never call `timingSafeEqual` (it throws). A missing or
 * blank configured token is unconfigured regardless of the header.
 *
 * @param configuredToken - `OCP_PLACE_INGEST_TOKEN`, or `undefined` when unset.
 * @param authorizationHeader - Raw `Authorization` header, if present.
 * @returns `'unconfigured'`, `'unauthorized'`, or `'ok'`.
 */
function checkIngestAuth(
  configuredToken: string | undefined,
  authorizationHeader: string | undefined,
): 'unconfigured' | 'unauthorized' | 'ok' {
  if (configuredToken === undefined || configuredToken.trim() === '') {
    return 'unconfigured';
  }
  if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
    return 'unauthorized';
  }
  const presented = authorizationHeader.slice('Bearer '.length).trim();
  const expected = configuredToken.trim();
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return 'unauthorized';
  }
  return timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}

/**
 * Build the `/ocp` route group (`GET /places`, `POST /places`).
 *
 * @param deps - Place store, optional BTC Map push, ingest token.
 * @returns A Hono app mounted under `/ocp`.
 */
export function ocpPlacesRoutes(deps: {
  places: OcpPlaceStore;
  btcMapPush?: BtcMapPush;
  ingestToken?: string;
}): Hono {
  return new Hono()
    .get('/places', async (c) => {
      const limitQuery = c.req.query('limit');
      let limit: number;
      if (limitQuery === undefined) {
        limit = DEFAULT_LIST_LIMIT;
      } else if (/^\d+$/.test(limitQuery)) {
        const n = Number(limitQuery);
        if (n < 1 || n > DEFAULT_LIST_LIMIT) {
          return c.json({ error: 'Invalid limit' }, 400);
        }
        limit = n;
      } else {
        return c.json({ error: 'Invalid limit' }, 400);
      }
      try {
        const rows = await deps.places.list(limit);
        return c.json(
          {
            places: rows.map((row) => ({
              id: row.id,
              origin: row.origin,
              name: row.name,
              lat: row.lat,
              lon: row.lon,
              category: row.category,
            })),
          },
          200,
        );
      } catch {
        logEvent('ocp.place.failed');
        return c.json({ error: 'Places are unavailable' }, 503);
      }
    })
    .post('/places', async (c) => {
      const auth = checkIngestAuth(deps.ingestToken, c.req.header('authorization'));
      if (auth === 'unconfigured') {
        return c.json({ error: 'Place ingest is not configured' }, 503);
      }
      if (auth === 'unauthorized') {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = normalizeOcpPlace(raw);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      try {
        const { created, place } = await deps.places.insertIfNew(parsed.value);
        if (!created) {
          return c.json({ created: false, id: place.id, btcmap: 'skipped' }, 200);
        }
        let btcmap: 'sent' | 'skipped' | 'failed' = 'skipped';
        if (deps.btcMapPush !== undefined) {
          btcmap = await deps.btcMapPush.submit(place);
        }
        return c.json({ created: true, id: place.id, btcmap }, 201);
      } catch {
        logEvent('ocp.place.failed');
        return c.json({ error: 'Places are unavailable' }, 503);
      }
    });
}
