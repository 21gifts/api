import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { buildKind0Event, buildKind1Event } from '@/lib/nostr/event';
import { bindKekId, parseNostrKek } from '@/lib/nostr/kek';
import {
  encryptNostrSecret,
  ensureAccountNostrKey,
  publicKeyHexFromSecret,
} from '@/lib/nostr/keys';
import {
  nostrRetiredKeyAad,
  type NostrRetiredKey,
  type NostrRetiredKeyStore,
} from '@/lib/nostr/retired-key';
import { signDeletionForAccount, signEventForAccount, signEventForShop } from '@/lib/nostr/sign';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryShopIdentityStore } from '@/lib/shop-identity';

const KEK = parseNostrKek('ef'.repeat(32));

describe('signEventForAccount', () => {
  it('signs a kind:1 for an account with keys', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(store, 'acc', KEK);
    const signed = await signEventForAccount(
      store,
      'acc',
      KEK,
      buildKind1Event('hi', 1_700_000_000),
    );
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.kind).toBe(1);
    expect(signed.content).toBe('hi\n\n#bitcoin #21gifts');
  });

  it('throws when the account has no secret', async () => {
    const store = new InMemoryAuthStore();
    await expect(
      signEventForAccount(store, 'missing', KEK, buildKind1Event('hi', 1)),
    ).rejects.toThrow(/missing/);
  });

  it('treats a secret under another KEK id as missing, without decrypting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-old',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(store, 'acc-old', KEK);
    const current = bindKekId(parseNostrKek('12'.repeat(32)), 2);
    await expect(
      signEventForAccount(store, 'acc-old', current, buildKind1Event('hi', 1)),
    ).rejects.toThrow('Nostr secret missing');
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('"event":"nostr.key.kek_stale"')),
    ).toBe(true);
    warn.mockRestore();
  });
});

describe('signDeletionForAccount', () => {
  const EVENT_ID = 'ee'.repeat(32);
  const OLD_SECRET = new Uint8Array(32).fill(7);
  const OLD_PUBKEY = publicKeyHexFromSecret(OLD_SECRET);

  async function accountWithKey(): Promise<{ store: InMemoryAuthStore; current: string }> {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    return { store, current: await ensureAccountNostrKey(store, 'acc', KEK) };
  }

  /** A retired-key reader over fixed rows, recording every lookup. */
  function retiredStore(rows: Map<string, NostrRetiredKey>): NostrRetiredKeyStore & {
    lookups: string[][];
  } {
    const lookups: string[][] = [];
    return {
      lookups,
      getRetiredKey: async (ownerType, ownerId, pubkey) => {
        lookups.push([ownerType, ownerId, pubkey]);
        return rows.get(`${ownerType}:${ownerId}:${pubkey}`);
      },
    };
  }

  async function retiredRow(
    secret: Uint8Array,
    pubkey: string,
    kek = KEK,
  ): Promise<NostrRetiredKey> {
    return {
      ciphertext: await encryptNostrSecret(
        secret,
        kek,
        nostrRetiredKeyAad('account', 'acc', pubkey),
      ),
      kekId: 1,
    };
  }

  it('signs a kind 5 for the event with the current key when the event has no stored pubkey or the current one', async () => {
    const { store, current } = await accountWithKey();
    const retired = retiredStore(new Map());
    for (const pubkey of [null, current, current.toUpperCase()]) {
      const event = await signDeletionForAccount(
        store,
        retired,
        'acc',
        KEK,
        { eventId: EVENT_ID, pubkey },
        1_700_000_000,
      );
      expect(event?.pubkey).toBe(current);
      expect(event?.kind).toBe(5);
      expect(event?.tags).toEqual([
        ['e', EVENT_ID],
        ['k', '1'],
      ]);
      expect(event?.created_at).toBe(1_700_000_000);
    }
    expect(retired.lookups).toEqual([]);
  });

  it('signs with the retired key whose pubkey signed the event', async () => {
    const { store } = await accountWithKey();
    const retired = retiredStore(
      new Map([[`account:acc:${OLD_PUBKEY}`, await retiredRow(OLD_SECRET, OLD_PUBKEY)]]),
    );
    const event = await signDeletionForAccount(
      store,
      retired,
      'acc',
      KEK,
      { eventId: EVENT_ID, pubkey: OLD_PUBKEY },
      2,
    );
    expect(event?.pubkey).toBe(OLD_PUBKEY);
    expect(event?.kind).toBe(5);
    expect(event?.tags).toEqual([
      ['e', EVENT_ID],
      ['k', '1'],
    ]);
    expect(retired.lookups).toEqual([['account', 'acc', OLD_PUBKEY]]);
  });

  it('signs nothing when no key of the account signed the event', async () => {
    const { store } = await accountWithKey();
    const target = { eventId: EVENT_ID, pubkey: OLD_PUBKEY };
    // No retired-key store (memory boot), no row, or a row under another KEK id.
    const other = bindKekId(parseNostrKek('56'.repeat(32)), 2);
    const underOtherId = retiredStore(
      new Map([[`account:acc:${OLD_PUBKEY}`, await retiredRow(OLD_SECRET, OLD_PUBKEY, other)]]),
    );
    for (const retired of [undefined, retiredStore(new Map()), underOtherId]) {
      expect(await signDeletionForAccount(store, retired, 'acc', KEK, target, 1)).toBeUndefined();
    }
  });

  it('refuses a retired secret that derives another pubkey', async () => {
    const { store } = await accountWithKey();
    const otherPubkey = publicKeyHexFromSecret(new Uint8Array(32).fill(8));
    const retired = retiredStore(
      new Map([[`account:acc:${otherPubkey}`, await retiredRow(OLD_SECRET, otherPubkey)]]),
    );
    await expect(
      signDeletionForAccount(
        store,
        retired,
        'acc',
        KEK,
        { eventId: EVENT_ID, pubkey: otherPubkey },
        1,
      ),
    ).rejects.toThrow('Retired Nostr key does not match its pubkey');
  });
});

describe('signEventForShop', () => {
  it('signs with shop-scoped AAD', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const messages = new InMemoryMessageStore([
      {
        id,
        accountId: 'author',
        name: 'Ada',
        text: 'Fresh coffee roasted here every morning. #21GiftsShop',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        place: {
          lat: 1,
          lng: 2,
          label: 'Coffee',
          address: {
            street: 'Main',
            houseNumber: '1',
            postalCode: '8001',
            city: 'Zürich',
            country: 'CH',
          },
        },
        shopAccount: { id: 'till', username: 'coffee', name: 'Coffee' },
      },
    ]);
    const shops = new InMemoryShopIdentityStore(messages);
    await shops.ensureListed(id, KEK);
    const signed = await signEventForShop(shops, id, KEK, buildKind0Event('Coffee', null, 1));
    expect(signed.kind).toBe(0);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const current = bindKekId(parseNostrKek('34'.repeat(32)), 2);
    await expect(
      signEventForShop(shops, id, current, buildKind0Event('Coffee', null, 1)),
    ).rejects.toThrow('Shop Nostr secret missing');
    warn.mockRestore();
  });
});
