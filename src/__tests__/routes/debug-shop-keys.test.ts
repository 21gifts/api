import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, shopNpub } from '@/lib/shop-identity';
import { publicKeyHexFromSecret } from '@/lib/nostr/keys';
import { logEvent } from '@/lib/log';
import { debugShopKeyRoutes, type DebugShopKeyRouteDeps } from '@/routes/debug-shop-keys';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';

const OP_KEYS = await seededOperatorLogin();
const OP_ADMIN = OP_KEYS.tokens.admin;
const UNCONFIGURED = new OperatorLogin({
  signers: null,
  store: new InMemoryOperatorLoginStore(),
  now: Date.now,
});

const ADOPTED_ID = '0cc5c2eb-aaf1-4f36-be26-f1b967e7bbe5';
const KEK = new Uint8Array(32).fill(7);

function secret(n: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? n : 1));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function note(id: string): MessageRow {
  return {
    id,
    accountId: 'author',
    name: 'Ada',
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: {
      lat: 14.6,
      lng: 120.9,
      label: 'Stall',
      address: null,
    },
    shopAccount: { id: 'till', username: 'stall', name: 'Stall' },
  };
}

function mount(overrides: Partial<DebugShopKeyRouteDeps> = {}): {
  app: Hono;
  store: InMemoryShopIdentityStore;
} {
  const messages = overrides.messages ?? new InMemoryMessageStore([note(ADOPTED_ID)]);
  const store =
    overrides.identities ?? new InMemoryShopIdentityStore(messages as InMemoryMessageStore);
  const app = new Hono().route(
    '/debug/shop-keys',
    debugShopKeyRoutes({
      identities: store,
      messages,
      kek: KEK,
      operatorLogin: OP_KEYS.operatorLogin,
      ...overrides,
    }),
  );
  return { app, store: store as InMemoryShopIdentityStore };
}

async function post(app: Hono, body: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  return app.request('/debug/shop-keys', { method: 'POST', headers, body });
}

describe('POST /debug/shop-keys', () => {
  it('returns 503 before JSON without a configured key login', async () => {
    const unset = mount({ operatorLogin: undefined });
    const blank = mount({ operatorLogin: UNCONFIGURED });
    expect((await post(unset.app, 'not-json', OP_ADMIN)).status).toBe(503);
    expect(await (await post(blank.app, 'not-json', OP_ADMIN)).json()).toEqual({
      error: 'Debug is not configured',
    });
  });

  it('returns 401 when the debug token is wrong', async () => {
    const { app } = mount();
    const res = await post(app, 'not-json', 'wrong');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 before JSON for a write key token', async () => {
    const { app } = mount();
    const res = await post(app, 'not-json', OP_KEYS.tokens.write);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 503 when the shop KEK is missing or short', async () => {
    const missing = mount({ kek: undefined });
    const short = mount({ kek: new Uint8Array(16) });
    expect((await post(missing.app, 'not-json', OP_ADMIN)).status).toBe(503);
    expect(await (await post(short.app, 'not-json', OP_ADMIN)).json()).toEqual({
      error: 'Shop keys are not configured',
    });
  });

  it('returns 400 for a body that is not a known shop key', async () => {
    const { app } = mount();
    expect((await post(app, 'not-json', OP_ADMIN)).status).toBe(400);
    expect(
      (await post(app, JSON.stringify({ messageId: ADOPTED_ID, secret: 'zz' }), OP_ADMIN)).status,
    ).toBe(400);
    const other = await post(
      app,
      JSON.stringify({ messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', secret: hex(secret(4)) }),
      OP_ADMIN,
    );
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: 'Invalid shop key' });
  });

  it('stores the secret and returns only the npub', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, store } = mount();
    const secretHex = hex(secret(4));
    const res = await post(
      app,
      JSON.stringify({ messageId: ADOPTED_ID.toUpperCase(), secret: secretHex.toUpperCase() }),
      OP_ADMIN,
    );
    expect(res.status).toBe(200);
    const pubkey = publicKeyHexFromSecret(secret(4));
    expect(await res.json()).toEqual({
      messageId: ADOPTED_ID,
      npub: shopNpub({ nostrPubkey: pubkey }),
    });
    expect((await store.getByMessageId(ADOPTED_ID))?.nostrPubkey).toBe(pubkey);
    expect(warn.mock.calls.some((call) => String(call[0]).includes(secretHex))).toBe(false);
    expect(logEvent).toBeTypeOf('function');
    const again = await post(
      app,
      JSON.stringify({ messageId: ADOPTED_ID, secret: secretHex }),
      OP_ADMIN,
    );
    expect(again.status).toBe(200);
    warn.mockRestore();
  });

  it('returns 404 when the note is missing and 409 when the key differs', async () => {
    const missing = mount({ messages: new InMemoryMessageStore([]) });
    const gone = await post(
      missing.app,
      JSON.stringify({ messageId: ADOPTED_ID, secret: hex(secret(4)) }),
      OP_ADMIN,
    );
    expect(gone.status).toBe(404);
    const { app } = mount();
    await post(app, JSON.stringify({ messageId: ADOPTED_ID, secret: hex(secret(4)) }), OP_ADMIN);
    const clash = await post(
      app,
      JSON.stringify({ messageId: ADOPTED_ID, secret: hex(secret(5)) }),
      OP_ADMIN,
    );
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: 'Shop key already exists' });
  });

  it('returns 400 when the secret is not a key or the store throws something else', async () => {
    const { app } = mount();
    const zero = await post(
      app,
      JSON.stringify({ messageId: ADOPTED_ID, secret: '00'.repeat(32) }),
      OP_ADMIN,
    );
    expect(zero.status).toBe(400);
    expect(await zero.json()).toEqual({ error: 'Invalid shop key' });
    const broken = mount({
      identities: {
        adoptKnownSecret: () => Promise.reject('nope'),
      } as unknown as InMemoryShopIdentityStore,
    });
    const res = await post(
      broken.app,
      JSON.stringify({ messageId: ADOPTED_ID, secret: hex(secret(4)) }),
      OP_ADMIN,
    );
    expect(res.status).toBe(400);
  });
});
