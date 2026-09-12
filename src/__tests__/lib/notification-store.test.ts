import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { NotificationRow } from '@/lib/notification';
import {
  InMemoryNotificationStore,
  NOTIFICATION_SCHEMA_SQL,
  migrateNotificationSchema,
  PostgresNotificationStore,
} from '@/lib/notification-store';

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

const NOW = new Date('2026-08-29T12:00:00.000Z');
const EARLIER = new Date('2026-08-28T12:00:00.000Z');
const READ_AT = new Date('2026-08-30T00:00:00.000Z');

function row(partial: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n-1',
    recipientAccountId: 'parent',
    actorAccountId: 'actor',
    type: 'forum_reply',
    parentId: 'p-1',
    replyId: 'r-1',
    name: 'Ada',
    text: 'child',
    createdAt: NOW,
    readAt: null,
    ...partial,
  };
}

function sqlRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n-1',
    recipient_account_id: 'parent',
    actor_account_id: 'actor',
    type: 'forum_reply',
    parent_id: 'p-1',
    reply_id: 'r-1',
    name: 'Ada',
    text: 'child',
    created_at: NOW,
    read_at: null,
    ...partial,
  };
}

describe('NOTIFICATION_SCHEMA_SQL', () => {
  it('creates the notification table and indexes', () => {
    const joined = NOTIFICATION_SCHEMA_SQL.join('\n');
    expect(NOTIFICATION_SCHEMA_SQL).toHaveLength(3);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS notification/i);
    expect(joined).toMatch(/notification_recipient_type_reply_idx/);
    expect(joined).toMatch(/notification_recipient_created_at_idx/);
  });
});

describe('migrateNotificationSchema', () => {
  it('runs every NOTIFICATION_SCHEMA_SQL statement in order', async () => {
    const sql = new MockSql();
    await migrateNotificationSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...NOTIFICATION_SCHEMA_SQL]);
  });
});

