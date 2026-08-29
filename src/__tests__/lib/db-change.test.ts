import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { DB_CHANGE_SCHEMA_SQL, migrateDbChangeSchema } from '@/lib/db-change';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  failAt: number | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return [];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.failAt !== undefined && this.executes.length === this.failAt) {
      throw new Error('ddl failed');
    }
  }
}

describe('DB_CHANGE_SCHEMA_SQL', () => {
  it('defines pgcrypto, db_change columns, redact secrets, and attach triggers', () => {
    expect(DB_CHANGE_SCHEMA_SQL[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
    expect(DB_CHANGE_SCHEMA_SQL[1]).toMatch(/CREATE TABLE IF NOT EXISTS db_change/i);
    expect(DB_CHANGE_SCHEMA_SQL[1]).toMatch(/before jsonb/);
    expect(DB_CHANGE_SCHEMA_SQL[1]).toMatch(/after jsonb/);
    const joined = DB_CHANGE_SCHEMA_SQL.join('\n');
    expect(joined).toMatch(/db_change/);
    expect(joined).toMatch(/log_db_change/);
    expect(joined).toMatch(/pgcrypto/);
    expect(joined).toMatch(/token/);
    expect(joined).toMatch(/challenge/);
    expect(joined).toMatch(/nostr_nsec_ciphertext/);
    expect(joined).toMatch(/nonce/);
    expect(joined).toMatch(/view_key/);
    const guardBlock = joined.slice(joined.indexOf('$guard$'));
    const dropAt = guardBlock.indexOf('DROP TRIGGER IF EXISTS db_change_immutable');
    const afterMatchAt = guardBlock.indexOf("a.view_key = d.after ->> 'view_key'");
    const beforeMatchAt = guardBlock.indexOf("a.view_key = d.before ->> 'view_key'");
    const recreateAt = guardBlock.indexOf(
      'CREATE TRIGGER db_change_immutable BEFORE UPDATE OR DELETE ON db_change',
    );
    expect(dropAt).toBeGreaterThan(-1);
    expect(afterMatchAt).toBeGreaterThan(dropAt);
    expect(beforeMatchAt).toBeGreaterThan(afterMatchAt);
    expect(recreateAt).toBeGreaterThan(beforeMatchAt);
    expect(joined.split('DROP TRIGGER IF EXISTS db_change_immutable').length - 1).toBe(1);
    expect(joined).toMatch(/trg_db_change/);
    expect(joined).toMatch(/append-only/);
    expect(joined).toMatch(/BEFORE TRUNCATE/);
    expect(joined).toMatch(/outj ->> k/);
    expect(joined).toMatch(/IS NOT DISTINCT FROM/);
    expect(joined).toMatch(/tablename <> 'db_change'/);
    expect(joined).toMatch(/EXECUTE PROCEDURE/);
  });
});

describe('migrateDbChangeSchema', () => {
  it('runs every DB_CHANGE_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateDbChangeSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...DB_CHANGE_SCHEMA_SQL]);
  });

  it('propagates a failed statement', async () => {
    const sql = new MockSql();
    sql.failAt = 2;
    await expect(migrateDbChangeSchema(sql)).rejects.toThrow(/ddl failed/);
  });
});
