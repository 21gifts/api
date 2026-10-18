/**
 * Public OpenCryptoPay place: shop-note mapping and map ingest.
 *
 * Coordinates follow the same 6-decimal rounding as forum pins. A complete
 * shop note pin maps onto one OCP place (`origin` `21gifts`, `techProvider`
 * `21.gifts`). An incomplete shop is not put; edit synchronization may delete
 * it so an older complete version does not stay on the map.
 */

import { errorLogFields, logEvent } from '@/lib/log';
import type { ForumPlace } from '@/lib/place';
import { SHOP_PLACE_PUSH_ENABLED } from '@/lib/shop-place-push-enabled';
import { shopDescription, shopPlaceProblem, shopTextProblem } from '@/lib/shop-place';

/** HTTP fetch for the map ingest. */
export type MapFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Where a shop pin is put or deleted. Both fields are required together. */
export type MapPush = {
  baseUrl: string;
  token: string;
  fetchImpl: MapFetch;
};

/**
 * Build a map push from the environment. Off while
 * {@link SHOP_PLACE_PUSH_ENABLED} is false, even when both variables are set.
 * A blank URL or token also means no push.
 *
 * @param env - `OCP_MAP_BASE_URL` and `OCP_PLACE_INGEST_TOKEN`.
 * @param fetchImpl - HTTP fetch.
 * @returns The push target, or `undefined`.
 */
export function resolveMapPush(
  env: Record<string, string | undefined>,
  fetchImpl: MapFetch,
): MapPush | undefined {
  if (!SHOP_PLACE_PUSH_ENABLED) {
    return undefined;
  }
  const rawUrl = env['OCP_MAP_BASE_URL'];
  const rawToken = env['OCP_PLACE_INGEST_TOKEN'];
  if (rawUrl === undefined || rawUrl.trim() === '') {
    return undefined;
  }
  if (rawToken === undefined || rawToken.trim() === '') {
    return undefined;
  }
  return {
    baseUrl: rawUrl.trim().replace(/\/+$/u, ''),
    token: rawToken.trim(),
    fetchImpl,
  };
}

/** Shop hashtag that triggers an OCP place. */
const SHOP_HASHTAG = '21GiftsShop';

/** Fixed origin for forum shop pins. */
const SHOP_ORIGIN = '21gifts';

/** Fixed tech provider for forum shop pins. */
const SHOP_TECH_PROVIDER = '21.gifts';

/** Fixed category for forum shop pins. */
const SHOP_CATEGORY = 'shopping';

/** Fixed payment methods for forum shop pins. */
const SHOP_PAYMENT_METHODS = 'lightning';

/** Fixed shop type for forum shop pins. */
const SHOP_TYPE = 'Others' as const;

/** Cap for one process-start walk of existing shop pins. */
const EXISTING_SHOP_PLACE_LIMIT = 1000;

/** Body sent to `PUT /map/places` for a complete 21.gifts shop. */
export type OcpPlaceInput = {
  origin: string;
  externalId: string;
  name: string;
  description: string;
  lat: number;
  lon: number;
  category: string;
  paymentMethods: string;
  techProvider: string;
  shopType: 'Others';
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
};

/**
 * Build the OCP ingest input for a shop pin.
 *
 * Returns `null` when {@link shopPlaceProblem} or {@link shopTextProblem}
 * reports a problem. The name is the pin label. The description is
 * {@link shopDescription} of the note text.
 *
 * @param messageId - Forum message id (`externalId`).
 * @param text - Stored note text.
 * @param place - Forum pin (lat/lng; mapped to lat/lon).
 * @returns Complete ingest body, or `null` when the shop is incomplete.
 */
export function shopOcpPlaceInput(
  messageId: string,
  text: string,
  place: ForumPlace,
): OcpPlaceInput | null {
  if (shopPlaceProblem(place) !== null || shopTextProblem(text, place) !== null) {
    return null;
  }
  const address = place.address;
  const name = place.label;
  /* v8 ignore next 3 -- shopPlaceProblem already rejected a missing name or address */
  if (address === null || name === null) {
    return null;
  }
  return {
    origin: SHOP_ORIGIN,
    externalId: messageId,
    name,
    description: shopDescription(text),
    lat: place.lat,
    lon: place.lng,
    category: SHOP_CATEGORY,
    paymentMethods: SHOP_PAYMENT_METHODS,
    techProvider: SHOP_TECH_PROVIDER,
    shopType: SHOP_TYPE,
    street: address.street,
    houseNumber: address.houseNumber,
    postalCode: address.postalCode,
    city: address.city,
    country: address.country,
  };
}

/**
 * Allowlisted fields for a thrown map ingest error, including a syscall code on `cause`.
 *
 * @param error - Thrown value.
 * @returns Fields for `ocp.place.failed`; empty when nothing is allowlisted.
 */
function mapPlacesCatchFields(error: unknown): ReturnType<typeof errorLogFields> {
  const outer = errorLogFields(error);
  if (outer['code'] !== undefined || outer['errno'] !== undefined) {
    return outer;
  }
  if (!(error instanceof Error) || error.cause === null || error.cause === undefined) {
    return outer;
  }
  const cause = errorLogFields(error.cause);
  const fields: { [key: string]: string | number | boolean } = { ...outer };
  if (cause['code'] !== undefined) {
    fields['code'] = cause['code'];
  }
  if (cause['errno'] !== undefined) {
    fields['errno'] = cause['errno'];
  }
  return fields;
}

