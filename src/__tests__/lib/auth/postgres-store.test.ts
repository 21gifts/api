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
  it('evicts expired challenges then inserts on createChallenge', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 5_000,
    });
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM auth_challenge/);
    expect(sql.executes[0]?.params[0]).toBe(5_000 - CHALLENGE_TTL_MS);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO auth_challenge/);
  });

  it('maps a challenge row including a Date timestamp', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        k1: 'k1',
        poll_token: 'pt',
        status: 'pending',
        account_id: null,
        created_at: new Date(1_000),
      },
    ];
    const store = new PostgresAuthStore(sql);
    const challenge = await store.getChallenge('k1');
    expect(challenge).toEqual({
      k1: 'k1',
      pollToken: 'pt',
      status: 'pending',
      accountId: null,
      createdAt: 1_000,
    });
  });

  it('returns undefined for a missing challenge', async () => {
    const sql = new MockSql();
    expect(await new PostgresAuthStore(sql).getChallenge('missing')).toBeUndefined();
  });

  it('returns undefined for a missing poll token', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getChallengeByPollToken('missing'),
    ).toBeUndefined();
  });

  it('looks up a challenge by poll token', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        k1: 'k1',
        poll_token: 'pt',
        status: 'authenticated',
        account_id: 'acc',
        created_at: '1970-01-01T00:00:01.000Z',
      },
    ];
    const challenge = await new PostgresAuthStore(sql).getChallengeByPollToken('pt');
    expect(challenge?.k1).toBe('k1');
    expect(challenge?.createdAt).toBe(1_000);
  });

  it('updates a challenge', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).updateChallenge({
      k1: 'k1',
      pollToken: 'pt',
      status: 'consumed',
      accountId: 'acc',
      createdAt: 1,
    });
    expect(sql.executes[0]?.text).toMatch(/UPDATE auth_challenge/);
  });

  it('maps account rows and lists them', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const store = new PostgresAuthStore(sql);
    expect((await store.getAccount('acc'))?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    expect((await store.findAccountByLinkingKey(ACCOUNT_ROW.linking_key))?.id).toBe('acc');
    const listed = await store.listAccounts();
    expect(listed).toHaveLength(1);
    expect(sql.queries[2]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
  });

  it('returns undefined for a missing account', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getAccount('x')).toBeUndefined();
    expect(await new PostgresAuthStore(new MockSql()).findAccountByLinkingKey('x')).toBeUndefined();
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
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO account/);
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

  it('rejects an unknown challenge status', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        k1: 'k1',
        poll_token: 'pt',
        status: 'nope',
        account_id: null,
        created_at: new Date(1),
      },
    ];
    await expect(new PostgresAuthStore(sql).getChallenge('k1')).rejects.toThrow(
      /Unknown challenge status/,
    );
  });
});
