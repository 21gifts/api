import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { MessageRow } from '@/lib/message';
import {
  InMemoryMessageStore,
  MESSAGE_SCHEMA_SQL,
  migrateMessageSchema,
  PostgresMessageStore,
} from '@/lib/message-store';

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

const EARLY: MessageRow = {
  id: 'a',
  accountId: 'acc',
  name: 'Ada',
  text: 'first',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

const LATE: MessageRow = {
  id: 'b',
  accountId: 'acc',
  name: 'Ada',
  text: 'second',
  createdAt: new Date('2026-08-02T00:00:00.000Z'),
};

const TIE_HIGH: MessageRow = {
  id: 'z',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-high',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
};

const TIE_LOW: MessageRow = {
  id: 'm',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-low',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
};

describe('MESSAGE_SCHEMA_SQL', () => {
  it('creates message and its created_at index', () => {
    expect(MESSAGE_SCHEMA_SQL).toHaveLength(2);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS message/i);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/account_id uuid NOT NULL REFERENCES account/i);
    expect(MESSAGE_SCHEMA_SQL[1]).toMatch(/CREATE INDEX IF NOT EXISTS message_created_at_idx/i);
  });
});

describe('migrateMessageSchema', () => {
  it('runs every MESSAGE_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateMessageSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...MESSAGE_SCHEMA_SQL]);
  });
});

describe('InMemoryMessageStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryMessageStore().listLatest(10)).toEqual([]);
  });

  it('copies the seed and listed rows so callers cannot mutate store state', async () => {
    const seed: MessageRow[] = [EARLY, LATE];
    const store = new InMemoryMessageStore(seed);
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
    const store = new InMemoryMessageStore([EARLY, LATE]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('breaks equal createdAt ties by id descending', async () => {
    const store = new InMemoryMessageStore([TIE_LOW, TIE_HIGH]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'm']);
  });

  it('keeps equal id and createdAt as a sort tie', async () => {
    const dup: MessageRow = {
      ...TIE_HIGH,
      createdAt: new Date(TIE_HIGH.createdAt.getTime()),
    };
    const store = new InMemoryMessageStore([TIE_HIGH, dup]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'z']);
  });

  it('caps the list at limit', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE, TIE_HIGH]);
    expect((await store.listLatest(1)).map((r) => r.id)).toEqual(['z']);
  });

  it('create then list returns the new row', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create(EARLY);
    expect(created.text).toBe('first');
    expect(created).not.toBe(EARLY);
    expect((await store.listLatest(10))[0]?.id).toBe('a');
  });
});

describe('PostgresMessageStore', () => {
  it('maps rows and binds the limit parameter', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Bob',
        text: 'yo',
        created_at: '2026-08-27T12:00:00.000Z',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listLatest(50);
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, account_id, name, text, created_at FROM message ORDER BY created_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed).toEqual([
      {
        id: 'm1',
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'm2',
        accountId: 'acc',
        name: 'Bob',
        text: 'yo',
        createdAt: new Date('2026-08-27T12:00:00.000Z'),
      },
    ]);
  });

  it('create binds columns and does not use ON CONFLICT', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
    };
    const created = await store.create(row);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO message \(id, account_id, name, text, created_at\) VALUES \(\$1,\$2,\$3,\$4,\$5\)/,
    );
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual(['m1', 'acc', 'Ada', 'hello', row.createdAt]);
    expect(created).toEqual(row);
    expect(created).not.toBe(row);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresMessageStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('propagates create execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('create boom');
    await expect(
      new PostgresMessageStore(sql).create({
        id: 'm1',
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date(0),
      }),
    ).rejects.toThrow('create boom');
  });
});
