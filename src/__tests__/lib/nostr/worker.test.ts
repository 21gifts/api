import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { RecordingQuerier } from '@/lib/nostr/query';
import { DEFAULT_RELAY_PUBLIC } from '@/lib/nostr/relays';
import { runNostrWorkerTick, startNostrWorker, type NostrWorkerDeps } from '@/lib/nostr/worker';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

const mockedDecode = vi.mocked(decodeBolt11);

const KEK = parseNostrKek('cd'.repeat(32));

/** Dummy fetch that never resolves LNURL metadata. */
function dummyFetch(): FetchFn {
  return async () => new Response('{}', { status: 500 });
}

/** Build worker deps with querier + fetch defaults so existing cases stay short. */
function deps(
  partial: Omit<NostrWorkerDeps, 'querier' | 'fetchImpl'> &
    Partial<Pick<NostrWorkerDeps, 'querier' | 'fetchImpl' | 'verifyReceipt'>>,
): NostrWorkerDeps {
  return {
    querier: partial.querier ?? new RecordingQuerier(),
    fetchImpl: partial.fetchImpl ?? dummyFetch(),
    ...partial,
  };
}

async function seed(): Promise<{
  auth: InMemoryAuthStore;
  messages: InMemoryMessageStore;
}> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await ensureAccountNostrKey(auth, 'acc', KEK);
  const messages = new InMemoryMessageStore();
  await messages.create({
    id: 'm1',
    accountId: 'acc',
    name: 'Ada',
    text: 'hello',
    createdAt: new Date('2026-08-28T00:00:00.000Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
  });
  return { auth, messages };
}

