import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, type ShopIdentityStore } from '@/lib/shop-identity';
import { debugShopNoteRoutes, type DebugShopNoteRouteDeps } from '@/routes/debug-shop-notes';

const AUTHOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEK = new Uint8Array(32).fill(7);
const TEXT = 'Morning stall\n\n#21GiftsShop';

function account(overrides: Partial<Account> & Pick<Account, 'id'>): Account {
  return {
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    location: null,
    forumLawsDismissed: false,
    viewKey: overrides.id.replaceAll('-', '').padEnd(64, 'a'),
    createdAt: 1,
    rulesAgreedAt: null,
    ...overrides,
  };
}

function mount(overrides: Partial<DebugShopNoteRouteDeps> = {}): {
  app: Hono;
  auth: InMemoryAuthStore;
  messages: InMemoryMessageStore;
} {
  const auth = new InMemoryAuthStore();
  const messages = new InMemoryMessageStore();
  const identities = new InMemoryShopIdentityStore(messages);
  const app = new Hono().route(
    '/debug/shop-notes',
    debugShopNoteRoutes({
      auth,
      messages,
      identities,
      kek: KEK,
      debugToken: 'secret',
      now: () => 1_700_000_000_000,
      ...overrides,
    }),
  );
  return { app, auth, messages };
}

async function post(app: Hono, body: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  return app.request('/debug/shop-notes', { method: 'POST', headers, body });
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ text: TEXT, shopUsername: 'till', authorId: AUTHOR, ...overrides });
}

describe('POST /debug/shop-notes', () => {
  it('returns 503 before JSON when debug is unset or blank', async () => {
    const unset = mount({ debugToken: undefined });
    const blank = mount({ debugToken: '  ' });
    expect((await post(unset.app, 'not-json', 'secret')).status).toBe(503);
    expect(await (await post(blank.app, 'not-json', 'secret')).json()).toEqual({
      error: 'Debug is not configured',
    });
  });

  it('returns 401 when the debug token is wrong', async () => {
    const { app } = mount();
    const res = await post(app, 'not-json', 'wrong');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 503 when the shop KEK is missing or short', async () => {
    const missing = mount({ kek: undefined });
    const short = mount({ kek: new Uint8Array(16) });
    expect((await post(missing.app, 'not-json', 'secret')).status).toBe(503);
    expect(await (await post(short.app, 'not-json', 'secret')).json()).toEqual({
      error: 'Shop keys are not configured',
    });
  });

  it('returns 400 when the note is not a shop with a till and an author', async () => {
    const { app } = mount();
    expect((await post(app, 'not-json', 'secret')).status).toBe(400);
    expect((await post(app, body({ text: '   ' }), 'secret')).status).toBe(400);
    expect((await post(app, body({ text: 'hello' }), 'secret')).status).toBe(400);
    expect((await post(app, body({ shopUsername: '_' }), 'secret')).status).toBe(400);
    const badAuthor = await post(app, body({ authorId: 'nope' }), 'secret');
    expect(badAuthor.status).toBe(400);
    expect(await badAuthor.json()).toEqual({ error: 'Invalid shop note' });
  });

  it('returns 404 when the till or the author is missing', async () => {
    const missing = mount();
    expect((await post(missing.app, body(), 'secret')).status).toBe(404);

    const blankName = mount({
      auth: {
        getAccountByUsername: async () => account({ id: TILL, username: '   ' }),
        getAccount: async () => account({ id: AUTHOR }),
      } as unknown as InMemoryAuthStore,
    });
    expect((await post(blankName.app, body(), 'secret')).status).toBe(404);

    const nameless = mount({
      auth: {
        getAccountByUsername: async () => account({ id: TILL, username: null }),
        getAccount: async () => account({ id: AUTHOR }),
      } as unknown as InMemoryAuthStore,
    });
    expect((await post(nameless.app, body(), 'secret')).status).toBe(404);

    const { app, auth } = mount();
    await auth.createAccount(account({ id: TILL, username: 'till', name: 'Till' }));
    const noAuthor = await post(app, body(), 'secret');
    expect(noAuthor.status).toBe(404);
    expect(await noAuthor.json()).toEqual({ error: 'Not found' });
  });

  it('returns 503 when the note or its key cannot be stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = mount({
      auth: {
        getAccountByUsername: async () => account({ id: TILL, username: 'till', name: 'Till' }),
        getAccount: async () => account({ id: AUTHOR }),
      } as unknown as InMemoryAuthStore,
      messages: {
        create: async () => {
          throw new Error('down');
        },
      } as unknown as MessageStore,
    });
    const failed = await post(down.app, body(), 'secret');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Shop note was not stored' });

    const { app, auth } = mount({
      identities: { ensureListed: async () => undefined } as unknown as ShopIdentityStore,
    });
    await auth.createAccount(account({ id: AUTHOR }));
    await auth.createAccount(account({ id: TILL, username: 'till', name: 'Till' }));
    const res = await post(app, body(), 'secret');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Shop key was not created' });
    warn.mockRestore();
  });

  it('stores a live shop note with no pin and returns its npub', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const named = mount();
    await named.auth.createAccount(account({ id: AUTHOR, name: 'Ada' }));
    await named.auth.createAccount(account({ id: TILL, username: 'till', name: 'Till' }));
    const first = await post(named.app, body(), 'secret');
    expect(first.status).toBe(200);
    const stored = (await first.json()) as { id: string; shopNpub: string };
    expect(stored.shopNpub).toMatch(/^npub1[02-9ac-hj-np-z]{58}$/);
    const row = await named.messages.getById(stored.id);
    expect(row?.place ?? null).toBeNull();
    expect(row?.parentId).toBeNull();
    expect(row?.shopAccount).toEqual({ id: TILL, username: 'till', name: 'Till' });
    expect(row?.name).toBe('Ada');

    const unnamed = mount();
    await unnamed.auth.createAccount(account({ id: AUTHOR, name: null }));
    await unnamed.auth.createAccount(account({ id: TILL, username: 'till', name: null }));
    const second = await post(
      unnamed.app,
      body({ text: 'Corner stall\n\n#21GiftsShop' }),
      'secret',
    );
    expect(second.status).toBe(200);
    const again = (await second.json()) as { id: string };
    const bare = await unnamed.messages.getById(again.id);
    expect(bare?.name).toBe('');
    expect(bare?.shopAccount?.name).toBe('');
    expect(bare?.place ?? null).toBeNull();
    warn.mockRestore();
  });
});
