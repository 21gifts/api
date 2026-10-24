import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import {
  allocateNip05Local,
  buildNostrJson,
  listNip05Entries,
  listShopNip05Entries,
  NIP05_DIRECTORY_REFRESH_MS,
  NIP05_DIRECTORY_TTL_MS,
  nip05Directory,
  nip05Domain,
  nip05Identifier,
  nip05Slug,
} from '@/lib/nip05';
import { InMemoryShopIdentityStore } from '@/lib/shop-identity';

function account(partial: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    linkingKey: null,
    role: 'basis',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'ab'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

function shop(id: string, label: string, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    accountId: 'author',
    name: 'Ada',
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: {
      lat: 47.3,
      lng: 8.5,
      label,
      address: {
        street: 'Main Street',
        houseNumber: '1',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      },
    },
    shopAccount: { id: 'till', username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

describe('nip05', () => {
  it('slugs names and allocates unique locals', () => {
    expect(nip05Slug('Ada Lovelace')).toBe('ada-lovelace');
    expect(nip05Slug('!!!')).toBe('user');
    const taken = new Set<string>(['ada']);
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', taken)).toBe(
      'ada-11111111',
    );
  });

  it('uses the public host and skips loopback', () => {
    expect(nip05Domain({ PUBLIC_BASE_URL: 'https://21.gifts' })).toBe('21.gifts');
    expect(nip05Domain({ PUBLIC_BASE_URL: 'https://dev.21.gifts/' })).toBe('dev.21.gifts');
    expect(nip05Domain({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000' })).toBeNull();
    expect(nip05Domain({ PUBLIC_BASE_URL: 'http://[::1]:3000' })).toBeNull();
    expect(nip05Domain({ PUBLIC_BASE_URL: 'not-a-url' })).toBeNull();
    expect(nip05Domain({})).toBeNull();
    const taken = new Set<string>(['ada', 'ada-11111111']);
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', taken)).toContain(
      'ada-',
    );
    const hex = '11111111111111111111111111111111';
    const exhausted = new Set<string>(['ada']);
    for (let n = 8; n <= hex.length; n += 1) {
      exhausted.add(`ada-${hex.slice(0, n)}`.slice(0, 32));
    }
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', exhausted)).toBe(
      'ada-2',
    );
    exhausted.add('ada-2');
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', exhausted)).toBe(
      'ada-3',
    );
  });

  it('builds nostr.json names and relays', async () => {
    const auth = new InMemoryAuthStore();
    const ada = account({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ada',
      createdAt: 1,
    });
    await auth.createAccount(ada);
    await auth.createAccount(
      account({
        id: '00000000-0000-4000-8000-000000000003',
        name: 'NoKey',
        createdAt: 2,
        viewKey: 'ee'.repeat(32),
      }),
    );
    await auth.createAccount(
      account({
        id: '00000000-0000-4000-8000-00000000000a',
        name: 'Zed',
        createdAt: 1,
        viewKey: 'ff'.repeat(32),
      }),
    );
    await auth.setNostrKeyIfAbsent('00000000-0000-4000-8000-00000000000a', {
      pubkey: 'bb'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    await auth.setNostrKeyIfAbsent(ada.id, {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const body = await buildNostrJson(auth, { NOSTR_PUBLISH: '1' }, 'ada');
    expect(body.names['ada']).toBe('aa'.repeat(32));
    expect(body.relays['aa'.repeat(32)]?.length).toBeGreaterThan(0);
    const identifier = nip05Identifier(ada, [ada], '21.gifts');
    expect(identifier).toBe('ada@21.gifts');
    const skipped = account({
      id: '00000000-0000-4000-8000-000000000099',
      name: '   ',
      createdAt: 0,
    });
    expect(nip05Identifier(ada, [skipped, ada], '21.gifts')).toBe('ada@21.gifts');
    const unknown = account({ id: '00000000-0000-4000-8000-000000000002', name: 'Bob' });
    expect(nip05Identifier(unknown, [ada], '21.gifts')).toBe('bob@21.gifts');
    const all = await buildNostrJson(auth, {}, '');
    expect(all.names['ada']).toBe('aa'.repeat(32));
  });

  it('reserves slugs for named accounts without a pubkey so kind:0 matches nostr.json', async () => {
    const auth = new InMemoryAuthStore();
    const older = account({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ada',
      createdAt: 1,
    });
    const younger = account({
      id: '00000000-0000-4000-8000-00000000000a',
      name: 'Ada',
      createdAt: 2,
      viewKey: 'ff'.repeat(32),
    });
    await auth.createAccount(older);
    await auth.createAccount(younger);
    await auth.setNostrKeyIfAbsent(younger.id, {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const named = [older, younger];
    const identifier = nip05Identifier(younger, named, '21.gifts');
    const body = await buildNostrJson(auth, {}, 'ada');
    expect(body.names['ada']).toBeUndefined();
    const local = identifier.slice(0, identifier.indexOf('@'));
    expect(local).toBe('ada-00000000');
    const filtered = await buildNostrJson(auth, {}, local);
    expect(filtered.names[local]).toBe('aa'.repeat(32));
  });

  it('uses a stored username instead of re-slugging the display name', async () => {
    const auth = new InMemoryAuthStore();
    const ada = account({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ada Lovelace',
      username: 'custom',
      createdAt: 1,
    });
    await auth.createAccount(ada);
    await auth.setNostrKeyIfAbsent(ada.id, {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    expect(nip05Identifier(ada, [ada], '21.gifts')).toBe('custom@21.gifts');
    const body = await buildNostrJson(auth, {}, 'custom');
    expect(body.names['custom']).toBe('aa'.repeat(32));
    expect(body.names['ada-lovelace']).toBeUndefined();
  });

  it('skips stored handles and nameless rows when allocating a fallback identifier', () => {
    const named = account({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ada',
      username: 'custom',
      createdAt: 1,
    });
    const blank = account({
      id: '00000000-0000-4000-8000-000000000002',
      name: '   ',
      createdAt: 2,
      viewKey: 'cc'.repeat(32),
    });
    const target = account({
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Ada',
      createdAt: 3,
      viewKey: 'dd'.repeat(32),
    });
    expect(nip05Identifier(target, [named, blank, target], '21.gifts')).toBe('ada@21.gifts');
  });

  it('allocates listed shops after the accounts with one bulk read of their notes', async () => {
    const ids = [1, 2, 3].map((n) => `0000000${String(n)}-0000-4000-8000-000000000000`);
    const messages = new InMemoryMessageStore([
      shop(ids[0]!, 'Ada'),
      shop(ids[1]!, 'Roastery'),
      shop(ids[2]!, 'Bakery'),
    ]);
    let now = 1_000;
    const shops = new InMemoryShopIdentityStore(messages, () => now);
    const kek = new Uint8Array(32).fill(7);
    for (const id of ids) {
      now += 1;
      await shops.ensureListed(id, kek);
    }
    await messages.markDeleted(ids[1]!, new Date(), 'staff');
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: '00000000-0000-4000-8000-000000000001', name: 'Ada' }));
    const reads = { getById: 0, getByIds: 0 };
    const counted = new Proxy(messages, {
      get(target, key) {
        if (key === 'getById' || key === 'getByIds') reads[key] += 1;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as MessageStore;
    const entries = await listShopNip05Entries(auth, shops, counted);
    expect(entries.map((entry) => [entry.messageId, entry.name, entry.local])).toEqual([
      [ids[0], 'Ada', 'ada-00000001'],
      [ids[2], 'Bakery', 'bakery'],
    ]);
    expect(reads).toEqual({ getById: 0, getByIds: 1 });
  });

  it('reads the accounts once per nostr.json, so a shop never takes the local part of an account', async () => {
    const shopId = '00000003-0000-4000-8000-000000000000';
    const messages = new InMemoryMessageStore([shop(shopId, 'Bakery')]);
    const shops = new InMemoryShopIdentityStore(messages);
    await shops.ensureListed(shopId, new Uint8Array(32).fill(7));
    const auth = new InMemoryAuthStore();
    const baker = account({ id: '00000000-0000-4000-8000-000000000001', name: 'Bakery' });
    await auth.createAccount(baker);
    await auth.setNostrKeyIfAbsent(baker.id, {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const first = await auth.listAccounts();
    // A later read no longer sees the account (renamed or merged in between).
    const listAccounts = vi
      .spyOn(auth, 'listAccounts')
      .mockResolvedValueOnce(first)
      .mockResolvedValue([]);
    const body = await buildNostrJson(auth, {}, undefined, { identities: shops, messages });
    expect(listAccounts).toHaveBeenCalledTimes(1);
    const shopKey = (await shops.getByMessageId(shopId))!.nostrPubkey;
    expect(body.names).toEqual({ bakery: 'aa'.repeat(32), 'bakery-00000003': shopKey });
    expect(body.relays[shopKey]).toBeDefined();
    // The filtered body comes from the same cached directory: no second account read.
    const filtered = await buildNostrJson(auth, {}, ' Bakery-00000003 ', {
      identities: shops,
      messages,
    });
    expect(filtered.names).toEqual({ 'bakery-00000003': shopKey });
    expect(listAccounts).toHaveBeenCalledTimes(1);
    // Without a snapshot, each list reads the accounts itself.
    listAccounts.mockClear();
    expect(await listNip05Entries(auth)).toEqual([]);
    expect((await listShopNip05Entries(auth, shops, messages))[0]?.local).toBe('bakery');
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });

  describe('nip05Directory', () => {
    const SHOP_ID = '00000003-0000-4000-8000-000000000000';

    /** One listed shop, one keyed account, counted directory reads. */
    async function fixture(): Promise<{
      auth: InMemoryAuthStore;
      messages: InMemoryMessageStore;
      shops: InMemoryShopIdentityStore;
      stores: { identities: InMemoryShopIdentityStore; messages: InMemoryMessageStore };
      computations: () => number;
      reads: () => { accounts: number; identities: number; notes: number };
    }> {
      const messages = new InMemoryMessageStore([shop(SHOP_ID, 'Bakery')]);
      const shops = new InMemoryShopIdentityStore(messages);
      await shops.ensureListed(SHOP_ID, new Uint8Array(32).fill(7));
      const auth = new InMemoryAuthStore();
      const ada = account({ id: '00000000-0000-4000-8000-000000000001', name: 'Ada' });
      await auth.createAccount(ada);
      await auth.setNostrKeyIfAbsent(ada.id, {
        pubkey: 'aa'.repeat(32),
        ciphertext: new Uint8Array(16),
        kekId: 1,
        custody: 'custodial',
      });
      const listAccounts = vi.spyOn(auth, 'listAccounts');
      const listAll = vi.spyOn(shops, 'listAll');
      const getByIds = vi.spyOn(messages, 'getByIds');
      return {
        auth,
        messages,
        shops,
        stores: { identities: shops, messages },
        // A computation starts with the account read.
        computations: () => listAccounts.mock.calls.length,
        reads: () => ({
          accounts: listAccounts.mock.calls.length,
          identities: listAll.mock.calls.length,
          notes: getByIds.mock.calls.length,
        }),
      };
    }

    it('computes once for a burst of concurrent reads and serves the cache until the TTL ends', async () => {
      const { auth, stores, computations, reads } = await fixture();
      const burst = await Promise.all(
        Array.from({ length: 25 }, () => nip05Directory(auth, stores, 1_000)),
      );
      expect(reads()).toEqual({ accounts: 1, identities: 1, notes: 1 });
      expect(new Set(burst).size).toBe(1);
      expect(burst[0]?.accounts.map((row) => row.local)).toEqual(['ada']);
      expect(burst[0]?.shops.get(SHOP_ID)?.local).toBe('bakery');
      expect(await nip05Directory(auth, stores, 1_000 + NIP05_DIRECTORY_TTL_MS - 1)).toBe(burst[0]);
      expect(computations()).toBe(1);
      // Expired: the next read computes again.
      const expired = await nip05Directory(auth, stores, 1_000 + NIP05_DIRECTORY_TTL_MS);
      expect(expired).not.toBe(burst[0]);
      expect(computations()).toBe(2);
    });

    it('forces at most one fresh computation per refresh gap, shared by concurrent callers', async () => {
      const { auth, messages, stores, computations } = await fixture();
      const cached = await nip05Directory(auth, stores, 0);
      await messages.updateText(SHOP_ID, 'Renamed note. #21GiftsShop');
      const forced = await Promise.all([
        nip05Directory(auth, stores, 5, true),
        nip05Directory(auth, stores, 6, true),
      ]);
      expect(computations()).toBe(2);
      expect(forced[0]).toBe(forced[1]);
      expect(forced[0]).not.toBe(cached);
      // The forced result replaced the cache.
      expect(await nip05Directory(auth, stores, 7)).toBe(forced[0]);
      // Inside the gap a forced read gets the cache and computes nothing.
      expect(await nip05Directory(auth, stores, 5 + NIP05_DIRECTORY_REFRESH_MS - 1, true)).toBe(
        forced[0],
      );
      expect(computations()).toBe(2);
      // After the gap it computes again.
      const next = await nip05Directory(auth, stores, 5 + NIP05_DIRECTORY_REFRESH_MS, true);
      expect(next).not.toBe(forced[0]);
      expect(computations()).toBe(3);
    });

    it('computes an expired cache as a plain read when a forced read is rate-limited', async () => {
      const { auth, stores, computations } = await fixture();
      const first = await nip05Directory(auth, stores, 0);
      vi.mocked(auth.listAccounts).mockRejectedValueOnce(new Error('db down'));
      const failedAt = NIP05_DIRECTORY_TTL_MS + 5;
      await expect(nip05Directory(auth, stores, failedAt, true)).rejects.toThrow('db down');
      // Inside the gap after the failed forced read, with the cache expired.
      const plain = await nip05Directory(auth, stores, failedAt + 1, true);
      expect(plain).not.toBe(first);
      expect(plain.shops.get(SHOP_ID)?.local).toBe('bakery');
      expect(computations()).toBe(3);
    });

    it('keeps the newer directory when an older computation finishes last and does not cache a failure', async () => {
      const { auth, stores, computations } = await fixture();
      const accounts = await auth.listAccounts();
      vi.mocked(auth.listAccounts).mockClear();
      let release: (rows: Account[]) => void = () => undefined;
      vi.mocked(auth.listAccounts).mockImplementationOnce(
        () =>
          new Promise<Account[]>((resolve) => {
            release = resolve;
          }),
      );
      const slow = nip05Directory(auth, stores, 0);
      // Started later, finishes first.
      const forced = await nip05Directory(auth, stores, 10, true);
      release(accounts);
      const older = await slow;
      expect(older).not.toBe(forced);
      expect(await nip05Directory(auth, stores, 20)).toBe(forced);
      expect(computations()).toBe(2);

      vi.mocked(auth.listAccounts).mockRejectedValueOnce(new Error('db down'));
      await expect(
        nip05Directory(auth, stores, 10 + NIP05_DIRECTORY_REFRESH_MS, true),
      ).rejects.toThrow('db down');
      // The failure is not cached; the cached directory still serves.
      expect(await nip05Directory(auth, stores, 30)).toBe(forced);
    });

    it('keeps one cache per auth store, shop identity store and message store', async () => {
      const { auth, messages, shops, stores } = await fixture();
      const first = await nip05Directory(auth, stores, 0);
      const otherShops = new InMemoryShopIdentityStore(messages);
      const otherMessages = new InMemoryMessageStore();
      const second = await nip05Directory(auth, { identities: otherShops, messages }, 0);
      const third = await nip05Directory(auth, { identities: shops, messages: otherMessages }, 0);
      expect(second).not.toBe(first);
      expect(third).not.toBe(first);
      expect(second.shops.size).toBe(0);
      expect(third.shops.size).toBe(0);
      expect(await nip05Directory(auth, stores, 1)).toBe(first);
    });

    it('serves nostr.json from the cache and forces one refresh for a ?name= it does not hold', async () => {
      const { auth, messages, shops, stores, computations } = await fixture();
      const full = await buildNostrJson(auth, {}, undefined, stores, 0);
      const shopKey = (await shops.getByMessageId(SHOP_ID))!.nostrPubkey;
      expect(full.names).toEqual({ ada: 'aa'.repeat(32), bakery: shopKey });
      // Same names as the directory the shop route and the worker read.
      const directory = await nip05Directory(auth, stores, 1);
      expect(directory.shops.get(SHOP_ID)?.local).toBe('bakery');
      expect(computations()).toBe(1);
      // A held name answers from the cache.
      expect((await buildNostrJson(auth, {}, 'bakery', stores, 2)).names).toEqual({
        bakery: shopKey,
      });
      expect(computations()).toBe(1);
      // Rename the shop: the cache still has the old name until a refresh.
      const note = (await messages.getById(SHOP_ID))!;
      await messages.setPlace(SHOP_ID, { ...note.place!, label: 'Roastery' });
      expect((await buildNostrJson(auth, {}, undefined, stores, 3)).names['bakery']).toBe(shopKey);
      expect((await buildNostrJson(auth, {}, 'roastery', stores, 4)).names).toEqual({
        roastery: shopKey,
      });
      expect(computations()).toBe(2);
      // An unknown name inside the gap forces nothing more.
      expect((await buildNostrJson(auth, {}, 'nobody', stores, 5)).names).toEqual({});
      expect(computations()).toBe(2);
    });

    it('treats a clock that stepped back past the refresh gap as expired and keeps the newer result', async () => {
      const { auth, stores, computations } = await fixture();
      const late = await nip05Directory(auth, stores, 200_000);
      const forcedLate = await nip05Directory(auth, stores, 200_001, true);
      expect(computations()).toBe(2);
      // The clock steps back 150 s, past the TTL: the cache counts as expired, not as fresh.
      const plain = await nip05Directory(auth, stores, 50_000);
      expect(plain).not.toBe(late);
      expect(plain).not.toBe(forcedLate);
      expect(computations()).toBe(3);
      // Started later with an earlier reading, it still replaced the cache.
      expect(await nip05Directory(auth, stores, 50_001)).toBe(plain);
      // A forced start further than the gap after `now` does not block a forced refresh either.
      const forced = await nip05Directory(auth, stores, 50_002, true);
      expect(forced).not.toBe(plain);
      expect(computations()).toBe(4);
      expect(await nip05Directory(auth, stores, 50_003)).toBe(forced);
      // A reading taken shortly before the last start (a caller that read the
      // clock before an await) still gets the cache and the gap.
      expect(await nip05Directory(auth, stores, 50_000, true)).toBe(forced);
      expect(await nip05Directory(auth, stores, 49_999)).toBe(forced);
      expect(computations()).toBe(4);
      // A step back past the gap but inside the TTL recomputes the cache.
      const stepped = await nip05Directory(auth, stores, 30_000);
      expect(stepped).not.toBe(forced);
      expect(computations()).toBe(5);
    });

    it('answers a ?name= from the lookup maps without walking the cached entries', async () => {
      const { auth, shops, stores, computations } = await fixture();
      const directory = await nip05Directory(auth, stores, 0);
      const shopKey = (await shops.getByMessageId(SHOP_ID))!.nostrPubkey;
      // The lookup maps are built once per computation from the same entries.
      expect([...directory.accountsByLocal]).toEqual([['ada', directory.accounts[0]]]);
      expect([...directory.shopsByLocal]).toEqual([['bakery', directory.shops.get(SHOP_ID)]]);
      // Every walk over the cached entries now throws.
      const trap = (target: object, keys: readonly PropertyKey[]): void => {
        for (const key of keys) {
          Object.defineProperty(target, key, {
            configurable: true,
            value: () => {
              throw new Error(`walked ${String(key)}`);
            },
          });
        }
      };
      trap(directory.accounts, [Symbol.iterator, 'filter', 'some', 'find', 'map', 'forEach']);
      trap(directory.shops, [Symbol.iterator, 'values', 'entries', 'forEach']);
      // A held account name and a held shop name answer from the maps alone.
      expect((await buildNostrJson(auth, {}, 'ada', stores, 1)).names).toEqual({
        ada: 'aa'.repeat(32),
      });
      expect((await buildNostrJson(auth, {}, ' Bakery ', stores, 2)).names).toEqual({
        bakery: shopKey,
      });
      expect(computations()).toBe(1);
      // The full body walks the cached entries (and copies none).
      await expect(buildNostrJson(auth, {}, undefined, stores, 3)).rejects.toThrow('walked');
    });

    it('refreshes a ?name= the cache gives a shop once an account holds it as its username', async () => {
      const { auth, shops, stores, computations } = await fixture();
      const shopKey = (await shops.getByMessageId(SHOP_ID))!.nostrPubkey;
      expect((await buildNostrJson(auth, {}, 'bakery', stores, 0)).names).toEqual({
        bakery: shopKey,
      });
      // An account name match answers from the cache without a username lookup.
      const byUsername = vi.spyOn(auth, 'getAccountByUsername');
      expect((await buildNostrJson(auth, {}, 'ada', stores, 1)).names).toEqual({
        ada: 'aa'.repeat(32),
      });
      expect(byUsername).not.toHaveBeenCalled();
      expect(computations()).toBe(1);
      // An account takes the username the cached directory gives the shop.
      const bea = account({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Bea',
        username: 'bakery',
        viewKey: 'bc'.repeat(32),
        createdAt: 2,
      });
      await auth.createAccount(bea);
      await auth.setNostrKeyIfAbsent(bea.id, {
        pubkey: 'bb'.repeat(32),
        ciphertext: new Uint8Array(16),
        kekId: 1,
        custody: 'custodial',
      });
      expect((await buildNostrJson(auth, {}, 'bakery', stores, 2)).names).toEqual({
        bakery: 'bb'.repeat(32),
      });
      expect(byUsername).toHaveBeenCalledWith('bakery');
      expect(computations()).toBe(2);
      // The shop moved to a suffixed local in the refreshed directory.
      const moved = (await nip05Directory(auth, stores, 3)).shops.get(SHOP_ID);
      expect(moved?.local).not.toBe('bakery');
      expect(moved?.local.startsWith('bakery')).toBe(true);
    });
  });
});
