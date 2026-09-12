import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { TrustEdge } from '@/lib/trust';
import {
  InMemoryTrustStore,
  TRUST_SCHEMA_SQL,
  migrateTrustSchema,
  PostgresTrustStore,
} from '@/lib/trust-store';

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

const EARLY: TrustEdge = {
  id: 'a',
  subjectId: 'sub',
  actorId: 'act',
  kind: 'verify',
  createdAt: Date.parse('2026-08-01T00:00:00.000Z'),
};

const LATE: TrustEdge = {
  id: 'b',
  subjectId: 'sub',
  actorId: 'act-2',
  kind: 'moderator_propose',
  createdAt: Date.parse('2026-08-02T00:00:00.000Z'),
};

const TIE_HIGH: TrustEdge = {
  id: 'z',
  subjectId: 'other',
  actorId: 'act',
  kind: 'verify',
  createdAt: Date.parse('2026-08-03T00:00:00.000Z'),
};

const TIE_LOW: TrustEdge = {
  id: 'm',
  subjectId: 'other',
  actorId: 'act',
  kind: 'moderator_appoint',
  createdAt: Date.parse('2026-08-03T00:00:00.000Z'),
};

describe('TRUST_SCHEMA_SQL', () => {
  it('creates trust_edge, the subject-kind unique index, and the actor index', () => {
    expect(TRUST_SCHEMA_SQL).toHaveLength(3);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS trust_edge/i);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/subject_id uuid NOT NULL REFERENCES account/i);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/CHECK \(subject_id <> actor_id\)/);
    expect(TRUST_SCHEMA_SQL[1]).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS trust_edge_subject_kind_uidx/,
    );
    expect(TRUST_SCHEMA_SQL[2]).toMatch(/CREATE INDEX IF NOT EXISTS trust_edge_actor_idx/);
  });
});

describe('migrateTrustSchema', () => {
  it('runs every TRUST_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateTrustSchema(sql);
    expect(sql.executes.map((item) => item.text)).toEqual([...TRUST_SCHEMA_SQL]);
  });
});

describe('InMemoryTrustStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryTrustStore().listEdges()).toEqual([]);
    expect(await new InMemoryTrustStore().listEdgesForSubject('sub')).toEqual([]);
  });

  it('copies the seed and listed rows so callers cannot mutate store state', async () => {
    const seed: TrustEdge[] = [EARLY, LATE];
    const store = new InMemoryTrustStore(seed);
    seed.pop();
    seed[0] = { ...LATE, kind: 'moderator_confirm' };
    const listed = await store.listEdges();
    expect(listed).toHaveLength(2);
    listed.pop();
    if (listed[0] !== undefined) {
      listed[0].kind = 'moderator_appoint';
    }
    const again = await store.listEdges();
    expect(again).toHaveLength(2);
    expect(again.map((row) => row.kind).sort()).toEqual(['moderator_propose', 'verify']);
  });

  it('returns oldest createdAt first and breaks ties by id ascending', async () => {
    const store = new InMemoryTrustStore([LATE, EARLY, TIE_HIGH, TIE_LOW]);
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['a', 'b', 'm', 'z']);
  });

  it('keeps equal id and createdAt as a sort tie', async () => {
    const dup: TrustEdge = { ...TIE_HIGH };
    const store = new InMemoryTrustStore([TIE_HIGH, dup]);
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['z', 'z']);
  });

  it('listEdgesForSubject filters and keeps oldest-first order', async () => {
    const store = new InMemoryTrustStore([LATE, EARLY, TIE_HIGH]);
    expect((await store.listEdgesForSubject('sub')).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('insertEdge then list returns a copy of the new row', async () => {
    const store = new InMemoryTrustStore();
    const created = await store.insertEdge(EARLY);
    expect(created.kind).toBe('verify');
    expect(created).not.toBe(EARLY);
    expect((await store.listEdges())[0]?.id).toBe('a');
  });

  it('insertEdge throws duplicate trust edge for the same subjectId and kind', async () => {
    const store = new InMemoryTrustStore([EARLY]);
    await expect(
      store.insertEdge({ ...EARLY, id: 'other', actorId: 'someone-else' }),
    ).rejects.toThrow('duplicate trust edge');
  });
});

describe('PostgresTrustStore', () => {
  it('maps rows and lists oldest-first without a subject filter', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'e1',
        subject_id: 'sub',
        actor_id: 'act',
        kind: 'verify',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'e2',
        subject_id: 'sub',
        actor_id: 'act-2',
        kind: 'moderator_propose',
        created_at: '2026-08-29T12:00:00.000Z',
      },
    ];
    const store = new PostgresTrustStore(sql);
    const listed = await store.listEdges();
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, subject_id, actor_id, kind, created_at FROM trust_edge ORDER BY created_at ASC, id ASC/,
    );
    expect(sql.queries[0]?.params).toEqual([]);
    expect(listed).toEqual([
      {
        id: 'e1',
        subjectId: 'sub',
        actorId: 'act',
        kind: 'verify',
        createdAt: Date.parse('2026-08-28T12:00:00.000Z'),
      },
      {
        id: 'e2',
        subjectId: 'sub',
        actorId: 'act-2',
        kind: 'moderator_propose',
        createdAt: Date.parse('2026-08-29T12:00:00.000Z'),
      },
    ]);
  });

  it('listEdgesForSubject binds the subject id', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const listed = await new PostgresTrustStore(sql).listEdgesForSubject('sub');
    expect(sql.queries[0]?.text).toMatch(/WHERE subject_id = \$1/);
    expect(sql.queries[0]?.params).toEqual(['sub']);
    expect(listed).toEqual([]);
  });

  it('insertEdge binds columns and does not use ON CONFLICT', async () => {
    const sql = new MockSql();
    const created = await new PostgresTrustStore(sql).insertEdge(EARLY);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO trust_edge \(id, subject_id, actor_id, kind, created_at\) VALUES \(\$1,\$2,\$3,\$4,\$5\)/,
    );
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual([
      EARLY.id,
      EARLY.subjectId,
      EARLY.actorId,
      EARLY.kind,
      new Date(EARLY.createdAt),
    ]);
    expect(created).toEqual(EARLY);
    expect(created).not.toBe(EARLY);
  });

  it('insertEdge maps unique violation 23505 to duplicate trust edge', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(new PostgresTrustStore(sql).insertEdge(EARLY)).rejects.toThrow(
      'duplicate trust edge',
    );
  });

  it('insertEdge rethrows non-unique execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('fk boom'), { code: '23503' });
    await expect(new PostgresTrustStore(sql).insertEdge(EARLY)).rejects.toThrow('fk boom');
  });

  it('insertEdge rethrows null execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = null;
    await expect(new PostgresTrustStore(sql).insertEdge(EARLY)).rejects.toBeNull();
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresTrustStore(sql).listEdges()).rejects.toThrow('list boom');
    await expect(new PostgresTrustStore(sql).listEdgesForSubject('sub')).rejects.toThrow(
      'list boom',
    );
  });
});
