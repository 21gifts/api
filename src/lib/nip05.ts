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
 * Cost per call: one read of every account (none when `accounts` is
 * given), one of every shop identity and one bulk read of their notes
 * ({@link MessageStore.getByIds}), no read per shop. Requests and worker
 * ticks do not call it directly; they read the cached directory of
 * {@link nip05Directory}, which calls it once per computation.
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
 * How long one computed NIP-05 directory ({@link nip05Directory}) serves its
 * callers: 60 s, the `max-age=60` that `/.well-known/nostr.json` and
 * `GET /shops/:npub` already give every public answer, so the shared cache
 * adds no staleness a client cache does not already allow.
 */
export const NIP05_DIRECTORY_TTL_MS = 60_000;

/**
 * Minimum gap between two forced recomputations ({@link nip05Directory} with
 * `refresh`) of one store set: 10 s. A forced refresh inside the gap does not
 * compute; it gets the cached directory (or joins the forced one in flight).
 * Together with {@link NIP05_DIRECTORY_TTL_MS}, while computations succeed a
 * store set computes the directory at most once per TTL on expiry plus at most
 * once per this gap on demand (at most seven times a minute), however many
 * requests and worker ticks ask for it. A rename waits at most this long for
 * a fresh directory; until then `GET /shops/:npub` answers 503 `nip05_stale`
 * and the worker skips the shop's kind 0 with `nip05_stale`.
 */
export const NIP05_DIRECTORY_REFRESH_MS = 10_000;

/** The NIP-05 allocation of one account snapshot: every account, then every listed shop. */
export interface Nip05Directory {
  /** Account entries in `nostr.json` order ({@link listNip05Entries}). */
  accounts: readonly Nip05Entry[];
  /** Listed shop entries by message id, in allocation order ({@link listShopNip05Entries}). */
  shops: ReadonlyMap<string, ShopNip05Entry>;
}

/** Shop identities and the forum store that decides whether a shop is listed. */
interface Nip05ShopStores {
  identities: ShopIdentityStore;
  messages: MessageStore;
}

/** Cache state of one store set. */
interface DirectorySlot {
  /** Last directory computed, with the clock reading and the sequence number of its start. */
  value?: { directory: Nip05Directory; startedAt: number; seq: number };
  /** Sequence number of the last computation started (orders results; the clock may step). */
  seq: number;
  /** Computation in flight for a plain read (expired or empty cache). */
  pending: Promise<Nip05Directory> | undefined;
  /** Forced computation in flight. */
  forced: Promise<Nip05Directory> | undefined;
  /** Clock reading at the start of the last forced computation. */
  forcedAt: number;
}

/** Per auth store, shop identity store and message store: one {@link DirectorySlot}. */
const directorySlots = new WeakMap<
  AuthStore,
  WeakMap<ShopIdentityStore, WeakMap<MessageStore, DirectorySlot>>
>();

/** The slot of one store set, created on first use. */
function directorySlot(auth: AuthStore, shops: Nip05ShopStores): DirectorySlot {
  let byIdentities = directorySlots.get(auth);
  if (byIdentities === undefined) {
    byIdentities = new WeakMap();
    directorySlots.set(auth, byIdentities);
  }
  let byMessages = byIdentities.get(shops.identities);
  if (byMessages === undefined) {
    byMessages = new WeakMap();
    byIdentities.set(shops.identities, byMessages);
  }
  let slot = byMessages.get(shops.messages);
  if (slot === undefined) {
    slot = { seq: 0, pending: undefined, forced: undefined, forcedAt: Number.NEGATIVE_INFINITY };
    byMessages.set(shops.messages, slot);
  }
  return slot;
}

/**
 * Compute the directory from one account read, store it in the slot unless a
 * computation that started later already did, and return it. "Later" is the
 * slot's start sequence, not the clock, so a clock step cannot keep a newer
 * result out.
 */
async function computeDirectory(
  slot: DirectorySlot,
  auth: AuthStore,
  shops: Nip05ShopStores,
  startedAt: number,
): Promise<Nip05Directory> {
  slot.seq += 1;
  const seq = slot.seq;
  const accounts = await auth.listAccounts();
  const accountEntries = await listNip05Entries(auth, accounts);
  const shopEntries = await listShopNip05Entries(auth, shops.identities, shops.messages, accounts);
  const directory: Nip05Directory = {
    accounts: accountEntries,
    shops: new Map(shopEntries.map((row) => [row.messageId, row] as const)),
  };
  if (slot.value === undefined || slot.value.seq < seq) {
    slot.value = { directory, startedAt, seq };
  }
  return directory;
}

