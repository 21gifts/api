import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  CONVERSATION_LIST_LIMIT,
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
    lastSenderAccountId: null,
    lastActorAccountId: null,
    lastSats: 0,
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

function sqlMessage(id: string, createdAt: Date): Record<string, unknown> {
  return {
    id,
    conversation_id: 'c1',
    text: id,
    created_at: createdAt,
    sender_account_id: 'acc',
    sender_pubkey: null,
    name: 'Ada',
    sats: 0,
    actor_account_id: null,
    actor_name: '',
    gift_for_message_id: null,
    event_id: null,
    nostr_publish_state: 'pending',
    nostr_event: null,
    claimed_until: null,
  };
}

describe('CONVERSATION_SCHEMA_SQL', () => {
  it('creates conversation tables and unique indexes', () => {
    const joined = CONVERSATION_SCHEMA_SQL.join('\n');
    expect(CONVERSATION_SCHEMA_SQL).toHaveLength(21);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS conversation/i);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS conversation_message/i);
    expect(joined).toMatch(/actor_account_id/);
    expect(joined).toMatch(/actor_name/);
    expect(joined).toMatch(
      /ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS gift_for_message_id uuid/,
    );
    expect(joined).not.toMatch(/gift_for_message_id uuid REFERENCES/);
    expect(joined).toMatch(/CREATE TABLE IF NOT EXISTS conversation_read/i);
    expect(joined).toMatch(/conversation_read_conversation_id_idx/);
    expect(joined).toMatch(/conversation_member_member_uidx/);
    expect(joined).toMatch(/conversation_member_platform_uidx/);
    expect(joined).toMatch(/conversation_member_damus_uidx/);
    expect(joined).toMatch(/conversation_moderator_group_uidx/);
    expect(joined).toMatch(/'moderator_group'/);
    expect(joined).toMatch(/conversation_message_event_id_uidx/);
    expect(joined).toMatch(/conversation_message_nostr_event_unrepaired_idx/);
    const unwrapRepair = CONVERSATION_SCHEMA_SQL.find((statement) =>
      statement.includes('$unwrap$'),
    );
    const giftForRepair = CONVERSATION_SCHEMA_SQL.find((statement) =>
      statement.includes('$gift_for$'),
    );
    expect(unwrapRepair).toContain('FROM pg_trigger');
    expect(unwrapRepair).toContain("tgname = 'trg_db_change'");
    expect(unwrapRepair).toContain("jsonb_typeof(nostr_event) = 'string'");
    expect(unwrapRepair).not.toContain('EXCEPTION WHEN others');
    expect(unwrapRepair).not.toContain('EXCEPTION WHEN invalid_text_representation');
    expect(unwrapRepair).toContain('EXCEPTION WHEN data_exception OR statement_too_complex THEN');
    expect(unwrapRepair).toContain("unwrapped := (repair_row.nostr_event #>> '{}')::jsonb;");
    expect(unwrapRepair).toContain('SET nostr_event = unwrapped');
    expect(unwrapRepair).toContain('CONTINUE;');
    expect(unwrapRepair).toContain('AND nostr_event = repair_row.nostr_event');
    expect(unwrapRepair).toMatch(
      /WHERE id = repair_row\.id[\s\S]*?jsonb_typeof\(nostr_event\) = 'string'[\s\S]*?AND nostr_event = repair_row\.nostr_event;/,
    );
    expect(unwrapRepair).toMatch(
      /unwrapped := \(repair_row\.nostr_event #>> '\{\}'\)::jsonb;[\s\S]*?EXCEPTION WHEN data_exception OR statement_too_complex THEN[\s\S]*?CONTINUE;[\s\S]*?END;[\s\S]*?UPDATE conversation_message/,
    );
    expect(unwrapRepair).not.toContain('repair_row.unwrapped_event');
    expect(giftForRepair).toContain('gift_for_message_id');
    expect(giftForRepair).toContain("kind = 'moderator_group'");
    expect(giftForRepair).toContain("interval '5 minutes'");
    expect(giftForRepair).toContain('is_platform');
    expect(giftForRepair).toContain('gift_for_message_id IS NULL');
    expect(giftForRepair).toContain('sats > 0');
    expect(giftForRepair).toContain('actor_account_id IS NULL');
    expect(giftForRepair).toContain('HAVING COUNT(*) = 1');
    expect(giftForRepair).toContain("tgname = 'trg_db_change'");
    expect(joined).toMatch(/conversation_message_gift_unlinked_idx/);
    expect(giftForRepair).toMatch(
      /UPDATE conversation_message s[\s\S]*FROM candidate[\s\S]*WHERE s\.id = candidate\.stipend_id/,
    );
    expect(giftForRepair).toMatch(
      /One-time repair for stipend rows written before gift_for_message_id existed/,
    );
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
    expect(first.lastSenderAccountId).toBeNull();
  });

  it('opens unique member_platform and member_damus threads', async () => {
    const store = new InMemoryConversationStore();
    const platform = await store.openMemberPlatform('mem', 'plat', NOW);
    expect((await store.openMemberPlatform('mem', 'plat', NOW)).id).toBe(platform.id);
    const damus = await store.openMemberDamus('mem', 'AA'.repeat(32), NOW);
    expect(damus.counterpartPubkey).toBe('aa'.repeat(32));
    expect((await store.openMemberDamus('mem', 'aa'.repeat(32), NOW)).id).toBe(damus.id);
  });

  it('ensureModeratorGroup inserts once and is hidden from staff without the moderator flag', async () => {
    const store = new InMemoryConversationStore();
    const first = await store.ensureModeratorGroup('plat', NOW);
    expect(first.kind).toBe('moderator_group');
    expect(first.accountA).toBe('plat');
    expect(first.accountB).toBeNull();
    expect(first.counterpartPubkey).toBeNull();
    const again = await store.ensureModeratorGroup('plat', NOW);
    expect(again.id).toBe(first.id);
    expect((await store.listVisible('acc', true, 'plat', 10, true)).map((t) => t.id)).toEqual([
      first.id,
    ]);
    expect(await store.listVisible('acc', true, 'plat', 10)).toEqual([]);
    expect(await store.listVisible('acc', true, 'plat', 10, false)).toEqual([]);
    expect(await store.listVisible('plat', true, 'plat', 10, false)).toEqual([]);
  });

  it('openMemberPlatform updates accountB when the platform id changes', async () => {
    const store = new InMemoryConversationStore([
      thread({
        id: 'c-plat',
        kind: 'member_platform',
        accountA: 'mem',
        accountB: 'old-plat',
      }),
    ]);
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    expect(opened.id).toBe('c-plat');
    expect(opened.accountB).toBe('plat');
    expect((await store.getById('c-plat'))?.accountB).toBe('plat');
    expect((await store.openMemberPlatform('mem', 'plat', NOW)).accountB).toBe('plat');
  });

  it('retargetMemberPlatform points every member_platform thread at the new account', async () => {
    const store = new InMemoryConversationStore([
      thread({
        id: 'c-plat',
        kind: 'member_platform',
        accountA: 'mem',
        accountB: 'old-plat',
      }),
      thread({
        id: 'c-mm',
        kind: 'member_member',
        accountA: 'a',
        accountB: 'b',
      }),
    ]);
    await store.retargetMemberPlatform('plat');
    expect((await store.getById('c-plat'))?.accountB).toBe('plat');
    expect((await store.getById('c-mm'))?.accountB).toBe('b');
  });

  it('retargetMemberPlatform does not point a platform member thread at itself', async () => {
    const store = new InMemoryConversationStore([
      thread({
        id: 'c-self',
        kind: 'member_platform',
        accountA: 'plat',
        accountB: 'old-plat',
      }),
    ]);
    await store.retargetMemberPlatform('plat');
    expect((await store.getById('c-self'))?.accountB).toBe('old-plat');
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
    expect(got?.lastSenderAccountId).toBe('acc-a');
  });

  it('round-trips giftForMessageId on append, get, and list', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ conversationId: opened.id, giftForMessageId: 'm-trigger' }),
    );
    expect((await store.getMessageById('m-1'))?.giftForMessageId).toBe('m-trigger');
    expect((await store.listMessages(opened.id, 10))[0]?.giftForMessageId).toBe('m-trigger');
  });

  it('returns the existing row when appending a duplicate message id', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    const first = await store.appendMessage(message({ id: 'm-dup', conversationId: opened.id }));
    const second = await store.appendMessage(
      message({ id: 'm-dup', conversationId: opened.id, text: 'other' }),
    );
    expect(second.text).toBe(first.text);
    expect(await store.listMessages(opened.id, 10)).toHaveLength(1);
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

  it('lets staff see a member_member thread when the platform account is a party', async () => {
    const store = new InMemoryConversationStore();
    const thread = await store.openMemberMember('plat', 'someone', NOW);
    expect((await store.listVisible('acc', true, 'plat', 10)).map((t) => t.id)).toEqual([
      thread.id,
    ]);
    expect(await store.listVisible('acc', true, 'other-plat', 10)).toEqual([]);
    expect(await store.listVisible('acc', true, null, 10)).toEqual([]);
    expect(await store.listVisible('acc', false, 'plat', 10)).toEqual([]);
  });

  it('orders same-timestamp messages by id and hydrates lastText from the newest id', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'm-z', conversationId: opened.id, text: 'later-id', createdAt: NOW }),
    );
    await store.appendMessage(
      message({ id: 'm-a', conversationId: opened.id, text: 'earlier-id', createdAt: NOW }),
    );
    expect((await store.listMessages(opened.id, 10)).map((r) => r.id)).toEqual(['m-a', 'm-z']);
    expect((await store.getById(opened.id))?.lastText).toBe('later-id');
    const claimed = await store.claimUnsigned(1, 1_000, 60_000);
    expect(claimed.map((r) => r.id)).toEqual(['m-a']);
  });

  it('orders messages by createdAt ascending when timestamps differ', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    const laterAt = new Date(NOW.getTime() + 1000);
    await store.appendMessage(
      message({ id: 'later', conversationId: opened.id, text: 'later', createdAt: laterAt }),
    );
    await store.appendMessage(
      message({ id: 'earlier', conversationId: opened.id, text: 'earlier', createdAt: NOW }),
    );
    expect((await store.listMessages(opened.id, 10)).map((r) => r.id)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('lists the newest thread page oldest-first with a cap and caller-owned copies', async () => {
    const later = new Date(NOW.getTime() + 1000);
    const newest = new Date(NOW.getTime() + 2000);
    const store = new InMemoryConversationStore(
      [thread()],
      [
        message({ id: 'm-old', createdAt: NOW, nostrEvent: { kind: 1059 } }),
        message({ id: 'm-a', createdAt: later }),
        message({ id: 'm-z', createdAt: later }),
        message({ id: 'm-new', createdAt: newest }),
        message({ id: 'm-other', conversationId: 'c-2', createdAt: newest }),
      ],
    );

    const listed = await store.listThreadPage({ conversationId: 'c-1', limit: 3, cursor: null });
    expect(listed.map((row) => row.id)).toEqual(['m-a', 'm-z', 'm-new']);
    listed[0]!.text = 'changed';
    listed[0]!.createdAt.setTime(0);
    listed[0]!.nostrEvent = { changed: true };

    const again = await store.listThreadPage({ conversationId: 'c-1', limit: 3, cursor: null });
    expect(again[0]?.text).toBe('hello');
    expect(again[0]?.createdAt).toEqual(later);
    expect(again[0]?.nostrEvent).toBeNull();
  });

  it('lists rows exclusively older than a thread cursor with same-timestamp id ordering', async () => {
    const tied = new Date(NOW.getTime() + 1000);
    const store = new InMemoryConversationStore(
      [thread()],
      [
        message({ id: 'm-old', createdAt: NOW }),
        message({ id: 'm-a', createdAt: tied }),
        message({ id: 'm-z', createdAt: tied }),
        message({ id: 'm-new', createdAt: new Date(NOW.getTime() + 2000) }),
      ],
    );

    const listed = await store.listThreadPage({
      conversationId: 'c-1',
      limit: 10,
      cursor: { c: tied, i: 'm-z' },
    });
    expect(listed.map((row) => row.id)).toEqual(['m-old', 'm-a']);
    expect(await store.listThreadPage({ conversationId: 'missing', limit: 10, cursor: null })).toEqual(
      [],
    );
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
    expect((await store.getById(opened.id))?.lastSenderAccountId).toBeNull();
  });

  it('hasInboundMessage is false for an empty thread', async () => {
    const store = new InMemoryConversationStore();
    const empty = await store.openMemberMember('a', 'b', NOW);
    const other = await store.openMemberMember('a', 'c', NOW);
    await store.appendMessage(message({ conversationId: other.id, senderAccountId: 'c' }));
    expect(await store.hasInboundMessage(empty.id, 'a', false, null)).toBe(false);
  });

  it('hasInboundMessage is false when every message is from the viewer', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'a' }));
    expect(await store.hasInboundMessage(opened.id, 'a', false, null)).toBe(false);
  });

  it('hasInboundMessage is true when a counterpart sent a message', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'b' }));
    expect(await store.hasInboundMessage(opened.id, 'a', false, null)).toBe(true);
  });

  it('hasInboundMessage is true for a Damus null sender', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: null }));
    expect(await store.hasInboundMessage(opened.id, 'acc', false, null)).toBe(true);
  });

  it('hasInboundMessage is true when staff sees only a platform send without actor', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'plat' }));
    expect(await store.hasInboundMessage(opened.id, 'staff', true, 'plat')).toBe(true);
  });

  it('hasInboundMessage is false when staff is the actor of a platform send', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(
      message({
        conversationId: opened.id,
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        actorName: 'Ada',
      }),
    );
    expect(await store.hasInboundMessage(opened.id, 'staff', true, 'plat')).toBe(false);
  });

  it('hasInboundMessage is true when staff sees a member send', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'mem' }));
    expect(await store.hasInboundMessage(opened.id, 'staff', true, 'plat')).toBe(true);
  });

  it('hasInboundMessage is true when a member views a platform send', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'plat' }));
    expect(await store.hasInboundMessage(opened.id, 'mem', false, 'plat')).toBe(true);
  });

  it('hasUnread is true for inbound never-read', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'b' }));
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(true);
  });

  it('hasUnread is false after markRead', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'b' }));
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(false);
  });

  it('hasUnread is true again for newer inbound after markRead', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'b' }));
    await store.markRead(opened.id, 'a', NOW);
    await store.appendMessage(
      message({
        id: 'm-2',
        conversationId: opened.id,
        senderAccountId: 'b',
        createdAt: new Date(NOW.getTime() + 1000),
      }),
    );
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(true);
  });

  it('hasUnread is false when inbound createdAt equals last_read_at', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'b', createdAt: NOW }),
    );
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(false);
  });

  it('hasUnread is false for outbound-only', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'a' }));
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(false);
  });

  it('hasUnread skips inbound messages that belong to another thread', async () => {
    const store = new InMemoryConversationStore();
    const keep = await store.openMemberMember('a', 'b', NOW);
    const other = await store.openMemberMember('c', 'd', NOW);
    await store.appendMessage(message({ conversationId: other.id, senderAccountId: 'd' }));
    expect(await store.hasUnread(keep.id, 'a', false, null)).toBe(false);
  });

  it('hasUnread is true for Damus null sender inbound never-read', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: null }));
    expect(await store.hasUnread(opened.id, 'acc', false, null)).toBe(true);
  });

  it('keeps last-read independent per account on the same thread', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'from-a', conversationId: opened.id, senderAccountId: 'a' }),
    );
    await store.appendMessage(
      message({ id: 'from-b', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(false);
    expect(await store.hasUnread(opened.id, 'b', false, null)).toBe(true);
  });

  it('hasUnread treats a platform send without actor as inbound for staff', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'plat' }));
    expect(await store.hasUnread(opened.id, 'staff', true, 'plat')).toBe(true);
    await store.appendMessage(
      message({ id: 'from-mem', conversationId: opened.id, senderAccountId: 'mem' }),
    );
    expect(await store.hasUnread(opened.id, 'staff', true, 'plat')).toBe(true);
  });

  it('hasUnread is false when staff is the actor of a platform send', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(
      message({
        conversationId: opened.id,
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        actorName: 'Ada',
      }),
    );
    expect(await store.hasUnread(opened.id, 'staff', true, 'plat')).toBe(false);
  });

  it('copies last-read seed Dates so callers cannot mutate the stamp', async () => {
    const stamp = new Date(NOW.getTime());
    const store = new InMemoryConversationStore(
      [],
      [message({ conversationId: 'c-1', senderAccountId: 'b' })],
      [{ accountId: 'a', conversationId: 'c-1', lastReadAt: stamp }],
    );
    stamp.setTime(0);
    expect(await store.hasUnread('c-1', 'a', false, null)).toBe(false);
  });

  it('countUnread is 3 for three inbound never-read messages', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'in-1', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.appendMessage(
      message({ id: 'in-2', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.appendMessage(
      message({ id: 'in-3', conversationId: opened.id, senderAccountId: 'b' }),
    );
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(3);
  });

  it('countUnread is 0 after markRead', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'in-1', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.appendMessage(
      message({ id: 'in-2', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.appendMessage(
      message({ id: 'in-3', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(0);
  });

  it('countUnread is 1 for newer inbound after markRead', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'b' }));
    await store.markRead(opened.id, 'a', NOW);
    await store.appendMessage(
      message({
        id: 'm-2',
        conversationId: opened.id,
        senderAccountId: 'b',
        createdAt: new Date(NOW.getTime() + 1000),
      }),
    );
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(1);
  });

  it('countUnread is 0 for outbound-only', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'a' }));
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(0);
  });

  it('countUnread counts only inbound in a mixed thread', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ id: 'out', conversationId: opened.id, senderAccountId: 'a' }),
    );
    await store.appendMessage(
      message({ id: 'in-1', conversationId: opened.id, senderAccountId: 'b' }),
    );
    await store.appendMessage(
      message({ id: 'in-2', conversationId: opened.id, senderAccountId: 'b' }),
    );
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(2);
  });

  it('countUnread counts gift-only inbound', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({
        conversationId: opened.id,
        senderAccountId: 'b',
        text: '',
        sats: 1,
      }),
    );
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(1);
  });

  it('countUnread counts Damus null sender inbound', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: null }));
    expect(await store.countUnread(opened.id, 'acc', false, null)).toBe(1);
  });

  it('countUnread skips inbound messages that belong to another thread', async () => {
    const store = new InMemoryConversationStore();
    const keep = await store.openMemberMember('a', 'b', NOW);
    const other = await store.openMemberMember('c', 'd', NOW);
    await store.appendMessage(message({ conversationId: other.id, senderAccountId: 'd' }));
    expect(await store.countUnread(keep.id, 'a', false, null)).toBe(0);
  });

  it('countUnread excludes inbound when createdAt equals last_read_at', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'b', createdAt: NOW }),
    );
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.countUnread(opened.id, 'a', false, null)).toBe(0);
  });

  it('markRead overwrites a previous stamp', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(
      message({
        conversationId: opened.id,
        senderAccountId: 'b',
        createdAt: new Date(NOW.getTime() + 1000),
      }),
    );
    await store.markRead(opened.id, 'a', NOW);
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(true);
    await store.markRead(opened.id, 'a', new Date(NOW.getTime() + 1000));
    expect(await store.hasUnread(opened.id, 'a', false, null)).toBe(false);
  });

  it('unreadCount matches listed GET unread (inbound yes, outbound-only member omitted)', async () => {
    const store = new InMemoryConversationStore();
    const inbound = await store.openMemberMember('a', 'b', NOW);
    await store.appendMessage(message({ conversationId: inbound.id, senderAccountId: 'b' }));
    const outbound = await store.openMemberMember('a', 'c', NOW);
    await store.appendMessage(message({ conversationId: outbound.id, senderAccountId: 'a' }));
    expect(await store.unreadCount('a', false, null)).toBe(1);
    await store.markRead(inbound.id, 'a', NOW);
    expect(await store.unreadCount('a', false, null)).toBe(0);
  });

  it('unreadCount lists outbound-only own platform tickets as unread false', async () => {
    const store = new InMemoryConversationStore();
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    await store.appendMessage(message({ conversationId: opened.id, senderAccountId: 'mem' }));
    expect(await store.unreadCount('mem', false, 'plat')).toBe(0);
    await store.appendMessage(
      message({ id: 'from-plat', conversationId: opened.id, senderAccountId: 'plat' }),
    );
    expect(await store.unreadCount('mem', false, 'plat')).toBe(1);
  });

  it('unreadCount includes moderator_group only when moderator is true', async () => {
    const store = new InMemoryConversationStore();
    const group = await store.ensureModeratorGroup('plat', NOW);
    await store.appendMessage(message({ conversationId: group.id, senderAccountId: 'mod-b' }));
    expect(await store.unreadCount('mod-a', true, 'plat')).toBe(0);
    expect(await store.unreadCount('mod-a', true, 'plat', true)).toBe(1);
  });

  it('unreadCount inspects outbound-only moderator_group without counting it unread', async () => {
    const store = new InMemoryConversationStore();
    const group = await store.ensureModeratorGroup('plat', NOW);
    await store.appendMessage(message({ conversationId: group.id, senderAccountId: 'mod-a' }));
    expect(await store.unreadCount('mod-a', true, 'plat', true)).toBe(0);
  });

  it('unreadCount counts a platform stipend row in moderator_group as unread for staff', async () => {
    const store = new InMemoryConversationStore();
    const group = await store.ensureModeratorGroup('plat', NOW);
    await store.appendMessage(
      message({ id: 'stipend', conversationId: group.id, senderAccountId: 'plat', sats: 1233 }),
    );
    expect(await store.unreadCount('mod-a', true, 'plat', true)).toBe(1);
  });

  it('unreadCount pins an existing empty moderator_group ahead of the list cap', async () => {
    const store = new InMemoryConversationStore();
    const older = new Date(NOW.getTime() - 60_000);
    await store.ensureModeratorGroup('plat', older);
    for (let i = 0; i < CONVERSATION_LIST_LIMIT; i += 1) {
      const opened = await store.openMemberMember('mod-a', `o${i}`, NOW);
      await store.appendMessage(
        message({
          id: `m-${i}`,
          conversationId: opened.id,
          senderAccountId: `o${i}`,
          createdAt: NOW,
        }),
      );
    }
    expect(await store.unreadCount('mod-a', true, 'plat', true)).toBe(CONVERSATION_LIST_LIMIT - 1);
  });

  it('getModeratorGroup returns undefined when no singleton exists', async () => {
    expect(await new InMemoryConversationStore().getModeratorGroup()).toBeUndefined();
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
    expect(got?.lastSenderAccountId).toBeNull();
    expect(got?.lastMessageAt.toISOString()).toBe('2026-08-29T13:00:00.000Z');
    expect(sql.queries[0]?.params).toEqual(['c1']);
  });

  it('getModeratorGroup selects the singleton kind', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresConversationStore(sql).getModeratorGroup()).toBeUndefined();
    expect(sql.queries[0]?.text).toMatch(/kind = 'moderator_group'/);
    expect(sql.queries[0]?.params).toEqual([]);
  });

  it('getModeratorGroup maps a singleton row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'g1',
        kind: 'moderator_group',
        account_a: 'plat',
        account_b: null,
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    const got = await new PostgresConversationStore(sql).getModeratorGroup();
    expect(got?.id).toBe('g1');
    expect(got?.kind).toBe('moderator_group');
  });

  it('getById returns undefined when no row matches', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresConversationStore(sql).getById('missing')).toBeUndefined();
  });

  it('maps null last_text to an empty string', async () => {
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
        last_text: null,
      },
    ];
    const got = await new PostgresConversationStore(sql).getById('c1');
    expect(got?.lastText).toBe('');
    expect(got?.lastSenderAccountId).toBeNull();
  });

  it('listVisible binds staff and platform filters', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.listVisible('acc', true, 'plat', 50);
    expect(sql.queries[0]?.params).toEqual(['acc', true, 'plat', 50, false]);
    expect(sql.queries[0]?.text).toMatch(/member_platform/);
    expect(sql.queries[0]?.text).toMatch(/moderator_group/);
    expect(sql.queries[0]?.text).toMatch(/AS last_sender_account_id/);
  });

  it('ensureModeratorGroup returns an existing row without inserting', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c-mod',
        kind: 'moderator_group',
        account_a: 'plat',
        account_b: null,
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: '',
      },
    ];
    const store = new PostgresConversationStore(sql);
    const opened = await store.ensureModeratorGroup('plat', NOW);
    expect(opened.id).toBe('c-mod');
    expect(opened.kind).toBe('moderator_group');
    expect(sql.executes).toHaveLength(0);
    expect(sql.queries[0]?.text).toMatch(/moderator_group/);
  });

  it('ensureModeratorGroup SELECT then INSERT binds kind moderator_group', async () => {
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
          id: 'c-mod',
          kind: 'moderator_group',
          account_a: 'plat',
          account_b: null,
          counterpart_pubkey: null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const opened = await store.ensureModeratorGroup('plat', NOW);
    expect(opened.id).toBe('c-mod');
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO conversation/);
    expect(sql.executes[0]?.text).toMatch(/moderator_group/);
    expect(sql.executes[0]?.params).toEqual([expect.any(String), 'plat', NOW]);
    expect(sql.queries).toHaveLength(2);
  });

  it('ensureModeratorGroup swallows unique_violation and re-selects', async () => {
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
          id: 'c-mod',
          kind: 'moderator_group',
          account_a: 'plat',
          account_b: null,
          counterpart_pubkey: null,
          created_at: NOW,
          last_message_at: NOW,
          last_text: '',
        },
      ];
    };
    const opened = await new PostgresConversationStore(sql).ensureModeratorGroup('plat', NOW);
    expect(opened.id).toBe('c-mod');
    expect(sql.queries).toHaveLength(2);
  });

  it('ensureModeratorGroup rethrows non-unique insert errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('insert boom');
    sql.queryImpl = () => [];
    await expect(
      new PostgresConversationStore(sql).ensureModeratorGroup('plat', NOW),
    ).rejects.toThrow('insert boom');
  });

  it('ensureModeratorGroup throws when re-select is empty', async () => {
    const sql = new MockSql();
    await expect(
      new PostgresConversationStore(sql).ensureModeratorGroup('plat', NOW),
    ).rejects.toThrow(/conversation open failed/);
  });

  it('hasInboundMessage binds EXISTS inbound predicate and returns true', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ exists: true }];
    const store = new PostgresConversationStore(sql);
    expect(await store.hasInboundMessage('c1', 'acc', true, 'plat')).toBe(true);
    expect(sql.queries[0]?.params).toEqual(['c1', 'acc', true, 'plat']);
    expect(sql.queries[0]?.text).toContain('EXISTS');
    expect(sql.queries[0]?.text).toContain('COALESCE(actor_account_id, sender_account_id)');
    expect(sql.queries[0]?.text).toContain('IS DISTINCT FROM');
  });

  it('hasInboundMessage is false when EXISTS is false', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ exists: false }];
    expect(await new PostgresConversationStore(sql).hasInboundMessage('c1', 'a', false, null)).toBe(
      false,
    );
    expect(sql.queries[0]?.params).toEqual(['c1', 'a', false, null]);
  });

  it('hasInboundMessage is false when the EXISTS row is missing', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresConversationStore(sql).hasInboundMessage('c1', 'staff', true, 'plat'),
    ).toBe(false);
  });

  it('hasInboundMessage is false when exists is not boolean true', async () => {
    const sql = new MockSql();
    sql.nextRows = [{}];
    expect(
      await new PostgresConversationStore(sql).hasInboundMessage('c1', 'mem', false, 'plat'),
    ).toBe(false);
  });

  it('hasUnread query text includes conversation_read and created_at', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ exists: true }];
    const store = new PostgresConversationStore(sql);
    expect(await store.hasUnread('c1', 'acc', true, 'plat')).toBe(true);
    expect(sql.queries[0]?.params).toEqual(['c1', 'acc', true, 'plat']);
    expect(sql.queries[0]?.text).toContain('EXISTS');
    expect(sql.queries[0]?.text).toContain('conversation_read');
    expect(sql.queries[0]?.text).toContain('created_at');
  });

  it('hasUnread is false when EXISTS is false', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ exists: false }];
    expect(await new PostgresConversationStore(sql).hasUnread('c1', 'a', false, null)).toBe(false);
    expect(sql.queries[0]?.params).toEqual(['c1', 'a', false, null]);
  });

  it('hasUnread is false when the EXISTS row is missing', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresConversationStore(sql).hasUnread('c1', 'staff', true, 'plat')).toBe(
      false,
    );
  });

  it('hasUnread is false when exists is not boolean true', async () => {
    const sql = new MockSql();
    sql.nextRows = [{}];
    expect(await new PostgresConversationStore(sql).hasUnread('c1', 'mem', false, 'plat')).toBe(
      false,
    );
  });

  it('countUnread query text includes COUNT, conversation_read and created_at', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ count: 1 }];
    const store = new PostgresConversationStore(sql);
    expect(await store.countUnread('c1', 'acc', true, 'plat')).toBe(1);
    expect(sql.queries[0]?.params).toEqual(['c1', 'acc', true, 'plat']);
    expect(sql.queries[0]?.text).toContain('COUNT');
    expect(sql.queries[0]?.text).toContain('conversation_read');
    expect(sql.queries[0]?.text).toContain('created_at');
  });

  it('countUnread maps bigint and string', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ count: 2n }];
    expect(await new PostgresConversationStore(sql).countUnread('c1', 'a', false, null)).toBe(2);
    sql.nextRows = [{ count: '3' }];
    expect(await new PostgresConversationStore(sql).countUnread('c1', 'a', false, null)).toBe(3);
    sql.nextRows = [{ count: 4 }];
    expect(await new PostgresConversationStore(sql).countUnread('c1', 'a', false, null)).toBe(4);
    sql.nextRows = [];
    expect(await new PostgresConversationStore(sql).countUnread('c1', 'a', false, null)).toBe(0);
    sql.nextRows = [{}];
    expect(await new PostgresConversationStore(sql).countUnread('c1', 'a', false, null)).toBe(0);
  });

  it('unreadCount uses listVisible then inbound/unread EXISTS', async () => {
    const sql = new MockSql();
    let calls = 0;
    sql.queryImpl = (sqlText: string) => {
      calls += 1;
      if (sqlText.includes('last_message_at')) {
        return [
          {
            id: 'c1',
            kind: 'member_member',
            account_a: 'a',
            account_b: 'b',
            counterpart_pubkey: null,
            created_at: NOW,
            last_message_at: NOW,
            last_text: 'hi',
            last_sender_account_id: 'b',
          },
        ];
      }
      return [{ exists: true }];
    };
    expect(await new PostgresConversationStore(sql).unreadCount('a', false, null)).toBe(1);
    expect(calls).toBe(3);
  });

  it('unreadCount omits empty member threads (no inbound, not own ticket)', async () => {
    const sql = new MockSql();
    sql.queryImpl = (sqlText: string) => {
      if (sqlText.includes('last_message_at')) {
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
            last_sender_account_id: null,
          },
        ];
      }
      return [{ exists: false }];
    };
    expect(await new PostgresConversationStore(sql).unreadCount('a', false, null)).toBe(0);
  });

  it('markRead is INSERT ON CONFLICT DO UPDATE', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.markRead('c1', 'acc', NOW);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO conversation_read/);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT/);
    expect(sql.executes[0]?.text).toMatch(/DO UPDATE/);
    expect(sql.executes[0]?.params).toEqual(['acc', 'c1', NOW]);
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

  it('openMemberPlatform updates account_b when the platform id changes', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        kind: 'member_platform',
        account_a: 'mem',
        account_b: 'old-plat',
        counterpart_pubkey: null,
        created_at: NOW,
        last_message_at: NOW,
        last_text: 'hi',
        last_sender_account_id: 'mem',
      },
    ];
    const store = new PostgresConversationStore(sql);
    const opened = await store.openMemberPlatform('mem', 'plat', NOW);
    expect(opened.id).toBe('c1');
    expect(opened.accountB).toBe('plat');
    expect(opened.lastText).toBe('hi');
    expect(opened.lastSenderAccountId).toBe('mem');
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/UPDATE conversation SET account_b/);
    expect(sql.executes[0]?.params).toEqual(['plat', 'c1']);
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

  it('retargetMemberPlatform updates every member_platform account_b', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.retargetMemberPlatform('plat');
    expect(sql.executes.at(-1)?.text).toMatch(/UPDATE conversation SET account_b = \$1/);
    expect(sql.executes.at(-1)?.text).toMatch(/kind = 'member_platform'/);
    expect(sql.executes.at(-1)?.text).toMatch(/account_a <> \$1/);
    expect(sql.executes.at(-1)?.params).toEqual(['plat']);
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
        actor_account_id: 'acc',
        actor_name: 'Ada',
        gift_for_message_id: 'm-trigger',
        event_id: null,
        nostr_publish_state: 'pending',
        nostr_event: null,
        claimed_until: null,
      },
    ];
    const store = new PostgresConversationStore(sql);
    const listed = await store.listMessages('c1', 20);
    expect(listed[0]?.text).toBe('hi');
    expect(listed[0]?.actorAccountId).toBe('acc');
    expect(listed[0]?.actorName).toBe('Ada');
    expect(listed[0]?.giftForMessageId).toBe('m-trigger');
    expect(sql.queries[0]?.text).toMatch(/gift_for_message_id/);
    expect(sql.queries[0]?.params).toEqual(['c1', 20]);
    expect(await store.getMessageById('m1')).toBeDefined();
    expect(await store.getMessageByEventId('ab'.repeat(32))).toBeDefined();
  });

  it('lists a Postgres thread page newest-first in SQL and reverses a copy', async () => {
    const sql = new MockSql();
    const newest = new Date(NOW.getTime() + 1000);
    sql.nextRows = [sqlMessage('m-new', newest), sqlMessage('m-old', NOW)];
    const originalRows = sql.nextRows.slice();

    const listed = await new PostgresConversationStore(sql).listThreadPage({
      conversationId: 'c1',
      limit: 2,
      cursor: null,
    });

    expect(listed.map((row) => row.id)).toEqual(['m-old', 'm-new']);
    expect(sql.nextRows).toEqual(originalRows);
    expect(sql.queries[0]?.text).toMatch(/WHERE conversation_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$2/);
    expect(sql.queries[0]?.text).not.toMatch(/created_at < \$3/);
    expect(sql.queries[0]?.params).toEqual(['c1', 2]);
  });

  it('binds the exclusive older cursor for a Postgres thread page', async () => {
    const sql = new MockSql();
    sql.nextRows = [sqlMessage('m-old', NOW)];
    const cursorAt = new Date(NOW.getTime() + 1000);

    const listed = await new PostgresConversationStore(sql).listThreadPage({
      conversationId: 'c1',
      limit: 20,
      cursor: { c: cursorAt, i: 'm-cursor' },
    });

    expect(listed.map((row) => row.id)).toEqual(['m-old']);
    expect(sql.queries[0]?.text).toMatch(
      /created_at < \$3 OR \(created_at = \$3 AND id < \$4\)/,
    );
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$2/);
    expect(sql.queries[0]?.params).toEqual(['c1', 20, cursorAt, 'm-cursor']);
  });

  it('getMessageById returns undefined when no row matches', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresConversationStore(sql).getMessageById('missing')).toBeUndefined();
  });

  it('appendMessage inserts then bumps last_message_at', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    const row = message({ claimedUntil: 5_000, nostrEvent: { kind: 1059 } });
    const created = await store.appendMessage(row);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO conversation_message/);
    expect(sql.executes[0]?.params[9]).toBe(row.nostrPublishState);
    expect(typeof sql.executes[0]?.params[10]).not.toBe('string');
    expect(sql.executes[0]?.params[10]).toStrictEqual(row.nostrEvent);
    expect(sql.executes[0]?.params[12]).toBe(row.actorAccountId);
    expect(sql.executes[0]?.params[13]).toBe(row.actorName);
    expect(sql.executes[0]?.text).toMatch(/gift_for_message_id/);
    expect(sql.executes[0]?.params[14]).toBeNull();
    expect(sql.executes[1]?.text).toMatch(/UPDATE conversation SET last_message_at/);
    expect(created.text).toBe('hello');
  });

  it('appendMessage binds a null nostrEvent unchanged', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    await store.appendMessage(message());
    expect(sql.executes[0]?.params[10]).toBeNull();
  });

  it('appendMessage binds empty actorName when the field is omitted', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    const row = message();
    delete (row as { actorName?: string }).actorName;
    await store.appendMessage(row);
    expect(sql.executes[0]?.params[12]).toBeNull();
    expect(sql.executes[0]?.params[13]).toBe('');
    expect(sql.executes[0]?.params[14]).toBeNull();
  });

  it('appendMessage binds giftForMessageId at the gift_for_message_id placeholder', async () => {
    const sql = new MockSql();
    const store = new PostgresConversationStore(sql);
    const row = message({ giftForMessageId: 'm-trigger' });
    await store.appendMessage(row);
    expect(sql.executes[0]?.text).toMatch(/gift_for_message_id/);
    expect(sql.executes[0]?.params[14]).toBe('m-trigger');
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

  it.each([
    ['Bun errno', { errno: '23505' }],
    ['measured Bun server-error shape', { code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' }],
  ])('appendMessage returns the existing row on %s unique_violation', async (_label, error) => {
    const sql = new MockSql();
    sql.executeError = error;
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

  it('appendMessage returns the event_id row when the id lookup is empty', async () => {
    const sql = new MockSql();
    sql.executeError = { code: '23505' };
    const existing = {
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
    };
    sql.queryImpl = (text: string) => (text.includes('WHERE id =') ? [] : [existing]);
    const found = await new PostgresConversationStore(sql).appendMessage(
      message({ eventId: 'ab'.repeat(32) }),
    );
    expect(found.id).toBe('m-existing');
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
    const nostrEvent = { k: 1 };
    expect(
      await new PostgresConversationStore(sql).updateSignedEvent('m', 'ab'.repeat(32), nostrEvent),
    ).toBe(false);
    expect(typeof sql.queries[0]?.params[2]).not.toBe('string');
    expect(sql.queries[0]?.params[2]).toStrictEqual(nostrEvent);
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

  it('maps a skipped publish state without remapping to pending', async () => {
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
        nostr_publish_state: 'skipped',
        nostr_event: null,
        claimed_until: null,
      },
    ];
    const row = await new PostgresConversationStore(sql).getMessageById('m1');
    expect(row?.nostrPublishState).toBe('skipped');
    expect(row?.eventId).toBeNull();
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
