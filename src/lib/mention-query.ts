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

/**
 * Whether an already-normalised mention token hits this account.
 *
 * `query` is `""` or a token from `mentionQueryPrefix`. Empty matches.
 * Otherwise the token must start the trimmed username, a username segment
 * split on `.` `_` `-`, the trimmed display name, or a display-name word
 * split on space `.` `_` `-`. A null or blank display name does not match
 * by name. Comparison is lowercase. `_` is a literal separator, not a wildcard.
 *
 * @param username - Stored handle. Not pre-trimmed.
 * @param displayName - Stored display name, not the username fallback.
 * @param query - `""` or a normalised token.
 * @returns True when the token hits.
 */
export function mentionAccountMatches(
  username: string,
  displayName: string | null | undefined,
  query: string,
): boolean {
  if (query === '') {
    return true;
  }
  const handle = username.trim().toLowerCase();
  if (handle.startsWith(query)) {
    return true;
  }
  for (const part of handle.split(/[._-]+/)) {
    if (part.startsWith(query)) {
      return true;
    }
  }
  const name = (displayName ?? '').trim().toLowerCase();
  if (name === '') {
    return false;
  }
  if (name.startsWith(query)) {
    return true;
  }
  for (const part of name.split(/[ ._-]+/)) {
    if (part.startsWith(query)) {
      return true;
    }
  }
  return false;
}
