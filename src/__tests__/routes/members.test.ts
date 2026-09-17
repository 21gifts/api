import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryTrustStore } from '@/lib/trust-store';
import { removeForumVideo, writeForumVideo } from '@/lib/video';
import { membersRoutes } from '@/routes/members';

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
  extras: { name?: string; lightningAddress?: string | null } = {},
): Promise<void> {
  const lightningAddress = extras.lightningAddress === undefined ? null : extras.lightningAddress;
  await store.createAccount({
    id,
    linkingKey: null,
    role: 'verified',
    name: extras.name ?? 'Ada',
    lightningAddress,
    lightningAddressVerified: lightningAddress !== null && lightningAddress !== '',
    forumLawsDismissed: false,
    location: null,
    viewKey,
    createdAt: 1_700_000_000_000,
    rulesAgreedAt: now(),
  });
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
    const res = await mount(authStore, messageStore).request(`/members/${ACCOUNT_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: ACCOUNT_ID,
      name: 'Ada',
      location: null,
      role: 'verified',
      lightningAddress: 'ada@walletofsatoshi.com',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      aboutMe: null,
      aboutMeHasPhoto: false,
      postCount: 1,
      replyCount: 0,
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
    expect(body['aboutMe']).toBeNull();
    expect(body['aboutMeHasPhoto']).toBe(false);
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
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
      trust: typeof NULL_TRUST;
    };
    expect(body.location).toBeNull();
    expect(body.profileMessage).toBeNull();
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(false);
    expect(body.postCount).toBe(0);
    expect(body.replyCount).toBe(0);
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
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
    };
    expect(body.profileMessage).toBeNull();
    expect(body.aboutMe).toBeNull();
    expect(body.aboutMeHasPhoto).toBe(false);
    expect(body.postCount).toBe(0);
    expect(body.replyCount).toBe(0);
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
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), {
      lightningAddress: 'ada@walletofsatoshi.com',
    });
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

  it('lists the member live replies newest-first with parentId and payable from eventId and LN', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), {
      lightningAddress: 'ada@walletofsatoshi.com',
    });
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

  it('lists member replies as not payable when the member has no Lightning Address', async () => {
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

  it('lists member replies as not payable when the Lightning Address is blank', async () => {
    const authStore = await seededCaller();
    await addAccount(authStore, ACCOUNT_ID, 'b'.repeat(64), { lightningAddress: '   ' });
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
