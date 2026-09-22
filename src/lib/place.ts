/**
 * Optional map pin on a top-level forum note.
 *
 * A note with no place stays valid. Replies cannot carry a pin. Coordinates
 * are finite numbers in the geographic range; an optional short label is
 * stored beside them and is not a Nostr hashtag.
 */

/** Maximum stored place label length after trim. */
export const PLACE_LABEL_MAX = 80;

/** Stored / public pin: both coordinates, optional label. */
export type ForumPlace = { lat: number; lng: number; label: string | null };

/** 400 body when latitude or longitude is missing or out of range. */
const PLACE_COORD_ERROR = 'Place must be a latitude and longitude' as const;

/** 400 body when the optional label is over-long or has C0/DEL controls. */
const PLACE_LABEL_ERROR = 'Place label must be at most 80 characters' as const;

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
 * Validate an optional forum place pin.
 *
 * `undefined` or `null` means no pin. Otherwise a plain object with finite
 * numeric `lat` in `[-90, 90]` and `lng` in `[-180, 180]`. Coordinates are
 * rounded to 6 decimal places (`Math.round(n * 1e6) / 1e6`); `-0` becomes
 * `0`. `label` absent, `null`, or trim-empty becomes `null`. A non-string
 * label is the latitude error. A trimmed label longer than
 * {@link PLACE_LABEL_MAX}, or any character with `charCode < 32` or
 * `=== 127`, is the label-length error. A label never removes the pin:
 * both coordinates or no pin.
 *
 * @param input - JSON `place`, multipart-derived object, or omitted/null.
 * @returns `{ ok: true, value: ForumPlace | null }` or `{ ok: false, error }`.
 */
export function normalizePlace(
  input: unknown,
):
  | { ok: true; value: ForumPlace | null }
  | { ok: false; error: typeof PLACE_COORD_ERROR | typeof PLACE_LABEL_ERROR } {
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
  return {
    ok: true,
    value: { lat: roundCoord(lat), lng: roundCoord(lng), label },
  };
}
