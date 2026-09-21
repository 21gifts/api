import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import type { FundingGrant } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { removeForumVideo, writeForumVideo } from '@/lib/video';
import { fundingRoutes } from '@/routes/funding';

const now = (): number => 1_700_000_000_000;
const TODAY = '2023-11-14';
const YESTERDAY = '2023-11-13';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const MOD = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const VERIFIED = '55555555-5555-4555-8555-555555555555';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: partial.name ?? partial.id,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: now(),
    ...partial,
  };
}

function grant(
  partial: Pick<FundingGrant, 'accountId' | 'status'> & Partial<FundingGrant>,
): FundingGrant {
  return {
    appliedAt: now() - 60_000,
    decidedAt: null,
    decidedBy: null,
    trialUtcDate: null,
    admittedAt: null,
    note: null,
    ...partial,
  };
}

async function staffed(
  extras: Account[] = [],
): Promise<{ authStore: InMemoryAuthStore; fundingStore: InMemoryFundingStore }> {
  const authStore = new InMemoryAuthStore();
  await authStore.createAccount(account({ id: FOUNDER, role: 'founder', name: 'Founder' }));
  await authStore.createAccount(account({ id: MOD, role: 'moderator', name: 'Mod' }));
  await authStore.createAccount(account({ id: OTHER, role: 'basis', name: 'Other' }));
  await authStore.createAccount(account({ id: VERIFIED, role: 'verified', name: 'Ada' }));
  await authStore.createSession({ token: 'founder', accountId: FOUNDER, createdAt: now() });
  await authStore.createSession({ token: 'mod', accountId: MOD, createdAt: now() });
  await authStore.createSession({ token: 'other', accountId: OTHER, createdAt: now() });
  await authStore.createSession({ token: 'verified', accountId: VERIFIED, createdAt: now() });
  for (const extra of extras) {
    await authStore.createAccount(extra);
  }
  return { authStore, fundingStore: new InMemoryFundingStore() };
}

function mount(
  authStore: InMemoryAuthStore,
  fundingStore: FundingStore,
  messageStore: InMemoryMessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/funding',
    fundingRoutes({
      authStore,
      fundingStore,
      messageStore,
      now,
    }),
  );
}

function post(
  app: Hono,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function get(app: Hono, path: string, token: string | undefined): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'GET',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

const boomStore: FundingStore = {
  getByAccountId: async () => {
    throw new Error('boom');
  },
  listGrants: async () => {
    throw new Error('boom');
  },
  upsert: async () => {
    throw new Error('boom');
  },
  transition: async () => {
    throw new Error('boom');
  },
  expireTrialIfUnchanged: async () => {
    throw new Error('boom');
  },
};

describe('POST /funding/apply', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/apply', undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 when the caller is basis', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/apply', 'other');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 200 and pending funding for a verified caller', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/apply', 'verified');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      funding: {
        status: 'pending',
        trialUtcDate: null,
        admittedAt: null,
        reviewedByName: null,
      },
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.applied')).toBe(true);
  });

  it('returns 409 when the CAS apply misses after the status check', async () => {
    const { authStore } = await staffed();
    const store: FundingStore = {
      getByAccountId: () => Promise.resolve(undefined),
      listGrants: () => Promise.resolve([]),
      upsert: () => Promise.resolve(grant({ accountId: VERIFIED, status: 'pending' })),
      transition: () => Promise.resolve(undefined),
      expireTrialIfUnchanged: () => Promise.resolve(undefined),
    };
    expect((await post(mount(authStore, store), '/funding/apply', 'verified')).status).toBe(409);
  });

  it('returns 409 when already pending, trial, or admitted', async () => {
    const { authStore, fundingStore } = await staffed();
    const app = mount(authStore, fundingStore);
    expect((await post(app, '/funding/apply', 'verified')).status).toBe(200);
    expect((await post(app, '/funding/apply', 'verified')).status).toBe(409);
    expect(await (await post(app, '/funding/apply', 'verified')).json()).toEqual({
      error: 'Conflict',
    });

    await fundingStore.upsert(
      grant({ accountId: MOD, status: 'trial', trialUtcDate: TODAY, appliedAt: now() }),
    );
    expect((await post(app, '/funding/apply', 'mod')).status).toBe(409);

    await fundingStore.upsert(
      grant({
        accountId: FOUNDER,
        status: 'admitted',
        admittedAt: now(),
        appliedAt: now(),
      }),
    );
    expect((await post(app, '/funding/apply', 'founder')).status).toBe(409);
  });

  it('returns 200 when re-applying after rejected', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(
      grant({
        accountId: VERIFIED,
        status: 'rejected',
        decidedAt: 1,
        decidedBy: FOUNDER,
        appliedAt: 1,
      }),
    );
    const res = await post(mount(authStore, fundingStore), '/funding/apply', 'verified');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { funding: { status: string } }).funding.status).toBe('pending');
    const stored = await fundingStore.getByAccountId(VERIFIED);
    expect(stored?.appliedAt).toBe(now());
    expect(stored?.decidedAt).toBeNull();
    expect(stored?.decidedBy).toBeNull();
  });

  it('returns 503 when the store throws', async () => {
    const { authStore } = await staffed();
    const res = await post(mount(authStore, boomStore), '/funding/apply', 'verified');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Funding is unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.write.failed')).toBe(true);
  });
});

