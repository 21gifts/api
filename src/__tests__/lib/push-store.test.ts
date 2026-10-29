import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryPushStore,
  PUSH_SCHEMA_SQL,
  migratePushSchema,
  PostgresPushStore,
  type PushOutboxRow,
  type PushSubscriptionRecord,
} from '@/lib/push-store';

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

const SUB: PushSubscriptionRecord = {
  endpoint: 'https://push.example/a',
  accountId: 'acc-a',
  p256dh: 'p256',
  auth: 'auth',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  sessionToken: null,
};

function pending(
  overrides: Partial<PushOutboxRow> & Pick<PushOutboxRow, 'id' | 'accountId'>,
): PushOutboxRow {
  return {
    type: 'forum',
    messageId: 'msg',
    payload: '{}',
    status: 'pending',
    attempts: 0,
    claimedUntil: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    finishedAt: null,
    deliveredEndpoints: [],
    skipEndpoints: [],
    ...overrides,
  };
}

describe('PUSH_SCHEMA_SQL', () => {
  it('creates push_subscription and push_outbox with indexes', () => {
    expect(PUSH_SCHEMA_SQL).toHaveLength(9);
    expect(PUSH_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS push_subscription/i);
    expect(PUSH_SCHEMA_SQL[1]).toMatch(/push_subscription_account_id_idx/i);
    expect(PUSH_SCHEMA_SQL[2]).toMatch(
      /ALTER TABLE push_subscription ADD COLUMN IF NOT EXISTS session_token text$/,
    );
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/CREATE TABLE IF NOT EXISTS push_outbox/i);
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/delivered_endpoints/);
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/skip_endpoints/);
    expect(PUSH_SCHEMA_SQL[4]).toMatch(/push_outbox_pending_idx/i);
    expect(PUSH_SCHEMA_SQL[5]).toMatch(/ADD COLUMN IF NOT EXISTS delivered_endpoints/i);
    expect(PUSH_SCHEMA_SQL[6]).toMatch(/ADD COLUMN IF NOT EXISTS skip_endpoints/i);
    expect(PUSH_SCHEMA_SQL[7]).toMatch(/ADD COLUMN IF NOT EXISTS finished_at timestamptz$/);
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/'conversation'/);
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/'dismiss'/);
    expect(PUSH_SCHEMA_SQL[8]).toMatch(/push_outbox_type_check/);
    expect(PUSH_SCHEMA_SQL[8]).toMatch(/'conversation'/);
    expect(PUSH_SCHEMA_SQL[8]).toMatch(/'dismiss'/);
  });
});

describe('migratePushSchema', () => {
  it('runs every PUSH_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migratePushSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...PUSH_SCHEMA_SQL]);
  });
});

