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
  clientIp: null,
  clientCountry: null,
  cfRay: null,
  userAgent: null,
  acceptLanguage: null,
  origin: null,
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
  clientIp: null,
  clientCountry: null,
  cfRay: null,
  userAgent: null,
  acceptLanguage: null,
  origin: null,
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
  clientIp: null,
  clientCountry: null,
  cfRay: null,
  userAgent: null,
  acceptLanguage: null,
  origin: null,
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
  clientIp: null,
  clientCountry: null,
  cfRay: null,
  userAgent: null,
  acceptLanguage: null,
  origin: null,
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
      clientIp: null,
      clientCountry: null,
      cfRay: null,
      userAgent: null,
      acceptLanguage: null,
      origin: null,
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

  it('pages every row once through listPage before cursors', async () => {
    const store = new InMemoryApiLogStore([EARLY, LATE, TIE_HIGH]);
    const first = await store.listPage(2);
    expect(first.map((row) => row.id)).toEqual(['c', 'b']);
    const last = first[first.length - 1]!;
    const second = await store.listPage(2, { before: { createdAt: last.createdAt, id: last.id } });
    expect(second.map((row) => row.id)).toEqual(['a']);
    const seen = [...first, ...second].map((row) => row.id);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages equal createdAt ties by id descending', async () => {
    const store = new InMemoryApiLogStore([TIE_LOW, TIE_HIGH]);
    const first = await store.listPage(1);
    expect(first.map((row) => row.id)).toEqual(['c']);
    const last = first[0]!;
    const second = await store.listPage(1, { before: { createdAt: last.createdAt, id: last.id } });
    expect(second.map((row) => row.id)).toEqual(['a']);
  });

  it('keeps only the requested accountId', async () => {
    const other: ApiLogRow = { ...LATE, id: 'd', accountId: 'other' };
    const store = new InMemoryApiLogStore([EARLY, LATE, other]);
    expect((await store.listPage(10, { accountId: 'acc' })).map((row) => row.id)).toEqual(['b']);
  });
});

describe('migrateApiLogSchema', () => {
  it('executes API_LOG_SCHEMA_SQL in order', async () => {
    const sql = new MockSql();
    await migrateApiLogSchema(sql);
    expect(sql.executes.map((row) => row.text)).toEqual([...API_LOG_SCHEMA_SQL]);
    expect(API_LOG_SCHEMA_SQL.slice(2)).toEqual([
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS client_ip text',
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS client_country text',
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS cf_ray text',
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS user_agent text',
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS accept_language text',
      'ALTER TABLE api_log ADD COLUMN IF NOT EXISTS origin text',
      'CREATE INDEX IF NOT EXISTS api_log_account_created_at_idx ON api_log (account_id, created_at DESC, id DESC)',
    ]);
  });
});

describe('PostgresApiLogStore', () => {
  it('append binds columns without ON CONFLICT', async () => {
    const sql = new MockSql();
    await new PostgresApiLogStore(sql).append(LATE);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO api_log \(id, created_at, method, path, status, ms, account_id, auth_kind, client_ip, client_country, cf_ray, user_agent, accept_language, origin\)/,
    );
    expect(sql.executes[0]?.text).toMatch(
      /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14\)/,
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
      null,
      null,
      null,
      null,
      null,
      null,
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
        client_ip: '192.0.2.1',
        client_country: 'CH',
        cf_ray: '0123456789abcdef-ZRH',
        user_agent: 'Agent',
        accept_language: 'de-CH',
        origin: 'https://21.gifts',
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
        client_ip: null,
        client_country: null,
        cf_ray: null,
        user_agent: null,
        accept_language: null,
        origin: null,
      },
    ];
    const listed = await new PostgresApiLogStore(sql).listLatest(50);
    expect(sql.queries[0]?.text).toMatch(
      /account_id, auth_kind, client_ip, client_country, cf_ray, user_agent, accept_language, origin/,
    );
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
        clientIp: '192.0.2.1',
        clientCountry: 'CH',
        cfRay: '0123456789abcdef-ZRH',
        userAgent: 'Agent',
        acceptLanguage: 'de-CH',
        origin: 'https://21.gifts',
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
        clientIp: null,
        clientCountry: null,
        cfRay: null,
        userAgent: null,
        acceptLanguage: null,
        origin: null,
      },
    ]);
  });

  it('listPage maps rows and binds the keyset params', async () => {
    const sql = new MockSql();
    const before = { createdAt: new Date('2026-09-19T13:00:00.000Z'), id: 'b' };
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
        client_ip: '192.0.2.1',
        client_country: 'CH',
        cf_ray: '0123456789abcdef-ZRH',
        user_agent: 'Agent',
        accept_language: 'de-CH',
        origin: 'https://21.gifts',
      },
    ];
    const listed = await new PostgresApiLogStore(sql).listPage(50, { accountId: 'acc', before });
    expect(sql.queries[0]?.text).toMatch(/\$1::uuid IS NULL OR account_id = \$1::uuid/);
    expect(sql.queries[0]?.text).toMatch(/\$2::timestamptz IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/created_at = \$2 AND id < \$3::uuid/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT \$4/);
    expect(sql.queries[0]?.params).toEqual(['acc', before.createdAt, 'b', 50]);
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
        clientIp: '192.0.2.1',
        clientCountry: 'CH',
        cfRay: '0123456789abcdef-ZRH',
        userAgent: 'Agent',
        acceptLanguage: 'de-CH',
        origin: 'https://21.gifts',
      },
    ]);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresApiLogStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('propagates listPage query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresApiLogStore(sql).listPage(10)).rejects.toThrow('list boom');
  });

  it('propagates append execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    await expect(new PostgresApiLogStore(sql).append(EARLY)).rejects.toThrow('insert boom');
  });
});
