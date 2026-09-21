import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryNotificationStore, type NotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore, type PushStore } from '@/lib/push-store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { trustRoutes } from '@/routes/trust';

const now = (): number => 1_700_000_000_000;
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const MOD = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

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

async function staffed(
  extras: Account[] = [],
): Promise<{ authStore: InMemoryAuthStore; trustStore: InMemoryTrustStore }> {
  const authStore = new InMemoryAuthStore();
  await authStore.createAccount(account({ id: FOUNDER, role: 'founder', name: 'Founder' }));
  await authStore.createAccount(account({ id: MOD, role: 'moderator', name: 'Mod' }));
  await authStore.createAccount(account({ id: OTHER, role: 'basis', name: 'Other' }));
  await authStore.createSession({ token: 'founder', accountId: FOUNDER, createdAt: now() });
  await authStore.createSession({ token: 'mod', accountId: MOD, createdAt: now() });
  await authStore.createSession({ token: 'other', accountId: OTHER, createdAt: now() });
  for (const extra of extras) {
    await authStore.createAccount(extra);
  }
  return { authStore, trustStore: new InMemoryTrustStore() };
}

function mount(
  authStore: InMemoryAuthStore,
  trustStore: TrustStore,
  extras: {
    notificationStore?: NotificationStore;
    pushStore?: PushStore;
    now?: () => number;
  } = {},
): Hono {
  return new Hono().route(
    '/trust',
    trustRoutes({
      authStore,
      trustStore,
      now: extras.now ?? now,
      ...(extras.notificationStore === undefined
        ? {}
        : { notificationStore: extras.notificationStore }),
      ...(extras.pushStore === undefined ? {} : { pushStore: extras.pushStore }),
    }),
  );
}

async function subscribePush(pushStore: InMemoryPushStore, accountId: string): Promise<void> {
  await pushStore.upsertSubscription({
    endpoint: `https://push.example/${accountId}`,
    accountId,
    p256dh: 'p',
    auth: 'a',
    createdAt: new Date(now()),
  });
}

async function subscribeSubjectActorAndOther(pushStore: InMemoryPushStore): Promise<void> {
  await subscribePush(pushStore, SUBJECT);
  await subscribePush(pushStore, FOUNDER);
  await subscribePush(pushStore, MOD);
  await subscribePush(pushStore, OTHER);
}

