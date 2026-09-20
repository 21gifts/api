import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  API_LOG_SCHEMA_SQL,
  InMemoryApiLogStore,
  migrateApiLogSchema,
  PostgresApiLogStore,
  serializeDebugApiLog,
  type ApiLogRow,
} from '@/lib/api-log';

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

const EARLY: ApiLogRow = {
  id: 'a',
  createdAt: new Date('2026-09-19T12:00:00.000Z'),
  method: 'GET',
  path: '/info',
  status: 200,
  ms: 1,
  accountId: null,
  authKind: 'none',
};

const LATE: ApiLogRow = {
  id: 'b',
  createdAt: new Date('2026-09-19T13:00:00.000Z'),
  method: 'POST',
  path: '/conversations/x',
  status: 200,
  ms: 4,
  accountId: 'acc',
  authKind: 'session',
};

const TIE_LOW: ApiLogRow = {
  id: 'a',
  createdAt: new Date('2026-09-19T13:00:00.000Z'),
  method: 'GET',
  path: '/info',
  status: 200,
  ms: 1,
  accountId: null,
  authKind: 'none',
};

const TIE_HIGH: ApiLogRow = {
  id: 'c',
  createdAt: new Date('2026-09-19T13:00:00.000Z'),
  method: 'GET',
  path: '/me',
  status: 200,
  ms: 2,
  accountId: 'acc',
  authKind: 'session',
};

describe('serializeDebugApiLog', () => {
  it('emits ISO createdAt and the stored fields', () => {
    expect(serializeDebugApiLog(LATE)).toEqual({
      id: 'b',
      createdAt: '2026-09-19T13:00:00.000Z',
      method: 'POST',
      path: '/conversations/x',
      status: 200,
      ms: 4,
      accountId: 'acc',
      authKind: 'session',
    });
  });
});

describe('InMemoryApiLogStore', () => {
  it('lists newest first and copies rows', async () => {
    const store = new InMemoryApiLogStore([EARLY, LATE]);
    const listed = await store.listLatest(10);
    expect(listed.map((row) => row.id)).toEqual(['b', 'a']);
    listed[0]!.path = 'mutated';
    const again = await store.listLatest(10);
    expect(again[0]?.path).toBe('/conversations/x');
  });

  it('appends and caps listLatest', async () => {
    const store = new InMemoryApiLogStore();
    await store.append(EARLY);
    await store.append(LATE);
    expect((await store.listLatest(1)).map((row) => row.id)).toEqual(['b']);
  });

  it('breaks equal createdAt ties by id descending', async () => {
    const store = new InMemoryApiLogStore([TIE_LOW, TIE_HIGH]);
    expect((await store.listLatest(10)).map((row) => row.id)).toEqual(['c', 'a']);
  });
});

describe('migrateApiLogSchema', () => {
  it('executes API_LOG_SCHEMA_SQL in order', async () => {
    const sql = new MockSql();
    await migrateApiLogSchema(sql);
    expect(sql.executes.map((row) => row.text)).toEqual([...API_LOG_SCHEMA_SQL]);
  });
});

describe('PostgresApiLogStore', () => {
  it('append binds columns without ON CONFLICT', async () => {
    const sql = new MockSql();
    await new PostgresApiLogStore(sql).append(LATE);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO api_log \(id, created_at, method, path, status, ms, account_id, auth_kind\)/,
    );
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual([
      'b',
      LATE.createdAt,
      'POST',
      '/conversations/x',
      200,
      4,
      'acc',
      'session',
    ]);
  });

  it('listLatest maps rows and orders by created_at then id', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c',
        created_at: new Date('2026-09-19T13:00:00.000Z'),
        method: 'GET',
        path: '/me',
        status: '200',
        ms: '2',
        account_id: 'acc',
        auth_kind: 'session',
      },
      {
        id: 'a',
        created_at: '2026-09-19T13:00:00.000Z',
        method: 'GET',
        path: '/info',
        status: 200,
        ms: 1,
        account_id: null,
        auth_kind: 'mystery',
      },
    ];
    const listed = await new PostgresApiLogStore(sql).listLatest(50);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT \$1/);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed).toEqual([
      {
        id: 'c',
        createdAt: new Date('2026-09-19T13:00:00.000Z'),
        method: 'GET',
        path: '/me',
        status: 200,
        ms: 2,
        accountId: 'acc',
        authKind: 'session',
      },
      {
        id: 'a',
        createdAt: new Date('2026-09-19T13:00:00.000Z'),
        method: 'GET',
        path: '/info',
        status: 200,
        ms: 1,
        accountId: null,
        authKind: 'none',
      },
    ]);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresApiLogStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('propagates append execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    await expect(new PostgresApiLogStore(sql).append(EARLY)).rejects.toThrow('insert boom');
  });
});