describe('InMemoryNotificationStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryNotificationStore().listByRecipient('parent', 10)).toEqual([]);
  });

  it('copies the seed and listed rows so callers cannot mutate store state', async () => {
    const seed: NotificationRow[] = [row(), row({ id: 'n-2', replyId: 'r-2', text: 'second' })];
    const store = new InMemoryNotificationStore(seed);
    seed.pop();
    if (seed[0] !== undefined) {
      seed[0].text = 'mutated-seed';
    }
    const listed = await store.listByRecipient('parent', 10);
    expect(listed).toHaveLength(2);
    listed.pop();
    if (listed[0] !== undefined) {
      listed[0].text = 'mutated-listed';
    }
    const again = await store.listByRecipient('parent', 10);
    expect(again).toHaveLength(2);
    expect(again.map((item) => item.text).sort()).toEqual(['child', 'second']);
  });

  it('returns newest createdAt first', async () => {
    const store = new InMemoryNotificationStore([
      row({ id: 'old', replyId: 'r-old', createdAt: EARLIER }),
      row({ id: 'new', replyId: 'r-new', createdAt: NOW }),
    ]);
    expect((await store.listByRecipient('parent', 10)).map((item) => item.id)).toEqual([
      'new',
      'old',
    ]);
  });

  it('breaks equal createdAt ties by id descending', async () => {
    const store = new InMemoryNotificationStore([
      row({ id: 'm', replyId: 'r-m' }),
      row({ id: 'z', replyId: 'r-z' }),
    ]);
    expect((await store.listByRecipient('parent', 10)).map((item) => item.id)).toEqual(['z', 'm']);
  });

  it('unreadCount counts only unread rows for that recipient', async () => {
    const store = new InMemoryNotificationStore([
      row({ id: 'unread', replyId: 'r-unread' }),
      row({ id: 'read', replyId: 'r-read', readAt: READ_AT }),
      row({
        id: 'other',
        recipientAccountId: 'other',
        replyId: 'r-other',
      }),
    ]);
    expect(await store.unreadCount('parent')).toBe(1);
    expect(await store.unreadCount('other')).toBe(1);
  });

  it('unreadCount is not capped by the list limit', async () => {
    const store = new InMemoryNotificationStore([
      row({ id: 'a', replyId: 'r-a' }),
      row({ id: 'b', replyId: 'r-b' }),
      row({ id: 'c', replyId: 'r-c' }),
    ]);
    expect(await store.listByRecipient('parent', 1)).toHaveLength(1);
    expect(await store.unreadCount('parent')).toBe(3);
  });

  it('getByIdForRecipient returns a copy or undefined', async () => {
    const store = new InMemoryNotificationStore([row()]);
    expect((await store.getByIdForRecipient('n-1', 'parent'))?.id).toBe('n-1');
    expect(await store.getByIdForRecipient('missing', 'parent')).toBeUndefined();
    expect(await store.getByIdForRecipient('n-1', 'other')).toBeUndefined();
  });

  it('markRead missing returns undefined', async () => {
    expect(
      await new InMemoryNotificationStore().markRead('missing', 'parent', READ_AT),
    ).toBeUndefined();
  });

  it('markRead for another recipient returns undefined', async () => {
    const store = new InMemoryNotificationStore([row()]);
    expect(await store.markRead('n-1', 'other', READ_AT)).toBeUndefined();
    expect((await store.getByIdForRecipient('n-1', 'parent'))?.readAt).toBeNull();
  });

  it('markRead already-read keeps the original readAt', async () => {
    const original = new Date('2026-08-29T18:00:00.000Z');
    const store = new InMemoryNotificationStore([row({ readAt: original })]);
    const marked = await store.markRead('n-1', 'parent', READ_AT);
    expect(marked?.readAt?.toISOString()).toBe(original.toISOString());
  });

  it('markAllRead stamps unread rows only', async () => {
    const original = new Date('2026-08-29T18:00:00.000Z');
    const store = new InMemoryNotificationStore([
      row({ id: 'unread', replyId: 'r-unread' }),
      row({ id: 'read', replyId: 'r-read', readAt: original }),
      row({ id: 'other', recipientAccountId: 'other', replyId: 'r-other' }),
    ]);
    await store.markAllRead('parent', READ_AT);
    expect((await store.getByIdForRecipient('unread', 'parent'))?.readAt?.toISOString()).toBe(
      READ_AT.toISOString(),
    );
    expect((await store.getByIdForRecipient('read', 'parent'))?.readAt?.toISOString()).toBe(
      original.toISOString(),
    );
    expect((await store.getByIdForRecipient('other', 'other'))?.readAt).toBeNull();
  });

  it('unique create returns the existing id', async () => {
    const store = new InMemoryNotificationStore();
    const first = await store.create(row({ id: 'first' }));
    const second = await store.create(row({ id: 'second', text: 'other' }));
    expect(second.id).toBe(first.id);
    expect(second.text).toBe('child');
    expect(await store.listByRecipient('parent', 10)).toHaveLength(1);
  });

  it('caps the list at limit', async () => {
    const store = new InMemoryNotificationStore([
      row({ id: 'a', replyId: 'r-a', createdAt: EARLIER }),
      row({ id: 'z', replyId: 'r-z', createdAt: NOW }),
    ]);
    expect((await store.listByRecipient('parent', 1)).map((item) => item.id)).toEqual(['z']);
  });
});