function post(
  app: Hono,
  path: string,
  token: string | undefined,
  body: unknown,
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

const throwingList: TrustStore = {
  listEdges: async () => [],
  listEdgesTouching: async () => [],
  listEdgesForSubject: async () => {
    throw new Error('list boom');
  },
  insertEdge: async (row) => row,
  deleteEdge: async () => undefined,
  deleteEdgeById: async () => undefined,
};

const throwingListEdges: TrustStore = {
  listEdges: async () => {
    throw new Error('list boom');
  },
  listEdgesTouching: async () => [],
  listEdgesForSubject: async () => [],
  insertEdge: async (row) => row,
  deleteEdge: async () => undefined,
  deleteEdgeById: async () => undefined,
};

const duplicateInsert: TrustStore = {
  listEdges: async () => [],
  listEdgesForSubject: async () => [],
  listEdgesTouching: async () => [],
  insertEdge: async () => {
    throw new Error('duplicate trust edge');
  },
  deleteEdge: async () => undefined,
  deleteEdgeById: async () => undefined,
};

const boomInsert: TrustStore = {
  listEdges: async () => [],
  listEdgesForSubject: async () => [],
  listEdgesTouching: async () => [],
  insertEdge: async () => {
    throw new Error('insert boom');
  },
  deleteEdge: async () => undefined,
  deleteEdgeById: async () => undefined,
};

describe('POST /trust/*', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('POST /trust/verify', () => {
    it('returns 401 without a session', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/verify', undefined, {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 403 when the caller is not staff', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'other', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for missing JSON', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await mount(authStore, trustStore).request('/trust/verify', {
        method: 'POST',
        headers: { authorization: 'Bearer founder' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with an "accountId" string',
      });
    });

    it('returns 404 for a non-uuid accountId', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: 'not-a-uuid',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });

    it('returns 404 when the subject is missing', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 when the subject is the caller', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: FOUNDER,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Conflict' });
    });

    it('returns 409 when the subject role is not basis', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a verify edge already exists', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'e1',
        subjectId: SUBJECT,
        actorId: OTHER,
        kind: 'verify',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('returns 200 idempotently when the caller already verified the subject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'e1',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'verify',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await trustStore.listEdges()).map((row) => row.id)).toEqual(['e1']);
    });

    it('completes the role write when the caller already stored a verify edge', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'e1',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'verify',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).map((row) => row.id)).toEqual(['e1']);
    });

    it('verifies a basis subject, inserts an edge, and logs', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      const edges = await trustStore.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'verify',
        createdAt: now(),
      });
      expect(
        parsedEvents(warn).some(
          (event) =>
            event['event'] === 'trust.verified' &&
            event['subjectId'] === SUBJECT &&
            event['actorId'] === MOD,
        ),
      ).toBe(true);
    });

    it('returns 503 when listing edges throws', async () => {
      const { authStore } = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const res = await post(mount(authStore, throwingList), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    });

    it('returns 503 when getAccount throws', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const inner = authStore.getAccount.bind(authStore);
      vi.spyOn(authStore, 'getAccount').mockImplementation(async (id) => {
        if (id === SUBJECT) {
          throw new Error('get boom');
        }
        return inner(id);
      });
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    });

    it('returns 409 when insert reports a duplicate edge', async () => {
      const { authStore } = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const res = await post(mount(authStore, duplicateInsert), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('returns 503 when insert throws any other error', async () => {
      const { authStore } = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const res = await post(mount(authStore, boomInsert), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('returns 503 when updateAccount throws after insert and retries the role write', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const first = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
      expect(
        (await trustStore.listEdges()).some((row) => row.kind === 'verify' && row.actorId === MOD),
      ).toBe(true);
      const retry = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect(await trustStore.listEdges()).toHaveLength(1);
      spy.mockRestore();
    });

    it('returns 409 when the caller owns a verify edge but the subject is not basis', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'verify',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'verify',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
    });

    it('returns 503 when updateAccount throws on a caller-owned verify retry', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'verify',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'verify',
        createdAt: 1,
      });
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const res = await post(mount(authStore, trustStore), '/trust/verify', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
      spy.mockRestore();
    });

    it('does not create a moderator_appointed notification on verify 200', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/verify',
        'mod',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect(await notifications.listByRecipient(SUBJECT, 10)).toEqual([]);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      expect(await pushStore.claimPending(10, now(), 60_000)).toEqual([]);
    });
  });

  describe('POST /trust/propose-moderator', () => {
    it('returns 401 without a session', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', undefined, {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when the caller is not staff', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'other', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid JSON', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
        accountId: 1,
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-uuid and missing subject', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
            accountId: 'bad',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(404);
    });

    it('returns 409 when proposing self or a non-verified subject', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/propose-moderator', 'mod', {
            accountId: MOD,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
            accountId: OTHER,
          })
        ).status,
      ).toBe(409);
    });

    it.each(['moderator_propose', 'moderator_confirm', 'moderator_appoint'] as const)(
      'returns 409 when a %s edge already exists',
      async (kind) => {
        const { authStore, trustStore } = await staffed([
          account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
        ]);
        await trustStore.insertEdge({
          id: 'e1',
          subjectId: SUBJECT,
          actorId: FOUNDER,
          kind,
          createdAt: 1,
        });
        const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'mod', {
          accountId: SUBJECT,
        });
        expect(res.status).toBe(409);
      },
    );

    it('inserts moderator_propose without changing role and logs', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges())[0]?.kind).toBe('moderator_propose');
      expect(
        parsedEvents(warn).some((event) => event['event'] === 'trust.moderator_proposed'),
      ).toBe(true);
    });

    it('returns 409 when a concurrent older propose already exists after insert', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            {
              id: 'other-p',
              subjectId: OTHER,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 1,
            },
            {
              id: 'r-new',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 2,
            },
            {
              id: 'r-old',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 2,
            },
            {
              id: 'a-propose',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 2,
            },
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 2_000_000_000_000,
            },
            {
              id: '88888888-8888-4888-8888-888888888888',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 1_700_000_000_000,
            },
            {
              id: '00000000-0000-4000-8000-000000000001',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 1_700_000_000_000,
            },
            {
              id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 1_700_000_000_000,
            },
            ...rows,
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a same-timestamp older propose wins on id', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            {
              id: 'r-new',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 2,
            },
            {
              id: 'z-propose',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 2,
            },
            ...rows,
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 503 when listing after propose insert throws', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          if (lists >= 2) {
            throw new Error('list boom');
          }
          return trustStore.listEdgesForSubject(id);
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_propose')).toBe(
        false,
      );
    });

    it('keeps the oldest concurrent propose and drops a newer extra', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: (id) => trustStore.listEdgesForSubject(id),
        insertEdge: async (row) => {
          const stored = await trustStore.insertEdge(row);
          await trustStore.insertEdge({
            id: 'newer',
            subjectId: SUBJECT,
            actorId: MOD,
            kind: 'moderator_propose',
            createdAt: 9_000_000_000_000,
          });
          return stored;
        },
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect((await trustStore.listEdges()).map((row) => row.id)).not.toContain('newer');
    });

    it('returns 409 when a concurrent confirm closed the grant after insert', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'confirm-race',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_confirm',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_propose')).toBe(
        false,
      );
    });

    it('returns 409 when the post-insert list has no remaining open propose', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          if (lists < 2) {
            return trustStore.listEdgesForSubject(id);
          }
          return [
            {
              id: 'r-only',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a concurrent older propose remains after extras are dropped', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            {
              id: 'older',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 1,
            },
            ...rows,
            {
              id: 'newer-extra',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: async (row) => {
          const stored = await trustStore.insertEdge(row);
          await trustStore.insertEdge({
            id: 'newer-extra',
            subjectId: SUBJECT,
            actorId: MOD,
            kind: 'moderator_propose',
            createdAt: 9_000_000_000_000,
          });
          return stored;
        },
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('fans out moderator_proposal to other staff on propose 200', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      const listed = await notifications.listByRecipient(MOD, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.type).toBe('moderator_proposal');
      expect(listed[0]?.parentId).toBe(SUBJECT);
      expect(listed[0]?.replyId).toBe(SUBJECT);
      expect(listed[0]?.actorAccountId).toBe(FOUNDER);
      expect(listed[0]?.name).toBe('Founder');
      expect(listed[0]?.text).toBe('Sub');
      expect(listed[0]?.readAt).toBeNull();
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(SUBJECT, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      const claimed = await pushStore.claimPending(10, now(), 60_000);
      expect(claimed.map((row) => row.accountId)).toEqual([MOD]);
      expect((JSON.parse(claimed[0]?.payload ?? '{}') as { url: string }).url).toBe(
        '/moderate/proposals',
      );
    });

    it('clears proposal notifications when a concurrent reject lands during notify', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'reject-during-notify',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_reject',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
    });

    it('refreshes proposal notifications when a newer propose reopened during notify', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'reject-during-notify',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 9_000_000_000_000,
            },
            {
              id: 'p-reopen',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_001,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      const listed = await notifications.listByRecipient(FOUNDER, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.actorAccountId).toBe(MOD);
      expect(listed[0]?.name).toBe('Mod');
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
    });

    it('refreshes proposal notifications when the newer proposer account is missing', async () => {
      const missing = '99999999-9999-4999-8999-999999999999';
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'reject-during-notify',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 9_000_000_000_000,
            },
            {
              id: 'p-reopen-missing',
              subjectId: SUBJECT,
              actorId: missing,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_001,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      const listed = await notifications.listByRecipient(MOD, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.actorAccountId).toBe(missing);
      expect(listed[0]?.name).toBe('Someone');
    });

    it('does not fan out when pending empties before the refresh notify', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          const closed = [
            ...rows,
            {
              id: 'reject-during-notify',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject' as const,
              createdAt: 9_000_000_000_000,
            },
          ];
          if (lists === 3) {
            return [
              ...closed,
              {
                id: 'p-reopen',
                subjectId: SUBJECT,
                actorId: MOD,
                kind: 'moderator_propose' as const,
                createdAt: 9_000_000_000_001,
              },
            ];
          }
          return closed;
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
    });

    it('drops refresh rows when pending empties after the refresh notify', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          const closed = [
            ...rows,
            {
              id: 'reject-during-notify',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject' as const,
              createdAt: 9_000_000_000_000,
            },
          ];
          if (lists < 5) {
            return [
              ...closed,
              {
                id: 'p-reopen',
                subjectId: SUBJECT,
                actorId: MOD,
                kind: 'moderator_propose' as const,
                createdAt: 9_000_000_000_001,
              },
            ];
          }
          return closed;
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/propose-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
    });

    it('still 200 when reconciling proposal notifications throws', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          if (lists >= 3) {
            throw new Error('list boom');
          }
          return trustStore.listEdgesForSubject(id);
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(parsedEvents(warn).some((event) => event['event'] === 'push.enqueue.failed')).toBe(
        true,
      );
    });

    it('still 200 when staff proposal notify throws', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      authStore.listAccounts = async () => {
        throw new Error('boom');
      };
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(parsedEvents(warn).some((event) => event['event'] === 'push.enqueue.failed')).toBe(
        true,
      );
    });

    it('returns 503 when listing throws and 409/503 on insert failure', async () => {
      const extras = [account({ id: SUBJECT, role: 'verified', name: 'Sub' })];
      const listed = await staffed(extras);
      expect(
        (
          await post(mount(listed.authStore, throwingList), '/trust/propose-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
      const dup = await staffed(extras);
      expect(
        (
          await post(mount(dup.authStore, duplicateInsert), '/trust/propose-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(409);
      const boom = await staffed(extras);
      expect(
        (
          await post(mount(boom.authStore, boomInsert), '/trust/propose-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
    });
  });

  describe('POST /trust/confirm-moderator', () => {
    async function pending(): Promise<{
      authStore: InMemoryAuthStore;
      trustStore: InMemoryTrustStore;
    }> {
      const seeded = await staffed([account({ id: SUBJECT, role: 'verified', name: 'Sub' })]);
      await seeded.trustStore.insertEdge({
        id: 'propose',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_propose',
        createdAt: 1,
      });
      return seeded;
    }

    it('returns 401, 403, 400, and 404 like the other staff POSTs', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/confirm-moderator', undefined, {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'other', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'founder', {
            nope: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'founder', {
            accountId: 'bad',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(404);
    });

    it('returns 409 when confirming self, when not verified, when no propose exists, or when the caller proposed', async () => {
      const self = await pending();
      expect(
        (
          await post(
            mount(self.authStore, self.trustStore),
            '/trust/confirm-moderator',
            'founder',
            {
              accountId: FOUNDER,
            },
          )
        ).status,
      ).toBe(409);
      const notVerified = await staffed();
      expect(
        (
          await post(
            mount(notVerified.authStore, notVerified.trustStore),
            '/trust/confirm-moderator',
            'mod',
            { accountId: OTHER },
          )
        ).status,
      ).toBe(409);
      const noPropose = await staffed([account({ id: SUBJECT, role: 'verified', name: 'Sub' })]);
      expect(
        (
          await post(
            mount(noPropose.authStore, noPropose.trustStore),
            '/trust/confirm-moderator',
            'mod',
            { accountId: SUBJECT },
          )
        ).status,
      ).toBe(409);
      const same = await pending();
      expect(
        (
          await post(
            mount(same.authStore, same.trustStore),
            '/trust/confirm-moderator',
            'founder',
            {
              accountId: SUBJECT,
            },
          )
        ).status,
      ).toBe(409);
    });

    it('promotes the subject when a different staff member confirms', async () => {
      const { authStore, trustStore } = await pending();
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        true,
      );
      expect(
        parsedEvents(warn).some((event) => event['event'] === 'trust.moderator_confirmed'),
      ).toBe(true);
    });

    it('returns 503 when listing throws and 409/503 on insert failure', async () => {
      const extras = [account({ id: SUBJECT, role: 'verified', name: 'Sub' })];
      const listed = await staffed(extras);
      expect(
        (
          await post(mount(listed.authStore, throwingList), '/trust/confirm-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
      const withPropose: TrustEdge[] = [
        {
          id: 'propose',
          subjectId: SUBJECT,
          actorId: FOUNDER,
          kind: 'moderator_propose',
          createdAt: 1,
        },
      ];
      const dupStore: TrustStore = {
        listEdges: async () => withPropose,
        listEdgesForSubject: async () => withPropose,
        listEdgesTouching: async () => withPropose,
        insertEdge: async () => {
          throw new Error('duplicate trust edge');
        },
        deleteEdge: async () => undefined,
        deleteEdgeById: async () => undefined,
      };
      const dup = await staffed(extras);
      expect(
        (
          await post(mount(dup.authStore, dupStore), '/trust/confirm-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(409);
      expect((await dup.authStore.getAccount(SUBJECT))?.role).toBe('verified');
      const boomStore: TrustStore = {
        listEdges: async () => withPropose,
        listEdgesForSubject: async () => withPropose,
        listEdgesTouching: async () => withPropose,
        insertEdge: async () => {
          throw new Error('insert boom');
        },
        deleteEdge: async () => undefined,
        deleteEdgeById: async () => undefined,
      };
      const boom = await staffed(extras);
      expect(
        (
          await post(mount(boom.authStore, boomStore), '/trust/confirm-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
      expect((await boom.authStore.getAccount(SUBJECT))?.role).toBe('verified');
    });

    it('returns 409 and drops the confirm when a newer propose replaced the pending one', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'r1',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_reject',
              createdAt: 2,
            },
            {
              id: 'p2',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        false,
      );
    });

    it('returns 409 when a newer extra propose replaced the pending row', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'propose-z',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 2,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        false,
      );
    });

    it('returns 409 when a same-actor same-timestamp re-propose replaced the pending row', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'propose0',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_reject',
              createdAt: 1,
            },
            {
              id: 'propose1',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_propose',
              createdAt: 1,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        false,
      );
    });

    it('returns 409 and drops the confirm when a concurrent reject closed the proposal', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'reject-race',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_reject',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        false,
      );
    });

    it('returns 503 when listing after confirm insert throws', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          if (lists >= 2) {
            throw new Error('list boom');
          }
          return trustStore.listEdgesForSubject(id);
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_confirm')).toBe(
        false,
      );
    });

    it('completes the role write when the caller already stored a confirm edge', async () => {
      const { authStore, trustStore } = await pending();
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_confirm',
        createdAt: 2,
      });
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(
        (await trustStore.listEdges()).filter((row) => row.kind === 'moderator_confirm'),
      ).toHaveLength(1);
    });

    it('returns 409 when the caller owns a confirm edge but the subject is not verified', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_confirm',
        createdAt: 2,
      });
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('returns 503 when updateAccount throws on a caller-owned confirm retry', async () => {
      const { authStore, trustStore } = await pending();
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_confirm',
        createdAt: 2,
      });
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const first = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      const retry = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(retry.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      spy.mockRestore();
    });

    it('returns 409 when a confirm edge from a different actor already exists', async () => {
      const { authStore, trustStore } = await pending();
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_confirm',
        createdAt: 2,
      });
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
    });

    it('returns 200 idempotently when the caller already confirmed the subject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_confirm',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect((await trustStore.listEdges()).map((row) => row.id)).toEqual(['confirm']);
    });

    it('returns 503 when updateAccount throws after insert and retries the role write', async () => {
      const { authStore, trustStore } = await pending();
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const first = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      expect(
        (await trustStore.listEdges()).some(
          (row) => row.kind === 'moderator_confirm' && row.actorId === MOD,
        ),
      ).toBe(true);
      const retry = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(
        (await trustStore.listEdges()).filter((row) => row.kind === 'moderator_confirm'),
      ).toHaveLength(1);
      spy.mockRestore();
    });

    it('notifies only the subject on a successful confirm', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/confirm-moderator',
        'mod',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      const listed = await notifications.listByRecipient(SUBJECT, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.type).toBe('moderator_appointed');
      expect(listed[0]?.actorAccountId).toBe(MOD);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      const claimed = await pushStore.claimPending(10, now(), 60_000);
      expect(claimed.map((row) => row.accountId)).toEqual([SUBJECT]);
    });

    it('notifies the subject on an idempotent already-moderator confirm 200', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'confirm',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_confirm',
        createdAt: 1,
      });
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/confirm-moderator',
        'mod',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(await notifications.listByRecipient(SUBJECT, 10)).toHaveLength(1);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      expect((await pushStore.claimPending(10, now(), 60_000)).map((row) => row.accountId)).toEqual(
        [SUBJECT],
      );
    });

    it('still returns 200 when notification create throws', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      notifications.create = async () => {
        throw new Error('create boom');
      };
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/confirm-moderator',
        'mod',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(parsedEvents(warn).some((event) => event['event'] === 'push.enqueue.failed')).toBe(
        true,
      );
    });
  });

  describe('POST /trust/reject-moderator', () => {
    async function pending(): Promise<{
      authStore: InMemoryAuthStore;
      trustStore: InMemoryTrustStore;
    }> {
      const seeded = await staffed([account({ id: SUBJECT, role: 'verified', name: 'Sub' })]);
      await seeded.trustStore.insertEdge({
        id: 'propose',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_propose',
        createdAt: 1,
      });
      return seeded;
    }

    it('returns 400 and 404 for a bad or missing accountId', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
            accountId: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
            accountId: 'bad',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(404);
    });

    it('returns 401 without a session', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', undefined, {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when the caller is not staff', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'other', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(403);
    });

    it('returns 409 when the subject is not verified', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
        accountId: MOD,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 when the subject is not pending', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 when rejecting self', async () => {
      const { authStore, trustStore } = await staffed();
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
        accountId: FOUNDER,
      });
      expect(res.status).toBe(409);
    });

    it('lets the proposer reject, keeps the propose edge, and logs', async () => {
      const { authStore, trustStore } = await pending();
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'verified' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('verified');
      const edges = await trustStore.listEdges();
      expect(edges.some((row) => row.kind === 'moderator_propose')).toBe(true);
      expect(edges.some((row) => row.kind === 'moderator_reject')).toBe(true);
      expect(
        parsedEvents(warn).some((event) => event['event'] === 'trust.moderator_rejected'),
      ).toBe(true);
    });

    it('allows a second propose after reject', async () => {
      const { authStore, trustStore } = await pending();
      let t = now();
      const tick = (): number => {
        t += 1;
        return t;
      };
      const app = mount(authStore, trustStore, { now: tick });
      const rejected = await post(app, '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(rejected.status).toBe(200);
      const res = await post(app, '/trust/propose-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(
        (await trustStore.listEdges()).filter((row) => row.kind === 'moderator_propose'),
      ).toHaveLength(2);
    });

    it('returns 409 when proposing while a proposal is still pending', async () => {
      const { authStore, trustStore } = await pending();
      const res = await post(mount(authStore, trustStore), '/trust/propose-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('confirms using the latest propose actor after a reject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'propose-1',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_propose',
        createdAt: 1,
      });
      await trustStore.insertEdge({
        id: 'reject-1',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_reject',
        createdAt: 2,
      });
      await trustStore.insertEdge({
        id: 'propose-2',
        subjectId: SUBJECT,
        actorId: MOD,
        kind: 'moderator_propose',
        createdAt: 3,
      });
      const res = await post(mount(authStore, trustStore), '/trust/confirm-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
    });

    it('deletes moderator_proposal rows on reject', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore([
        {
          id: '55555555-5555-4555-8555-555555555555',
          recipientAccountId: MOD,
          actorAccountId: FOUNDER,
          type: 'moderator_proposal',
          parentId: SUBJECT,
          replyId: SUBJECT,
          name: 'Founder',
          text: 'Sub',
          createdAt: new Date(now()),
          readAt: null,
        },
      ]);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
    });

    it('deletes moderator_proposal rows on confirm and notifies the subject', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore([
        {
          id: '55555555-5555-4555-8555-555555555555',
          recipientAccountId: MOD,
          actorAccountId: FOUNDER,
          type: 'moderator_proposal',
          parentId: SUBJECT,
          replyId: SUBJECT,
          name: 'Founder',
          text: 'Sub',
          createdAt: new Date(now()),
          readAt: null,
        },
      ]);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications }),
        '/trust/confirm-moderator',
        'mod',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      const appointed = await notifications.listByRecipient(SUBJECT, 10);
      expect(appointed).toHaveLength(1);
      expect(appointed[0]?.type).toBe('moderator_appointed');
    });

    it('returns 503 when listing throws', async () => {
      const { authStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      const res = await post(mount(authStore, throwingList), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect(parsedEvents(warn).some((event) => event['event'] === 'trust.write.failed')).toBe(
        true,
      );
    });

    it('returns 503 when reject insert throws', async () => {
      const { authStore } = await pending();
      const withPropose: TrustEdge[] = [
        {
          id: 'propose',
          subjectId: SUBJECT,
          actorId: FOUNDER,
          kind: 'moderator_propose',
          createdAt: 1,
        },
      ];
      const store: TrustStore = {
        ...boomInsert,
        listEdgesForSubject: async () => withPropose,
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect(parsedEvents(warn).some((event) => event['event'] === 'trust.write.failed')).toBe(
        true,
      );
    });

    it('returns 409 when reject insert reports a duplicate', async () => {
      const { authStore } = await pending();
      const withPropose: TrustEdge[] = [
        {
          id: 'propose',
          subjectId: SUBJECT,
          actorId: FOUNDER,
          kind: 'moderator_propose',
          createdAt: 1,
        },
      ];
      const store: TrustStore = {
        ...duplicateInsert,
        listEdgesForSubject: async () => withPropose,
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 409 and drops the reject when a concurrent confirm already closed the grant', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'confirm-race',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_confirm',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        false,
      );
    });

    it('returns 409 and drops the reject when a concurrent appoint already closed the grant', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'appoint-race',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_appoint',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        false,
      );
    });

    it('returns 503 when listing after reject insert throws', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          if (lists >= 2) {
            throw new Error('list boom');
          }
          return trustStore.listEdgesForSubject(id);
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        false,
      );
    });

    it('fans out again when a re-propose lands after reject clear', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 4) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'p-after-clear',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      const listed = await notifications.listByRecipient(FOUNDER, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.actorAccountId).toBe(MOD);
      expect(listed[0]?.name).toBe('Mod');
    });

    it('fans out after reject clear when the newer proposer account is missing', async () => {
      const missing = '99999999-9999-4999-8999-999999999999';
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 4) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'p-after-clear-missing',
              subjectId: SUBJECT,
              actorId: missing,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      const listed = await notifications.listByRecipient(FOUNDER, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.actorAccountId).toBe(missing);
      expect(listed[0]?.name).toBe('Someone');
    });

    it('does not drop proposal rows when a re-propose lands before reject clear', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore([
        {
          id: '55555555-5555-4555-8555-555555555555',
          recipientAccountId: MOD,
          actorAccountId: FOUNDER,
          type: 'moderator_proposal',
          parentId: SUBJECT,
          replyId: SUBJECT,
          name: 'Founder',
          text: 'Sub',
          createdAt: new Date(now()),
          readAt: null,
        },
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 3) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'p-reopen',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(MOD, 10)).toHaveLength(1);
    });

    it('returns 200 without dropping proposal rows when a newer propose reopened', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore([
        {
          id: '55555555-5555-4555-8555-555555555555',
          recipientAccountId: MOD,
          actorAccountId: FOUNDER,
          type: 'moderator_proposal',
          parentId: SUBJECT,
          replyId: SUBJECT,
          name: 'Founder',
          text: 'Sub',
          createdAt: new Date(now()),
          readAt: null,
        },
      ]);
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'p2',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: 9_000_000_000_000,
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(
        mount(authStore, store, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await notifications.listByRecipient(MOD, 10)).toHaveLength(1);
    });

    it('returns 200 when a same-actor same-timestamp re-propose reopened after reject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_propose',
        createdAt: now(),
      });
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              subjectId: SUBJECT,
              actorId: FOUNDER,
              kind: 'moderator_propose',
              createdAt: now(),
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'mod', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        true,
      );
    });

    it('returns 200 when a same-timestamp newer propose reopened after reject', async () => {
      const { authStore, trustStore } = await pending();
      let lists = 0;
      const store: TrustStore = {
        listEdges: () => trustStore.listEdges(),
        listEdgesTouching: (id) => trustStore.listEdgesTouching(id),
        listEdgesForSubject: async (id) => {
          lists += 1;
          const rows = await trustStore.listEdgesForSubject(id);
          if (lists < 2) {
            return rows;
          }
          return [
            ...rows,
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              subjectId: SUBJECT,
              actorId: MOD,
              kind: 'moderator_propose',
              createdAt: now(),
            },
          ];
        },
        insertEdge: (row) => trustStore.insertEdge(row),
        deleteEdge: (subjectId, kind) => trustStore.deleteEdge(subjectId, kind),
        deleteEdgeById: (id) => trustStore.deleteEdgeById(id),
      };
      const res = await post(mount(authStore, store), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        true,
      );
    });

    it('returns 409 when a same-timestamp propose stays latest after reject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'verified', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_propose',
        createdAt: now(),
      });
      const res = await post(mount(authStore, trustStore), '/trust/reject-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await trustStore.listEdges()).some((row) => row.kind === 'moderator_reject')).toBe(
        false,
      );
    });

    it('still 200 when dropping proposal notifications throws', async () => {
      const { authStore, trustStore } = await pending();
      const notifications = new InMemoryNotificationStore();
      notifications.deleteByTypeAndReplyId = async () => {
        throw new Error('boom');
      };
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications }),
        '/trust/reject-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(
        parsedEvents(warn).some((event) => event['event'] === 'notifications.hidden.purge_failed'),
      ).toBe(true);
    });
  });

  describe('POST /trust/appoint-moderator', () => {
    it('returns 401 without a session and 403 when the caller is not a founder', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', undefined, {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'other', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(403);
    });

    it('returns 400, 404, and 409 for bad body, missing subject, self, founder, and moderator', async () => {
      const { authStore, trustStore } = await staffed();
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
            accountId: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
            accountId: 'bad',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
            accountId: FOUNDER,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
            accountId: MOD,
          })
        ).status,
      ).toBe(409);
    });

    it('appoints a basis subject and a verified subject', async () => {
      const basis = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const basisRes = await post(
        mount(basis.authStore, basis.trustStore),
        '/trust/appoint-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(basisRes.status).toBe(200);
      expect(await basisRes.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await basis.authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect((await basis.trustStore.listEdges())[0]?.kind).toBe('moderator_appoint');
      expect(
        parsedEvents(warn).some((event) => event['event'] === 'trust.moderator_appointed'),
      ).toBe(true);

      const verifiedId = '55555555-5555-4555-8555-555555555555';
      const verified = await staffed([account({ id: verifiedId, role: 'verified', name: 'Ver' })]);
      const verifiedRes = await post(
        mount(verified.authStore, verified.trustStore),
        '/trust/appoint-moderator',
        'founder',
        { accountId: verifiedId },
      );
      expect(verifiedRes.status).toBe(200);
      expect(await verifiedRes.json()).toEqual({ id: verifiedId, name: 'Ver', role: 'moderator' });
    });

    it('returns 503 when listing throws, 409 when insert is a duplicate, and 503 on other insert errors', async () => {
      const extras = [account({ id: SUBJECT, role: 'basis', name: 'Sub' })];
      const listed = await staffed(extras);
      expect(
        (
          await post(mount(listed.authStore, throwingList), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
      expect((await listed.authStore.getAccount(SUBJECT))?.role).toBe('basis');
      const dup = await staffed(extras);
      expect(
        (
          await post(mount(dup.authStore, duplicateInsert), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(409);
      expect((await dup.authStore.getAccount(SUBJECT))?.role).toBe('basis');
      const boom = await staffed(extras);
      expect(
        (
          await post(mount(boom.authStore, boomInsert), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
      expect((await boom.authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('completes the role write when the caller already stored an appoint edge', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'appoint',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_appoint',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect((await trustStore.listEdges()).map((row) => row.id)).toEqual(['appoint']);
    });

    it('returns 200 idempotently when the caller already appointed the subject', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'appoint',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_appoint',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect((await trustStore.listEdges()).map((row) => row.id)).toEqual(['appoint']);
    });

    it('returns 503 when updateAccount throws on a caller-owned appoint retry', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'appoint',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_appoint',
        createdAt: 1,
      });
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const first = await post(
        mount(authStore, trustStore),
        '/trust/appoint-moderator',
        'founder',
        {
          accountId: SUBJECT,
        },
      );
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
      const retry = await post(
        mount(authStore, trustStore),
        '/trust/appoint-moderator',
        'founder',
        {
          accountId: SUBJECT,
        },
      );
      expect(retry.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      spy.mockRestore();
    });

    it('returns 409 when an appoint edge from a different actor already exists', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'appoint',
        subjectId: SUBJECT,
        actorId: OTHER,
        kind: 'moderator_appoint',
        createdAt: 1,
      });
      const res = await post(mount(authStore, trustStore), '/trust/appoint-moderator', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
    });

    it('returns 503 when updateAccount throws after insert and retries the role write', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const spy = vi
        .spyOn(authStore, 'updateAccount')
        .mockRejectedValueOnce(new Error('role boom'));
      const first = await post(
        mount(authStore, trustStore),
        '/trust/appoint-moderator',
        'founder',
        {
          accountId: SUBJECT,
        },
      );
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: 'Trust chain is unavailable' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('basis');
      expect(
        (await trustStore.listEdges()).some(
          (row) => row.kind === 'moderator_appoint' && row.actorId === FOUNDER,
        ),
      ).toBe(true);
      const retry = await post(
        mount(authStore, trustStore),
        '/trust/appoint-moderator',
        'founder',
        {
          accountId: SUBJECT,
        },
      );
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(await trustStore.listEdges()).toHaveLength(1);
      spy.mockRestore();
    });

    it('notifies only the subject on a successful appoint', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/appoint-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      const listed = await notifications.listByRecipient(SUBJECT, 10);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.type).toBe('moderator_appointed');
      expect(listed[0]?.actorAccountId).toBe(FOUNDER);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      const claimed = await pushStore.claimPending(10, now(), 60_000);
      expect(claimed.map((row) => row.accountId)).toEqual([SUBJECT]);
    });

    it('notifies the subject on an idempotent already-moderator appoint 200', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'moderator', name: 'Sub' }),
      ]);
      await trustStore.insertEdge({
        id: 'appoint',
        subjectId: SUBJECT,
        actorId: FOUNDER,
        kind: 'moderator_appoint',
        createdAt: 1,
      });
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/appoint-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(await notifications.listByRecipient(SUBJECT, 10)).toHaveLength(1);
      expect(await notifications.listByRecipient(FOUNDER, 10)).toEqual([]);
      expect(await notifications.listByRecipient(MOD, 10)).toEqual([]);
      expect(await notifications.listByRecipient(OTHER, 10)).toEqual([]);
      expect((await pushStore.claimPending(10, now(), 60_000)).map((row) => row.accountId)).toEqual(
        [SUBJECT],
      );
    });

    it('still returns 200 when push enqueue throws', async () => {
      const { authStore, trustStore } = await staffed([
        account({ id: SUBJECT, role: 'basis', name: 'Sub' }),
      ]);
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribeSubjectActorAndOther(pushStore);
      pushStore.enqueue = async () => {
        throw new Error('enqueue failed');
      };
      const res = await post(
        mount(authStore, trustStore, { notificationStore: notifications, pushStore }),
        '/trust/appoint-moderator',
        'founder',
        { accountId: SUBJECT },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: SUBJECT, name: 'Sub', role: 'moderator' });
      expect((await authStore.getAccount(SUBJECT))?.role).toBe('moderator');
      expect(parsedEvents(warn).some((event) => event['event'] === 'push.enqueue.failed')).toBe(
        true,
      );
    });
  });
});

