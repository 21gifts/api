import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { DEFAULT_RELAY_PUBLIC, DEFAULT_RELAY_SPACE_PRD } from '@/lib/nostr/relays';
import { retractHiddenForumNotes } from '@/lib/nostr/retract';

const KEK = parseNostrKek('ef'.repeat(32));
const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const GIFT_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_EVENT = 'aa'.repeat(32);
const CHILD_EVENT = 'bb'.repeat(32);
const JPEG: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};

function forumRow(overrides: Partial<MessageRow> & Pick<MessageRow, 'id'>): MessageRow {
  return {
    accountId: 'acc',
    name: 'Ada',
    text: 'note',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

async function seededAuth(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'moderator',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await store.createAccount({
    id: 'child',
    linkingKey: null,
    role: 'verified',
    name: 'Bea',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await ensureAccountNostrKey(store, 'acc', KEK);
  await ensureAccountNostrKey(store, 'child', KEK);
  return store;
}

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

describe('retractHiddenForumNotes', () => {
  it('is a no-op when the target is missing', async () => {
    const publisher = new RecordingPublisher();
    await retractHiddenForumNotes(
      {
        store: new InMemoryMessageStore(),
        authStore: await seededAuth(),
        publisher,
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: {},
        fetchImpl: async () => new Response('{}', { status: 200 }),
      },
      PARENT_ID,
    );
    expect(publisher.calls).toEqual([]);
  });

  it('skips null eventId and null accountId and publishes author-signed kind:5', async () => {
    const auth = await seededAuth();
    const parentPub = await auth.getNostrPublicKey('acc');
    const childPub = await auth.getNostrPublicKey('child');
    expect(parentPub).toMatch(/^[0-9a-f]{64}$/);
    expect(childPub).toMatch(/^[0-9a-f]{64}$/);
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: PARENT_ID,
        eventId: PARENT_EVENT,
        nostrPublishState: 'published',
      }),
      JPEG,
    );
    await store.create(
      forumRow({
        id: CHILD_ID,
        accountId: 'child',
        name: 'Bea',
        eventId: CHILD_EVENT,
        nostrPublishState: 'published',
        createdAt: new Date('2026-09-20T00:01:00.000Z'),
        parentId: PARENT_ID,
      }),
    );
    await store.create(
      forumRow({
        id: GIFT_ID,
        accountId: 'child',
        name: 'Bea',
        eventId: null,
        nostrPublishState: 'skipped',
        text: '',
        createdAt: new Date('2026-09-20T00:02:00.000Z'),
        parentId: PARENT_ID,
      }),
    );
    await store.create(
      forumRow({
        id: '44444444-4444-4444-8444-444444444444',
        accountId: null,
        name: 'npub',
        eventId: 'cc'.repeat(32),
        createdAt: new Date('2026-09-20T00:03:00.000Z'),
        parentId: PARENT_ID,
      }),
    );
    const publisher = new RecordingPublisher();
    const fetches: string[] = [];
    await retractHiddenForumNotes(
      {
        store,
        authStore: auth,
        publisher,
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: {
          PUBLIC_BASE_URL: 'https://21.gifts',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'secret-token',
        },
        fetchImpl: async (input) => {
          fetches.push(String(input));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
      },
      PARENT_ID,
    );
    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[0]?.event['kind']).toBe(5);
    expect(publisher.calls[0]?.event['pubkey']).toBe(parentPub);
    expect((publisher.calls[0]?.event['tags'] as string[][])[0]).toEqual(['e', PARENT_EVENT]);
    expect(publisher.calls[1]?.event['pubkey']).toBe(childPub);
    expect((publisher.calls[1]?.event['tags'] as string[][])[0]).toEqual(['e', CHILD_EVENT]);
    expect(publisher.calls[0]?.urls[0]).toBe(DEFAULT_RELAY_SPACE_PRD);
    expect(publisher.calls[0]?.urls.slice(1)).toEqual([...DEFAULT_RELAY_PUBLIC]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain('/zones/zone/purge_cache');
  });

  it('logs messages.delete.nostr_failed when signing throws and still purges', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: PARENT_ID,
        eventId: PARENT_EVENT,
        nostrPublishState: 'published',
      }),
      JPEG,
    );
    const publisher = new RecordingPublisher();
    await retractHiddenForumNotes(
      {
        store,
        authStore: new InMemoryAuthStore(),
        publisher,
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: { PUBLIC_BASE_URL: 'https://21.gifts' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
      },
      PARENT_ID,
    );
    expect(publisher.calls).toEqual([]);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.nostr_failed')).toBe(
      true,
    );
    expect(parsedEvents(warn).some((e) => JSON.stringify(e).includes(PARENT_EVENT))).toBe(false);
  });

  it('logs messages.delete.nostr_failed when publish throws', async () => {
    const auth = await seededAuth();
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({ id: PARENT_ID, eventId: PARENT_EVENT, nostrPublishState: 'published' }),
    );
    const publisher = new RecordingPublisher();
    publisher.publish = async () => {
      throw new Error('relay down');
    };
    await retractHiddenForumNotes(
      {
        store,
        authStore: auth,
        publisher,
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: {},
        fetchImpl: async () => new Response('{}', { status: 200 }),
      },
      PARENT_ID,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.nostr_failed')).toBe(
      true,
    );
  });

  it('skips the Cloudflare POST when the hidden rows have no media', async () => {
    const auth = await seededAuth();
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: PARENT_ID,
        eventId: PARENT_EVENT,
        nostrPublishState: 'published',
      }),
    );
    let fetches = 0;
    await retractHiddenForumNotes(
      {
        store,
        authStore: auth,
        publisher: new RecordingPublisher(),
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: {
          PUBLIC_BASE_URL: 'https://21.gifts',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'secret-token',
        },
        fetchImpl: async () => {
          fetches += 1;
          return new Response('{}', { status: 200 });
        },
      },
      PARENT_ID,
    );
    expect(fetches).toBe(0);
  });

  it('skips purge when Cloudflare env or PUBLIC_BASE_URL is missing', async () => {
    const auth = await seededAuth();
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: PARENT_ID,
        eventId: PARENT_EVENT,
        nostrPublishState: 'published',
      }),
      JPEG,
    );
    let fetches = 0;
    await retractHiddenForumNotes(
      {
        store,
        authStore: auth,
        publisher: new RecordingPublisher(),
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: { PUBLIC_BASE_URL: 'https://21.gifts' },
        fetchImpl: async () => {
          fetches += 1;
          return new Response('{}', { status: 200 });
        },
      },
      PARENT_ID,
    );
    expect(fetches).toBe(0);
  });

  it('logs messages.delete.purge_failed on HTTP 500 without the token', async () => {
    const auth = await seededAuth();
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: PARENT_ID,
        eventId: PARENT_EVENT,
        nostrPublishState: 'published',
      }),
      JPEG,
    );
    await retractHiddenForumNotes(
      {
        store,
        authStore: auth,
        publisher: new RecordingPublisher(),
        kek: KEK,
        now: () => 1_700_000_000_000,
        env: {
          PUBLIC_BASE_URL: 'https://21.gifts',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'secret-token',
        },
        fetchImpl: async () => new Response('nope', { status: 500 }),
      },
      PARENT_ID,
    );
    const events = parsedEvents(warn).filter((e) => e['event'] === 'messages.delete.purge_failed');
    expect(events).toEqual([expect.objectContaining({ messageId: PARENT_ID })]);
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });
});
