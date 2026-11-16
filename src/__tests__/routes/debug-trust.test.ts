import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { debugTrustRoutes } from '@/routes/debug-trust';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';

const OP_KEYS = await seededOperatorLogin();
const OP_READ = OP_KEYS.tokens.read;
const OP_WRITE = OP_KEYS.tokens.write;
const UNCONFIGURED = new OperatorLogin({
  signers: null,
  store: new InMemoryOperatorLoginStore(),
  now: Date.now,
});

const now = (): number => Date.parse('2026-09-12T12:00:00.000Z');
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: partial.id,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

async function seeded(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount(account({ id: SUBJECT, role: 'basis', name: 'Sub' }));
  await store.createAccount(account({ id: ACTOR, role: 'founder', name: 'Act' }));
  return store;
}

function mount(
  store: InMemoryAuthStore,
  trustStore: TrustStore,
  operatorLogin: OperatorLogin | null = OP_KEYS.operatorLogin,
  clock: (() => number) | undefined = now,
): Hono {
  return new Hono().route(
    '/debug/trust-edges',
    debugTrustRoutes({
      store,
      trustStore,
      ...(operatorLogin === null ? {} : { operatorLogin }),
      ...(clock === undefined ? {} : { now: clock }),
    }),
  );
}

function post(app: Hono, token: string | undefined, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/debug/trust-edges', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function del(app: Hono, token: string | undefined, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/debug/trust-edges', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe('GET /debug/trust-edges', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a matching bearer', async () => {
    const app = mount(new InMemoryAuthStore(), new InMemoryTrustStore());
    const res = await app.request('/debug/trust-edges');
    expect(res.status).toBe(401);
  });

  it('lists edges newest first', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    await trustStore.insertEdge({
      id: 'edge-old',
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
      createdAt: 1,
    });
    const app = mount(store, trustStore);
    const res = await app.request('/debug/trust-edges', {
      headers: { authorization: `Bearer ${OP_READ}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: Array<{ id: string; kind: string }> };
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]?.id).toBe('edge-old');
    expect(body.edges[0]?.kind).toBe('verify');
  });

  it('returns 503 when listEdges throws', async () => {
    const throwing: TrustStore = {
      listEdges: async () => {
        throw new Error('boom');
      },
      listEdgesForSubject: async () => [],
      listEdgesTouching: async () => [],
      insertEdge: async (row) => row,
      deleteEdge: async () => undefined,
      deleteEdgeById: async () => undefined,
    };
    const res = await mount(new InMemoryAuthStore(), throwing).request('/debug/trust-edges', {
      headers: { authorization: `Bearer ${OP_READ}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.failed')).toBe(
      true,
    );
  });
});

