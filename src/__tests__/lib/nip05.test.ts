import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import {
  allocateNip05Local,
  buildNostrJson,
  listNip05Entries,
  listShopNip05Entries,
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
    listAccounts.mockResolvedValueOnce(first);
    const filtered = await buildNostrJson(auth, {}, ' Bakery-00000003 ', {
      identities: shops,
      messages,
    });
    expect(filtered.names).toEqual({ 'bakery-00000003': shopKey });
    // Without a snapshot, each list reads the accounts itself.
    listAccounts.mockClear();
    expect(await listNip05Entries(auth)).toEqual([]);
    expect((await listShopNip05Entries(auth, shops, messages))[0]?.local).toBe('bakery');
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });
});
