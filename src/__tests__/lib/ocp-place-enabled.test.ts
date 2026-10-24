import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveMapPush, type MapFetch } from '@/lib/ocp-place';
import { InMemoryMessageStore } from '@/lib/message-store';
import { runOcpPlaceOutboxPass } from '@/lib/ocp-outbox';
import { InMemoryShopIdentityStore, shopNpub } from '@/lib/shop-identity';
import { createApp } from '@/server';

vi.mock('@/lib/shop-place-push-enabled', () => ({
  SHOP_PLACE_PUSH_ENABLED: true,
}));

async function shopAccount(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  const now = Date.now();
  await store.createAccount({
    id: 'acc',
    linkingKey: 'a'.repeat(64),
    role: 'verified',
    name: 'Ada',
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: now,
    rulesAgreedAt: now,
    username: 'ada',
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now });
  return store;
}

describe('resolveMapPush when the code switch is on', () => {
  it('trims the url and the token', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: ' http://map.test/// ', OCP_PLACE_INGEST_TOKEN: ' secret ' },
        fetchImpl,
      ),
    ).toMatchObject({ baseUrl: 'http://map.test', token: 'secret' });
  });

  it('returns undefined when the url or token is missing', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(resolveMapPush({}, fetchImpl)).toBeUndefined();
    expect(resolveMapPush({ OCP_MAP_BASE_URL: '  ' }, fetchImpl)).toBeUndefined();
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: 'http://map.test', OCP_PLACE_INGEST_TOKEN: ' ' },
        fetchImpl,
      ),
    ).toBeUndefined();
  });
});

describe('shop place push when the code switch is on', () => {
  it('creates the shop key on POST and the outbox puts the pin with it', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('{}', { status: 201 });
    };
    const env = { OCP_MAP_BASE_URL: 'http://map.test/', OCP_PLACE_INGEST_TOKEN: ' secret ' };
    const messages = new InMemoryMessageStore();
    const identities = new InMemoryShopIdentityStore(messages);
    const app = createApp({
      env,
      fetchImpl,
      authStore: await shopAccount(),
      messageStore: messages,
      shopIdentityStore: identities,
      nostrKek: new Uint8Array(32).fill(7),
    });
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Coffee roasted on site and served at the bar every morning.\n\n#21GiftsShop',
        shopUsername: 'ada',
        place: {
          lat: 47.3,
          lng: 8.5,
          label: 'Stall',
          address: {
            street: 'Bahnhofstrasse',
            houseNumber: '1',
            postalCode: '8001',
            city: 'Zürich',
            country: 'CH',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; shopNpub: string | null };
    const identity = (await identities.getByMessageId(body.id))!;
    expect(body.shopNpub).toBe(shopNpub(identity));
    expect(calls).toEqual([]);
    const mapPush = resolveMapPush(env, fetchImpl as MapFetch)!;
    await runOcpPlaceOutboxPass({ identities, messages, mapPush });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://map.test/map/places', method: 'PUT' });
    expect(calls[0]?.body).toMatchObject({
      externalId: body.id,
      nostrPubkey: identity.nostrPubkey,
      revision: 1,
    });
  });
});