describe('InMemoryPushStore', () => {
  it('upserts, rebinds account and session, and keeps original createdAt', async () => {
    const store = new InMemoryPushStore();
    const first = await store.upsertSubscription({ ...SUB, sessionToken: 'tok-1' });
    expect(first.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    expect(first.sessionToken).toBe('tok-1');
    const later = new Date('2026-08-10T00:00:00.000Z');
    const rebound = await store.upsertSubscription({
      ...SUB,
      accountId: 'acc-b',
      p256dh: 'new',
      auth: 'new-auth',
      createdAt: later,
      sessionToken: 'tok-2',
    });
    expect(rebound.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    expect(rebound.sessionToken).toBe('tok-2');
    const listed = await store.listByAccount('acc-b');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.accountId).toBe('acc-b');
    expect(listed[0]?.sessionToken).toBe('tok-2');
    expect(listed[0]?.p256dh).toBe('new');
    expect(listed[0]?.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    expect(await store.listByAccount('acc-a')).toEqual([]);
  });

  it('copies listed rows so callers cannot mutate store state', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB);
    const listed = await store.listByAccount('acc-a');
    if (listed[0] !== undefined) {
      listed[0].auth = 'mutated';
      listed[0].createdAt.setTime(0);
    }
    const again = await store.listByAccount('acc-a');
    expect(again[0]?.auth).toBe('auth');
    expect(again[0]?.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
  });

  it('deleteSubscription returns false when missing or wrong account', async () => {
    const store = new InMemoryPushStore();
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(false);
    await store.upsertSubscription(SUB);
    expect(await store.deleteSubscription('other', SUB.endpoint)).toBe(false);
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(true);
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(false);
  });

  it('deleteStaleSubscription removes only a row that still matches account and session', async () => {
    const store = new InMemoryPushStore();
    expect(await store.deleteStaleSubscription(SUB)).toBe(false);
    await store.upsertSubscription({ ...SUB, sessionToken: 'tok-new' });
    expect(await store.deleteStaleSubscription(SUB)).toBe(false);
    expect(
      await store.deleteStaleSubscription({ ...SUB, accountId: 'other', sessionToken: 'tok-new' }),
    ).toBe(false);
    expect(await store.listByAccount('acc-a')).toHaveLength(1);
    expect(await store.deleteStaleSubscription({ ...SUB, sessionToken: 'tok-new' })).toBe(true);
    expect(await store.listByAccount('acc-a')).toEqual([]);
  });

  it('removeAccountSubscriptions deletes every subscription of one account and counts them', async () => {
    const store = new InMemoryPushStore();
    expect(store.removeAccountSubscriptions('acc-a')).toBe(0);
    await store.upsertSubscription(SUB);
    await store.upsertSubscription({ ...SUB, endpoint: 'https://push.example/b' });
    await store.upsertSubscription({
      ...SUB,
      endpoint: 'https://push.example/c',
      accountId: 'acc-b',
    });
    expect(store.removeAccountSubscriptions('acc-a')).toBe(2);
    expect(await store.listByAccount('acc-a')).toEqual([]);
    expect((await store.listByAccount('acc-b')).map((row) => row.endpoint)).toEqual([
      'https://push.example/c',
    ]);
  });

  it('lists distinct account ids with subscriptions', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB);
    await store.upsertSubscription({
      ...SUB,
      endpoint: 'https://push.example/b',
      accountId: 'acc-b',
    });
    await store.upsertSubscription({
      ...SUB,
      endpoint: 'https://push.example/c',
      accountId: 'acc-a',
    });
    const ids = await store.listAccountIdsWithSubscriptions();
    expect(ids.sort()).toEqual(['acc-a', 'acc-b']);
  });

  it('claims pending by oldest createdAt then id and respects lease', async () => {
    const store = new InMemoryPushStore();
    await store.enqueue(
      pending({
        id: 'b',
        accountId: 'a',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      }),
    );
    await store.enqueue(
      pending({
        id: 'a',
        accountId: 'a',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      }),
    );
    await store.enqueue(
      pending({
        id: 'early',
        accountId: 'a',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
    );
    const now = Date.parse('2026-08-03T00:00:00.000Z');
    const first = await store.claimPending(2, now, 60_000);
    expect(first.map((r) => r.id)).toEqual(['early', 'a']);
    expect(first[0]?.claimedUntil?.getTime()).toBe(now + 60_000);
    const stillHeld = await store.claimPending(10, now + 1_000, 60_000);
    expect(stillHeld.map((r) => r.id)).toEqual(['b']);
    const afterExpiry = await store.claimPending(10, now + 60_001, 60_000);
    expect(afterExpiry.map((r) => r.id).sort()).toEqual(['a', 'early']);
  });

  it('skips non-pending rows when claiming', async () => {
    const store = new InMemoryPushStore();
    await store.enqueue(pending({ id: 's', accountId: 'a', status: 'sent' }));
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });

  it('markSent and markFailed including terminal at 8 attempts', async () => {
    const store = new InMemoryPushStore();
    await store.enqueue(pending({ id: 'x', accountId: 'a' }));
    await store.markSent('missing', 5);
    await store.markFailed('missing', 5);
    await store.markSent('x', 5);
    const claimed = await store.claimPending(10, 1, 1000);
    expect(claimed).toEqual([]);
    expect((await store.listAllOutbox(10))[0]?.finishedAt?.getTime()).toBe(5);

    await store.enqueue(pending({ id: 'y', accountId: 'a' }));
    for (let i = 0; i < 7; i += 1) {
      await store.markFailed('y', 6);
    }
    const requeued = await store.claimPending(10, 1, 1000);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]?.attempts).toBe(7);
    expect(requeued[0]?.claimedUntil).not.toBeNull();
    expect(requeued[0]?.finishedAt).toBeNull();
    await store.markFailed('y', 9);
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
    const failed = (await store.listAllOutbox(10)).find((row) => row.id === 'y');
    expect(failed?.status).toBe('failed');
    expect(failed?.finishedAt?.getTime()).toBe(9);
  });

  it('deleteFinishedOutbox drops only sent/failed rows that finished before the cutoff', async () => {
    const store = new InMemoryPushStore();
    const created = new Date(1_000);
    await store.enqueue(pending({ id: 'old-pending', accountId: 'a', createdAt: created }));
    await store.enqueue(
      pending({ id: 'old-sent', accountId: 'a', status: 'sent', finishedAt: new Date(2_000) }),
    );
    await store.enqueue(
      pending({ id: 'old-failed', accountId: 'a', status: 'failed', finishedAt: new Date(2_000) }),
    );
    await store.enqueue(
      pending({ id: 'new-sent', accountId: 'a', status: 'sent', finishedAt: new Date(10_000) }),
    );
    // Finished before `finishedAt` existed: ages from createdAt.
    await store.enqueue(
      pending({ id: 'legacy-sent', accountId: 'a', status: 'sent', createdAt: created }),
    );
    await store.enqueue(
      pending({
        id: 'legacy-new',
        accountId: 'a',
        status: 'failed',
        createdAt: new Date(10_000),
      }),
    );
    expect(await store.deleteFinishedOutbox(5_000)).toBe(3);
    const left = (await store.listAllOutbox(10)).map((row) => row.id).sort();
    expect(left).toEqual(['legacy-new', 'new-sent', 'old-pending']);
    expect(await store.deleteFinishedOutbox(5_000)).toBe(0);
  });

  it('recordDelivered unions unique endpoints and isolates claimed copies', async () => {
    const store = new InMemoryPushStore();
    await store.enqueue(pending({ id: 'o', accountId: 'a' }));
    await store.recordDelivered('missing', ['https://push.example/x']);
    await store.recordDelivered('o', ['https://push.example/a', 'https://push.example/a', '']);
    await store.recordDelivered('o', ['https://push.example/b']);
    const claimed = await store.claimPending(10, 1, 1000);
    expect(claimed[0]?.deliveredEndpoints).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ]);
    claimed[0]?.deliveredEndpoints.push('https://push.example/mutated');
    await store.markFailed('o', 1);
    const again = await store.claimPending(10, 1, 1000);
    expect(again[0]?.deliveredEndpoints).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ]);
  });
});

