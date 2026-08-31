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

  it('returns the five-field public profile without Authorization', async () => {
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
      rulesAgreedAt: null,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      createdAt: 1_000_000,
      hasPasskey: false,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('id');
    expect(raw).not.toContain('linkingKey');
    expect(raw).not.toContain('role');
    expect(raw).not.toContain('viewKey');
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'hasPasskey',
      'lightningAddress',
      'lightningAddressVerified',
      'name',
    ]);
  });

  it('sets hasPasskey true when this account has a credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createPasskeyCredential({
      credentialId: 'cred-acc',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1_000_000,
      hasPasskey: true,
    });
  });

  it('does not flip hasPasskey from another account credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.createPasskeyCredential({
      credentialId: 'cred-other',
      publicKey: new Uint8Array([2]),
      signCount: 0,
      accountId: 'other',
      createdAt: 2,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPasskey: false });
  });
});
