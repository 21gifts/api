import { describe, expect, it } from 'vitest';
import {
  conversationFromMe,
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
};

const ROW: ConversationMessageRow = {
  id: 'm-1',
  conversationId: 'c-1',
  text: 'hello',
  createdAt: new Date('2026-08-29T13:00:00.000Z'),
  senderAccountId: 'acc-a',
  senderPubkey: 'aa'.repeat(32),
  name: 'Ada',
  eventId: 'ef'.repeat(32),
  nostrPublishState: 'published',
  nostrEvent: { id: 'ef'.repeat(32), kind: 1059 },
  claimedUntil: null,
};

describe('conversationFromMe', () => {
  it('is false when the sender is unknown', () => {
    expect(
      conversationFromMe({
        senderAccountId: null,
        viewerId: 'acc',
        staff: true,
        platformId: 'plat',
      }),
    ).toBe(false);
  });

  it('is true when the sender is the viewer', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'acc',
        viewerId: 'acc',
        staff: false,
        platformId: null,
      }),
    ).toBe(true);
  });

  it('is true when staff is acting as the platform sender', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        viewerId: 'staff',
        staff: true,
        platformId: 'plat',
      }),
    ).toBe(true);
  });

  it('is false when staff is viewing a member sender', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'mem',
        viewerId: 'staff',
        staff: true,
        platformId: 'plat',
      }),
    ).toBe(false);
  });

  it('is false when a member views the platform sender', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        viewerId: 'acc',
        staff: false,
        platformId: 'plat',
      }),
    ).toBe(false);
  });

  it('is false when staff has no platform id', () => {
    expect(
      conversationFromMe({
        senderAccountId: 'plat',
        viewerId: 'staff',
        staff: true,
        platformId: null,
      }),
    ).toBe(false);
  });
});

describe('serializeConversation', () => {
  it('emits public list fields without account or event ids', () => {
    const json = serializeConversation(THREAD, false);
    expect(json).toEqual({
      id: 'c-1',
      kind: 'member_member',
      name: 'Ada',
      lastText: 'hello',
      lastAt: '2026-08-29T13:00:00.000Z',
      lastFromMe: false,
    });
    expect(json).not.toHaveProperty('accountA');
    expect(json).not.toHaveProperty('accountId');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('npub');
    expect(json).not.toHaveProperty('lastSenderAccountId');
  });

  it('copies counterpart kind for a platform thread', () => {
    const json = serializeConversation({ ...THREAD, kind: 'member_platform' }, true);
    expect(json).toEqual({
      id: 'c-1',
      kind: 'member_platform',
      name: 'Ada',
      lastText: 'hello',
      lastAt: '2026-08-29T13:00:00.000Z',
      lastFromMe: true,
    });
  });
});

describe('serializeConversationMessage', () => {
  it('emits public message fields without account or event ids', () => {
    const json = serializeConversationMessage(ROW, false);
    expect(json).toEqual({
      id: 'm-1',
      name: 'Ada',
      text: 'hello',
      createdAt: '2026-08-29T13:00:00.000Z',
      fromMe: false,
    });
    expect(json).not.toHaveProperty('accountId');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('senderAccountId');
    expect(json).not.toHaveProperty('senderPubkey');
  });

  it('sets fromMe from the viewer-relative flag', () => {
    expect(serializeConversationMessage(ROW, true).fromMe).toBe(true);
  });
});

describe('unsignedConversationDefaults', () => {
  it('returns pending columns with a null event id', () => {
    expect(unsignedConversationDefaults()).toEqual({
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
  });
});
