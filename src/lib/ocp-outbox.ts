/**
 * Durable OpenCryptoPay place and photo senders for shop identities
 * (`docs/shop-identity.md` S5).
 *
 * Both lanes claim rows of `shop_identity` with a lease by the database
 * clock and a claim token. Every request carries the next `revision` of the
 * shop's shared counter. The worker decides at send time from the note as
 * it is then: a listed shop gets `PUT /map/places`, anything else
 * `DELETE /map/places`.
 */

import { createHash } from 'node:crypto';
import { errorLogFields, logEvent } from '@/lib/log';
import type { ForumPhoto } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { WORKER_BATCH, WORKER_INTERVAL_MS, WORKER_LEASE_MS } from '@/lib/nostr/worker';
import { shopOcpPlaceInput, type MapPush } from '@/lib/ocp-place';
import type { ShopIdentityStore, ShopOcpClaim } from '@/lib/shop-identity';
import { isListedShop, listedShop } from '@/lib/shop-place';

/** Timeout of one place request (as the former `mapPlacesRequest`). */
export const OCP_PLACE_TIMEOUT_MS = 5_000;

/** Timeout of one photo request (body up to about 13.3 MiB). */
export const OCP_PHOTO_TIMEOUT_MS = 30_000;

/** Lease time a request must still have beyond its timeout before it starts. */
export const OCP_LEASE_MARGIN_MS = 10_000;

/** Page size of the start-up pass. */
export const OCP_STARTUP_PAGE = 200;

/** At most this many photos are sent per shop. */
const OCP_PHOTO_LIMIT = 10;

/** Collaborators for the two OpenCryptoPay outbox senders. */
export interface OcpOutboxDeps {
  /** Shop identities and both outboxes. */
  identities: ShopIdentityStore;
  /** Forum notes and photos (decide listed at send time). */
  messages: MessageStore;
  /** Resolved OpenCryptoPay target (`resolveMapPush`). */
  mapPush: MapPush;
}

async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function isStaleRevision(response: Response): Promise<boolean> {
  return response.status === 409 && (await bodyText(response)).includes('Stale revision');
}

