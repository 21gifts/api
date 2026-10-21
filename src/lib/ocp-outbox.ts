/**
 * Durable OpenCryptoPay place and photo senders for shop identities
 * (`docs/shop-identity.md` S5).
 *
 * Both lanes claim rows of `shop_identity` with a lease by the database
 * clock and a claim token, least recently claimed first, so rows whose sends
 * keep failing (and keep their claims until the lease ends) or that are
 * released on every pass (a release goes behind never-claimed rows and
 * leases that ended earlier) never hold the place of later shops. Every
 * request carries the next `revision` of the shop's shared counter. The
 * worker decides at send time from the note as it is then: a listed shop
 * gets `PUT /map/places`, anything else `DELETE /map/places`.
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

/**
 * Answer body, or `''` when it cannot be read. The place lane's 400 and 409
 * checks test the trimmed text, so a body of only whitespace is no verdict
 * there.
 */
async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isStaleRevisionText(text: string): boolean {
  return text.includes('Stale revision');
}

async function isStaleRevision(response: Response): Promise<boolean> {
  return response.status === 409 && isStaleRevisionText(await bodyText(response));
}

/**
 * The 400 answers of an OpenCryptoPay API without openCryptoPay/api#26: its
 * place validation names the first field it does not know.
 */
const OCP_OLD_API_ERRORS: ReadonlySet<string> = new Set([
  'Place field is not allowed: nostrPubkey',
  'Place field is not allowed: revision',
]);

/** Error of the JSON 404 that openCryptoPay/api#26 answers for a place it does not know by key. */
const OCP_PLACE_NOT_FOUND = 'Place not found';

/**
 * The `error` string of a JSON answer body.
 *
 * @param text - Answer body.
 * @returns The `error` field when the body is a JSON object with a string `error`, otherwise null.
 */
function jsonError(text: string): string | null {
  try {
    const payload = JSON.parse(text) as { error?: unknown } | null;
    return typeof payload?.error === 'string' ? payload.error : null;
  } catch {
    return null;
  }
}

/**
 * Whether a 400 is the answer of an OpenCryptoPay API that does not run
 * openCryptoPay/api#26 yet (`nostrPubkey` or `revision` not allowed).
 *
 * @param text - Body of the 400 answer.
 * @returns The fixed error text when it is such an answer, otherwise null.
 */
function oldApiError(text: string): string | null {
  const error = jsonError(text);
  return error !== null && OCP_OLD_API_ERRORS.has(error) ? error : null;
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
    if (response.status === 409) {
      const text = await bodyText(response);
      if (isStaleRevisionText(text)) {
        await identities.release('place', claim);
        return;
      }
      if (text.trim() === '') {
        // An unreadable (empty or whitespace-only) answer is not a verdict:
        // keep the flag and the claim, so the place is sent again when the
        // lease ends.
        logEvent('ocp.place.failed', { messageId, status: 409 });
        return;
      }
      logEvent('ocp.place.rejected', { messageId, status: 409 });
      await identities.finishPlace(claim, 'reject');
      return;
    }
    if (response.status === 400) {
      const text = await bodyText(response);
      const error = oldApiError(text);
      if (error !== null) {
        logEvent('ocp.place.deferred', { messageId, status: 400, error });
        return;
      }
      if (text.trim() === '') {
        // As for 409: no readable answer is no verdict, retry at lease end.
        logEvent('ocp.place.failed', { messageId, status: 400 });
        return;
      }
      logEvent('ocp.place.rejected', { messageId, status: 400 });
      await identities.finishPlace(claim, 'reject');
      return;
    }
    logEvent('ocp.place.failed', { messageId, status: response.status });
  } catch (error) {
    logEvent('ocp.place.failed', { messageId, ...errorLogFields(error) });
  }
}

