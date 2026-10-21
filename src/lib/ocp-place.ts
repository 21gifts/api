/**
 * Public OpenCryptoPay place: shop-note mapping and map ingest.
 *
 * Coordinates follow the same 6-decimal rounding as forum pins. A complete
 * shop note pin maps onto one OCP place (`origin` `21gifts`, `techProvider`
 * `21.gifts`). An incomplete shop is not put; the place outbox
 * (`src/lib/ocp-outbox.ts`) sends `DELETE` for a keyed shop that is no longer
 * listed, so an older complete version does not stay on the map.
 */

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
