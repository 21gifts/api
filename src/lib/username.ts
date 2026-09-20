/**
 * Unique account username (NIP-05 local-part and LUD-16 handle).
 *
 * Charset is LUD-16 local-part: lowercase `a-z0-9-_.` only. Hyphen,
 * underscore, and dot are allowed; `+` is not stored. `_` alone is
 * forbidden because LUD-16 uses it as the default identifier.
 */

import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { allocateNip05Local, nip05Slug } from '@/lib/nip05';

/** Maximum stored length after trim/lower. */
export const USERNAME_MAX_LENGTH = 32;

const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * Trim, lowercase, and validate a LUD-16 / NIP-05 local-part.
 *
 * @param raw - The handle as entered by the user.
 * @returns The normalised username, or `null` when it is empty, `_`,
 *   longer than {@link USERNAME_MAX_LENGTH}, or outside `a-z0-9-_.`
 *   with a leading letter or digit.
 */
export function normalizeUsername(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > USERNAME_MAX_LENGTH) {
    return null;
  }
  if (trimmed === '_') {
    return null;
  }
  if (!USERNAME.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Derive a username from a display name using {@link nip05Slug}.
 *
 * Returns `null` when the slug is empty/`user` (punctuation-only names
 * slug to `user`) or fails {@link normalizeUsername}. Does not add
 * collision suffixes — the caller checks uniqueness.
 *
 * @param name - Account display name.
 * @returns A normalised handle, or `null`.
 */
export function usernameFromDisplayName(name: string): string | null {
  const slug = nip05Slug(name);
  // Empty / punctuation-only names slug to 'user' (nip05Slug never returns '').
  if (slug === 'user') {
    return null;
  }
  return normalizeUsername(slug);
}

/**
 * Assign usernames to named accounts that still have none.
 *
 * Oldest-first ({@link AuthStore.listAccounts} order). Uses
 * {@link allocateNip05Local} so existing NIP-05 locals (including
 * suffixes) are preserved. Nameless accounts stay `null`. Already-set
 * handles are kept and reserved. The fallback slug `user` is stored
 * only when allocation produces a unique `user` / `user-<suffix>` that
 * passes {@link normalizeUsername}.
 *
 * @param store - Auth persistence.
 * @returns The number of accounts updated.
 */
export async function backfillAccountUsernames(store: AuthStore): Promise<number> {
  const accounts = await store.listAccounts();
  const taken = new Set<string>();
  for (const account of accounts) {
    const raw = account.username;
    if (raw === null || raw === undefined) {
      continue;
    }
    const needle = raw.trim().toLowerCase();
    if (needle !== '') {
      taken.add(needle);
    }
  }
  let count = 0;
  for (const account of accounts) {
    const raw = account.username;
    const blank = raw === null || raw === undefined || raw.trim() === '';
    if (!blank) {
      continue;
    }
    if (account.name === null || account.name.trim() === '') {
      continue;
    }
    const allocated = allocateNip05Local(account.name, account.id, taken);
    const username = normalizeUsername(allocated);
    /* v8 ignore next 3 -- allocateNip05Local emits a-z0-9- locals that always pass */
    if (username === null) {
      continue;
    }
    await store.updateAccount({ ...account, username });
    taken.add(username);
    count += 1;
  }
  logEvent('account.username.backfill', { count });
  return count;
}
