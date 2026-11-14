import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  conversationPushRecipientIds,
  unsignedConversationDefaults,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import {
  inboxUnreadCountFor,
  notifyConversationMessage,
  removeUnadmittedDamusThreads,
} from '@/lib/conversation-push';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';

const NOW = new Date('2026-09-17T12:00:00.000Z');

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function thread(partial: Partial<ConversationThread> = {}): ConversationThread {
  return {
    id: 'c-1',
    kind: 'member_member',
    accountA: 'acc-a',
    accountB: 'acc-b',
    counterpartPubkey: null,
    createdAt: NOW,
    lastMessageAt: NOW,
    name: 'Bob',
    lastText: 'hi',
    lastMessageId: null,
    lastSenderAccountId: 'acc-a',
    lastActorAccountId: null,
    lastSats: 0,
    ...partial,
  };
}

function message(partial: Partial<ConversationMessageRow> = {}): ConversationMessageRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
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

async function subscribe(push: InMemoryPushStore, accountId: string): Promise<void> {
  await push.upsertSubscription({
    endpoint: `https://push.example/${accountId}`,
    accountId,
    p256dh: 'p',
    auth: 'a',
    createdAt: NOW,
    sessionToken: null,
  });
}

/** Listed unread for a staff viewer with the Moderators-group flag off. */
function unreadOfWithoutGroup(
  conversations: InMemoryConversationStore,
  accountId: string,
): Promise<number> {
  return conversations.unreadCount(accountId, true, 'plat', false);
}

describe('conversationPushRecipientIds', () => {
  it('notifies accountA for Damus inbound (null sender)', () => {
    expect(
      conversationPushRecipientIds(
        thread({ kind: 'member_damus', accountB: null, counterpartPubkey: 'aa'.repeat(32) }),
        null,
      ),
    ).toEqual(['acc-a']);
  });

  it('notifies nobody when the member sent on a Damus thread', () => {
    expect(
      conversationPushRecipientIds(
        thread({ kind: 'member_damus', accountB: null, counterpartPubkey: 'aa'.repeat(32) }),
        'acc-a',
      ),
    ).toEqual([]);
  });

  it('notifies the other member on member_member', () => {
    expect(conversationPushRecipientIds(thread(), 'acc-a')).toEqual(['acc-b']);
    expect(conversationPushRecipientIds(thread(), 'acc-b')).toEqual(['acc-a']);
  });

  it('notifies the other party on member_platform', () => {
    expect(
      conversationPushRecipientIds(thread({ kind: 'member_platform', accountB: 'plat' }), 'acc-a'),
    ).toEqual(['plat']);
    expect(
      conversationPushRecipientIds(thread({ kind: 'member_platform', accountB: 'plat' }), 'plat'),
    ).toEqual(['acc-a']);
  });

  it('drops null accountB and never includes the sender', () => {
    expect(
      conversationPushRecipientIds(thread({ kind: 'member_platform', accountB: null }), 'acc-a'),
    ).toEqual([]);
    expect(
      conversationPushRecipientIds(thread({ accountA: 'acc-a', accountB: 'acc-a' }), 'acc-a'),
    ).toEqual([]);
  });

  it('notifies other moderators on moderator_group, not accountA', () => {
    expect(
      conversationPushRecipientIds(
        thread({ kind: 'moderator_group', accountA: 'plat', accountB: null }),
        'mod-a',
        ['mod-a', 'mod-b'],
      ),
    ).toEqual(['mod-b']);
  });
});

