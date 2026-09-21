import { describe, expect, it } from 'vitest';
import {
  conversationFromMe,
  conversationIsInbound,
  conversationPushRecipientIds,
  moderatorGroupDisplayName,
  serializeConversation,
  serializeConversationMessage,
  unsignedConversationDefaults,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';

const THREAD: ConversationThread = {
  id: 'c-1',
  kind: 'member_member',
  accountA: 'acc-a',
  accountB: 'acc-b',
  counterpartPubkey: null,
  createdAt: new Date('2026-08-29T12:00:00.000Z'),
  lastMessageAt: new Date('2026-08-29T13:00:00.000Z'),
  name: 'Ada',
  lastText: 'hello',
  lastSenderAccountId: 'acc-a',
  lastActorAccountId: null,
  lastSats: 0,
};

const ROW: ConversationMessageRow = {
  id: 'm-1',
  conversationId: 'c-1',
  text: 'hello',
  createdAt: new Date('2026-08-29T13:00:00.000Z'),
  senderAccountId: 'acc-a',
  senderPubkey: 'aa'.repeat(32),
  name: 'Ada',
  actorAccountId: 'acc-a',
  actorName: 'Ada',
  sats: 0,
  eventId: 'ef'.repeat(32),
  nostrPublishState: 'published',
  nostrEvent: { id: 'ef'.repeat(32), kind: 1059 },
  claimedUntil: null,
};

describe('conversationFromMe', () => {
  it('is false when actor and sender are null', () => {
    expect(
      conversationFromMe({
        senderAccountId: null,
        actorAccountId: null,
        viewerId: 'acc',
      }),
    ).toBe(false);
  });

  it('is true when actor is null and sender is the viewer', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'acc',
        actorAccountId: null,
        viewerId: 'acc',
      }),
    ).toBe(true);
  });

  it('is true when actor is the viewer even if sender is the platform', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        viewerId: 'staff',
      }),
    ).toBe(true);
  });

  it('is false when another staff is the actor of a platform send', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        actorAccountId: 'other-staff',
        viewerId: 'staff',
      }),
    ).toBe(false);
  });

  it('is false when a member views a staff actor on a platform send', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        viewerId: 'acc',
      }),
    ).toBe(false);
  });
});

describe('conversationIsInbound', () => {
  it('is the negation of conversationFromMe', () => {
    const inbound = {
      senderAccountId: 'plat' as string | null,
      actorAccountId: 'staff' as string | null,
      viewerId: 'acc',
    };
    expect(conversationIsInbound(inbound)).toBe(!conversationFromMe(inbound));
    expect(
      conversationIsInbound({
        senderAccountId: null,
        actorAccountId: null,
        viewerId: 'acc',
      }),
    ).toBe(true);
    expect(
      conversationIsInbound({
        senderAccountId: 'acc',
        actorAccountId: null,
        viewerId: 'acc',
      }),
    ).toBe(false);
  });
});

describe('serializeConversation', () => {
  it('emits public list fields without account or event ids', () => {
    const json = serializeConversation(THREAD, false, false, 0);
    expect(json).toEqual({
      id: 'c-1',
      kind: 'member_member',
      name: 'Ada',
      lastText: 'hello',
      lastAt: '2026-08-29T13:00:00.000Z',
      lastFromMe: false,
      lastSats: 0,
      unread: false,
      unreadMessageCount: 0,
    });
    expect(json).not.toHaveProperty('accountA');
    expect(json).not.toHaveProperty('accountId');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('npub');
    expect(json).not.toHaveProperty('lastSenderAccountId');
  });

  it('includes unreadMessageCount 3 when passed 3', () => {
    const json = serializeConversation(THREAD, false, true, 3);
    expect(json.unread).toBe(true);
    expect(json.unreadMessageCount).toBe(3);
  });

  it('keeps unread as the boolean argument even when the count is 0', () => {
    expect(serializeConversation(THREAD, false, true, 0).unread).toBe(true);
    expect(serializeConversation(THREAD, false, true, 0).unreadMessageCount).toBe(0);
    expect(serializeConversation(THREAD, false, false, 3).unread).toBe(false);
    expect(serializeConversation(THREAD, false, false, 3).unreadMessageCount).toBe(3);
  });

  it('includes accountId when given a non-empty counterpart id', () => {
    const json = serializeConversation(THREAD, false, false, 0, 'acc-b');
    expect(json.accountId).toBe('acc-b');
    expect(json).not.toHaveProperty('accountA');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('npub');
  });

  it('omits accountId when the counterpart id is null', () => {
    expect(serializeConversation(THREAD, false, false, 0, null)).not.toHaveProperty('accountId');
  });

  it('omits accountId when the counterpart id is empty', () => {
    expect(serializeConversation(THREAD, false, false, 0, '')).not.toHaveProperty('accountId');
  });

  it('copies counterpart kind for a platform thread', () => {
    const json = serializeConversation({ ...THREAD, kind: 'member_platform' }, true, false, 0);
    expect(json).toEqual({
      id: 'c-1',
      kind: 'member_platform',
      name: 'Ada',
      lastText: 'hello',
      lastAt: '2026-08-29T13:00:00.000Z',
      lastFromMe: true,
      lastSats: 0,
      unread: false,
      unreadMessageCount: 0,
    });
  });
});

