/**
 * `@username` marks in living-room post text.
 *
 * Only {@link persistForumPost} parses marks. A later rename does not move
 * a stored mark; the account id is resolved at send time.
 */

import { normalizeUsername } from '@/lib/username';

/** Characters that may appear in a mark token (and that bind a preceding `@`). */
const USERNAME_CHAR = /[A-Za-z0-9._-]/;

/**
 * Collect unique `@username` tokens from forum text, first-seen order.
 *
 * A mark starts at `@` only when it is at index 0 or the previous character
 * is not in `[A-Za-z0-9._-]`. Then consume the longest run of that class.
 * Keep the token only when {@link normalizeUsername} returns a string.
 * Do not shorten a too-long or dotted run. Returned strings are normalised
 * (lowercase).
 *
 * @param text - Forum body (already normalised).
 * @returns Distinct normalised usernames in first-seen order.
 */
export function mentionUsernames(text: string): string[] {
  const seen = new Set<string>();
  const usernames: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') {
      continue;
    }
    const previous = i === 0 ? '' : (text[i - 1] ?? '');
    if (previous !== '' && USERNAME_CHAR.test(previous)) {
      continue;
    }
    let end = i + 1;
    while (end < text.length && USERNAME_CHAR.test(text.charAt(end))) {
      end += 1;
    }
    const token = text.slice(i + 1, end);
    const username = normalizeUsername(token);
    if (username !== null && !seen.has(username)) {
      seen.add(username);
      usernames.push(username);
    }
    i = end - 1;
  }
  return usernames;
}
