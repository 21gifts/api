/**
 * Completeness rules for a 21.gifts shop pin on the OpenCryptoPay map.
 *
 * A shop is a top-level forum note whose text has `#21GiftsShop` and a till
 * account. Creating one requires a pin, because the shop name is the pin
 * label; the route rejects a missing pin with `Shop name is required`.
 * The public directory lists every such note. A pin and a structured
 * address are optional there. The map still requires a short name that is not
 * the address, a full structured address, and a description.
 */

import type { ForumPlace, ForumPlaceAddress } from '@/lib/place';

/** Minimum shop description length after the shop tag is stripped. */
export const SHOP_DESCRIPTION_MIN = 20;

/** Maximum shop description length after the shop tag is stripped. */
export const SHOP_DESCRIPTION_MAX = 1000;

/** Caller-visible error when a shop note has no shop name. */
export const SHOP_NAME_REQUIRED = 'Shop name is required';
const SHOP_NAME_CONTAINS_ADDRESS = 'Shop name must not contain the address';
const SHOP_ADDRESS_REQUIRED = 'Shop address is required';
const SHOP_DESCRIPTION_RANGE =
  'Shop description must be 20 to 1000 characters and longer than the shop name';

const SHOP_HASHTAG_TOKEN = /#21GiftsShop(?![A-Za-z0-9_])/gi;

/**
 * Escape a string so it is safe inside a `RegExp` constructor.
 *
 * @param value - Literal token.
 * @returns Escaped pattern.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `name` contains `token` as a standalone word.
 *
 * Boundaries are letters and numbers (`\p{L}` / `\p{N}`), case-insensitive.
 *
 * @param name - Shop name (pin label).
 * @param token - Street or postal code.
 * @returns `true` when the token appears as a whole word.
 */
function containsStandaloneToken(name: string, token: string): boolean {
  if (token === '') {
    return false;
  }
  const escaped = escapeRegex(token);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(name);
}

/**
 * Whether the shop name contains the street or postal code as a whole word.
 *
 * @param name - Shop name (pin label).
 * @param street - Structured street.
 * @param postalCode - Structured postal code.
 * @returns `true` when the name embeds the address.
 */
function nameContainsAddress(name: string, street: string, postalCode: string): boolean {
  return containsStandaloneToken(name, street) || containsStandaloneToken(name, postalCode);
}

/**
 * Note text without the shop tag (same rule as the app's `stripShopHashtag`).
 *
 * Converts CRLF to LF, removes every case-insensitive `#21GiftsShop` token
 * not followed by `[A-Za-z0-9_]`, collapses 3+ newlines to 2, and trims.
 *
 * @param text - Stored or submitted note text.
 * @returns Description for the map, the shop kind 0 `about`, and `GET /shops/:npub`.
 */
export function shopDescription(text: string): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const stripped = lf.replace(SHOP_HASHTAG_TOKEN, '');
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Name and address problems of a shop pin, or null when both are complete.
 *
 * Order: name required, then address required, then name must not contain
 * the street or postal code as a standalone token.
 *
 * @param place - Forum pin on a shop note.
 * @returns A fixed English error, or `null`.
 */
export function shopPlaceProblem(place: ForumPlace): string | null {
  const label = place.label;
  if (label === null || label.trim() === '') {
    return SHOP_NAME_REQUIRED;
  }
  if (place.address === null) {
    return SHOP_ADDRESS_REQUIRED;
  }
  if (nameContainsAddress(label, place.address.street, place.address.postalCode)) {
    return SHOP_NAME_CONTAINS_ADDRESS;
  }
  return null;
}

/**
 * Description problem of a shop note, or null when it is complete.
 *
 * The description is {@link shopDescription} (CRLF already folded to LF).
 * It must be 20–1000 characters, strictly longer than the pin label, and
 * not equal to the label case-insensitively. A missing label is compared
 * as the empty string.
 *
 * @param text - Stored or submitted note text.
 * @param place - Forum pin, or `null` when the note has none.
 * @returns A fixed English error, or `null`.
 */
export function shopTextProblem(text: string, place: ForumPlace | null): string | null {
  const description = shopDescription(text);
  const name = place === null || place.label === null ? '' : place.label;
  if (
    description.length < SHOP_DESCRIPTION_MIN ||
    description.length > SHOP_DESCRIPTION_MAX ||
    description.length <= name.length ||
    description.toLowerCase() === name.toLowerCase()
  ) {
    return SHOP_DESCRIPTION_RANGE;
  }
  return null;
}

/** {@link SHOP_HASHTAG_TOKEN} without the global flag, for a stateless `test`. */
const SHOP_HASHTAG_PRESENT = new RegExp(SHOP_HASHTAG_TOKEN.source, 'i');

/** Note fields that decide whether a forum note is a listed shop. */
export interface ShopListingFields {
  /** Parent note id; a listed shop is top-level (`null`). */
  parentId: string | null;
  /** Hide or delete time; a listed shop is live (`null`). */
  deletedAt: Date | null;
  /** Stored note text. */
  text: string;
  /** Place pin, if any. */
  place?: ForumPlace | null;
  /** Assigned till account, if any. */
  shopAccount?: { id: string } | null;
}

/** A listed shop: its name and its complete pin. */
export interface ListedShop {
  /** Shop name (the pin label). */
  name: string;
  /** Complete pin with its structured address. */
  place: { lat: number; lng: number; label: string; address: ForumPlaceAddress };
  /** Till account id (`shop_account_id`). */
  tillAccountId: string;
}

