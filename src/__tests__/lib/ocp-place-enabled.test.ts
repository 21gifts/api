import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveMapPush, type MapFetch } from '@/lib/ocp-place';
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

describe('createApp map push when the code switch is on', () => {
  it('puts one shop pin to the stripped map url', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 201 });
    };
    const app = createApp({
      env: { OCP_MAP_BASE_URL: 'http://map.test/', OCP_PLACE_INGEST_TOKEN: ' secret ' },
      fetchImpl,
      authStore: await shopAccount(),
    });
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Open #21GiftsShop',
        place: { lat: 47.3, lng: 8.5, label: 'Stall' },
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: 'http://map.test/map/places', method: 'PUT' }]);
  });
});
