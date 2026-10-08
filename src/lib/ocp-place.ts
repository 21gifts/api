/**
 * Public OpenCryptoPay place: validated ingest body and shop-note mapping.
 *
 * Coordinates follow the same 6-decimal rounding as forum pins. A shop note
 * pin maps onto one OCP place (`origin` `21gifts`, `techProvider` `21.gifts`).
 */

import { errorLogFields, logEvent } from '@/lib/log';
import type { ForumPlace } from '@/lib/place';
import { SHOP_PLACE_PUSH_ENABLED } from '@/lib/shop-place-push-enabled';
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

/** 400 when latitude or longitude is missing or out of range. */
const PLACE_COORD_ERROR = 'Place must be a latitude and longitude' as const;

/** 400 when `origin` fails the slug rule. */
const PLACE_ORIGIN_ERROR = 'Place origin is invalid' as const;

/** 400 when `externalId` is missing or illegal. */
const PLACE_EXTERNAL_ID_ERROR = 'Place external id is required' as const;

/** 400 when `name` is missing or illegal. */
const PLACE_NAME_ERROR = 'Place name is required' as const;

/** 400 when `category` is missing or illegal. */
const PLACE_CATEGORY_ERROR = 'Place category is required' as const;

/** 400 when `techProvider` is present and illegal. */
const PLACE_TECH_PROVIDER_ERROR = 'Place tech provider is invalid' as const;

/** Maximum stored place name / external id length after trim. */
const PLACE_NAME_MAX = 80;

/** Maximum stored category length after trim. */
const PLACE_CATEGORY_MAX = 40;

/** Allowed payment-method CSV after trim. */
const PAYMENT_METHODS_RE = /^(onchain|lightning|nfc)(,(onchain|lightning|nfc))*$/;

/** Allowed tech-provider slug after trim. */
const TECH_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;

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

/** Cap for one process-start walk of existing shop pins. */
const EXISTING_SHOP_PLACE_LIMIT = 1000;

/** Validated body sent to `PUT /map/places`. */
export type OcpPlaceInput = {
  origin: string;
  externalId: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  paymentMethods: string | null;
  techProvider?: string;
};

/**
 * Round a coordinate to 6 decimal places and collapse `-0` to `0`.
 *
 * @param n - Finite number already range-checked.
 * @returns Rounded value (`0` not `-0`).
 */
