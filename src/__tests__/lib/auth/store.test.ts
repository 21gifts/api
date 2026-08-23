import { describe, it, expect } from 'vitest';
import { compareAccountsForList, InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

const KEY = `02${'a'.repeat(64)}`;
const T0 = 1_000_000;

describe('InMemoryAuthStore', () => {
  it('stores and retrieves a challenge', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect((await store.getChallenge('k1'))?.status).toBe('pending');
  });

  it('returns undefined for an unknown challenge', async () => {
    expect(await new InMemoryAuthStore().getChallenge('missing')).toBeUndefined();
  });

  it('refuses to authenticate a challenge that is not pending', async () => {
    const store = new InMemoryAuthStore();
    expect(
      await store.updateChallenge({
        k1: 'missing',
        pollToken: 'pt',
        status: 'authenticated',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('refuses to re-authenticate an already authenticated challenge', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect(
      await store.updateChallenge({
        k1: 'k1',
        pollToken: 'pt',
        status: 'authenticated',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.updateChallenge({
        k1: 'k1',
        pollToken: 'pt',
        status: 'authenticated',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('refuses to consume a challenge that is not authenticated', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect(
      await store.updateChallenge({
        k1: 'k1',
        pollToken: 'pt',
        status: 'consumed',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('overwrites a challenge on update', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect(
      await store.updateChallenge({
        k1: 'k1',
        pollToken: 'pt',
        status: 'authenticated',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.updateChallenge({
        k1: 'k1',
        pollToken: 'pt',
        status: 'consumed',
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getChallenge('k1'))?.status).toBe('consumed');
  });

  it('retrieves a challenge by its poll token', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect((await store.getChallengeByPollToken('pt'))?.k1).toBe('k1');
  });

  it('returns undefined for an unknown poll token', async () => {
    expect(await new InMemoryAuthStore().getChallengeByPollToken('missing')).toBeUndefined();
  });

  it('ignores a second createAccount with the same linkingKey', async () => {
    const store = new InMemoryAuthStore();
    const first = {
      id: 'acc-1',
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    };
    await store.createAccount(first);
    await store.createAccount({ ...first, id: 'acc-2', createdAt: 2 });
    expect((await store.getAccount('acc-1'))?.id).toBe('acc-1');
    expect(await store.getAccount('acc-2')).toBeUndefined();
    expect((await store.listAccounts()).map((row) => row.id)).toEqual(['acc-1']);
  });

  it('stores an account and finds it by id and by linkingKey', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.linkingKey).toBe(KEY);
    expect((await store.findAccountByLinkingKey(KEY))?.id).toBe('acc');
  });

  it('overwrites account fields on update', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: 'a@b.com',
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBe('a@b.com');
  });

  it('returns undefined for an unknown account id', async () => {
    expect(await new InMemoryAuthStore().getAccount('missing')).toBeUndefined();
  });

  it('returns undefined for an unknown linkingKey', async () => {
    expect(await new InMemoryAuthStore().findAccountByLinkingKey(KEY)).toBeUndefined();
  });

  it('lists accounts oldest first then by id', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'b',
      linkingKey: `02${'b'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 2,
    });
    await store.createAccount({
      id: 'a',
      linkingKey: `02${'c'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    const listed = await store.listAccounts();
    expect(listed.map((row) => row.id)).toEqual(['a', 'b']);
    await store.createAccount({
      id: 'c',
      linkingKey: `02${'d'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect((await store.listAccounts()).map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('compareAccountsForList orders by createdAt then id, including equality', () => {
    const base = {
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
    };
    const early = { ...base, id: 'a', createdAt: 1 };
    const late = { ...base, id: 'a', createdAt: 2 };
    const a = { ...base, id: 'a', createdAt: 1 };
    const b = { ...base, id: 'b', createdAt: 1 };
    expect(compareAccountsForList(early, late)).toBeLessThan(0);
    expect(compareAccountsForList(late, early)).toBeGreaterThan(0);
    expect(compareAccountsForList(a, b)).toBeLessThan(0);
    expect(compareAccountsForList(b, a)).toBeGreaterThan(0);
    expect(compareAccountsForList(a, a)).toBe(0);
  });

  it('stores and retrieves a session', async () => {
    const store = new InMemoryAuthStore();
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1 });
    expect((await store.getSession('tok'))?.accountId).toBe('acc');
  });

  it('returns undefined for an unknown session token', async () => {
    expect(await new InMemoryAuthStore().getSession('missing')).toBeUndefined();
  });

  it('evicts an expired challenge (and its poll-token index) on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'old',
      pollToken: 'pt-old',
      status: 'pending',
      accountId: null,
      createdAt: T0,
    });
    await store.createChallenge({
      k1: 'new',
      pollToken: 'pt-new',
      status: 'pending',
      accountId: null,
      createdAt: T0 + CHALLENGE_TTL_MS + 1,
    });
    expect(await store.getChallenge('old')).toBeUndefined();
    expect(await store.getChallengeByPollToken('pt-old')).toBeUndefined();
    expect((await store.getChallenge('new'))?.k1).toBe('new');
  });

  it('keeps a still-valid challenge on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'a',
      pollToken: 'pa',
      status: 'pending',
      accountId: null,
      createdAt: T0,
    });
    await store.createChallenge({
      k1: 'b',
      pollToken: 'pb',
      status: 'pending',
      accountId: null,
      createdAt: T0 + 1000,
    });
    expect((await store.getChallenge('a'))?.k1).toBe('a');
  });

  it('evicts an expired session on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createSession({ token: 'old', accountId: 'acc', createdAt: T0 });
    await store.createSession({
      token: 'new',
      accountId: 'acc',
      createdAt: T0 + SESSION_TTL_MS + 1,
    });
    expect(await store.getSession('old')).toBeUndefined();
    expect((await store.getSession('new'))?.token).toBe('new');
  });

  it('keeps a still-valid session on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createSession({ token: 'a', accountId: 'acc', createdAt: T0 });
    await store.createSession({ token: 'b', accountId: 'acc', createdAt: T0 + 1000 });
    expect((await store.getSession('a'))?.token).toBe('a');
  });

  it('stores and retrieves a pending address verification', async () => {
    const store = new InMemoryAuthStore();
    await store.putVerification({
      accountId: 'acc',
      address: 'alice@walletofsatoshi.com',
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    expect((await store.getVerification('acc'))?.nonce).toBe('a'.repeat(32));
  });

  it('upserts verification by accountId', async () => {
    const store = new InMemoryAuthStore();
    await store.putVerification({
      accountId: 'acc',
      address: 'alice@walletofsatoshi.com',
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    await store.putVerification({
      accountId: 'acc',
      address: 'bob@getalby.com',
      nonce: 'b'.repeat(32),
      createdAt: T0 + 1,
    });
    expect((await store.getVerification('acc'))?.address).toBe('bob@getalby.com');
    expect((await store.getVerification('acc'))?.nonce).toBe('b'.repeat(32));
  });

  it('returns undefined for an unknown verification account', async () => {
    expect(await new InMemoryAuthStore().getVerification('missing')).toBeUndefined();
  });

  it('deletes a pending verification', async () => {
    const store = new InMemoryAuthStore();
    await store.putVerification({
      accountId: 'acc',
      address: 'alice@walletofsatoshi.com',
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    await store.deleteVerification('acc');
    expect(await store.getVerification('acc')).toBeUndefined();
  });
});
