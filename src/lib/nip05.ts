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
    if (host === '' || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
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
  const suffix = accountId.replace(/-/g, '').slice(0, 8);
  let candidate = `${base}-${suffix}`.slice(0, 32);
  if (!taken.has(candidate)) {
    return candidate;
  }
  candidate = `${base}-${accountId.replace(/-/g, '')}`.slice(0, 32);
  return candidate;
}

/**
 * Build the NIP-05 identifier for one named account, matching `nostr.json`.
 *
 * @param account - Named account.
 * @param namedOldestFirst - All named accounts, oldest first.
 * @param domain - Hostname (e.g. `21.gifts`).
 * @returns `local@domain`.
 */
export function nip05Identifier(
  account: Account,
  namedOldestFirst: readonly Account[],
  domain: string,
): string {
  const taken = new Set<string>();
  for (const row of namedOldestFirst) {
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
 * Load named accounts that already have a Nostr pubkey, oldest first.
 *
 * @param auth - Auth store.
 * @returns Directory rows.
 */
export async function listNip05Entries(auth: AuthStore): Promise<Nip05Entry[]> {
  const accounts = await auth.listAccounts();
  const named = accounts
    .filter((row) => row.name !== null && row.name.trim() !== '')
    .sort((left, right) => {
      const byTime = left.createdAt - right.createdAt;
      /* v8 ignore next -- same createdAt, sort by id */
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
  const taken = new Set<string>();
  const entries: Nip05Entry[] = [];
  for (const account of named) {
    const pubkey = await auth.getNostrPublicKey(account.id);
    if (pubkey === undefined || account.name === null) {
      continue;
    }
    const local = allocateNip05Local(account.name, account.id, taken);
    taken.add(local);
    entries.push({ accountId: account.id, name: account.name, pubkey, local });
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
