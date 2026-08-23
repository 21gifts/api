/**
 * Display-name validation for an account profile.
 *
 * Names are free-form labels, not unique usernames. Empty, over-long, or
 * control-character input is rejected so a bad value cannot be stored and
 * re-served on every `/me` response.
 */

/** Maximum stored length after trim. */
export const NAME_MAX_LENGTH = 80;

/**
 * Trim and validate a display name.
 *
 * @param raw - User input.
 * @returns The trimmed name, or `null` when it is empty, longer than
 * {@link NAME_MAX_LENGTH}, or contains a C0 control / DEL character
 * (`charCode < 32` or `=== 127`). Internal spaces are kept.
 */
export function normalizeDisplayName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX_LENGTH) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) {
      return null;
    }
  }
  return trimmed;
}