/**
 * PUT or DELETE one map place. Failures are logged as `ocp.place.failed` and swallowed.
 * The failure log includes the HTTP status, or the allowlisted error name and an
 * allowlisted `code` or `errno` from the error or its cause, and never the message,
 * the address, or the bearer.
 *
 * @param mapPush - Configured map target.
 * @param method - `PUT` (pin body) or `DELETE` (`origin` + `externalId`).
 * @param body - JSON body.
 */
async function mapPlacesRequest(
  mapPush: MapPush,
  method: 'PUT' | 'DELETE',
  body: unknown,
): Promise<void> {
  try {
    const response = await mapPush.fetchImpl(`${mapPush.baseUrl}/map/places`, {
      method,
      headers: {
        Authorization: `Bearer ${mapPush.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logEvent('ocp.place.failed', { status: response.status });
    }
  } catch (error) {
    const fields = mapPlacesCatchFields(error);
    if (Object.keys(fields).length === 0) {
      logEvent('ocp.place.failed');
    } else {
      logEvent('ocp.place.failed', fields);
    }
  }
}

/**
 * PUT a complete shop pin, or with `removeWhenIncomplete` DELETE an incomplete one.
 *
 * Only when `parentId` is null, the text contains `#21GiftsShop`, a pin is
 * present, {@link shopOcpPlaceInput} is non-null, and `mapPush` is configured.
 * An incomplete existing shop is normally not sent. When `removeWhenIncomplete`
 * is true, it is deleted instead: concurrent place and text edits can leave an
 * incomplete pair, and removing it keeps the map from showing the stale shop.
 * A pin that already existed is still sent when complete. BTC Map is not called
 * here. Failures are logged as `ocp.place.failed` and swallowed.
 *
 * @param opts - Optional map push, message fields, pin, and incomplete-removal policy.
 */
export async function syncShopOcpPlace(opts: {
  mapPush?: MapPush;
  messageId: string;
  text: string;
  parentId: string | null;
  place: ForumPlace | null;
  /** Whether an incomplete shop should be deleted from the map. */
  removeWhenIncomplete?: boolean;
  /** Hashtag token check (injected so tests need not import the message helper). */
  textHasHashtagToken: (text: string, name: string) => boolean;
}): Promise<void> {
  if (
    opts.parentId !== null ||
    opts.place === null ||
    !opts.textHasHashtagToken(opts.text, SHOP_HASHTAG) ||
    opts.mapPush === undefined
  ) {
    return;
  }
  const body = shopOcpPlaceInput(opts.messageId, opts.text, opts.place);
  if (body === null) {
    if (opts.removeWhenIncomplete === true) {
      await removeShopOcpPlace({ mapPush: opts.mapPush, messageId: opts.messageId });
    }
    return;
  }
  await mapPlacesRequest(opts.mapPush, 'PUT', body);
}

/**
 * DELETE a shop pin from the OpenCryptoPay map.
 *
 * No-op when `mapPush` is missing. Failures are logged as `ocp.place.failed`
 * and swallowed.
 *
 * @param opts - Optional map push and forum message id (`externalId`).
 */
export async function removeShopOcpPlace(opts: {
  mapPush?: MapPush;
  messageId: string;
}): Promise<void> {
  if (opts.mapPush === undefined) {
    return;
  }
  await mapPlacesRequest(opts.mapPush, 'DELETE', {
    origin: SHOP_ORIGIN,
    externalId: opts.messageId,
  });
}

type ExistingShopNote = {
  id: string;
  text: string;
  name: string;
  parentId: string | null;
  place?: ForumPlace | null;
  deletedAt?: Date | null;
};

/**
 * PUT each existing live top-level shop pin to the OpenCryptoPay map.
 *
 * A missing map push does nothing. Replies, hidden notes, notes without a
 * pin, notes without the shop tag, and incomplete shops are skipped. A later
 * 200 is success. BTC Map is not called here. Failures are logged as
 * `ocp.place.failed` and swallowed.
 *
 * @param opts - Optional map push, listed pin ids, row loader, and hashtag check.
 */
export async function publishExistingShopPlaces(opts: {
  mapPush?: MapPush;
  listPlaces: (limit: number) => Promise<ReadonlyArray<{ id: string }>>;
  getById: (id: string) => Promise<ExistingShopNote | undefined>;
  textHasHashtagToken: (text: string, name: string) => boolean;
}): Promise<void> {
  if (opts.mapPush === undefined) {
    return;
  }
  const mapPush = opts.mapPush;
  let listed: ReadonlyArray<{ id: string }>;
  try {
    listed = await opts.listPlaces(EXISTING_SHOP_PLACE_LIMIT);
  } catch {
    logEvent('ocp.place.failed');
    return;
  }
  for (const item of listed) {
    let row: ExistingShopNote | undefined;
    try {
      row = await opts.getById(item.id);
    } catch {
      logEvent('ocp.place.failed');
      continue;
    }
    if (
      row === undefined ||
      row.parentId !== null ||
      (row.deletedAt !== null && row.deletedAt !== undefined) ||
      row.place === null ||
      row.place === undefined ||
      !opts.textHasHashtagToken(row.text, SHOP_HASHTAG)
    ) {
      continue;
    }
    const body = shopOcpPlaceInput(row.id, row.text, row.place);
    if (body === null) {
      continue;
    }
    await mapPlacesRequest(mapPush, 'PUT', body);
  }
}
