import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { viewRoutes } from '@/routes/view';

const VIEW_KEY = 'a'.repeat(64);

function mount(store: InMemoryAuthStore): Hono {
  return new Hono().route('/view', viewRoutes({ store }));
}

describe('GET /view/:viewKey', () => {
  it('returns 404 Not found for a short param', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/view/abcd');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for uppercase hex', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${'A'.repeat(64)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for extra characters', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${VIEW_KEY}zz`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for an unknown 64-hex key', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns the four-field public profile without Authorization', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      createdAt: 1_000_000,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('id');
    expect(raw).not.toContain('linkingKey');
    expect(raw).not.toContain('role');
    expect(raw).not.toContain('viewKey');
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'lightningAddress',
      'lightningAddressVerified',
      'name',
    ]);
  });
});
