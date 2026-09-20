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
  queryImpl: ((text: string) => unknown[] | undefined) | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    const override = this.queryImpl?.(text);
    if (override !== undefined) {
      return override as T[];
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
  it('creates trust_edge, live unique index, kind check, and the actor index', () => {
    expect(TRUST_SCHEMA_SQL).toHaveLength(6);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS trust_edge/i);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/subject_id uuid NOT NULL REFERENCES account/i);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/CHECK \(subject_id <> actor_id\)/);
    expect(TRUST_SCHEMA_SQL[0]).toMatch(/moderator_reject/);
    expect(TRUST_SCHEMA_SQL[1]).toMatch(/DROP CONSTRAINT IF EXISTS trust_edge_kind_check/);
    expect(TRUST_SCHEMA_SQL[2]).toMatch(/ADD CONSTRAINT trust_edge_kind_check/);
    expect(TRUST_SCHEMA_SQL[2]).toMatch(/moderator_reject/);
    expect(TRUST_SCHEMA_SQL[3]).toMatch(/DROP INDEX IF EXISTS trust_edge_subject_kind_uidx/);
    expect(TRUST_SCHEMA_SQL[4]).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS trust_edge_subject_kind_live_uidx/,
    );
    expect(TRUST_SCHEMA_SQL[4]).toMatch(
      /WHERE kind IN \('verify', 'moderator_confirm', 'moderator_appoint'\)/,
    );
    expect(TRUST_SCHEMA_SQL[5]).toMatch(/CREATE INDEX IF NOT EXISTS trust_edge_actor_idx/);
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
    expect(await new InMemoryTrustStore().listEdgesTouching('sub')).toEqual([]);
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

  it('listEdgesTouching includes subject and actor ends', async () => {
    const asActor: TrustEdge = {
      id: 'act',
      subjectId: 'other',
      actorId: 'sub',
      kind: 'verify',
      createdAt: Date.parse('2026-08-04T00:00:00.000Z'),
    };
    const store = new InMemoryTrustStore([LATE, EARLY, TIE_HIGH, asActor]);
    expect((await store.listEdgesTouching('sub')).map((row) => row.id)).toEqual(['a', 'b', 'act']);
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

  it('inserts multiple moderator_propose and moderator_reject rows for one subject', async () => {
    const store = new InMemoryTrustStore();
    await store.insertEdge({ ...LATE, id: 'p1', createdAt: 1 });
    await store.insertEdge({ ...LATE, id: 'p2', actorId: 'act-3', createdAt: 2 });
    await store.insertEdge({
      ...LATE,
      id: 'r1',
      kind: 'moderator_reject',
      createdAt: 3,
    });
    await store.insertEdge({
      ...LATE,
      id: 'r2',
      actorId: 'act-3',
      kind: 'moderator_reject',
      createdAt: 4,
    });
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['p1', 'p2', 'r1', 'r2']);
    await store.insertEdge({ ...EARLY, id: 'v1' });
    await expect(store.insertEdge({ ...EARLY, id: 'v2', actorId: 'someone-else' })).rejects.toThrow(
      'duplicate trust edge',
    );
  });

  it('deleteEdge removes the matching row and leaves others', async () => {
    const store = new InMemoryTrustStore([EARLY, LATE]);
    const removed = await store.deleteEdge('sub', 'verify');
    expect(removed).toEqual(EARLY);
    expect(removed).not.toBe(EARLY);
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['b']);
  });

  it('deleteEdge returns undefined when no row matches', async () => {
    const store = new InMemoryTrustStore([EARLY]);
    expect(await store.deleteEdge('sub', 'moderator_confirm')).toBeUndefined();
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['a']);
  });

  it('deleteEdge removes the latest moderator_propose and leaves the older', async () => {
    const older: TrustEdge = {
      id: 'p-old',
      subjectId: 'sub',
      actorId: 'act',
      kind: 'moderator_propose',
      createdAt: 1,
    };
    const newer: TrustEdge = {
      id: 'p-new',
      subjectId: 'sub',
      actorId: 'act-2',
      kind: 'moderator_propose',
      createdAt: 2,
    };
    const store = new InMemoryTrustStore([older, newer]);
    const removed = await store.deleteEdge('sub', 'moderator_propose');
    expect(removed).toEqual(newer);
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['p-old']);
  });

  it('deleteEdge prefers the higher id when createdAt ties', async () => {
    const low: TrustEdge = {
      id: 'p-a',
      subjectId: 'sub',
      actorId: 'act',
      kind: 'moderator_propose',
      createdAt: 5,
    };
    const high: TrustEdge = {
      id: 'p-z',
      subjectId: 'sub',
      actorId: 'act-2',
      kind: 'moderator_propose',
      createdAt: 5,
    };
    const store = new InMemoryTrustStore([low, high]);
    const removed = await store.deleteEdge('sub', 'moderator_propose');
    expect(removed).toEqual(high);
    expect((await store.listEdges()).map((row) => row.id)).toEqual(['p-a']);
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

  it('listEdgesTouching binds subject or actor', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const listed = await new PostgresTrustStore(sql).listEdgesTouching('sub');
    expect(sql.queries[0]?.text).toMatch(/WHERE subject_id = \$1 OR actor_id = \$1/);
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

  it('insertEdge maps Bun errno unique violation 23505 to duplicate trust edge', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { errno: '23505' });
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

  it('deleteEdge selects the latest row then DELETE WHERE id', async () => {
    const sql = new MockSql();
    const mapped = {
      id: 'e1',
      subject_id: 'sub',
      actor_id: 'act',
      kind: 'moderator_confirm',
      created_at: new Date('2026-08-28T12:00:00.000Z'),
    };
    sql.queryImpl = (text) => {
      if (text.includes('DELETE')) {
        return [mapped];
      }
      return [mapped];
    };
    const removed = await new PostgresTrustStore(sql).deleteEdge('sub', 'moderator_confirm');
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, subject_id, actor_id, kind, created_at FROM trust_edge WHERE subject_id = \$1 AND kind = \$2 ORDER BY created_at DESC, id DESC LIMIT 1/,
    );
    expect(sql.queries[0]?.params).toEqual(['sub', 'moderator_confirm']);
    expect(sql.queries[1]?.text).toMatch(
      /DELETE FROM trust_edge WHERE id = \$1 RETURNING id, subject_id, actor_id, kind, created_at/,
    );
    expect(sql.queries[1]?.params).toEqual(['e1']);
    expect(removed).toEqual({
      id: 'e1',
      subjectId: 'sub',
      actorId: 'act',
      kind: 'moderator_confirm',
      createdAt: Date.parse('2026-08-28T12:00:00.000Z'),
    });
  });

  it('deleteEdge returns undefined when SELECT is empty', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresTrustStore(sql).deleteEdge('sub', 'verify')).toBeUndefined();
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC LIMIT 1/);
  });

  it('deleteEdge returns undefined when DELETE RETURNING is empty', async () => {
    const sql = new MockSql();
    sql.queryImpl = (text) => {
      if (text.includes('DELETE')) {
        return [];
      }
      return [
        {
          id: 'e1',
          subject_id: 'sub',
          actor_id: 'act',
          kind: 'verify',
          created_at: new Date('2026-08-28T12:00:00.000Z'),
        },
      ];
    };
    expect(await new PostgresTrustStore(sql).deleteEdge('sub', 'verify')).toBeUndefined();
    expect(sql.queries[1]?.params).toEqual(['e1']);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresTrustStore(sql).listEdges()).rejects.toThrow('list boom');
    await expect(new PostgresTrustStore(sql).listEdgesForSubject('sub')).rejects.toThrow(
      'list boom',
    );
    await expect(new PostgresTrustStore(sql).listEdgesTouching('sub')).rejects.toThrow('list boom');
    await expect(new PostgresTrustStore(sql).deleteEdge('sub', 'verify')).rejects.toThrow(
      'list boom',
    );
  });
});
