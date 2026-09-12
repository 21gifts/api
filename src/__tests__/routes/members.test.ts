import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryTrustStore } from '@/lib/trust-store';
import { membersRoutes } from '@/routes/members';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const NULL_TRUST = {
  verifiedBy: null,
  proposedBy: null,
  confirmedBy: null,
  appointedBy: null,
};

function mount(
  authStore: InMemoryAuthStore,
  messageStore: InMemoryMessageStore = new InMemoryMessageStore(),
  trustStore: InMemoryTrustStore = new InMemoryTrustStore(),
): Hono {
  return new Hono().route('/members', membersRoutes({ authStore, messageStore, trustStore, now }));
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
    expect(body['trust']).toEqual(NULL_TRUST);
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
    const body = (await res.json()) as { profileMessage: null; trust: typeof NULL_TRUST };
    expect(body.profileMessage).toBeNull();
    expect(body.trust).toEqual(NULL_TRUST);
  });

  it('returns populated trust actors from stored edges', async () => {
    const authStore = await seededCaller();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
    });
    const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await authStore.createAccount({
      id: actorId,
      linkingKey: null,
      role: 'moderator',
      name: 'Mod',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
    });
    const edges: TrustEdge[] = [
      {
        id: 'e-verify',
        subjectId: ACCOUNT_ID,
        actorId,
        kind: 'verify',
        createdAt: 1,
      },
      {
        id: 'e-propose',
        subjectId: ACCOUNT_ID,
        actorId,
        kind: 'moderator_propose',
        createdAt: 2,
      },
    ];
    const res = await mount(
      authStore,
      new InMemoryMessageStore(),
      new InMemoryTrustStore(edges),
    ).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trust: typeof NULL_TRUST & { verifiedBy: unknown } };
    expect(body.trust).toEqual({
      verifiedBy: { id: actorId, name: 'Mod' },
      proposedBy: { id: actorId, name: 'Mod' },
      confirmedBy: null,
      appointedBy: null,
    });
  });

  it('returns profileMessage null when the profile note is soft-deleted but keeps profileMessageId', async () => {
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
    expect(await messageStore.markDeleted(noteId, new Date(now()), 'staff')).toBe(true);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileMessage: null };
    expect(body.profileMessage).toBeNull();
    const account = await authStore.getAccount(ACCOUNT_ID);
    expect(account?.profileMessageId).toBe(noteId);
  });

  it('returns 503 when getAccount throws', async () => {
    const authStore = await seededCaller();
    const original = authStore.getAccount.bind(authStore);
    vi.spyOn(authStore, 'getAccount').mockImplementation(async (id: string) => {
      if (id === ACCOUNT_ID) {
        throw new Error('store down');
      }
      return original(id);
    });
    const res = await mount(authStore).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });
});
