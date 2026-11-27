import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { buildKind0Event, buildKind1Event } from '@/lib/nostr/event';
import { bindKekId, parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { signEventForAccount, signEventForShop } from '@/lib/nostr/sign';
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
