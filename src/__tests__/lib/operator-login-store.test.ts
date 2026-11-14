import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryOperatorLoginStore,
  OPERATOR_LOGIN_SCHEMA_SQL,
  PostgresOperatorLoginStore,
  migrateOperatorLoginSchema,
  type OperatorTokenRecord,
} from '@/lib/operator-login-store';

const RECORD: OperatorTokenRecord = {
  tokenHash: 'a'.repeat(64),
  operator: 'alice',
  keyFingerprint: 'SHA256:abc',
  level: 'write',
  createdAt: 1_000,
  expiresAt: 2_000,
};

class MockSql implements SqlClient {
  readonly calls: { text: string; params: readonly unknown[] | undefined }[] = [];
  rows: unknown[] = [];

  query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
    this.calls.push({ text, params });
    return Promise.resolve(this.rows as T[]);
  }

  execute(text: string, params?: readonly unknown[]): Promise<void> {
    this.calls.push({ text, params });
    return Promise.resolve();
  }
}

describe('InMemoryOperatorLoginStore', () => {
  it('consumes a challenge once and only while it is valid', async () => {
    const store = new InMemoryOperatorLoginStore();
    await store.addChallenge('c1', 0, 100);
    await store.addChallenge('c2', 0, 100);
    expect(await store.consumeChallenge('c1', 99)).toBe(true);
    expect(await store.consumeChallenge('c1', 99)).toBe(false);
    expect(await store.consumeChallenge('c2', 100)).toBe(false);
    expect(await store.consumeChallenge('c2', 0)).toBe(false);
    expect(await store.consumeChallenge('unknown', 0)).toBe(false);
  });

  it('finds a token until it expires and returns a copy', async () => {
    const store = new InMemoryOperatorLoginStore();
    await store.addToken(RECORD);
    const found = await store.findToken(RECORD.tokenHash, 1_999);
    expect(found).toEqual(RECORD);
    if (found !== null) {
      found.level = 'admin';
    }
    expect((await store.findToken(RECORD.tokenHash, 1_999))?.level).toBe('write');
    expect(await store.findToken(RECORD.tokenHash, 2_000)).toBeNull();
    expect(await store.findToken('b'.repeat(64), 0)).toBeNull();
  });

  it('deletes expired challenges and tokens and keeps the rest', async () => {
    const store = new InMemoryOperatorLoginStore();
    await store.addChallenge('old', 0, 50);
    await store.addChallenge('new', 0, 500);
    await store.addToken({ ...RECORD, tokenHash: 'old', expiresAt: 50 });
    await store.addToken({ ...RECORD, tokenHash: 'new', expiresAt: 500 });
    await store.deleteExpired(50);
    expect(await store.findToken('old', 0)).toBeNull();
    expect(await store.findToken('new', 0)).not.toBeNull();
    expect(await store.consumeChallenge('old', 0)).toBe(false);
    expect(await store.consumeChallenge('new', 0)).toBe(true);
  });
});

describe('migrateOperatorLoginSchema', () => {
  it('runs every statement in order', async () => {
    const sql = new MockSql();
    await migrateOperatorLoginSchema(sql);
    expect(sql.calls.map((c) => c.text)).toEqual([...OPERATOR_LOGIN_SCHEMA_SQL]);
    expect(OPERATOR_LOGIN_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE TABLE IF NOT EXISTS operator_challenge/,
    );
    expect(OPERATOR_LOGIN_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE TABLE IF NOT EXISTS operator_token/,
    );
  });
});

describe('PostgresOperatorLoginStore', () => {
  it('inserts a challenge with its times', async () => {
    const sql = new MockSql();
    await new PostgresOperatorLoginStore(sql).addChallenge('c', 1_000, 61_000);
    expect(sql.calls[0]?.text).toMatch(/INSERT INTO operator_challenge/);
    expect(sql.calls[0]?.params).toEqual(['c', new Date(1_000), new Date(61_000)]);
  });

  it('consumes a challenge with one DELETE … RETURNING', async () => {
    const sql = new MockSql();
    const store = new PostgresOperatorLoginStore(sql);
    sql.rows = [{ expires_at: new Date(2_000) }];
    expect(await store.consumeChallenge('c', 1_999)).toBe(true);
    sql.rows = [{ expires_at: '1970-01-01T00:00:02.000Z' }];
    expect(await store.consumeChallenge('c', 2_000)).toBe(false);
    sql.rows = [];
    expect(await store.consumeChallenge('c', 0)).toBe(false);
    expect(sql.calls[0]?.text).toMatch(
      /DELETE FROM operator_challenge WHERE challenge = \$1 RETURNING expires_at/,
    );
    expect(sql.calls[0]?.params).toEqual(['c']);
  });

  it('inserts and maps a token', async () => {
    const sql = new MockSql();
    const store = new PostgresOperatorLoginStore(sql);
    await store.addToken(RECORD);
    expect(sql.calls[0]?.text).toMatch(/INSERT INTO operator_token/);
    expect(sql.calls[0]?.params).toEqual([
      RECORD.tokenHash,
      'alice',
      'SHA256:abc',
      'write',
      new Date(1_000),
      new Date(2_000),
    ]);
    sql.rows = [
      {
        token_hash: RECORD.tokenHash,
        operator: 'alice',
        key_fingerprint: 'SHA256:abc',
        level: 'write',
        created_at: '1970-01-01T00:00:01.000Z',
        expires_at: new Date(2_000),
      },
    ];
    expect(await store.findToken(RECORD.tokenHash, 1_500)).toEqual(RECORD);
    expect(sql.calls[1]?.text).toMatch(/WHERE token_hash = \$1 AND expires_at > \$2/);
    expect(sql.calls[1]?.params).toEqual([RECORD.tokenHash, new Date(1_500)]);
    sql.rows = [];
    expect(await store.findToken(RECORD.tokenHash, 1_500)).toBeNull();
  });

  it('deletes expired challenges and tokens', async () => {
    const sql = new MockSql();
    await new PostgresOperatorLoginStore(sql).deleteExpired(5_000);
    expect(sql.calls.map((c) => [c.text, c.params])).toEqual([
      ['DELETE FROM operator_challenge WHERE expires_at <= $1', [new Date(5_000)]],
      ['DELETE FROM operator_token WHERE expires_at <= $1', [new Date(5_000)]],
    ]);
  });
});
