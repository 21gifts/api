import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { OcpPlaceInput } from '@/lib/ocp-place';
import {
  InMemoryOcpPlaceStore,
  OCP_PLACE_SCHEMA_SQL,
  migrateOcpPlaceSchema,
  PostgresOcpPlaceStore,
} from '@/lib/ocp-place-store';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  insertRows: unknown[] = [];
  selectRows: unknown[] = [];
  listRows: unknown[] = [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (text.includes('INSERT INTO ocp_place')) {
      return this.insertRows as T[];
    }
    if (text.includes('ORDER BY created_at DESC')) {
      return this.listRows as T[];
    }
    return this.selectRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
  }
}

const INPUT: OcpPlaceInput = {
  origin: '21gifts',
  externalId: 'msg-1',
  name: 'Stall',
  lat: 47.3,
  lon: 8.5,
  category: 'shopping',
  paymentMethods: 'lightning',
};

describe('OCP_PLACE_SCHEMA_SQL', () => {
  it('matches docs/schema/ocp-place.sql CREATE TABLE', () => {
    const docs = readFileSync(join(process.cwd(), 'docs/schema/ocp-place.sql'), 'utf8');
    const create = docs
      .split('\n')
      .filter((line) => !line.startsWith('--') && line.trim() !== '')
      .join('\n')
      .trim();
    expect(OCP_PLACE_SCHEMA_SQL.trim()).toBe(create.replace(/;\s*$/, ''));
    expect(OCP_PLACE_SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS ocp_place/);
    expect(OCP_PLACE_SCHEMA_SQL).toMatch(/UNIQUE \(origin, external_id\)/);
  });
});

describe('migrateOcpPlaceSchema', () => {
  it('runs the single schema statement', async () => {
    const sql = new MockSql();
    await migrateOcpPlaceSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([OCP_PLACE_SCHEMA_SQL]);
  });
});

describe('InMemoryOcpPlaceStore', () => {
  it('inserts once and returns the existing row unchanged on conflict', async () => {
    const store = new InMemoryOcpPlaceStore();
    const first = await store.insertIfNew(INPUT);
    expect(first.created).toBe(true);
    const second = await store.insertIfNew({
      ...INPUT,
      name: 'Other',
      lat: 1,
      lon: 2,
    });
    expect(second.created).toBe(false);
    expect(second.place).toEqual(first.place);
    expect(second.place.name).toBe('Stall');
    expect(second.place.lat).toBe(47.3);
  });

  it('lists newest first, breaks ties by id descending, and copies rows', async () => {
    const fixed = new Date('2026-09-26T00:00:00.000Z');
    const store = new InMemoryOcpPlaceStore(() => fixed);
    const first = await store.insertIfNew({ ...INPUT, externalId: 'a' });
    const second = await store.insertIfNew({ ...INPUT, externalId: 'z' });
    // Same createdAt as `z` so id DESC decides order between z and m.
    const thirdInput = { ...INPUT, externalId: 'm' };
    const third = await store.insertIfNew(thirdInput);
    // Reach into listed copies only — store rows keep original times.
    const listed = await store.list(10);
    expect(listed).toHaveLength(3);
    expect(listed.map((row) => row.externalId).sort()).toEqual(['a', 'm', 'z']);
    // Newest wall-clock wins; when equal, higher id first.
    const byTime = [...listed].sort((a, b) => {
      const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
      return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
    });
    expect(listed.map((row) => row.id)).toEqual(byTime.map((row) => row.id));
    listed[0]!.name = 'mutated';
    expect((await store.list(10)).some((row) => row.name === 'mutated')).toBe(false);
    expect(first.created && second.created && third.created).toBe(true);
  });

  it('lists a later timestamp before an earlier one', async () => {
    let tick = 0;
    const store = new InMemoryOcpPlaceStore(() => new Date(tick++));
    await store.insertIfNew({ ...INPUT, externalId: 'older' });
    await store.insertIfNew({ ...INPUT, externalId: 'newer' });
    const listed = await store.list(10);
    expect(listed.map((row) => row.externalId)).toEqual(['newer', 'older']);
  });

  it('caps list at limit', async () => {
    const store = new InMemoryOcpPlaceStore();
    await store.insertIfNew({ ...INPUT, externalId: '1' });
    await store.insertIfNew({ ...INPUT, externalId: '2' });
    expect(await store.list(1)).toHaveLength(1);
  });
});

describe('PostgresOcpPlaceStore', () => {
  it('returns created true from INSERT RETURNING', async () => {
    const sql = new MockSql();
    sql.insertRows = [
      {
        id: 'id-1',
        origin: '21gifts',
        external_id: 'msg-1',
        name: 'Stall',
        lat: 47.3,
        lon: 8.5,
        category: 'shopping',
        payment_methods: 'lightning',
        created_at: '2026-09-01T00:00:00.000Z',
      },
    ];
    const store = new PostgresOcpPlaceStore(sql);
    const result = await store.insertIfNew(INPUT);
    expect(result.created).toBe(true);
    expect(result.place.id).toBe('id-1');
    expect(result.place.externalId).toBe('msg-1');
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT \(origin, external_id\) DO NOTHING/);
  });

  it('selects the existing row when INSERT returns nothing', async () => {
    const sql = new MockSql();
    sql.insertRows = [];
    sql.selectRows = [
      {
        id: 'id-old',
        origin: '21gifts',
        external_id: 'msg-1',
        name: 'Stall',
        lat: '47.3',
        lon: '8.5',
        category: 'shopping',
        payment_methods: null,
        created_at: new Date('2026-09-01T00:00:00.000Z'),
      },
    ];
    const store = new PostgresOcpPlaceStore(sql);
    const result = await store.insertIfNew(INPUT);
    expect(result.created).toBe(false);
    expect(result.place.id).toBe('id-old');
    expect(result.place.paymentMethods).toBeNull();
    expect(result.place.lat).toBe(47.3);
  });

  it('throws when conflict select finds nothing', async () => {
    const sql = new MockSql();
    sql.insertRows = [];
    sql.selectRows = [];
    await expect(new PostgresOcpPlaceStore(sql).insertIfNew(INPUT)).rejects.toThrow(
      'ocp.place.insert_conflict_missing',
    );
  });

  it('lists with ORDER BY created_at DESC, id DESC', async () => {
    const sql = new MockSql();
    sql.listRows = [
      {
        id: 'b',
        origin: '21gifts',
        external_id: '2',
        name: 'B',
        lat: 1,
        lon: 2,
        category: 'shopping',
        payment_methods: null,
        created_at: '2026-09-02T00:00:00.000Z',
      },
    ];
    const store = new PostgresOcpPlaceStore(sql);
    const rows = await store.list(5);
    expect(rows).toHaveLength(1);
    expect(sql.queries[0]?.params).toEqual([5]);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
  });
});