describe('GET /trust/proposals', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const { authStore, trustStore } = await staffed();
    const res = await get(mount(authStore, trustStore), '/trust/proposals', undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 when the caller is not staff', async () => {
    const { authStore, trustStore } = await staffed();
    const res = await get(mount(authStore, trustStore), '/trust/proposals', 'other');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 200 with an empty list from moderator upwards', async () => {
    const { authStore, trustStore } = await staffed();
    const app = mount(authStore, trustStore);
    for (const token of ['founder', 'mod'] as const) {
      const res = await get(app, '/trust/proposals', token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ proposals: [] });
    }
    const listed = parsedEvents(warn).filter(
      (event) => event['event'] === 'trust.proposals.listed',
    );
    expect(listed).toHaveLength(2);
    expect(listed.every((event) => event['count'] === 0)).toBe(true);
  });

  it('returns 200 with one pending propose for a founder', async () => {
    const createdAt = Date.parse('2026-09-16T00:00:00.000Z');
    const { authStore, trustStore } = await staffed([
      account({ id: SUBJECT, role: 'verified', name: 'Ada' }),
    ]);
    await trustStore.insertEdge({
      id: 'propose',
      subjectId: SUBJECT,
      actorId: MOD,
      kind: 'moderator_propose',
      createdAt,
    });
    const res = await get(mount(authStore, trustStore), '/trust/proposals', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposals: [
        {
          id: 'propose',
          subject: { id: SUBJECT, name: 'Ada', role: 'verified' },
          proposedBy: { id: MOD, name: 'Mod' },
          createdAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    });
    expect(
      parsedEvents(warn).some(
        (event) => event['event'] === 'trust.proposals.listed' && event['count'] === 1,
      ),
    ).toBe(true);
  });

  it('omits confirmed and appointed subjects', async () => {
    const appointedId = '55555555-5555-4555-8555-555555555555';
    const { authStore, trustStore } = await staffed([
      account({ id: SUBJECT, role: 'verified', name: 'Confirmed' }),
      account({ id: appointedId, role: 'verified', name: 'Appointed' }),
    ]);
    await trustStore.insertEdge({
      id: 'p-confirm',
      subjectId: SUBJECT,
      actorId: MOD,
      kind: 'moderator_propose',
      createdAt: 1,
    });
    await trustStore.insertEdge({
      id: 'confirm',
      subjectId: SUBJECT,
      actorId: FOUNDER,
      kind: 'moderator_confirm',
      createdAt: 2,
    });
    await trustStore.insertEdge({
      id: 'p-appoint',
      subjectId: appointedId,
      actorId: MOD,
      kind: 'moderator_propose',
      createdAt: 1,
    });
    await trustStore.insertEdge({
      id: 'appoint',
      subjectId: appointedId,
      actorId: FOUNDER,
      kind: 'moderator_appoint',
      createdAt: 2,
    });
    const res = await get(mount(authStore, trustStore), '/trust/proposals', 'mod');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposals: [] });
    expect(
      parsedEvents(warn).some(
        (event) => event['event'] === 'trust.proposals.listed' && event['count'] === 0,
      ),
    ).toBe(true);
  });

  it('returns 503 when listEdges throws', async () => {
    const { authStore } = await staffed();
    const res = await get(mount(authStore, throwingListEdges), '/trust/proposals', 'founder');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.proposals.failed')).toBe(
      true,
    );
  });
});
