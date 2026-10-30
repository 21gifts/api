import { describe, it, expect } from 'vitest';
import {
  compareAccountsForList,
  InMemoryAuthStore,
  parseAmountUnit,
  parseStoredFiat,
  parseStoredLocale,
  staffTagOf,
  type PasskeyChallenge,
  type PasskeyCredential,
  type PendingRecovery,
} from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import { InMemoryPushStore } from '@/lib/push-store';
import { encodeSparkAddress } from '@/lib/spark-address';

const KEY = `02${'a'.repeat(64)}`;
const T0 = 1_000_000;

describe('parseAmountUnit', () => {
  it('returns exact btc and fiat and fail-opens everything else to btc', () => {
    expect(parseAmountUnit('btc')).toBe('btc');
    expect(parseAmountUnit('fiat')).toBe('fiat');
    expect(parseAmountUnit('sats')).toBe('btc');
    expect(parseAmountUnit(null)).toBe('btc');
  });
});

describe('parseStoredLocale', () => {
  it('returns exact en, de, es, and fil and maps everything else to null', () => {
    expect(parseStoredLocale('en')).toBe('en');
    expect(parseStoredLocale('de')).toBe('de');
    expect(parseStoredLocale('es')).toBe('es');
    expect(parseStoredLocale('fil')).toBe('fil');
    expect(parseStoredLocale('fr')).toBeNull();
    expect(parseStoredLocale('EN')).toBeNull();
    expect(parseStoredLocale(null)).toBeNull();
    expect(parseStoredLocale(undefined)).toBeNull();
    expect(parseStoredLocale(1)).toBeNull();
  });
});

describe('parseStoredFiat', () => {
  it('returns exact CHF, EUR, USD, and PHP and maps everything else to null', () => {
    expect(parseStoredFiat('CHF')).toBe('CHF');
    expect(parseStoredFiat('EUR')).toBe('EUR');
    expect(parseStoredFiat('USD')).toBe('USD');
    expect(parseStoredFiat('PHP')).toBe('PHP');
    expect(parseStoredFiat('GBP')).toBeNull();
    expect(parseStoredFiat('chf')).toBeNull();
    expect(parseStoredFiat(null)).toBeNull();
    expect(parseStoredFiat(undefined)).toBeNull();
    expect(parseStoredFiat(1)).toBeNull();
  });
});

describe('staffTagOf', () => {
  it('returns software_developer only for that exact string', () => {
    expect(staffTagOf('software_developer')).toBe('software_developer');
    expect(staffTagOf(undefined)).toBeNull();
    expect(staffTagOf(null)).toBeNull();
    expect(staffTagOf('')).toBeNull();
    expect(staffTagOf('basis')).toBeNull();
  });
});

