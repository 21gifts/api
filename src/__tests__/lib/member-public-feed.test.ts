import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore, type MessageRow } from '@/lib/message-store';
import { loadMemberProfileNote, memberPublicMessages } from '@/lib/member-public-feed';

const createdAt = new Date(1_000_000);

function row(overrides: Partial<MessageRow> & Pick<MessageRow, 'id' | 'text'>): MessageRow {
  return {
    accountId: 'acc',
    name: 'Ada',
    createdAt,
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

async function ada(): Promise<Account> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    walletRequired: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
    profileMessageId: 'note-1',
  });
  const account = await store.getAccount('acc');
  if (account === undefined) {
    throw new Error('account missing');
  }
  return account;
}

describe('memberPublicMessages', () => {
  it('returns posts, shops, credits, and replies with hearted false for an anonymous viewer', async () => {
    const account = await ada();
    const messages = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await messages.create(row({ id: 'post-1', text: 'hello' }));
    await messages.create(row({ id: 'shop-1', text: '#21GiftsShop open' }));
    await messages.create(row({ id: 'credit-1', text: 'lend me', goalRepayable: true }));
    await messages.create(row({ id: 'reply-1', text: 'reply', parentId: 'post-1' }));
    const input = {
      account,
      messageStore: messages,
      authStore: auth,
      viewerAccountId: null,
    };
    const posts = await memberPublicMessages({ ...input, kind: 'posts' });
    const shops = await memberPublicMessages({ ...input, kind: 'shops' });
    const credits = await memberPublicMessages({ ...input, kind: 'credits' });
    const replies = await memberPublicMessages({ ...input, kind: 'replies' });
    expect(posts.map((message) => message.id).sort()).toEqual(['credit-1', 'post-1', 'shop-1']);
    expect(posts.every((message) => message.hearted === false)).toBe(true);
    expect(shops.map((message) => message.id)).toEqual(['shop-1']);
    expect(credits.map((message) => message.id)).toEqual(['credit-1']);
    expect(replies.map((message) => message.id)).toEqual(['reply-1']);
    expect(replies[0]?.hearted).toBe(false);
  });

  it('drops a post whose video file is missing', async () => {
    const account = await ada();
    const messages = new InMemoryMessageStore([
      row({ id: 'clip-1', text: 'clip', hasVideo: true, videoContentType: 'video/mp4' }),
    ]);
    const listed = await memberPublicMessages({
      kind: 'posts',
      account,
      messageStore: messages,
      authStore: new InMemoryAuthStore(),
      viewerAccountId: null,
    });
    expect(listed).toEqual([]);
    expect(await messages.getById('clip-1')).toBeUndefined();
  });
});

describe('loadMemberProfileNote', () => {
  it('returns the live note and false hearted for an anonymous viewer', async () => {
    const account = await ada();
    const messages = new InMemoryMessageStore([
      row({ id: 'note-1', text: 'I bake bread', hasPhoto: true }),
    ]);
    const note = await loadMemberProfileNote({
      account,
      messageStore: messages,
      viewerAccountId: null,
    });
    expect(note?.profileMessage.id).toBe('note-1');
    expect(note?.profileMessage.hearted).toBe(false);
    expect(note?.aboutMe).toBe('I bake bread');
    expect(note?.aboutMeHasPhoto).toBe(true);
  });

  it('returns null when the note is missing, blank, or soft-hidden', async () => {
    const account = await ada();
    const messages = new InMemoryMessageStore([
      row({ id: 'note-1', text: 'I bake bread', deletedAt: new Date(2_000_000) }),
    ]);
    expect(
      await loadMemberProfileNote({
        account: { ...account, profileMessageId: null },
        messageStore: messages,
        viewerAccountId: null,
      }),
    ).toBeNull();
    expect(
      await loadMemberProfileNote({
        account: { ...account, profileMessageId: '   ' },
        messageStore: messages,
        viewerAccountId: null,
      }),
    ).toBeNull();
    expect(
      await loadMemberProfileNote({
        account: { ...account, profileMessageId: 'missing' },
        messageStore: messages,
        viewerAccountId: null,
      }),
    ).toBeNull();
    expect(
      await loadMemberProfileNote({
        account,
        messageStore: messages,
        viewerAccountId: null,
      }),
    ).toBeNull();
  });
});
