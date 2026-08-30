import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { ContactRow } from '@/lib/contact';
import {
  InMemoryContactStore,
  CONTACT_SCHEMA_SQL,
  migrateContactSchema,
  PostgresContactStore,
} from '@/lib/contact-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  queryError: unknown | undefined;
  executeError: unknown | undefined;

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

const EARLY: ContactRow = {
  id: 'a',
  accountId: 'acc',
  name: 'Ada',
  text: 'first',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const LATE: ContactRow = {
  id: 'b',
  accountId: 'acc',
  name: 'Ada',
  text: 'second',
  createdAt: new Date('2026-08-02T00:00:00.000Z'),
};

const TIE_HIGH: ContactRow = {
  id: 'z',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-high',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
};

const TIE_LOW: ContactRow = {
  id: 'm',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-low',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
};

describe('CONTACT_SCHEMA_SQL', () => {
  it('creates contact and its created_at index', () => {
    expect(CONTACT_SCHEMA_SQL).toHaveLength(2);
    expect(CONTACT_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS contact/i);
    expect(CONTACT_SCHEMA_SQL[0]).toMatch(/account_id uuid NOT NULL REFERENCES account/i);
    expect(CONTACT_SCHEMA_SQL[1]).toMatch(/CREATE INDEX IF NOT EXISTS contact_created_at_idx/i);
  });
});

describe('migrateContactSchema', () => {
  it('runs every CONTACT_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateContactSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...CONTACT_SCHEMA_SQL]);
  });
});

describe('InMemoryContactStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryContactStore().listLatest(10)).toEqual([]);
  });

  it('copies the seed and listed rows so callers cannot mutate store state', async () => {
    const seed: ContactRow[] = [EARLY, LATE];
    const store = new InMemoryContactStore(seed);
    seed.pop();
    seed[0] = { ...LATE, text: 'mutated-seed' };
    const listed = await store.listLatest(10);
    expect(listed).toHaveLength(2);
    listed.pop();
    if (listed[0] !== undefined) {
      listed[0].text = 'mutated-listed';
    }
    const again = await store.listLatest(10);
    expect(again).toHaveLength(2);
    expect(again.map((r) => r.text).sort()).toEqual(['first', 'second']);
  });

  it('returns newest createdAt first', async () => {
    const store = new InMemoryContactStore([EARLY, LATE]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('breaks equal createdAt ties by id descending', async () => {
    const store = new InMemoryContactStore([TIE_LOW, TIE_HIGH]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'm']);
  });

  it('keeps equal id and createdAt as a sort tie', async () => {
    const dup: ContactRow = {
      ...TIE_HIGH,
      createdAt: new Date(TIE_HIGH.createdAt.getTime()),
    };
    const store = new InMemoryContactStore([TIE_HIGH, dup]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'z']);
  });

  it('caps the list at limit', async () => {
    const store = new InMemoryContactStore([EARLY, LATE, TIE_HIGH]);
    expect((await store.listLatest(1)).map((r) => r.id)).toEqual(['z']);
  });

  it('create then list returns the new row', async () => {
    const store = new InMemoryContactStore();
    const created = await store.create(EARLY);
    expect(created.text).toBe('first');
    expect(created).not.toBe(EARLY);
    expect((await store.listLatest(10))[0]?.id).toBe('a');
  });
});

describe('PostgresContactStore', () => {
  it('maps rows and binds the limit parameter', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'c2',
        account_id: 'acc',
        name: 'Bob',
        text: 'yo',
        created_at: '2026-08-27T12:00:00.000Z',
      },
    ];
    const store = new PostgresContactStore(sql);
    const listed = await store.listLatest(50);
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, account_id, name, text, created_at FROM contact ORDER BY created_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed).toEqual([
      {
        id: 'c1',
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'c2',
        accountId: 'acc',
        name: 'Bob',
        text: 'yo',
        createdAt: new Date('2026-08-27T12:00:00.000Z'),
      },
    ]);
  });

  it('create binds columns and does not use ON CONFLICT', async () => {
    const sql = new MockSql();
    const store = new PostgresContactStore(sql);
    const row: ContactRow = {
      id: 'c1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
    };
    const created = await store.create(row);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO contact \(id, account_id, name, text, created_at\) VALUES \(\$1,\$2,\$3,\$4,\$5\)/,
    );
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual(['c1', 'acc', 'Ada', 'hello', row.createdAt]);
    expect(created).toEqual(row);
    expect(created).not.toBe(row);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresContactStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('propagates create execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('create boom');
    await expect(
      new PostgresContactStore(sql).create({
        id: 'c1',
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date(0),
      }),
    ).rejects.toThrow('create boom');
  });
});
