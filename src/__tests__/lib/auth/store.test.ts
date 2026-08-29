import { describe, it, expect } from 'vitest';
import { compareAccountsForList, InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

const KEY = `02${'a'.repeat(64)}`;
const T0 = 1_000_000;

describe('InMemoryAuthStore', () => {
  it('ignores a second createAccount with the same linkingKey', async () => {
    const store = new InMemoryAuthStore();
    const first = {
      id: 'acc-1',
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    };
    await store.createAccount(first);
    await store.createAccount({ ...first, id: 'acc-2', createdAt: 2, viewKey: 'b'.repeat(64) });
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
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.linkingKey).toBe(KEY);
    expect((await store.getAccount('acc'))?.id).toBe('acc');
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
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: 'a@b.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBe('a@b.com');
  });

  it('round-trips forumLawsDismissed false and true', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-false',
      linkingKey: `02${'e'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      createdAt: 1,
    });
    expect((await store.getAccount('acc-false'))?.forumLawsDismissed).toBe(false);
    await store.createAccount({
      id: 'acc-true',
      linkingKey: `02${'f'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: true,
      createdAt: 2,
    });
    expect((await store.getAccount('acc-true'))?.forumLawsDismissed).toBe(true);
    await store.updateAccount({
      id: 'acc-false',
      linkingKey: `02${'e'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: true,
      createdAt: 1,
    });
    expect((await store.getAccount('acc-false'))?.forumLawsDismissed).toBe(true);
  });

  it('returns undefined for an unknown account id', async () => {
    expect(await new InMemoryAuthStore().getAccount('missing')).toBeUndefined();
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
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
    });
    await store.createAccount({
      id: 'a',
      linkingKey: `02${'c'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
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
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
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
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
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

  it('stores two passkey accounts without clobbering the linkingKey index', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'p1',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: '1'.repeat(64),
      createdAt: 1,
    });
    await store.createAccount({
      id: 'p2',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: '2'.repeat(64),
      createdAt: 1,
    });
    await store.createAccount({
      id: 'ln',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: '3'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('p1'))?.id).toBe('p1');
    expect((await store.getAccount('p2'))?.id).toBe('p2');
    expect((await store.getAccount('ln'))?.id).toBe('ln');
  });

  it('keeps the LNURL index when updateAccount only changes the address', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: 'a@b.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBe('a@b.com');
  });

  it('drops the linkingKey index when updateAccount clears it', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.linkingKey).toBeNull();
  });

  it('indexes a linkingKey added on updateAccount', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('acc'))?.id).toBe('acc');
  });

  it('stores and retrieves a passkey challenge and credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 1,
    });
    expect(
      await store.updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: 'acc',
        consumed: true,
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getPasskeyChallenge('ch'))?.consumed).toBe(true);
    expect(await store.getPasskeyChallenge('missing')).toBeUndefined();
    expect(
      await store.updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: 'acc',
        consumed: true,
        createdAt: 1,
      }),
    ).toBe(false);
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 9,
        accountId: 'other',
        createdAt: 1,
      }),
    ).toBe(false);
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 2,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 1,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    expect((await store.getPasskeyCredential('cred'))?.signCount).toBe(2);
    expect((await store.getPasskeyCredential('cred'))?.accountId).toBe('acc');
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([9]),
        signCount: 3,
        accountId: 'other',
        createdAt: 99,
      }),
    ).toBe(true);
    expect(await store.getPasskeyCredential('cred')).toEqual({
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 3,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(await store.getPasskeyCredential('missing')).toBeUndefined();
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'missing',
        publicKey: new Uint8Array([1]),
        signCount: 9,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    expect(await store.getPasskeyCredential('missing')).toBeUndefined();
  });

  it('accepts a 0/0 signCount update and refuses an equal counter', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyCredential({
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getPasskeyCredential('cred'))?.signCount).toBe(0);
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 3,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 3,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    expect((await store.getPasskeyCredential('cred'))?.signCount).toBe(3);
  });

  it('lets only the first of two sequential N+1 signCount updates succeed', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyCredential({
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 4,
      accountId: 'acc',
      createdAt: 1,
    });
    const next = {
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 5,
      accountId: 'acc',
      createdAt: 1,
    };
    expect(await store.updatePasskeyCredential(next)).toBe(true);
    expect(await store.updatePasskeyCredential(next)).toBe(false);
    expect((await store.getPasskeyCredential('cred'))?.signCount).toBe(5);
  });

  it('refuses to let updateAccount steal another account linkingKey', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'ln',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.createAccount({
      id: 'pk',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'pk',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('ln'))?.linkingKey).toBe(KEY);
    expect((await store.getAccount('pk'))?.linkingKey).toBeNull();
  });

  it('finds an account by viewKey and misses unknown keys', async () => {
    const store = new InMemoryAuthStore();
    const viewKey = 'f'.repeat(64);
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey,
      createdAt: 1,
    });
    expect((await store.getAccountByViewKey(viewKey))?.id).toBe('acc');
    expect(await store.getAccountByViewKey('0'.repeat(64))).toBeUndefined();
  });

  it('ignores a second createAccount with the same viewKey', async () => {
    const store = new InMemoryAuthStore();
    const viewKey = 'e'.repeat(64);
    await store.createAccount({
      id: 'acc-1',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey,
      createdAt: 1,
    });
    await store.createAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey,
      createdAt: 2,
    });
    expect((await store.getAccount('acc-1'))?.id).toBe('acc-1');
    expect(await store.getAccount('acc-2')).toBeUndefined();
    expect((await store.getAccountByViewKey(viewKey))?.id).toBe('acc-1');
  });

  it('reindexes viewKey when updateAccount changes it', async () => {
    const store = new InMemoryAuthStore();
    const oldKey = 'd'.repeat(64);
    const newKey = 'c'.repeat(64);
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey: oldKey,
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey: newKey,
      createdAt: 1,
    });
    expect(await store.getAccountByViewKey(oldKey)).toBeUndefined();
    expect((await store.getAccountByViewKey(newKey))?.id).toBe('acc');
  });

  it('refuses updateAccount when viewKey is owned by another id', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-1',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey: '1'.repeat(64),
      createdAt: 1,
    });
    await store.createAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey: '2'.repeat(64),
      createdAt: 2,
    });
    await store.updateAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: 'stolen',
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey: '1'.repeat(64),
      createdAt: 2,
    });
    expect((await store.getAccount('acc-2'))?.viewKey).toBe('2'.repeat(64));
    expect((await store.getAccount('acc-2'))?.name).toBeNull();
    expect((await store.getAccountByViewKey('1'.repeat(64)))?.id).toBe('acc-1');
  });

  it('deleteAccount drops the viewKey index so the key can be reused', async () => {
    const store = new InMemoryAuthStore();
    const viewKey = '9'.repeat(64);
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey,
      createdAt: 1,
    });
    await store.deleteAccount('acc');
    expect(await store.getAccountByViewKey(viewKey)).toBeUndefined();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      viewKey,
      createdAt: 2,
    });
    expect((await store.getAccountByViewKey(viewKey))?.id).toBe('other');
  });

  it('deleteAccount drops the row and its linkingKey index', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    await store.deleteAccount('acc');
    await store.deleteAccount('missing');
    expect(await store.getAccount('acc')).toBeUndefined();
    await store.createAccount({
      id: 'other',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect((await store.getAccount('other'))?.id).toBe('other');
  });

  it('evicts an expired passkey challenge on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyChallenge({
      id: 'old',
      type: 'authenticate',
      challenge: 'c',
      accountId: null,
      consumed: false,
      createdAt: T0,
    });
    await store.createPasskeyChallenge({
      id: 'new',
      type: 'authenticate',
      challenge: 'c',
      accountId: null,
      consumed: false,
      createdAt: T0 + CHALLENGE_TTL_MS + 1,
    });
    expect(await store.getPasskeyChallenge('old')).toBeUndefined();
    expect((await store.getPasskeyChallenge('new'))?.id).toBe('new');
  });

  it('keeps a still-valid passkey challenge on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyChallenge({
      id: 'a',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: T0,
    });
    await store.createPasskeyChallenge({
      id: 'b',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: T0 + 1000,
    });
    expect((await store.getPasskeyChallenge('a'))?.id).toBe('a');
  });

  it('returns false when updating a missing or consumed passkey challenge', async () => {
    const store = new InMemoryAuthStore();
    expect(
      await store.updatePasskeyChallenge({
        id: 'missing',
        type: 'register',
        challenge: 'c',
        accountId: 'acc',
        consumed: true,
        createdAt: T0,
      }),
    ).toBe(false);
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: T0,
    });
    expect(
      await store.updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: 'acc',
        consumed: true,
        createdAt: T0,
      }),
    ).toBe(true);
    expect(
      await store.updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: 'acc',
        consumed: true,
        createdAt: T0,
      }),
    ).toBe(false);
  });

  it('evicts an expired passkey challenge on a later create', async () => {
    const store = new InMemoryAuthStore();
    await store.createPasskeyChallenge({
      id: 'old',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: T0,
    });
    await store.createPasskeyChallenge({
      id: 'new',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: T0 + CHALLENGE_TTL_MS + 1,
    });
    expect(await store.getPasskeyChallenge('old')).toBeUndefined();
    expect((await store.getPasskeyChallenge('new'))?.id).toBe('new');
  });

  it('stores Nostr keys only if absent', async () => {
    const store = new InMemoryAuthStore();
    const record = {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array([1, 2, 3]),
      kekId: 1,
      custody: 'custodial' as const,
    };
    expect(await store.setNostrKeyIfAbsent('missing', record)).toBe('exists');
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
    });
    expect(await store.listAccountIdsWithoutNostrKey(10)).toEqual(['acc']);
    expect(await store.setNostrKeyIfAbsent('acc', record)).toBe('inserted');
    expect(await store.getNostrPublicKey('acc')).toBe(record.pubkey);
    expect(await store.getNostrSecret('acc')).toEqual(record.ciphertext);
    expect(await store.setNostrKeyIfAbsent('acc', record)).toBe('exists');
    expect(await store.listAccountIdsWithoutNostrKey(10)).toEqual([]);
    await store.deleteAccount('acc');
    expect(await store.getNostrPublicKey('acc')).toBeUndefined();
  });
});