function send(
  mapPush: MapPush,
  path: '/map/places' | '/map/places/photos',
  method: 'PUT' | 'DELETE',
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  return mapPush.fetchImpl(`${mapPush.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${mapPush.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Send one claimed place: `PUT` with `nostrPubkey` and `revision` for a
 * listed shop, otherwise reset the photo state and `DELETE`.
 */
async function sendPlace(deps: OcpOutboxDeps, claim: ShopOcpClaim): Promise<void> {
  const { identities } = deps;
  const messageId = claim.messageId;
  const identity = await identities.getByMessageId(messageId);
  const note = await deps.messages.getById(messageId);
  const shop = listedShop(note);
  let body: Record<string, unknown>;
  if (identity === undefined) {
    await identities.release('place', claim);
    return;
  }
  if (note !== undefined && shop !== null) {
    body = {
      ...shopOcpPlaceInput(messageId, note.text, shop.place),
      nostrPubkey: identity.nostrPubkey,
    };
  } else {
    await identities.resetPhotosForDelete(claim);
    body = { origin: '21gifts', externalId: messageId };
  }
  const method = shop === null ? 'DELETE' : 'PUT';
  const revision = await identities.nextRevision('place', claim);
  if (revision === undefined) return;
  if (
    !(await identities.leaseHasTime('place', claim, OCP_PLACE_TIMEOUT_MS + OCP_LEASE_MARGIN_MS))
  ) {
    await identities.release('place', claim);
    return;
  }
  try {
    const response = await send(
      deps.mapPush,
      '/map/places',
      method,
      { ...body, revision },
      OCP_PLACE_TIMEOUT_MS,
    );
    if (response.ok) {
      await identities.finishPlace(
        claim,
        method === 'DELETE' ? 'delete' : response.status === 201 ? 'created' : 'put',
      );
      return;
    }
    if (await isStaleRevision(response)) {
      await identities.release('place', claim);
      return;
    }
    if (response.status === 400 || response.status === 409) {
      logEvent('ocp.place.rejected', { messageId, status: response.status });
      await identities.finishPlace(claim, 'reject');
      return;
    }
    logEvent('ocp.place.failed', { messageId, status: response.status });
  } catch (error) {
    logEvent('ocp.place.failed', { messageId, ...errorLogFields(error) });
  }
}

/**
 * Claim and send at most `WORKER_BATCH` pending OpenCryptoPay place writes.
 *
 * Results: `PUT` 2xx clears the place flag (generation-checked) and queues
 * the photos; 201 also nulls the photo hash; `DELETE` 2xx clears the flag;
 * 409 `Stale revision` only releases; 400 or another 409 logs
 * `ocp.place.rejected` and clears the flag; anything else logs
 * `ocp.place.failed` and keeps the flag until the lease ends.
 *
 * @param deps - Identities, messages and the map target.
 * @returns Resolves when every claimed row was handled.
 */
export async function runOcpPlaceOutboxPass(deps: OcpOutboxDeps): Promise<void> {
  const claims = await deps.identities.claimPlaces(WORKER_BATCH, WORKER_LEASE_MS);
  await Promise.all(claims.map((claim) => sendPlace(deps, claim)));
}

/**
 * SHA-256 over a photo set in note order (content type, byte length and
 * bytes of each photo), as stored in `ocp_photos_hash`.
 *
 * @param photos - Photos in note order.
 * @returns Lowercase hex digest.
 */
export function ocpPhotoSetHash(photos: readonly ForumPhoto[]): string {
  const hash = createHash('sha256');
  for (const photo of photos) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(photo.bytes.byteLength, 0);
    hash.update(photo.contentType);
    hash.update(length);
    hash.update(photo.bytes);
  }
  return hash.digest('hex');
}

async function notePhotos(messages: MessageStore, messageId: string): Promise<ForumPhoto[]> {
  const first = await messages.getPhoto(messageId);
  if (first === null) return [];
  return [first, ...(await messages.listExtraPhotos(messageId))].slice(0, OCP_PHOTO_LIMIT);
}

async function skippedCount(response: Response): Promise<number> {
  try {
    const payload = (await response.json()) as { skipped?: unknown };
    return Array.isArray(payload.skipped) ? payload.skipped.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Claim and send one pending OpenCryptoPay photo set (`PUT /map/places/photos`).
 *
 * A shop that is not listed, or whose set hash equals `ocp_photos_hash`, is
 * cleared without a request. Otherwise the hash is nulled first, then up to
 * 10 photos are sent in note order as base64. Results: 200 stores the hash
 * (generation-checked) and logs `ocp.photos.skipped` for skipped photos;
 * 409 `Stale revision` nulls the hash and releases; 400 or 413 store the
 * hash and log `ocp.photos.rejected`; 404 clears the flag and queues the
 * place when still listed; anything else logs `ocp.photos.failed` and keeps
 * the flag until the lease ends.
 *
 * @param deps - Identities, messages and the map target.
 * @returns Resolves when the claimed row (if any) was handled.
 */
export async function runOcpPhotoOutboxPass(deps: OcpOutboxDeps): Promise<void> {
  const { identities } = deps;
  const claim = await identities.claimPhoto(WORKER_LEASE_MS);
  if (claim === undefined) return;
  const messageId = claim.messageId;
  const minimumMs = OCP_PHOTO_TIMEOUT_MS + OCP_LEASE_MARGIN_MS;
  if (!(await identities.leaseHasTime('photos', claim, minimumMs))) {
    await identities.release('photos', claim);
    return;
  }
  const identity = await identities.getByMessageId(messageId);
  if (identity === undefined || !isListedShop(await deps.messages.getById(messageId))) {
    await identities.clearPhotoWithoutSend(claim);
    return;
  }
  const photos = await notePhotos(deps.messages, messageId);
  const hash = ocpPhotoSetHash(photos);
  if (identity.ocpPhotosHash === hash) {
    await identities.clearPhotoWithoutSend(claim);
    return;
  }
  await identities.clearPhotoHash(claim);
  const revision = await identities.nextRevision('photos', claim);
  if (revision === undefined) return;
  if (!(await identities.leaseHasTime('photos', claim, minimumMs))) {
    await identities.release('photos', claim);
    return;
  }
  try {
    const response = await send(
      deps.mapPush,
      '/map/places/photos',
      'PUT',
      {
        origin: '21gifts',
        nostrPubkey: identity.nostrPubkey,
        revision,
        photos: photos.map((photo) => ({
          contentType: photo.contentType,
          data: Buffer.from(photo.bytes).toString('base64'),
        })),
      },
      OCP_PHOTO_TIMEOUT_MS,
    );
    if (response.status === 200) {
      const skipped = await skippedCount(response);
      if (skipped > 0) logEvent('ocp.photos.skipped', { messageId, skipped });
      await identities.finishPhotos(claim, hash);
      return;
    }
    if (await isStaleRevision(response)) {
      await identities.clearPhotoHash(claim);
      await identities.release('photos', claim);
      return;
    }
    if (response.status === 400 || response.status === 413) {
      logEvent('ocp.photos.rejected', { messageId, status: response.status });
      await identities.finishPhotos(claim, hash);
      return;
    }
    if (response.status === 404) {
      const listed = isListedShop(await deps.messages.getById(messageId));
      await identities.missingPhotoPlace(claim, listed);
      return;
    }
    logEvent('ocp.photos.failed', { messageId, status: response.status });
  } catch (error) {
    logEvent('ocp.photos.failed', { messageId, ...errorLogFields(error) });
  }
}

/**
 * Start-up pass: queue the place push of every `shop_identity` row with
 * keyset paging by `message_id` ({@link OCP_STARTUP_PAGE} per page). It
 * decides nothing; the place sender does at send time.
 *
 * @param identities - Shop identity store.
 * @returns Number of rows queued.
 */
export async function queueAllShopPlaces(identities: ShopIdentityStore): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  for (;;) {
    const page = await identities.queueAllPlacePage(cursor, OCP_STARTUP_PAGE);
    total += page.length;
    const last = page[page.length - 1];
    if (page.length < OCP_STARTUP_PAGE || last === undefined) return total;
    cursor = last;
  }
}

/**
 * Start both outbox lanes: the place pass on a fixed interval (claims keep
 * two passes apart), and the photo pass serialised, each pass scheduled
 * `intervalMs` after the previous one settled, so each instance has at most
 * one photo upload in flight.
 *
 * @param deps - Identities, messages and the map target.
 * @param intervalMs - Tick interval (default `WORKER_INTERVAL_MS`).
 * @returns Handle whose `stop` ends both lanes.
 */
export function startOcpOutboxWorker(
  deps: OcpOutboxDeps,
  intervalMs: number = WORKER_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  let photoTimer: ReturnType<typeof setTimeout> | undefined;
  const runPhoto = (): void => {
    void runOcpPhotoOutboxPass(deps)
      .catch((error: unknown) => {
        logEvent('ocp.photos.failed', errorLogFields(error));
      })
      .finally(() => {
        if (!stopped) photoTimer = setTimeout(runPhoto, intervalMs);
      });
  };
  photoTimer = setTimeout(runPhoto, intervalMs);
  const placeTimer = setInterval(() => {
    void runOcpPlaceOutboxPass(deps).catch((error: unknown) => {
      logEvent('ocp.place.failed', errorLogFields(error));
    });
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(placeTimer);
      clearTimeout(photoTimer);
    },
  };
}
