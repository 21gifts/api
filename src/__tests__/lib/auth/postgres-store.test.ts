import { describe, it, expect } from 'vitest';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return this.nextRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
  }
}

const ACCOUNT_ROW = {
  id: 'acc',
  linking_key: `02${'a'.repeat(64)}`,
  role: 'basis',
  name: null as string | null,
  lightning_address: null as string | null,
  lightning_address_verified: false,
  created_at: new Date(1_000),
};

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
    expect((await store.getAccount('acc'))?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    const listed = await store.listAccounts();
    expect(listed).toHaveLength(1);
    expect(sql.queries[1]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
  });

  it('returns undefined for a missing account', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getAccount('x')).toBeUndefined();
  });

  it('inserts and updates accounts', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createAccount({
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'moderator',
      name: 'Ada',
      lightningAddress: 'a@b.com',
      lightningAddressVerified: true,
      createdAt: 1,
    });
    await store.updateAccount({
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(linking_key\) DO NOTHING/);
    expect(sql.executes[1]?.text).toMatch(/UPDATE account/);
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
    await store.createPasskeyCredential({
      credentialId: 'cred',
      publicKey: key,
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO passkey_credential/);
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
    await store.updatePasskeyCredential({
      credentialId: 'cred',
      publicKey: key,
      signCount: 5,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(sql.executes[1]?.text).toMatch(/UPDATE passkey_credential/);
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
