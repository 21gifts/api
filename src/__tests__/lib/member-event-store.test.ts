import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { parseMemberEventBatch } from '@/lib/member-event';
import {
  InMemoryMemberEventStore,
  MEMBER_EVENT_SCHEMA_SQL,
  migrateMemberEventSchema,
  PostgresMemberEventStore,
  type MemberEvent,
} from '@/lib/member-event-store';

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
const RECEIVED = new Date('2026-01-03T00:00:00.000Z');
const PHRASE_12 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';
const NSEC1 = 'nsec1abcdefghijklmnopqrstuvwxyz123456';
const SECRETS = [
  'preimage-secret-aaaa',
  'seed-secret-bbbb',
  'mnemonic-secret-cccc',
  'prf-secret-dddd',
  'privateKey-secret-eeee',
  'nsec-secret-ffff',
  PHRASE_12,
  NSEC1,
];

function row(partial: Partial<MemberEvent> & Pick<MemberEvent, 'id'>): MemberEvent {
  return {
    accountId: 'acc',
    name: 'login',
    at: T1,
    path: null,
    props: {},
    receivedAt: RECEIVED,
    ...partial,
  };
}

describe('MEMBER_EVENT_SCHEMA_SQL', () => {
  it('matches docs/schema/member_event.sql', () => {
    const docs = readFileSync(join(process.cwd(), 'docs/schema/member_event.sql'), 'utf8');
    expect(MEMBER_EVENT_SCHEMA_SQL).toHaveLength(2);
    for (const statement of MEMBER_EVENT_SCHEMA_SQL) {
      expect(docs).toContain(statement);
    }
    expect(MEMBER_EVENT_SCHEMA_SQL[0]).toContain('CREATE TABLE IF NOT EXISTS member_event');
    expect(MEMBER_EVENT_SCHEMA_SQL[1]).toContain(
      'CREATE INDEX IF NOT EXISTS member_event_account_at_idx ON member_event (account_id, at DESC, id DESC)',
    );
  });
});

describe('migrateMemberEventSchema', () => {
  it('executes MEMBER_EVENT_SCHEMA_SQL in order', async () => {
    const sql = new MockSql();
    await migrateMemberEventSchema(sql);
    expect(sql.executes).toHaveLength(MEMBER_EVENT_SCHEMA_SQL.length);
    for (let i = 0; i < MEMBER_EVENT_SCHEMA_SQL.length; i++) {
      expect(sql.executes[i]?.text).toBe(MEMBER_EVENT_SCHEMA_SQL[i]);
      expect(sql.executes[i]?.params).toEqual([]);
    }
  });

  it('stops later statements when execute throws', async () => {
    const sql = new MockSql();
    sql.failAt = 1;
    await expect(migrateMemberEventSchema(sql)).rejects.toThrow(/ddl failed/);
    expect(sql.executes).toHaveLength(1);
  });
});