describe('GET /funding/applications', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(mount(authStore, fundingStore), '/funding/applications', undefined);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not staff', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(mount(authStore, fundingStore), '/funding/applications', 'verified');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns an empty list when there are no pending grants', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'trial', trialUtcDate: TODAY }));
    const res = await get(mount(authStore, fundingStore), '/funding/applications', 'mod');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applications: [] });
  });

  it('returns pending applications oldest appliedAt first and includes an expired trial', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(
      grant({ accountId: VERIFIED, status: 'pending', appliedAt: now() - 2 }),
    );
    await fundingStore.upsert(
      grant({
        accountId: SUBJECT,
        status: 'trial',
        trialUtcDate: YESTERDAY,
        appliedAt: now() - 1,
      }),
    );
    await authStore.createAccount(account({ id: SUBJECT, role: 'verified', name: 'Sub' }));
    await fundingStore.upsert(
      grant({
        accountId: MOD,
        status: 'admitted',
        admittedAt: now(),
        appliedAt: now() - 3,
      }),
    );
    const ghost = '66666666-6666-4666-8666-666666666666';
    await fundingStore.upsert(grant({ accountId: ghost, status: 'pending', appliedAt: now() }));
    const res = await get(mount(authStore, fundingStore), '/funding/applications', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applications: [
        { accountId: VERIFIED, name: 'Ada', role: 'verified', appliedAt: now() - 2 },
        { accountId: SUBJECT, name: 'Sub', role: 'verified', appliedAt: now() - 1 },
      ],
    });
    expect((await fundingStore.getByAccountId(SUBJECT))?.status).toBe('pending');
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.applications.listed')).toBe(true);
  });

  it('returns 503 when listing throws', async () => {
    const { authStore } = await staffed();
    const res = await get(mount(authStore, boomStore), '/funding/applications', 'mod');
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.list.failed')).toBe(true);
  });
});

