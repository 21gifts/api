/**
 * Optional map pin on a top-level forum note.
 *
 * A note with no place stays valid. Replies cannot carry a pin. Coordinates
 * are finite numbers in the geographic range; an optional short label is
 * stored beside them and is not a Nostr hashtag. An optional structured
 * address is stored all-or-nothing beside the pin.
 */

import { iso1A2Code } from '@rapideditor/country-coder';

/** Maximum stored place label length after trim. */
export const PLACE_LABEL_MAX = 80;

/** Structured postal address on a forum pin. */
export type ForumPlaceAddress = {
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2, uppercased. */
  country: string;
};

/** Stored / public pin: both coordinates, optional label, optional address. */
export type ForumPlace = {
  lat: number;
  lng: number;
  label: string | null;
  address: ForumPlaceAddress | null;
};

/** 400 body when latitude or longitude is missing or out of range. */
const PLACE_COORD_ERROR = 'Place must be a latitude and longitude' as const;

/** 400 body when the optional label is over-long or has C0/DEL controls. */
const PLACE_LABEL_ERROR = 'Place label must be at most 80 characters' as const;

/** 400 body when the optional structured address fails OpenCryptoPay rules. */
const PLACE_ADDRESS_ERROR = 'Place address is invalid' as const;

const HOUSE_NUMBER = /^[0-9][0-9A-Za-z/ .&–-]{0,31}$/;
const POSTAL_CH_LI = /^[0-9]{4}$/;
const POSTAL_OTHER = /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/;
const CITY_LETTER = /\p{L}/u;

const ADDRESS_KEYS = ['street', 'houseNumber', 'postalCode', 'city', 'country'] as const;

const ISO_COUNTRIES: ReadonlySet<string> = new Set([
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
]);

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
 * Reject C0 controls and DEL.
 *
 * @param value - Candidate string (trimmed or raw).
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

function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const country = raw.trim().toUpperCase();
  if (!ISO_COUNTRIES.has(country)) {
    return null;
  }
  return country;
}

function normalizeStreet(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const street = raw.trim();
  if (street.length < 1 || street.length > 120 || !hasNoControls(street)) {
    return null;
  }
  return street;
}

function normalizeHouseNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (!hasNoControls(raw)) {
    return null;
  }
  const houseNumber = raw.trim();
  if (!HOUSE_NUMBER.test(houseNumber)) {
    return null;
  }
  return houseNumber;
}

function normalizePostalCode(raw: unknown, country: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (!hasNoControls(raw)) {
    return null;
  }
  const postalCode = raw.trim();
  const pattern = country === 'CH' || country === 'LI' ? POSTAL_CH_LI : POSTAL_OTHER;
  if (!pattern.test(postalCode)) {
    return null;
  }
  return postalCode;
}

function normalizeCity(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (!hasNoControls(raw)) {
    return null;
  }
  const city = raw.trim();
  if (city.length < 1 || city.length > 80 || !CITY_LETTER.test(city)) {
    return null;
  }
  return city;
}

/**
 * Validate an optional structured address on a pin.
 *
 * `undefined` or `null` is no address. Otherwise a plain object with exactly
 * the five string keys `street`, `houseNumber`, `postalCode`, `city`, and
 * `country`, each checked with the OpenCryptoPay place rules.
 *
 * @param input - JSON `address` or omitted/null.
 * @returns `{ ok: true, value }` or `{ ok: false }`.
 */
function normalizePlaceAddress(
  input: unknown,
): { ok: true; value: ForumPlaceAddress | null } | { ok: false } {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false };
  }
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== ADDRESS_KEYS.length) {
    return { ok: false };
  }
  for (const key of ADDRESS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) {
      return { ok: false };
    }
  }
  const country = normalizeCountry(rec['country']);
  if (country === null) {
    return { ok: false };
  }
  const street = normalizeStreet(rec['street']);
  if (street === null) {
    return { ok: false };
  }
  const houseNumber = normalizeHouseNumber(rec['houseNumber']);
  if (houseNumber === null) {
    return { ok: false };
  }
  const postalCode = normalizePostalCode(rec['postalCode'], country);
  if (postalCode === null) {
    return { ok: false };
  }
  const city = normalizeCity(rec['city']);
  if (city === null) {
    return { ok: false };
  }
  return {
    ok: true,
    value: { street, houseNumber, postalCode, city, country },
  };
}

function addressesMatch(a: ForumPlaceAddress | null, b: ForumPlaceAddress | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.street === b.street &&
    a.houseNumber === b.houseNumber &&
    a.postalCode === b.postalCode &&
    a.city === b.city &&
    a.country === b.country
  );
}

/**
 * Compare two optional pins.
 *
 * Both absent matches. One absent does not. Otherwise latitude, longitude,
 * label, and address must all be equal.
 *
 * @param a - One pin, or `null` when that side has none.
 * @param b - The other pin, or `null` when that side has none.
 * @returns `true` when the pins are the same.
 */
