import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import { encodeLnurl } from '@/lib/auth/lnurl';
import { claimSession, completeCallback, resolveSession, startChallenge } from '@/lib/auth/service';
import { newWallet, type TestWallet } from '@/__tests__/helpers/auth-vectors';

const T0 = 1_000_000;
const BASE = 'https://dev.21.gifts';
const KEY = `02${'a'.repeat(64)}`;

describe('startChallenge', () => {
  it('mints and stores a pending challenge with an lnurl', async () => {
    const store = new InMemoryAuthStore();
    const res = await startChallenge(store, BASE, T0);
    expect(res.k1).toMatch(/^[0-9a-f]{64}$/);
    expect(res.lnurl).toBe(encodeLnurl(`${BASE}/auth/lnurl/callback?tag=login&k1=${res.k1}`));
    expect(res.expiresInSeconds).toBe(Math.floor(CHALLENGE_TTL_MS / 1000));
    expect(res.pollToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.pollToken).not.toBe(res.k1);
    const stored = await store.getChallenge(res.k1);
    expect(stored?.status).toBe('pending');
    expect(stored?.accountId).toBeNull();
  });
});

describe('completeCallback', () => {
  it('rejects an unknown challenge', async () => {
    const w = newWallet();
    const k1 = 'a'.repeat(64);
    const res = await completeCallback(new InMemoryAuthStore(), T0, {
      k1,
      sig: w.sign(k1),
      key: w.key,
    });
    expect(res).toEqual({ ok: false, reason: 'Unknown or expired challenge' });
  });

  it('rejects a challenge that is not pending', async () => {
    const store = new InMemoryAuthStore();
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt-k1',
      status: 'consumed',
      accountId: 'acc',
      createdAt: T0,
    });
    const res = await completeCallback(store, T0, { k1: 'k1', sig: 'abcd', key: KEY });
    expect(res).toEqual({ ok: false, reason: 'Challenge already used' });
  });

  it('rejects an expired challenge', async () => {
    const store = new InMemoryAuthStore();
    const { k1 } = await startChallenge(store, BASE, T0);
    const w = newWallet();
    const res = await completeCallback(store, T0 + CHALLENGE_TTL_MS + 1, {
      k1,
      sig: w.sign(k1),
      key: w.key,
    });
    expect(res).toEqual({ ok: false, reason: 'Challenge expired' });
  });

  it('rejects an invalid signature', async () => {
    const store = new InMemoryAuthStore();
    const { k1 } = await startChallenge(store, BASE, T0);
    const res = await completeCallback(store, T0, { k1, sig: 'abcd', key: KEY });
    expect(res).toEqual({ ok: false, reason: 'Invalid signature' });
  });

  it('creates a Basis account on first login and authenticates the challenge', async () => {
    const store = new InMemoryAuthStore();
    const { k1 } = await startChallenge(store, BASE, T0);
    const w = newWallet();
    const result = await completeCallback(store, T0, { k1, sig: w.sign(k1), key: w.key });
    const account = await store.findAccountByLinkingKey(w.key);
    expect(result).toEqual({ ok: true, accountId: account?.id, firstLogin: true });
    expect(account?.role).toBe('basis');
    expect(account?.name).toBeNull();
    expect((await store.getChallenge(k1))?.status).toBe('authenticated');
    expect((await store.getChallenge(k1))?.accountId).toBe(account?.id);
  });

  it('reuses the existing account on a later login with the same key', async () => {
    const store = new InMemoryAuthStore();
    const w = newWallet();
    const first = await startChallenge(store, BASE, T0);
    await completeCallback(store, T0, { k1: first.k1, sig: w.sign(first.k1), key: w.key });
    const firstId = (await store.findAccountByLinkingKey(w.key))?.id;
    const second = await startChallenge(store, BASE, T0);
    expect(
      await completeCallback(store, T0, { k1: second.k1, sig: w.sign(second.k1), key: w.key }),
    ).toEqual({ ok: true, accountId: firstId, firstLogin: false });
    expect((await store.findAccountByLinkingKey(w.key))?.id).toBe(firstId);
  });

  it('canonicalises the linkingKey so a differently-cased key is the same account', async () => {
    const store = new InMemoryAuthStore();
    const w = newWallet(); // w.key is lower-case hex
    const first = await startChallenge(store, BASE, T0);
    await completeCallback(store, T0, {
      k1: first.k1,
      sig: w.sign(first.k1),
      key: w.key.toUpperCase(),
    });
    const second = await startChallenge(store, BASE, T0);
    await completeCallback(store, T0, { k1: second.k1, sig: w.sign(second.k1), key: w.key });
    expect(await store.findAccountByLinkingKey(w.key)).toBeDefined();
    expect(await store.findAccountByLinkingKey(w.key.toUpperCase())).toBeUndefined();
  });
});

async function authenticatedChallenge(
  store: InMemoryAuthStore,
  w: TestWallet,
): Promise<{ k1: string; pollToken: string }> {
  const { k1, pollToken } = await startChallenge(store, BASE, T0);
  await completeCallback(store, T0, { k1, sig: w.sign(k1), key: w.key });
  return { k1, pollToken };
}

describe('claimSession', () => {
  it('reports expired for an unknown poll token', async () => {
    expect(await claimSession(new InMemoryAuthStore(), T0, 'nope')).toEqual({ status: 'expired' });
  });

  it('reports expired for an aged challenge', async () => {
    const store = new InMemoryAuthStore();
    const { pollToken } = await startChallenge(store, BASE, T0);
    expect(await claimSession(store, T0 + CHALLENGE_TTL_MS + 1, pollToken)).toEqual({
      status: 'expired',
    });
  });

  it('reports pending before the wallet signs', async () => {
    const store = new InMemoryAuthStore();
    const { pollToken } = await startChallenge(store, BASE, T0);
    expect(await claimSession(store, T0, pollToken)).toEqual({ status: 'pending' });
  });

  it('does not accept the public k1 as a poll token', async () => {
    const store = new InMemoryAuthStore();
    const { k1 } = await authenticatedChallenge(store, newWallet());
    // A QR observer knows k1 but not the secret poll token — the claim must fail.
    expect(await claimSession(store, T0, k1)).toEqual({ status: 'expired' });
  });

  it('issues a session once a challenge is authenticated, then marks it used', async () => {
    const store = new InMemoryAuthStore();
    const w = newWallet();
    const { k1, pollToken } = await authenticatedChallenge(store, w);
    const res = await claimSession(store, T0, pollToken);
    expect(res.status).toBe('authenticated');
    if (res.status !== 'authenticated') throw new Error('unreachable');
    expect(res.account.linkingKey).toBe(w.key);
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.getSession(res.token))?.accountId).toBe(res.account.id);
    expect((await store.getChallenge(k1))?.status).toBe('consumed');
    expect(await claimSession(store, T0, pollToken)).toEqual({ status: 'used' });
  });
});

describe('resolveSession', () => {
  it('returns null for an unknown token', async () => {
    expect(await resolveSession(new InMemoryAuthStore(), T0, 'nope')).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: T0,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect(await resolveSession(store, T0 + SESSION_TTL_MS + 1, 'tok')).toBeNull();
  });

  it('returns the account for a valid session', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: T0,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: T0 });
    expect((await resolveSession(store, T0, 'tok'))?.id).toBe('acc');
  });
});
