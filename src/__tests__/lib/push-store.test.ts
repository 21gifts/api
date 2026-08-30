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
    ...overrides,
  };
}

describe('PUSH_SCHEMA_SQL', () => {
  it('creates push_subscription and push_outbox with indexes', () => {
    expect(PUSH_SCHEMA_SQL).toHaveLength(4);
    expect(PUSH_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS push_subscription/i);
    expect(PUSH_SCHEMA_SQL[1]).toMatch(/push_subscription_account_id_idx/i);
    expect(PUSH_SCHEMA_SQL[2]).toMatch(/CREATE TABLE IF NOT EXISTS push_outbox/i);
    expect(PUSH_SCHEMA_SQL[3]).toMatch(/push_outbox_pending_idx/i);
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
  it('upserts, rebinds account, and keeps original createdAt', async () => {
    const store = new InMemoryPushStore();
    const first = await store.upsertSubscription(SUB);
    expect(first.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    const later = new Date('2026-08-10T00:00:00.000Z');
    const rebound = await store.upsertSubscription({
      ...SUB,
      accountId: 'acc-b',
      p256dh: 'new',
      auth: 'new-auth',
      createdAt: later,
    });
    expect(rebound.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());
    const listed = await store.listByAccount('acc-b');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.accountId).toBe('acc-b');
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
    await store.markSent('missing');
    await store.markFailed('missing');
    await store.markSent('x');
    const claimed = await store.claimPending(10, 1, 1000);
    expect(claimed).toEqual([]);

    await store.enqueue(pending({ id: 'y', accountId: 'a' }));
    for (let i = 0; i < 7; i += 1) {
      await store.markFailed('y');
    }
    const requeued = await store.claimPending(10, 1, 1000);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]?.attempts).toBe(7);
    expect(requeued[0]?.claimedUntil).not.toBeNull();
    await store.markFailed('y');
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
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
    expect(stored.createdAt.toISOString()).toBe(SUB.createdAt.toISOString());

    sql.nextRows = [{ endpoint: SUB.endpoint }];
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(true);
    sql.nextRows = [];
    expect(await store.deleteSubscription('acc-a', SUB.endpoint)).toBe(false);

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

    sql.nextRows = [{ account_id: 'acc-a' }, { account_id: 'acc-b' }];
    expect(await store.listAccountIdsWithSubscriptions()).toEqual(['acc-a', 'acc-b']);

    await store.enqueue(pending({ id: 'o1', accountId: 'acc-a' }));
    expect(sql.executes.at(-1)?.text).toMatch(/INSERT INTO push_outbox/i);

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
      },
    ];
    const claimed = await store.claimPending(5, Date.parse('2026-08-03T00:00:00.000Z'), 60_000);
    expect(claimed[0]?.claimedUntil).toBeInstanceOf(Date);
    expect(sql.queries.at(-1)?.text).toMatch(/FOR UPDATE SKIP LOCKED/);

    await store.markSent('o1');
    expect(sql.executes.at(-1)?.text).toMatch(/status = 'sent'/);
    await store.markFailed('o1');
    expect(sql.executes.at(-1)?.text).toMatch(/attempts = attempts \+ 1/);
  });

  it('throws when upsert RETURNING is empty', async () => {
    const sql = new MockSql();
    const store = new PostgresPushStore(sql);
    sql.nextRows = [];
    await expect(store.upsertSubscription(SUB)).rejects.toThrow(/upsert_empty/);
  });

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
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.type).toBe('forum');
    expect(claimed[0]?.status).toBe('pending');
    expect(claimed[0]?.claimedUntil).toBeNull();
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
      },
    ];
    const claimed = await store.claimPending(1, 1, 1000);
    expect(claimed[0]?.claimedUntil).toBeInstanceOf(Date);
    expect(claimed[0]?.claimedUntil?.toISOString()).toBe(until.toISOString());
  });
});