/**
 * The listed shop of a note, or `null` when the note is not listed.
 *
 * Listed means: top-level, live, the `#21GiftsShop` token (same rule as
 * `GET /shops/activity`), a pin, a till account, and complete under
 * {@link shopPlaceProblem} and {@link shopTextProblem}.
 *
 * @param row - Forum note, or `undefined` when it does not exist.
 * @returns Name and complete pin, or `null`.
 */
export function listedShop(row: ShopListingFields | undefined): ListedShop | null {
  if (
    row === undefined ||
    row.parentId !== null ||
    row.deletedAt !== null ||
    row.shopAccount === undefined ||
    row.shopAccount === null ||
    row.place === undefined ||
    row.place === null ||
    row.place.label === null ||
    row.place.address === null ||
    !SHOP_HASHTAG_PRESENT.test(row.text) ||
    shopPlaceProblem(row.place) !== null ||
    shopTextProblem(row.text, row.place) !== null
  ) {
    return null;
  }
  const { lat, lng, label, address } = row.place;
  return { name: label, place: { lat, lng, label, address }, tillAccountId: row.shopAccount.id };
}

/**
 * Shop name of a listed shop, or `null` (see {@link listedShop}).
 *
 * @param row - Forum note, or `undefined`.
 * @returns The pin label, or `null`.
 */
export function listedShopName(row: ShopListingFields | undefined): string | null {
  return listedShop(row)?.name ?? null;
}

/**
 * Whether a note is a listed shop (see {@link listedShop}).
 *
 * @param row - Forum note, or `undefined`.
 * @returns `true` when the note is listed.
 */
export function isListedShop(row: ShopListingFields | undefined): boolean {
  return listedShop(row) !== null;
}

/** Longest public shop name taken from the description when the pin has no label. */
const PUBLIC_SHOP_NAME_MAX = 80;

/** Fallback public name when a shop note has neither a label nor a description. */
const PUBLIC_SHOP_NAME_FALLBACK = 'Shop';

/**
 * A shop on the public directory: live, top-level, tagged, with a till.
 * The pin and its structured address may be missing.
 */
export interface PublicShop {
  /** Pin label, or the description's first line, or {@link PUBLIC_SHOP_NAME_FALLBACK}. */
  name: string;
  /** Coordinates when the note has them. `address` is null until it is complete. */
  place: { lat: number; lng: number; label: string; address: ForumPlaceAddress | null } | null;
  /** Till account id (`shop_account_id`). */
  tillAccountId: string;
}

/**
 * Structured address, or null when any part is missing or blank.
 *
 * @param address - Stored address, or null.
 * @returns The same address when every part is non-blank, otherwise null.
 */
function completeAddress(address: ForumPlaceAddress | null): ForumPlaceAddress | null {
  if (
    address === null ||
    address.street.trim() === '' ||
    address.houseNumber.trim() === '' ||
    address.postalCode.trim() === '' ||
    address.city.trim() === '' ||
    address.country.trim() === ''
  ) {
    return null;
  }
  return address;
}

/**
 * Public name of a shop note.
 *
 * A non-blank pin label is the name, unchanged. Otherwise the name is the
 * first non-blank line of {@link shopDescription}, cut at 80 characters, or
 * `Shop` when that line is empty.
 *
 * @param text - Stored note text.
 * @param place - Pin, or null.
 * @returns A non-empty name.
 */
export function publicShopName(text: string, place: ForumPlace | null): string {
  const label = place?.label ?? null;
  if (label !== null && label.trim() !== '') return label;
  const line =
    shopDescription(text)
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? '';
  if (line === '') return PUBLIC_SHOP_NAME_FALLBACK;
  return line.length <= PUBLIC_SHOP_NAME_MAX ? line : line.slice(0, PUBLIC_SHOP_NAME_MAX).trimEnd();
}

/**
 * The public shop of a note, or null when the note is not a shop.
 *
 * A public shop is top-level, live, tagged `#21GiftsShop`, and has a till
 * account. It does not need a pin, a structured address, or a description
 * that passes {@link shopTextProblem}. The map still uses {@link listedShop}.
 *
 * @param row - Forum note, or `undefined` when it does not exist.
 * @returns Name, optional pin, and till account, or null.
 */
export function publicShop(row: ShopListingFields | undefined): PublicShop | null {
  if (
    row === undefined ||
    row.parentId !== null ||
    row.deletedAt !== null ||
    row.shopAccount === undefined ||
    row.shopAccount === null ||
    !SHOP_HASHTAG_PRESENT.test(row.text)
  ) {
    return null;
  }
  const place = row.place === undefined || row.place === null ? null : row.place;
  const published =
    place === null || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)
      ? null
      : {
          lat: place.lat,
          lng: place.lng,
          label: place.label ?? '',
          address: completeAddress(place.address),
        };
  return {
    name: publicShopName(row.text, place),
    place: published,
    tillAccountId: row.shopAccount.id,
  };
}

/**
 * The note fields a shop's public state is built from, as one comparable
 * string: text (listing tag, description), pin (name, place), till account id
 * and `deletedAt` (listed). Two reads of a note with the same fingerprint
 * give the same listing, name, description and till account; `parentId`,
 * `createdAt` and the id do not change. `GET /shops/:npub`, the shop kind 0
 * and the in-memory place queue compare reads with it.
 *
 * @param row - Forum note, or `undefined` when it does not exist.
 * @returns `'missing'` for `undefined`, otherwise the JSON of those fields.
 */
export function shopListingFingerprint(row: ShopListingFields | undefined): string {
  if (row === undefined) return 'missing';
  return JSON.stringify([row.text, row.place, row.shopAccount?.id, row.deletedAt]);
}
