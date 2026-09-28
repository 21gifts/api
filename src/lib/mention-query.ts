/**
 * Normalise a GET /mentions `q` value into a username prefix.
 *
 * Does not parse or store `@username` marks on a note.
 */

const USERNAME_PREFIX = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * Trim, strip one leading `@`, lowercase, and validate a mention prefix.
 *
 * @param raw - The `q` query string, or `undefined` when omitted.
 * @returns A lowercase prefix (`""` when empty), or `null` when invalid.
 */
export function mentionQueryPrefix(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return '';
  }
  let value = raw.trim();
  if (value.startsWith('@')) {
    value = value.slice(1);
  }
  value = value.toLowerCase();
  if (value === '') {
    return '';
  }
  if (value.length > 32) {
    return null;
  }
  if (!USERNAME_PREFIX.test(value)) {
    return null;
  }
  return value;
}
