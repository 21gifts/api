import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import type { TrustEdge } from '@/lib/trust';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { trustChainRoutes } from '@/routes/trust-chain';
import { createApp } from '@/server';

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
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

function mount(authStore: InMemoryAuthStore, trustStore: TrustStore): Hono {
  return new Hono().route('/trust-chain', trustChainRoutes({ authStore, trustStore }));
}

describe('GET /trust-chain', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns empty arrays from the default store', async () => {
    const res = await createApp().request('/trust-chain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodes: [], edges: [] });
  });

  it('returns stored nodes and edges without propose or inferred links', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account({ id: 'f', role: 'founder', name: 'F', createdAt: 1 }));
    await authStore.createAccount(account({ id: 'm', role: 'moderator', name: 'M', createdAt: 2 }));
    await authStore.createAccount(account({ id: 'v', role: 'verified', name: 'V', createdAt: 3 }));
    await authStore.createAccount(account({ id: 'b', role: 'basis', name: 'B', createdAt: 0 }));
    await authStore.createAccount(
      account({ id: 'd', role: 'verified', name: 'Disconnected', createdAt: 4 }),
    );
    const edges: TrustEdge[] = [
      { id: 'e1', subjectId: 'v', actorId: 'm', kind: 'verify', createdAt: 10 },
      { id: 'e2', subjectId: 'v', actorId: 'm', kind: 'moderator_propose', createdAt: 11 },
      { id: 'e3', subjectId: 'm', actorId: 'f', kind: 'moderator_confirm', createdAt: 12 },
    ];
    const res = await mount(authStore, new InMemoryTrustStore(edges)).request('/trust-chain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodes: [
        { id: 'f', name: 'F', role: 'founder' },
        { id: 'm', name: 'M', role: 'moderator' },
        { id: 'v', name: 'V', role: 'verified' },
        { id: 'd', name: 'Disconnected', role: 'verified' },
      ],
      edges: [
        { from: 'm', to: 'v', kind: 'verify' },
        { from: 'f', to: 'm', kind: 'moderator_confirm' },
      ],
    });
  });

  it('returns 503 and logs when listEdges throws', async () => {
    const throwing: TrustStore = {
      listEdges: async () => {
        throw new Error('boom');
      },
      listEdgesForSubject: async () => [],
      insertEdge: async (row) => row,
    };
    const res = await mount(new InMemoryAuthStore(), throwing).request('/trust-chain');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.chain.failed')).toBe(true);
  });

  it('returns 503 and logs when listAccounts throws', async () => {
    const authStore = new InMemoryAuthStore();
    vi.spyOn(authStore, 'listAccounts').mockRejectedValue(new Error('auth down'));
    const res = await mount(authStore, new InMemoryTrustStore()).request('/trust-chain');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Trust chain is unavailable' });
    expect(parsedEvents(warn).some((event) => event['event'] === 'trust.chain.failed')).toBe(true);
  });
});