describe('PostgresPushStore', () => {
  it('upserts with ON CONFLICT and maps list/delete/enqueue/claim/mark', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: SUB.accountId,
        p256dh: SUB.p256dh,
        auth: SUB.auth,
        created_at: SUB.createdAt,
      },
    ];
    const stored = await store.upsertSubscription(SUB);
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT \(endpoint\) DO UPDATE/i);
    expect(sql.queries[0]?.text).toMatch(/RETURNING/i);
    expect(sql.queries[0]?.text).not.toMatch(/created_at = EXCLUDED/i);
    expect(sql.queries[0]?.text).toMatch(/session_token = EXCLUDED\.session_token/);
    expect(stored.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    expect(stored.sessionToken).toBeNull();

    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: SUB.accountId,
        p256dh: SUB.p256dh,
        auth: SUB.auth,
        created_at: SUB.createdAt,
        session_token: 'tok-1',
      },
    ];
    const bound = await store.upsertSubscription({ ...SUB, sessionToken: 'tok-1' });
    expect(sql.queries.at(-1)?.params.at(-1)).toBe('tok-1');
    expect(bound.sessionToken).toBe('tok-1');

    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: SUB.accountId,
        p256dh: SUB.p256dh,
        auth: SUB.auth,
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ];
    const storedFromString = await store.upsertSubscription(SUB);
    expect(storedFromString.createdAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: SUB.accountId,
        p256dh: SUB.p256dh,
        auth: SUB.auth,
        created_at: SUB.createdAt,
      },
    ];
    expect((await store.listAllSubscriptions())[0]?.endpoint).toBe(SUB.endpoint);
    sql.nextRows = [
      {
        id: 'ob',
        account_id: SUB.accountId,
        type: 'forum',
        message_id: null,
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: SUB.createdAt,
        delivered_endpoints: '[]',
      },
    ];
    expect((await store.listAllOutbox(5))[0]?.id).toBe('ob');

    sql.nextRows = [{ endpoint: SUB.endpoint }];
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(true);
    sql.nextRows = [];
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(false);

    sql.nextRows = [{ endpoint: SUB.endpoint }];
    expect(await store.deleteStaleSubscription({ ...SUB, sessionToken: 'tok-1' })).toBe(true);
    expect(sql.queries.at(-1)?.text).toMatch(/session_token IS NOT DISTINCT FROM \$3/);
    expect(sql.queries.at(-1)?.params).toEqual(['acc-a', SUB.endpoint, 'tok-1']);
    sql.nextRows = [];
    expect(await store.deleteStaleSubscription(SUB)).toBe(false);
    expect(sql.queries.at(-1)?.params).toEqual(['acc-a', SUB.endpoint, null]);

    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: 'acc-a',
        p256dh: 'p',
        auth: 'a',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ];
    const listed = await store.listByAccount('acc-a');
    expect(listed[0]?.createdAt).toBeInstanceOf(Date);

    sql.nextRows = [
      {
        endpoint: SUB.endpoint,
        account_id: 'acc-a',
        p256dh: 'p',
        auth: 'a',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
      },
    ];
    const listedDate = await store.listByAccount('acc-a');
    expect(listedDate[0]?.createdAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    sql.nextRows = [{ account_id: 'acc-a' }, { account_id: 'acc-b' }];
    expect(await store.listAccountIdsWithSubscriptions()).toEqual(['acc-a', 'acc-b']);

    await store.enqueue(pending({ id: 'o1', accountId: 'acc-a' }));
    expect(sql.executes.at(-1)?.text).toMatch(/INSERT INTO push_outbox/i);
    expect(sql.executes.at(-1)?.text).toMatch(/delivered_endpoints/);
    expect(sql.executes.at(-1)?.text).toMatch(/skip_endpoints/);
    expect(sql.executes.at(-1)?.params.at(-1)).toBe('[]');

    sql.nextRows = [
      {
        id: 'o1',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'm',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: '2026-08-03T00:01:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
        delivered_endpoints: '[]',
      },
    ];
    const claimed = await store.claimPending(5, Date.parse('2026-08-03T00:00:00.000Z'), 60_000);
    expect(claimed[0]?.claimedUntil).toBeInstanceOf(Date);
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
    expect(sql.queries.at(-1)?.text).toMatch(/FOR UPDATE SKIP LOCKED/);

    await store.markSent('o1', 7);
    expect(sql.executes.at(-1)?.text).toMatch(/status = 'sent', finished_at = \$2/);
    expect(sql.executes.at(-1)?.params).toEqual(['o1', new Date(7)]);
    await store.markFailed('o1', 8);
    expect(sql.executes.at(-1)?.text).toMatch(/attempts = attempts \+ 1/);
    expect(sql.executes.at(-1)?.text).toMatch(
      /finished_at = CASE WHEN attempts \+ 1 >= 8 THEN \$2 ELSE finished_at END/,
    );
    expect(sql.executes.at(-1)?.params).toEqual(['o1', new Date(8)]);
  });

  it('deleteFinishedOutbox deletes only sent/failed rows older than the cutoff', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [{ id: 'a' }, { id: 'b' }];
    expect(await store.deleteFinishedOutbox(5_000)).toBe(2);
    const query = sql.queries.at(-1);
    expect(query?.text).toMatch(/DELETE FROM push_outbox/);
    expect(query?.text).toMatch(/status IN \('sent', 'failed'\)/);
    expect(query?.text).toMatch(/COALESCE\(finished_at, created_at\) < \$1/);
    expect(query?.params).toEqual([new Date(5_000)]);
  });

  it('maps finished_at from Postgres as a string or a Date', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    const base = {
      account_id: 'acc-a',
      type: 'forum',
      message_id: null,
      payload: '{}',
      status: 'sent',
      attempts: 0,
      claimed_until: null,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      delivered_endpoints: '[]',
    };
    sql.nextRows = [
      { ...base, id: 'b', finished_at: '2026-08-02T00:00:00.000Z' },
      { ...base, id: 'a', finished_at: new Date('2026-08-03T00:00:00.000Z') },
      { ...base, id: 'c', finished_at: null },
    ];
    const rows = await store.listAllOutbox(5);
    expect(rows.map((row) => row.finishedAt?.toISOString() ?? null)).toEqual([
      '2026-08-02T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      null,
    ]);
  });

  it('recordDelivered selects and updates delivered_endpoints; unknown id is a no-op', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [];
    await store.recordDelivered('missing', ['https://push.example/a']);
    expect(sql.queries.at(-1)?.text).toMatch(/delivered_endpoints/);
    expect(sql.executes).toHaveLength(0);

    sql.nextRows = [{ delivered_endpoints: '["https://push.example/a"]' }];
    await store.recordDelivered('o1', ['https://push.example/a', 'https://push.example/b']);
    expect(sql.queries.at(-1)?.text).toMatch(/delivered_endpoints/);
    expect(sql.executes.at(-1)?.text).toMatch(/delivered_endpoints/);
    expect(sql.executes.at(-1)?.params[0]).toBe(
      JSON.stringify(['https://push.example/a', 'https://push.example/b']),
    );
  });

  it('throws when upsert RETURNING is empty', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [];
    await expect(store.upsertSubscription(SUB)).rejects.toThrow(/upsert_empty/);
  });

  it('maps type conversation from Postgres', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'o-conv',
        account_id: 'acc-a',
        type: 'conversation',
        message_id: '11111111-1111-4111-8111-111111111111',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[]',
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.type).toBe('conversation');
  });

  it('maps dismiss type and valid skip_endpoints from Postgres', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'o-dismiss',
        account_id: 'acc-a',
        type: 'dismiss',
        message_id: null,
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[]',
        skip_endpoints:
          '["https://push.example/a","","https://push.example/a","https://push.example/b"]',
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.type).toBe('dismiss');
    expect(claimed[0]?.skipEndpoints).toEqual(['https://push.example/a', 'https://push.example/b']);
  });

  it('claimPending returns leased rows oldest createdAt then id', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'newer',
        account_id: 'acc-a',
        type: 'dismiss',
        message_id: null,
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        delivered_endpoints: '[]',
        skip_endpoints: '[]',
      },
      {
        id: 'older',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'm',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[]',
      },
    ];
    const claimed = await store.claimPending(10, 1, 1000);
    expect(claimed.map((row) => row.id)).toEqual(['older', 'newer']);
  });

  it('claimPending orders equal createdAt by id', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'b',
        account_id: 'acc-a',
        type: 'dismiss',
        message_id: null,
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[]',
        skip_endpoints: '[]',
      },
      {
        id: 'a',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'm',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[]',
        skip_endpoints: '[]',
      },
    ];
    const claimed = await store.claimPending(10, 1, 1000);
    expect(claimed.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it.each([undefined, null, 'not-json'])(
    'maps missing or invalid skip_endpoints %s to an empty array',
    async (skipEndpoints) => {
      const sql = new MockSql();
      const store = new PostgresPushStore(sql);
      sql.nextRows = [
        {
          id: 'o-dismiss-empty',
          account_id: 'acc-a',
          type: 'dismiss',
          message_id: null,
          payload: '{}',
          status: 'pending',
          attempts: 0,
          claimed_until: null,
          created_at: new Date('2026-08-01T00:00:00.000Z'),
          delivered_endpoints: '[]',
          skip_endpoints: skipEndpoints,
        },
      ];
      expect((await store.claimPending(1, 1, 1000))[0]?.skipEndpoints).toEqual([]);
    },
  );

  it('maps unknown type/status and null claimed_until safely', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'o2',
        account_id: 'acc-a',
        type: 'other',
        message_id: null,
        payload: '{}',
        status: 'weird',
        attempts: 1,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: null,
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.type).toBe('forum');
    expect(claimed[0]?.status).toBe('pending');
    expect(claimed[0]?.claimedUntil).toBeNull();
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
  });

  it('maps a Date claimed_until from Postgres without wrapping twice', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    const until = new Date('2026-08-03T00:01:00.000Z');
    sql.nextRows = [
      {
        id: 'o3',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'msg',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: until,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '["https://push.example/a"]',
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.claimedUntil).toBeInstanceOf(Date);
    expect(claimed[0]?.claimedUntil?.toISOString()).toBe(until.toISOString());
    expect(claimed[0]?.deliveredEndpoints).toEqual(['https://push.example/a']);
  });

  it('maps invalid delivered_endpoints JSON to an empty array', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'o4',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'msg',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: 'not-json',
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
  });

  it('maps non-array and dirty delivered_endpoints entries via parse rules', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      {
        id: 'o5',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'msg',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '{}',
      },
    ];
    expect((await store.claimPending(1, 1, 1000))[0]?.deliveredEndpoints).toEqual([]);

    sql.nextRows = [
      {
        id: 'o6',
        account_id: 'acc-a',
        type: 'forum',
        message_id: 'msg',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        claimed_until: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        delivered_endpoints: '[1,"","https://push.example/a","https://push.example/a",null]',
      },
    ];
    expect((await store.claimPending(1, 1, 1000))[0]?.deliveredEndpoints).toEqual([
      'https://push.example/a',
    ]);
  });
});

