import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { notifyForumMentions } from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';

const created = (mentions?: MessageRow['mentions']): MessageRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  accountId: 'ada',
  name: 'Ada',
  text: 'hi',
  createdAt: new Date(0),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
  ...(mentions === undefined ? {} : { mentions }),
});

describe('notifyForumMentions', () => {
  it('skips an empty list and a self mark', async () => {
    await notifyForumMentions({
      account: { id: 'ada' },
      created: created(),
      parentId: '11111111-1111-4111-8111-111111111111',
      isActive: false,
    });
    await notifyForumMentions({
      account: { id: 'ada' },
      created: created([{ accountId: 'ada', username: 'ada' }]),
      parentId: '11111111-1111-4111-8111-111111111111',
      isActive: false,
    });
  });

  it('notifies one person with and without the optional stores', async () => {
    const mark = created([{ accountId: 'bob', username: 'bob' }]);
    await notifyForumMentions({
      account: { id: 'ada' },
      created: mark,
      parentId: mark.id,
      isActive: true,
    });
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'bob',
      linkingKey: `02${'b'.repeat(64)}`,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
      username: 'bob',
      locale: 'de',
    });
    const notes = new InMemoryNotificationStore();
    await notifyForumMentions({
      account: { id: 'ada' },
      created: mark,
      parentId: mark.id,
      isActive: false,
      auth,
      notifications: notes,
      pushStore: new InMemoryPushStore(),
      inboxUnreadCount: async () => 0,
    });
    expect((await notes.listByRecipient('bob', 10)).map((row) => row.type)).toEqual([
      'forum_mention',
    ]);
  });
});
