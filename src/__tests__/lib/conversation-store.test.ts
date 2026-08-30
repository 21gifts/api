import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  unsignedConversationDefaults,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import {
  CONVERSATION_SCHEMA_SQL,
  InMemoryConversationStore,
  migrateConversationSchema,
  PostgresConversationStore,
} from '@/lib/conversation-store';

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

function thread(partial: Partial<ConversationThread> = {}): ConversationThread {
  return {
    id: 'c-1',
    kind: 'member_member',
    accountA: 'acc-a',
    accountB: 'acc-b',
    counterpartPubkey: null,
    createdAt: NOW,
    lastMessageAt: NOW,
    name: '',
    lastText: '',
    ...partial,
  };
}

function message(partial: Partial<ConversationMessageRow> = {}): ConversationMessageRow {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    text: 'hello',
    createdAt: NOW,
    senderAccountId: 'acc-a',
    senderPubkey: null,
    name: 'Ada',
    ...unsignedConversationDefaults(),
    ...partial,
  };
}

describe('CONVERSATION_SCHEMA_SQL', () => {
  it('creates conversation tables and unique indexes', () => {
    const joined = CONVERSATION_SCHEMA_SQL.join('\n');
    expect(CONVERSATION_SCHEMA_SQL).toHaveLength(8);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS conversation/i);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS conversation_message/i);
    expect(joined).toMatch(/conversation_member_member_uidx/);
    expect(joined).toMatch(/conversation_member_platform_uidx/);
    expect(joined).toMatch(/conversation_member_damus_uidx/);
    expect(joined).toMatch(/conversation_message_event_id_uidx/);
  });
});

describe('migrateConversationSchema', () => {
  it('runs every CONVERSATION_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateConversationSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...CONVERSATION_SCHEMA_SQL]);
  });
});

describe('InMemoryConversationStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryConversationStore().listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('opens unique member_member threads with ordered ids', async () => {
    const store = new InMemoryConversationStore();
    const first = await store.openMemberMember('b', 'a', NOW);
    const again = await store.openMemberMember('a', 'b', NOW);
    expect(again.id).toBe(first.id);
    expect(first.accountA).toBe('a');
    expect(first.accountB).toBe('b');
    expect(first.kind).toBe('member_member');
  });

  it('opens unique member_platform and member_damus threads', async () => {
    const store = new InMemoryConversationStore();
    const platform = await store.openMemberPlatform('mem', 'plat', NOW);
    expect((await store.openMemberPlatform('mem', 'plat', NOW)).id).toBe(platform.id);
    const damus = await store.openMemberDamus('mem', 'AA'.repeat(32), NOW);
    expect(damus.counterpartPubkey).toBe('aa'.repeat(32));
    expect((await store.openMemberDamus('mem', 'aa'.repeat(32), NOW)).id).toBe(damus.id);
  });

  it('appends messages, hydrates lastText, and copies so callers cannot mutate', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    const created = await store.appendMessage(message({ conversationId: opened.id, text: 'hi' }));
    created.text = 'mutated';
    const listed = await store.listMessages(opened.id, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('hi');
    const got = await store.getById(opened.id);
    expect(got?.lastText).toBe('hi');
  });

  it('returns the existing row when appending a duplicate event id', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    const first = await store.appendMessage(
      message({ id: 'm-1', conversationId: opened.id, eventId: 'ab'.repeat(32) }),
    );
    const second = await store.appendMessage(
      message({ id: 'm-2', conversationId: opened.id, eventId: 'ab'.repeat(32), text: 'other' }),
    );
    expect(second.id).toBe(first.id);
    expect(await store.listMessages(opened.id, 10)).toHaveLength(1);
  });

  it('lists visible own threads and staff platform threads newest first', async () => {
    const store = new InMemoryConversationStore();
    const own = await store.openMemberMember('acc', 'other', NOW);
    await store.appendMessage(message({ conversationId: own.id, text: 'own' }));
    const platform = await store.openMemberPlatform(
      'someone',
      'plat',
      new Date(NOW.getTime() + 1000),
    );
    const listed = await store.listVisible('acc', true, 'plat', 10);
    expect(listed.map((t) => t.id)).toEqual([platform.id, own.id]);
    const memberOnly = await store.listVisible('acc', false, 'plat', 10);
    expect(memberOnly.map((t) => t.id)).toEqual([own.id]);
  });

  it('caps listVisible at limit and breaks ties by id descending', async () => {
    const highId = thread({
      id: 'z',
      accountA: 'acc',
      accountB: 'a',
      lastMessageAt: NOW,
    });
    const lowId = thread({
      id: 'm',
      accountA: 'acc',
      accountB: 'x',
      lastMessageAt: NOW,
    });
    const store = new InMemoryConversationStore([highId, lowId]);
    expect((await store.listVisible('acc', false, null, 1)).map((t) => t.id)).toEqual(['z']);
  });

  it('claims unsigned and unpublished rows with a lease', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ id: 'u1', conversationId: opened.id }));
    const unsigned = await store.claimUnsigned(10, 1_000, 60_000);
    expect(unsigned.map((r) => r.id)).toEqual(['u1']);
    expect(await store.claimUnsigned(10, 1_000, 60_000)).toEqual([]);
    expect(await store.updateSignedEvent('u1', 'ab'.repeat(32), { kind: 1059 })).toBe(true);
    const unpublished = await store.claimUnpublished(10, 70_000, 60_000);
    expect(unpublished.map((r) => r.id)).toEqual(['u1']);
    await store.updatePublishState('u1', 'published');
    expect((await store.getMessageById('u1'))?.nostrPublishState).toBe('published');
    expect(await store.getMessageByEventId('ab'.repeat(32))).toBeDefined();
  });

  it('rejects a colliding signed event id', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'm-1', conversationId: opened.id, eventId: 'aa'.repeat(32) }),
    );
    await store.appendMessage(message({ id: 'm-2', conversationId: opened.id }));
    expect(await store.updateSignedEvent('m-2', 'aa'.repeat(32), { kind: 1059 })).toBe(false);
    expect(await store.updateSignedEvent('missing', 'bb'.repeat(32), { kind: 1059 })).toBe(false);
  });

  it('skips Damus-only rows without a sender account when claiming unsigned', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    await store.appendMessage(
      message({ conversationId: opened.id, senderAccountId: null, eventId: null }),
    );
    expect(await store.claimUnsigned(10, 1, 10)).toEqual([]);
  });
});

