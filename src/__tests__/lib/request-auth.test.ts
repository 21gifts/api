import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '@/lib/config';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { issueSession } from '@/lib/auth/service';
import { resolveRequestAuth } from '@/lib/request-auth';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';

describe('resolveRequestAuth', () => {
  it('returns none without a bearer', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: undefined,
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none', operator: null });
  });

  it('classifies a matching debug token', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer debug',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'debug', operator: null });
  });

  it('classifies a matching spend token when debug does not match', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer spend',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'spend', operator: null });
  });

  it('returns none for an empty Bearer token', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer ',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none', operator: null });
  });

  it('returns none for an unknown bearer', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer not-a-known-token',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none', operator: null });
  });

  it('returns none for an expired session', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'v'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
      isPlatform: false,
    });
    const account = await store.getAccount('acc');
    if (account === undefined) {
      throw new Error('missing account');
    }
    const minted = await issueSession(store, 1, account);
    const auth = await resolveRequestAuth({
      authorizationHeader: `Bearer ${minted.token}`,
      authStore: store,
      now: 1 + SESSION_TTL_MS + 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none', operator: null });
  });

  it('classifies a live session', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'v'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
      isPlatform: false,
    });
    const account = await store.getAccount('acc');
    if (account === undefined) {
      throw new Error('missing account');
    }
    const minted = await issueSession(store, 1, account);
    const auth = await resolveRequestAuth({
      authorizationHeader: `Bearer ${minted.token}`,
      authStore: store,
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: 'acc', authKind: 'session', operator: null });
  });

  it('classifies a key token as debug with its operator name', async () => {
    const keys = await seededOperatorLogin();
    const auth = await resolveRequestAuth({
      authorizationHeader: `Bearer ${keys.tokens.write}`,
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
      operatorLogin: keys.operatorLogin,
    });
    expect(auth).toEqual({ accountId: null, authKind: 'debug', operator: 'op-write' });
  });

  it('keeps DEBUG_TOKEN as debug without an operator next to a key login', async () => {
    const keys = await seededOperatorLogin();
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer debug',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
      operatorLogin: keys.operatorLogin,
    });
    expect(auth).toEqual({ accountId: null, authKind: 'debug', operator: null });
  });

  it('falls through to sessions for an unknown key token', async () => {
    const keys = await seededOperatorLogin();
    const auth = await resolveRequestAuth({
      authorizationHeader: `Bearer op_${'q'.repeat(43)}`,
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
      operatorLogin: keys.operatorLogin,
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none', operator: null });
  });
});
