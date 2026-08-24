import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { SESSION_TTL_MS } from '@/lib/config';
import { issueSession, resolveSession } from '@/lib/auth/service';

const T0 = 1_000_000;

async function seedAccount(store: InMemoryAuthStore): Promise<void> {
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: T0,
  });
}

describe('issueSession', () => {
  it('persists a bearer token for the account', async () => {
    const store = new InMemoryAuthStore();
    await seedAccount(store);
    const account = await store.getAccount('acc');
    if (account === undefined) {
      throw new Error('expected account');
    }
    const issued = await issueSession(store, T0, account);
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.account.id).toBe('acc');
    expect((await store.getSession(issued.token))?.accountId).toBe('acc');
  });
});

describe('resolveSession', () => {
  it('returns null for an unknown token', async () => {
    expect(await resolveSession(new InMemoryAuthStore(), T0, 'nope')).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const store = new InMemoryAuthStore();
    await seedAccount(store);
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect(await resolveSession(store, T0 + SESSION_TTL_MS + 1, 'tok')).toBeNull();
  });

  it('returns the account for a valid session', async () => {
    const store = new InMemoryAuthStore();
    await seedAccount(store);
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect((await resolveSession(store, T0, 'tok'))?.id).toBe('acc');
  });
});
