import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { issueSession } from '@/lib/auth/service';
import { resolveRequestAuth } from '@/lib/request-auth';

describe('resolveRequestAuth', () => {
  it('returns none without a bearer', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: undefined,
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'none' });
  });

  it('classifies a matching debug token', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer debug',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'debug' });
  });

  it('classifies a matching spend token when debug does not match', async () => {
    const auth = await resolveRequestAuth({
      authorizationHeader: 'Bearer spend',
      authStore: new InMemoryAuthStore(),
      now: 1,
      debugToken: 'debug',
      spendApiToken: 'spend',
    });
    expect(auth).toEqual({ accountId: null, authKind: 'spend' });
  });

  it('classifies a live session', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
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
    expect(auth).toEqual({ accountId: 'acc', authKind: 'session' });
  });
});