/**
 * The NIP-05 directory of a store set from a shared in-process cache.
 *
 * One directory is computed from one account read (accounts with
 * {@link listNip05Entries}, then listed shops with {@link listShopNip05Entries}
 * on the same snapshot) and kept per auth store, shop identity store and
 * message store for {@link NIP05_DIRECTORY_TTL_MS}. Callers that arrive while
 * a computation runs share it (single flight), so a burst of reads computes
 * at most once per TTL. `refresh` asks for a fresh computation that bypasses
 * the cache and replaces it: a caller that read a note the cached entry does
 * not match uses it once before giving up. Forced computations of a store set
 * are single flight too and start at most once per
 * {@link NIP05_DIRECTORY_REFRESH_MS}; inside that gap a forced read gets the
 * forced computation in flight, else the cached directory (computed as a
 * plain read when it expired). A failed computation is not cached: its
 * callers get the error and the next read computes again. A clock that steps
 * back counts as elapsed: a cached directory or a forced start with a reading
 * after `now` is treated as expired, so a clock step never freezes the cache.
 *
 * @param auth - Auth store.
 * @param shops - Shop identities and forum store.
 * @param now - Clock reading in epoch milliseconds.
 * @param refresh - Force a fresh computation (rate-limited, see above).
 * @returns The directory.
 * @throws When the computation it waits for fails (a store read throws).
 */
export async function nip05Directory(
  auth: AuthStore,
  shops: { identities: ShopIdentityStore; messages: MessageStore },
  now: number,
  refresh = false,
): Promise<Nip05Directory> {
  const slot = directorySlot(auth, shops);
  if (refresh) {
    const sinceForced = now - slot.forcedAt;
    if (slot.forced === undefined && (sinceForced < 0 || sinceForced >= NIP05_DIRECTORY_REFRESH_MS)) {
      slot.forcedAt = now;
      const forced = computeDirectory(slot, auth, shops, now).finally(() => {
        slot.forced = undefined;
      });
      slot.forced = forced;
    }
    if (slot.forced !== undefined) return slot.forced;
  }
  if (slot.value !== undefined) {
    const age = now - slot.value.startedAt;
    if (age >= 0 && age < NIP05_DIRECTORY_TTL_MS) {
      return slot.value.directory;
    }
  }
  if (slot.pending === undefined) {
    slot.pending = computeDirectory(slot, auth, shops, now).finally(() => {
      slot.pending = undefined;
    });
  }
  return slot.pending;
}

/**
 * NIP-05 `nostr.json` body (names + recommended relays).
 *
 * With `shops`, the names come from the shared directory
 * ({@link nip05Directory}): one account snapshot gives the account
 * allocation ({@link listNip05Entries}) and the shop allocation
 * ({@link listShopNip05Entries}), so a rename or merge between two reads
 * cannot give a shop the local part of an account in the same body, and the
 * body carries the same names as `GET /shops/:npub` and the shop kind 0. The
 * full body may be up to {@link NIP05_DIRECTORY_TTL_MS} old. A `?name=`
 * that the cached directory does not hold forces one fresh directory
 * (rate-limited by {@link NIP05_DIRECTORY_REFRESH_MS}) before the answer, so
 * a new username or shop is found as soon as the refresh gap allows. So does
 * a `?name=` the cache gives a shop while an account now holds it as its
 * username (`auth.getAccountByUsername`): accounts win, so the cached shop
 * entry is stale and the account's key is served once the gap allows. Without
 * `shops` (accounts only) every call reads every account itself. Account
 * entries are written first; a shop entry whose local part an account already
 * holds is never written over it (it is skipped and logged as
 * `nip05.shop.collision` with the shop's message id).
 *
 * @param auth - Auth store.
 * @param env - Process env for write-set relays.
 * @param nameFilter - Optional `?name=` filter (NIP-05 clients send this).
 * @param shops - Optional shop identities and forum store; listed shops
 *   follow the accounts ({@link listShopNip05Entries}).
 * @param now - Clock reading in epoch milliseconds for the directory cache.
 *   Default `Date.now()`.
 * @returns JSON-serialisable directory.
 */
export async function buildNostrJson(
  auth: AuthStore,
  env: Record<string, string | undefined>,
  nameFilter?: string,
  shops?: { identities: ShopIdentityStore; messages: MessageStore },
  now: number = Date.now(),
): Promise<{ names: Record<string, string>; relays: Record<string, string[]> }> {
  const needle = nameFilter?.trim().toLowerCase() ?? '';
  const keep = (row: { local: string }): boolean => needle === '' || row.local === needle;
  let accountEntries: readonly Nip05Entry[];
  let shopEntries: readonly ShopNip05Entry[];
  if (shops === undefined) {
    accountEntries = await listNip05Entries(auth);
    shopEntries = [];
  } else {
    let directory = await nip05Directory(auth, shops, now);
    const holds = (dir: Nip05Directory): boolean =>
      dir.accounts.some(keep) || [...dir.shops.values()].some(keep);
    // Called only when the directory holds the name: no account entry means a shop holds it.
    const claimedByAccount = async (dir: Nip05Directory): Promise<boolean> =>
      !dir.accounts.some(keep) && (await auth.getAccountByUsername(needle)) !== undefined;
    if (needle !== '' && (!holds(directory) || (await claimedByAccount(directory)))) {
      // A name the cache may not have seen yet (new username or shop), or a
      // cached shop name an account took as its username since.
      directory = await nip05Directory(auth, shops, now, true);
    }
    accountEntries = directory.accounts;
    shopEntries = [...directory.shops.values()];
  }
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