describe('runNostrWorkerTick', () => {
  it('re-signs pending kind:1 events that lack t=bitcoin', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello',
      tags: [
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const row = await messages.getById('m1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.eventId).not.toBe('ab'.repeat(32));
    expect(row?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('re-signs pending rows with a null stored event', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'm-null',
      accountId: 'acc',
      name: 'Ada',
      text: 'later',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
      nostrEvent: null,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m-null'))?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('re-signs a legacy note even when newer bitcoin-tagged notes are pending', async () => {
    const { auth, messages } = await seed();
    const modern = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    for (let i = 0; i < 20; i += 1) {
      const id = `n${String(i).padStart(2, '0')}`;
      await messages.create({
        id,
        accountId: 'acc',
        name: 'Ada',
        text: `n${i}`,
        createdAt: new Date(Date.parse('2026-08-27T00:00:00.000Z') + i * 1000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      });
      await messages.updateSignedEvent(id, `${i.toString(16).padStart(2, '0')}`.repeat(32), {
        kind: 1,
        content: `n${i}\n\n#bitcoin #21gifts`,
        tags: modern,
        created_at: 1,
      });
    }
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello',
      tags: [['t', '21gifts']],
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const m1 = await messages.getById('m1');
    expect(m1?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
    expect(String(m1?.nostrEvent?.['content'])).toContain('#bitcoin');
    expect(String(m1?.nostrEvent?.['content'])).toContain('#21gifts');
  });

  it('leaves pending kind:1 events that already have t=bitcoin', async () => {
    const { auth, messages } = await seed();
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    const eventId = 'cd'.repeat(32);
    await messages.updateSignedEvent('m1', eventId, {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags,
      created_at: 1,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toBe(eventId);
  });

  it('re-signs published unpaid notes whose content lacks Damus hashtags', async () => {
    const { auth, messages } = await seed();
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    await messages.create({
      id: 'm-hashtag',
      accountId: 'acc',
      name: 'Ada',
      text: 'ohne foto funktioniert es',
      createdAt: new Date('2026-08-28T00:10:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m-hashtag', 'ab'.repeat(32), {
      kind: 1,
      content: 'ohne foto funktioniert es',
      tags,
      created_at: 1,
    });
    await messages.updatePublishState('m-hashtag', 'published', 'space');
    await messages.create({
      id: 'm-hashtag-zapped',
      accountId: 'acc',
      name: 'Ada',
      text: 'ohne foto funktioniert es',
      createdAt: new Date('2026-08-28T00:11:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m-hashtag-zapped', 'cd'.repeat(32), {
      kind: 1,
      content: 'ohne foto funktioniert es',
      tags,
      created_at: 1,
    });
    await messages.updatePublishState('m-hashtag-zapped', 'published', 'space');
    await messages.addSats('m-hashtag-zapped', 21);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const unpaid = await messages.getById('m-hashtag');
    expect(unpaid?.eventId).not.toBe('ab'.repeat(32));
    expect(String(unpaid?.nostrEvent?.['content'])).toContain('#bitcoin');
    expect(String(unpaid?.nostrEvent?.['content'])).toContain('#21gifts');
    expect(String(unpaid?.nostrEvent?.['content'])).toContain('ohne foto funktioniert es');
    const zapped = await messages.getById('m-hashtag-zapped');
    expect(zapped?.eventId).toBe('cd'.repeat(32));
    expect(zapped?.nostrEvent?.['content']).toBe('ohne foto funktioniert es');
    expect(zapped?.sats).toBe(21);
  });

  it('re-signs pending rows whose stored event has no tag array', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ef'.repeat(32), { kind: 1, content: 'hello' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('signs without publishing when NOSTR_PUBLISH is off', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const row = await messages.getById('m1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.calls).toHaveLength(0);
  });

  it('publishes to space when NOSTR_PUBLISH=1', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect(publisher.calls.length).toBeGreaterThan(0);
    expect(publisher.calls[0]?.urls).toEqual(['wss://relay.nostr.space']);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
    const afterFirst = publisher.calls.length;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    expect(publisher.calls.length).toBe(afterFirst);
  });

  it('publishes kind:0 with the database name before kind:1', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const kinds = publisher.calls.map((call) => call.event['kind']);
    expect(kinds[0]).toBe(0);
    expect(JSON.parse(String(publisher.calls[0]?.event['content']))).toEqual({
      name: 'Ada',
      display_name: 'Ada',
      website: 'https://21.gifts',
      picture: 'https://21.gifts/apple-touch-icon.png',
    });
    expect(kinds).toContain(10002);
    expect(kinds).toContain(1);
  });

  it('publishes kind:10002 with the write-set relays', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    const relays = publisher.calls.find((call) => call.event['kind'] === 10002);
    expect(relays?.event['tags']).toEqual([
      ['r', 'wss://relay.nostr.space'],
      ['r', 'wss://relay.damus.io'],
    ]);
    expect(relays?.urls).toEqual(['wss://relay.nostr.space', 'wss://relay.damus.io']);
  });

  it('republishes kind:10002 when the write-set grows', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const space = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    const both = {
      ...space,
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: space,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env: both,
      }),
    );
    const lists = publisher.calls.filter((call) => call.event['kind'] === 10002);
    expect(lists).toHaveLength(2);
    expect(lists[0]?.event['tags']).toEqual([['r', 'wss://relay.nostr.space']]);
    expect(lists[1]?.event['tags']).toEqual([
      ['r', 'wss://relay.nostr.space'],
      ['r', 'wss://relay.damus.io'],
    ]);
    expect(Number(lists[1]?.event['created_at'])).toBeGreaterThan(
      Number(lists[0]?.event['created_at']),
    );
  });

  it('embeds a public photo URL and imeta on kind:1', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-pic',
        accountId: 'acc',
        name: 'Ada',
        text: 'pic',
        createdAt: new Date('2026-08-28T00:02:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://dev.21.gifts',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const notes = publisher.calls
      .filter((call) => call.event['kind'] === 1)
      .map((call) => String(call.event['content']));
    expect(notes).toContain(
      'pic\nhttps://dev-api.21.gifts/messages/m-pic/photo.jpg\n\n#bitcoin #21gifts',
    );
    const note = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).includes('m-pic/photo'),
    );
    expect(note?.event['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
      ['imeta', 'url https://dev-api.21.gifts/messages/m-pic/photo.jpg', 'm image/jpeg'],
    ]);
  });

  it('re-signs published photo posts that lack the photo URL', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-photo',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:03:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    );
    await messages.updateSignedEvent('m-photo', 'ab'.repeat(32), {
      kind: 1,
      content: '',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.updatePublishState('m-photo', 'published', 'space');
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const row = await messages.getById('m-photo');
    expect(row?.eventId).not.toBe('ab'.repeat(32));
    expect(String(row?.nostrEvent?.['content'])).toContain('/messages/m-photo/photo.png');
  });

  it('does not reset published photo posts when PUBLIC_BASE_URL is unset', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-nophoto-url',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:04:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    );
    await messages.updateSignedEvent('m-nophoto-url', 'ab'.repeat(32), {
      kind: 1,
      content: '#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.updatePublishState('m-nophoto-url', 'published', 'space');
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    const row = await messages.getById('m-nophoto-url');
    expect(row?.eventId).toBe('ab'.repeat(32));
    expect(row?.nostrPublishState).toBe('published');
  });

  it('does not reset a zapped photo post that lacks the photo URL', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-zapped-photo',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:08:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    );
    await messages.updateSignedEvent('m-zapped-photo', 'ab'.repeat(32), {
      kind: 1,
      content: '',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.updatePublishState('m-zapped-photo', 'published', 'space');
    await messages.addSats('m-zapped-photo', 21);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {
          NOSTR_PUBLISH: '1',
          NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
          PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
        },
      }),
    );
    const row = await messages.getById('m-zapped-photo');
    expect(row?.eventId).toBe('ab'.repeat(32));
    expect(row?.nostrPublishState).toBe('published');
    expect(row?.sats).toBe(21);
  });

  it('publishes a pending photo snapshot even without the photo URL', async () => {
    const { auth, messages } = await seed();
    const jpeg: { contentType: 'image/jpeg'; bytes: Uint8Array } = {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    await messages.create(
      {
        id: 'm-stale',
        accountId: 'acc',
        name: 'Ada',
        text: 'hallo',
        createdAt: new Date('2026-08-28T00:05:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      jpeg,
    );
    await messages.updateSignedEvent('m-stale', 'ab'.repeat(32), {
      kind: 1,
      id: 'ab'.repeat(32),
      content: 'hallo',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    messages.listSignedMissingPhoto = async () => [];
    messages.listSignedMissingHashtags = async () => [];
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: {
          NOSTR_PUBLISH: '1',
          NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
          PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
        },
      }),
    );
    expect(
      publisher.calls.some(
        (call) => call.event['kind'] === 1 && call.event['id'] === 'ab'.repeat(32),
      ),
    ).toBe(true);
    expect((await messages.getById('m-stale'))?.eventId).toBe('ab'.repeat(32));
    expect((await messages.getById('m-stale'))?.nostrPublishState).toBe('published');
  });

  it('signs a photo note without a URL when getPhoto returns null', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-missing-bytes',
        accountId: 'acc',
        name: 'Ada',
        text: 'hallo',
        createdAt: new Date('2026-08-28T00:10:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    messages.getPhoto = async () => null;
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const row = await messages.getById('m-missing-bytes');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.nostrEvent?.['content']).toBe('hallo\n\n#bitcoin #21gifts');
    expect(row?.nostrPublishState).toBe('published');
  });

  it('publishes a zapped URL-less photo snapshot instead of resetting it', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-zap-pending',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:09:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    await messages.updateSignedEvent('m-zap-pending', 'ab'.repeat(32), {
      kind: 1,
      id: 'ab'.repeat(32),
      content: '',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.addSats('m-zap-pending', 7);
    messages.listSignedMissingPhoto = async () => [];
    messages.listSignedMissingHashtags = async () => [];
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: {
          NOSTR_PUBLISH: '1',
          NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
          PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
        },
      }),
    );
    expect((await messages.getById('m-zap-pending'))?.eventId).toBe('ab'.repeat(32));
    expect(
      publisher.calls.some(
        (call) => call.event['kind'] === 1 && call.event['id'] === 'ab'.repeat(32),
      ),
    ).toBe(true);
  });

  it('publishes URL-less photo notes when PUBLIC_BASE_URL is unset', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-plain-photo',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:07:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const row = await messages.getById('m-plain-photo');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.nostrEvent?.['content']).toBe('#bitcoin #21gifts');
    expect(row?.nostrPublishState).toBe('published');
    expect(
      publisher.calls.some(
        (call) =>
          call.event['kind'] === 1 &&
          call.event['content'] === '#bitcoin #21gifts' &&
          call.event['id'] === row?.eventId,
      ),
    ).toBe(true);
  });

  it('includes lud16 on kind:0 when the account has a Lightning Address', async () => {
    const { auth, messages } = await seed();
    const acc = await auth.getAccount('acc');
    expect(acc).toBeDefined();
    await auth.updateAccount({ ...acc!, lightningAddress: 'ada@walletofsatoshi.com' });
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    const profileJson = JSON.parse(String(profile?.event['content'])) as {
      lud16: string;
      picture: string;
    };
    expect(profileJson.lud16).toBe('ada@walletofsatoshi.com');
    expect(profileJson.picture).toBe('https://21.gifts/apple-touch-icon.png');
  });

  it('publishes a name that changed after listAccounts', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    const originalList = auth.listAccounts.bind(auth);
    auth.listAccounts = async () => {
      const rows = await originalList();
      const acc = await auth.getAccount('acc');
      await auth.updateAccount({ ...acc!, name: 'Anton' });
      return rows;
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    expect(JSON.parse(String(profile?.event['content'])).name).toBe('Anton');
  });

  it('publishes kind:0 to public relays when NOSTR_PUBLISH_PUBLIC=1', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    expect(profile?.urls).toEqual(['wss://relay.nostr.space', 'wss://relay.damus.io']);
  });

  it('retries kind:0 when public relays nack and space acks', async () => {
    const { auth, messages } = await seed();
    const space = 'wss://relay.nostr.space';
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      return urls.map((url) => ({ url, ok: url === space }));
    };
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(2);
  });

  it('keeps kind:0 created_at after a public nack in the same second', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const space = 'wss://relay.nostr.space';
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      return urls.map((url) => ({ url, ok: url === space }));
    };
    const t = 1_700_000_000_000;
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => t,
        env,
      }),
    );
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => t,
        env,
      }),
    );
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.event['created_at']).toBe(1_700_000_000);
    expect(profiles[1]?.event['created_at']).toBe(1_700_000_001);
    expect(JSON.parse(String(profiles[1]?.event['content'])).name).toBe('Anton');
  });

  it('stamps kind:0 created_at at sign time not tick start', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    let t = 1_700_000_000_000;
    const originalPub = auth.getNostrPublicKey.bind(auth);
    auth.getNostrPublicKey = async (accountId: string) => {
      t = 1_700_000_005_000;
      return originalPub(accountId);
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => t,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    expect(profile?.event['created_at']).toBe(1_700_000_005);
  });

  it('skips kind:0 when the account has no name', async () => {
    const { auth, messages } = await seed();
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: null });
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect(publisher.calls.every((call) => call.event['kind'] !== 0)).toBe(true);
  });

  it('skips kind:0 when the account has no Nostr key', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'nameless-key',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'e'.repeat(64),
      rulesAgreedAt: null,
      createdAt: 1,
    });
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages: new InMemoryMessageStore(),
        auth,
        kek: new Uint8Array(16),
        publisher,
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(0);
  });

  it('republishes kind:0 when the database name changes', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const afterFirst = publisher.calls.filter((call) => call.event['kind'] === 0).length;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles.length).toBe(afterFirst + 1);
    expect(JSON.parse(String(profiles.at(-1)?.event['content'])).name).toBe('Anton');
  });

  it('caps kind:0 publishes at WORKER_BATCH per tick', async () => {
    const auth = new InMemoryAuthStore();
    const messages = new InMemoryMessageStore();
    for (let i = 0; i < 21; i += 1) {
      const id = `acc-${String(i).padStart(2, '0')}`;
      await auth.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: `User${i}`,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: `${i.toString(16).padStart(2, '0')}`.repeat(32),
        rulesAgreedAt: null,
        createdAt: i + 1,
      });
      await ensureAccountNostrKey(auth, id, KEK);
    }
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(20);
  });

  it('caps kind:0 attempts at WORKER_BATCH when space nacks', async () => {
    const auth = new InMemoryAuthStore();
    const messages = new InMemoryMessageStore();
    for (let i = 0; i < 21; i += 1) {
      const id = `acc-${String(i).padStart(2, '0')}`;
      await auth.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: `User${i}`,
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        viewKey: `${i.toString(16).padStart(2, '0')}`.repeat(32),
        rulesAgreedAt: null,
        createdAt: i + 1,
      });
      await ensureAccountNostrKey(auth, id, KEK);
    }
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(20);
  });

  it('publishes kind:0 only once when two ticks overlap', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      return urls.map((url) => ({ url, ok: true }));
    };
    await Promise.all([
      runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher,
          now: () => 1_700_000_000_000,
          env,
        }),
      ),
      runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher,
          now: () => 1_700_000_001_000,
          env,
        }),
      ),
    ]);
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(1);
  });

  it('bumps kind:0 created_at past an in-flight older profile in the same second', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    const t = 1_700_000_000_000;
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (
        event['kind'] === 0 &&
        publisher.calls.filter((call) => call.event['kind'] === 0).length === 1
      ) {
        enteredFirst();
        await firstHeld;
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => t,
        env,
      }),
    );
    await firstEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => t,
        env,
      }),
    );
    releaseFirst();
    await first;
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.event['created_at']).toBe(1_700_000_000);
    expect(profiles[1]?.event['created_at']).toBe(1_700_000_001);
    expect(JSON.parse(String(profiles[1]?.event['content'])).name).toBe('Anton');
  });

  it('keeps a newer kind:0 reservation when an in-flight nack lands', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    let releaseNack: () => void = () => {};
    const nackHeld = new Promise<void>((resolve) => {
      releaseNack = resolve;
    });
    let enteredFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (
        event['kind'] === 0 &&
        publisher.calls.filter((call) => call.event['kind'] === 0).length === 1
      ) {
        enteredFirst();
        await nackHeld;
        return urls.map((url) => ({ url, ok: false }));
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await firstEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    releaseNack();
    await first;
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(2);
    expect(JSON.parse(String(profiles.at(-1)?.event['content'])).name).toBe('Anton');
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(2);
  });

  it('does not drop a later Ada reservation when an earlier Ada nack lands', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    let releaseNack: () => void = () => {};
    const nackHeld = new Promise<void>((resolve) => {
      releaseNack = resolve;
    });
    let enteredFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (
        event['kind'] === 0 &&
        publisher.calls.filter((call) => call.event['kind'] === 0).length === 1
      ) {
        enteredFirst();
        await nackHeld;
        return urls.map((url) => ({ url, ok: false }));
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await firstEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const afterAnton = await auth.getAccount('acc');
    await auth.updateAccount({ ...afterAnton!, name: 'Ada' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    releaseNack();
    await first;
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(3);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_180_000,
        env,
      }),
    );
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(3);
    expect(JSON.parse(String(profiles.at(-1)?.event['content'])).name).toBe('Ada');
  });

  it('keeps a newer kind:0 reservation when an in-flight publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    let releaseThrow: () => void = () => {};
    const throwHeld = new Promise<void>((resolve) => {
      releaseThrow = resolve;
    });
    let enteredFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (
        event['kind'] === 0 &&
        publisher.calls.filter((call) => call.event['kind'] === 0).length === 1
      ) {
        enteredFirst();
        await throwHeld;
        throw new Error('ws down');
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await firstEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    releaseThrow();
    await first;
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(2);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(2);
  });

  it('skips publishing a stale kind:0 after a newer reservation', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    const originalGet = auth.getNostrSecret.bind(auth);
    let releaseSign: () => void = () => {};
    const signHeld = new Promise<void>((resolve) => {
      releaseSign = resolve;
    });
    let enteredSign: () => void = () => {};
    const signEntered = new Promise<void>((resolve) => {
      enteredSign = resolve;
    });
    auth.getNostrSecret = async (accountId: string) => {
      enteredSign();
      await signHeld;
      return originalGet(accountId);
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await signEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    auth.getNostrSecret = originalGet;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    releaseSign();
    await first;
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(1);
    expect(JSON.parse(String(profiles[0]?.event['content'])).name).toBe('Anton');
  });

  it('skips kind:0 when the reservation moves during key lookup', async () => {
    const { auth } = await seed();
    const messages = new InMemoryMessageStore();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    const originalPub = auth.getNostrPublicKey.bind(auth);
    let releaseLookup: () => void = () => {};
    const lookupHeld = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let enteredLookup: () => void = () => {};
    const lookupEntered = new Promise<void>((resolve) => {
      enteredLookup = resolve;
    });
    auth.getNostrPublicKey = async (accountId: string) => {
      enteredLookup();
      await lookupHeld;
      return originalPub(accountId);
    };
    const first = runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await lookupEntered;
    const acc = await auth.getAccount('acc');
    await auth.updateAccount({ ...acc!, name: 'Anton' });
    auth.getNostrPublicKey = originalPub;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    releaseLookup();
    await first;
    const profiles = publisher.calls.filter((call) => call.event['kind'] === 0);
    expect(profiles).toHaveLength(1);
    expect(JSON.parse(String(profiles[0]?.event['content'])).name).toBe('Anton');
  });

  it('retries kind:0 when space rejects', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    const afterTwo = publisher.calls.filter((call) => call.event['kind'] === 0).length;
    expect(afterTwo).toBe(2);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_120_000,
        env,
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0).length).toBe(3);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('retries kind:0 when publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      throw new Error('ws down');
    };
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect(publisher.calls.filter((call) => call.event['kind'] === 0)).toHaveLength(2);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('marks published when public ACK is present', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('parks when public relays are on but only space ACKs', async () => {
    const { auth, messages } = await seed();
    const space = 'wss://relay.nostr.space';
    const publisher: RecordingPublisher = new RecordingPublisher();
    publisher.publish = async (event, urls, _timeoutMs) => {
      publisher.calls.push({ event, urls });
      return Promise.resolve(urls.map((url) => ({ url, ok: url === space })));
    };
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('space');
  });

  it('bumps created_at when two notes collide on event id', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'm2',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    const first = await messages.getById('m1');
    const second = await messages.getById('m2');
    expect(first?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.eventId).not.toBe(first?.eventId);
  });

  it('stops signing after two event-id collisions', async () => {
    const { auth, messages } = await seed();
    messages.updateSignedEvent = async (): Promise<boolean> => false;
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toBeNull();
  });

  it('logs nack when space rejects', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('logs nack when publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async () => {
      throw new Error('ws down');
    };
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_060_000,
        env,
      }),
    );
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('backfills a missing key with a valid KEK', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc2',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await runNostrWorkerTick(
      deps({
        messages: new InMemoryMessageStore(),
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1,
        env: {},
      }),
    );
    expect(await auth.getNostrPublicKey('acc2')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs keygen backfill failure when the KEK is the wrong size', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await runNostrWorkerTick(
      deps({
        messages: new InMemoryMessageStore(),
        auth,
        kek: new Uint8Array(16),
        publisher: new RecordingPublisher(),
        now: () => 1,
        env: {},
      }),
    );
    expect(await auth.getNostrPublicKey('acc')).toBeUndefined();
  });

  it('indexes a valid kind:9735 onto sats when publish is off', async () => {
    const eventId = 'ab'.repeat(32);
    const providerPubkey = 'cd'.repeat(32);
    const receiptId = 'ef'.repeat(32);
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc-zap',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'worker-zap-ok@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'd'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'acc-zap', KEK);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: 'm-zap',
      accountId: 'acc-zap',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId,
      nostrEvent: {
        id: eventId,
        kind: 1,
        content: 'hello\n\n#bitcoin #21gifts',
        tags: [
          ['t', 'bitcoin'],
          ['t', '21gifts'],
          ['r', 'https://21.gifts'],
        ],
      },
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: receiptId,
        pubkey: providerPubkey,
        kind: 9735,
        tags: [
          ['e', eventId],
          ['bolt11', 'lnbc-test'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({
      paymentHash: '11'.repeat(32),
      amountMsat: 21_000,
    });
    const fetchImpl: FetchFn = async () =>
      new Response(
        JSON.stringify({
          callback: 'https://example.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000,
          allowsNostr: true,
          nostrPubkey: providerPubkey,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        fetchImpl,
        verifyReceipt: () => true,
        now: () => 1_700_000_000_000,
        env: {},
      }),
    );
    expect((await messages.getById('m-zap'))?.sats).toBe(21);
  });

  it('queries zap relays including public defaults when publish-public is off', async () => {
    const eventId = 'ab'.repeat(32);
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', eventId, {
      id: eventId,
      kind: 1,
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    const querier = new RecordingQuerier();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
    );
    expect(querier.calls[0]?.urls).toEqual(['wss://space', ...DEFAULT_RELAY_PUBLIC]);
  });
});

describe('startNostrWorker', () => {
  it('returns a stop handle', () => {
    const handle = startNostrWorker(
      deps({
        messages: new InMemoryMessageStore(),
        auth: new InMemoryAuthStore(),
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 0,
        env: {},
      }),
      60_000,
    );
    handle.stop();
  });
});
