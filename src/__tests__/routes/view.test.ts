import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { viewRoutes } from '@/routes/view';

const VIEW_KEY = 'a'.repeat(64);
const NOTE_ID = 'note-ada';

function mount(
  store: InMemoryAuthStore,
  messages: InMemoryMessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route('/view', viewRoutes({ store, messageStore: messages }));
}

async function adaAccount(
  store: InMemoryAuthStore,
  overrides: {
    lightningAddress?: string | null;
    lightningAddressVerified?: boolean;
    profileMessageId?: string;
  } = {},
): Promise<void> {
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress:
      overrides.lightningAddress === undefined
        ? 'ada@walletofsatoshi.com'
        : overrides.lightningAddress,
    lightningAddressVerified: overrides.lightningAddressVerified ?? true,
    forumLawsDismissed: false,
    location: null,
    viewKey: VIEW_KEY,
    createdAt: 1_000_000,
    rulesAgreedAt: null,
    ...(overrides.profileMessageId === undefined
      ? {}
      : { profileMessageId: overrides.profileMessageId }),
  });
}

describe('GET /view/:viewKey', () => {
  it('defaults forum and gift collaborators when omitted', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const res = await new Hono().route('/view', viewRoutes({ store })).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Ada', aboutMe: null });
  });

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

  it('returns the seven-field public profile without Authorization', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      location: null,
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      createdAt: 1_000_000,
      hasPasskey: false,
      aboutMe: null,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('id');
    expect(raw).not.toContain('linkingKey');
    expect(raw).not.toContain('role');
    expect(raw).not.toContain('viewKey');
    expect(Object.keys(body).sort()).toEqual([
      'aboutMe',
      'createdAt',
      'hasPasskey',
      'lightningAddress',
      'lightningAddressVerified',
      'location',
      'name',
    ]);
  });

  it('sets hasPasskey true when this account has a credential', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { lightningAddress: null, lightningAddressVerified: false });
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
      location: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1_000_000,
      hasPasskey: true,
      aboutMe: null,
    });
  });

  it('does not flip hasPasskey from another account credential', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { lightningAddress: null, lightningAddressVerified: false });
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
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
    expect(await res.json()).toMatchObject({ hasPasskey: false, aboutMe: null });
  });

  it('sets aboutMe from a real bio and null when the note is only the display name', async () => {
    const bioStore = new InMemoryAuthStore();
    await adaAccount(bioStore, { profileMessageId: NOTE_ID });
    const bioMessages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'I build on Bitcoin',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const bioRes = await mount(bioStore, bioMessages).request(`/view/${VIEW_KEY}`);
    expect(bioRes.status).toBe(200);
    expect(((await bioRes.json()) as { aboutMe: string | null }).aboutMe).toBe(
      'I build on Bitcoin',
    );

    const nameStore = new InMemoryAuthStore();
    await adaAccount(nameStore, { profileMessageId: NOTE_ID });
    const nameMessages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const nameRes = await mount(nameStore, nameMessages).request(`/view/${VIEW_KEY}`);
    expect(nameRes.status).toBe(200);
    expect(((await nameRes.json()) as { aboutMe: string | null }).aboutMe).toBeNull();
  });

  it('returns aboutMe null when the note is the stored name after a rename', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    await store.updateAccount({ ...existing!, name: 'Grace' });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; aboutMe: string | null };
    expect(body.name).toBe('Grace');
    expect(body.aboutMe).toBeNull();
  });

  it('returns aboutMe null when the profile note is soft-hidden', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'I build on Bitcoin',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    expect(await messages.markDeleted(NOTE_ID, new Date(2_000_000), 'staff')).toBe(true);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aboutMe: string | null }).aboutMe).toBeNull();
  });

  it('returns aboutMe null when profileMessageId has no row', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: 'missing-note' });
    const res = await mount(store, new InMemoryMessageStore()).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aboutMe: string | null }).aboutMe).toBeNull();
  });

  it('returns 503 when getById throws', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(messages, 'getById').mockRejectedValue(new Error('store down'));
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(
      warn.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('view.get.failed'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});
