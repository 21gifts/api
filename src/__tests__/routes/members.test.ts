import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { InMemoryTrustStore } from '@/lib/trust-store';
import { removeForumVideo, writeForumVideo } from '@/lib/video';
import { membersRoutes } from '@/routes/members';
import { LNURL_SERVER, WALLET_PUBKEY, createWalletAccount } from '@/__tests__/helpers/wallet-lnurl';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POST_NEW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MEMBER_REPLY_OLD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MEMBER_REPLY_NEW = '77777777-7777-4777-8777-777777777777';
const OTHER_POST = '99999999-9999-4999-8999-999999999999';
const OTHER_REPLY = '88888888-8888-4888-8888-888888888888';

function loggedEvents(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => (JSON.parse(arg) as { event?: string }).event)
    .filter((event): event is string => typeof event === 'string');
}

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
  fundingStore: InMemoryFundingStore = new InMemoryFundingStore(),
): Hono {
  return new Hono().route(
    '/members',
    membersRoutes({
      authStore,
      messageStore,
      trustStore,
      fundingStore,
      now,
      lnurlServer: LNURL_SERVER,
    }),
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
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: overrides.rulesAgreedAt === undefined ? now() : overrides.rulesAgreedAt,
  });
  await store.createSession({ token: 'tok', accountId: 'caller', createdAt: now() });
  return store;
}

async function addAccount(
  store: InMemoryAuthStore,
  id: string,
  viewKey: string,
  extras: { name?: string; wallet?: boolean } = {},
): Promise<void> {
  await store.createAccount({
    id,
    linkingKey: null,
    role: 'verified',
    name: extras.name ?? 'Ada',
    walletRequired: true,
    forumLawsDismissed: false,
    location: null,
    viewKey,
    createdAt: 1_700_000_000_000,
    rulesAgreedAt: now(),
  });
  if (extras.wallet === true) {
    await verifyWallet(store, id);
  }
}

