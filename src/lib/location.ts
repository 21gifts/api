/**
 * Free-text profile location validation.
 *
 * Location is an optional label, not unique and not a setup step. Empty,
 * over-long, or C0/DEL control-character input (`charCode < 32` or `=== 127`)
 * is rejected so a bad value cannot be stored and re-served on every `/me`
 * response. Empty-after-trim is a valid clear (`null`), unlike display names.
 */

/** Maximum stored length after trim. Same cap as display names. */
export const LOCATION_MAX_LENGTH = 80;

/**
 * Trim and validate a free-text profile location.
 *
 * Empty or whitespace-only input becomes `null` (clear). Over-long or
 * C0/DEL control characters (`charCode < 32` or `=== 127`) return a
 * distinct invalid sentinel so the route can 400. Internal spaces kept.
 *
 * @param raw - User input.
 * @returns `{ ok: true, value: string | null }` when the input is empty
 * after trim (clear) or a valid stored string; `{ ok: false }` when it is
 * longer than {@link LOCATION_MAX_LENGTH} or contains a C0 control / DEL
 * character.
 */
export function normalizeLocation(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > LOCATION_MAX_LENGTH) {
    return { ok: false };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) {
      return { ok: false };
    }
  }
  return { ok: true, value: trimmed };
}
