import { describe, it, expect } from 'vitest';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  executeError: unknown | undefined;
  queryError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    return this.nextRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
  }
}

const VIEW_KEY = 'a'.repeat(64);

const ACCOUNT_ROW = {
  id: 'acc',
  linking_key: `02${'a'.repeat(64)}`,
  role: 'basis',
  name: null as string | null,
  lightning_address: null as string | null,
  lightning_address_verified: false,
  forum_laws_dismissed: false,
  view_key: VIEW_KEY,
  created_at: new Date(1_000),
  rules_agreed_at: null as Date | string | null,
};

describe('PostgresAuthStore nostr keys', () => {
  it('reads and writes nostr key material', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ nostr_pubkey: null }];
    expect(await store.getNostrPublicKey('acc')).toBeUndefined();
    sql.nextRows = [{ nostr_pubkey: 'aa'.repeat(32) }];
    expect(await store.getNostrPublicKey('acc')).toBe('aa'.repeat(32));
    sql.nextRows = [{ nostr_nsec_ciphertext: null }];
    expect(await store.getNostrSecret('acc')).toBeUndefined();
    sql.nextRows = [{ nostr_nsec_ciphertext: new Uint8Array([1, 2]) }];
    expect(await store.getNostrSecret('acc')).toEqual(new Uint8Array([1, 2]));
    sql.nextRows = [];
    expect(
      await store.setNostrKeyIfAbsent('acc', {
        pubkey: 'aa'.repeat(32),
        ciphertext: new Uint8Array([1]),
        kekId: 1,
        custody: 'custodial',
      }),
    ).toBe('exists');
    sql.nextRows = [{ nostr_pubkey: 'aa'.repeat(32) }];
    expect(
      await store.setNostrKeyIfAbsent('acc', {
        pubkey: 'aa'.repeat(32),
        ciphertext: new Uint8Array([1]),
        kekId: 1,
        custody: 'custodial',
      }),
    ).toBe('inserted');
    sql.nextRows = [{ id: 'acc' }];
    expect(await store.listAccountIdsWithoutNostrKey(5)).toEqual(['acc']);
  });
});

describe('migrateAuthSchema', () => {
  it('runs every AUTH_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateAuthSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...AUTH_SCHEMA_SQL]);
  });
});

