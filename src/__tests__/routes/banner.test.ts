import { Hono } from 'hono';
import { encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryBannerStore } from '@/lib/banner-store';
import { bannerRoutes } from '@/routes/banner';
import { createApp } from '@/server';

function jpeg(width: number, height: number): string {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  return Buffer.from(encodeJpeg({ data, width, height }, 50).data).toString('base64');
}

async function authedApp(): Promise<{
  app: ReturnType<typeof createApp>;
  banners: InMemoryBannerStore;
}> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  const banners = new InMemoryBannerStore();
  const app = createApp({ authStore: store, now: () => 1_000_000, bannerStore: banners });
  return { app, banners };
}

describe('banner routes', () => {
  it('stores a wide image, serves it, and clears it', async () => {
    const { app, banners } = await authedApp();
    const saved = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 'image/jpeg', data: jpeg(1280, 640) } }),
    });
    expect(saved.status).toBe(204);
    const mine = await app.request('/banners/me', { headers: { authorization: 'Bearer tok' } });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('image/jpeg');
    const pub = await app.request('/banners/acc.jpg');
    expect(pub.status).toBe(200);
    expect((await app.request('/banners/acc.png')).status).toBe(404);
    await banners.set('acc', 'banner', {
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect((await app.request('/banners/acc.png')).status).toBe(200);
    await banners.set('acc', 'banner', {
      contentType: 'image/webp',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect((await app.request('/banners/acc.webp')).status).toBe(200);
    const cleared = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: null }),
    });
    expect(cleared.status).toBe(204);
    expect(
      (await app.request('/banners/me', { headers: { authorization: 'Bearer tok' } })).status,
    ).toBe(404);
  });

  it('rejects a portrait, a bad body, and a missing session', async () => {
    const { app } = await authedApp();
    const portrait = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 'image/jpeg', data: jpeg(400, 800) } }),
    });
    expect(portrait.status).toBe(400);
    const junk = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 'image/jpeg', data: 'aaaa' } }),
    });
    expect(junk.status).toBe(400);
    const missing = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const shaped = await app.request('/banners/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 1, data: 'aa' } }),
    });
    expect(shaped.status).toBe(400);
    expect(
      (
        await app.request('/banners/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/banners/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: '[]',
        })
      ).status,
    ).toBe(400);
    expect((await app.request('/banners/me', { method: 'PUT', body: 'not-json' })).status).toBe(
      401,
    );
    expect(
      (
        await app.request('/banners/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
          body: JSON.stringify({ photo: null }),
        })
      ).status,
    ).toBe(401);
    expect((await app.request('/banners/acc.jpg')).status).toBe(404);
    expect((await app.request('/banners/me')).status).toBe(401);
    expect(
      (await app.request('/banners/me', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect((await app.request('/banners/nope')).status).toBe(404);
  });

  it('uses the default store and clock', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: Date.now() });
    const app = new Hono();
    app.route('/banners', bannerRoutes({ auth: store }));
    expect(
      (await app.request('/banners/me', { headers: { authorization: 'Bearer tok' } })).status,
    ).toBe(404);
  });
});