/** Give `id` the username `ada` and a verified wallet (`ada@example.test`). */
async function verifyWallet(store: InMemoryAuthStore, id: string): Promise<void> {
  const account = await store.getAccount(id);
  await store.updateAccount({ ...account!, username: 'ada' });
  await store.claimSparkPubkey(id, WALLET_PUBKEY);
  await store.markSparkPubkeyVerified(id, WALLET_PUBKEY, 'ada', 1);
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      rulesAgreedAt: now(),
      profileMessageId: noteId,
      walletRequired: true,
    });
    await verifyWallet(authStore, ACCOUNT_ID);
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
      username: 'ada',
      location: null,
      role: 'verified',
      lightningAddress: 'ada@example.test',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      aboutMe: null,
      aboutMeHasPhoto: false,
      postCount: 1,
      replyCount: 0,
      shopCount: 0,
      creditCount: 0,
    });
    expect(body).not.toHaveProperty('viewKey');
    expect(body).not.toHaveProperty('eventId');
    expect(body).not.toHaveProperty('linkingKey');
    expect(body).not.toHaveProperty('staffTag');
    const profile = body['profileMessage'] as Record<string, unknown>;
    expect(profile['text']).toBe('Ada');
    expect(profile['accountId']).toBe(ACCOUNT_ID);
    expect(profile['payable']).toBe(true);
    expect(profile).not.toHaveProperty('eventId');
    expect(body['trust']).toEqual(NULL_TRUST);
    expect(body['aboutMe']).toBeNull();
    expect(body['aboutMeHasPhoto']).toBe(false);
    expect(body['fundingReviewedAt']).toBeNull();
  });

  it('includes staffTag only when the account has the software_developer label', async () => {
    const authStore = await seededCaller();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Dan',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      rulesAgreedAt: now(),
      staffTag: 'software_developer',
    });
    const withTag = await mount(authStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(withTag.status).toBe(200);
    expect(((await withTag.json()) as { staffTag?: string }).staffTag).toBe('software_developer');

    const otherId = OTHER_ID;
    await addAccount(authStore, otherId, 'c'.repeat(64));
    const withoutTag = await mount(authStore).request(`/members/${otherId}`, {
      headers: AUTH,
    });
    expect(withoutTag.status).toBe(200);
    expect(await withoutTag.json()).not.toHaveProperty('staffTag');
  });

  it('defaults fundingStore when omitted from membersRoutes', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const res = await new Hono()
      .route(
        '/members',
        membersRoutes({
          authStore,
          messageStore: new InMemoryMessageStore(),
          trustStore: new InMemoryTrustStore(),
          now,
        }),
      )
      .request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { fundingReviewedAt: number | null }).fundingReviewedAt,
    ).toBeNull();
  });

  it('returns fundingReviewedAt only when the grant is admitted', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: ACCOUNT_ID,
        status: 'admitted',
        appliedAt: 1,
        decidedAt: now(),
        decidedBy: 'caller',
        trialUtcDate: null,
        admittedAt: now(),
        note: null,
      },
    ]);
    const admitted = await mount(
      authStore,
      new InMemoryMessageStore(),
      new InMemoryTrustStore(),
      fundingStore,
    ).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(admitted.status).toBe(200);
    expect(
      ((await admitted.json()) as { fundingReviewedAt: number | null }).fundingReviewedAt,
    ).toBe(now());

    const pendingStore = new InMemoryFundingStore([
      {
        accountId: ACCOUNT_ID,
        status: 'pending',
        appliedAt: 1,
        decidedAt: null,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: now(),
        note: null,
      },
    ]);
    const pending = await mount(
      authStore,
      new InMemoryMessageStore(),
      new InMemoryTrustStore(),
      pendingStore,
    ).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(
      ((await pending.json()) as { fundingReviewedAt: number | null }).fundingReviewedAt,
    ).toBeNull();
  });

  it('marks the profile note not payable when eventId is empty', async () => {
    const authStore = await seededCaller();
    const noteId = '55555555-5555-4555-8555-555555555555';
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    const existing = await authStore.getAccount(ACCOUNT_ID);
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...existing,
      profileMessageId: noteId,
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileMessage: { payable: boolean } };
    expect(body.profileMessage.payable).toBe(false);
  });

  it('sets aboutMeHasPhoto true when the live note has a jpeg photo', async () => {
    const authStore = await seededCaller();
    const messageStore = new InMemoryMessageStore();
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      rulesAgreedAt: now(),
      profileMessageId: noteId,
    });
    await messageStore.create(
      {
        id: noteId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
        eventId: 'ee'.repeat(32),
      },
      { contentType: 'image/jpeg', bytes: jpeg },
    );
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
      profileMessage: { hasPhoto: boolean } | null;
    };
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(true);
    expect(body.profileMessage?.hasPhoto).toBe(true);
  });

  it('returns aboutMe from a real profile-note bio and keeps profileMessage', async () => {
    const authStore = await seededCaller();
    const messageStore = new InMemoryMessageStore();
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      location: null,
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
      text: 'I build on Bitcoin',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aboutMe: string | null;
      profileMessage: { text: string } | null;
    };
    expect(body.aboutMe).toBe('I build on Bitcoin');
    expect(body.profileMessage?.text).toBe('I build on Bitcoin');
  });

  it('returns aboutMe null when the note is the stored name after a rename', async () => {
    const authStore = await seededCaller();
    const messageStore = new InMemoryMessageStore();
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Grace',
      location: null,
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
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string | null;
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
    };
    expect(body.name).toBe('Grace');
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(false);
  });

  it('returns profileMessage null when no note exists', async () => {
    const authStore = await seededCaller();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
    });
    const res = await mount(authStore).request(`/members/${ACCOUNT_ID}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      location: string | null;
      profileMessage: null;
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
      postCount: number;
      replyCount: number;
      shopCount: number;
      creditCount: number;
      trust: typeof NULL_TRUST;
    };
    expect(body.location).toBeNull();
    expect(body.profileMessage).toBeNull();
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(false);
    expect(body.postCount).toBe(0);
    expect(body.replyCount).toBe(0);
    expect(body.shopCount).toBe(0);
    expect(body.creditCount).toBe(0);
    expect(body.trust).toEqual(NULL_TRUST);
  });

  it('returns populated trust actors from stored edges', async () => {
    const authStore = await seededCaller();
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
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
      forumLawsDismissed: false,
      location: null,
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
      forumLawsDismissed: false,
      location: null,
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
    const body = (await res.json()) as {
      profileMessage: null;
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
      postCount: number;
      replyCount: number;
      shopCount: number;
      creditCount: number;
    };
    expect(body.profileMessage).toBeNull();
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(false);
    expect(body.postCount).toBe(0);
    expect(body.replyCount).toBe(0);
    expect(body.shopCount).toBe(0);
    expect(body.creditCount).toBe(0);
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

  it('returns the uncapped shop count using assigned-shop ownership', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '2a2a2a2a-2a2a-42a2-82a2-2a2a2a2a2a2a',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: '#21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: '#21GiftsShop assigned away',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      shopAccount: { id: OTHER_ID, username: 'bob', name: 'Bob' },
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ postCount: 2, replyCount: 0, shopCount: 1, creditCount: 0 }),
    );
  });

  it('returns the uncapped credit count for notes this member authored', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '4a4a4a4a-4a4a-44a4-84a4-4a4a4a4a4a4a',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'credit',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalRepayable: true,
    });
    await messageStore.create({
      id: '4b4b4b4b-4b4b-44b4-84b4-4b4b4b4b4b4b',
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other credit',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalRepayable: true,
      shopAccount: { id: ACCOUNT_ID, username: 'ada', name: 'Ada' },
    });
    await messageStore.create({
      id: '4c4c4c4c-4c4c-44c4-84c4-4c4c4c4c4c4c',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'ask',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 100,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ postCount: 2, replyCount: 0, shopCount: 0, creditCount: 1 }),
    );
  });
});

describe('GET /members/:accountId/posts', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/members/${ACCOUNT_ID}/posts`);
    expect(res.status).toBe(401);
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      `/members/${ACCOUNT_ID}/posts`,
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededCaller()).request('/members/not-a-uuid/posts', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const res = await mount(await seededCaller()).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns an empty list when the member has replies but no top-level notes', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: MEMBER_REPLY_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'member reply',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('lists the member live top-level notes newest-first and omits replies and other authors', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: POST_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'older post',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
    });
    await messageStore.create({
      id: POST_NEW,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'newer post',
      createdAt: new Date(now() + 1_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    await messageStore.create({
      id: MEMBER_REPLY_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'member reply',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: POST_OLD,
    });
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other post',
      createdAt: new Date(now() + 3_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
    });
    await messageStore.create({
      id: OTHER_REPLY,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other reply',
      createdAt: new Date(now() + 4_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: POST_NEW,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        accountId?: string;
        replyCount?: number;
        payable: boolean;
        parentId?: string;
      }>;
    };
    expect(body.messages.map((row) => row.id)).toEqual([POST_NEW, POST_OLD]);
    expect(body.messages[0]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]).not.toHaveProperty('parentId');
    expect(body.messages[1]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[1]?.replyCount).toBe(1);
    expect(body.messages[1]?.payable).toBe(false);
    expect(body.messages[1]).not.toHaveProperty('parentId');
  });

  it('keeps a post whose video file is present', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const keptId = '5c5051d3-adba-44f9-a964-9bd0df1ce096';
    const bytes = new Uint8Array(32);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await writeForumVideo(keptId, { contentType: 'video/mp4', bytes });
    try {
      const messageStore = new InMemoryMessageStore([
        {
          id: keptId,
          accountId: ACCOUNT_ID,
          name: 'Ada',
          text: 'clip',
          createdAt: new Date(now()),
          ...unsignedNostrDefaults(),
          hasPhoto: false,
          hasVideo: true,
          videoContentType: 'video/mp4',
        },
      ]);
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string; hasVideo: boolean }> };
      expect(body.messages).toEqual([expect.objectContaining({ id: keptId, hasVideo: true })]);
      expect(await messageStore.getById(keptId)).toBeDefined();
    } finally {
      await removeForumVideo(keptId, 'video/mp4');
    }
  });

  it('drops a missing-file video post from the list', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const goneId = '5c5051d3-adba-44f9-a964-9bd0df1ce090';
    const messageStore = new InMemoryMessageStore([
      {
        id: goneId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await messageStore.getById(goneId)).toBeUndefined();
  });

  it('keeps a missing-file video credit that the store refuses to delete', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const creditId = '5c5051d3-adba-44f9-a964-9bd0df1ce0a0';
    const messageStore = new InMemoryMessageStore([
      {
        id: creditId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'credit clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        sats: 5,
        goalSats: 10,
        goalRepayable: true,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((row) => row.id)).toEqual([creditId]);
    expect(await messageStore.getById(creditId)).toBeDefined();
  });

  it('omits a missing-file video row the store keeps but that is gone or hidden on reread', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const goneId = '5c5051d3-adba-44f9-a964-9bd0df1ce0a1';
    const hiddenId = '5c5051d3-adba-44f9-a964-9bd0df1ce0a2';
    const clip = (id: string): MessageRow => ({
      id,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'clip gone',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: true,
      videoContentType: 'video/mp4',
    });
    class KeepingStore extends InMemoryMessageStore {
      override deleteById(): Promise<boolean> {
        return Promise.resolve(false);
      }
      override getById(id: string): Promise<MessageRow | undefined> {
        return Promise.resolve(
          id === hiddenId ? { ...clip(id), deletedAt: new Date(1), deletedBy: 'staff' } : undefined,
        );
      }
    }
    const messageStore = new KeepingStore([clip(goneId), clip(hiddenId)]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages).toEqual([]);
  });

  it('subtracts dropped missing-file video replies from replyCount', async () => {
    const parentId = '5c5051d3-adba-44f9-a964-9bd0df1ce091';
    const goneChildId = '5c5051d3-adba-44f9-a964-9bd0df1ce092';
    const keptChildId = '5c5051d3-adba-44f9-a964-9bd0df1ce093';
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'live parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: goneChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: keptChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'text reply',
        createdAt: new Date(now() + 2),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; replyCount: number }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(await messageStore.getById(goneChildId)).toBeUndefined();
  });

  it('returns 503 when listPostsByAccount throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const authStore = await seededCaller();
      await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
      const messageStore = new InMemoryMessageStore();
      vi.spyOn(messageStore, 'listPostsByAccount').mockRejectedValue(new Error('boom'));
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/posts`, {
        headers: AUTH,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(loggedEvents(warn)).toContain('members.posts.failed');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GET /members/:accountId/shops', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/members/${ACCOUNT_ID}/shops`);
    expect(res.status).toBe(401);
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      `/members/${ACCOUNT_ID}/shops`,
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededCaller()).request('/members/not-a-uuid/shops', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const res = await mount(await seededCaller()).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns an empty list when the member has replies and non-shop notes but no shop', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    const nonShopId = '31313131-3131-4131-8131-313131313131';
    await messageStore.create({
      id: nonShopId,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'ordinary note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '32323232-3232-4232-8232-323232323232',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: '#21GiftsShop in a reply',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: nonShopId,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('lists only the member shops newest-first with the posts serialization', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    const messageStore = new InMemoryMessageStore();
    const older = '33333333-3333-4333-8333-333333333333';
    const newer = '34343434-3434-4434-8434-343434343434';
    await messageStore.create({
      id: older,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Older #21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
    });
    await messageStore.create({
      id: newer,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'Newer #21GiftsShop',
      createdAt: new Date(now() + 1_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
      shopAccount: { id: ACCOUNT_ID, username: 'ada', name: 'Ada' },
    });
    await messageStore.create({
      id: '35353535-3535-4535-8535-353535353535',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'not a shop',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '36363636-3636-4636-8636-363636363636',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now() + 3_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: newer,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        accountId?: string;
        replyCount?: number;
        payable: boolean;
        parentId?: string;
        role?: string;
      }>;
    };
    expect(body.messages.map((item) => item.id)).toEqual([newer, older]);
    expect(body.messages[0]?.accountId).toBe(OTHER_ID);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('basis');
    expect(body.messages[0]).not.toHaveProperty('parentId');
    expect(body.messages[1]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[1]?.replyCount).toBe(0);
    expect(body.messages[1]?.payable).toBe(false);
    expect(body.messages[1]).not.toHaveProperty('parentId');
  });

  it('lists the member own shop as payable with verified role when the author has a wallet', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    const messageStore = new InMemoryMessageStore();
    const id = '4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d';
    await messageStore.create({
      id,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: '#21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; payable: boolean; role?: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(id);
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]?.role).toBe('verified');
  });

  it('uses the author not the profile owner for an assigned shop', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    await authStore.createAccount({
      id: OTHER_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Bob',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1_700_000_000_000,
      rulesAgreedAt: now(),
      staffTag: 'software_developer',
    });
    const messageStore = new InMemoryMessageStore();
    const id = '4e4e4e4e-4e4e-44e4-84e4-4e4e4e4e4e4e';
    await messageStore.create({
      id,
      accountId: OTHER_ID,
      name: 'Bob',
      text: '#21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
      shopAccount: { id: ACCOUNT_ID, username: 'ada', name: 'Ada' },
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        accountId?: string;
        payable: boolean;
        role?: string;
        staffTag?: string;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(id);
    expect(body.messages[0]?.accountId).toBe(OTHER_ID);
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('verified');
    expect(body.messages[0]?.staffTag).toBe('software_developer');
  });

  it('lists a shop as not payable when the member has no verified wallet', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    const id = '3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c';
    await messageStore.create({
      id,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: '#21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; payable: boolean }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(id);
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('keeps a shop whose video file is present', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const keptId = '37373737-3737-4737-8737-373737373737';
    const bytes = new Uint8Array(32);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await writeForumVideo(keptId, { contentType: 'video/mp4', bytes });
    try {
      const messageStore = new InMemoryMessageStore([
        {
          id: keptId,
          accountId: ACCOUNT_ID,
          name: 'Ada',
          text: '#21GiftsShop clip',
          createdAt: new Date(now()),
          ...unsignedNostrDefaults(),
          hasPhoto: false,
          hasVideo: true,
          videoContentType: 'video/mp4',
        },
      ]);
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string; hasVideo: boolean }> };
      expect(body.messages).toEqual([expect.objectContaining({ id: keptId, hasVideo: true })]);
      expect(await messageStore.getById(keptId)).toBeDefined();
    } finally {
      await removeForumVideo(keptId, 'video/mp4');
    }
  });

  it('drops a missing-file video shop from the list', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const goneId = '38383838-3838-4838-8838-383838383838';
    const messageStore = new InMemoryMessageStore([
      {
        id: goneId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: '#21GiftsShop clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await messageStore.getById(goneId)).toBeUndefined();
  });

  it('subtracts dropped missing-file video replies from shop replyCount', async () => {
    const parentId = '39393939-3939-4939-8939-393939393939';
    const goneChildId = '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a';
    const keptChildId = '3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b';
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: '#21GiftsShop live parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: goneChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: keptChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'text reply',
        createdAt: new Date(now() + 2),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; replyCount: number }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(await messageStore.getById(goneChildId)).toBeUndefined();
  });

  it('returns 503 when listShopsByAccount throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const authStore = await seededCaller();
      await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
      const messageStore = new InMemoryMessageStore();
      vi.spyOn(messageStore, 'listShopsByAccount').mockRejectedValue(new Error('boom'));
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
        headers: AUTH,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(loggedEvents(warn)).toContain('members.shops.failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('lists an assigned external shop as not payable and without a role', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '4f4f4f4f-4f4f-44f4-84f4-4f4f4f4f4f4f',
      accountId: null,
      name: '',
      text: '#21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
      authorPubkey: 'ab'.repeat(32),
      shopAccount: { id: ACCOUNT_ID, username: 'ada', name: 'Ada' },
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/shops`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        payable: boolean;
        via?: string;
        role?: string;
        accountId?: string;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]).not.toHaveProperty('role');
    expect(body.messages[0]).not.toHaveProperty('accountId');
    expect(body.messages[0]?.via).toBe('nostr');
  });
});

describe('GET /members/:accountId/credits', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/members/${ACCOUNT_ID}/credits`);
    expect(res.status).toBe(401);
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      `/members/${ACCOUNT_ID}/credits`,
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededCaller()).request('/members/not-a-uuid/credits', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const res = await mount(await seededCaller()).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns an empty list when the member has replies and non-credit notes but no credit', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    const nonCreditId = '51515151-5151-4151-8151-515151515151';
    await messageStore.create({
      id: nonCreditId,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'ordinary note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '52525252-5252-4252-8252-525252525252',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'repayable in a reply',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: nonCreditId,
      goalRepayable: true,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('lists only the member credits newest-first with the posts serialization', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    const messageStore = new InMemoryMessageStore();
    const older = '53535353-5353-4353-8353-535353535353';
    const newer = '54545454-5454-4454-8454-545454545454';
    await messageStore.create({
      id: older,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Older credit',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
      goalRepayable: true,
    });
    await messageStore.create({
      id: newer,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Newer credit',
      createdAt: new Date(now() + 1_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
      goalRepayable: true,
      shopAccount: { id: OTHER_ID, username: 'bob', name: 'Bob' },
    });
    await messageStore.create({
      id: '55555555-5555-4555-8555-555555555555',
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'assigned to member',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
      goalRepayable: true,
      shopAccount: { id: ACCOUNT_ID, username: 'ada', name: 'Ada' },
    });
    await messageStore.create({
      id: '56565656-5656-4656-8656-565656565656',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'not a credit',
      createdAt: new Date(now() + 3_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 100,
    });
    await messageStore.create({
      id: '57575757-5757-4757-8757-575757575757',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now() + 4_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: newer,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        accountId?: string;
        replyCount?: number;
        payable: boolean;
        parentId?: string;
      }>;
    };
    expect(body.messages.map((item) => item.id)).toEqual([newer, older]);
    expect(body.messages[0]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]).not.toHaveProperty('parentId');
    expect(body.messages[1]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[1]?.replyCount).toBe(0);
    expect(body.messages[1]?.payable).toBe(false);
    expect(body.messages[1]).not.toHaveProperty('parentId');
  });

  it('lists a credit as not payable when the member has no verified wallet', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore();
    const id = '59595959-5959-4959-8959-595959595959';
    await messageStore.create({
      id,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'A credit',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
      goalRepayable: true,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; payable: boolean }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(id);
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('keeps a credit whose video file is present', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const keptId = '58585858-5858-4858-8858-585858585858';
    const bytes = new Uint8Array(32);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await writeForumVideo(keptId, { contentType: 'video/mp4', bytes });
    try {
      const messageStore = new InMemoryMessageStore([
        {
          id: keptId,
          accountId: ACCOUNT_ID,
          name: 'Ada',
          text: 'credit clip',
          createdAt: new Date(now()),
          ...unsignedNostrDefaults(),
          hasPhoto: false,
          hasVideo: true,
          videoContentType: 'video/mp4',
          goalRepayable: true,
        },
      ]);
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string; hasVideo: boolean }> };
      expect(body.messages).toEqual([expect.objectContaining({ id: keptId, hasVideo: true })]);
      expect(await messageStore.getById(keptId)).toBeDefined();
    } finally {
      await removeForumVideo(keptId, 'video/mp4');
    }
  });

  it('drops a missing-file video credit from the list', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const goneId = '59595959-5959-4959-8959-595959595959';
    const messageStore = new InMemoryMessageStore([
      {
        id: goneId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'credit clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        goalRepayable: true,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await messageStore.getById(goneId)).toBeUndefined();
  });

  it('subtracts dropped missing-file video replies from credit replyCount', async () => {
    const parentId = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
    const goneChildId = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b';
    const keptChildId = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c';
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    const messageStore = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'credit live parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        goalRepayable: true,
      },
      {
        id: goneChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: keptChildId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'text reply',
        createdAt: new Date(now() + 2),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; replyCount: number }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(1);
    expect(await messageStore.getById(goneChildId)).toBeUndefined();
  });

  it('returns 503 when listCreditsByAccount throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const authStore = await seededCaller();
      await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
      const messageStore = new InMemoryMessageStore();
      vi.spyOn(messageStore, 'listCreditsByAccount').mockRejectedValue(new Error('boom'));
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/credits`, {
        headers: AUTH,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(loggedEvents(warn)).toContain('members.credits.failed');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GET /members/:accountId/replies', () => {
  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/members/${ACCOUNT_ID}/replies`);
    expect(res.status).toBe(401);
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      `/members/${ACCOUNT_ID}/replies`,
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededCaller()).request('/members/not-a-uuid/replies', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const res = await mount(await seededCaller()).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns an empty list when the member has top-level notes but no replies', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: POST_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'member post',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other post',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('lists the member live replies newest-first with parentId and payable from eventId and wallet', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: POST_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'member post',
      createdAt: new Date(now() + 500),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    await messageStore.create({
      id: MEMBER_REPLY_OLD,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'older reply',
      createdAt: new Date(now() + 1_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
    });
    await messageStore.create({
      id: MEMBER_REPLY_NEW,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'newer reply',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
      eventId: 'ee'.repeat(32),
    });
    await messageStore.create({
      id: OTHER_REPLY,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other reply',
      createdAt: new Date(now() + 3_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        id: string;
        accountId?: string;
        parentId?: string;
        payable: boolean;
        replyCount?: number;
      }>;
    };
    expect(body.messages.map((row) => row.id)).toEqual([MEMBER_REPLY_NEW, MEMBER_REPLY_OLD]);
    expect(body.messages[0]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[0]?.parentId).toBe(OTHER_POST);
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]).not.toHaveProperty('replyCount');
    expect(body.messages[1]?.accountId).toBe(ACCOUNT_ID);
    expect(body.messages[1]?.parentId).toBe(OTHER_POST);
    expect(body.messages[1]?.payable).toBe(false);
    expect(body.messages[1]).not.toHaveProperty('replyCount');
  });

  it('lists member replies as not payable when the member has no verified wallet', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: MEMBER_REPLY_NEW,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'signed reply',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; payable: boolean }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(MEMBER_REPLY_NEW);
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('lists member replies as not payable when eventId is empty', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { wallet: true });
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: OTHER_POST,
      accountId: OTHER_ID,
      name: 'Bob',
      text: 'other parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: MEMBER_REPLY_NEW,
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'empty eventId reply',
      createdAt: new Date(now() + 2_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: OTHER_POST,
      eventId: '',
    });
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('drops a missing-file video reply from the list', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const goneId = '5c5051d3-adba-44f9-a964-9bd0df1ce094';
    const messageStore = new InMemoryMessageStore([
      {
        id: OTHER_POST,
        accountId: OTHER_ID,
        name: 'Bob',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
      },
      {
        id: goneId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId: OTHER_POST,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await messageStore.getById(goneId)).toBeUndefined();
  });

  it('omits a reply that cannot serialize and still returns siblings', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
    await addAccount(authStore, OTHER_ID, 'c'.repeat(64), { name: 'Bob' });
    const badId = '5c5051d3-adba-44f9-a964-9bd0df1ce095';
    const messageStore = new InMemoryMessageStore([
      {
        id: OTHER_POST,
        accountId: OTHER_ID,
        name: 'Bob',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
      },
      {
        id: badId,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'bad date',
        createdAt: new Date(Number.NaN),
        ...unsignedNostrDefaults(),
        parentId: OTHER_POST,
        hasPhoto: false,
      },
      {
        id: MEMBER_REPLY_NEW,
        accountId: ACCOUNT_ID,
        name: 'Ada',
        text: 'ok reply',
        createdAt: new Date(now() + 2),
        ...unsignedNostrDefaults(),
        parentId: OTHER_POST,
        hasPhoto: false,
      },
    ]);
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((row) => row.id)).toEqual([MEMBER_REPLY_NEW]);
  });

  it('returns 503 when listRepliesByAccount throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const authStore = await seededCaller();
      await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64));
      const messageStore = new InMemoryMessageStore();
      vi.spyOn(messageStore, 'listRepliesByAccount').mockRejectedValue(new Error('boom'));
      const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}/replies`, {
        headers: AUTH,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(loggedEvents(warn)).toContain('members.replies.failed');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('payable notes of a wallet-backed member', () => {
  const PROFILE = '66666666-6666-4666-8666-666666666666';

  async function walletMember(lnurlServer: boolean): Promise<Hono> {
    const authStore = await seededCaller();
    await createWalletAccount(authStore, ACCOUNT_ID, 'wally');
    const member = await authStore.getAccount(ACCOUNT_ID);
    if (member === undefined) {
      throw new Error('expected member');
    }
    await authStore.updateAccount({ ...member, profileMessageId: PROFILE });
    const messageStore = new InMemoryMessageStore();
    const note = (id: string, parentId: string | null) => ({
      id,
      accountId: ACCOUNT_ID,
      name: 'wally',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: id.replaceAll('-', '').padEnd(64, '0'),
      ...(parentId === null ? {} : { parentId }),
    });
    await messageStore.create(note(PROFILE, null));
    await messageStore.create(note(POST_NEW, null));
    await messageStore.create(note(MEMBER_REPLY_NEW, POST_NEW));
    return new Hono().route(
      '/members',
      membersRoutes({
        authStore,
        messageStore,
        trustStore: new InMemoryTrustStore(),
        fundingStore: new InMemoryFundingStore(),
        now,
        ...(lnurlServer ? { lnurlServer: LNURL_SERVER } : {}),
      }),
    );
  }

  it('marks posts, replies, and the profile note payable only when the LNURL server is on', async () => {
    for (const lnurlServer of [true, false]) {
      const app = await walletMember(lnurlServer);
      const posts = (await (
        await app.request(`/members/${ACCOUNT_ID}/posts`, { headers: AUTH })
      ).json()) as { messages: { payable: boolean }[] };
      expect(posts.messages.length).toBeGreaterThan(0);
      expect(posts.messages.every((m) => m.payable === lnurlServer)).toBe(true);
      const replies = (await (
        await app.request(`/members/${ACCOUNT_ID}/replies`, { headers: AUTH })
      ).json()) as { messages: { payable: boolean }[] };
      expect(replies.messages.length).toBeGreaterThan(0);
      expect(replies.messages.every((m) => m.payable === lnurlServer)).toBe(true);
      const profile = (await (
        await app.request(`/members/${ACCOUNT_ID}`, { headers: AUTH })
      ).json()) as { profileMessage: { payable: boolean } | null };
      expect(profile.profileMessage?.payable).toBe(lnurlServer);
    }
  });
});
