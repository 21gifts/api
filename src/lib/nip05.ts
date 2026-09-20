/**
 * NIP-05 local-parts and directory JSON so Damus can show a domain checkmark.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import { resolveWriteSet, writeRelayUrls } from '@/lib/nostr/relays';

/** One NIP-05 mapping ready to publish on kind:0 and in `nostr.json`. */
export interface Nip05Entry {
  /** Account id. */
  accountId: string;
  /** Display name. */
  name: string;
  /** Hex pubkey. */
  pubkey: string;
  /** Local-part (`alice` in `alice@21.gifts`). */
  local: string;
}

/**
 * Hostname used after `@` in `nip05`.
 *
 * Loopback/IPs are skipped so tests without a public host do not mint junk identifiers.
 *
 * @param env - Process env.
 * @returns Hostname from `PUBLIC_BASE_URL`, or `null`.
 */
export function nip05Domain(env: Record<string, string | undefined>): string | null {
  const base = env['PUBLIC_BASE_URL']?.trim() ?? '';
  if (base === '') {
    return null;
  }
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (
      host === '' ||
      host === 'localhost' ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host === '::1' ||
      host.includes(':')
    ) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

/**
 * Slug a display name into a NIP-05 local-part.
 *
 * @param name - Account display name.
 * @returns `a-z0-9-` slug, or `user` when empty.
 */
export function nip05Slug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug === '' ? 'user' : slug;
}

/**
 * Allocate a unique local-part. First account with a slug keeps it; later
 * collisions append 8 hex chars of the account id.
 *
 * @param name - Display name.
 * @param accountId - Account id.
 * @param taken - Locals already assigned in this pass.
 * @returns Unique local-part.
 */
export function allocateNip05Local(name: string, accountId: string, taken: Set<string>): string {
  const base = nip05Slug(name);
  if (!taken.has(base)) {
    return base;
  }
  const hex = accountId.replace(/-/g, '');
  for (let n = 8; n <= hex.length; n += 1) {
    const candidate = `${base}-${hex.slice(0, n)}`.slice(0, 32);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  let i = 2;
  while (true) {
    const candidate = `${base}-${String(i)}`.slice(0, 32);
    if (!taken.has(candidate)) {
      return candidate;
    }
    i += 1;
  }
}

/**
 * Stored LUD-16 / NIP-05 local-part after trim/lower, or `null` when blank.
 *
 * @param account - Stored account.
 * @returns Normalised stored username, or `null`.
 */
function storedUsername(account: Account): string | null {
  const raw = account.username;
  if (raw === null || raw === undefined) {
    return null;
  }
  const needle = raw.trim().toLowerCase();
  /* v8 ignore next -- stored username is normalised before write */
  return needle === '' ? null : needle;
}

/**
 * Seed collision set with every non-blank stored username in this pass.
 *
 * @param accounts - Accounts considered for NIP-05 locals.
 * @returns Locals already reserved by stored usernames.
 */
function seedTakenUsernames(accounts: readonly Account[]): Set<string> {
  const taken = new Set<string>();
  for (const row of accounts) {
    const local = storedUsername(row);
    if (local !== null) {
      taken.add(local);
    }
  }
  return taken;
}

/**
 * Build the NIP-05 identifier for one account, matching `nostr.json`.
 *
 * Prefers a non-blank stored username. Otherwise allocates from the
 * display name like {@link listNip05Entries}.
 *
 * @param account - Account to identify.
 * @param namedOldestFirst - Accounts in this pass, oldest first.
 * @param domain - Hostname (e.g. `21.gifts`).
 * @returns `local@domain`.
 */
export function nip05Identifier(
  account: Account,
  namedOldestFirst: readonly Account[],
  domain: string,
): string {
  const taken = seedTakenUsernames(namedOldestFirst);
  const own = storedUsername(account);
  if (own !== null) {
    return `${own}@${domain}`;
  }
  for (const row of namedOldestFirst) {
    if (storedUsername(row) !== null) {
      continue;
    }
    if (row.name === null || row.name.trim() === '') {
      continue;
    }
    const local = allocateNip05Local(row.name, row.id, taken);
    taken.add(local);
    if (row.id === account.id) {
      return `${local}@${domain}`;
    }
  }
  /* v8 ignore next -- caller always includes the account in namedOldestFirst */
  return `${allocateNip05Local(account.name ?? 'user', account.id, taken)}@${domain}`;
}

/**
 * Load accounts that already have a Nostr pubkey, oldest first.
 *
 * Stored usernames win over display-name slugs. Accounts with a stored
 * username and a skipped/blank name are included. Nameless accounts
 * without a username are skipped.
 *
 * @param auth - Auth store.
 * @returns Directory rows.
 */
export async function listNip05Entries(auth: AuthStore): Promise<Nip05Entry[]> {
  const accounts = await auth.listAccounts();
  const eligible = accounts
    .filter((row) => storedUsername(row) !== null || (row.name !== null && row.name.trim() !== ''))
    .sort((left, right) => {
      const byTime = left.createdAt - right.createdAt;
      /* v8 ignore next -- same createdAt, sort by id */
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
  const taken = seedTakenUsernames(eligible);
  const entries: Nip05Entry[] = [];
  for (const account of eligible) {
    const stored = storedUsername(account);
    const local =
      stored !== null
        ? stored
        : /* v8 ignore next -- eligible rows always have a non-blank name */
          allocateNip05Local(account.name ?? 'user', account.id, taken);
    if (stored === null) {
      taken.add(local);
    }
    const pubkey = await auth.getNostrPublicKey(account.id);
    if (pubkey === undefined) {
      continue;
    }
    /* v8 ignore next -- stored-username rows may still have a blank display name */
    const name = account.name !== null && account.name.trim() !== '' ? account.name : local;
    entries.push({ accountId: account.id, name, pubkey, local });
  }
  return entries;
}

/**
 * NIP-05 `nostr.json` body (names + recommended relays).
 *
 * @param auth - Auth store.
 * @param env - Process env for write-set relays.
 * @param nameFilter - Optional `?name=` filter (NIP-05 clients send this).
 * @returns JSON-serialisable directory.
 */
export async function buildNostrJson(
  auth: AuthStore,
  env: Record<string, string | undefined>,
  nameFilter?: string,
): Promise<{ names: Record<string, string>; relays: Record<string, string[]> }> {
  const entries = await listNip05Entries(auth);
  const filtered =
    nameFilter === undefined || nameFilter.trim() === ''
      ? entries
      : entries.filter((row) => row.local === nameFilter.trim().toLowerCase());
  const names: Record<string, string> = {};
  const relays: Record<string, string[]> = {};
  const relayList = writeRelayUrls(resolveWriteSet(env));
  for (const row of filtered) {
    names[row.local] = row.pubkey;
    relays[row.pubkey] = relayList;
  }
  return { names, relays };
}