describe('inboxUnreadCountFor', () => {
  it('uses staff false and platformId null when lookup throws', async () => {
    const conversations = new InMemoryConversationStore();
    const opened = await conversations.openMemberMember('acc-a', 'acc-b', NOW);
    await conversations.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'acc-b' }),
    );
    const auth = {
      getAccount: async () => {
        throw new Error('boom');
      },
      listAccounts: async () => {
        throw new Error('boom');
      },
    };
    const unread = await inboxUnreadCountFor(conversations, auth)('acc-a');
    expect(unread).toBe(1);
  });

  it('treats a missing account as non-staff and finds the platform id', async () => {
    const conversations = new InMemoryConversationStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'p'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const unread = await inboxUnreadCountFor(conversations, auth)('missing');
    expect(unread).toBe(0);
  });

  it('counts staff-visible platform unread via isStaffRole', async () => {
    const conversations = new InMemoryConversationStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'staff',
      linkingKey: null,
      role: 'moderator',
      name: 'Mod',
      forumLawsDismissed: false,
      location: null,
      viewKey: 's'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await auth.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'p'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const opened = await conversations.openMemberPlatform('mem', 'plat', NOW);
    await conversations.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'mem' }),
    );
    expect(await inboxUnreadCountFor(conversations, auth)('staff')).toBe(1);
  });

  it('treats founder and moderator identically for staff-visible platform unread', async () => {
    const conversations = new InMemoryConversationStore();
    const auth = new InMemoryAuthStore();
    for (const item of [
      { id: 'mod', role: 'moderator' as const, name: 'Mod', key: 'm' },
      { id: 'founder', role: 'founder' as const, name: 'Founder', key: 'f' },
    ]) {
      await auth.createAccount({
        id: item.id,
        linkingKey: null,
        role: item.role,
        name: item.name,
        forumLawsDismissed: false,
        location: null,
        viewKey: item.key.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
      });
    }
    await auth.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'p'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const opened = await conversations.openMemberPlatform('mem', 'plat', NOW);
    await conversations.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'mem' }),
    );
    const unreadOf = inboxUnreadCountFor(conversations, auth);
    expect(await unreadOf('mod')).toBe(1);
    expect(await unreadOf('founder')).toBe(1);
    // A staff-room message from someone else counts for every group member.
    const group = await conversations.ensureModeratorGroup('plat', NOW);
    await conversations.appendMessage(
      message({
        id: '33333333-3333-4333-8333-333333333333',
        conversationId: group.id,
        senderAccountId: 'someone-else',
      }),
    );
    const moderatorUnread = await unreadOf('mod');
    const founderUnread = await unreadOf('founder');
    expect(moderatorUnread).toBe(2);
    expect(founderUnread).toBe(moderatorUnread);
    // The platform account is not in the staff room, whatever role it carries.
    expect(await unreadOf('plat')).toBe(await unreadOfWithoutGroup(conversations, 'plat'));
  });
});

