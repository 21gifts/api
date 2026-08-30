import { describe, expect, it } from 'vitest';
import {
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

describe('serializeConversation', () => {
  it('emits public list fields without account or event ids', () => {
    const json = serializeConversation(THREAD);
    expect(json).toEqual({
      id: 'c-1',
      name: 'Ada',
      lastText: 'hello',
      lastAt: '2026-08-29T13:00:00.000Z',
    });
    expect(json).not.toHaveProperty('accountA');
    expect(json).not.toHaveProperty('accountId');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('npub');
  });
});

describe('serializeConversationMessage', () => {
  it('emits public message fields without account or event ids', () => {
    const json = serializeConversationMessage(ROW);
    expect(json).toEqual({
      id: 'm-1',
      name: 'Ada',
      text: 'hello',
      createdAt: '2026-08-29T13:00:00.000Z',
    });
    expect(json).not.toHaveProperty('accountId');
    expect(json).not.toHaveProperty('eventId');
    expect(json).not.toHaveProperty('senderAccountId');
    expect(json).not.toHaveProperty('senderPubkey');
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
