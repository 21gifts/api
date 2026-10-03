import { describe, expect, it, vi } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import {
  publicExternalAuthorPosts,
  publicExternalAuthorProfile,
  publicExternalAuthorReplies,
} from '@/lib/nostr/external-profile';

const NOW = 1_700_000_000_000;
const NOTE = '14141414-1414-4141-8141-141414141414';
const PARENT = '15151515-1515-4151-8151-151515151515';
const MISSING = '17171717-1717-4171-8171-171717171717';
const OTHER = '16161616-1616-4161-8161-161616161616';
const NEWER = '19191919-1919-4191-8191-191919191919';

function row(overrides: Partial<MessageRow> & Pick<MessageRow, 'id'>): MessageRow {
  return {
    accountId: null,
    name: 'Ada',
    text: '',
    createdAt: new Date(NOW),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

function deps(store: InMemoryMessageStore): {
  store: InMemoryMessageStore;
  authStore: InMemoryAuthStore;
  now: () => number;
} {
  return { store, authStore: new InMemoryAuthStore(), now: () => NOW };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe('publicExternalAuthorProfile', () => {
  it('returns 404 for an id that is not a UUID', async () => {
    const result = await publicExternalAuthorProfile(
      deps(new InMemoryMessageStore()),
      'not-a-uuid',
    );
    expect(result).toEqual({ status: 404 });
  });

  it('returns the stored name and npub for an external note', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    const result = await publicExternalAuthorProfile(deps(store), NOTE);
    expect(result).toEqual({
      status: 200,
      body: { name: 'Ada', npub: npubEncode(pubkey), postCount: 1, replyCount: 0 },
    });
  });
});

describe('publicExternalAuthorPosts', () => {
  it('returns 404 for an id that is not a UUID', async () => {
    const result = await publicExternalAuthorPosts(deps(new InMemoryMessageStore()), 'not-a-uuid');
    expect(result).toEqual({ status: 404 });
  });

  it('returns 404 for a missing UUID', async () => {
    const result = await publicExternalAuthorPosts(deps(new InMemoryMessageStore()), MISSING);
    expect(result).toEqual({ status: 404 });
  });

  it('returns 404 for a deleted row', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    await store.markDeleted(NOTE, new Date(NOW), 'staff');
    expect(await publicExternalAuthorPosts(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns 404 when the seed has an accountId', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, accountId: 'acc', authorPubkey: pubkey, name: 'Ada' }));
    expect(await publicExternalAuthorPosts(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns 404 for a withheld non-zapper reply', async () => {
    const store = new InMemoryMessageStore();
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.create(
      row({
        id: NOTE,
        parentId: PARENT,
        authorPubkey: 'ab'.repeat(32),
        name: 'Ada',
      }),
    );
    expect(await publicExternalAuthorPosts(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns 200 empty posts for a zapper reply with no top-level note', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'cd'.repeat(32);
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.recordZapper(pubkey, '11'.repeat(32), new Date(NOW));
    await store.create(row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' }));
    expect(await publicExternalAuthorPosts(deps(store), NOTE)).toEqual({
      status: 200,
      messages: [],
    });
  });

  it('lists newest-first posts for a case-insensitive pubkey and counts attributed children', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    const otherPubkey = 'cd'.repeat(32);
    const zapperChild = 'ef'.repeat(32);
    const nonZapperChild = '11'.repeat(32);
    await store.create(
      row({
        id: NOTE,
        authorPubkey: pubkey.toUpperCase(),
        name: 'Ada',
        createdAt: new Date(NOW),
      }),
    );
    await store.create(
      row({
        id: NEWER,
        authorPubkey: pubkey,
        name: 'Ada',
        createdAt: new Date(NOW + 1000),
      }),
    );
    await store.create(
      row({
        id: OTHER,
        authorPubkey: otherPubkey,
        name: 'Other',
      }),
    );
    await store.create(
      row({
        id: '12121212-1212-4121-8121-121212121212',
        accountId: 'acc',
        authorPubkey: pubkey,
        name: 'Member',
      }),
    );
    await store.create(
      row({
        id: '13131313-1313-4131-8131-131313131313',
        authorPubkey: pubkey,
        name: 'Hidden',
      }),
    );
    await store.markDeleted('13131313-1313-4131-8131-131313131313', new Date(NOW), 'staff');
    await store.create(
      row({
        id: '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a',
        parentId: NOTE,
        authorPubkey: pubkey,
        name: 'Own reply',
      }),
    );
    await store.create(
      row({
        id: '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b',
        parentId: NOTE,
        accountId: 'acc',
        name: 'Member child',
      }),
    );
    await store.recordZapper(zapperChild, '22'.repeat(32), new Date(NOW));
    await store.create(
      row({
        id: '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c',
        parentId: NOTE,
        authorPubkey: zapperChild,
        name: 'Zapper child',
      }),
    );
    await store.create(
      row({
        id: '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d',
        parentId: NOTE,
        authorPubkey: nonZapperChild,
        name: 'External child',
      }),
    );
    await store.create(
      row({
        id: '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e',
        parentId: NOTE,
        accountId: 'acc',
        name: 'Deleted child',
      }),
    );
    await store.markDeleted('1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e', new Date(NOW), 'staff');
    const result = await publicExternalAuthorPosts(deps(store), NOTE);
    expect(result.status).toBe(200);
    if (result.status !== 200) {
      return;
    }
    expect(result.messages.map((message) => message.id)).toEqual([NEWER, NOTE]);
    expect(result.messages.find((message) => message.id === NOTE)?.replyCount).toBe(2);
    expect(result.messages.find((message) => message.id === NEWER)?.replyCount).toBe(0);
  });

  it('returns 503 when listPostsByPubkey throws and does not log pubkey text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pubkey = 'ab'.repeat(32);
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey })),
      listPostsByPubkey: () => Promise.reject(new Error('boom pubkey')),
    } as unknown as InMemoryMessageStore;
    const result = await publicExternalAuthorPosts(deps(store), NOTE);
    expect(result).toEqual({ status: 503 });
    const line = parsedEvents(warn).find(
      (event) => event['event'] === 'messages.external_posts.failed',
    );
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_posts.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
    expect(JSON.stringify(line)).not.toContain(pubkey);
    warn.mockRestore();
  });
});

describe('publicExternalAuthorReplies', () => {
  it('returns 404 for an id that is not a UUID', async () => {
    const result = await publicExternalAuthorReplies(
      deps(new InMemoryMessageStore()),
      'not-a-uuid',
    );
    expect(result).toEqual({ status: 404 });
  });

  it('returns 404 for a missing UUID', async () => {
    const result = await publicExternalAuthorReplies(deps(new InMemoryMessageStore()), MISSING);
    expect(result).toEqual({ status: 404 });
  });

  it('returns 404 for a deleted row', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    await store.markDeleted(NOTE, new Date(NOW), 'staff');
    expect(await publicExternalAuthorReplies(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns 404 when the seed has an accountId', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, accountId: 'acc', authorPubkey: pubkey, name: 'Ada' }));
    expect(await publicExternalAuthorReplies(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns 404 for a withheld non-zapper reply', async () => {
    const store = new InMemoryMessageStore();
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.create(
      row({
        id: NOTE,
        parentId: PARENT,
        authorPubkey: 'ab'.repeat(32),
        name: 'Ada',
      }),
    );
    expect(await publicExternalAuthorReplies(deps(store), NOTE)).toEqual({ status: 404 });
  });

  it('returns the zapper reply row without replyCount', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'cd'.repeat(32);
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.recordZapper(pubkey, '11'.repeat(32), new Date(NOW));
    await store.create(row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' }));
    const result = await publicExternalAuthorReplies(deps(store), NOTE);
    expect(result.status).toBe(200);
    if (result.status !== 200) {
      return;
    }
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe(NOTE);
    expect(result.messages[0]?.parentId).toBe(PARENT);
    expect(result.messages[0]).not.toHaveProperty('replyCount');
  });

  it('returns an empty list for a non-zapper top-level author even when replies exist', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    await store.create(
      row({
        id: OTHER,
        parentId: NOTE,
        authorPubkey: pubkey,
        name: 'Ada',
      }),
    );
    expect(await publicExternalAuthorReplies(deps(store), NOTE)).toEqual({
      status: 200,
      messages: [],
    });
    await store.recordZapper(pubkey, '11'.repeat(32), new Date(NOW));
    const result = await publicExternalAuthorReplies(deps(store), NOTE);
    expect(result.status).toBe(200);
    if (result.status !== 200) {
      return;
    }
    expect(result.messages.map((message) => message.id)).toEqual([OTHER]);
    expect(result.messages[0]?.parentId).toBe(NOTE);
    expect(result.messages[0]).not.toHaveProperty('replyCount');
  });

  it('returns 503 when listRepliesByPubkey throws and does not log pubkey text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pubkey = 'ab'.repeat(32);
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey })),
      listRepliesByPubkey: () => Promise.reject(new Error('boom pubkey')),
    } as unknown as InMemoryMessageStore;
    const result = await publicExternalAuthorReplies(deps(store), NOTE);
    expect(result).toEqual({ status: 503 });
    const line = parsedEvents(warn).find(
      (event) => event['event'] === 'messages.external_replies.failed',
    );
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_replies.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
    expect(JSON.stringify(line)).not.toContain(pubkey);
    warn.mockRestore();
  });
});