describe('GET /funding/applications/:accountId', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(
      mount(authStore, fundingStore),
      `/funding/applications/${VERIFIED}`,
      undefined,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not staff', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(
      mount(authStore, fundingStore),
      `/funding/applications/${VERIFIED}`,
      'verified',
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-uuid id', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(mount(authStore, fundingStore), '/funding/applications/nope', 'founder');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when there is no grant', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await get(
      mount(authStore, fundingStore),
      `/funding/applications/${VERIFIED}`,
      'founder',
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the account is missing', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: SUBJECT, status: 'pending' }));
    const res = await get(
      mount(authStore, fundingStore),
      `/funding/applications/${SUBJECT}`,
      'founder',
    );
    expect(res.status).toBe(404);
  });

  it('returns account, effective grant, and posts', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(
      grant({
        accountId: VERIFIED,
        status: 'trial',
        trialUtcDate: YESTERDAY,
        appliedAt: 10,
        decidedAt: 20,
      }),
    );
    const postId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const messageStore = new InMemoryMessageStore([
      {
        id: postId,
        accountId: VERIFIED,
        name: 'Ada',
        text: 'hello',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await get(
      mount(authStore, fundingStore, messageStore),
      `/funding/applications/${VERIFIED}`,
      'mod',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { id: string; name: string; role: string };
      grant: { status: string; appliedAt: number; trialUtcDate: string | null };
      messages: Array<{ id: string; text: string }>;
    };
    expect(body.account).toEqual({
      id: VERIFIED,
      name: 'Ada',
      role: 'verified',
      lightningAddress: null,
    });
    expect(body.grant.status).toBe('pending');
    expect(body.grant.appliedAt).toBe(10);
    expect(body.grant.trialUtcDate).toBeNull();
    expect(body.messages[0]?.id).toBe(postId);
    expect(body.messages[0]?.text).toBe('hello');
  });

  it('marks a post payable when the applicant has a Lightning Address and event id', async () => {
    const { authStore, fundingStore } = await staffed();
    const existing = await authStore.getAccount(VERIFIED);
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected verified');
    }
    await authStore.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending' }));
    const postId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const messageStore = new InMemoryMessageStore([
      {
        id: postId,
        accountId: VERIFIED,
        name: 'Ada',
        text: 'hello',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        eventId: 'e'.repeat(64),
      },
    ]);
    const res = await get(
      mount(authStore, fundingStore, messageStore),
      `/funding/applications/${VERIFIED}`,
      'founder',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable?: boolean }> };
    expect(body.messages[0]?.payable).toBe(true);
  });

  it('subtracts missing-file video replies from replyCount', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending' }));
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const messageStore = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: VERIFIED,
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: childId,
        accountId: VERIFIED,
        name: 'Ada',
        text: 'gone',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await get(
      mount(authStore, fundingStore, messageStore),
      `/funding/applications/${VERIFIED}`,
      'founder',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; replyCount: number }> };
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(0);
    expect(await messageStore.getById(childId)).toBeUndefined();
  });

  it('drops a missing-file video post and keeps a present one', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending' }));
    const keptId = '5c5051d3-adba-44f9-a964-9bd0df1ce096';
    const droppedId = '6d6162e4-becb-45fa-b075-ace1ef2df107';
    const bytes = new Uint8Array(32);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await writeForumVideo(keptId, { contentType: 'video/mp4', bytes });
    try {
      const messageStore = new InMemoryMessageStore([
        {
          id: keptId,
          accountId: VERIFIED,
          name: 'Ada',
          text: 'clip',
          createdAt: new Date(now()),
          ...unsignedNostrDefaults(),
          hasPhoto: false,
          hasVideo: true,
          videoContentType: 'video/mp4',
        },
        {
          id: droppedId,
          accountId: VERIFIED,
          name: 'Ada',
          text: 'gone',
          createdAt: new Date(now() - 1),
          ...unsignedNostrDefaults(),
          hasPhoto: false,
          hasVideo: true,
          videoContentType: 'video/mp4',
        },
      ]);
      const res = await get(
        mount(authStore, fundingStore, messageStore),
        `/funding/applications/${VERIFIED}`,
        'founder',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ id: string; hasVideo: boolean }> };
      expect(body.messages.map((row) => row.id)).toEqual([keptId]);
      expect(body.messages[0]?.hasVideo).toBe(true);
      expect(await messageStore.getById(droppedId)).toBeUndefined();
    } finally {
      await removeForumVideo(keptId, 'video/mp4');
    }
  });

  it('returns 503 when the store throws', async () => {
    const { authStore } = await staffed();
    const res = await get(
      mount(authStore, boomStore),
      `/funding/applications/${VERIFIED}`,
      'founder',
    );
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.list.failed')).toBe(true);
  });
});

