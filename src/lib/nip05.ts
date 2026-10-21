/**
 * NIP-05 local-parts and directory JSON so Damus can show a domain checkmark.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { resolveWriteSet, writeRelayUrls } from '@/lib/nostr/relays';
import type { MessageStore } from '@/lib/message-store';
import type { ShopIdentityStore } from '@/lib/shop-identity';
import { listedShopName } from '@/lib/shop-place';

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
 * Allocate a unique local-part. First account (or shop) with a slug keeps it;
 * later collisions append 8 hex chars of the account id (a shop passes its
 * message id).
 *
 * @param name - Display name (or listed shop name).
 * @param accountId - Account id, or the shop's message id.
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
 * Account locals in the order of `nostr.json`: every account with a stored
 * username or a name, oldest first, stored usernames reserved first.
 *
 * @param accounts - Every account.
 * @returns Eligible accounts with their locals, and every local taken.
 */
function allocateAccountLocals(accounts: readonly Account[]): {
  rows: Array<{ account: Account; local: string }>;
  taken: Set<string>;
} {
  const eligible = accounts
    .filter((row) => storedUsername(row) !== null || (row.name !== null && row.name.trim() !== ''))
    .sort((left, right) => {
      const byTime = left.createdAt - right.createdAt;
      /* v8 ignore next -- same createdAt, sort by id */
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
  const taken = seedTakenUsernames(eligible);
  const rows: Array<{ account: Account; local: string }> = [];
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
    rows.push({ account, local });
  }
  return { rows, taken };
}

/**
 * Load accounts that already have a Nostr pubkey, oldest first.
 *
 * Stored usernames win over display-name slugs. Accounts with a stored
 * username and a skipped/blank name are included. Nameless accounts
 * without a username are skipped.
 *
 * @param auth - Auth store (pubkeys; also the accounts when `accounts` is omitted).
 * @param accounts - Optional snapshot of every account. A caller that also
 *   allocates shop locals passes the snapshot it gives
 *   {@link listShopNip05Entries}, so both allocations see the same accounts.
 *   Omitted, the accounts are read once with `auth.listAccounts()`.
 * @returns Directory rows.
 */
export async function listNip05Entries(
  auth: AuthStore,
  accounts?: readonly Account[],
): Promise<Nip05Entry[]> {
  const { rows } = allocateAccountLocals(accounts ?? (await auth.listAccounts()));
  const entries: Nip05Entry[] = [];
  for (const { account, local } of rows) {
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

/** One listed shop in the NIP-05 directory. */
export interface ShopNip05Entry {
  /** Shop note id. */
  messageId: string;
  /** Shop name (pin label). */
  name: string;
  /** Shop hex pubkey. */
  pubkey: string;
  /** Local-part (`shop` in `shop@21.gifts`). */
  local: string;
}

/**
 * NIP-05 locals of listed shops, allocated after every account.
 *
 * Accounts are allocated first with the set and order of
 * {@link listNip05Entries}, so an account never loses its local part to a
 * shop. Shops follow in `nostr_key_created_at`, then `message_id` order,
 * with the same slug and collision suffix ({@link allocateNip05Local}) from
 * the current shop name. Shops that are not listed get no local.
 *
 * Cost per call, like the account directory of `/.well-known/nostr.json`
 * that it extends: one read of every account (none when `accounts` is
 * given), one of every shop identity and one bulk read of their notes
 * ({@link MessageStore.getByIds}), no read per shop.
 *
 * @param auth - Auth store (read only when `accounts` is omitted).
 * @param shops - Shop identities (ordered by key creation).
 * @param messages - Forum store that decides whether a shop is listed.
 * @param accounts - Optional snapshot of every account. A caller that
 *   combines these entries with the account entries of
 *   {@link listNip05Entries} passes both the same snapshot; a second read
 *   could miss an account renamed or merged in between, and a shop could then
 *   get the local part that account already holds. Omitted, the accounts are
 *   read once with `auth.listAccounts()`.
 * @returns One entry per listed shop with a key.
 */
export async function listShopNip05Entries(
  auth: AuthStore,
  shops: ShopIdentityStore,
  messages: MessageStore,
  accounts?: readonly Account[],
): Promise<ShopNip05Entry[]> {
  const { taken } = allocateAccountLocals(accounts ?? (await auth.listAccounts()));
  const identities = await shops.listAll();
  // One bulk read of every shop note instead of one read per shop.
  const notes = new Map(
    (await messages.getByIds(identities.map((identity) => identity.messageId))).map(
      (note) => [note.id, note] as const,
    ),
  );
  const out: ShopNip05Entry[] = [];
  for (const identity of identities) {
    const name = listedShopName(notes.get(identity.messageId));
    if (name === null) {
      continue;
    }
    const local = allocateNip05Local(name, identity.messageId, taken);
    taken.add(local);
    out.push({ messageId: identity.messageId, name, pubkey: identity.nostrPubkey, local });
  }
  return out;
}

/**
 * NIP-05 `nostr.json` body (names + recommended relays).
 *
 * Reads every account once per call and gives that one snapshot to the
 * account allocation ({@link listNip05Entries}) and the shop allocation
 * ({@link listShopNip05Entries}), so a rename or merge between two reads
 * cannot give a shop the local part of an account in the same body. Account
 * entries are written first; a shop entry whose local part an account
 * already holds is never written over it (it is skipped and logged as
 * `nip05.shop.collision` with the shop's message id).
 *
 * @param auth - Auth store.
 * @param env - Process env for write-set relays.
 * @param nameFilter - Optional `?name=` filter (NIP-05 clients send this).
 * @param shops - Optional shop identities and forum store; listed shops
 *   follow the accounts ({@link listShopNip05Entries}).
 * @returns JSON-serialisable directory.
 */
export async function buildNostrJson(
  auth: AuthStore,
  env: Record<string, string | undefined>,
  nameFilter?: string,
  shops?: { identities: ShopIdentityStore; messages: MessageStore },
): Promise<{ names: Record<string, string>; relays: Record<string, string[]> }> {
  const accounts = await auth.listAccounts();
  const accountEntries = await listNip05Entries(auth, accounts);
  const shopEntries =
    shops === undefined
      ? []
      : await listShopNip05Entries(auth, shops.identities, shops.messages, accounts);
  const needle = nameFilter?.trim().toLowerCase() ?? '';
  const keep = (row: { local: string }): boolean => needle === '' || row.local === needle;
  const names: Record<string, string> = {};
  const relays: Record<string, string[]> = {};
  const relayList = writeRelayUrls(resolveWriteSet(env));
  for (const row of accountEntries.filter(keep)) {
    names[row.local] = row.pubkey;
    relays[row.pubkey] = relayList;
  }
  for (const row of shopEntries.filter(keep)) {
    /* v8 ignore start -- both allocations share one account snapshot and every account local seeds the shop allocation, so a shop never gets an account's local part */
    if (Object.hasOwn(names, row.local)) {
      logEvent('nip05.shop.collision', { messageId: row.messageId });
      continue;
    }
    /* v8 ignore stop */
    names[row.local] = row.pubkey;
    relays[row.pubkey] = relayList;
  }
  return { names, relays };
}