describe('PostgresNotificationStore', () => {
  it('listByRecipient maps Date and date-string timestamps and binds accountId + limit', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      sqlRow({
        id: 'n-date',
        created_at: NOW,
        read_at: READ_AT,
      }),
      sqlRow({
        id: 'n-string',
        reply_id: 'r-2',
        created_at: '2026-08-28T12:00:00.000Z',
        read_at: '2026-08-30T00:00:00.000Z',
      }),
    ];
    const listed = await new PostgresNotificationStore(sql).listByRecipient('parent', 50);
    expect(sql.queries[0]?.params).toEqual(['parent', 50]);
    expect(sql.queries[0]?.text).toMatch(/recipient_account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$2/);
    expect(listed[0]?.createdAt).toEqual(NOW);
    expect(listed[0]?.readAt).toEqual(READ_AT);
    expect(listed[1]?.createdAt).toEqual(EARLIER);
    expect(listed[1]?.readAt).toEqual(READ_AT);
    expect(listed[0]?.recipientAccountId).toBe('parent');
    expect(listed[0]?.actorAccountId).toBe('actor');
  });

  it('maps null and omitted read_at to null', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      sqlRow({ id: 'n-null', read_at: null }),
      sqlRow({ id: 'n-undef', read_at: undefined }),
    ];
    const listed = await new PostgresNotificationStore(sql).listByRecipient('parent', 10);
    expect(listed[0]?.readAt).toBeNull();
    expect(listed[1]?.readAt).toBeNull();
  });

  it('create INSERTs 10 columns and has no ON CONFLICT', async () => {
    const sql = new MockSql();
    const created = await new PostgresNotificationStore(sql).create(row());
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO notification/);
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toHaveLength(10);
    expect(sql.executes[0]?.params).toEqual([
      'n-1',
      'parent',
      'actor',
      'forum_reply',
      'p-1',
      'r-1',
      'Ada',
      'child',
      NOW,
      null,
    ]);
    expect(created.id).toBe('n-1');
    expect(created.createdAt).not.toBe(NOW);
  });

  it('returns the mapped existing row on unique_violation 23505', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    sql.queryImpl = (text) => {
      if (text.includes('SELECT')) {
        return [sqlRow({ id: 'existing' })];
      }
      return undefined;
    };
    const created = await new PostgresNotificationStore(sql).create(row({ id: 'new' }));
    expect(created.id).toBe('existing');
    expect(sql.queries[0]?.params).toEqual(['parent', 'forum_reply', 'r-1']);
  });

  it('throws when 23505 re-select is empty', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    sql.queryImpl = () => [];
    await expect(new PostgresNotificationStore(sql).create(row())).rejects.toThrow(
      /notification create failed/,
    );
  });

  it('rethrows non-unique execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    await expect(new PostgresNotificationStore(sql).create(row())).rejects.toThrow('insert boom');
  });

  it('propagates query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresNotificationStore(sql).listByRecipient('parent', 10)).rejects.toThrow(
      'list boom',
    );
  });

  it('unreadCount maps bigint and string', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ count: 2n }];
    expect(await new PostgresNotificationStore(sql).unreadCount('parent')).toBe(2);
    sql.nextRows = [{ count: '3' }];
    expect(await new PostgresNotificationStore(sql).unreadCount('parent')).toBe(3);
    sql.nextRows = [{ count: 4 }];
    expect(await new PostgresNotificationStore(sql).unreadCount('parent')).toBe(4);
    sql.nextRows = [];
    expect(await new PostgresNotificationStore(sql).unreadCount('parent')).toBe(0);
    expect(sql.queries[0]?.params).toEqual(['parent']);
  });

  it('getByIdForRecipient is undefined when nextRows is empty', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresNotificationStore(sql).getByIdForRecipient('n-1', 'parent'),
    ).toBeUndefined();
  });

  it('markRead UPDATEs then returns the updated row', async () => {
    const sql = new MockSql();
    sql.nextRows = [sqlRow()];
    const marked = await new PostgresNotificationStore(sql).markRead('n-1', 'parent', READ_AT);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/UPDATE notification SET read_at/);
    expect(sql.executes[0]?.params).toEqual(['n-1', 'parent', READ_AT]);
    expect(marked?.readAt).toEqual(READ_AT);
  });

  it('markRead already-read skips execute', async () => {
    const sql = new MockSql();
    sql.nextRows = [sqlRow({ read_at: READ_AT })];
    const marked = await new PostgresNotificationStore(sql).markRead(
      'n-1',
      'parent',
      new Date('2026-09-01T00:00:00.000Z'),
    );
    expect(sql.executes).toHaveLength(0);
    expect(marked?.readAt).toEqual(READ_AT);
  });

  it('markRead missing returns undefined', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresNotificationStore(sql).markRead('n-1', 'parent', READ_AT),
    ).toBeUndefined();
    expect(sql.executes).toHaveLength(0);
  });

  it('markAllRead UPDATE params', async () => {
    const sql = new MockSql();
    await new PostgresNotificationStore(sql).markAllRead('parent', READ_AT);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/UPDATE notification SET read_at = \$2/);
    expect(sql.executes[0]?.params).toEqual(['parent', READ_AT]);
  });
});
