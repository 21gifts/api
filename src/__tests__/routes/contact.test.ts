import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryContactStore, type ContactStore } from '@/lib/contact-store';
import { MESSAGE_MAX_LENGTH } from '@/lib/message';
import { contactRoutes } from '@/routes/contact';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;

function mount(
  authStore: InMemoryAuthStore,
  store: ContactStore = new InMemoryContactStore(),
): Hono {
  return new Hono().route('/contact', contactRoutes({ store, authStore, now }));
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: 1_000_000,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function namedStore(name: string): Promise<InMemoryAuthStore> {
  const store = await seededStore();
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  if (existing === undefined) {
    throw new Error('expected account');
  }
  await store.updateAccount({ ...existing, name });
  return store;
}

describe('POST /contact', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/contact', {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/contact', {
      method: 'POST',
      headers: { authorization: 'Bearer    ', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/contact', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('posts a contact and returns the public object', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  hello world  ' }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      name: string;
      text: string;
      createdAt: string;
      accountId?: string;
    };
    expect(created.name).toBe('Ada');
    expect(created.text).toBe('hello world');
    expect(created.createdAt).toBe(new Date(now()).toISOString());
    expect(created.accountId).toBeUndefined();
    expect(created.id.length).toBeGreaterThan(8);
  });

  it('rejects posting without a name', async () => {
    const res = await mount(await seededStore()).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('rejects posting with a whitespace-only name', async () => {
    const res = await mount(await namedStore('   ')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('rejects invalid JSON', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
  });

  it('rejects a body without a text field', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
  });

  it('rejects empty text', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('rejects too-long text', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A'.repeat(MESSAGE_MAX_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('rejects a tab in text', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello\tworld' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('rejects a DEL character in text', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `hello${String.fromCharCode(127)}` }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('accepts a newline in text', async () => {
    const res = await mount(await namedStore('Ada')).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello\nworld' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('hello\nworld');
  });

  it('returns 503 and logs when create throws', async () => {
    const throwing: ContactStore = {
      listLatest: async () => [],
      create: async () => {
        throw new Error('boom');
      },
    };
    const res = await mount(await namedStore('Ada'), throwing).request('/contact', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Contact is unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'contact.create.failed')).toBe(true);
  });
});