export function placesMatch(a: ForumPlace | null, b: ForumPlace | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.lat === b.lat &&
    a.lng === b.lng &&
    a.label === b.label &&
    addressesMatch(a.address, b.address)
  );
}

/**
 * Read one multipart coordinate.
 *
 * Blank or missing is `missing`. Anything that is not an explicit decimal is
 * `invalid`, so `Number(" ")` cannot become a pin at zero.
 *
 * @param raw - Multipart field value (`placeLat` or `placeLng`).
 * @returns `'missing'`, `'invalid'`, or a finite number. Overflow to
 *   `Infinity` is `'invalid'`.
 */
export function parseMultipartCoord(raw: unknown): 'missing' | 'invalid' | number {
  if (raw === null || raw === undefined) {
    return 'missing';
  }
  if (typeof raw !== 'string') {
    return 'invalid';
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return 'missing';
  }
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    return 'invalid';
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : 'invalid';
}

/**
 * Validate an optional forum place pin.
 *
 * `undefined` or `null` means no pin. Otherwise a plain object with finite
 * numeric `lat` in `[-90, 90]` and `lng` in `[-180, 180]`. Coordinates are
 * rounded to 6 decimal places (`Math.round(n * 1e6) / 1e6`); `-0` becomes
 * `0`. `label` absent, `null`, or trim-empty becomes `null`. A non-string
 * label is the latitude error. A trimmed label longer than
 * {@link PLACE_LABEL_MAX}, or any character with `charCode < 32` or
 * `=== 127`, is the label-length error. A label never removes the pin:
 * both coordinates or no pin. `address` absent, `undefined`, or `null`
 * becomes `null`. Otherwise a plain object with exactly the five string
 * keys, each trimmed and checked with the OpenCryptoPay rules; any other
 * shape is `{ ok: false, error: 'Place address is invalid' }`.
 *
 * @param input - JSON `place`, multipart-derived object, or omitted/null.
 * @returns `{ ok: true, value: ForumPlace | null }` or `{ ok: false, error }`.
 */
export function normalizePlace(input: unknown):
  | { ok: true; value: ForumPlace | null }
  | {
      ok: false;
      error: typeof PLACE_COORD_ERROR | typeof PLACE_LABEL_ERROR | typeof PLACE_ADDRESS_ERROR;
    } {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: PLACE_COORD_ERROR };
  }
  const rec = input as Record<string, unknown>;
  const lat = rec['lat'];
  const lng = rec['lng'];
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return { ok: false, error: PLACE_COORD_ERROR };
  }
  const rawLabel = rec['label'];
  let label: string | null;
  if (rawLabel === undefined || rawLabel === null) {
    label = null;
  } else if (typeof rawLabel !== 'string') {
    return { ok: false, error: PLACE_COORD_ERROR };
  } else {
    const trimmed = rawLabel.trim();
    if (trimmed.length === 0) {
      label = null;
    } else if (trimmed.length > PLACE_LABEL_MAX) {
      return { ok: false, error: PLACE_LABEL_ERROR };
    } else {
      for (let i = 0; i < trimmed.length; i += 1) {
        const code = trimmed.charCodeAt(i);
        if (code < 32 || code === 127) {
          return { ok: false, error: PLACE_LABEL_ERROR };
        }
      }
      label = trimmed;
    }
  }
  const parsedAddress = normalizePlaceAddress(rec['address']);
  if (!parsedAddress.ok) {
    return { ok: false, error: PLACE_ADDRESS_ERROR };
  }
  return {
    ok: true,
    value: {
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      label,
      address: parsedAddress.value,
    },
  };
}

/**
 * ISO 3166-1 alpha-2 code of the country or territory that contains a pin.
 *
 * Read from the coordinates only, never from the free-text label, with the
 * offline boundary dataset of `@rapideditor/country-coder` (territory level,
 * so Hong Kong is `HK` and Puerto Rico is `PR`; coastal waters count as that
 * country). Ceuta and Melilla, the one territory the dataset returns with a
 * code ISO 3166-1 does not assign (`EA`), take their country's code (`ES`);
 * smaller reserved areas such as Ascension already roll up to an assigned
 * code (`SH`). Kosovo is `XK`. A point
 * in the open sea or outside every boundary has no country. Nothing is stored:
 * the code is derived again on every read, so no pin can carry a stale country.
 *
 * @param place - Pin coordinates (`lat`, `lng`).
 * @returns Two upper-case letters, or `null` when the point lies in no country.
 */
export function placeCountryCode(place: { lat: number; lng: number }): string | null {
  const point: [number, number] = [place.lng, place.lat];
  const territory = iso1A2Code(point, { level: 'territory' });
  return territory === 'EA' ? iso1A2Code(point, { level: 'country' }) : territory;
}
