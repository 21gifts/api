import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { trustChainRoutes } from '@/routes/trust-chain';
import { createApp } from '@/server';

const now = (): number => 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer tok' };

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

function mount(authStore: InMemoryAuthStore, trustStore: TrustStore): Hono {
  return new Hono().route('/trust-chain', trustChainRoutes({ authStore, trustStore, now }));
}

async function signIn(authStore: InMemoryAuthStore, accountId: string): Promise<void> {
  await authStore.createSession({ token: 'tok', accountId, createdAt: now() });
}

describe('GET /trust-chain', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a bearer session', async () => {
    const res = await createApp().request('/trust-chain');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for an unknown bearer token', async () => {
    const res = await createApp().request('/trust-chain', {
      headers: { Authorization: 'Bearer unknown' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns empty arrays from the default store', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const res = await createApp({ authStore, now }).request('/trust-chain', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodes: [], edges: [] });
  });

  it('returns only founder seeds with no edges on the bare GET', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 3 }));
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const edges: TrustEdge[] = [
      { id: 'e1', subjectId: 'v', actorId: 'm', kind: 'verify', createdAt: 10 },
      { id: 'e3', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm', createdAt: 12 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request('/trust-chain', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [{ id: 'f', name: 'F', role: 'founder' }],
      edges: [],
    });
  });

  it('treats empty around as founder seeds, not 404', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 3 }));
    await signIn(authStore, 'v');
    const res = await mount(authStore, new InMemoryTrustStore()).request('/trust-chain?around=', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [{ id: 'f', name: 'F', role: 'founder' }],
      edges: [],
    });
  });

  it('returns one hop around a chain member, credits the proposer, omits confirm and pending propose', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'p', role: 'moderator', name: 'P', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 3 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 4 }));
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const edges: TrustEdge[] = [
      { id: 'e1', subjectId: 'v', actorId: 'm', kind: 'verify', createdAt: 10 },
      { id: 'e2', subjectId: 'v', actorId: 'm', kind: 'moderator_propose', createdAt: 11 },
      { id: 'e-propose', subjectId: 'm', actorId: 'p', kind: 'moderator_propose', createdAt: 11 },
      { id: 'e3', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm', createdAt: 12 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request(
      '/trust-chain?around=m',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [
        { id: 'p', name: 'P', role: 'moderator' },
        { id: 'm', name: 'M', role: 'moderator' },
        { id: 'v', name: 'V', role: 'verified' },
      ],
      edges: [
        { from: 'm', to: 'v', kind: 'verify' },
        { from: 'p', to: 'm', kind: 'moderator_propose' },
      ],
    });
  });

  it('omits a propose-only neighbor from the hop', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'p', role: 'verified', name: 'P', createdAt: 3 }));
    await signIn(authStore, 'f');
    const edges: TrustEdge[] = [
      { id: 'e2', subjectId: 'p', actorId: 'm', kind: 'moderator_propose', createdAt: 11 },
      { id: 'e3', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm', createdAt: 12 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request(
      '/trust-chain?around=m',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [{ id: 'm', name: 'M', role: 'moderator' }],
      edges: [],
    });
  });

  it('skips a missing oldest sibling actor so a later chain contact can show', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 3 }));
    await signIn(authStore, 'f');
    const edges: TrustEdge[] = [
      { id: 'e-ghost', subjectId: 'v', actorId: 'ghost', kind: 'verify', createdAt: 10 },
      { id: 'e-mod', subjectId: 'v', actorId: 'm', kind: 'verify', createdAt: 11 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request(
      '/trust-chain?around=m',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [
        { id: 'm', name: 'M', role: 'moderator' },
        { id: 'v', name: 'V', role: 'verified' },
      ],
      edges: [{ from: 'm', to: 'v', kind: 'verify' }],
    });
  });

  it('skips a non-chain oldest verify so a later chain contact can show', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 3 }));
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'f');
    const edges: TrustEdge[] = [
      { id: 'e-basis', subjectId: 'v', actorId: 'b', kind: 'verify', createdAt: 10 },
      { id: 'e-mod', subjectId: 'v', actorId: 'm', kind: 'verify', createdAt: 11 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request(
      '/trust-chain?around=v',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [
        { id: 'm', name: 'M', role: 'moderator' },
        { id: 'v', name: 'V', role: 'verified' },
      ],
      edges: [{ from: 'm', to: 'v', kind: 'verify' }],
    });
  });

  it('omits founder appoint when the subject was verified by someone else', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 's', role: 'moderator', name: 'S', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'r', role: 'moderator', name: 'R', createdAt: 3 }));
    await signIn(authStore, 'f');
    const edges: TrustEdge[] = [
      { id: 'e-v', subjectId: 'r', actorId: 's', kind: 'verify', createdAt: 10 },
      { id: 'e-a', subjectId: 'r', actorId: 'f', kind: 'moderator_appoint', createdAt: 11 },
    ];
    const app = mount(authStore, new InMemoryTrustStore(edges));
    const aroundFounder = await app.request('/trust-chain?around=f', { headers: AUTH });
    expect(aroundFounder.status).toBe(200);
    expect(await aroundFounder.json()).toEqual({
      nodes: [{ id: 'f', name: 'F', role: 'founder' }],
      edges: [],
    });
    const aroundSubject = await app.request('/trust-chain?around=r', { headers: AUTH });
    expect(aroundSubject.status).toBe(200);
    expect(await aroundSubject.json()).toEqual({
      nodes: [
        { id: 's', name: 'S', role: 'moderator' },
        { id: 'r', name: 'R', role: 'moderator' },
      ],
      edges: [{ from: 's', to: 'r', kind: 'verify' }],
    });
  });

  it('returns 404 when around is missing or not on the chain', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const missing = await mount(authStore, new InMemoryTrustStore()).request(
      '/trust-chain?around=ghost',
      { headers: AUTH },
    );
    expect(missing.status).toBe(404);
    const basis = await mount(authStore, new InMemoryTrustStore()).request(
      '/trust-chain?around=b',
      { headers: AUTH },
    );
    expect(basis.status).toBe(404);
  });

  it('returns 404 when getAccount throws a Postgres invalid-uuid error', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const original = authStore.getAccount.bind(authStore);
    vi.spyOn(authStore, 'getAccount').mockImplementation(async (id) => {
      if (id === 'ghost') {
        throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      }
      return original(id);
    });
    const res = await mount(authStore, new InMemoryTrustStore()).request(
      '/trust-chain?around=ghost',
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for the Bun SQL invalid-uuid error shape without logging', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const original = authStore.getAccount.bind(authStore);
    vi.spyOn(authStore, 'getAccount').mockImplementation(async (id) => {
      if (id === 'ghost') {
        throw Object.assign(new Error('invalid input syntax for type uuid'), {
          code: 'ERR_POSTGRES_SERVER_ERROR',
          errno: '22P02',
        });
      }
      return original(id);
    });
    const res = await mount(authStore, new InMemoryTrustStore()).request(
      '/trust-chain?around=ghost',
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.chain.failed')).toBe(false);
  });

  it('returns 503 when getAccount throws a non-uuid error', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    const original = authStore.getAccount.bind(authStore);
    vi.spyOn(authStore, 'getAccount').mockImplementation(async (id) => {
      if (id === 'f') {
        throw new Error('auth down');
      }
      return original(id);
    });
    const res = await mount(authStore, new InMemoryTrustStore()).request('/trust-chain?around=f', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
  });

  it('returns 503 and logs when listEdgesTouching throws', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await signIn(authStore, 'f');
    const throwing: TrustStore = {
      listEdges: async () => [],
      listEdgesForSubject: async () => [],
      listEdgesTouching: async () => {
        throw new Error('boom');
      },
      insertEdge: async (row) => row,
      deleteEdge: async () => undefined,
      deleteEdgeById: async () => undefined,
    };
    const res = await mount(authStore, throwing).request('/trust-chain?around=f', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.chain.failed')).toBe(true);
  });

  it('returns 503 and logs when listAccounts throws', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await signIn(authStore, 'b');
    vi.spyOn(authStore, 'listAccounts').mockRejectedValue(new Error('auth down'));
    const res = await mount(authStore, new InMemoryTrustStore()).request('/trust-chain', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.chain.failed')).toBe(true);
  });
});