describe('countBroadcastOutbox', () => {
  it('counts in-memory rows of one broadcast by outcome', async () => {
    const store = new InMemoryPushStore();
    const tagged = (
      overrides: Partial<PushOutboxRow> & Pick<PushOutboxRow, 'id' | 'accountId'>,
    ): PushOutboxRow => pending({ payload: '{"tag":"broadcast:b"}', ...overrides });
    expect(await store.countBroadcastOutbox('b')).toEqual({
      queued: 0,
      pending: 0,
      delivered: 0,
      dropped: 0,
      failed: 0,
    });
    await store.enqueue(tagged({ id: '1', accountId: 'a', messageId: 'b' }));
    await store.enqueue(
      tagged({
        id: '2',
        accountId: 'a',
        messageId: 'b',
        status: 'sent',
        deliveredEndpoints: ['x'],
      }),
    );
    await store.enqueue(tagged({ id: '3', accountId: 'a', messageId: 'b', status: 'sent' }));
    await store.enqueue(tagged({ id: '4', accountId: 'a', messageId: 'b', status: 'failed' }));
    await store.enqueue(
      tagged({
        id: '6',
        accountId: 'a',
        messageId: 'b',
        status: 'failed',
        deliveredEndpoints: ['y'],
      }),
    );
    await store.enqueue(
      tagged({ id: '7', accountId: 'a', messageId: 'b', deliveredEndpoints: ['z'] }),
    );
    await store.enqueue(
      tagged({ id: '5', accountId: 'a', messageId: 'other', payload: '{"tag":"broadcast:other"}' }),
    );
    await store.enqueue(
      pending({ id: '8', accountId: 'a', messageId: 'b', payload: '{"tag":"zap:b"}' }),
    );
    await store.enqueue(pending({ id: '9', accountId: 'a', messageId: 'b', payload: 'not json' }));
    await store.enqueue(pending({ id: '10', accountId: 'a', messageId: 'b', payload: 'null' }));
    expect(await store.countBroadcastOutbox('b')).toEqual({
      queued: 6,
      pending: 2,
      delivered: 2,
      dropped: 1,
      failed: 1,
    });
  });

  it('groups Postgres rows by status and splits sent rows by delivered endpoints', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [
      { status: 'pending', n: 2, reached: 0 },
      { status: 'sent', n: 5, reached: 3 },
      { status: 'failed', n: 3, reached: 1 },
    ];
    expect(await store.countBroadcastOutbox('b')).toEqual({
      queued: 10,
      pending: 2,
      delivered: 4,
      dropped: 2,
      failed: 2,
    });
    expect(sql.queries.at(-1)?.text).toMatch(
      /WHERE message_id = \$1 AND payload::jsonb ->> 'tag' = \$2/,
    );
    expect(sql.queries.at(-1)?.params).toEqual(['b', 'broadcast:b']);
  });
});