describe('PostgresConversationStore', () => {
  it('maps a thread row and binds getById', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        kind: 'member_member',
        account_a: 'a',
        account_b: 'b',
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: '2026-08-29T13:00:00.000Z',
        last_text: 'hi',
      },
    ];
    const store = new PostgresConversationStore(sql);
    const got = await store.getById('c1');
    expect(got?.accountA).toBe('a');
    expect(got?.lastText).toBe('hi');
    expect(got?.lastMessageAt.toISOString()).toBe('2026-08-29T13:00:00.000Z');
    expect(sql.queries[0]?.params).toEqual(['c1']);
  });

  it('listVisible binds staff and platform filters', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.listVisible('acc', true, 'plat', 50);
    expect(sql.queries[0]?.params).toEqual(['acc', true, 'plat', 50]);
    expect(sql.queries[0]?.text).toMatch(/member_platform/);
  });

  it('openMemberMember returns an existing row without inserting', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        kind: 'member_member',
        account_a: 'a',
        account_b: 'b',
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    const store = new PostgresConversationStore(sql);
    const opened = await store.openMemberMember('b', 'a', NOW);
    expect(opened.id).toBe('c1');
    expect(sql.executes).toHaveLength(0);
  });

  it('openMemberMember inserts then re-selects', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    let calls = 0;
    sql.queryImpl = () => {
      calls += 1;
      if (calls === 1) {
        return [];
      }
      return [
        {
          id: 'c-new',
          kind: 'member_member',
          account_a: 'a',
          account_b: 'b',
          counterpart_pubkey: null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const opened = await store.openMemberMember('a', 'b', NOW);
    expect(opened.id).toBe('c-new');
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO conversation/);
  });

  it('openMemberPlatform and openMemberDamus return existing rows without inserting', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        kind: 'member_platform',
        account_a: 'mem',
        account_b: 'plat',
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    const store = new PostgresConversationStore(sql);
    expect((await store.openMemberPlatform('mem', 'plat', NOW)).id).toBe('c1');
    sql.nextRows = [
      {
        id: 'c2',
        kind: 'member_damus',
        account_a: 'mem',
        account_b: null,
        counterpart_pubkey: 'aa'.repeat(32),
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    expect((await store.openMemberDamus('mem', 'aa'.repeat(32), NOW)).id).toBe('c2');
    expect(sql.executes).toHaveLength(0);
  });

  it('openMemberPlatform and openMemberDamus insert when missing', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    let n = 0;
    sql.queryImpl = (text) => {
      n += 1;
      if (text.includes('member_platform') && n <= 2 && n % 2 === 1) {
        return [];
      }
      if (text.includes('member_damus') && n % 2 === 1) {
        return [];
      }
      return [
        {
          id: `c-${n}`,
          kind: text.includes('member_damus') ? 'member_damus' : 'member_platform',
          account_a: 'mem',
          account_b: text.includes('member_damus') ? null : 'plat',
          counterpart_pubkey: text.includes('member_damus') ? 'aa'.repeat(32) : null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const platform = await store.openMemberPlatform('mem', 'plat', NOW);
    expect(platform.kind).toBe('member_platform');
    const damus = await store.openMemberDamus('mem', 'AA'.repeat(32), NOW);
    expect(damus.kind).toBe('member_damus');
    expect(sql.executes).toHaveLength(2);
  });

  it('open helpers swallow unique_violation and re-select', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    let n = 0;
    sql.queryImpl = () => {
      n += 1;
      if (n === 1) {
        return [];
      }
      return [
        {
          id: 'c1',
          kind: 'member_member',
          account_a: 'a',
          account_b: 'b',
          counterpart_pubkey: null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const opened = await new PostgresConversationStore(sql).openMemberMember('a', 'b', NOW);
    expect(opened.id).toBe('c1');
  });

  it('openMemberPlatform and openMemberDamus swallow unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    let n = 0;
    sql.queryImpl = (text) => {
      n += 1;
      if (n % 2 === 1) {
        return [];
      }
      return [
        {
          id: 'c1',
          kind: text.includes('member_damus') ? 'member_damus' : 'member_platform',
          account_a: 'mem',
          account_b: text.includes('member_damus') ? null : 'plat',
          counterpart_pubkey: text.includes('member_damus') ? 'aa'.repeat(32) : null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const store = new PostgresConversationStore(sql);
    expect((await store.openMemberPlatform('mem', 'plat', NOW)).id).toBe('c1');
    expect((await store.openMemberDamus('mem', 'aa'.repeat(32), NOW)).id).toBe('c1');
  });

  it('openMemberPlatform and openMemberDamus rethrow non-unique insert errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    sql.queryImpl = () => [];
    const store = new PostgresConversationStore(sql);
    await expect(store.openMemberPlatform('m', 'p', NOW)).rejects.toThrow('insert boom');
    await expect(store.openMemberDamus('m', 'aa'.repeat(32), NOW)).rejects.toThrow('insert boom');
  });

  it('open helpers throw when re-select is empty', async () => {
    const sql = new MockSql();
    await expect(
      new PostgresConversationStore(sql).openMemberMember('a', 'b', NOW),
    ).rejects.toThrow(/conversation open failed/);
    await expect(
      new PostgresConversationStore(sql).openMemberPlatform('m', 'p', NOW),
    ).rejects.toThrow(/conversation open failed/);
    await expect(
      new PostgresConversationStore(sql).openMemberDamus('m', 'aa'.repeat(32), NOW),
    ).rejects.toThrow(/conversation open failed/);
  });

  it('maps messages and listMessages binds limit', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        conversation_id: 'c1',
        text: 'hi',
        created_at: NOW,
        sender_account_id: 'acc',
        sender_pubkey: null,
        name: 'Ada',
        event_id: null,
        nostr_publish_state: 'pending',
        nostr_event: null,
        claimed_until: null,
      },
    ];
    const store = new PostgresConversationStore(sql);
    const listed = await store.listMessages('c1', 20);
    expect(listed[0]?.text).toBe('hi');
    expect(sql.queries[0]?.params).toEqual(['c1', 20]);
    expect(await store.getMessageById('m1')).toBeDefined();
    expect(await store.getMessageByEventId('ab'.repeat(32))).toBeDefined();
  });

  it('appendMessage inserts then bumps last_message_at', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    const row = message({ claimedUntil: 5_000, nostrEvent: { kind: 1059 } });
    const created = await store.appendMessage(row);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO conversation_message/);
    expect(sql.executes[1]?.text).toMatch(/UPDATE conversation SET last_message_at/);
    expect(created.text).toBe('hello');
  });

  it('appendMessage returns the existing row on event_id unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    sql.nextRows = [
      {
        id: 'm-existing',
        conversation_id: 'c-1',
        text: 'hello',
        created_at: NOW,
        sender_account_id: 'acc-a',
        sender_pubkey: null,
        name: 'Ada',
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'published',
        nostr_event: null,
        claimed_until: null,
      },
    ];
    const existing = await new PostgresConversationStore(sql).appendMessage(
      message({ eventId: 'ab'.repeat(32) }),
    );
    expect(existing.id).toBe('m-existing');
  });

  it('appendMessage rethrows unique_violation when no event id row exists', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    await expect(
      new PostgresConversationStore(sql).appendMessage(message({ eventId: 'ab'.repeat(32) })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('claimUnsigned and claimUnpublished bind lease parameters', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.claimUnsigned(5, 1_000, 60_000);
    await store.claimUnpublished(5, 1_000, 60_000);
    expect(sql.queries[0]?.text).toMatch(/sender_account_id IS NOT NULL/);
    expect(sql.queries[1]?.text).toMatch(/event_id IS NOT NULL/);
    expect(sql.queries[0]?.params[2]).toBe(5);
  });

  it('updateSignedEvent returns false when no row matches', async () => {
    const sql = new MockSql();
    expect(
      await new PostgresConversationStore(sql).updateSignedEvent('m', 'ab'.repeat(32), { k: 1 }),
    ).toBe(false);
  });

  it('updateSignedEvent returns false on unique_violation', async () => {
    const sql = new MockSql();
    sql.queryError = { code: '23505' };
    expect(
      await new PostgresConversationStore(sql).updateSignedEvent('m', 'ab'.repeat(32), { k: 1 }),
    ).toBe(false);
  });

  it('updatePublishState binds the new state', async () => {
    const sql = new MockSql();
    await new PostgresConversationStore(sql).updatePublishState('m', 'published');
    expect(sql.executes[0]?.params).toEqual(['m', 'published']);
  });

  it('throws on an unknown conversation kind', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        kind: 'nope',
        account_a: 'a',
        account_b: 'b',
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    await expect(new PostgresConversationStore(sql).getById('c1')).rejects.toThrow(
      /Unknown conversation kind/,
    );
  });

  it('maps a failed publish state and string nostr_event JSON', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        conversation_id: 'c1',
        text: 'hi',
        created_at: NOW,
        sender_account_id: null,
        sender_pubkey: 'aa'.repeat(32),
        name: 'npub',
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'weird',
        nostr_event: JSON.stringify({ id: 'ab'.repeat(32), kind: 4 }),
        claimed_until: NOW,
      },
    ];
    const row = await new PostgresConversationStore(sql).getMessageById('m1');
    expect(row?.nostrPublishState).toBe('pending');
    expect(row?.claimedUntil).toBe(NOW.getTime());
    expect(row?.nostrEvent).toEqual({ id: 'ab'.repeat(32), kind: 4 });
  });

  it('propagates query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(
      new PostgresConversationStore(sql).listVisible('a', false, null, 1),
    ).rejects.toThrow('list boom');
  });

  it('propagates execute errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    await expect(new PostgresConversationStore(sql).appendMessage(message())).rejects.toThrow(
      'insert boom',
    );
  });

  it('openMemberMember rethrows non-unique insert errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    sql.queryImpl = (text) => (text.includes('SELECT') ? [] : undefined);
    await expect(
      new PostgresConversationStore(sql).openMemberMember('a', 'b', NOW),
    ).rejects.toThrow('insert boom');
  });
});
