/**
 * Completeness rules for a 21.gifts shop pin on the OpenCryptoPay map.
 *
 * A shop is a top-level forum note whose text has `#21GiftsShop`. A shop
 * without a pin stays allowed. A shop with a pin must have a short name
 * that is not the address, a full structured address, and a description.
 */

import type { ForumPlace } from '@/lib/place';

/** Minimum shop description length after the shop tag is stripped. */
export const SHOP_DESCRIPTION_MIN = 20;

/** Maximum shop description length after the shop tag is stripped. */
export const SHOP_DESCRIPTION_MAX = 1000;

const SHOP_NAME_REQUIRED = 'Shop name is required';
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
 * @returns Description ready for the map.
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