describe('InMemoryMemberEventStore', () => {
  it('is a no-op for an empty appendMany', async () => {
    const store = new InMemoryMemberEventStore();
    await store.appendMany([]);
    expect(await store.listForAccount('acc', 10)).toEqual([]);
  });

  it('returns copies so callers cannot mutate stored props or timestamps', async () => {
    const store = new InMemoryMemberEventStore();
    const input = row({
      id: 'a',
      props: { keep: 'a' },
      path: '/home',
      at: new Date(T1.getTime()),
      receivedAt: new Date(RECEIVED.getTime()),
    });
    await store.appendMany([input]);
    input.props['keep'] = 'mutated-input';
    input.at.setTime(0);
    input.receivedAt.setTime(0);
    const listed = await store.listForAccount('acc', 10);
    const first = listed[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    first.props['keep'] = 'mutated-out';
    first.at.setTime(0);
    first.receivedAt.setTime(0);
    const again = await store.listForAccount('acc', 10);
    expect(again[0]?.props).toEqual({ keep: 'a' });
    expect(again[0]?.at.getTime()).toBe(T1.getTime());
    expect(again[0]?.receivedAt.getTime()).toBe(RECEIVED.getTime());
    expect(again[0]?.path).toBe('/home');
  });

  it('lists newest at first for one account and breaks ties with id descending', async () => {
    const store = new InMemoryMemberEventStore();
    await store.appendMany([
      row({ id: 'old', at: T1, accountId: 'acc' }),
      row({ id: 'new', at: T2, accountId: 'acc' }),
      row({ id: 'other', at: T2, accountId: 'other' }),
      row({ id: 'a', at: T1, accountId: 'acc' }),
      row({ id: 'b', at: new Date(T1.getTime()), accountId: 'acc' }),
    ]);
    expect((await store.listForAccount('acc', 10)).map((item) => item.id)).toEqual([
      'new',
      'old',
      'b',
      'a',
    ]);
    expect((await store.listForAccount('acc', 2)).map((item) => item.id)).toEqual(['new', 'old']);
    expect(await store.listForAccount('missing', 10)).toEqual([]);
  });
});

describe('PostgresMemberEventStore', () => {
  it('does not execute for an empty appendMany', async () => {
    const sql = new MockSql();
    await new PostgresMemberEventStore(sql).appendMany([]);
    expect(sql.executes).toEqual([]);
  });

  it('inserts one row with jsonb-cast props', async () => {
    const sql = new MockSql();
    const event = row({
      id: 'id-1',
      accountId: 'acc-1',
      name: 'screen_view',
      at: T2,
      path: '/home',
      props: { n: 1 },
    });
    await new PostgresMemberEventStore(sql).appendMany([event]);
    expect(sql.executes).toEqual([
      {
        text: 'INSERT INTO member_event (id, account_id, name, at, path, props, received_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
        params: ['id-1', 'acc-1', 'screen_view', T2, '/home', JSON.stringify({ n: 1 }), RECEIVED],
      },
    ]);
  });

  it('inserts several rows in one statement', async () => {
    const sql = new MockSql();
    await new PostgresMemberEventStore(sql).appendMany([
      row({ id: 'a', path: null }),
      row({ id: 'b', name: 'search', at: T2 }),
    ]);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toBe(
      'INSERT INTO member_event (id, account_id, name, at, path, props, received_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7), ($8,$9,$10,$11,$12,$13::jsonb,$14)',
    );
    expect(sql.executes[0]?.params).toEqual([
      'a',
      'acc',
      'login',
      T1,
      null,
      JSON.stringify({}),
      RECEIVED,
      'b',
      'acc',
      'search',
      T2,
      null,
      JSON.stringify({}),
      RECEIVED,
    ]);
  });

  it('listForAccount maps driver values and keeps only scalar or null props', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'date-row',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: '/home',
        props: '{"keep":"a","n":1,"b":true,"nil":null,"nested":{"x":1},"arr":[1]}',
        received_at: RECEIVED,
      },
      {
        id: 'iso-row',
        account_id: 'acc',
        name: 'search',
        at: T2.toISOString(),
        path: null,
        props: {
          keep: 'a',
          nested: { x: 1 },
          n: 1,
          skipNaN: Number.NaN,
          skipInf: Number.POSITIVE_INFINITY,
        },
        received_at: RECEIVED.toISOString(),
      },
      {
        id: 'bad-json',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: undefined,
        props: 'not-json',
        received_at: T2,
      },
      {
        id: 'num-json',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: null,
        props: '42',
        received_at: T2,
      },
      {
        id: 'null-props',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: null,
        props: null,
        received_at: T2,
      },
      {
        id: 'arr-props',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: null,
        props: [],
        received_at: T2,
      },
      {
        id: 'missing-props',
        account_id: 'acc',
        name: 'login',
        at: T2,
        path: null,
        props: undefined,
        received_at: T2,
      },
    ];
    const listed = await new PostgresMemberEventStore(sql).listForAccount('acc', 50);
    expect(sql.queries).toEqual([
      {
        text: 'SELECT id, account_id, name, at, path, props, received_at FROM member_event WHERE account_id = $1 ORDER BY at DESC, id DESC LIMIT $2',
        params: ['acc', 50],
      },
    ]);
    expect(listed.map((item) => item.id)).toEqual([
      'date-row',
      'iso-row',
      'bad-json',
      'num-json',
      'null-props',
      'arr-props',
      'missing-props',
    ]);
    expect(listed[0]?.at.getTime()).toBe(T2.getTime());
    expect(listed[0]?.receivedAt.getTime()).toBe(RECEIVED.getTime());
    expect(listed[0]?.path).toBe('/home');
    expect(listed[0]?.props).toEqual({ keep: 'a', n: 1, b: true, nil: null });
    expect(listed[1]?.at.getTime()).toBe(T2.getTime());
    expect(listed[1]?.receivedAt.getTime()).toBe(RECEIVED.getTime());
    expect(listed[1]?.path).toBeNull();
    expect(listed[1]?.props).toEqual({ keep: 'a', n: 1 });
    expect(listed[2]?.path).toBeNull();
    expect(listed[2]?.props).toEqual({});
    expect(listed[3]?.props).toEqual({});
    expect(listed[4]?.props).toEqual({});
    expect(listed[5]?.props).toEqual({});
    expect(listed[6]?.props).toEqual({});
  });

  it('does not persist secret keys or secret-shaped values in SQL params', async () => {
    const now = T2.getTime();
    const parsed = parseMemberEventBatch(
      {
        events: [
          {
            name: 'login',
            at: T2.toISOString(),
            preimage: SECRETS[0],
            seed: SECRETS[1],
            props: {
              preimage: SECRETS[0],
              seed: SECRETS[1],
              mnemonic: SECRETS[2],
              prf: SECRETS[3],
              privateKey: SECRETS[4],
              nsec: SECRETS[5],
              note: PHRASE_12,
              query: NSEC1,
              screen: 'home',
            },
          },
        ],
      },
      now,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const sql = new MockSql();
    const stored = parsed.events[0];
    expect(stored).toBeDefined();
    if (stored === undefined) {
      return;
    }
    await new PostgresMemberEventStore(sql).appendMany([
      {
        id: 'id-1',
        accountId: 'acc',
        name: stored.name,
        at: stored.at,
        path: stored.path,
        props: stored.props,
        receivedAt: T2,
      },
    ]);
    const dumped = JSON.stringify(sql.executes);
    for (const secret of SECRETS) {
      expect(dumped).not.toContain(secret);
    }
    expect(sql.executes[0]?.params[5]).toBe(JSON.stringify({ screen: 'home' }));
  });
});