describe('PostgresAuthStore', () => {
  it('maps account rows and lists them', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const store = new PostgresAuthStore(sql);
    const mapped = await store.getAccount('acc');
    expect(mapped?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    expect(mapped?.forumLawsDismissed).toBe(false);
    expect(mapped?.rulesAgreedAt).toBeNull();
    const account = await store.getAccount('acc');
    expect(account?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    expect(account?.viewKey).toBe(VIEW_KEY);
    expect(sql.queries[0]?.text).toMatch(/forum_laws_dismissed/);
    expect(sql.queries[0]?.text).toMatch(/rules_agreed_at/);
    const listed = await store.listAccounts();
    expect(listed).toHaveLength(1);
    expect(sql.queries[2]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(sql.queries[2]?.text).toMatch(/rules_agreed_at/);
  });

  it('maps a non-null rules_agreed_at timestamp', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, rules_agreed_at: new Date(5_000) }];
    expect((await new PostgresAuthStore(sql).getAccount('acc'))?.rulesAgreedAt).toBe(5_000);
  });

  it('returns undefined for a missing account', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getAccount('x')).toBeUndefined();
  });

  it('inserts and updates accounts', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const account = {
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'moderator' as const,
      name: 'Ada',
      lightningAddress: 'a@b.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
    };
    await store.createAccount(account);
    await store.updateAccount({
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: 9_000,
    });
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(linking_key\) DO NOTHING/);
    expect(sql.executes[0]?.text).toMatch(/forum_laws_dismissed/);
    expect(sql.executes[0]?.text).toMatch(/view_key/);
    expect(sql.executes[0]?.text).toMatch(/rules_agreed_at/);
    expect(sql.executes[0]?.params[8]).toBe(account.viewKey);
    expect(sql.executes[0]?.params[9]).toBeNull();
    expect(sql.executes[1]?.text).toMatch(/UPDATE account/);
    expect(sql.executes[1]?.text).toMatch(/forum_laws_dismissed/);
    expect(sql.executes[1]?.text).toMatch(/view_key = \$9/);
    expect(sql.executes[1]?.text).toMatch(/rules_agreed_at/);
    expect(sql.executes[1]?.text).toMatch(/NOT EXISTS/);
    expect(sql.executes[1]?.params).toEqual([
      'acc',
      ACCOUNT_ROW.linking_key,
      'basis',
      null,
      null,
      false,
      false,
      1,
      VIEW_KEY,
      9_000,
    ]);
  });

  it('looks up an account by view_key', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const store = new PostgresAuthStore(sql);
    const found = await store.getAccountByViewKey(VIEW_KEY);
    expect(sql.queries[0]?.text).toMatch(/WHERE view_key = \$1/);
    expect(sql.queries[0]?.params).toEqual([VIEW_KEY]);
    expect(found?.viewKey).toBe(VIEW_KEY);
    expect(found?.id).toBe('acc');
  });

  it('returns undefined for a missing view_key', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getAccountByViewKey(VIEW_KEY),
    ).toBeUndefined();
  });

  it('looks up an account by lightning_address with lower(trim) SQL', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { ...ACCOUNT_ROW, lightning_address: 'guest@walletofsatoshi.com', name: 'Ada' },
    ];
    const store = new PostgresAuthStore(sql);
    const found = await store.getAccountByLightningAddress('  Guest@WalletOfSatoshi.com  ');
    expect(sql.queries[0]?.text).toMatch(
      /WHERE lower\(trim\(lightning_address\)\) = lower\(trim\(\$1\)\)/,
    );
    expect(sql.queries[0]?.params).toEqual(['  Guest@WalletOfSatoshi.com  ']);
    expect(found?.id).toBe('acc');
    expect(found?.lightningAddress).toBe('guest@walletofsatoshi.com');
  });

  it('returns undefined when lightning_address lookup has no rows', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getAccountByLightningAddress(
        'missing@example.com',
      ),
    ).toBeUndefined();
  });

  it('accountHasPasskey queries passkey_credential by account_id', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [];
    expect(await store.accountHasPasskey('acc')).toBe(false);
    expect(sql.queries[0]?.text).toMatch(/FROM passkey_credential/);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [{ '?column?': 1 }];
    expect(await store.accountHasPasskey('acc')).toBe(true);
  });

  it('skips rows with a null view_key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null }];
    const store = new PostgresAuthStore(sql);
    expect(await store.getAccount('acc')).toBeUndefined();
    expect(await store.getAccountByViewKey(VIEW_KEY)).toBeUndefined();
    expect(await store.listAccounts()).toEqual([]);
  });

  it('createAccount treats a unique_violation as a no-op', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(
      new PostgresAuthStore(sql).createAccount({
        id: 'acc',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('createAccount rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('canceled'), { code: '57014' });
    await expect(
      new PostgresAuthStore(sql).createAccount({
        id: 'acc',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('updateAccount SQL refuses a linking_key owned by another id', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).updateAccount({
      id: 'pk',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(sql.executes[0]?.text).toMatch(/other\.linking_key = \$2 AND other\.id <> \$1/);
  });

  it('updateAccount treats a linking_key unique_violation as a no-op', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('updateAccount rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('canceled'), { code: '57014' });
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('updateAccount rethrows a thrown null', async () => {
    const sql = new MockSql();
    sql.executeError = null;
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toBeNull();
  });

  it('updateAccount rethrows a thrown string', async () => {
    const sql = new MockSql();
    sql.executeError = 'boom';
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toBe('boom');
  });

  it('updateAccount rethrows a plain Error', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('disk full');
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toThrow('disk full');
  });

  it('deletes an account by id', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).deleteAccount('acc');
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM account WHERE id = \$1/);
    expect(sql.executes[0]?.params).toEqual(['acc']);
  });

  it('evicts expired sessions then inserts', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).createSession({
      token: 'tok',
      accountId: 'acc',
      createdAt: 9_000,
    });
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM auth_session/);
    expect(sql.executes[0]?.params[0]).toBe(9_000 - SESSION_TTL_MS);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO auth_session/);
  });

  it('maps a session row', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ token: 'tok', account_id: 'acc', created_at: new Date(2_000) }];
    expect(await new PostgresAuthStore(sql).getSession('tok')).toEqual({
      token: 'tok',
      accountId: 'acc',
      createdAt: 2_000,
    });
  });

  it('returns undefined for a missing session', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getSession('x')).toBeUndefined();
  });

  it('upserts, reads, and deletes verifications', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.putVerification({
      accountId: 'acc',
      address: 'a@b.com',
      nonce: 'n'.repeat(32),
      createdAt: 1,
    });
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT/);
    sql.nextRows = [
      {
        account_id: 'acc',
        address: 'a@b.com',
        nonce: 'n'.repeat(32),
        created_at: new Date(1),
      },
    ];
    expect((await store.getVerification('acc'))?.address).toBe('a@b.com');
    await store.deleteVerification('acc');
    expect(sql.executes[1]?.text).toMatch(/DELETE FROM address_verification/);
  });

  it('returns undefined for a missing verification', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getVerification('x')).toBeUndefined();
  });

  it('maps verified and founder account roles', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'verified' }];
    expect((await store.getAccount('acc'))?.role).toBe('verified');
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'founder' }];
    expect((await store.getAccount('acc'))?.role).toBe('founder');
  });

  it('rejects an unknown account role', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'admin' }];
    await expect(new PostgresAuthStore(sql).getAccount('acc')).rejects.toThrow(
      /Unknown account role/,
    );
  });

  it('evicts expired passkey challenges then inserts', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 5_000,
    });
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM passkey_challenge/);
    expect(sql.executes[0]?.params[0]).toBe(5_000 - CHALLENGE_TTL_MS);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO passkey_challenge/);
  });

  it('maps a passkey challenge row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'authenticate',
        challenge: 'c',
        account_id: null,
        consumed: false,
        created_at: new Date(1_000),
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toEqual({
      id: 'ch',
      type: 'authenticate',
      challenge: 'c',
      accountId: null,
      consumed: false,
      createdAt: 1_000,
    });
  });

  it('returns undefined for a missing passkey challenge', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getPasskeyChallenge('x')).toBeUndefined();
  });

  it('updates a passkey challenge only while unconsumed', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'ch' }];
    const ok = await new PostgresAuthStore(sql).updatePasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: true,
      createdAt: 1,
    });
    expect(ok).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/consumed = false/);
  });

  it('returns false when the passkey challenge CAS matches no row', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: null,
        consumed: true,
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('inserts and maps a passkey credential including a bytea key', async () => {
    const sql = new MockSql();
    const key = new Uint8Array([1, 2, 3]);
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ credential_id: 'cred' }];
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/INSERT INTO passkey_credential/);
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT \(credential_id\) DO NOTHING/);
    sql.nextRows = [];
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    sql.nextRows = [
      {
        credential_id: 'cred',
        public_key: key,
        sign_count: 4,
        account_id: 'acc',
        created_at: new Date(1),
      },
    ];
    expect(await store.getPasskeyCredential('cred')).toEqual({
      credentialId: 'cred',
      publicKey: key,
      signCount: 4,
      accountId: 'acc',
      createdAt: 1,
    });
    sql.nextRows = [{ credential_id: 'cred' }];
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 5,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    const update = sql.queries[sql.queries.length - 1];
    expect(update?.text).toMatch(/SET sign_count = \$2/);
    expect(update?.text).toMatch(/\$2 = 0 AND sign_count = 0/);
    expect(update?.text).toMatch(/\$2 > sign_count/);
    expect(update?.text).toMatch(/RETURNING credential_id/);
    expect(update?.params).toEqual(['cred', 5]);
    sql.nextRows = [];
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 5,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('inserts a first passkey only when the account has none', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ credential_id: 'cred' }];
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/WHERE NOT EXISTS/);
    sql.nextRows = [];
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential treats a unique_violation as false', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = new Error('disk full');
    await expect(
      store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it('returns undefined for a missing passkey credential', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getPasskeyCredential('x')).toBeUndefined();
  });

  it('rejects an unknown passkey challenge type', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'nope',
        challenge: 'c',
        account_id: null,
        consumed: false,
        created_at: new Date(1),
      },
    ];
    await expect(new PostgresAuthStore(sql).getPasskeyChallenge('ch')).rejects.toThrow(
      /Unknown passkey challenge type/,
    );
  });

  it('maps a passkey challenge timestamp from an ISO string', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: '1970-01-01T00:00:01.000Z',
      },
    ];
    const row = await new PostgresAuthStore(sql).getPasskeyChallenge('ch');
    expect(row?.createdAt).toBe(1_000);
  });
});