describe('POST /debug/trust-edges', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const res = await post(
      mount(new InMemoryAuthStore(), new InMemoryTrustStore(), null),
      OP_WRITE,
      { subjectId: SUBJECT, actorId: ACTOR, kind: 'verify' },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the key login is not configured', async () => {
    const res = await post(
      mount(new InMemoryAuthStore(), new InMemoryTrustStore(), UNCONFIGURED),
      OP_WRITE,
      { subjectId: SUBJECT, actorId: ACTOR, kind: 'verify' },
    );
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const res = await post(mount(new InMemoryAuthStore(), new InMemoryTrustStore()), undefined, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a wrong bearer', async () => {
    const res = await post(mount(new InMemoryAuthStore(), new InMemoryTrustStore()), 'wrong', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read key token', async () => {
    const res = await post(mount(new InMemoryAuthStore(), new InMemoryTrustStore()), OP_READ, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 400 for a bad body', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with "subjectId", "actorId", and "kind" strings',
    });
  });

  it('returns 400 for an unknown kind', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {
      subjectId: 'bad',
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the subject is missing', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount(account({ id: ACTOR, role: 'founder' }));
    const res = await post(mount(store, new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the actor is missing', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount(account({ id: SUBJECT, role: 'basis' }));
    const res = await post(mount(store, new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when subjectId equals actorId', async () => {
    const store = await seeded();
    const res = await post(mount(store, new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: SUBJECT,
      kind: 'verify',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Conflict' });
  });

  it('inserts the edge without changing account.role and returns ISO createdAt', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    const res = await post(mount(store, trustStore), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      subjectId: string;
      actorId: string;
      kind: string;
      createdAt: string;
    };
    expect(body.subjectId).toBe(SUBJECT);
    expect(body.actorId).toBe(ACTOR);
    expect(body.kind).toBe('verify');
    expect(body.createdAt).toBe('2026-09-12T12:00:00.000Z');
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect((await store.getAccount(SUBJECT))?.role).toBe('basis');
    expect(await trustStore.listEdges()).toHaveLength(1);
    expect(
      parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.inserted'),
    ).toBe(true);
  });

  it('returns 200 on a repeated moderator_reject and leaves role unchanged', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    const app = mount(store, trustStore);
    const first = await post(app, OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_reject',
    });
    expect(first.status).toBe(200);
    const second = await post(app, OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_reject',
    });
    expect(second.status).toBe(200);
    expect(
      (await trustStore.listEdges()).filter((row) => row.kind === 'moderator_reject'),
    ).toHaveLength(2);
    expect((await store.getAccount(SUBJECT))?.role).toBe('basis');
  });

  it('returns 200 on a repeated moderator_propose and leaves role unchanged', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    const app = mount(store, trustStore);
    const first = await post(app, OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_propose',
    });
    expect(first.status).toBe(200);
    const second = await post(app, OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_propose',
    });
    expect(second.status).toBe(200);
    expect(
      (await trustStore.listEdges()).filter((row) => row.kind === 'moderator_propose'),
    ).toHaveLength(2);
    expect((await store.getAccount(SUBJECT))?.role).toBe('basis');
  });

  it.each(['verify', 'moderator_confirm', 'moderator_appoint'] as const)(
    'returns 409 on a duplicate (subjectId, %s)',
    async (kind) => {
      const store = await seeded();
      const trustStore = new InMemoryTrustStore();
      const app = mount(store, trustStore);
      const first = await post(app, OP_WRITE, {
        subjectId: SUBJECT,
        actorId: ACTOR,
        kind,
      });
      expect(first.status).toBe(200);
      const second = await post(app, OP_WRITE, {
        subjectId: SUBJECT,
        actorId: ACTOR,
        kind,
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'Conflict' });
    },
  );

  it('returns 503 when getAccount throws', async () => {
    const store = await seeded();
    const inner = store.getAccount.bind(store);
    vi.spyOn(store, 'getAccount').mockImplementation(async (id) => {
      if (id === SUBJECT) {
        throw new Error('get boom');
      }
      return inner(id);
    });
    const res = await post(mount(store, new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.failed')).toBe(
      true,
    );
  });

  it('returns 503 when insert throws an unexpected error', async () => {
    const throwing: TrustStore = {
      listEdges: async () => [],
      listEdgesForSubject: async () => [],
      listEdgesTouching: async () => [],
      insertEdge: async () => {
        throw new Error('boom');
      },
      deleteEdge: async () => undefined,
      deleteEdgeById: async () => undefined,
    };
    const res = await post(mount(await seeded(), throwing), OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.failed')).toBe(
      true,
    );
  });

  it('uses Date.now when now is omitted', async () => {
    const store = await seeded();
    const app = new Hono().route(
      '/debug/trust-edges',
      debugTrustRoutes({
        store,
        trustStore: new InMemoryTrustStore(),
        operatorLogin: OP_KEYS.operatorLogin,
      }),
    );
    const res = await post(app, OP_WRITE, {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_appoint',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdAt: string };
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });
});

describe('DELETE /debug/trust-edges', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a matching bearer', async () => {
    const res = await del(mount(await seeded(), new InMemoryTrustStore()), undefined, {
      subjectId: SUBJECT,
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a bad body', async () => {
    const res = await del(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with "subjectId" and "kind" strings',
    });
  });

  it('returns 404 for a non-uuid subjectId', async () => {
    const res = await del(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {
      subjectId: 'nope',
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when no edge matches', async () => {
    const res = await del(mount(await seeded(), new InMemoryTrustStore()), OP_WRITE, {
      subjectId: SUBJECT,
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('deletes the edge without changing account.role', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    await trustStore.insertEdge({
      id: 'edge-1',
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_confirm',
      createdAt: now(),
    });
    const res = await del(mount(store, trustStore), OP_WRITE, {
      subjectId: SUBJECT,
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'edge-1',
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_confirm',
      createdAt: '2026-09-12T12:00:00.000Z',
    });
    expect(await trustStore.listEdges()).toEqual([]);
    expect((await store.getAccount(SUBJECT))?.role).toBe('basis');
    expect(parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.deleted')).toBe(
      true,
    );
  });

  it('returns 503 when deleteEdge throws', async () => {
    const throwing: TrustStore = {
      listEdges: async () => [],
      listEdgesForSubject: async () => [],
      listEdgesTouching: async () => [],
      insertEdge: async (row) => row,
      deleteEdge: async () => {
        throw new Error('boom');
      },
      deleteEdgeById: async () => undefined,
    };
    const res = await del(mount(await seeded(), throwing), OP_WRITE, {
      subjectId: SUBJECT,
      kind: 'moderator_confirm',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(
      parsedEvents(warn).some((event) => event['event'] === 'debug.trust_edges.delete_failed'),
    ).toBe(true);
  });
});
