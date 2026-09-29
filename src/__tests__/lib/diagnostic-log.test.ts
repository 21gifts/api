import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  DIAGNOSTIC_SCHEMA_SQL,
  InMemoryDiagnosticStore,
  migrateDiagnosticSchema,
  PostgresDiagnosticStore,
  serializeDebugDiagnostic,
  type DiagnosticEvent,
} from '@/lib/diagnostic-log';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  failAt: number | undefined;
  nextRows: unknown[] = [];
  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return this.nextRows as T[];
  }
  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.failAt !== undefined && this.executes.length === this.failAt) {
      throw new Error('ddl failed');
    }
  }
}

const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-01-02T00:00:00.000Z');

function row(partial: Partial<DiagnosticEvent> & Pick<DiagnosticEvent, 'id'>): DiagnosticEvent {
  return {
    createdAt: T1,
    source: 'server',
    event: 'e',
    fields: {},
    ...partial,
  };
}

describe('migrateDiagnosticSchema', () => {
  it('executes DIAGNOSTIC_SCHEMA_SQL in order', async () => {
    const sql = new MockSql();
    await migrateDiagnosticSchema(sql);
    expect(sql.executes).toHaveLength(DIAGNOSTIC_SCHEMA_SQL.length);
    for (let i = 0; i < DIAGNOSTIC_SCHEMA_SQL.length; i++) {
      expect(sql.executes[i]?.text).toBe(DIAGNOSTIC_SCHEMA_SQL[i]);
      expect(sql.executes[i]?.params).toEqual([]);
    }
  });

  it('stops later statements when execute throws', async () => {
    const sql = new MockSql();
    sql.failAt = 1;
    await expect(migrateDiagnosticSchema(sql)).rejects.toThrow(/ddl failed/);
    expect(sql.executes).toHaveLength(1);
  });
});

describe('InMemoryDiagnosticStore', () => {
  it('returns copies so callers cannot mutate stored fields or createdAt', async () => {
    const store = new InMemoryDiagnosticStore();
    await store.append(row({ id: 'a', fields: { keep: 'a' }, createdAt: T1 }));
    const listed = await store.listLatest(10);
    const first = listed[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    first.fields['keep'] = 'mutated';
    first.createdAt.setTime(0);
    const again = await store.listLatest(10);
    expect(again[0]?.fields).toEqual({ keep: 'a' });
    expect(again[0]?.createdAt.getTime()).toBe(T1.getTime());
  });

  it('lists newest createdAt first even when the older row was appended first', async () => {
    const store = new InMemoryDiagnosticStore();
    await store.append(row({ id: 'old', createdAt: T1 }));
    await store.append(row({ id: 'new', createdAt: T2 }));
    expect((await store.listLatest(10)).map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('breaks equal createdAt ties with id descending via localeCompare', async () => {
    const store = new InMemoryDiagnosticStore();
    await store.append(row({ id: 'a', createdAt: T1 }));
    await store.append(row({ id: 'b', createdAt: new Date(T1.getTime()) }));
    expect((await store.listLatest(10)).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('truncates listLatest to the limit', async () => {
    const store = new InMemoryDiagnosticStore();
    await store.append(row({ id: 'a', createdAt: T1 }));
    await store.append(row({ id: 'b', createdAt: T2 }));
    await store.append(row({ id: 'c', createdAt: new Date('2026-01-03T00:00:00.000Z') }));
    expect((await store.listLatest(2)).map((item) => item.id)).toEqual(['c', 'b']);
  });
});

describe('PostgresDiagnosticStore', () => {
  it('append executes the exact insert', async () => {
    const sql = new MockSql();
    const event = row({
      id: 'id-1',
      createdAt: T2,
      source: 'client',
      event: 'client.passkey.register.begin',
      fields: { n: 1 },
    });
    await new PostgresDiagnosticStore(sql).append(event);
    expect(sql.executes).toEqual([
      {
        text: 'INSERT INTO diagnostic_event (id, created_at, source, event, fields) VALUES ($1,$2,$3,$4,$5::jsonb)',
        params: ['id-1', T2, 'client', 'client.passkey.register.begin', JSON.stringify({ n: 1 })],
      },
    ]);
  });

  it('listLatest maps rows and drops non-scalar fields and unknown sources', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'date-row',
        created_at: T2,
        source: 'server',
        event: 'e1',
        fields: '{"keep":"a","n":1,"b":true,"nested":{"x":1},"arr":[1],"nil":null}',
      },
      {
        id: 'iso-row',
        created_at: T2.toISOString(),
        source: 'client',
        event: 'e2',
        fields: { keep: 'a', nested: { x: 1 }, n: 1 },
      },
      {
        id: 'bad-json',
        created_at: T2,
        source: 'server',
        event: 'e3',
        fields: 'not-json',
      },
      {
        id: 'num-json',
        created_at: T2,
        source: 'server',
        event: 'e4',
        fields: '42',
      },
      {
        id: 'null-fields',
        created_at: T2,
        source: 'server',
        event: 'e5',
        fields: null,
      },
      {
        id: 'arr-fields',
        created_at: T2,
        source: 'server',
        event: 'e6',
        fields: [],
      },
      {
        id: 'other',
        created_at: T2,
        source: 'other',
        event: 'e7',
        fields: {},
      },
    ];
    const listed = await new PostgresDiagnosticStore(sql).listLatest(50);
    expect(sql.queries).toEqual([
      {
        text: 'SELECT id, created_at, source, event, fields FROM diagnostic_event ORDER BY created_at DESC, id DESC LIMIT $1',
        params: [50],
      },
    ]);
    expect(listed.map((item) => item.id)).toEqual([
      'date-row',
      'iso-row',
      'bad-json',
      'num-json',
      'null-fields',
      'arr-fields',
    ]);
    expect(listed[0]?.createdAt.getTime()).toBe(T2.getTime());
    expect(listed[1]?.createdAt.getTime()).toBe(T2.getTime());
    expect(listed[0]?.fields).toEqual({ keep: 'a', n: 1, b: true });
    expect(listed[1]?.fields).toEqual({ keep: 'a', n: 1 });
    expect(listed[2]?.fields).toEqual({});
    expect(listed[3]?.fields).toEqual({});
    expect(listed[4]?.fields).toEqual({});
    expect(listed[5]?.fields).toEqual({});
  });
});

describe('serializeDebugDiagnostic', () => {
  it('emits ISO createdAt and a copy of fields', () => {
    const fields = { keep: 'a' };
    const event = row({ id: 'x', createdAt: T2, fields });
    const out = serializeDebugDiagnostic(event);
    expect(out.createdAt).toBe(T2.toISOString());
    expect(out.fields).toEqual({ keep: 'a' });
    out.fields['keep'] = 'mutated';
    expect(event.fields).toEqual({ keep: 'a' });
  });
});

describe('boot store migrate order', () => {
  it('calls migrateDiagnosticSchema after banner and before db_change', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/boot-stores.ts'), 'utf8');
    const banner = source.indexOf('migrateBannerSchema(sqlClient)');
    const diagnostic = source.indexOf('migrateDiagnosticSchema(sqlClient)');
    const dbChange = source.indexOf('migrateDbChangeSchema(sqlClient)');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(diagnostic).toBeGreaterThanOrEqual(0);
    expect(dbChange).toBeGreaterThanOrEqual(0);
    expect(diagnostic).toBeGreaterThan(banner);
    expect(diagnostic).toBeLessThan(dbChange);
  });
});
