import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

const KEY = `02${'a'.repeat(64)}`;
const T0 = 1_000_000;

describe('InMemoryAuthStore', () => {
  it('stores and retrieves a challenge', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect(store.getChallenge('k1')?.status).toBe('pending');
  });

  it('returns undefined for an unknown challenge', () => {
    expect(new InMemoryAuthStore().getChallenge('missing')).toBeUndefined();
  });

  it('overwrites a challenge on update', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    store.updateChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'consumed',
      accountId: 'acc',
      createdAt: 1,
    });
    expect(store.getChallenge('k1')?.status).toBe('consumed');
  });

  it('retrieves a challenge by its poll token', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1,
    });
    expect(store.getChallengeByPollToken('pt')?.k1).toBe('k1');
  });

  it('returns undefined for an unknown poll token', () => {
    expect(new InMemoryAuthStore().getChallengeByPollToken('missing')).toBeUndefined();
  });

  it('stores an account and finds it by id and by linkingKey', () => {
    const store = new InMemoryAuthStore();
    store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect(store.getAccount('acc')?.linkingKey).toBe(KEY);
    expect(store.findAccountByLinkingKey(KEY)?.id).toBe('acc');
  });

  it('overwrites account fields on update', () => {
    const store = new InMemoryAuthStore();
    store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      lightningAddress: 'a@b.com',
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect(store.getAccount('acc')?.lightningAddress).toBe('a@b.com');
  });

  it('returns undefined for an unknown account id', () => {
    expect(new InMemoryAuthStore().getAccount('missing')).toBeUndefined();
  });

  it('returns undefined for an unknown linkingKey', () => {
    expect(new InMemoryAuthStore().findAccountByLinkingKey(KEY)).toBeUndefined();
  });

  it('stores and retrieves a session', () => {
    const store = new InMemoryAuthStore();
    store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1 });
    expect(store.getSession('tok')?.accountId).toBe('acc');
  });

  it('returns undefined for an unknown session token', () => {
    expect(new InMemoryAuthStore().getSession('missing')).toBeUndefined();
  });

  it('evicts an expired challenge (and its poll-token index) on a later create', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'old',
      pollToken: 'pt-old',
      status: 'pending',
      accountId: null,
      createdAt: T0,
    });
    store.createChallenge({
      k1: 'new',
      pollToken: 'pt-new',
      status: 'pending',
      accountId: null,
      createdAt: T0 + CHALLENGE_TTL_MS + 1,
    });
    expect(store.getChallenge('old')).toBeUndefined();
    expect(store.getChallengeByPollToken('pt-old')).toBeUndefined();
    expect(store.getChallenge('new')?.k1).toBe('new');
  });

  it('keeps a still-valid challenge on a later create', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'a',
      pollToken: 'pa',
      status: 'pending',
      accountId: null,
      createdAt: T0,
    });
    store.createChallenge({
      k1: 'b',
      pollToken: 'pb',
      status: 'pending',
      accountId: null,
      createdAt: T0 + 1000,
    });
    expect(store.getChallenge('a')?.k1).toBe('a');
  });

  it('evicts an expired session on a later create', () => {
    const store = new InMemoryAuthStore();
    store.createSession({ token: 'old', accountId: 'acc', createdAt: T0 });
    store.createSession({ token: 'new', accountId: 'acc', createdAt: T0 + SESSION_TTL_MS + 1 });
    expect(store.getSession('old')).toBeUndefined();
    expect(store.getSession('new')?.token).toBe('new');
  });

  it('keeps a still-valid session on a later create', () => {
    const store = new InMemoryAuthStore();
    store.createSession({ token: 'a', accountId: 'acc', createdAt: T0 });
    store.createSession({ token: 'b', accountId: 'acc', createdAt: T0 + 1000 });
    expect(store.getSession('a')?.token).toBe('a');
  });
});
