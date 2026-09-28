import { Hono } from 'hono';
import { encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryBannerStore } from '@/lib/banner-store';
import { pictureRoutes } from '@/routes/pictures';
import { createApp } from '@/server';

function jpeg(width: number, height: number): string {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  return Buffer.from(encodeJpeg({ data, width, height }, 50).data).toString('base64');
}

describe('picture routes', () => {
  it('stores a portrait without using it as the wide image', async () => {
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
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const banners = new InMemoryBannerStore();
    const app = createApp({ authStore: store, now: () => 1_000_000, bannerStore: banners });
    const saved = await app.request('/pictures/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 'image/jpeg', data: jpeg(400, 800) } }),
    });
    expect(saved.status).toBe(204);
    expect(
      (await app.request('/pictures/me', { headers: { authorization: 'Bearer tok' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/pictures/me', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect((await app.request('/pictures/me', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect((await app.request('/pictures/acc.jpg')).status).toBe(200);
    expect((await app.request('/banners/acc.jpg')).status).toBe(404);
    expect((await app.request('/pictures/acc.png')).status).toBe(404);
    const junk = await app.request('/pictures/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: { contentType: 'image/jpeg', data: 'aaaa' } }),
    });
    expect(junk.status).toBe(400);
    expect((await app.request('/pictures/me')).status).toBe(401);
    expect(
      (
        await app.request('/pictures/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
          body: JSON.stringify({ photo: null }),
        })
      ).status,
    ).toBe(401);
    const cleared = await app.request('/pictures/me', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: null }),
    });
    expect(cleared.status).toBe(204);
    expect(
      (await app.request('/pictures/me', { headers: { authorization: 'Bearer tok' } })).status,
    ).toBe(404);
    expect((await app.request('/pictures/acc.jpg')).status).toBe(404);
    expect(
      (
        await app.request('/pictures/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/pictures/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: '[]',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/pictures/me', {
          method: 'PUT',
          headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
          body: JSON.stringify({ photo: { contentType: 1, data: 'aa' } }),
        })
      ).status,
    ).toBe(400);
    await banners.set('acc', 'picture', {
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect((await app.request('/pictures/acc.png')).status).toBe(200);
    await banners.set('acc', 'picture', {
      contentType: 'image/webp',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect((await app.request('/pictures/acc.webp')).status).toBe(200);
    expect((await app.request('/pictures/nope')).status).toBe(404);
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
      viewKey: 'd'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: Date.now() });
    const app = new Hono();
    app.route('/pictures', pictureRoutes({ auth: store }));
    expect(
      (await app.request('/pictures/me', { headers: { authorization: 'Bearer tok' } })).status,
    ).toBe(404);
  });
});
