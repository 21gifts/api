import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { meRoutes } from '@/routes/me';

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

const now = (): number => 1_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;
const VIEW_KEY = 'a'.repeat(64);
const ADDRESS = 'alice@walletofsatoshi.com';
const NOSTR_KEK = parseNostrKek('cd'.repeat(32));
const NOTE_ID = 'note-ada';
const BIO = 'I build on Bitcoin';
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

interface MountOpts {
  messages?: InMemoryMessageStore;
  pushStore?: InMemoryPushStore;
  notificationStore?: InMemoryNotificationStore;
}

function mount(store: InMemoryAuthStore, opts: MountOpts = {}): Hono {
  return new Hono().route(
    '/me',
    meRoutes({
      store,
      messages: opts.messages ?? new InMemoryMessageStore(),
      now,
      payer: new UnconfiguredInvoicePayer(),
      fetchImpl: globalThis.fetch,
      nostrKek: NOSTR_KEK,
      ...(opts.pushStore === undefined ? {} : { pushStore: opts.pushStore }),
      ...(opts.notificationStore === undefined
        ? {}
        : { notificationStore: opts.notificationStore }),
    }),
  );
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(
  overrides: { lightningAddress?: string | null; verified?: boolean; name?: string | null } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: overrides.name ?? null,
    location: null,
    lightningAddress: overrides.lightningAddress ?? null,
    lightningAddressVerified: overrides.verified ?? false,
    forumLawsDismissed: false,
    viewKey: VIEW_KEY,
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  return store;
}

async function patchAccount(
  store: InMemoryAuthStore,
  patch: { name?: string | null; lightningAddress?: string | null; profileMessageId?: string },
): Promise<void> {
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  await store.updateAccount({ ...existing!, ...patch });
}

function nameOnlyNote(overrides: { text?: string; eventId?: string | null; sats?: number } = {}) {
  return {
    id: NOTE_ID,
    accountId: 'acc',
    name: 'Ada',
    text: overrides.text ?? 'Ada',
    createdAt: new Date(now()),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    ...(overrides.eventId === undefined ? {} : { eventId: overrides.eventId }),
    ...(overrides.sats === undefined ? {} : { sats: overrides.sats }),
  };
}

async function putAbout(
  store: InMemoryAuthStore,
  body: unknown,
  messages?: InMemoryMessageStore,
): Promise<Response> {
  return mount(store, messages === undefined ? {} : { messages }).request('/me/about', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

describe('PUT /me/about', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/about', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when the body is not { text: string }', async () => {
    const store = await seededStore({ name: 'Ada' });
    const malformed = await mount(store).request('/me/about', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: 'not json',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
    const missing = await putAbout(store, {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
    const wrongType = await putAbout(store, { text: 1 });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
  });

  it('returns 400 when text is longer than 500 characters', async () => {
    const store = await seededStore({ name: 'Ada' });
    const res = await putAbout(store, { text: 'A'.repeat(501) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'About me must be at most 500 characters' });
  });

  it('returns 409 missing name even when a Lightning Address is linked', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    const res = await putAbout(store, { text: BIO });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'missing_requirements', missing: ['name'] });
  });

  it('returns 409 when the stored name is blank after trim', async () => {
    const store = await seededStore({ name: '   ' });
    const res = await putAbout(store, { text: BIO });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'missing_requirements', missing: ['name'] });
  });

  it('updates an existing name-only note when name and Lightning Address are set', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote()]);
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    expect((await messages.getById(NOTE_ID))?.text).toBe(BIO);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.about.set' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('clears About me when text is empty', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote({ text: BIO })]);
    const res = await putAbout(store, { text: '' }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBeNull();
    expect((await messages.getById(NOTE_ID))?.text).toBe('');
  });

  it('creates a profile note without a Lightning Address', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).toEqual(expect.any(String));
    const note = await messages.getById(stored!.profileMessageId!);
    expect(note?.text).toBe(BIO);
    expect(note?.accountId).toBe('acc');
    expect(await messages.listLatest(10)).toHaveLength(1);
  });

  it('notifies bell subscribers when PUT creates a profile note without LN', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const pushStore = new InMemoryPushStore();
    const notificationStore = new InMemoryNotificationStore();
    await pushStore.upsertSubscription({
      accountId: 'other',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const res = await mount(store, { messages, pushStore, notificationStore }).request(
      '/me/about',
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: BIO }),
      },
    );
    expect(res.status).toBe(200);
    const pending = await pushStore.claimPending(10, now(), 60_000);
    expect(pending.some((row) => row.type === 'forum')).toBe(true);
    const listed = await notificationStore.listByRecipient('other', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_post');
    expect(listed[0]?.text).toBe(BIO);
  });

  it('does not notify when PUT writes an already-live profile note', async () => {
    const store = await seededStore({ name: 'Ada' });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote()]);
    const pushStore = new InMemoryPushStore();
    const notificationStore = new InMemoryNotificationStore();
    await pushStore.upsertSubscription({
      accountId: 'other',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const res = await mount(store, { messages, pushStore, notificationStore }).request(
      '/me/about',
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: BIO }),
      },
    );
    expect(res.status).toBe(200);
    expect(await pushStore.claimPending(10, now(), 60_000)).toEqual([]);
    expect(await notificationStore.listByRecipient('other', 10)).toEqual([]);
  });

  it('creates a note when a stale profileMessageId has no row and LN is missing', async () => {
    const store = await seededStore({ name: 'Ada' });
    await patchAccount(store, { profileMessageId: 'gone' });
    const messages = new InMemoryMessageStore();
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).not.toBe('gone');
    expect((await messages.getById(stored!.profileMessageId!))?.text).toBe(BIO);
  });

  it('creates a new live note when the profile note is soft-hidden and LN is missing', async () => {
    const store = await seededStore({ name: 'Ada' });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote()]);
    expect(await messages.markDeleted(NOTE_ID, new Date(now()), 'staff')).toBe(true);
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    expect((await messages.getById(NOTE_ID))?.deletedAt).toBeInstanceOf(Date);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).not.toBe(NOTE_ID);
    expect(stored?.profileMessageId).toEqual(expect.any(String));
    const live = await messages.getById(stored!.profileMessageId!);
    expect(live?.deletedAt).toBeNull();
    expect(live?.text).toBe(BIO);
  });

  it('ensures a missing note when name and Lightning Address are set, then writes the bio', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    const messages = new InMemoryMessageStore();
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).toEqual(expect.any(String));
    const note = await messages.getById(stored!.profileMessageId!);
    expect(note?.text).toBe(BIO);
    expect(note?.text).not.toBe('Ada');
    expect(await messages.listLatest(10)).toHaveLength(1);
  });

  it('ensures a missing note with a defined pushStore, then writes the bio', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    const res = await mount(store, { pushStore: new InMemoryPushStore() }).request('/me/about', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: BIO }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
  });

  it('ensures then updates when profileMessageId points at a missing row and LN is set', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: 'gone' });
    const messages = new InMemoryMessageStore();
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).not.toBe('gone');
    expect((await messages.getById(stored!.profileMessageId!))?.text).toBe(BIO);
  });

  it('ensures a new live note when the profile note is soft-hidden and LN is set', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote()]);
    expect(await messages.markDeleted(NOTE_ID, new Date(now()), 'staff')).toBe(true);
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    expect((await messages.getById(NOTE_ID))?.deletedAt).toBeInstanceOf(Date);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).not.toBe(NOTE_ID);
    const live = await messages.getById(stored!.profileMessageId!);
    expect(live?.deletedAt).toBeNull();
    expect(live?.text).toBe(BIO);
  });

  it('returns 503 when updateText throws', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote()]);
    vi.spyOn(messages, 'updateText').mockRejectedValue(new Error('store down'));
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.about.failed')).toBe(true);
  });

  it('resets the signed event after a bio PUT on a published sats=0 note', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const eventId = 'ee'.repeat(32);
    const messages = new InMemoryMessageStore([nameOnlyNote({ eventId, sats: 0 })]);
    expect((await messages.getById(NOTE_ID))?.eventId).toBe(eventId);
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    expect((await messages.getById(NOTE_ID))?.eventId).toBeNull();
    expect((await messages.getById(NOTE_ID))?.text).toBe(BIO);
  });

  it('does not reset a signed event when the note already has sats', async () => {
    const store = await seededStore({ name: 'Ada', lightningAddress: ADDRESS });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const eventId = 'ee'.repeat(32);
    const messages = new InMemoryMessageStore([nameOnlyNote({ eventId, sats: 21 })]);
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    expect((await messages.getById(NOTE_ID))?.eventId).toBe(eventId);
    expect((await messages.getById(NOTE_ID))?.text).toBe(BIO);
  });

  it('deletes a raced insert when another profile note already won', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const winnerId = '22222222-2222-4222-8222-222222222222';
    await messages.create({
      id: winnerId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      vi.spyOn(store, 'getAccount').mockResolvedValue({
        ...account!,
        profileMessageId: winnerId,
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    expect((await messages.getById(winnerId))?.text).toBe(BIO);
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
  });

  it('deletes the insert when a later write wins the profile pointer', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const winnerId = '22222222-2222-4222-8222-222222222222';
    await messages.create({
      id: winnerId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      let calls = 0;
      vi.spyOn(store, 'getAccount').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return account;
        }
        return { ...account!, profileMessageId: winnerId };
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBe(BIO);
    expect((await messages.getById(winnerId))?.text).toBe(BIO);
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
  });

  it('returns 401 and deletes the insert when the account vanishes after create', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const originalCreate = messages.create.bind(messages);
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      vi.spyOn(store, 'getAccount').mockResolvedValue(undefined);
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('returns 503 when the confirmed pointer has no message row', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      let calls = 0;
      vi.spyOn(store, 'getAccount').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return account;
        }
        return { ...account!, profileMessageId: 'missing-winner' };
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('returns 401 and deletes the insert when the account vanishes after update', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      let calls = 0;
      vi.spyOn(store, 'getAccount').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return account;
        }
        return undefined;
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('returns 503 and deletes the insert when claimProfileMessageId throws after create', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    vi.spyOn(store, 'claimProfileMessageId').mockRejectedValue(new Error('store down'));
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(await messages.listLatest(10)).toHaveLength(0);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.about.failed')).toBe(true);
  });

  it('returns 401 and deletes the insert when claimProfileMessageId loses and the account vanishes', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(store, 'claimProfileMessageId').mockResolvedValue(false);
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      let calls = 0;
      vi.spyOn(store, 'getAccount').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return account;
        }
        return undefined;
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('returns 503 and deletes the insert when claimProfileMessageId loses and the pointer is not live', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const originalCreate = messages.create.bind(messages);
    const originalGet = store.getAccount.bind(store);
    const account = await originalGet('acc');
    expect(account).toBeDefined();
    vi.spyOn(store, 'claimProfileMessageId').mockResolvedValue(false);
    vi.spyOn(messages, 'create').mockImplementation(async (row) => {
      const created = await originalCreate(row);
      let calls = 0;
      vi.spyOn(store, 'getAccount').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return account;
        }
        return { ...account!, profileMessageId: 'missing-winner' };
      });
      return created;
    });
    const res = await putAbout(store, { text: BIO }, messages);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('keeps exactly one live top-level note when two PUTs race without a profile note', async () => {
    const store = await seededStore({ name: 'Ada' });
    const messages = new InMemoryMessageStore();
    const app = mount(store, { messages });
    const [first, second] = await Promise.all([
      app.request('/me/about', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: 'One' }),
      }),
      app.request('/me/about', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: 'Two' }),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const live = (await messages.listLatest(10)).filter((row) => row.parentId === null);
    expect(live).toHaveLength(1);
    const stored = await store.getAccount('acc');
    expect(stored?.profileMessageId).toBe(live[0]?.id);
    expect(await messages.getById(live[0]!.id)).toBeDefined();
  });
});

describe('GET /me aboutMe', () => {
  it('returns aboutMe null when the profile note is only the display name', async () => {
    const store = await seededStore({ name: 'Ada' });
    await patchAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([nameOnlyNote({ text: 'Ada' })]);
    const res = await mount(store, { messages }).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aboutMe: string | null };
    expect(body.aboutMe).toBeNull();
  });
});