describe('notifyConversationMessage', () => {
  it('is a no-op when pushStore is omitted', async () => {
    const conversations = new InMemoryConversationStore();
    const auth = new InMemoryAuthStore();
    await notifyConversationMessage({
      conversations,
      authStore: auth,
      thread: thread(),
      message: message(),
      nowMs: NOW.getTime(),
    });
    expect(parsedEvents(warn)).toEqual([]);
  });

  it('enqueues for other moderators on moderator_group', async () => {
    const conversations = new InMemoryConversationStore();
    const group = await conversations.ensureModeratorGroup('plat', NOW);
    const push = new InMemoryPushStore();
    await subscribe(push, 'mod-b');
    const auth = new InMemoryAuthStore();
    for (const id of ['mod-a', 'mod-b'] as const) {
      await auth.createAccount({
        id,
        linkingKey: null,
        role: 'moderator',
        name: id,
        forumLawsDismissed: false,
        location: null,
        viewKey: `${id}-key`.padEnd(64, '0'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
    }
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: group,
      message: message({ conversationId: group.id, senderAccountId: 'mod-a' }),
      nowMs: NOW.getTime(),
    });
    const claimed = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('mod-b');
    expect(claimed[0]?.type).toBe('conversation');
    const payload = JSON.parse(claimed[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'conversation',
      title: 'Ada',
      body: 'hello',
      url: '/moderate/group',
      tag: `conversation:${group.id}`,
    });
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: group,
      message: message({
        id: '22222222-2222-4222-8222-222222222222',
        conversationId: group.id,
        senderAccountId: 'mod-a',
        name: '',
        text: 'later',
      }),
      nowMs: NOW.getTime(),
    });
    const emptyName = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(emptyName).toHaveLength(1);
    expect(JSON.parse(emptyName[0]?.payload ?? '{}')).toMatchObject({
      title: '21.gifts',
      body: 'later',
      url: '/moderate/group',
      tag: `conversation:${group.id}`,
    });
  });

  it('enqueues for a founder alongside moderators on moderator_group and excludes the sender', async () => {
    const conversations = new InMemoryConversationStore();
    const group = await conversations.ensureModeratorGroup('plat', NOW);
    const push = new InMemoryPushStore();
    const auth = new InMemoryAuthStore();
    const accounts: { id: string; role: 'moderator' | 'founder'; isPlatform?: boolean }[] = [
      { id: 'mod-a', role: 'moderator' },
      { id: 'mod-b', role: 'moderator' },
      { id: 'founder-a', role: 'founder' },
      // A platform account never receives the staff-room push, whatever role it carries.
      { id: 'plat', role: 'founder', isPlatform: true },
    ];
    for (const item of accounts) {
      await subscribe(push, item.id);
      await auth.createAccount({
        id: item.id,
        linkingKey: null,
        role: item.role,
        ...(item.isPlatform === true ? { isPlatform: true } : {}),
        name: item.id,
        forumLawsDismissed: false,
        location: null,
        viewKey: `${item.id}-key`.padEnd(64, '0'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
    }
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: group,
      message: message({ conversationId: group.id, senderAccountId: 'mod-a' }),
      nowMs: NOW.getTime(),
    });
    const afterModerator = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(afterModerator.map((row) => row.accountId).sort()).toEqual(['founder-a', 'mod-b']);
    expect(afterModerator.every((row) => row.type === 'conversation')).toBe(true);
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: group,
      message: message({
        id: '22222222-2222-4222-8222-222222222222',
        conversationId: group.id,
        senderAccountId: 'founder-a',
      }),
      nowMs: NOW.getTime(),
    });
    const afterFounder = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(afterFounder.map((row) => row.accountId).sort()).toEqual(['mod-a', 'mod-b']);
    expect(afterFounder.every((row) => row.type === 'conversation')).toBe(true);
  });

  it('skips recipients with zero subscriptions', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    const auth = new InMemoryAuthStore();
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: thread(),
      message: message({ senderAccountId: 'acc-a' }),
      nowMs: NOW.getTime(),
    });
    expect(await push.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('enqueues one conversation outbox with notif+inbox unreadCount', async () => {
    const conversations = new InMemoryConversationStore();
    const opened = await conversations.openMemberMember('acc-a', 'acc-b', NOW);
    await conversations.appendMessage(
      message({ conversationId: opened.id, senderAccountId: 'acc-a' }),
    );
    const push = new InMemoryPushStore();
    await subscribe(push, 'acc-b');
    const notifications = new InMemoryNotificationStore();
    await notifications.create({
      id: 'n-1',
      recipientAccountId: 'acc-b',
      actorAccountId: 'acc-a',
      type: 'forum_post',
      parentId: 'p',
      replyId: 'p',
      name: 'Ada',
      text: 'post',
      createdAt: NOW,
      readAt: null,
    });
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc-b',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await notifyConversationMessage({
      pushStore: push,
      notifications,
      conversations,
      authStore: auth,
      thread: {
        ...opened,
        lastText: 'hello',
        lastSenderAccountId: 'acc-a',
        lastActorAccountId: null,
      },
      message: message({
        conversationId: opened.id,
        senderAccountId: 'acc-a',
        name: 'Ada',
        text: 'hello',
      }),
      nowMs: NOW.getTime(),
    });
    const claimed = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe('conversation');
    expect(claimed[0]?.accountId).toBe('acc-b');
    expect(claimed[0]?.messageId).toBe('11111111-1111-4111-8111-111111111111');
    const payload = JSON.parse(claimed[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'conversation',
      title: 'Ada',
      body: 'hello',
      url: `/messages?c=${opened.id}`,
      tag: `conversation:${opened.id}`,
    });
    expect(payload['unreadCount']).toBe(1 + 1);
  });

  it('uses 21.gifts as title when the sender name is empty', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    await subscribe(push, 'acc-b');
    const auth = new InMemoryAuthStore();
    await notifyConversationMessage({
      pushStore: push,
      conversations,
      authStore: auth,
      thread: thread(),
      message: message({ name: '', senderAccountId: 'acc-a' }),
      nowMs: NOW.getTime(),
    });
    const claimed = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      title: '21.gifts',
      unreadCount: 0,
    });
  });

  it('logs and throws after a per-recipient enqueue failure', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    await subscribe(push, 'acc-b');
    push.enqueue = async () => {
      throw new Error('enqueue boom');
    };
    const auth = new InMemoryAuthStore();
    await expect(
      notifyConversationMessage({
        pushStore: push,
        conversations,
        authStore: auth,
        thread: thread(),
        message: message(),
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('conversations.push.failed');
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.push.failed')).toBe(true);
  });
});