/**
 * Claim and send at most `WORKER_BATCH` pending OpenCryptoPay place writes,
 * least recently claimed first ({@link ShopIdentityStore.claimPlaces}).
 *
 * Results: `PUT` 2xx clears the place flag (generation-checked) and queues
 * the photos; 201 also nulls the photo hash; `DELETE` 2xx clears the flag;
 * 409 `Stale revision` only releases; a 409 whose body is empty, only
 * whitespace or cannot be read logs `ocp.place.failed` and keeps the flag and
 * the claim, so the next attempt follows when the lease ends; a 400 whose
 * error says the field
 * `nostrPubkey` or `revision` is not allowed (an OpenCryptoPay API without
 * openCryptoPay/api#26) logs `ocp.place.deferred` and keeps the flag and the
 * claim, so the place is sent again when the lease ends; a 400 whose body
 * is empty, only whitespace or cannot be read logs `ocp.place.failed` and
 * keeps the flag and the claim, like the empty 409; any other 400 or another 409 logs
 * `ocp.place.rejected` and clears the flag; anything else logs
 * `ocp.place.failed` and keeps the flag until the lease ends.
 *
 * The pass waits until every claimed row has settled, so no request of this
 * pass is still in flight when the next pass starts. A row whose handling
 * throws (for example a store read before the request) logs
 * `ocp.place.failed` with its message id and keeps the flag until the lease
 * ends; the other rows of the pass are not affected.
 *
 * @param deps - Identities, messages and the map target.
 * @returns Resolves when every claimed row has settled; only a failed claim
 * read rejects.
 */