function roundCoord(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Reject C0 controls and DEL in a trimmed string.
 *
 * @param value - Already-trimmed candidate.
 * @returns `true` when every character is allowed.
 */
function hasNoControls(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

/**
 * Validate a JSON OCP place body.
 *
 * Object (not array) with finite `lat` in `[-90, 90]` and `lon` in
 * `[-180, 180]` (rounded to 6 decimals; `-0` → `0`). `origin` after trim
 * matches `/^[a-z][a-z0-9-]{0,31}$/`. `externalId` and `name` are trimmed
 * strings of length 1–80 without C0/DEL. `category` is a trimmed string of
 * length 1–40 matching `/^[a-z0-9_-]+$/`. `paymentMethods` absent, null, or
 * `""` → `null`; a trim-matching onchain/lightning/nfc CSV is kept trimmed;
 * any other value becomes `null` (no 400). `techProvider` omitted, null, or
 * trim-empty → omitted; a trim-matching `/^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/`
 * string is kept trimmed; any other value is 400.
 *
 * @param input - JSON body.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function normalizeOcpPlace(
  input: unknown,
): { ok: true; value: OcpPlaceInput } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: PLACE_COORD_ERROR };
  }
  const rec = input as Record<string, unknown>;
  const lat = rec['lat'];
  const lon = rec['lon'];
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { ok: false, error: PLACE_COORD_ERROR };
  }

  const rawOrigin = rec['origin'];
  if (typeof rawOrigin !== 'string') {
    return { ok: false, error: PLACE_ORIGIN_ERROR };
  }
  const origin = rawOrigin.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(origin)) {
    return { ok: false, error: PLACE_ORIGIN_ERROR };
  }

  const rawExternalId = rec['externalId'];
  if (typeof rawExternalId !== 'string') {
    return { ok: false, error: PLACE_EXTERNAL_ID_ERROR };
  }
  const externalId = rawExternalId.trim();
  if (externalId.length < 1 || externalId.length > PLACE_NAME_MAX || !hasNoControls(externalId)) {
    return { ok: false, error: PLACE_EXTERNAL_ID_ERROR };
  }

  const rawName = rec['name'];
  if (typeof rawName !== 'string') {
    return { ok: false, error: PLACE_NAME_ERROR };
  }
  const name = rawName.trim();
  if (name.length < 1 || name.length > PLACE_NAME_MAX || !hasNoControls(name)) {
    return { ok: false, error: PLACE_NAME_ERROR };
  }

  const rawCategory = rec['category'];
  if (typeof rawCategory !== 'string') {
    return { ok: false, error: PLACE_CATEGORY_ERROR };
  }
  const category = rawCategory.trim();
  if (
    category.length < 1 ||
    category.length > PLACE_CATEGORY_MAX ||
    !/^[a-z0-9_-]+$/.test(category)
  ) {
    return { ok: false, error: PLACE_CATEGORY_ERROR };
  }

  const rawPayment = rec['paymentMethods'];
  let paymentMethods: string | null;
  if (rawPayment === undefined || rawPayment === null) {
    paymentMethods = null;
  } else if (typeof rawPayment !== 'string') {
    paymentMethods = null;
  } else {
    const trimmed = rawPayment.trim();
    if (trimmed === '') {
      paymentMethods = null;
    } else if (PAYMENT_METHODS_RE.test(trimmed)) {
      paymentMethods = trimmed;
    } else {
      paymentMethods = null;
    }
  }

  const rawTech = rec['techProvider'];
  let techProvider: string | undefined;
  if (rawTech === undefined || rawTech === null) {
    techProvider = undefined;
  } else if (typeof rawTech !== 'string') {
    return { ok: false, error: PLACE_TECH_PROVIDER_ERROR };
  } else {
    const trimmed = rawTech.trim();
    if (trimmed === '') {
      techProvider = undefined;
    } else if (TECH_PROVIDER_RE.test(trimmed)) {
      techProvider = trimmed;
    } else {
      return { ok: false, error: PLACE_TECH_PROVIDER_ERROR };
    }
  }

  return {
    ok: true,
    value: {
      origin,
      externalId,
      name,
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      category,
      paymentMethods,
      ...(techProvider === undefined ? {} : { techProvider }),
    },
  };
}

/**
 * Display name for a shop OCP place: pin label, else author name, else
 * `"Shop"`, truncated to 80 characters.
 *
 * @param place - Forum pin just written.
 * @param authorName - Message author display name, if any.
 * @returns Trimmed name of length 1–80.
 */
export function shopOcpPlaceName(place: ForumPlace, authorName: string | null | undefined): string {
  const fromLabel = place.label !== null && place.label.trim() !== '' ? place.label.trim() : null;
  const fromAuthor =
    typeof authorName === 'string' && authorName.trim() !== '' ? authorName.trim() : null;
  const raw = fromLabel ?? fromAuthor ?? 'Shop';
  return raw.length > PLACE_NAME_MAX ? raw.slice(0, PLACE_NAME_MAX) : raw;
}

/**
 * Build the OCP ingest input for a shop pin.
 *
 * @param messageId - Forum message id (`externalId`).
 * @param place - Forum pin (lat/lng; mapped to lat/lon).
 * @param authorName - Message author display name, if any.
 * @returns Input with `origin` `21gifts`, `techProvider` `21.gifts`,
 *   `category` `shopping`, `paymentMethods` `lightning`.
 */
export function shopOcpPlaceInput(
  messageId: string,
  place: ForumPlace,
  authorName: string | null | undefined,
): OcpPlaceInput {
  return {
    origin: SHOP_ORIGIN,
    externalId: messageId,
    name: shopOcpPlaceName(place, authorName),
    lat: place.lat,
    lon: place.lng,
    category: SHOP_CATEGORY,
    paymentMethods: SHOP_PAYMENT_METHODS,
    techProvider: SHOP_TECH_PROVIDER,
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
 * allowlisted `code` or `errno` from the error or its cause, and never the message.
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
 * PUT a shop pin to the OpenCryptoPay map.
 *
 * Only when `parentId` is null, the text contains `#21GiftsShop`, a pin is
 * present, and `mapPush` is configured. A pin that already existed is still
 * sent. BTC Map is not called here. Failures are logged as `ocp.place.failed`
 * and swallowed.
 *
 * @param opts - Optional map push, message fields, and pin.
 */
export async function syncShopOcpPlace(opts: {
  mapPush?: MapPush;
  messageId: string;
  text: string;
  parentId: string | null;
  place: ForumPlace | null;
  authorName: string | null | undefined;
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
  const mapPush = opts.mapPush;
  await mapPlacesRequest(
    mapPush,
    'PUT',
    shopOcpPlaceInput(opts.messageId, opts.place, opts.authorName),
  );
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
 * pin, and notes without the shop tag are skipped. A later 200 is success.
 * BTC Map is not called here. Failures are logged as `ocp.place.failed` and
 * swallowed.
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
    await mapPlacesRequest(mapPush, 'PUT', shopOcpPlaceInput(row.id, row.place, row.name));
  }
}
