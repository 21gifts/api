import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import { InMemoryAuthStore, type Account, type AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { shopRoutes } from '@/routes/shops';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEK = new Uint8Array(32).fill(7);
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 2 : 1));

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: TILL,
    linkingKey: null,
    role: 'basis',
    name: 'Coffee',
    username: 'coffee',
    lightningAddress: 'coffee@example.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: '11'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    ...overrides,
  } as Account;
}

function note(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ID,
    accountId: 'author',
    name: 'Ada',
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: {
      lat: 47.3,
      lng: 8.5,
      label: 'Coffee Lab',
      address: {
        street: 'Main Street',
        houseNumber: '1',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      },
    },
    shopAccount: { id: TILL, username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function setup(
  options: {
    env?: Record<string, string | undefined>;
    till?: Account | null;
    photos?: ForumPhoto[];
    row?: Partial<MessageRow>;
  } = {},
): Promise<{
  app: Hono;
  messages: InMemoryMessageStore;
  auth: InMemoryAuthStore;
  identities: InMemoryShopIdentityStore;
  npub: string;
  hex: string;
}> {
  const messages = new InMemoryMessageStore();
  const photos = options.photos ?? [];
  await messages.create(note(options.row), photos[0], undefined, photos.slice(1));
  const auth = new InMemoryAuthStore();
  if (options.till !== null) await auth.createAccount(options.till ?? account());
  const identities = new InMemoryShopIdentityStore(messages);
  const identity = (await identities.ensureListed(ID, KEK, {
    generateSecretKey: () => SECRET.slice(),
  }))!;
  const app = new Hono().route(
    '/shops',
    shopRoutes({ authStore: auth, messages, identities, env: options.env ?? {} }),
  );
  return { app, messages, auth, identities, npub: shopNpub(identity), hex: identity.nostrPubkey };
}

describe('GET /shops/:npub', () => {
  it('returns a listed shop with photos, pay username and NIP-05', async () => {
    const { app, npub } = await setup({
      env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      photos: [
        { contentType: 'image/png', bytes: png(320, 200) },
        { contentType: 'image/webp', bytes: new Uint8Array([1, 2, 3]) },
      ],
    });
    const response = await app.request(`/shops/${npub}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({
      shop: {
        npub,
        messageId: ID,
        name: 'Coffee Lab',
        description: 'Fresh coffee roasted here every morning.',
        place: {
          lat: 47.3,
          lng: 8.5,
          label: 'Coffee Lab',
          address: {
            street: 'Main Street',
            houseNumber: '1',
            postalCode: '8001',
            city: 'Zürich',
            country: 'CH',
          },
        },
        photos: [
          { url: `https://api.21.gifts/messages/${ID}/photo.png`, width: 320, height: 200 },
          { url: `https://api.21.gifts/messages/${ID}/photo/1.webp`, width: null, height: null },
        ],
        payUsername: 'coffee',
        nip05: 'coffee-lab@21.gifts',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    });
  });

  it('uses bare photo paths and a null NIP-05 without a public origin', async () => {
    const { app, npub } = await setup({
      photos: [{ contentType: 'image/png', bytes: png(1, 2) }],
    });
    const body = (await (await app.request(`/shops/${npub}`)).json()) as {
      shop: { photos: unknown[]; nip05: unknown };
    };
    expect(body.shop.photos).toEqual([{ url: `/messages/${ID}/photo.png`, width: 1, height: 2 }]);
    expect(body.shop.nip05).toBeNull();
  });

  it('answers payUsername null without a username, a Lightning address, or the account', async () => {
    for (const till of [
      account({ username: null }),
      account({ lightningAddress: null }),
      account({ lightningAddress: '  ' }),
      null,
    ]) {
      const { app, npub } = await setup({ till });
      const body = (await (await app.request(`/shops/${npub}`)).json()) as {
        shop: { payUsername: unknown; photos: unknown[] };
      };
      expect(body.shop.payUsername).toBeNull();
      expect(body.shop.photos).toEqual([]);
    }
  });

  it('redirects the hex key of a known shop to its npub', async () => {
    const { app, npub, hex } = await setup();
    const response = await app.request(`/shops/${hex}`);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`/shops/${npub}`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('answers 410 without a name for a shop that is no longer listed', async () => {
    const { app, messages, npub, hex } = await setup();
    await messages.markDeleted(ID, new Date(0), 'staff');
    const response = await app.request(`/shops/${npub}`);
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({ error: 'Shop is no longer listed', npub });
    expect((await app.request(`/shops/${hex}`)).status).toBe(301);
  });

  it('answers 410 when the note is gone', async () => {
    const { identities, npub } = await setup();
    const messages = { getById: () => Promise.resolve(undefined) } as unknown as MessageStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({ authStore: new InMemoryAuthStore(), messages, identities, env: {} }),
    );
    expect((await app.request(`/shops/${npub}`)).status).toBe(410);
  });

  it('answers a null NIP-05 when the shop stops being listed during the request', async () => {
    const { identities, npub, messages, auth } = await setup();
    let reads = 0;
    const flaky = {
      getById: async (id: string) => {
        reads += 1;
        const row = await messages.getById(id);
        return reads === 1 || row === undefined ? row : { ...row, deletedAt: new Date(0) };
      },
      getPhoto: (id: string) => messages.getPhoto(id),
      listExtraPhotos: (id: string) => messages.listExtraPhotos(id),
    } as unknown as MessageStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: auth,
        messages: flaky,
        identities,
        env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      }),
    );
    const body = (await (await app.request(`/shops/${npub}`)).json()) as {
      shop: { nip05: unknown };
    };
    expect(body.shop.nip05).toBeNull();
  });

  it('answers 404 for every other segment', async () => {
    const { app, npub } = await setup();
    const unknownHex = '11'.repeat(32);
    const badChecksum = `${npub.slice(0, -1)}${npub.endsWith('q') ? 'p' : 'q'}`;
    for (const segment of [
      'nobody',
      npub.toUpperCase(),
      unknownHex.toUpperCase(),
      badChecksum,
      nip19.npubEncode(unknownHex),
      unknownHex,
      `${'11'.repeat(31)}1`,
    ]) {
      const response = await app.request(`/shops/${segment}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('answers 503 with no-store and logs on a store failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const identities = {
      getByPubkey: () => Promise.reject(new Error('down')),
    } as unknown as ShopIdentityStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: {} as AuthStore,
        messages: new InMemoryMessageStore(),
        identities,
      }),
    );
    const response = await app.request(`/shops/${'11'.repeat(32)}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Shops are unavailable' });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('shops.detail.failed'))).toBe(
      true,
    );
    warn.mockRestore();
  });
});