export async function runOcpPlaceOutboxPass(deps: OcpOutboxDeps): Promise<void> {
  const claims = await deps.identities.claimPlaces(WORKER_BATCH, WORKER_LEASE_MS);
  // Each row's failure is logged and turned into a resolved promise, so the
  // pass waits for every row: a failed row never ends the pass while the other
  // rows' requests are still in flight, which would let the lane start the
  // next pass and overlap two passes' place requests.
  await Promise.all(
    claims.map((claim) =>
      sendPlace(deps, claim).catch((error: unknown) => {
        logEvent('ocp.place.failed', { messageId: claim.messageId, ...errorLogFields(error) });
      }),
    ),
  );
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

/**
 * The note's photos in note order from one read of the whole set, so the
 * hash and the request never mix photo 0 of one set with the extras of
 * another (the generation check of `nextRevision` would already hold such a
 * set back; this keeps the hash itself one real set). The list is every
 * still the set returns, in stored index order: a still with an unrecognized
 * type drops only itself, photo 0 included.
 */
async function notePhotos(messages: MessageStore, messageId: string): Promise<ForumPhoto[]> {
  const { photo, extras } = await messages.getPhotoSet(messageId);
  return [...(photo === null ? [] : [photo]), ...extras.map((extra) => extra.photo)].slice(
    0,
    OCP_PHOTO_LIMIT,
  );
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
 * Claim and send one pending OpenCryptoPay photo set (`PUT /map/places/photos`),
 * least recently claimed first ({@link ShopIdentityStore.claimPhoto}).
 *
 * A shop that is not listed, or whose set hash equals `ocp_photos_hash`, is
 * cleared without a request. Otherwise the revision is reserved first, only
 * while the place is not pending and the photo generation is still the
 * claim's (`nextRevision`); otherwise the claim is released without a
 * request and with the stored hash kept, and the photos are sent after the
 * place lane has settled. After the reservation the hash is nulled, then up
 * to 10 photos are sent in note order as base64.
 * Results: 200 stores the hash
 * (generation-checked) and logs `ocp.photos.skipped` for skipped photos;
 * 409 `Stale revision` nulls the hash and releases; 400 or 413 store the
 * hash and log `ocp.photos.rejected`; 404 `{"error":"Place not found"}`
 * (openCryptoPay/api#26 does not know the place by key) clears the flag and
 * queues the place when still listed; any other 404 (an OpenCryptoPay API
 * without the photo route, i.e. without openCryptoPay/api#26) logs
 * `ocp.photos.deferred`, keeps the flag and the claim, so the photos are
 * tried again when the lease ends, and when still listed queues the place
 * with its lease held until then (`deferPhotos`), so the place request that
 * carries the key is repeated once per lease and stores it once #26 is live;
 * anything else logs `ocp.photos.failed` and keeps the flag until the lease
 * ends.
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
  const revision = await identities.nextRevision('photos', claim);
  if (revision === undefined) {
    // The place is pending, the photo generation moved on, or the claim was
    // taken over: send nothing and release (a lost claim is a no-op). The
    // flag and the stored hash stay, so the photos follow once the place lane
    // has settled and an unchanged set is still not sent again.
    await identities.release('photos', claim);
    return;
  }
  await identities.clearPhotoHash(claim);
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
      const text = await bodyText(response);
      const listed = isListedShop(await deps.messages.getById(messageId));
      if (jsonError(text) === OCP_PLACE_NOT_FOUND) {
        await identities.missingPhotoPlace(claim, listed);
        return;
      }
      // The body is upstream text: log only its length, never its content.
      logEvent('ocp.photos.deferred', {
        messageId,
        status: 404,
        reason: 'route_missing',
        bodyLength: text.length,
      });
      await identities.deferPhotos(claim, listed);
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
 * {@link startOcpOutboxWorker} runs it and, after a failed page, retries it
 * from the last queued page until one attempt succeeds.
 *
 * @param identities - Shop identity store.
 * @param after - Message id to resume after (`null` starts at the first
 *   page).
 * @param onPage - Called with the last message id of each queued page, so a
 *   caller can resume after it.
 * @returns Number of rows queued by this call.
 * @throws When a page read fails; the rows of earlier pages stay queued.
 */
export async function queueAllShopPlaces(
  identities: ShopIdentityStore,
  after: string | null = null,
  onPage?: (last: string) => void,
): Promise<number> {
  let cursor = after;
  let total = 0;
  for (;;) {
    const page = await identities.queueAllPlacePage(cursor, OCP_STARTUP_PAGE);
    total += page.length;
    const last = page[page.length - 1];
    if (last === undefined) return total;
    onPage?.(last);
    if (page.length < OCP_STARTUP_PAGE) return total;
    cursor = last;
  }
}

/**
 * Start the start-up pass and both outbox lanes.
 *
 * The start-up pass ({@link queueAllShopPlaces}) starts at once. When it
 * fails (a page read throws), it logs `ocp.place.failed` with
 * `pass: 'startup'`, the attempt number, `retryInMs` and the safe error
 * fields, and runs again after `intervalMs`, doubling the delay per failed
 * attempt up to `WORKER_LEASE_MS`, until one attempt succeeds. A retry
 * resumes at the failed page (after the last message id of the last queued
 * page), so the rows of earlier pages are queued once and are not re-sent,
 * given a new revision or have their photos held back again. A failure after
 * `stop` is logged without `retryInMs` and not retried.
 *
 * Each lane is serialised: it schedules its next pass `intervalMs` after the
 * previous one settled (also after a failure), so each instance has at most
 * one place pass and one photo upload in flight and a slow pass never stacks
 * database or HTTP work (a place pass settles only after all its claimed rows
 * settled). `stop` clears the pending retry of the start-up pass and both
 * pending lane timers; a pass still in flight then settles without
 * scheduling another.
 *
 * @param deps - Identities, messages and the map target.
 * @param intervalMs - Delay between passes of a lane and first retry delay
 *   of the start-up pass (default `WORKER_INTERVAL_MS`).
 * @returns Handle whose `stop` ends the start-up retries and both lanes.
 */
export function startOcpOutboxWorker(
  deps: OcpOutboxDeps,
  intervalMs: number = WORKER_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let startupAfter: string | null = null;
  const startup = (attempt: number): void => {
    void queueAllShopPlaces(deps.identities, startupAfter, (last) => {
      startupAfter = last;
    }).catch((error: unknown) => {
      const fields = { pass: 'startup', attempt, ...errorLogFields(error) };
      if (stopped) {
        logEvent('ocp.place.failed', fields);
        return;
      }
      const retryInMs = Math.min(intervalMs * 2 ** (attempt - 1), WORKER_LEASE_MS);
      logEvent('ocp.place.failed', { ...fields, retryInMs });
      startupTimer = setTimeout(() => {
        startup(attempt + 1);
      }, retryInMs);
    });
  };
  startup(1);
  const lane = (pass: (deps: OcpOutboxDeps) => Promise<void>, failed: string): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      void pass(deps)
        .catch((error: unknown) => {
          logEvent(failed, errorLogFields(error));
        })
        .finally(() => {
          if (!stopped) timer = setTimeout(run, intervalMs);
        });
    };
    timer = setTimeout(run, intervalMs);
    return () => clearTimeout(timer);
  };
  const stopPlace = lane(runOcpPlaceOutboxPass, 'ocp.place.failed');
  const stopPhoto = lane(runOcpPhotoOutboxPass, 'ocp.photos.failed');
  return {
    stop: () => {
      stopped = true;
      clearTimeout(startupTimer);
      stopPlace();
      stopPhoto();
    },
  };
}
