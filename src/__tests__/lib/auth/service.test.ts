import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import { claimSession, completeCallback, resolveSession, startChallenge } from '@/lib/auth/service';
import { newWallet, type TestWallet } from '@/__tests__/helpers/auth-vectors';

const T0 = 1_000_000;
const BASE = 'https://dev-api.21.gifts';
const KEY = `02${'a'.repeat(64)}`;

describe('startChallenge', () => {
  it('mints and stores a pending challenge with an lnurl', () => {
    const store = new InMemoryAuthStore();
    const res = startChallenge(store, BASE, T0);
    expect(res.k1).toMatch(/^[0-9a-f]{64}$/);
    expect(res.lnurl.startsWith('lnurl1')).toBe(true);
    expect(res.expiresInSeconds).toBe(Math.floor(CHALLENGE_TTL_MS / 1000));
    expect(res.pollToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.pollToken).not.toBe(res.k1);
    const stored = store.getChallenge(res.k1);
    expect(stored?.status).toBe('pending');
    expect(stored?.accountId).toBeNull();
  });
});

describe('completeCallback', () => {
  it('rejects an unknown challenge', () => {
    const w = newWallet();
    const k1 = 'a'.repeat(64);
    const res = completeCallback(new InMemoryAuthStore(), T0, { k1, sig: w.sign(k1), key: w.key });
    expect(res).toEqual({ ok: false, reason: 'Unknown or expired challenge' });
  });

  it('rejects a challenge that is not pending', () => {
    const store = new InMemoryAuthStore();
    store.createChallenge({
      k1: 'k1',
      pollToken: 'pt-k1',
      status: 'consumed',
      accountId: 'acc',
      createdAt: T0,
    });
    const res = completeCallback(store, T0, { k1: 'k1', sig: 'abcd', key: KEY });
    expect(res).toEqual({ ok: false, reason: 'Challenge already used' });
  });

  it('rejects an expired challenge', () => {
    const store = new InMemoryAuthStore();
    const { k1 } = startChallenge(store, BASE, T0);
    const w = newWallet();
    const res = completeCallback(store, T0 + CHALLENGE_TTL_MS + 1, {
      k1,
      sig: w.sign(k1),
      key: w.key,
    });
    expect(res).toEqual({ ok: false, reason: 'Challenge expired' });
  });

  it('rejects an invalid signature', () => {
    const store = new InMemoryAuthStore();
    const { k1 } = startChallenge(store, BASE, T0);
    const res = completeCallback(store, T0, { k1, sig: 'abcd', key: KEY });
    expect(res).toEqual({ ok: false, reason: 'Invalid signature' });
  });

  it('creates a Basis account on first login and authenticates the challenge', () => {
    const store = new InMemoryAuthStore();
    const { k1 } = startChallenge(store, BASE, T0);
    const w = newWallet();
    expect(completeCallback(store, T0, { k1, sig: w.sign(k1), key: w.key })).toEqual({ ok: true });
    const account = store.findAccountByLinkingKey(w.key);
    expect(account?.role).toBe('basis');
    expect(store.getChallenge(k1)?.status).toBe('authenticated');
    expect(store.getChallenge(k1)?.accountId).toBe(account?.id);
  });

  it('reuses the existing account on a later login with the same key', () => {
    const store = new InMemoryAuthStore();
    const w = newWallet();
    const first = startChallenge(store, BASE, T0);
    completeCallback(store, T0, { k1: first.k1, sig: w.sign(first.k1), key: w.key });
    const firstId = store.findAccountByLinkingKey(w.key)?.id;
    const second = startChallenge(store, BASE, T0);
    expect(
      completeCallback(store, T0, { k1: second.k1, sig: w.sign(second.k1), key: w.key }),
    ).toEqual({ ok: true });
    expect(store.findAccountByLinkingKey(w.key)?.id).toBe(firstId);
  });

  it('canonicalises the linkingKey so a differently-cased key is the same account', () => {
    const store = new InMemoryAuthStore();
    const w = newWallet(); // w.key is lower-case hex
    const first = startChallenge(store, BASE, T0);
    completeCallback(store, T0, { k1: first.k1, sig: w.sign(first.k1), key: w.key.toUpperCase() });
    const second = startChallenge(store, BASE, T0);
    completeCallback(store, T0, { k1: second.k1, sig: w.sign(second.k1), key: w.key });
    expect(store.findAccountByLinkingKey(w.key)).toBeDefined();
    expect(store.findAccountByLinkingKey(w.key.toUpperCase())).toBeUndefined();
  });
});

function authenticatedChallenge(
  store: InMemoryAuthStore,
  w: TestWallet,
): { k1: string; pollToken: string } {
  const { k1, pollToken } = startChallenge(store, BASE, T0);
  completeCallback(store, T0, { k1, sig: w.sign(k1), key: w.key });
  return { k1, pollToken };
}

describe('claimSession', () => {
  it('reports expired for an unknown poll token', () => {
    expect(claimSession(new InMemoryAuthStore(), T0, 'nope')).toEqual({ status: 'expired' });
  });

  it('reports expired for an aged challenge', () => {
    const store = new InMemoryAuthStore();
    const { pollToken } = startChallenge(store, BASE, T0);
    expect(claimSession(store, T0 + CHALLENGE_TTL_MS + 1, pollToken)).toEqual({
      status: 'expired',
    });
  });

  it('reports pending before the wallet signs', () => {
    const store = new InMemoryAuthStore();
    const { pollToken } = startChallenge(store, BASE, T0);
    expect(claimSession(store, T0, pollToken)).toEqual({ status: 'pending' });
  });

  it('does not accept the public k1 as a poll token', () => {
    const store = new InMemoryAuthStore();
    const { k1 } = authenticatedChallenge(store, newWallet());
    // A QR observer knows k1 but not the secret poll token — the claim must fail.
    expect(claimSession(store, T0, k1)).toEqual({ status: 'expired' });
  });

  it('issues a session once a challenge is authenticated, then marks it used', () => {
    const store = new InMemoryAuthStore();
    const w = newWallet();
    const { k1, pollToken } = authenticatedChallenge(store, w);
    const res = claimSession(store, T0, pollToken);
    expect(res.status).toBe('authenticated');
    if (res.status !== 'authenticated') throw new Error('unreachable');
    expect(res.account.linkingKey).toBe(w.key);
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getSession(res.token)?.accountId).toBe(res.account.id);
    expect(store.getChallenge(k1)?.status).toBe('consumed');
    expect(claimSession(store, T0, pollToken)).toEqual({ status: 'used' });
  });
});

describe('resolveSession', () => {
  it('returns null for an unknown token', () => {
    expect(resolveSession(new InMemoryAuthStore(), T0, 'nope')).toBeNull();
  });

  it('returns null for an expired session', () => {
    const store = new InMemoryAuthStore();
    store.createAccount({ id: 'acc', linkingKey: KEY, role: 'basis', createdAt: T0 });
    store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect(resolveSession(store, T0 + SESSION_TTL_MS + 1, 'tok')).toBeNull();
  });

  it('returns the account for a valid session', () => {
    const store = new InMemoryAuthStore();
    store.createAccount({ id: 'acc', linkingKey: KEY, role: 'basis', createdAt: T0 });
    store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect(resolveSession(store, T0, 'tok')?.id).toBe('acc');
  });
});
