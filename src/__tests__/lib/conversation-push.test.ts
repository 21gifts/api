import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  conversationPushRecipientIds,
  unsignedConversationDefaults,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import { inboxUnreadCountFor, notifyConversationMessage } from '@/lib/conversation-push';
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
    lastSenderAccountId: 'acc-a',
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
  });
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
      lightningAddress: null,
      lightningAddressVerified: false,
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
      thread: { ...opened, lastText: 'hello', lastSenderAccountId: 'acc-a' },
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