describe('POST /funding/trial', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/trial', undefined, {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not staff', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/trial', 'verified', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing JSON', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await mount(authStore, fundingStore).request('/funding/trial', {
      method: 'POST',
      headers: { authorization: 'Bearer founder' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with an "accountId" string',
    });
  });

  it('returns 404 for a non-uuid accountId', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/trial', 'founder', {
      accountId: 'nope',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the subject is missing', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/trial', 'founder', {
      accountId: SUBJECT,
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the subject is the caller', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: FOUNDER, status: 'pending' }));
    const res = await post(mount(authStore, fundingStore), '/funding/trial', 'founder', {
      accountId: FOUNDER,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Conflict' });
  });

  it('returns 409 when the subject is basis or not pending', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: OTHER, status: 'pending' }));
    const app = mount(authStore, fundingStore);
    expect((await post(app, '/funding/trial', 'founder', { accountId: OTHER })).status).toBe(409);
    expect((await post(app, '/funding/trial', 'founder', { accountId: VERIFIED })).status).toBe(
      409,
    );
  });

  it('returns 200 and sets trialUtcDate to today UTC', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending', appliedAt: 9 }));
    const res = await post(mount(authStore, fundingStore), '/funding/trial', 'founder', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      role: string;
      funding: { status: string; trialUtcDate: string | null; reviewedByName: string | null };
    };
    expect(body).toMatchObject({ id: VERIFIED, name: 'Ada', role: 'verified' });
    expect(body.funding.status).toBe('trial');
    expect(body.funding.trialUtcDate).toBe(TODAY);
    expect(body.funding.reviewedByName).toBeNull();
    expect((await fundingStore.getByAccountId(VERIFIED))?.appliedAt).toBe(9);
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.trial')).toBe(true);
  });

  it('returns 503 when upsert throws', async () => {
    const { authStore } = await staffed();
    const store: FundingStore = {
      getByAccountId: async () => grant({ accountId: VERIFIED, status: 'pending' }),
      listGrants: async () => [],
      upsert: async () => {
        throw new Error('boom');
      },
      transition: async () => {
        throw new Error('boom');
      },
      expireTrialIfUnchanged: async () => {
        throw new Error('boom');
      },
    };
    const res = await post(mount(authStore, store), '/funding/trial', 'founder', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(503);
  });

  it('returns 409 when the CAS trial misses after the status check', async () => {
    const { authStore } = await staffed();
    const pending = grant({ accountId: VERIFIED, status: 'pending' });
    const store: FundingStore = {
      getByAccountId: () => Promise.resolve(pending),
      listGrants: () => Promise.resolve([pending]),
      upsert: () => Promise.resolve(pending),
      transition: () => Promise.resolve(undefined),
      expireTrialIfUnchanged: () => Promise.resolve(undefined),
    };
    expect(
      (await post(mount(authStore, store), '/funding/trial', 'founder', { accountId: VERIFIED }))
        .status,
    ).toBe(409);
  });

  it('returns 503 when loading the subject throws', async () => {
    const inner = new InMemoryAuthStore();
    await inner.createAccount(account({ id: FOUNDER, role: 'founder', name: 'Founder' }));
    await inner.createSession({ token: 'founder', accountId: FOUNDER, createdAt: now() });
    const authStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getAccount') {
          return async (id: string) => {
            if (id === VERIFIED) {
              throw new Error('boom');
            }
            return target.getAccount(id);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    }) as InMemoryAuthStore;
    const res = await post(
      mount(authStore, new InMemoryFundingStore()),
      '/funding/trial',
      'founder',
      {
        accountId: VERIFIED,
      },
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /funding/admit', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/admit', undefined, {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(401);
  });

  it('returns 409 when admitting self, basis, or a non-pending grant', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: FOUNDER, status: 'pending' }));
    await fundingStore.upsert(grant({ accountId: OTHER, status: 'pending' }));
    const app = mount(authStore, fundingStore);
    expect((await post(app, '/funding/admit', 'founder', { accountId: FOUNDER })).status).toBe(409);
    expect((await post(app, '/funding/admit', 'founder', { accountId: OTHER })).status).toBe(409);
    expect((await post(app, '/funding/admit', 'founder', { accountId: VERIFIED })).status).toBe(
      409,
    );
  });

  it('returns 409 when the CAS transition misses after the status check', async () => {
    const { authStore } = await staffed();
    const pending = grant({ accountId: VERIFIED, status: 'pending' });
    const store: FundingStore = {
      getByAccountId: () => Promise.resolve(pending),
      listGrants: () => Promise.resolve([pending]),
      upsert: () => Promise.resolve(pending),
      transition: () => Promise.resolve(undefined),
      expireTrialIfUnchanged: () => Promise.resolve(undefined),
    };
    const app = mount(authStore, store);
    expect((await post(app, '/funding/admit', 'founder', { accountId: VERIFIED })).status).toBe(
      409,
    );
  });

  it('admits from pending and from trial the same day', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending', appliedAt: 4 }));
    const app = mount(authStore, fundingStore);
    const pending = await post(app, '/funding/admit', 'founder', { accountId: VERIFIED });
    expect(pending.status).toBe(200);
    const admitted = (await pending.json()) as {
      funding: {
        status: string;
        admittedAt: number;
        trialUtcDate: string | null;
        reviewedByName: string | null;
      };
    };
    expect(admitted.funding.status).toBe('admitted');
    expect(admitted.funding.admittedAt).toBe(now());
    expect(admitted.funding.trialUtcDate).toBeNull();
    expect(admitted.funding.reviewedByName).toBe('Founder');
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.admitted')).toBe(true);

    await fundingStore.upsert(
      grant({
        accountId: MOD,
        status: 'trial',
        trialUtcDate: TODAY,
        appliedAt: 5,
      }),
    );
    const fromTrial = await post(app, '/funding/admit', 'founder', { accountId: MOD });
    expect(fromTrial.status).toBe(200);
    expect(((await fromTrial.json()) as { funding: { status: string } }).funding.status).toBe(
      'admitted',
    );
  });

  it('returns 400 for missing JSON and 404 for a missing subject', async () => {
    const { authStore, fundingStore } = await staffed();
    const app = mount(authStore, fundingStore);
    expect(
      (
        await app.request('/funding/admit', {
          method: 'POST',
          headers: { authorization: 'Bearer founder' },
        })
      ).status,
    ).toBe(400);
    expect((await post(app, '/funding/admit', 'founder', { accountId: SUBJECT })).status).toBe(404);
  });

  it('returns 503 when upsert throws', async () => {
    const { authStore } = await staffed();
    const store: FundingStore = {
      getByAccountId: async () => grant({ accountId: VERIFIED, status: 'pending' }),
      listGrants: async () => [],
      upsert: async () => {
        throw new Error('boom');
      },
      transition: async () => {
        throw new Error('boom');
      },
      expireTrialIfUnchanged: async () => {
        throw new Error('boom');
      },
    };
    const res = await post(mount(authStore, store), '/funding/admit', 'mod', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /funding/reject', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 403 when the caller is not staff', async () => {
    const { authStore, fundingStore } = await staffed();
    const res = await post(mount(authStore, fundingStore), '/funding/reject', 'verified', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(403);
  });

  it('returns 409 when rejecting self or an admitted grant', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: FOUNDER, status: 'pending' }));
    await fundingStore.upsert(
      grant({ accountId: VERIFIED, status: 'admitted', admittedAt: now() }),
    );
    const app = mount(authStore, fundingStore);
    expect((await post(app, '/funding/reject', 'founder', { accountId: FOUNDER })).status).toBe(
      409,
    );
    expect((await post(app, '/funding/reject', 'founder', { accountId: VERIFIED })).status).toBe(
      409,
    );
  });

  it('rejects pending and trial and clears trial and admitted', async () => {
    const { authStore, fundingStore } = await staffed();
    await fundingStore.upsert(grant({ accountId: VERIFIED, status: 'pending', appliedAt: 8 }));
    const app = mount(authStore, fundingStore);
    const res = await post(app, '/funding/reject', 'mod', { accountId: VERIFIED });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      funding: { status: string; trialUtcDate: string | null; admittedAt: number | null };
    };
    expect(body.funding.status).toBe('rejected');
    expect(body.funding.trialUtcDate).toBeNull();
    expect(body.funding.admittedAt).toBeNull();
    expect(parsedEvents(warn).some((e) => e['event'] === 'funding.rejected')).toBe(true);

    await fundingStore.upsert(
      grant({
        accountId: MOD,
        status: 'trial',
        trialUtcDate: TODAY,
        appliedAt: 7,
      }),
    );
    expect((await post(app, '/funding/reject', 'founder', { accountId: MOD })).status).toBe(200);
  });

  it('returns 400 for missing JSON and 404 for a missing subject', async () => {
    const { authStore, fundingStore } = await staffed();
    const app = mount(authStore, fundingStore);
    expect(
      (
        await app.request('/funding/reject', {
          method: 'POST',
          headers: { authorization: 'Bearer founder', 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);
    expect((await post(app, '/funding/reject', 'founder', { accountId: SUBJECT })).status).toBe(
      404,
    );
  });

  it('returns 503 when upsert throws', async () => {
    const { authStore } = await staffed();
    const store: FundingStore = {
      getByAccountId: async () => grant({ accountId: VERIFIED, status: 'pending' }),
      listGrants: async () => [],
      upsert: async () => {
        throw new Error('boom');
      },
      transition: async () => {
        throw new Error('boom');
      },
      expireTrialIfUnchanged: async () => {
        throw new Error('boom');
      },
    };
    const res = await post(mount(authStore, store), '/funding/reject', 'founder', {
      accountId: VERIFIED,
    });
    expect(res.status).toBe(503);
  });

  it('returns 409 when the CAS reject misses after the status check', async () => {
    const { authStore } = await staffed();
    const pending = grant({ accountId: VERIFIED, status: 'pending' });
    const store: FundingStore = {
      getByAccountId: () => Promise.resolve(pending),
      listGrants: () => Promise.resolve([pending]),
      upsert: () => Promise.resolve(pending),
      transition: () => Promise.resolve(undefined),
      expireTrialIfUnchanged: () => Promise.resolve(undefined),
    };
    expect(
      (await post(mount(authStore, store), '/funding/reject', 'founder', { accountId: VERIFIED }))
        .status,
    ).toBe(409);
  });
});
