import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
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
  ...unsignedNostrDefaults(),
};

const LATE: MessageRow = {
  id: 'b',
  accountId: 'acc',
  name: 'Ada',
  text: 'second',
  createdAt: new Date('2026-08-02T00:00:00.000Z'),
  ...unsignedNostrDefaults(),
};

const TIE_HIGH: MessageRow = {
  id: 'z',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-high',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
  ...unsignedNostrDefaults(),
};

const TIE_LOW: MessageRow = {
  id: 'm',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-low',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
  ...unsignedNostrDefaults(),
};

describe('MESSAGE_SCHEMA_SQL', () => {
  it('creates message and its created_at index', () => {
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS message/i);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/account_id uuid NOT NULL REFERENCES account/i);
    expect(MESSAGE_SCHEMA_SQL[1]).toMatch(/CREATE INDEX IF NOT EXISTS message_created_at_idx/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/event_id/);
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

  it('updates signed events, publish state, and sats', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect(await store.updateSignedEvent('a', 'ee'.repeat(32), { id: 'ee'.repeat(32) })).toBe(true);
    await store.create(LATE);
    expect(await store.updateSignedEvent('b', 'ee'.repeat(32), { id: 'ee'.repeat(32) })).toBe(
      false,
    );
    expect(await store.updateSignedEvent('missing', 'ff'.repeat(32), {})).toBe(false);
    await store.updatePublishState('a', 'published', 'public');
    await store.addSats('a', 21);
    const row = await store.getById('a');
    expect(row?.eventId).toBe('ee'.repeat(32));
    expect(row?.nostrPublishState).toBe('published');
    expect(row?.sats).toBe(21);
    const unpublished = await store.claimUnpublished(10, 1_000, 60_000);
    expect(unpublished).toEqual([]);
  });

  it('getById and claimUnsigned lease a row', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect((await store.getById('a'))?.text).toBe('first');
    const claimed = await store.claimUnsigned(10, 1_000, 60_000);
    expect(claimed.map((row) => row.id)).toEqual(['a']);
    const again = await store.claimUnsigned(10, 1_000, 60_000);
    expect(again).toEqual([]);
    await store.create(LATE);
    const one = await store.claimUnsigned(1, 2_000_000, 60_000);
    expect(one).toHaveLength(1);
  });

  it('getByEventId returns the row for a stored eventId and undefined when missing', async () => {
    const store = new InMemoryMessageStore();
    const eventId = 'ee'.repeat(32);
    await store.create({ ...EARLY, eventId });
    expect((await store.getByEventId(eventId))?.id).toBe('a');
    expect(await store.getByEventId('ff'.repeat(32))).toBeUndefined();
  });

  it('recordZapReceipt adds sats once per receiptEventId', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect(await store.recordZapReceipt('r1', 'a', 21)).toBe(true);
    expect((await store.getById('a'))?.sats).toBe(21);
    expect(await store.recordZapReceipt('r1', 'a', 21)).toBe(false);
    expect((await store.getById('a'))?.sats).toBe(21);
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
      /FROM message ORDER BY created_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed[0]?.id).toBe('m1');
    expect(listed[0]?.sats).toBe(0);
    expect(listed[1]?.id).toBe('m2');
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
      ...unsignedNostrDefaults(),
    };
    const created = await store.create(row);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO message \(id, account_id, name, text, created_at, nostr_publish_state, sats\)/,
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

  it('getById maps a row and claim SQL runs', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    expect((await store.getById('m1'))?.id).toBe('m1');
    sql.nextRows = [];
    expect(await store.getById('missing')).toBeUndefined();
    sql.nextRows = [
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: '2026-08-28T00:00:00.000Z',
        claimed_until: new Date('2026-08-28T00:01:00.000Z'),
        nostr_first_attempt_at: '2026-08-28T00:00:30.000Z',
        nostr_publish_state: 'weird',
      },
    ];
    const mapped = await store.getById('m2');
    expect(mapped?.nostrPublishState).toBe('pending');
    expect(mapped?.claimedUntil).toBe(Date.parse('2026-08-28T00:01:00.000Z'));
    sql.nextRows = [];
    expect(await store.claimUnsigned(5, 1_000, 60_000)).toEqual([]);
    expect(await store.claimUnpublished(5, 1_000, 60_000)).toEqual([]);
    expect(await store.updateSignedEvent('m1', 'ee'.repeat(32), { id: 'x' })).toBe(false);
    await store.updatePublishState('m1', 'published', 'public');
    await store.addSats('m1', 7);
    expect(sql.executes.some((e) => e.text.includes('sats = sats +'))).toBe(true);
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
        ...unsignedNostrDefaults(),
      }),
    ).rejects.toThrow('create boom');
  });

  it('getByEventId SQL matches event_id and the same SELECT column list as getById', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        event_id: 'ee'.repeat(32),
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    expect((await store.getByEventId('ee'.repeat(32)))?.id).toBe('m1');
    expect(sql.queries[0]?.text).toMatch(/event_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, account_id, name, text, created_at, event_id, nostr_publish_state, sats,/,
    );
    expect(sql.queries[0]?.text).toMatch(
      /nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts/,
    );
    sql.nextRows = [];
    expect(await store.getByEventId('missing')).toBeUndefined();
  });

  it('recordZapReceipt success inserts then adds sats', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ event_id: 'r1' }];
    const store = new PostgresMessageStore(sql);
    expect(await store.recordZapReceipt('r1', 'm1', 21)).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/nostr_zap_receipt/);
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT/);
    expect(sql.queries[0]?.text).toMatch(/UPDATE message SET sats = sats \+/);
    expect(sql.executes).toEqual([]);
  });

  it('recordZapReceipt conflict returns false without sats update', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    expect(await store.recordZapReceipt('r1', 'm1', 21)).toBe(false);
    expect(sql.executes).toEqual([]);
  });

  it('getById maps nostr_event JSON string', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        event_id: 'abc123',
        nostr_publish_state: 'pending',
        sats: 0,
        nostr_event: JSON.stringify({ id: 'abc123', kind: 1 }),
      },
    ];
    const mapped = await new PostgresMessageStore(sql).getById('m1');
    expect(mapped?.nostrEvent?.['id']).toBe('abc123');
  });

  it('listPendingSigned and clearSignedEvent round-trip in memory', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.updateSignedEvent('a', 'ab'.repeat(32), { id: 'x' });
    expect((await store.listPendingSigned(10)).map((row) => row.id)).toEqual(['a']);
    await store.clearSignedEvent('a');
    expect(await store.listPendingSigned(10)).toEqual([]);
    expect((await store.getById('a'))?.eventId).toBeNull();
    await store.clearSignedEvent('missing');
    await store.updateSignedEvent('a', 'cd'.repeat(32), {
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
      ],
    });
    await store.updatePublishState('a', 'published', 'space');
    await store.clearSignedEvent('a');
    expect((await store.getById('a'))?.eventId).toBe('cd'.repeat(32));
  });

  it('listPendingSigned skips pending rows that already have t=bitcoin', async () => {
    const store = new InMemoryMessageStore();
    await store.create(LATE);
    await store.create(EARLY);
    await store.create(TIE_HIGH);
    await store.create(TIE_LOW);
    await store.updateSignedEvent('b', '11'.repeat(32), {
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
      ],
    });
    await store.updateSignedEvent('a', '22'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    await store.updateSignedEvent('z', '33'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    await store.updateSignedEvent('m', '44'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    expect((await store.listPendingSigned(10)).map((row) => row.id)).toEqual(['a', 'm', 'z']);
  });

  it('listPendingSigned and clearSignedEvent hit Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    expect((await store.listPendingSigned(7))[0]?.id).toBe('m1');
    expect(sql.queries.at(-1)?.text).toMatch(/event_id IS NOT NULL/);
    await store.clearSignedEvent('m1');
    expect(sql.executes.at(-1)?.text).toMatch(/event_id = NULL/);
  });
});