describe('removeUnadmittedDamusThreads', () => {
  const noAccounts = {
    getAccount: async () => undefined,
    listAccounts: async () => [],
  };

  it('removes the threads, logs one event, and closes their device notifications with the new badge', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    const notifications = new InMemoryNotificationStore();
    await subscribe(push, 'acc');
    const inbound = await conversations.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    const inboundRow = message({ conversationId: inbound.id, senderAccountId: null });
    await conversations.appendMessage(inboundRow);
    await notifyConversationMessage({
      conversations,
      authStore: new InMemoryAuthStore(),
      pushStore: push,
      notifications,
      thread: (await conversations.getById(inbound.id)) as ConversationThread,
      message: inboundRow,
      nowMs: NOW.getTime(),
    });
    const before = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(before.map((row) => row.type)).toEqual(['conversation']);
    expect(JSON.parse(before[0]?.payload ?? '{}')).toMatchObject({
      tag: `conversation:${inbound.id}`,
      unreadCount: 1,
    });
    await push.markSent(before[0]?.id ?? '', NOW.getTime());
    const kept = await conversations.openMemberDamus('acc', 'bb'.repeat(32), NOW);
    await conversations.appendMessage(
      message({ id: 'kept-1', conversationId: kept.id, senderAccountId: 'acc' }),
    );
    await conversations.openMemberDamus('nosub', 'aa'.repeat(32), NOW);
    vi.spyOn(notifications, 'unreadCount').mockResolvedValue(2);
    warn.mockClear();

    expect(
      await removeUnadmittedDamusThreads({
        conversations,
        pushStore: push,
        notifications,
        auth: noAccounts,
        nowMs: NOW.getTime() + 120_000,
      }),
    ).toEqual({ threads: 2, messages: 1 });

    expect(parsedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'conversations.damus_cleanup', threads: 2, messages: 1 }),
    ]);
    expect(await conversations.unreadCount('acc', false, null)).toBe(0);
    expect((await conversations.listVisible('acc', false, null, 10)).map((t) => t.id)).toEqual([
      kept.id,
    ]);
    const dismiss = await push.claimPending(10, NOW.getTime() + 300_000, 60_000);
    expect(dismiss).toHaveLength(1);
    expect(dismiss[0]?.accountId).toBe('acc');
    expect(dismiss[0]?.type).toBe('dismiss');
    expect(JSON.parse(dismiss[0]?.payload ?? '{}')).toEqual({
      type: 'dismiss',
      tags: [`conversation:${inbound.id}`],
      unreadCount: 2,
    });
  });

  it('is a no-op with a zero event on a second run and without a notification store', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    await subscribe(push, 'acc');
    await conversations.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    const first = await removeUnadmittedDamusThreads({
      conversations,
      pushStore: push,
      auth: noAccounts,
      nowMs: NOW.getTime(),
    });
    expect(first).toEqual({ threads: 1, messages: 0 });
    const dismiss = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(JSON.parse(dismiss[0]?.payload ?? '{}')).toMatchObject({ unreadCount: 0 });
    const again = await conversations.openMemberDamus('acc', 'aa'.repeat(32), NOW);
    warn.mockClear();
    expect(
      await removeUnadmittedDamusThreads({
        conversations,
        pushStore: push,
        auth: noAccounts,
        nowMs: NOW.getTime(),
      }),
    ).toEqual({ threads: 0, messages: 0 });
    expect(parsedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'conversations.damus_cleanup', threads: 0, messages: 0 }),
    ]);
    expect((await conversations.getById(again.id))?.id).toBe(again.id);
    expect(await push.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('logs a failed removal and keeps booting', async () => {
    const conversations = new InMemoryConversationStore();
    vi.spyOn(conversations, 'removeDamusThreadsWithoutMemberMessage').mockRejectedValue(
      new Error('db down'),
    );
    expect(
      await removeUnadmittedDamusThreads({
        conversations,
        pushStore: new InMemoryPushStore(),
        auth: noAccounts,
        nowMs: NOW.getTime(),
      }),
    ).toEqual({ threads: 0, messages: 0 });
    expect(parsedEvents(warn)).toEqual([
      expect.objectContaining({ event: 'conversations.damus_cleanup.failed' }),
    ]);
  });

  it('logs a failed dismiss for one member and continues with the next', async () => {
    const conversations = new InMemoryConversationStore();
    const push = new InMemoryPushStore();
    await subscribe(push, 'second');
    await conversations.openMemberDamus('first', 'aa'.repeat(32), NOW);
    const second = await conversations.openMemberDamus('second', 'aa'.repeat(32), NOW);
    const list = push.listByAccount.bind(push);
    vi.spyOn(push, 'listByAccount').mockImplementation(async (accountId: string) => {
      if (accountId === 'first') {
        throw new Error('push down');
      }
      return list(accountId);
    });
    expect(
      await removeUnadmittedDamusThreads({
        conversations,
        pushStore: push,
        auth: noAccounts,
        nowMs: NOW.getTime(),
      }),
    ).toEqual({ threads: 2, messages: 0 });
    expect(parsedEvents(warn).map((e) => e['event'])).toEqual([
      'conversations.damus_cleanup',
      'conversations.damus_cleanup.dismiss_failed',
    ]);
    const dismiss = await push.claimPending(10, NOW.getTime(), 60_000);
    expect(dismiss.map((row) => row.accountId)).toEqual(['second']);
    expect(JSON.parse(dismiss[0]?.payload ?? '{}')).toMatchObject({
      tags: [`conversation:${second.id}`],
    });
  });
});
