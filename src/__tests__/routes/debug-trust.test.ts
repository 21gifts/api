import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { debugTrustRoutes } from '@/routes/debug-trust';

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
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
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
  debugToken: string | undefined | null = 'secret',
  clock: (() => number) | undefined = now,
): Hono {
  return new Hono().route(
    '/debug/trust-edges',
    debugTrustRoutes({
      store,
      trustStore,
      debugToken: debugToken === null ? undefined : debugToken,
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
      'secret',
      { subjectId: SUBJECT, actorId: ACTOR, kind: 'verify' },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const res = await post(
      mount(new InMemoryAuthStore(), new InMemoryTrustStore(), '  '),
      'secret',
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

  it('returns 400 for a bad body', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), 'secret', {
      subjectId: SUBJECT,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with "subjectId", "actorId", and "kind" strings',
    });
  });

  it('returns 400 for an unknown kind', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await post(mount(await seeded(), new InMemoryTrustStore()), 'secret', {
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
    const res = await post(mount(store, new InMemoryTrustStore()), 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the actor is missing', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount(account({ id: SUBJECT, role: 'basis' }));
    const res = await post(mount(store, new InMemoryTrustStore()), 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'verify',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when subjectId equals actorId', async () => {
    const store = await seeded();
    const res = await post(mount(store, new InMemoryTrustStore()), 'secret', {
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
    const res = await post(mount(store, trustStore), 'secret', {
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

  it('returns 409 on a duplicate (subjectId, kind)', async () => {
    const store = await seeded();
    const trustStore = new InMemoryTrustStore();
    const app = mount(store, trustStore);
    const first = await post(app, 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_propose',
    });
    expect(first.status).toBe(200);
    const second = await post(app, 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_propose',
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'Conflict' });
  });

  it('returns 503 when insert throws an unexpected error', async () => {
    const throwing: TrustStore = {
      listEdges: async () => [],
      listEdgesForSubject: async () => [],
      insertEdge: async () => {
        throw new Error('boom');
      },
    };
    const res = await post(mount(await seeded(), throwing), 'secret', {
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
      debugTrustRoutes({ store, trustStore: new InMemoryTrustStore(), debugToken: 'secret' }),
    );
    const res = await post(app, 'secret', {
      subjectId: SUBJECT,
      actorId: ACTOR,
      kind: 'moderator_appoint',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdAt: string };
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });
});
