import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
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
    viewKey: 'a'.repeat(64),
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

function mount(authStore: InMemoryAuthStore, trustStore: TrustStore): Hono {
  return new Hono().route('/trust', trustRoutes({ authStore, trustStore, now }));
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

const throwingList: TrustStore = {
  listEdges: async () => [],
  listEdgesForSubject: async () => {
    throw new Error('list boom');
  },
  insertEdge: async (row) => row,
};

const duplicateInsert: TrustStore = {
  listEdges: async () => [],
  listEdgesForSubject: async () => [],
  insertEdge: async () => {
    throw new Error('duplicate trust edge');
  },
};

const boomInsert: TrustStore = {
  listEdges: async () => [],
  listEdgesForSubject: async () => [],
  insertEdge: async () => {
    throw new Error('insert boom');
  },
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

    it('returns 409 when insert reports a duplicate edge', async () => {
      const { authStore } = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const res = await post(mount(authStore, duplicateInsert), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(409);
    });

    it('returns 503 when insert throws any other error', async () => {
      const { authStore } = await staffed([account({ id: SUBJECT, role: 'basis', name: 'Sub' })]);
      const res = await post(mount(authStore, boomInsert), '/trust/verify', 'founder', {
        accountId: SUBJECT,
      });
      expect(res.status).toBe(503);
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
        insertEdge: async () => {
          throw new Error('duplicate trust edge');
        },
      };
      const dup = await staffed(extras);
      expect(
        (
          await post(mount(dup.authStore, dupStore), '/trust/confirm-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(409);
      const boomStore: TrustStore = {
        listEdges: async () => withPropose,
        listEdgesForSubject: async () => withPropose,
        insertEdge: async () => {
          throw new Error('insert boom');
        },
      };
      const boom = await staffed(extras);
      expect(
        (
          await post(mount(boom.authStore, boomStore), '/trust/confirm-moderator', 'mod', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
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

    it('returns 409 when insert is a duplicate and 503 on other insert errors', async () => {
      const extras = [account({ id: SUBJECT, role: 'basis', name: 'Sub' })];
      const dup = await staffed(extras);
      expect(
        (
          await post(mount(dup.authStore, duplicateInsert), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(409);
      const boom = await staffed(extras);
      expect(
        (
          await post(mount(boom.authStore, boomInsert), '/trust/appoint-moderator', 'founder', {
            accountId: SUBJECT,
          })
        ).status,
      ).toBe(503);
    });
  });
});