describe('InMemoryAuthStore', () => {
  it('ignores a second createAccount with the same linkingKey', async () => {
    const store = new InMemoryAuthStore();
    const first = {
      id: 'acc-1',
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    };
    await store.createAccount(first);
    await store.createAccount({ ...first, id: 'acc-2', createdAt: 2, viewKey: 'b'.repeat(64) });
    expect((await store.getAccount('acc-1'))?.id).toBe('acc-1');
    expect(await store.getAccount('acc-2')).toBeUndefined();
    expect((await store.listAccounts()).map((row) => row.id)).toEqual(['acc-1']);
  });

  it('getAccounts returns each known account once and skips unknown ids', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      createdAt: 1,
      rulesAgreedAt: null,
    };
    await store.createAccount({ ...base, id: 'acc-a', viewKey: 'a'.repeat(64) });
    await store.createAccount({ ...base, id: 'acc-b', viewKey: 'b'.repeat(64) });
    const found = await store.getAccounts(['acc-b', 'acc-gone', 'acc-a', 'acc-b']);
    expect(found.map((row) => row.id)).toEqual(['acc-b', 'acc-a']);
    expect(await store.getAccounts([])).toEqual([]);
  });

  it('stores an account and finds it by id and by linkingKey', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
  });

  it('persists walletRequired and walletBackupSeenAt on create and update', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: true,
      walletBackupSeenAt: null,
    });
    expect((await store.getAccount('acc'))?.walletRequired).toBe(true);
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBeNull();
    expect((await store.markWalletBackupSeen('acc', 42))?.account.walletBackupSeenAt).toBe(42);
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: false,
      walletBackupSeenAt: null,
    });
    expect((await store.getAccount('acc'))?.walletRequired).toBe(true);
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBe(42);
  });

  it('round-trips forumLawsDismissed false and true', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-false',
      linkingKey: `02${'e'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.getAccount('acc-false'))?.forumLawsDismissed).toBe(false);
    await store.createAccount({
      id: 'acc-true',
      linkingKey: `02${'f'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: true,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    expect((await store.getAccount('acc-true'))?.forumLawsDismissed).toBe(true);
    await store.updateAccount({
      id: 'acc-false',
      linkingKey: `02${'e'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: true,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.getAccount('acc-false'))?.forumLawsDismissed).toBe(true);
  });

  it('clears any other isPlatform flag when setting a new platform account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'plat-1',
      linkingKey: null,
      role: 'founder',
      name: 'One',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    await store.createAccount({
      id: 'plat-2',
      linkingKey: null,
      role: 'founder',
      name: 'Two',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'f'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    expect((await store.getAccount('plat-1'))?.isPlatform).toBe(false);
    expect((await store.getAccount('plat-2'))?.isPlatform).toBe(true);
    const first = await store.getAccount('plat-1');
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error('expected account');
    }
    await store.updateAccount({ ...first, isPlatform: true });
    expect((await store.getAccount('plat-1'))?.isPlatform).toBe(true);
    expect((await store.getAccount('plat-2'))?.isPlatform).toBe(false);
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'a',
      linkingKey: `02${'c'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const listed = await store.listAccounts();
    expect(listed.map((row) => row.id)).toEqual(['a', 'b']);
    await store.createAccount({
      id: 'c',
      linkingKey: `02${'d'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.listAccounts()).map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('compareAccountsForList orders by createdAt then id, including equality', () => {
    const base = {
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      rulesAgreedAt: null,
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

  it('deleteAllSessions removes every session and returns the count', async () => {
    const store = new InMemoryAuthStore();
    await store.createSession({ token: 'a', accountId: 'acc', createdAt: 1 });
    await store.createSession({ token: 'b', accountId: 'other', createdAt: 1 });
    expect(await store.deleteAllSessions()).toBe(2);
    expect(await store.getSession('a')).toBeUndefined();
    expect(await store.listSessions()).toEqual([]);
    expect(await store.deleteAllSessions()).toBe(0);
  });

  it('tryCreateSession writes only when the account is not refused', async () => {
    const store = new InMemoryAuthStore();
    const account = {
      id: 'acc',
      linkingKey: KEY,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    };
    expect(await store.tryCreateSession({ token: 'missing', accountId: 'acc', createdAt: 1 })).toBe(
      false,
    );
    expect(await store.getSession('missing')).toBeUndefined();
    await store.createAccount(account);
    expect(await store.tryCreateSession({ token: 'ok', accountId: 'acc', createdAt: 1 })).toBe(
      true,
    );
    expect((await store.getSession('ok'))?.accountId).toBe('acc');
    await store.setSessionRefused('acc', true);
    expect(await store.tryCreateSession({ token: 'refused', accountId: 'acc', createdAt: 1 })).toBe(
      false,
    );
    expect(await store.getSession('refused')).toBeUndefined();
  });

  it('setSessionRefused writes only that flag', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.setSessionRefused('missing', true)).toBeUndefined();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const updated = await store.setSessionRefused('acc', true);
    expect(updated?.sessionRefused).toBe(true);
    expect(updated?.name).toBe('Ada');
    const nameOnly = { ...(await store.getAccount('acc'))!, name: 'Bob' };
    delete (nameOnly as { sessionRefused?: boolean }).sessionRefused;
    await store.updateAccount(nameOnly);
    expect((await store.getAccount('acc'))?.sessionRefused).toBe(true);
    expect((await store.getAccount('acc'))?.name).toBe('Bob');
    await store.updateAccount({ ...(await store.getAccount('acc'))!, sessionRefused: false });
    expect((await store.getAccount('acc'))?.sessionRefused).toBe(true);
    expect((await store.setSessionRefused('acc', false))?.sessionRefused).toBe(false);
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

  it('stores two passkey accounts without clobbering the linkingKey index', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'p1',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: '1'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'p2',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: '2'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'ln',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: '3'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.getAccount('p1'))?.id).toBe('p1');
    expect((await store.getAccount('p2'))?.id).toBe('p2');
    expect((await store.getAccount('ln'))?.id).toBe('ln');
  });

  it('drops the linkingKey index when updateAccount clears it', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'pk',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'pk',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect((await store.getAccountByViewKey(viewKey))?.id).toBe('acc');
    expect(await store.getAccountByViewKey('0'.repeat(64))).toBeUndefined();
  });

  it('looks up an account by nostr pubkey case-insensitively', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      location: null,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.setNostrKeyIfAbsent('acc', {
      pubkey: 'ab'.repeat(32),
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    expect((await store.getAccountByPubkey('AB'.repeat(32)))?.id).toBe('acc');
    expect(await store.getAccountByPubkey('cd'.repeat(32))).toBeUndefined();
    expect(await store.getAccountByPubkey('')).toBeUndefined();
  });

  it('refuses createAccount and updateAccount when the username is taken', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      name: 'Ada',
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'a',
      username: 'ada',
      viewKey: 'a'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'b',
      name: 'Bob',
      username: '  Ada  ',
      viewKey: 'b'.repeat(64),
    });
    expect(await store.getAccount('b')).toBeUndefined();
    await store.createAccount({
      ...base,
      id: 'c',
      name: 'Cara',
      username: 'cara',
      viewKey: 'c'.repeat(64),
    });
    expect((await store.getAccountByUsername('cara'))?.id).toBe('c');
    await store.updateAccount({
      ...(await store.getAccount('c'))!,
      username: 'ada',
    });
    expect((await store.getAccount('c'))?.username).toBe('cara');
    expect(await store.getAccountByUsername('   ')).toBeUndefined();
    await store.updateAccount({
      ...(await store.getAccount('c'))!,
      username: '   ',
    });
    expect((await store.getAccountByUsername('cara'))?.id).toBe('c');
  });

  it('skips blank usernames on lookup and does not fill a blank one with a taken name', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null,
      role: 'basis' as const,
      name: 'Ada',
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({ ...base, id: 'blank', username: '   ', viewKey: 'd'.repeat(64) });
    await store.createAccount({ ...base, id: 'ada', username: 'ada', viewKey: 'e'.repeat(64) });
    expect((await store.getAccountByUsername('ada'))?.id).toBe('ada');
    await store.updateAccount({ ...(await store.getAccount('blank'))!, username: 'ada' });
    expect((await store.getAccount('blank'))?.username).toBe('   ');
  });

  it('listAccountsByUsernamePrefix skips null, undefined, and blank usernames', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      name: 'Ada' as string | null,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'undef',
      viewKey: '1'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'nully',
      username: null,
      viewKey: '2'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'blank',
      username: '   ',
      viewKey: '3'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'zed',
      username: 'zed',
      viewKey: '4'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('', 20)).toEqual([
      { id: 'zed', username: 'zed', name: 'Ada' },
    ]);
  });

  it('listAccountsByUsernamePrefix matches a prefix and misses others', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      name: 'Ada' as string | null,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'ada',
      username: 'Ada',
      viewKey: '1'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'bob',
      name: 'Bob',
      username: 'bob',
      viewKey: '2'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('ad', 20)).toEqual([
      { id: 'ada', username: 'Ada', name: 'Ada' },
    ]);
    expect(await store.listAccountsByUsernamePrefix('zz', 20)).toEqual([]);
    expect(await store.listAccountsByUsernamePrefix('', 20)).toEqual([
      { id: 'ada', username: 'Ada', name: 'Ada' },
      { id: 'bob', username: 'bob', name: 'Bob' },
    ]);
  });

  it('listAccountsByUsernamePrefix maps blank names and keeps a padded display name', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'n',
      name: null,
      username: 'cara',
      viewKey: '1'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'b',
      name: '   ',
      username: 'cara2',
      viewKey: '2'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'p',
      name: '  Ada Lovelace  ',
      username: 'Ada',
      viewKey: '3'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('', 20)).toEqual([
      { id: 'p', username: 'Ada', name: 'Ada Lovelace' },
      { id: 'n', username: 'cara', name: 'cara' },
      { id: 'b', username: 'cara2', name: 'cara2' },
    ]);
  });

  it('listAccountsByUsernamePrefix orders by username then id and slices after sort', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      name: 'Ada' as string | null,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'a',
      username: 'zed',
      createdAt: 1,
      viewKey: '1'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'z',
      username: 'ada',
      createdAt: 2,
      viewKey: '2'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'm',
      username: 'mia',
      createdAt: 3,
      viewKey: '3'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('', 20)).toEqual([
      { id: 'z', username: 'ada', name: 'Ada' },
      { id: 'm', username: 'mia', name: 'Ada' },
      { id: 'a', username: 'zed', name: 'Ada' },
    ]);
    expect(await store.listAccountsByUsernamePrefix('', 2)).toEqual([
      { id: 'z', username: 'ada', name: 'Ada' },
      { id: 'm', username: 'mia', name: 'Ada' },
    ]);
  });

  it('listAccountsByUsernamePrefix treats underscore as a literal', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      name: 'Ada' as string | null,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'axb',
      username: 'axb',
      viewKey: '1'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'a_b',
      username: 'a_b',
      viewKey: '2'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('a_', 20)).toEqual([
      { id: 'a_b', username: 'a_b', name: 'Ada' },
    ]);
  });

  it('listAccountsByUsernamePrefix matches a username segment or display-name word', async () => {
    const store = new InMemoryAuthStore();
    const base = {
      linkingKey: null as string | null,
      role: 'basis' as const,
      location: null as string | null,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null as number | null,
    };
    await store.createAccount({
      ...base,
      id: 'abbot',
      username: 'abbot',
      name: 'Pater Severin',
      viewKey: 'a'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'padre',
      username: 'padre',
      name: 'Reserve',
      viewKey: 'b'.repeat(64),
    });
    await store.createAccount({
      ...base,
      id: 'pater',
      username: 'pater-severin',
      name: 'Pater Severin',
      viewKey: 'c'.repeat(64),
    });
    expect(await store.listAccountsByUsernamePrefix('sev', 20)).toEqual([
      { id: 'abbot', username: 'abbot', name: 'Pater Severin' },
      { id: 'pater', username: 'pater-severin', name: 'Pater Severin' },
    ]);
  });

  it('reports whether an account has a passkey credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.accountHasPasskey('acc')).toBe(false);
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(await store.accountHasPasskey('acc')).toBe(true);
  });

  it('refuses a second passkey credential for the same account', async () => {
    const store = new InMemoryAuthStore();
    const first = {
      credentialId: 'cred-a',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    };
    expect(await store.createPasskeyCredential(first)).toBe(true);
    expect(
      await store.createPasskeyCredential({
        ...first,
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
      }),
    ).toBe(false);
  });

  it('looks up and replaces the account passkey credential', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.getPasskeyCredentialForAccount('acc')).toBeUndefined();
    expect(
      await store.replacePasskeyCredential({
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(false);
    const first = {
      credentialId: 'cred-a',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    };
    expect(await store.createPasskeyCredential(first)).toBe(true);
    expect((await store.getPasskeyCredentialForAccount('acc'))?.credentialId).toBe('cred-a');
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-other',
        publicKey: new Uint8Array([9]),
        signCount: 0,
        accountId: 'other',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.replacePasskeyCredential({
        credentialId: 'cred-other',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(false);
    expect((await store.getPasskeyCredential('cred-a'))?.accountId).toBe('acc');
    expect(
      await store.replacePasskeyCredential({
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(true);
    expect(await store.getPasskeyCredential('cred-a')).toBeUndefined();
    expect(await store.getPasskeyCredentialForAccount('acc')).toEqual({
      credentialId: 'cred-b',
      publicKey: new Uint8Array([2]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 2,
    });
  });

  it('keeps one passkey when two replaces run together', async () => {
    const store = new InMemoryAuthStore();
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    const [first, second] = await Promise.all([
      store.replacePasskeyCredential({
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
      store.replacePasskeyCredential({
        credentialId: 'cred-c',
        publicKey: new Uint8Array([3]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 3,
      }),
    ]);
    expect(first || second).toBe(true);
    const remaining = [
      await store.getPasskeyCredential('cred-a'),
      await store.getPasskeyCredential('cred-b'),
      await store.getPasskeyCredential('cred-c'),
    ].filter((row) => row !== undefined);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.accountId).toBe('acc');
  });

  it('refuses a second first-passkey for the same account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const first = {
      credentialId: 'cred-a',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    };
    expect(await store.createFirstPasskeyCredential(first)).toBe(true);
    expect(
      await store.createFirstPasskeyCredential({
        ...first,
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential returns false when the account is missing', async () => {
    const store = new InMemoryAuthStore();
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    expect(await store.getPasskeyCredential('cred-a')).toBeUndefined();
  });

  it('createFirstPasskeyCredential returns false when the account is refused', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential sets walletRequired and refuses a taken credential id', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-a',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'acc-b',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-shared',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc-a',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getAccount('acc-a'))?.walletRequired).toBe(true);
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-shared',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc-b',
        createdAt: 2,
      }),
    ).toBe(false);
  });

  it('addSeedPasskeyCredential inserts a second credential and sets walletRequired', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      walletBackupSeenAt: 9,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(true);
    expect((await store.getAccount('acc'))?.walletRequired).toBe(true);
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBe(9);
    expect((await store.getPasskeyCredential('cred-a'))?.accountId).toBe('acc');
    expect((await store.getPasskeyCredential('cred-b'))?.accountId).toBe('acc');
    expect((await store.getPasskeyCredentialForAccount('acc'))?.credentialId).toBe('cred-b');
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-c',
        publicKey: new Uint8Array([3]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 3,
      }),
    ).toBe(false);
  });

  it('addSeedPasskeyCredential refuses missing, refused, flagged, and taken ids', async () => {
    const store = new InMemoryAuthStore();
    const seed = {
      credentialId: 'cred-b',
      publicKey: new Uint8Array([2]),
      signCount: 0,
      accountId: 'missing',
      createdAt: 2,
    };
    expect(await store.addSeedPasskeyCredential(seed)).toBe(false);
    await store.createAccount({
      id: 'refused',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    expect(await store.addSeedPasskeyCredential({ ...seed, accountId: 'refused' })).toBe(false);
    await store.createAccount({
      id: 'flagged',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      walletRequired: true,
    });
    expect(await store.addSeedPasskeyCredential({ ...seed, accountId: 'flagged' })).toBe(false);
    await store.createAccount({
      id: 'acc-a',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'acc-b',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 4,
      rulesAgreedAt: null,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-shared',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc-a',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-shared',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc-b',
        createdAt: 2,
      }),
    ).toBe(false);
    expect(await store.getPasskeyCredentialForAccount('acc-b')).toBeUndefined();
    expect((await store.getAccount('acc-b'))?.walletRequired === true).toBe(false);
  });

  it('getPasskeyCredentialForAccount prefers a later createdAt', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-b',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(true);
    expect((await store.getPasskeyCredentialForAccount('acc'))?.credentialId).toBe('cred-b');
  });

  it('getPasskeyCredentialForAccount does not let an older createdAt replace a newer row', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-new',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(true);
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-old',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getPasskeyCredentialForAccount('acc'))?.credentialId).toBe('cred-new');
  });

  it('getPasskeyCredentialForAccount breaks createdAt ties by credentialId descending', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc-high',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc-high',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-z',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc-high',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await store.getPasskeyCredentialForAccount('acc-high'))?.credentialId).toBe('cred-z');
    const lower = new InMemoryAuthStore();
    await lower.createAccount({
      id: 'acc-low',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(
      await lower.createPasskeyCredential({
        credentialId: 'cred-z',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc-low',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await lower.addSeedPasskeyCredential({
        credentialId: 'cred-a',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc-low',
        createdAt: 1,
      }),
    ).toBe(true);
    expect((await lower.getPasskeyCredentialForAccount('acc-low'))?.credentialId).toBe('cred-z');
  });

  it('markWalletBackupSeen sets only the timestamp', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const first = await store.markWalletBackupSeen('acc', 9);
    expect(first?.wrote).toBe(true);
    expect(first?.account.walletBackupSeenAt).toBe(9);
    expect(first?.account.name).toBe('Ada');
    const second = await store.markWalletBackupSeen('acc', 10);
    expect(second?.wrote).toBe(false);
    expect(second?.account.walletBackupSeenAt).toBe(9);
    expect(await store.markWalletBackupSeen('missing', 1)).toBeUndefined();
    await store.updateAccount({ ...first!.account, name: 'Grace', walletBackupSeenAt: null });
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBe(9);
    expect((await store.getAccount('acc'))?.name).toBe('Grace');
  });

  it('tracks unacknowledged failed passkey renew rows per account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'other',
      linkingKey: `03${'b'.repeat(64)}`,
      role: 'basis',
      name: 'Bob',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const base = {
      createdAt: 1,
      stage: 'ceremony' as const,
      errorName: null,
      errorCode: null,
      httpStatus: 400,
      message: 'seed failed',
      userAgent: null,
    };
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(false);
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 's1',
      accountId: 'acc',
      outcome: 'succeeded',
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'c1',
      accountId: 'acc',
      outcome: 'cancelled',
    });
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(false);
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'f1',
      accountId: 'acc',
      outcome: 'failed',
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'f2',
      accountId: 'other',
      outcome: 'failed',
    });
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(true);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('other')).toBe(true);
    expect((await store.getAccount('acc'))?.walletRequired === true).toBe(false);
    await store.acknowledgePasskeyRenewFailures('acc', 9);
    await store.acknowledgePasskeyRenewFailures('acc', 10);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(false);
    expect(await store.hasAcknowledgedPasskeyRenewFailure('acc')).toBe(true);
    expect(await store.hasAcknowledgedPasskeyRenewFailure('other')).toBe(false);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('other')).toBe(true);
    expect((await store.getAccount('acc'))?.walletRequired === true).toBe(false);
    expect(await store.deleteFailedPasskeyRenewAttempts('acc')).toBe(1);
    expect(await store.hasAcknowledgedPasskeyRenewFailure('acc')).toBe(false);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('other')).toBe(true);
    expect(await store.deleteFailedPasskeyRenewAttempts('missing')).toBe(0);
  });

  it('uses the later id when two unacknowledged failures share a time', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const base = {
      accountId: 'acc',
      createdAt: 5,
      stage: 'ceremony' as const,
      outcome: 'failed' as const,
      errorCode: null,
      httpStatus: null,
      message: 'seed failed',
      userAgent: null,
    };
    await store.insertPasskeyRenewAttempt({ ...base, id: 'b', errorName: 'kept' });
    await store.insertPasskeyRenewAttempt({ ...base, id: 'a', errorName: 'older-id' });
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('acc')).toBe('kept');
    await store.insertPasskeyRenewAttempt({ ...base, id: 'c', errorName: 'wins' });
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('acc')).toBe('wins');
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('missing')).toBeNull();
  });

  it('createAccount stores locale and fiat null even when the argument includes them', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      locale: 'de',
      fiat: 'EUR',
    });
    expect((await store.getAccount('acc'))?.locale).toBeNull();
    expect((await store.getAccount('acc'))?.fiat).toBeNull();
  });

  it('setAccountLocale writes onlyIfUnset and unconditional values', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.setAccountLocale('missing', 'en', false)).toBeUndefined();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const first = await store.setAccountLocale('acc', 'en', true);
    expect(first?.wrote).toBe(true);
    expect(first?.account.locale).toBe('en');
    const skipped = await store.setAccountLocale('acc', 'de', true);
    expect(skipped?.wrote).toBe(false);
    expect(skipped?.account.locale).toBe('en');
    const replaced = await store.setAccountLocale('acc', 'de', false);
    expect(replaced?.wrote).toBe(true);
    expect(replaced?.account.locale).toBe('de');
    const same = await store.setAccountLocale('acc', 'de', false);
    expect(same?.wrote).toBe(true);
    expect(same?.account.locale).toBe('de');
    const late = await store.setAccountLocale('acc', 'es', true);
    expect(late?.wrote).toBe(false);
    expect(late?.account.locale).toBe('de');
    const stored = await store.getAccount('acc');
    delete stored!.locale;
    const fromUnset = await store.setAccountLocale('acc', 'fil', true);
    expect(fromUnset?.wrote).toBe(true);
    expect(fromUnset?.account.locale).toBe('fil');
  });

  it('setAccountFiat writes onlyIfUnset and unconditional values', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.setAccountFiat('missing', 'CHF', false)).toBeUndefined();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const first = await store.setAccountFiat('acc', 'CHF', true);
    expect(first?.wrote).toBe(true);
    expect(first?.account.fiat).toBe('CHF');
    const skipped = await store.setAccountFiat('acc', 'EUR', true);
    expect(skipped?.wrote).toBe(false);
    expect(skipped?.account.fiat).toBe('CHF');
    const replaced = await store.setAccountFiat('acc', 'EUR', false);
    expect(replaced?.wrote).toBe(true);
    expect(replaced?.account.fiat).toBe('EUR');
    const same = await store.setAccountFiat('acc', 'EUR', false);
    expect(same?.wrote).toBe(true);
    expect(same?.account.fiat).toBe('EUR');
    const late = await store.setAccountFiat('acc', 'USD', true);
    expect(late?.wrote).toBe(false);
    expect(late?.account.fiat).toBe('EUR');
    const stored = await store.getAccount('acc');
    delete stored!.fiat;
    const fromUnset = await store.setAccountFiat('acc', 'PHP', true);
    expect(fromUnset?.wrote).toBe(true);
    expect(fromUnset?.account.fiat).toBe('PHP');
  });

  it('updateAccount preserves locale and fiat from the previous row', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.setAccountLocale('acc', 'de', false);
    await store.setAccountFiat('acc', 'EUR', false);
    const current = await store.getAccount('acc');
    await store.updateAccount({
      ...current!,
      name: 'Grace',
      locale: 'en',
      fiat: 'USD',
    });
    expect((await store.getAccount('acc'))?.name).toBe('Grace');
    expect((await store.getAccount('acc'))?.locale).toBe('de');
    expect((await store.getAccount('acc'))?.fiat).toBe('EUR');
  });

  it('updateAccount of an unknown id stores locale null and fiat null', async () => {
    const store = new InMemoryAuthStore();
    await store.updateAccount({
      id: 'never',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      locale: 'es',
      fiat: 'PHP',
    });
    expect((await store.getAccount('never'))?.locale).toBeNull();
    expect((await store.getAccount('never'))?.fiat).toBeNull();
  });

  it('updateAccount leaves unset locale and fiat null', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const current = await store.getAccount('acc');
    await store.updateAccount({ ...current!, name: 'Grace', locale: 'en', fiat: 'USD' });
    expect((await store.getAccount('acc'))?.name).toBe('Grace');
    expect((await store.getAccount('acc'))?.locale).toBeNull();
    expect((await store.getAccount('acc'))?.fiat).toBeNull();
  });

  it('ignores a second createAccount with the same viewKey', async () => {
    const store = new InMemoryAuthStore();
    const viewKey = 'e'.repeat(64);
    await store.createAccount({
      id: 'acc-1',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey,
      createdAt: 2,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: oldKey,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: newKey,
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: '1'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: '2'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.updateAccount({
      id: 'acc-2',
      linkingKey: null,
      role: 'basis',
      name: 'stolen',
      forumLawsDismissed: false,
      location: null,
      viewKey: '1'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.deleteAccount('acc');
    expect(await store.getAccountByViewKey(viewKey)).toBeUndefined();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey,
      createdAt: 2,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.deleteAccount('acc');
    await store.deleteAccount('missing');
    expect(await store.getAccount('acc')).toBeUndefined();
    await store.createAccount({
      id: 'other',
      linkingKey: KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
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

  it('listNostrKeys returns defaults when createAccount did not store a key', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const rows = await store.listNostrKeys();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe('acc');
    expect(rows[0]?.record.pubkey).toBeNull();
    expect(rows[0]?.record.ciphertext).toEqual(new Uint8Array());
    expect(rows[0]?.record.kekId).toBe(1);
    expect(rows[0]?.record.custody).toBe('custodial');
    expect(rows[0]?.createdAt).toBeNull();
  });

  it('listNostrKeys copies a stored key and defaults an account without one', async () => {
    const store = new InMemoryAuthStore();
    const record = {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array([1, 2, 3]),
      kekId: 1,
      custody: 'custodial' as const,
    };
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.setNostrKeyIfAbsent('acc', record)).toBe('inserted');
    const withKey = await store.listNostrKeys();
    expect(withKey).toHaveLength(1);
    expect(withKey[0]?.accountId).toBe('acc');
    expect(withKey[0]?.record.pubkey).toBe(record.pubkey);
    expect(withKey[0]?.record.ciphertext).toEqual(record.ciphertext);
    expect(withKey[0]?.record.kekId).toBe(1);
    expect(withKey[0]?.record.custody).toBe('custodial');
    expect(withKey[0]?.createdAt).toBeNull();
    await store.createAccount({
      id: 'acc2',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    const mixed = await store.listNostrKeys();
    expect(mixed).toHaveLength(2);
    const stored = mixed.find((row) => row.accountId === 'acc');
    const missing = mixed.find((row) => row.accountId === 'acc2');
    expect(stored?.record.pubkey).toBe(record.pubkey);
    expect(stored?.record.ciphertext).toEqual(record.ciphertext);
    expect(stored?.record.kekId).toBe(1);
    expect(stored?.record.custody).toBe('custodial');
    expect(missing?.record.pubkey).toBeNull();
    expect(missing?.record.ciphertext).toEqual(new Uint8Array());
    expect(missing?.record.kekId).toBe(1);
    expect(missing?.record.custody).toBe('custodial');
    expect(missing?.createdAt).toBeNull();
  });

  it('listStaffAccountIds returns founder and moderator ids', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'founder-1',
      linkingKey: null,
      role: 'founder',
      name: 'Founder',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'mod-1',
      linkingKey: null,
      role: 'moderator',
      name: 'Mod',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'initiator-1',
      linkingKey: null,
      role: 'initiator',
      name: 'Initiator',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'basis-1',
      linkingKey: null,
      role: 'basis',
      name: 'Basis',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'verified-1',
      linkingKey: null,
      role: 'verified',
      name: 'Verified',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 4,
      rulesAgreedAt: null,
    });
    const ids = await store.listStaffAccountIds();
    expect(ids.sort()).toEqual(['founder-1', 'initiator-1', 'mod-1']);
  });

  it('listIdsByPrefix returns [] when empty', async () => {
    expect(await new InMemoryAuthStore().listIdsByPrefix('d70c4763')).toEqual([]);
  });

  it('listIdsByPrefix matches a mixed-case stored id against a lowercase prefix', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'D70C4763-3033-43da-817a-2c7de9938f27',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.listIdsByPrefix('d70c4763')).toEqual([
      'D70C4763-3033-43da-817a-2c7de9938f27',
    ]);
  });

  it('listIdsByPrefix matches a lowercase stored id against an uppercase prefix', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'd70c4763-3033-43da-817a-2c7de9938f27',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.listIdsByPrefix('D70C4763')).toEqual([
      'd70c4763-3033-43da-817a-2c7de9938f27',
    ]);
  });

  it('listIdsByPrefix matches a non-UUID id', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'd70c4763not-a-uuid',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.listIdsByPrefix('d70c4763')).toEqual(['d70c4763not-a-uuid']);
  });

  it('listIdsByPrefix does not match a different prefix', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'd70c4763-3033-43da-817a-2c7de9938f27',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.listIdsByPrefix('ffffffff')).toEqual([]);
  });

  it('listIdsByPrefix stops at two matches', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'd70c4763-1',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'd70c4763-2',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'd70c4763-3',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    const ids = await store.listIdsByPrefix('d70c4763');
    const allowed = ['d70c4763-1', 'd70c4763-2', 'd70c4763-3'];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => allowed.includes(id))).toBe(true);
  });

  it('claimProfileMessageId sets the pointer only when it still matches', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.claimProfileMessageId('missing', null, 'note-1')).toBe(false);
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(await store.claimProfileMessageId('acc', null, 'note-1')).toBe(true);
    expect((await store.getAccount('acc'))?.profileMessageId).toBe('note-1');
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
    expect((await store.getAccountByViewKey('a'.repeat(64)))?.id).toBe('acc');
    expect(await store.claimProfileMessageId('acc', null, 'note-2')).toBe(false);
    expect((await store.getAccount('acc'))?.profileMessageId).toBe('note-1');
    expect(await store.claimProfileMessageId('acc', 'note-1', 'note-3')).toBe(true);
    expect((await store.getAccount('acc'))?.profileMessageId).toBe('note-3');
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
  });
});

describe('InMemoryAuthStore spark pubkey', () => {
  const PUBKEY = `02${'a'.repeat(64)}`;
  const OTHER_KEY = `03${'b'.repeat(64)}`;

  async function walletAccount(
    store: InMemoryAuthStore,
    id: string,
    opts: { username?: string | null; walletRequired?: boolean; viewKey?: string } = {},
  ) {
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: opts.username === undefined ? 'ada' : opts.username,
      forumLawsDismissed: false,
      location: null,
      viewKey: opts.viewKey ?? `${id.replace(/-/g, '').padEnd(64, 'a').slice(0, 64)}`,
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: opts.walletRequired ?? true,
    });
  }

  it('createAccount ignores wallet fields from the input', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: KEY,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: true,
      sparkPubkey: PUBKEY,
      sparkPubkeyVerifiedAt: 99,
    });
    const stored = await store.getAccount('acc');
    expect(stored?.sparkPubkey).toBeNull();
    expect(stored?.sparkPubkeyVerifiedAt).toBeNull();
  });

  it('claimSparkPubkey writes while unverified and overwrites', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc');
    const first = await store.claimSparkPubkey('acc', PUBKEY);
    expect(first?.wrote).toBe(true);
    expect(first?.account.sparkPubkey).toBe(PUBKEY);
    const second = await store.claimSparkPubkey('acc', OTHER_KEY);
    expect(second?.wrote).toBe(true);
    expect(second?.account.sparkPubkey).toBe(OTHER_KEY);
  });

  it('claimSparkPubkey returns wrote false without walletRequired, without username, and once verified', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'no-wallet', {
      walletRequired: false,
      username: 'nowallet',
      viewKey: 'b'.repeat(64),
    });
    expect((await store.claimSparkPubkey('no-wallet', PUBKEY))?.wrote).toBe(false);
    await walletAccount(store, 'no-name', { username: null, viewKey: 'c'.repeat(64) });
    expect((await store.claimSparkPubkey('no-name', PUBKEY))?.wrote).toBe(false);
    await walletAccount(store, 'blank', { username: '  ', viewKey: 'd'.repeat(64) });
    expect((await store.claimSparkPubkey('blank', PUBKEY))?.wrote).toBe(false);
    await walletAccount(store, 'acc', { username: 'carol', viewKey: 'e'.repeat(64) });
    await store.claimSparkPubkey('acc', PUBKEY);
    await store.markSparkPubkeyVerified('acc', PUBKEY, 'carol', 10);
    expect((await store.claimSparkPubkey('acc', OTHER_KEY))?.wrote).toBe(false);
    expect((await store.getAccount('acc'))?.sparkPubkey).toBe(PUBKEY);
  });

  it('claimSparkPubkey returns undefined for an unknown id', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.claimSparkPubkey('missing', PUBKEY)).toBeUndefined();
  });

  it('allows two accounts to hold the same unverified key', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc-1', { username: 'ada', viewKey: 'a'.repeat(64) });
    await walletAccount(store, 'acc-2', { username: 'grace', viewKey: 'b'.repeat(64) });
    expect((await store.claimSparkPubkey('acc-1', PUBKEY))?.wrote).toBe(true);
    expect((await store.claimSparkPubkey('acc-2', PUBKEY))?.wrote).toBe(true);
    expect(await store.isSparkPubkeyClaimed(PUBKEY)).toBe(true);
  });

  it('markSparkPubkeyVerified succeeds exactly once', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc');
    await store.claimSparkPubkey('acc', PUBKEY);
    expect(await store.markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10)).toBe(true);
    expect((await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).toBe(10);
    expect(await store.markSparkPubkeyVerified('acc', PUBKEY, 'ada', 11)).toBe(false);
    expect((await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).toBe(10);
  });

  it('markSparkPubkeyVerified refuses wrong key, wrong username, unknown id, and a key verified by another account', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc-1', { username: 'ada', viewKey: 'a'.repeat(64) });
    await walletAccount(store, 'acc-2', { username: 'grace', viewKey: 'b'.repeat(64) });
    await store.claimSparkPubkey('acc-1', PUBKEY);
    expect(await store.markSparkPubkeyVerified('acc-1', OTHER_KEY, 'ada', 10)).toBe(false);
    expect(await store.markSparkPubkeyVerified('acc-1', PUBKEY, 'wrong', 10)).toBe(false);
    expect(await store.markSparkPubkeyVerified('missing', PUBKEY, 'ada', 10)).toBe(false);
    expect(await store.markSparkPubkeyVerified('acc-1', PUBKEY, 'ada', 10)).toBe(true);
    await store.claimSparkPubkey('acc-2', PUBKEY);
    expect(await store.markSparkPubkeyVerified('acc-2', PUBKEY, 'grace', 11)).toBe(false);
  });

  it('getAccountByVerifiedSparkPubkey and isSparkPubkeyClaimed cover claimed, verified, and unknown keys', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc');
    expect(await store.isSparkPubkeyClaimed(PUBKEY)).toBe(false);
    expect(await store.getAccountByVerifiedSparkPubkey(PUBKEY)).toBeUndefined();
    await store.claimSparkPubkey('acc', PUBKEY);
    expect(await store.isSparkPubkeyClaimed(PUBKEY)).toBe(true);
    expect(await store.getAccountByVerifiedSparkPubkey(PUBKEY)).toBeUndefined();
    await store.markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10);
    expect((await store.getAccountByVerifiedSparkPubkey(PUBKEY))?.id).toBe('acc');
    expect(await store.getAccountByVerifiedSparkPubkey(OTHER_KEY)).toBeUndefined();
    expect(await store.isSparkPubkeyClaimed(OTHER_KEY)).toBe(false);
  });

  it('updateAccount keeps verified username but writes other fields', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc');
    expect(await store.setUsername('acc', 'grace')).toMatchObject({ ok: true });
    expect((await store.getAccount('acc'))?.username).toBe('grace');
    await store.claimSparkPubkey('acc', PUBKEY);
    await store.markSparkPubkeyVerified('acc', PUBKEY, 'grace', 10);
    await walletAccount(store, 'other', { username: 'ada', viewKey: 'b'.repeat(64) });
    const verified = await store.getAccount('acc');
    await store.updateAccount({ ...verified!, username: 'ada', name: 'New' });
    const afterVerified = await store.getAccount('acc');
    expect(afterVerified?.username).toBe('grace');
    expect(afterVerified?.name).toBe('New');
    await walletAccount(store, 'unverified', {
      username: 'bob',
      viewKey: 'c'.repeat(64),
    });
    const unverified = await store.getAccount('unverified');
    await store.updateAccount({ ...unverified!, username: 'carol' });
    expect((await store.getAccount('unverified'))?.username).toBe('bob');
  });

  it('updateAccount never alters the two wallet fields', async () => {
    const store = new InMemoryAuthStore();
    await walletAccount(store, 'acc');
    await store.claimSparkPubkey('acc', PUBKEY);
    await store.markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10);
    const verified = await store.getAccount('acc');
    await store.updateAccount({
      ...verified!,
      sparkPubkey: OTHER_KEY,
      sparkPubkeyVerifiedAt: null,
      name: 'Changed',
    });
    const stored = await store.getAccount('acc');
    expect(stored?.sparkPubkey).toBe(PUBKEY);
    expect(stored?.sparkPubkeyVerifiedAt).toBe(10);
    expect(stored?.name).toBe('Changed');
  });
});

describe('InMemoryAuthStore setUsername', () => {
  const PUBKEY = `02${'a'.repeat(64)}`;

  async function account(
    store: InMemoryAuthStore,
    id: string,
    opts: { username?: string | null; viewKey?: string } = {},
  ): Promise<void> {
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: opts.viewKey ?? `${id.replace(/-/g, '').padEnd(64, 'a').slice(0, 64)}`,
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: true,
      ...(opts.username === undefined ? {} : { username: opts.username }),
    });
  }

  it('returns previous null when no username was set', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc');
    expect(await store.setUsername('acc', 'ada')).toEqual({ ok: true, previous: null });
    expect((await store.getAccount('acc'))?.username).toBe('ada');
  });

  it('returns the previous username and stores the new one', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc', { username: 'ada' });
    expect(await store.setUsername('acc', 'grace')).toEqual({ ok: true, previous: 'ada' });
    expect((await store.getAccount('acc'))?.username).toBe('grace');
  });

  it('keeps a renamed username when a write from an older snapshot arrives', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc', { username: 'ada' });
    const stale = await store.getAccount('acc');
    if (stale === undefined) {
      throw new Error('expected account');
    }
    expect(await store.setUsername('acc', 'grace')).toEqual({ ok: true, previous: 'ada' });
    await store.updateAccount({ ...stale, location: 'Zurich' });
    expect(await store.getAccount('acc')).toMatchObject({ username: 'grace', location: 'Zurich' });
  });

  it('lets updateAccount fill a blank username', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc', { username: '  ' });
    const current = await store.getAccount('acc');
    if (current === undefined) {
      throw new Error('expected account');
    }
    await store.updateAccount({ ...current, username: 'ada' });
    expect((await store.getAccount('acc'))?.username).toBe('ada');
  });

  it('returns frozen when the wallet is verified and leaves the username', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc', { username: 'ada' });
    await store.claimSparkPubkey('acc', PUBKEY);
    await store.markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10);
    expect(await store.setUsername('acc', 'grace')).toEqual({ ok: false, reason: 'frozen' });
    expect((await store.getAccount('acc'))?.username).toBe('ada');
  });

  it('returns taken when another account owns the username', async () => {
    const store = new InMemoryAuthStore();
    await account(store, 'acc', { username: 'ada' });
    await account(store, 'other', { username: 'grace', viewKey: 'b'.repeat(64) });
    expect(await store.setUsername('acc', 'grace')).toEqual({ ok: false, reason: 'taken' });
    expect((await store.getAccount('acc'))?.username).toBe('ada');
  });

  it('returns missing when the account does not exist', async () => {
    const store = new InMemoryAuthStore();
    expect(await store.setUsername('missing', 'ada')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('InMemoryAuthStore social recovery', () => {
  const OLD = `02${'1'.repeat(64)}`;
  const NEW = `03${'2'.repeat(64)}`;
  const THIRD = `02${'3'.repeat(64)}`;
  const NOW = 50_000_000;

  async function recoverable(
    store: InMemoryAuthStore,
    id: string,
    username: string,
    sparkPubkey = OLD,
  ): Promise<void> {
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: null,
      username,
      forumLawsDismissed: false,
      location: null,
      viewKey: `${id}`.padEnd(64, '0').slice(0, 64),
      createdAt: 1,
      rulesAgreedAt: null,
      walletRequired: true,
    });
    await store.claimSparkPubkey(id, sparkPubkey);
    expect(await store.markSparkPubkeyVerified(id, sparkPubkey, username.toLowerCase(), 10)).toBe(
      true,
    );
  }

  function challenge(id: string, accountId: string, createdAt = NOW): PasskeyChallenge {
    return {
      id,
      type: 'recovery',
      challenge: `challenge-${id}`,
      accountId,
      consumed: false,
      createdAt,
    };
  }

  function pending(accountId: string, overrides: Partial<PendingRecovery> = {}): PendingRecovery {
    return {
      accountId,
      oldSparkPubkey: OLD,
      newSparkPubkey: NEW,
      credentialId: 'new-credential',
      publicKey: Uint8Array.of(4, 5, 6),
      signCount: 0,
      createdAt: NOW,
      forwardedAt: null,
      ...overrides,
    };
  }

  /** Begin, finish, and admit one recovery of `accountId`. */
  async function forwarded(
    store: InMemoryAuthStore,
    accountId: string,
    username: string,
    from = OLD,
    to = NEW,
    credentialId = 'new-credential',
  ): Promise<void> {
    const id = `c-${accountId}-${to}`;
    expect(
      await store.startRecoveryChallenge({
        accountId,
        oldSparkPubkey: from,
        challenge: challenge(id, accountId),
        now: NOW,
      }),
    ).toBe('started');
    expect(
      await store.storePendingRecovery({
        challengeId: id,
        pending: pending(accountId, { oldSparkPubkey: from, newSparkPubkey: to, credentialId }),
        now: NOW,
      }),
    ).toBe('stored');
    expect(
      await store.markRecoveryForwarded({
        newSparkPubkey: to,
        oldSparkPubkey: from,
        username,
        now: NOW + 1,
      }),
    ).toBeDefined();
  }

  describe('startRecoveryChallenge', () => {
    it('refuses an unknown account, another key, an unverified key, and a refused account', async () => {
      const store = new InMemoryAuthStore();
      const start = (accountId: string, oldSparkPubkey = OLD) =>
        store.startRecoveryChallenge({
          accountId,
          oldSparkPubkey,
          challenge: challenge(`c-${accountId}`, accountId),
          now: NOW,
        });
      expect(await start('missing')).toBe('changed');
      await recoverable(store, 'acc', 'ada');
      expect(await start('acc', NEW)).toBe('changed');
      await store.createAccount({
        id: 'claimed',
        linkingKey: null,
        role: 'basis',
        name: null,
        username: 'claimed',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'c'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
        walletRequired: true,
      });
      await store.claimSparkPubkey('claimed', THIRD);
      expect(await start('claimed', THIRD)).toBe('changed');
      await store.setSessionRefused('acc', true);
      expect(await start('acc')).toBe('changed');
      expect(await store.getPasskeyChallenge('c-acc')).toBeUndefined();
    });

    it('consumes earlier recovery challenges, drops an unforwarded pending recovery, evicts expired challenges, and stores the new one', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyChallenge({ ...challenge('old-expired', 'acc'), createdAt: 1 });
      await store.createPasskeyChallenge(challenge('first', 'acc'));
      await store.createPasskeyChallenge({ ...challenge('seed', 'acc'), type: 'seed' });
      await store.createPasskeyChallenge(challenge('foreign', 'other'));
      expect(
        await store.storePendingRecovery({
          challengeId: 'first',
          pending: pending('acc'),
          now: NOW,
        }),
      ).toBe('stored');
      await store.createPasskeyChallenge(challenge('second', 'acc'));
      const next = challenge('third', 'acc', NOW + 5);
      expect(
        await store.startRecoveryChallenge({
          accountId: 'acc',
          oldSparkPubkey: OLD,
          challenge: next,
          now: NOW + CHALLENGE_TTL_MS - 1,
        }),
      ).toBe('started');
      expect(await store.getPendingRecovery('acc', NOW)).toBeUndefined();
      expect((await store.getPasskeyChallenge('second'))?.consumed).toBe(true);
      expect((await store.getPasskeyChallenge('first'))?.consumed).toBe(true);
      expect((await store.getPasskeyChallenge('seed'))?.consumed).toBe(false);
      expect((await store.getPasskeyChallenge('foreign'))?.consumed).toBe(false);
      expect(await store.getPasskeyChallenge('old-expired')).toBeUndefined();
      expect(await store.getPasskeyChallenge('third')).toBe(next);
    });

    it('answers forwarded and writes nothing while a forwarded pending recovery remains', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await forwarded(store, 'acc', 'ada');
      await store.createPasskeyChallenge(challenge('open', 'acc'));
      expect(
        await store.startRecoveryChallenge({
          accountId: 'acc',
          oldSparkPubkey: OLD,
          challenge: challenge('next', 'acc'),
          now: NOW + 10 * CHALLENGE_TTL_MS,
        }),
      ).toBe('forwarded');
      expect(await store.getPasskeyChallenge('next')).toBeUndefined();
      expect((await store.getPasskeyChallenge('open'))?.consumed).toBe(false);
      expect(
        (await store.getPendingRecovery('acc', NOW + 10 * CHALLENGE_TTL_MS))?.forwardedAt,
      ).toBe(NOW + 1);
    });
  });

  describe('storePendingRecovery', () => {
    it('refuses an account that left the old key and a missing, foreign, other-type, or expired challenge', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      await store.createPasskeyChallenge(challenge('theirs', 'other'));
      await store.createPasskeyChallenge({ ...challenge('seed', 'acc'), type: 'seed' });
      const store1 = (challengeId: string, now = NOW, value = pending('acc')) =>
        store.storePendingRecovery({ challengeId, pending: value, now });
      expect(await store1('mine', NOW, pending('acc', { oldSparkPubkey: THIRD }))).toBe('changed');
      expect(await store1('missing')).toBe('challenge');
      expect(await store1('theirs')).toBe('challenge');
      expect(await store1('seed')).toBe('challenge');
      expect(await store1('mine', NOW + CHALLENGE_TTL_MS + 1)).toBe('challenge');
      expect(await store1('mine', NOW + CHALLENGE_TTL_MS)).toBe('stored');
    });

    it('stores once, keeps the byte array by reference, consumes the challenge, and answers same for the repeat', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      const value = pending('acc', { forwardedAt: 99 });
      expect(
        await store.storePendingRecovery({ challengeId: 'mine', pending: value, now: NOW }),
      ).toBe('stored');
      expect((await store.getPasskeyChallenge('mine'))?.consumed).toBe(true);
      const stored = await store.getPendingRecovery('acc', NOW);
      expect(stored).toEqual({ ...value, forwardedAt: null });
      expect(stored?.publicKey).toBe(value.publicKey);
      expect(await store.getPendingRecoveryByNewSparkPubkey(NEW, NOW)).toBe(stored);
      expect(await store.getPendingRecoveryByCredentialId('new-credential', NOW)).toBe(stored);
      expect(await store.getPendingRecoveryByNewSparkPubkey(THIRD, NOW)).toBeUndefined();
      expect(await store.getPendingRecoveryByCredentialId('other', NOW)).toBeUndefined();
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc'),
          now: NOW,
        }),
      ).toBe('same');
      expect(await store.getPendingRecovery('acc', NOW)).toBe(stored);
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { credentialId: 'other' }),
          now: NOW,
        }),
      ).toBe('challenge');
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { newSparkPubkey: THIRD }),
          now: NOW,
        }),
      ).toBe('challenge');
      await store.createPasskeyChallenge(challenge('again', 'acc'));
      expect(
        await store.storePendingRecovery({
          challengeId: 'again',
          pending: pending('acc', { credentialId: 'other', newSparkPubkey: THIRD }),
          now: NOW,
        }),
      ).toBe('pending');
      expect((await store.getPasskeyChallenge('again'))?.consumed).toBe(false);
    });

    it('answers challenge for a used challenge when the account has no pending recovery', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await store.createPasskeyChallenge({ ...challenge('used', 'acc'), consumed: true });
      expect(
        await store.storePendingRecovery({
          challengeId: 'used',
          pending: pending('acc'),
          now: NOW,
        }),
      ).toBe('challenge');
    });

    it('treats an expired unforwarded pending recovery as absent and a forwarded one as present', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      await store.storePendingRecovery({ challengeId: 'mine', pending: pending('acc'), now: NOW });
      const later = NOW + CHALLENGE_TTL_MS + 1;
      expect(await store.getPendingRecovery('acc', NOW + CHALLENGE_TTL_MS)).toBeDefined();
      expect(await store.getPendingRecovery('acc', later)).toBeUndefined();
      expect(await store.getPendingRecoveryByNewSparkPubkey(NEW, later)).toBeUndefined();
      expect(await store.getPendingRecoveryByCredentialId('new-credential', later)).toBeUndefined();
      await store.createPasskeyChallenge(challenge('later', 'acc', later));
      expect(
        await store.storePendingRecovery({
          challengeId: 'later',
          pending: pending('acc', { createdAt: later }),
          now: later,
        }),
      ).toBe('stored');
      await store.markRecoveryForwarded({
        newSparkPubkey: NEW,
        oldSparkPubkey: OLD,
        username: 'ada',
        now: later,
      });
      expect(await store.getPendingRecovery('acc', later + 100 * CHALLENGE_TTL_MS)).toBeDefined();
    });

    it('evicts expired pending recoveries of other accounts before the key and credential checks', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyChallenge(challenge('theirs', 'other'));
      await store.storePendingRecovery({
        challengeId: 'theirs',
        pending: pending('other', { oldSparkPubkey: THIRD }),
        now: NOW,
      });
      const later = NOW + CHALLENGE_TTL_MS + 1;
      await store.createPasskeyChallenge(challenge('mine', 'acc', later));
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { createdAt: later }),
          now: later,
        }),
      ).toBe('stored');
    });

    it('refuses a new key held by an account, a previous wallet, or another pending recovery', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { newSparkPubkey: THIRD }),
          now: NOW,
        }),
      ).toBe('key');
      await forwarded(store, 'other', 'bob', THIRD, NEW, 'their-credential');
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc'),
          now: NOW,
        }),
      ).toBe('key');
      expect(
        await store.commitRecovery({ accountId: 'other', newSparkPubkey: NEW, now: NOW + 2 }),
      ).toBe('committed');
      const fourth = `03${'4'.repeat(64)}`;
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { newSparkPubkey: fourth, credentialId: 'their-credential' }),
          now: NOW + 3,
        }),
      ).toBe('credential');
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc', { newSparkPubkey: THIRD }),
          now: NOW + 3,
        }),
      ).toBe('key');
      expect((await store.getPasskeyChallenge('mine'))?.consumed).toBe(false);
    });

    it('refuses a credential id held by another pending recovery', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyChallenge(challenge('theirs', 'other'));
      await store.storePendingRecovery({
        challengeId: 'theirs',
        pending: pending('other', { oldSparkPubkey: THIRD, newSparkPubkey: `03${'5'.repeat(64)}` }),
        now: NOW,
      });
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      expect(
        await store.storePendingRecovery({
          challengeId: 'mine',
          pending: pending('acc'),
          now: NOW,
        }),
      ).toBe('credential');
    });
  });

  describe('markRecoveryForwarded', () => {
    it('admits only an open, unexpired pending recovery of the old verified key and the username', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'Ada');
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      await store.storePendingRecovery({ challengeId: 'mine', pending: pending('acc'), now: NOW });
      const admit = (
        overrides: Partial<{
          newSparkPubkey: string;
          oldSparkPubkey: string;
          username: string;
          now: number;
        }> = {},
      ) =>
        store.markRecoveryForwarded({
          newSparkPubkey: NEW,
          oldSparkPubkey: OLD,
          username: 'ada',
          now: NOW + 1,
          ...overrides,
        });
      expect(await admit({ newSparkPubkey: THIRD })).toBeUndefined();
      expect(await admit({ oldSparkPubkey: THIRD })).toBeUndefined();
      expect(await admit({ username: 'bob' })).toBeUndefined();
      expect(await admit({ now: NOW + CHALLENGE_TTL_MS + 1 })).toBeUndefined();
      await store.setSessionRefused('acc', true);
      expect(await admit()).toBeUndefined();
      await store.setSessionRefused('acc', false);
      const admitted = await admit();
      expect(admitted).toEqual({ ...pending('acc'), forwardedAt: NOW + 1 });
      expect(await store.getPendingRecovery('acc', NOW)).toEqual(admitted);
      expect(await admit({ now: NOW + 2 })).toBeUndefined();
    });
  });

  describe('commitRecovery', () => {
    it('answers gone without a forwarded pending recovery with that new key', async () => {
      const store = new InMemoryAuthStore();
      expect(
        await store.commitRecovery({ accountId: 'missing', newSparkPubkey: NEW, now: NOW }),
      ).toBe('gone');
      await recoverable(store, 'acc', 'ada');
      expect(await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW })).toBe(
        'gone',
      );
      await store.createPasskeyChallenge(challenge('mine', 'acc'));
      await store.storePendingRecovery({ challengeId: 'mine', pending: pending('acc'), now: NOW });
      expect(await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW })).toBe(
        'gone',
      );
      await store.markRecoveryForwarded({
        newSparkPubkey: NEW,
        oldSparkPubkey: OLD,
        username: 'ada',
        now: NOW,
      });
      expect(
        await store.commitRecovery({ accountId: 'acc', newSparkPubkey: THIRD, now: NOW }),
      ).toBe('gone');
      expect(await store.getPendingRecovery('acc', NOW)).toBeDefined();
    });

    it('replaces credentials, sessions, push subscriptions, and the wallet key in one step', async () => {
      const store = new InMemoryAuthStore();
      const push = new InMemoryPushStore();
      store.usePushStore(push);
      await recoverable(store, 'acc', 'Ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await store.createPasskeyCredential({
        credentialId: 'login',
        publicKey: Uint8Array.of(1),
        signCount: 3,
        accountId: 'acc',
        createdAt: 5,
      });
      await store.createPasskeyCredential({
        credentialId: 'seed',
        publicKey: Uint8Array.of(2),
        signCount: 0,
        accountId: 'other',
        createdAt: 5,
      });
      await store.createSession({ token: 'a'.repeat(64), accountId: 'acc', createdAt: NOW });
      await store.createSession({ token: 'b'.repeat(64), accountId: 'other', createdAt: NOW });
      const sub = (endpoint: string, accountId: string) => ({
        endpoint,
        accountId,
        p256dh: 'p',
        auth: 'a',
        createdAt: new Date(NOW),
        sessionToken: null,
      });
      await push.upsertSubscription(sub('https://push.example/1', 'acc'));
      await push.upsertSubscription(sub('https://push.example/2', 'acc'));
      await push.upsertSubscription(sub('https://push.example/3', 'other'));
      expect(
        await store.putRecoveryShare({
          accountId: 'acc',
          sparkPubkey: OLD,
          ciphertext: new Uint8Array(40),
          now: NOW,
        }),
      ).toBe('stored');
      await store.createPasskeyChallenge(challenge('stale', 'acc'));
      await forwarded(store, 'acc', 'ada');
      await store.createPasskeyChallenge(challenge('late', 'acc'));
      const before = await store.getAccount('acc');

      expect(
        await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW + 9 }),
      ).toBe('committed');

      const after = await store.getAccount('acc');
      expect(after).toEqual({ ...before, sparkPubkey: NEW, walletRequired: true });
      expect(after?.sparkPubkeyVerifiedAt).toBe(10);
      expect(after?.username).toBe('Ada');
      expect((await store.listPasskeyCredentials()).map((c) => c.credentialId).sort()).toEqual([
        'new-credential',
        'seed',
      ]);
      expect(await store.getPasskeyCredential('new-credential')).toEqual({
        credentialId: 'new-credential',
        publicKey: Uint8Array.of(4, 5, 6),
        signCount: 0,
        accountId: 'acc',
        createdAt: NOW + 9,
      });
      expect((await store.listSessions()).map((session) => session.accountId)).toEqual(['other']);
      expect(await push.listByAccount('acc')).toEqual([]);
      expect(await push.listByAccount('other')).toHaveLength(1);
      expect(await store.listPreviousWallets('acc')).toEqual([
        {
          accountId: 'acc',
          sparkPubkey: OLD,
          sparkAddress: encodeSparkAddress(OLD),
          replacedAt: NOW + 9,
        },
      ]);
      expect((await store.getPasskeyChallenge('late'))?.consumed).toBe(true);
      expect(await store.getPendingRecovery('acc', NOW)).toBeUndefined();
      expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
      expect(await store.getAccountByVerifiedSparkPubkey(NEW)).toEqual(after);
      expect(
        await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW + 10 }),
      ).toBe('gone');
    });

    it('commits without a linked push store', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await forwarded(store, 'acc', 'ada');
      expect(await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW })).toBe(
        'committed',
      );
    });

    it('drops the pending recovery when the account no longer holds the old verified key', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await forwarded(store, 'acc', 'ada');
      await store.deleteAccount('acc');
      await recoverable(store, 'acc', 'ada', THIRD);
      expect(await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW })).toBe(
        'changed',
      );
      expect(await store.getPendingRecovery('acc', NOW)).toBeUndefined();
      expect((await store.getAccount('acc'))?.sparkPubkey).toBe(THIRD);

      const unverified = new InMemoryAuthStore();
      await recoverable(unverified, 'acc', 'ada');
      await forwarded(unverified, 'acc', 'ada');
      await unverified.deleteAccount('acc');
      await unverified.createAccount({
        id: 'acc',
        linkingKey: null,
        role: 'basis',
        name: null,
        username: 'ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'd'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
        walletRequired: true,
      });
      await unverified.claimSparkPubkey('acc', OLD);
      expect(
        await unverified.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW }),
      ).toBe('changed');
    });

    it('throws, writing nothing, when another account verified the new key meanwhile', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await forwarded(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', NEW);
      await expect(
        store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW }),
      ).rejects.toThrow(/verified wallet key of another account/);
      expect((await store.getAccount('acc'))?.sparkPubkey).toBe(OLD);
      expect(await store.listPreviousWallets('acc')).toEqual([]);
      expect(await store.getPendingRecovery('acc', NOW)).toBeDefined();
    });

    it('throws, writing nothing, when another account took the pending credential id meanwhile', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      await forwarded(store, 'acc', 'ada');
      const theirs: PasskeyCredential = {
        credentialId: 'new-credential',
        publicKey: Uint8Array.of(7, 8, 9),
        signCount: 3,
        accountId: 'other',
        createdAt: NOW + 2,
      };
      expect(await store.createPasskeyCredential(theirs)).toBe(true);
      await expect(
        store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW + 3 }),
      ).rejects.toThrow(/passkey of another account/);
      expect((await store.getAccount('acc'))?.sparkPubkey).toBe(OLD);
      expect(await store.listPreviousWallets('acc')).toEqual([]);
      expect(await store.getPendingRecovery('acc', NOW)).toBeDefined();
      expect(await store.getPasskeyCredential('new-credential')).toEqual(theirs);
    });
  });

  describe('dropPendingRecovery', () => {
    it('deletes only the account pending recovery with that new key', async () => {
      const store = new InMemoryAuthStore();
      expect(await store.dropPendingRecovery({ accountId: 'acc', newSparkPubkey: NEW })).toBe(
        false,
      );
      await recoverable(store, 'acc', 'ada');
      await forwarded(store, 'acc', 'ada');
      expect(await store.dropPendingRecovery({ accountId: 'acc', newSparkPubkey: THIRD })).toBe(
        false,
      );
      expect(await store.dropPendingRecovery({ accountId: 'acc', newSparkPubkey: NEW })).toBe(true);
      expect(await store.getPendingRecovery('acc', NOW)).toBeUndefined();
    });
  });

  describe('previous wallets', () => {
    it('lists newest first, then by key, and drops a wallet together with its share', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await store.putRecoveryShare({
        accountId: 'acc',
        sparkPubkey: OLD,
        ciphertext: new Uint8Array(40),
        now: 1,
      });
      await forwarded(store, 'acc', 'ada', OLD, NEW, 'cred-1');
      await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW });
      await store.putRecoveryShare({
        accountId: 'acc',
        sparkPubkey: NEW,
        ciphertext: new Uint8Array(40),
        now: 2,
      });
      await forwarded(store, 'acc', 'ada', NEW, THIRD, 'cred-2');
      await store.commitRecovery({ accountId: 'acc', newSparkPubkey: THIRD, now: NOW });
      const fourth = `03${'4'.repeat(64)}`;
      await forwarded(store, 'acc', 'ada', THIRD, fourth, 'cred-3');
      await store.commitRecovery({ accountId: 'acc', newSparkPubkey: fourth, now: NOW + 5 });
      expect((await store.listPreviousWallets('acc')).map((wallet) => wallet.sparkPubkey)).toEqual([
        THIRD,
        OLD,
        NEW,
      ]);
      expect(await store.listPreviousWallets('other')).toEqual([]);
      expect(await store.dropPreviousWallet('acc', fourth)).toBe(false);
      expect(await store.dropPreviousWallet('acc', OLD)).toBe(true);
      expect(await store.dropPreviousWallet('acc', OLD)).toBe(false);
      expect(await store.getPreviousWalletBySparkPubkey(OLD)).toBeUndefined();
      expect(await store.dropPreviousWallet('acc', NEW)).toBe(true);
      await forwarded(store, 'acc', 'ada', fourth, OLD, 'cred-4');
      expect(
        await store.commitRecovery({ accountId: 'acc', newSparkPubkey: OLD, now: NOW + 6 }),
      ).toBe('committed');
      expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
    });

    it('orders previous wallets of the same commit time by key whatever the commit order', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada', NEW);
      await forwarded(store, 'acc', 'ada', NEW, OLD, 'cred-1');
      await store.commitRecovery({ accountId: 'acc', newSparkPubkey: OLD, now: NOW });
      await forwarded(store, 'acc', 'ada', OLD, THIRD, 'cred-2');
      await store.commitRecovery({ accountId: 'acc', newSparkPubkey: THIRD, now: NOW });
      expect((await store.listPreviousWallets('acc')).map((wallet) => wallet.sparkPubkey)).toEqual([
        OLD,
        NEW,
      ]);
    });

    it('returns the newest previous wallet of a key, then the larger account id', async () => {
      const shared = `03${'6'.repeat(64)}`;
      const build = async (first: [string, number], second: [string, number]) => {
        const store = new InMemoryAuthStore();
        for (const [id, at] of [first, second]) {
          await recoverable(store, id, `user-${id}`, shared);
          await forwarded(store, id, `user-${id}`, shared, `02${id.repeat(64)}`, `cred-${id}`);
          await store.commitRecovery({
            accountId: id,
            newSparkPubkey: `02${id.repeat(64)}`,
            now: at,
          });
        }
        return (await store.getPreviousWalletBySparkPubkey(shared))?.accountId;
      };
      expect(await build(['a', 5], ['b', 5])).toBe('b');
      expect(await build(['b', 5], ['a', 5])).toBe('b');
      expect(await build(['a', 9], ['b', 5])).toBe('a');
      expect(await build(['b', 5], ['a', 9])).toBe('a');
      expect(await new InMemoryAuthStore().getPreviousWalletBySparkPubkey(shared)).toBeUndefined();
    });
  });

  describe('recovery shares', () => {
    it('stores, replaces, and reports a share only for the current verified wallet', async () => {
      const store = new InMemoryAuthStore();
      const put = (accountId: string, sparkPubkey = OLD) =>
        store.putRecoveryShare({
          accountId,
          sparkPubkey,
          ciphertext: new Uint8Array(40),
          now: NOW,
        });
      expect(await put('missing')).toBe('changed');
      expect(await store.hasRecoveryShareForVerifiedWallet('missing')).toBe(false);
      await recoverable(store, 'acc', 'ada');
      expect(await put('acc', THIRD)).toBe('changed');
      expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
      expect(await put('acc')).toBe('stored');
      expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(true);
      expect(await put('acc')).toBe('replaced');
      await store.createAccount({
        id: 'claimed',
        linkingKey: null,
        role: 'basis',
        name: null,
        username: 'claimed',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'e'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
        walletRequired: true,
      });
      expect(await store.hasRecoveryShareForVerifiedWallet('claimed')).toBe(false);
      await store.claimSparkPubkey('claimed', THIRD);
      expect(await put('claimed', THIRD)).toBe('changed');
      expect(await store.hasRecoveryShareForVerifiedWallet('claimed')).toBe(false);
    });
  });

  describe('held-share boxes', () => {
    const BOX_A = 'a'.repeat(32);
    const BOX_B = 'b'.repeat(32);
    const BOX_C = 'c'.repeat(32);

    function putBox(
      store: InMemoryAuthStore,
      accountId: string,
      id: string,
      byte: number,
      now = NOW,
      limit = 50,
    ): Promise<string> {
      return store.putHeldShareBox({
        accountId,
        id,
        ciphertext: Uint8Array.of(1, byte),
        now,
        limit,
      });
    }

    it('creates, replaces, lists oldest first, and deletes only own boxes', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      expect(await store.listHeldShareBoxes('acc')).toEqual([]);
      // Same creation time, stored in reverse id order: the id breaks the tie.
      expect(await putBox(store, 'acc', BOX_C, 3, NOW)).toBe('created');
      expect(await putBox(store, 'acc', BOX_B, 2, NOW)).toBe('created');
      expect(await putBox(store, 'acc', BOX_A, 1, NOW + 1)).toBe('created');
      expect(await putBox(store, 'acc', BOX_C, 9, NOW + 5)).toBe('replaced');
      const listed = await store.listHeldShareBoxes('acc');
      expect(listed).toEqual([
        { id: BOX_B, ciphertext: Uint8Array.of(1, 2), createdAt: NOW, updatedAt: NOW },
        { id: BOX_C, ciphertext: Uint8Array.of(1, 9), createdAt: NOW, updatedAt: NOW + 5 },
        { id: BOX_A, ciphertext: Uint8Array.of(1, 1), createdAt: NOW + 1, updatedAt: NOW + 1 },
      ]);
      // A listed copy cannot change the stored bytes.
      listed[0]!.ciphertext[1] = 0;
      expect((await store.listHeldShareBoxes('acc'))[0]?.ciphertext).toEqual(Uint8Array.of(1, 2));

      expect(await putBox(store, 'other', BOX_A, 7)).toBe('taken');
      await store.deleteHeldShareBox('other', BOX_A);
      expect(await store.listHeldShareBoxes('other')).toEqual([]);
      expect(await store.listHeldShareBoxes('acc')).toHaveLength(3);

      await store.deleteHeldShareBox('acc', BOX_A);
      await store.deleteHeldShareBox('acc', BOX_A);
      expect((await store.listHeldShareBoxes('acc')).map((box) => box.id)).toEqual([BOX_B, BOX_C]);
    });

    it('refuses a create past the limit but still replaces', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      expect(await putBox(store, 'other', BOX_C, 3, NOW, 2)).toBe('created');
      expect(await putBox(store, 'acc', BOX_A, 1, NOW, 2)).toBe('created');
      expect(await putBox(store, 'acc', BOX_B, 2, NOW, 2)).toBe('created');
      expect(await putBox(store, 'acc', 'd'.repeat(32), 4, NOW, 2)).toBe('full');
      expect(await putBox(store, 'acc', BOX_B, 5, NOW + 1, 2)).toBe('replaced');
      expect((await store.listHeldShareBoxes('acc')).map((box) => box.id)).toEqual([BOX_A, BOX_B]);
    });

    it('keeps the boxes through a recovery commit, which keeps the account id', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      expect(await putBox(store, 'acc', BOX_A, 1)).toBe('created');
      await forwarded(store, 'acc', 'ada');
      expect(
        await store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW + 2 }),
      ).toBe('committed');
      expect((await store.getAccount('acc'))?.sparkPubkey).toBe(NEW);
      expect(await store.listHeldShareBoxes('acc')).toEqual([
        { id: BOX_A, ciphertext: Uint8Array.of(1, 1), createdAt: NOW, updatedAt: NOW },
      ]);
    });

    it('deletes the boxes with the account', async () => {
      const store = new InMemoryAuthStore();
      await recoverable(store, 'acc', 'ada');
      await recoverable(store, 'other', 'bob', THIRD);
      expect(await putBox(store, 'acc', BOX_A, 1)).toBe('created');
      expect(await putBox(store, 'other', BOX_B, 2)).toBe('created');
      await store.deleteAccount('acc');
      expect(await store.listHeldShareBoxes('acc')).toEqual([]);
      expect((await store.listHeldShareBoxes('other')).map((box) => box.id)).toEqual([BOX_B]);
      // The id is free again.
      expect(await putBox(store, 'other', BOX_A, 3)).toBe('created');
    });
  });
});
