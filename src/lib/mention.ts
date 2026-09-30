/**
 * `@username` marks in living-room posts and in private threads.
 *
 * A forum post notifies the marked person. An inbox message, a paid inbox
 * gift, and a moderator-room message store the same mark and do not notify.
 * A later rename does not move a stored mark; the account id is resolved
 * at send time.
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
    const previous = i === 0 ? '' : text.charAt(i - 1);
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

/**
 * Resolve conversation `@username` tokens to profile marks.
 *
 * Same token rules as {@link mentionUsernames}. An unknown username is
 * skipped. This does not notify the marked account.
 *
 * @param text - Message body.
 * @param lookup - Account that owns the username now, or undefined.
 * @returns Marks in first-seen order. Empty when the text marks nobody.
 */
export async function resolveMentionMarks(
  text: string,
  lookup: (username: string) => Promise<{ id: string } | undefined>,
): Promise<{ accountId: string; username: string }[]> {
  const marks: { accountId: string; username: string }[] = [];
  for (const username of mentionUsernames(text)) {
    const marked = await lookup(username);
    if (marked !== undefined) {
      marks.push({ accountId: marked.id, username });
    }
  }
  return marks;
}