describe('serializeConversationMessage', () => {
  it('emits public message fields with sender accountId and without event ids', () => {
    const json = serializeConversationMessage(ROW, false);
    expect(json).toEqual({
      id: 'm-1',
      name: 'Ada',
      text: 'hello',
      createdAt: '2026-08-29T13:00:00.000Z',
      fromMe: false,
      sats: 0,
      hasPhoto: false,
      photoCount: 0,
      accountId: 'acc-a',
    });
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('senderAccountId');
    expect(json).not.toHaveProperty('senderPubkey');
    expect(json).not.toHaveProperty('bytes');
    expect(json).not.toHaveProperty('photo');
  });

  it('defaults omitted photoCount to 1 when hasPhoto is true', () => {
    expect(serializeConversationMessage({ ...ROW, hasPhoto: true }, false)).toMatchObject({
      hasPhoto: true,
      photoCount: 1,
    });
  });

  it('defaults omitted hasPhoto and photoCount to false and 0', () => {
    expect(serializeConversationMessage(ROW, false)).toMatchObject({
      hasPhoto: false,
      photoCount: 0,
    });
  });

  it('omits accountId when senderAccountId is null', () => {
    expect(
      serializeConversationMessage({ ...ROW, senderAccountId: null }, false),
    ).not.toHaveProperty('accountId');
  });

  it('omits accountId when senderAccountId is empty', () => {
    expect(serializeConversationMessage({ ...ROW, senderAccountId: '' }, false)).not.toHaveProperty(
      'accountId',
    );
  });

  it('sets fromMe from the viewer-relative flag', () => {
    expect(serializeConversationMessage(ROW, true).fromMe).toBe(true);
  });

  it('uses sender name and accountId for members even when an actor is set', () => {
    const json = serializeConversationMessage(
      {
        ...ROW,
        name: '21.gifts',
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        actorName: 'Mod',
      },
      false,
    );
    expect(json.name).toBe('21.gifts');
    expect(json.accountId).toBe('plat');
  });

  it('uses actor name and accountId for staff when actorAccountId is set', () => {
    const json = serializeConversationMessage(
      {
        ...ROW,
        name: '21.gifts',
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        actorName: 'Mod',
      },
      true,
      { staff: true },
    );
    expect(json.name).toBe('Mod');
    expect(json.accountId).toBe('staff');
  });

  it('falls back to sender fields for staff when actorAccountId is missing', () => {
    const json = serializeConversationMessage(
      { ...ROW, name: '21.gifts', senderAccountId: 'plat', actorAccountId: null, actorName: '' },
      false,
      { staff: true },
    );
    expect(json.name).toBe('21.gifts');
    expect(json.accountId).toBe('plat');
  });

  it('falls back to sender name for staff when actorName is empty', () => {
    const json = serializeConversationMessage(
      {
        ...ROW,
        name: '21.gifts',
        senderAccountId: 'plat',
        actorAccountId: 'staff',
        actorName: '',
      },
      true,
      { staff: true },
    );
    expect(json.name).toBe('21.gifts');
    expect(json.accountId).toBe('staff');
  });

  it('emits giftFor when giftForMessageId is set', () => {
    const json = serializeConversationMessage({ ...ROW, giftForMessageId: 'm-trigger' }, false);
    expect(json.giftFor).toBe('m-trigger');
  });

  it('omits giftFor when giftForMessageId is unset or null', () => {
    expect(serializeConversationMessage(ROW, false)).not.toHaveProperty('giftFor');
    expect(
      serializeConversationMessage({ ...ROW, giftForMessageId: null }, false),
    ).not.toHaveProperty('giftFor');
    expect(
      serializeConversationMessage({ ...ROW, giftForMessageId: '' }, false),
    ).not.toHaveProperty('giftFor');
  });
});

describe('unsignedConversationDefaults', () => {
  it('returns pending columns with a null event id', () => {
    expect(unsignedConversationDefaults()).toEqual({
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
      actorAccountId: null,
      actorName: '',
    });
  });
});

describe('moderatorGroupDisplayName', () => {
  it('returns Moderators for moderator_group and null otherwise', () => {
    expect(moderatorGroupDisplayName('moderator_group')).toBe('Moderators');
    expect(moderatorGroupDisplayName('member_member')).toBeNull();
    expect(moderatorGroupDisplayName('member_platform')).toBeNull();
    expect(moderatorGroupDisplayName('member_damus')).toBeNull();
  });
});

describe('conversationPushRecipientIds', () => {
  it('returns the counterpart on member_member', () => {
    expect(conversationPushRecipientIds(THREAD, 'acc-a')).toEqual(['acc-b']);
  });

  it('notifies other moderators on moderator_group, not the platform account', () => {
    const group: ConversationThread = {
      ...THREAD,
      kind: 'moderator_group',
      accountA: 'plat',
      accountB: null,
    };
    expect(conversationPushRecipientIds(group, 'mod-a', ['mod-a', 'mod-b'])).toEqual(['mod-b']);
    expect(conversationPushRecipientIds(group, 'mod-a')).toEqual([]);
  });
});
