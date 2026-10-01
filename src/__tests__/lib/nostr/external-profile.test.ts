import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { publicExternalAuthorProfile } from '@/lib/nostr/external-profile';

const NOW = 1_700_000_000_000;
const NOTE = '14141414-1414-4141-8141-141414141414';

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
      body: { name: 'Ada', npub: npubEncode(pubkey) },
    });
  });
});
