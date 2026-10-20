import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { debugMessagesRoutes } from '@/routes/debug-messages';
import { messagesRoutes } from '@/routes/messages';
import { createApp } from '@/server';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const KEK = new Uint8Array(32).fill(7);
const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const TEXT = 'Coffee roasted on site and served at the bar every morning.\n\n#21GiftsShop';
const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};
const PIN = { lat: 47.3, lng: 8.5, label: 'Cafe', address: ADDRESS };

function account(overrides: Partial<Account>): Account {
  return {
    id: 'mod',
    linkingKey: null,
    role: 'moderator',
    name: 'Mo',
    username: 'mo',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...overrides,
  } as Account;
}

async function authStore(): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount(account({}));
  await auth.createAccount(
    account({
      id: 'till',
      role: 'basis',
      name: 'Coffee',
      username: 'coffee',
      viewKey: 'b'.repeat(64),
    }),
  );
  await auth.createSession({ token: 'tok', accountId: 'mod', createdAt: now() });
  return auth;
}

function shopNote(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: SHOP_ID,
    accountId: 'mod',
    name: 'Mo',
    text: TEXT,
    createdAt: new Date(now()),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: PIN,
    shopAccount: { id: 'till', username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

async function mount(
  row: MessageRow,
  identities?: ShopIdentityStore,
  kek: Uint8Array | null = KEK,
): Promise<{ app: Hono; messages: InMemoryMessageStore; shops: InMemoryShopIdentityStore }> {
  const messages = new InMemoryMessageStore();
  await messages.create(row);
  const shops = new InMemoryShopIdentityStore(messages);
  const app = new Hono().route(
    '/messages',
    messagesRoutes({
      store: messages,
      authStore: await authStore(),
      now,
      shopIdentities: identities ?? shops,
      ...(kek === null ? {} : { nostrKek: kek }),
    }),
  );
  return { app, messages, shops };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

function logged(event: string): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === event);
}

const failing = {
  ensureListed: () => Promise.reject(new Error('db down')),
} as unknown as ShopIdentityStore;

describe('shop key after a write that lists a shop', () => {
  const cases: Array<{
    name: string;
    row: Partial<MessageRow>;
    path: string;
    body: unknown;
  }> = [
    {
      name: 'PATCH /messages/:id/place',
      row: { place: null },
      path: `/messages/${SHOP_ID}/place`,
      body: { place: PIN },
    },
    {
      name: 'PATCH /messages/:id/shop-account',
      row: { shopAccount: null },
      path: `/messages/${SHOP_ID}/shop-account`,
      body: { username: 'coffee' },
    },
    {
      name: 'PATCH /messages/:id/text',
      row: { text: 'Tiny.\n\n#21GiftsShop' },
      path: `/messages/${SHOP_ID}/text`,
      body: { text: TEXT },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} creates the key and answers its npub`, async () => {
      const { app, shops } = await mount(shopNote(testCase.row));
      const res = await app.request(testCase.path, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify(testCase.body),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { shopNpub: string | null };
      const identity = await shops.getByMessageId(SHOP_ID);
      expect(body.shopNpub).toBe(shopNpub(identity!));
    });

    it(`${testCase.name} logs shop.nostr_key.failed and still answers 200`, async () => {
      const { app } = await mount(shopNote(testCase.row), failing);
      const res = await app.request(testCase.path, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify(testCase.body),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { shopNpub: unknown }).shopNpub).toBeNull();
      expect(logged('shop.nostr_key.failed')).toEqual([
        expect.objectContaining({ messageId: SHOP_ID }),
      ]);
    });
  }

  it('answers shopNpub null when the write leaves the note unlisted', async () => {
    const { app, shops } = await mount(shopNote({ place: null, shopAccount: null }));
    const res = await app.request(`/messages/${SHOP_ID}/place`, {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ place: PIN }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shopNpub: unknown }).shopNpub).toBeNull();
    expect(await shops.listAll()).toEqual([]);
  });

  it('creates no key without a KEK', async () => {
    const { app, shops } = await mount(shopNote({ place: null }), undefined, null);
    const res = await app.request(`/messages/${SHOP_ID}/place`, {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ place: PIN }),
    });
    expect(res.status).toBe(200);
    expect(await shops.listAll()).toEqual([]);
  });
});

describe('shop key after a staff restore', () => {
  async function restore(
    identities: (messages: InMemoryMessageStore) => ShopIdentityStore,
    kek?: Uint8Array,
  ): Promise<{
    status: number;
    messages: InMemoryMessageStore;
  }> {
    const messages = new InMemoryMessageStore();
    await messages.create(shopNote({}));
    await messages.markDeleted(SHOP_ID, new Date(now()), 'mod');
    const app = new Hono().route(
      '/debug/messages',
      debugMessagesRoutes({
        store: messages,
        debugToken: 'dbg',
        shopIdentities: identities(messages),
        ...(kek === undefined ? {} : { nostrKek: kek }),
      }),
    );
    const res = await app.request(`/debug/messages/${SHOP_ID}/restore`, {
      method: 'POST',
      headers: { authorization: 'Bearer dbg' },
    });
    return { status: res.status, messages };
  }

  it('creates the key of the restored listed shop', async () => {
    let shops: InMemoryShopIdentityStore | undefined;
    const { status } = await restore((messages) => {
      shops = new InMemoryShopIdentityStore(messages);
      return shops;
    }, KEK);
    expect(status).toBe(204);
    expect(await shops!.getByMessageId(SHOP_ID)).toBeDefined();
  });

  it('logs a failure and still answers 204, and skips without a KEK', async () => {
    expect((await restore(() => failing, KEK)).status).toBe(204);
    expect(logged('shop.nostr_key.failed')).toEqual([
      expect.objectContaining({ messageId: SHOP_ID }),
    ]);
    let shops: InMemoryShopIdentityStore | undefined;
    expect(
      (
        await restore((messages) => {
          shops = new InMemoryShopIdentityStore(messages);
          return shops;
        })
      ).status,
    ).toBe(204);
    expect(await shops!.listAll()).toEqual([]);
  });
});

describe('shop key after PUT /me/about', () => {
  it('asks for the key of the profile note and logs a failure without failing', async () => {
    const auth = await authStore();
    const calls: string[] = [];
    const spy = {
      ensureListed: (id: string) => {
        calls.push(id);
        return calls.length === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('db'));
      },
    } as unknown as ShopIdentityStore;
    const app = createApp({ authStore: auth, now, nostrKek: KEK, shopIdentityStore: spy });
    const put = (text: string): Promise<Response> =>
      Promise.resolve(
        app.request('/me/about', {
          method: 'PUT',
          headers: AUTH,
          body: JSON.stringify({ text }),
        }),
      );
    expect((await put('About the coffee shop')).status).toBe(200);
    expect((await put('About the coffee shop again')).status).toBe(200);
    const profileId = (await auth.getAccount('mod'))?.profileMessageId;
    expect(calls).toEqual([profileId, profileId]);
    expect(logged('shop.nostr_key.failed')).toEqual([
      expect.objectContaining({ messageId: profileId }),
    ]);
  });

  it('skips the key without a KEK', async () => {
    const calls: string[] = [];
    const spy = {
      ensureListed: (id: string) => {
        calls.push(id);
        return Promise.resolve(undefined);
      },
    } as unknown as ShopIdentityStore;
    const app = createApp({ authStore: await authStore(), now, shopIdentityStore: spy });
    const res = await app.request('/me/about', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ text: 'About' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
