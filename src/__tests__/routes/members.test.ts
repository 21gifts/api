import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { membersRoutes } from '@/routes/members';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mount(
  authStore: InMemoryAuthStore,
  messageStore: InMemoryMessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/members',
    membersRoutes({ authStore, messageStore, now }),
  );
}

async function seededCaller(
  overrides: { rulesAgreedAt?: number | null } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'caller',
    linkingKey: null,
    role: 'basis',
    name: 'Caller',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: overrides.rulesAgreedAt === undefined ? now() : overrides.rulesAgreedAt,
  });
  await store.createSession({ token: 'tok', accountId: 'caller', createdAt: now() });
  return store;
}

describe('GET /members/:accountId', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/members/${ACCOUNT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      `/members/${ACCOUNT_ID}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededCaller()).request('/members/not-a-uuid', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const res = await mount(await seededCaller()).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns live identity with a profileMessage', async () => {
    const authStore = await seededCaller();
    const messageStore = new InMemoryMessageStore();
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      rulesAgreedAt: now(),
      profileMessageId: noteId,
    });
    await messageStore.create({
      id: noteId,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: ACCOUNT_ID,
      name: 'Ada',
      role: 'verified',
      lightningAddress: 'ada@walletofsatoshi.com',
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(body).not.toHaveProperty('viewKey');
    expect(body).not.toHaveProperty('eventId');
    expect(body).not.toHaveProperty('linkingKey');
    const profile = body['profileMessage'] as Record<string, unknown>;
    expect(profile['text']).toBe('Ada');
    expect(profile['accountId']).toBe(ACCOUNT_ID);
    expect(profile['payable']).toBe(true);
    expect(profile).not.toHaveProperty('eventId');
  });

  it('returns profileMessage null when no note exists', async () => {
    const authStore = await seededCaller();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
    });
    const res = await mount(authStore).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileMessage: null };
    expect(body.profileMessage).toBeNull();
  });
});
