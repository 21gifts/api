import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type NostrEvent,
} from 'nostr-tools/pure';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryBannerStore } from '@/lib/banner-store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { InMemoryFiatStore } from '@/lib/usd-fiat-store';
import { encryptKind4, unwrapNip17, wrapNip17 } from '@/lib/nostr/dm';
import { decodeBolt11 } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';
import {
  MESSAGE_INBOUND_REPLY_MAX_LENGTH,
  truncatePubkeyDisplay,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type MessageStore,
} from '@/lib/message-store';
import { buildNostrJson, listShopNip05Entries } from '@/lib/nip05';
import { KIND0_BANNER_URL, KIND0_PICTURE_URL } from '@/lib/nostr/event';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { decryptNostrSecret, ensureAccountNostrKey, zeroizeSecret } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { RecordingQuerier, type NostrEventFrame } from '@/lib/nostr/query';
import { resolveZapReadRelays, resolveZapRelays } from '@/lib/nostr/relays';
import { PostRateLimiter } from '@/lib/nostr/rate-limit';
import {
  HOT_ZAP_SINCE_SLACK_S,
  HOT_ZAP_WINDOW_MS,
  runNostrWorkerTick,
  startNostrWorker,
  WORKER_BATCH,
  type NostrWorkerDeps,
} from '@/lib/nostr/worker';
import { ExternalIngestLimiter } from '@/lib/nostr/external';
import { InMemoryPushStore } from '@/lib/push-store';
import {
  InMemoryShopIdentityStore,
  shopNpub,
  type ShopIdentityRow,
  type ShopIdentityStore,
} from '@/lib/shop-identity';
import { removeForumVideo } from '@/lib/video';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

// Pass-through spy: the shop kind 0 tests count and fail the NIP-05 allocation.
vi.mock('@/lib/nip05', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nip05')>();
  return { ...actual, listShopNip05Entries: vi.fn(actual.listShopNip05Entries) };
});

const mockedDecode = vi.mocked(decodeBolt11);

const KEK = parseNostrKek('cd'.repeat(32));

/** Dummy fetch that never resolves LNURL metadata. */
function dummyFetch(): FetchFn {
  return async () => new Response('{}', { status: 500 });
}

/** Drain queued promise callbacks without advancing fake time. */
async function drainMicrotasks(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
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
  const messages = new InMemoryMessageStore();
  const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await auth.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    profileMessageId: profileId,
  });
  await ensureAccountNostrKey(auth, 'acc', KEK);
  await messages.create({
    id: profileId,
    accountId: 'acc',
    name: 'Ada',
    text: 'Ada',
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    // Already published so worker ticks under test do not claim this note.
    // Distinct from inbound-test event ids (`aa`/`ab`/…).
    sats: 0,
    eventId: 'f1'.repeat(32),
    nostrPublishState: 'published',
    nostrEvent: { ...BITCOIN_KIND1, id: 'f1'.repeat(32) },
  });
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

/** Kind:1 fixture with t=bitcoin so resignLegacyKind1Tags leaves the signed row alone. */
const BITCOIN_KIND1 = {
  kind: 1,
  content: 'hello',
  tags: [
    ['t', 'bitcoin'],
    ['t', '21gifts'],
    ['r', 'https://21.gifts'],
  ],
};

/** One tick with conversations and inbound signature checks skipped. */
async function inboundTick(
  auth: InMemoryAuthStore,
  messages: InMemoryMessageStore,
  conversations: InMemoryConversationStore,
  querier: RecordingQuerier,
  notificationStore?: InMemoryNotificationStore,
  pushStore?: InMemoryPushStore,
): Promise<void> {
  await runNostrWorkerTick(
    deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      querier,
      now: () => 1_700_000_000_000,
      env: {},
      conversations,
      verifyKind1: () => true,
      fundingStore: new InMemoryFundingStore(),
      ...(notificationStore === undefined ? {} : { notificationStore }),
      ...(pushStore === undefined ? {} : { pushStore }),
    }),
  );
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
        pushStore: new InMemoryPushStore(),
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

  it('accepts spendPing and postLimiter when zap ingest has no receipts', async () => {
    const { auth, messages } = await seed();
    const spendPing = { ping: vi.fn(async () => undefined) };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
        spendPing,
        postLimiter: new PostRateLimiter(),
      }),
    );
    expect(spendPing.ping).not.toHaveBeenCalled();
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
      sats: 0,
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
    expect(String(m1?.nostrEvent?.['content'])).toBe('hello\n\n#bitcoin #21gifts');
  });

  it('appends a location hashtag when the account location is set', async () => {
    const { auth, messages } = await seed();
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    await auth.updateAccount({ ...account!, location: 'Berlin' });
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
      ['t', 'berlin'],
      ['r', 'https://21.gifts'],
    ]);
    expect(String(m1?.nostrEvent?.['content'])).toBe('hello\n\n#bitcoin #21gifts #Berlin');
  });

  it('re-signs published unpaid notes that lack the location hashtag', async () => {
    const { auth, messages } = await seed();
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    await auth.updateAccount({ ...account!, location: 'Berlin' });
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    await messages.create({
      id: 'm-loc',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:10:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m-loc', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags,
      created_at: 1,
    });
    await messages.updatePublishState('m-loc', 'published', 'space');
    await messages.create({
      id: 'm-loc-zapped',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:11:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m-loc-zapped', 'cd'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags,
      created_at: 1,
    });
    await messages.updatePublishState('m-loc-zapped', 'published', 'space');
    await messages.addSats('m-loc-zapped', 21, null);
    const tick = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1_700_000_000_000,
      env: {},
    });
    await runNostrWorkerTick(tick);
    expect((await messages.getById('m-loc'))?.eventId).toBeNull();
    expect((await messages.getById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))?.eventId).toBe(
      'f1'.repeat(32),
    );
    expect((await messages.getById('m-loc-zapped'))?.eventId).toBe('cd'.repeat(32));
    await runNostrWorkerTick(tick);
    const unpaid = await messages.getById('m-loc');
    expect(String(unpaid?.nostrEvent?.['content'])).toBe('hello\n\n#bitcoin #21gifts #Berlin');
    expect(unpaid?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['t', 'berlin'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('does not put a location hashtag on the profile note', async () => {
    const { auth, messages } = await seed();
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    await messages.create({
      id: 'profile-unsigned',
      accountId: 'acc',
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await auth.updateAccount({
      ...account!,
      location: 'Berlin',
      profileMessageId: 'profile-unsigned',
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
    const profile = await messages.getById('profile-unsigned');
    expect(String(profile?.nostrEvent?.['content'])).toBe('Ada\n\n#bitcoin #21gifts');
    expect(profile?.nostrEvent?.['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
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
    await messages.addSats('m-hashtag-zapped', 21, null);
    const tick = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1_700_000_000_000,
      env: {},
    });
    await runNostrWorkerTick(tick);
    expect((await messages.getById('m-hashtag'))?.eventId).toBeNull();
    await runNostrWorkerTick(tick);
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

  it('does not reset a published profile note that lacks Damus hashtags', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'acc-null-profile',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      profileMessageId: null,
    });
    await auth.createAccount({
      id: 'acc-empty-profile',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
      profileMessageId: '',
    });
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
    const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
    expect((await messages.getById(profileId))?.eventId).toBe('f1'.repeat(32));
    expect((await messages.getById('m-hashtag'))?.eventId).toBeNull();
  });

  it('signs a new post before resetting published notes that lack Damus hashtags', async () => {
    const { auth, messages } = await seed();
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    for (let i = 0; i < 20; i += 1) {
      const id = `old-${String(i).padStart(2, '0')}`;
      await messages.create({
        id,
        accountId: 'acc',
        name: 'Ada',
        text: `old ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      });
      await messages.updateSignedEvent(id, id.padEnd(64, 'a'), {
        kind: 1,
        content: `old ${i}`,
        tags,
        created_at: 1,
      });
      await messages.updatePublishState(id, 'published', 'space');
    }
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
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect((await messages.getById('old-00'))?.eventId).toBeNull();
  });

  it('EVENTs pending notes that lack Damus hashtags instead of resetting them', async () => {
    const { auth, messages } = await seed();
    const tags = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ];
    const eventId = 'ab'.repeat(32);
    await messages.updateSignedEvent('m1', eventId, {
      kind: 1,
      content: 'Das ist ein hashtag test v2',
      tags,
      created_at: 1,
    });
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
    expect((await messages.getById('m1'))?.eventId).toBe(eventId);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
    expect(publisher.calls.some((call) => call.event['kind'] === 1)).toBe(true);
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

  it('does not use the About me photo as the avatar or the banner', async () => {
    const { auth, messages } = await seed();
    const acc = await auth.getAccount('acc');
    expect(acc).toBeDefined();
    const profileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await messages.create(
      {
        id: profileId,
        accountId: 'acc',
        name: 'Ada',
        text: 'about Ada',
        createdAt: new Date('2026-08-27T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    await auth.updateAccount({ ...acc!, profileMessageId: profileId });
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://21.gifts',
    };
    const banners = new InMemoryBannerStore();
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_000_000, env, banners }),
    );
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_060_000, env, banners }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    const body = JSON.parse(String(profile?.event['content'])) as {
      picture: string;
      banner: string;
      about: string;
    };
    expect(body.picture).toBe('https://21.gifts/apple-touch-icon.png');
    expect(body.banner).toBe('https://21.gifts/og.png');
    expect(body.about).toBe('about Ada');
  });

  it('publishes a stored wide image as the banner and keeps the profile photo as the avatar', async () => {
    const { auth, messages } = await seed();
    const acc = await auth.getAccount('acc');
    expect(acc).toBeDefined();
    const profileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await messages.create(
      {
        id: profileId,
        accountId: 'acc',
        name: 'Ada',
        text: 'about Ada',
        createdAt: new Date('2026-08-27T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    await auth.updateAccount({ ...acc!, profileMessageId: profileId });
    const banners = new InMemoryBannerStore();
    await banners.set('acc', 'picture', {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([9, 9, 9]),
    });
    await banners.set('acc', 'banner', {
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://21.gifts',
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env,
        banners,
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    const body = JSON.parse(String(profile?.event['content'])) as {
      picture: string;
      banner: string;
    };
    expect(body.picture).toBe('https://api.21.gifts/pictures/acc.jpg');
    expect(body.banner).toBe('https://api.21.gifts/banners/acc.png');
    const plain = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: plain,
        now: () => 1_700_000_120_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
        banners,
      }),
    );
    const withoutOrigin = JSON.parse(
      String(plain.calls.find((call) => call.event['kind'] === 0)?.event['content']),
    ) as {
      picture: string;
      banner: string;
    };
    expect(withoutOrigin.picture).toBe('https://21.gifts/apple-touch-icon.png');
    expect(withoutOrigin.banner).toBe('https://21.gifts/og.png');
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
      banner: 'https://21.gifts/og.png',
      picture: 'https://21.gifts/apple-touch-icon.png',
      about: 'Ada',
    });
    expect(kinds).toContain(10002);
    expect(kinds).toContain(1);
  });

  it('backfills a profile note for named accounts missing one', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc2',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'acc2', KEK);
    const messages = new InMemoryMessageStore();
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
    const stored = await auth.getAccount('acc2');
    expect(typeof stored?.profileMessageId).toBe('string');
    expect((await messages.getById(stored!.profileMessageId!))?.text).toBe('Bob');
  });

  it('uses profile note text as kind:0 about', async () => {
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
    const kind0 = publisher.calls.find((call) => call.event['kind'] === 0);
    expect(JSON.parse(String(kind0?.event['content'])).about).toBe('Ada');
  });

  it('queries kind:9735 zap receipts before publish', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const querier = new RecordingQuerier();
    const querySpy = vi.spyOn(querier, 'query');
    const publishSpy = vi.spyOn(publisher, 'publish');
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        querier,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    expect(publishSpy.mock.calls.length).toBeGreaterThan(0);
    const zapQueryIndex = querySpy.mock.calls.findIndex((call) => {
      const filter = call[0] as { kinds?: number[] };
      return Array.isArray(filter.kinds) && filter.kinds.includes(9735);
    });
    expect(zapQueryIndex).toBeGreaterThanOrEqual(0);
    const zapOrder = querySpy.mock.invocationCallOrder[zapQueryIndex];
    const publishOrder = publishSpy.mock.invocationCallOrder[0];
    expect(zapOrder).toBeDefined();
    expect(publishOrder).toBeDefined();
    expect(zapOrder!).toBeLessThan(publishOrder!);
  });

  it('samples nowMs for sign after zap query returns', async () => {
    const { auth, messages } = await seed();
    const T0 = 1_700_000_000_000;
    const T1 = 1_700_000_030_000;
    let clock = T0;
    const querier = new RecordingQuerier();
    const innerQuery = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(9735)) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        clock = T1;
      }
      return innerQuery(filter, urls, timeoutMs);
    };
    const claimSpy = vi.spyOn(messages, 'claimUnsigned');
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => clock,
        env: {},
      }),
    );
    expect(claimSpy).toHaveBeenCalled();
    expect(claimSpy.mock.calls[0]?.[1]).toBe(T1);
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
    expect(lists).toHaveLength(3);
    expect(lists[0]?.event['tags']).toEqual([['r', 'wss://relay.nostr.space']]);
    expect(lists[1]?.event['tags']).toEqual([
      ['r', 'wss://relay.nostr.space'],
      ['r', 'wss://relay.damus.io'],
    ]);
    expect(Number(lists[1]?.event['created_at'])).toBeGreaterThan(
      Number(lists[0]?.event['created_at']),
    );
  });

  it('puts the public note link on a new kind:1 and a poster blurhash on video', async () => {
    const { encode: encodeJpeg } = await import('jpeg-js');
    const { auth, messages } = await seed();
    const poster = new Uint8Array(
      encodeJpeg({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 }, 50).data,
    );
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      accountId: 'acc',
      name: 'Ada',
      text: 'gift',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.create(
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip',
        createdAt: new Date('2026-08-28T00:01:30.000Z'),
        hasPhoto: true,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: poster },
      { contentType: 'video/mp4', bytes: mp4 },
    );
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://21.gifts',
    };
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_000_000, env }),
    );
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_060_000, env }),
    );
    const note = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).startsWith('gift'),
    );
    expect(String(note?.event['content'])).toBe(
      'gift\nhttps://21.gifts/l/bbbbbbbb\n\n#bitcoin #21gifts',
    );
    expect(note?.event['tags']).toContainEqual(['r', 'https://21.gifts/l/bbbbbbbb']);
    const video = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).includes('/video.mp4'),
    );
    const imeta = (video?.event['tags'] as string[][] | undefined)?.find(
      (tag) => tag[0] === 'imeta',
    );
    expect(imeta?.some((part) => part.startsWith('blurhash '))).toBe(true);
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
      [
        'imeta',
        'url https://dev-api.21.gifts/messages/m-pic/photo.jpg',
        'm image/jpeg',
        expect.stringMatching(/^x [0-9a-f]{64}$/),
      ],
    ]);
  });

  it('embeds extra still URLs and imeta on kind:1', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-pics',
        accountId: 'acc',
        name: 'Ada',
        text: 'pics',
        createdAt: new Date('2026-08-28T00:02:05.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      undefined,
      [{ contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) }],
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
    expect(notes.some((content) => content.includes('m-pics/photo.jpg'))).toBe(true);
    expect(notes.some((content) => content.includes('m-pics/photo/1.jpg'))).toBe(true);
    const note = publisher.calls.find(
      (call) =>
        call.event['kind'] === 1 && String(call.event['content']).includes('m-pics/photo/1.jpg'),
    );
    expect(note?.event['tags']).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
      [
        'imeta',
        'url https://dev-api.21.gifts/messages/m-pics/photo.jpg',
        'm image/jpeg',
        expect.stringMatching(/^x [0-9a-f]{64}$/),
      ],
      [
        'imeta',
        'url https://dev-api.21.gifts/messages/m-pics/photo/1.jpg',
        'm image/jpeg',
        expect.stringMatching(/^x [0-9a-f]{64}$/),
      ],
    ]);
  });

  it('embeds a public video URL and poster imeta on kind:1', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-vid',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip',
        createdAt: new Date('2026-08-28T00:02:30.000Z'),
        hasPhoto: true,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      { contentType: 'video/mp4', bytes: mp4 },
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
    const note = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).includes('m-vid/video'),
    );
    expect(String(note?.event['content'])).toContain(
      'https://dev-api.21.gifts/messages/m-vid/video.mp4',
    );
    expect(note?.event['tags']).toEqual(
      expect.arrayContaining([
        [
          'imeta',
          'url https://dev-api.21.gifts/messages/m-vid/video.mp4',
          'm video/mp4',
          `size ${mp4.byteLength}`,
          'image https://dev-api.21.gifts/messages/m-vid/photo.jpg',
          expect.stringMatching(/^x [0-9a-f]{64}$/),
        ],
      ]),
    );
  });

  it('does not embed extra still URLs on a video kind:1', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-vid-x',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip-x',
        createdAt: new Date('2026-08-28T00:02:32.000Z'),
        hasPhoto: true,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      { contentType: 'video/mp4', bytes: mp4 },
      [{ contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) }],
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
    const note = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).includes('m-vid-x/video'),
    );
    expect(String(note?.event['content'])).not.toContain('/photo/1.');
    expect(note?.event['tags']).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['imeta', expect.stringContaining('/photo/1.')]),
      ]),
    );
  });

  it('embeds a video URL without a poster when none is stored', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-vid2',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip2',
        createdAt: new Date('2026-08-28T00:02:31.000Z'),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://dev.21.gifts',
    };
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_000_000, env }),
    );
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_060_000, env }),
    );
    const note = publisher.calls.find(
      (call) => call.event['kind'] === 1 && String(call.event['content']).includes('m-vid2/video'),
    );
    expect(note?.event['tags']).toEqual(
      expect.arrayContaining([
        [
          'imeta',
          'url https://dev-api.21.gifts/messages/m-vid2/video.mp4',
          'm video/mp4',
          `size ${mp4.byteLength}`,
          expect.stringMatching(/^x [0-9a-f]{64}$/),
        ],
      ]),
    );
  });

  it('adds dim and size on video imeta when the file is parseable', async () => {
    const { auth, messages } = await seed();
    const box = (type: string, payload: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + payload.byteLength);
      const view = new DataView(out.buffer);
      view.setUint32(0, out.byteLength);
      out[4] = type.charCodeAt(0);
      out[5] = type.charCodeAt(1);
      out[6] = type.charCodeAt(2);
      out[7] = type.charCodeAt(3);
      out.set(payload, 8);
      return out;
    };
    const ftypPayload = new Uint8Array(16);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 0);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 8);
    const tkhdPayload = new Uint8Array(84);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdView.setUint32(76, 720 << 16);
    tkhdView.setUint32(80, 1280 << 16);
    const parseable = (() => {
      const ftyp = box('ftyp', ftypPayload);
      const moov = box('moov', box('trak', box('tkhd', tkhdPayload)));
      const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]));
      const out = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
      out.set(ftyp, 0);
      out.set(moov, ftyp.byteLength);
      out.set(mdat, ftyp.byteLength + moov.byteLength);
      return out;
    })();
    await messages.create(
      {
        id: 'm-vid-dim',
        accountId: 'acc',
        name: 'Ada',
        text: 'dims',
        createdAt: new Date('2026-08-28T00:02:32.000Z'),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: parseable },
    );
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://dev.21.gifts',
    };
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_000_000, env }),
    );
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_060_000, env }),
    );
    const note = publisher.calls.find(
      (call) =>
        call.event['kind'] === 1 && String(call.event['content']).includes('m-vid-dim/video'),
    );
    expect(note?.event['tags']).toEqual(
      expect.arrayContaining([
        [
          'imeta',
          'url https://dev-api.21.gifts/messages/m-vid-dim/video.mp4',
          'm video/mp4',
          'dim 720x1280',
          `size ${parseable.byteLength}`,
          expect.stringMatching(/^x [0-9a-f]{64}$/),
        ],
      ]),
    );
  });

  it('omits dim and size on video imeta when the file is missing', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-vid-missing',
        accountId: 'acc',
        name: 'Ada',
        text: 'gone',
        createdAt: new Date('2026-08-28T00:02:33.000Z'),
        hasPhoto: true,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      { contentType: 'video/mp4', bytes: mp4 },
    );
    await removeForumVideo('m-vid-missing', 'video/mp4');
    const publisher = new RecordingPublisher();
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
      PUBLIC_BASE_URL: 'https://dev.21.gifts',
    };
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_000_000, env }),
    );
    await runNostrWorkerTick(
      deps({ messages, auth, kek: KEK, publisher, now: () => 1_700_000_060_000, env }),
    );
    const note = publisher.calls.find(
      (call) =>
        call.event['kind'] === 1 && String(call.event['content']).includes('m-vid-missing/video'),
    );
    expect(note?.event['tags']).toEqual(
      expect.arrayContaining([
        [
          'imeta',
          'url https://dev-api.21.gifts/messages/m-vid-missing/video.mp4',
          'm video/mp4',
          'image https://dev-api.21.gifts/messages/m-vid-missing/photo.jpg',
        ],
      ]),
    );
    const imeta = (note?.event['tags'] as string[][] | undefined)?.find(
      (tag) => tag[0] === 'imeta' && tag.some((part) => part.includes('/video.mp4')),
    );
    expect(imeta?.some((part) => part.startsWith('dim '))).toBe(false);
    expect(imeta?.some((part) => part.startsWith('size '))).toBe(false);
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

  it('re-signs published video posts that lack the video URL', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-video',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:04:30.000Z'),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    await messages.updateSignedEvent('m-video', 'ab'.repeat(32), {
      kind: 1,
      content: '#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.updatePublishState('m-video', 'published', 'space');
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
    const row = await messages.getById('m-video');
    expect(row?.eventId).not.toBe('ab'.repeat(32));
    expect(String(row?.nostrEvent?.['content'])).toContain('/messages/m-video/video.mp4');
  });

  it('does not reset published video posts when PUBLIC_BASE_URL is unset', async () => {
    const { auth, messages } = await seed();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await messages.create(
      {
        id: 'm-novideo-url',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-28T00:04:45.000Z'),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    await messages.updateSignedEvent('m-novideo-url', 'ab'.repeat(32), {
      kind: 1,
      content: '#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
    });
    await messages.updatePublishState('m-novideo-url', 'published', 'space');
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
    const row = await messages.getById('m-novideo-url');
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
    await messages.addSats('m-zapped-photo', 21, null);
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
    messages.listSignedMissingVideo = async () => [];
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
    await messages.addSats('m-zap-pending', 7, null);
    messages.listSignedMissingPhoto = async () => [];
    messages.listSignedMissingVideo = async () => [];
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
        env: {
          NOSTR_PUBLISH: '1',
          NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
          PUBLIC_BASE_URL: 'https://dev.21.gifts',
        },
      }),
    );
    const profile = publisher.calls.find((call) => call.event['kind'] === 0);
    const content = JSON.parse(String(profile?.event['content'])) as {
      name: string;
      nip05: string;
    };
    expect(content.name).toBe('Anton');
    expect(content.nip05).toBe('anton@dev.21.gifts');
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
      location: null,
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
        location: null,
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
        location: null,
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

  it('skips unsigned forum rows with a null accountId and keeps signing others', async () => {
    const { auth, messages } = await seed();
    const inner = messages.claimUnsigned.bind(messages);
    messages.claimUnsigned = async (limit, nowMs, leaseMs) => [
      {
        id: 'damus-unsigned',
        accountId: null,
        name: 'aabbccdd…8899',
        text: 'from damus',
        createdAt: new Date('2026-08-28T00:00:00.000Z'),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      ...(await inner(limit, nowMs, leaseMs)),
    ];
    await expect(
      runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          now: () => 1_700_000_000_000,
          env: {},
        }),
      ),
    ).resolves.toBeUndefined();
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(await messages.getById('damus-unsigned')).toBeUndefined();
  });

  it('does not sign an unsigned reply whose parent has no eventId', async () => {
    const { auth, messages } = await seed();
    await messages.create({
      id: 'parent-unsigned',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: 'reply-wait',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: 'parent-unsigned',
    });
    const inner = messages.claimUnsigned.bind(messages);
    messages.claimUnsigned = async (limit, nowMs, leaseMs) => {
      const reply = await messages.getById('reply-wait');
      const claimed = await inner(limit, nowMs, leaseMs);
      return reply === undefined ? claimed : [reply, ...claimed];
    };
    const tickDeps = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      now: () => 1_700_000_000_000,
      env: {},
    });
    await runNostrWorkerTick(tickDeps);
    expect((await messages.getById('reply-wait'))?.eventId).toBeNull();
    expect((await messages.getById('parent-unsigned'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
    await runNostrWorkerTick(tickDeps);
    expect((await messages.getById('reply-wait'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs parent_pubkey when the parent has an eventId but no author pubkey', async () => {
    const { auth, messages } = await seed();
    const parent = {
      id: 'parent-damus',
      accountId: null as string | null,
      name: 'aabbccdd…8899',
      text: 'note',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      sats: 0,
      eventId: 'ee'.repeat(32),
      authorPubkey: null,
      nostrEvent: BITCOIN_KIND1,
    };
    const reply = {
      id: 'reply-nopk',
      accountId: 'acc' as string | null,
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:01:00.000Z'),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: 'parent-damus',
    };
    await messages.create(parent);
    await messages.create(reply);
    messages.claimUnsigned = async () =>
      [await messages.getById('reply-nopk')].filter(
        (row): row is NonNullable<typeof row> => row !== undefined,
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
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
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(
        events.some(
          (e) =>
            e['event'] === 'nostr.sign.failed' &&
            e['messageId'] === 'reply-nopk' &&
            e['reason'] === 'parent_pubkey',
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect((await messages.getById('reply-nopk'))?.eventId).toBeNull();
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
      location: null,
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
      location: null,
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
      location: null,
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
    const env = { NOSTR_RELAY_SPACE: 'wss://space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env,
      }),
    );
    expect(querier.calls[0]?.urls).toEqual(resolveZapReadRelays(env));
    expect(querier.calls[0]?.filter['kinds']).toContain(9735);
    const kind1Call = querier.calls.find((call) => {
      const kinds = call.filter['kinds'];
      return Array.isArray(kinds) && kinds.includes(1);
    });
    expect(kind1Call?.urls).toEqual(resolveZapRelays(env));
    expect(kind1Call?.urls).not.toContain('wss://nostr.wine');
    expect(kind1Call?.urls).not.toContain('wss://nostr.bitcoiner.social');
  });

  it('skips private-message ingest when no conversation store is injected', async () => {
    const { auth, messages } = await seed();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', 'aa'.repeat(32)]],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        verifyKind1: () => true,
      }),
    );
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.some((kind) => kind === 1059);
      }),
    ).toBe(false);
  });

  it('ingests an inbound NIP-17 wrap into a Damus thread', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = await auth.getNostrPublicKey('acc');
    expect(recipient).toBeDefined();
    const sender = generateSecretKey();
    const wrap = wrapNip17(sender, recipient as string, 'hello from damus');
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: wrap.tags as string[][],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => true,
      }),
    );
    const listed = await conversations.listVisible('acc', false, null, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe('member_damus');
    const rows = await conversations.listMessages(listed[0]!.id, 10);
    expect(rows[0]?.text).toBe('hello from damus');
    expect(rows[0]?.eventId).toBe(wrap.id);
  });

  it('ingests inbound kind:4 from a nameless 21gifts member', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const { decryptNostrSecret, zeroizeSecret } = await import('@/lib/nostr/keys');
    const senderSecret = await decryptNostrSecret(
      (await auth.getNostrSecret('bob')) as Uint8Array,
      KEK,
      'bob',
    );
    const cipher = encryptKind4(senderSecret, recipient, 'legacy hi');
    const signed = finalizeEvent(
      { kind: 4, created_at: 1_700_000_000, tags: [['p', recipient]], content: cipher },
      senderSecret,
    );
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags as string[][],
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    const listed = await conversations.listVisible('acc', false, null, 10);
    expect(listed[0]?.kind).toBe('member_member');
    const rows = await conversations.listMessages(listed[0]!.id, 10);
    expect(rows[0]?.text).toBe('legacy hi');
    expect(rows[0]?.senderAccountId).toBe('bob');
    expect(rows[0]?.name).toMatch(/…/);
  });

  it('ingests inbound kind:4 from a 21gifts member', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const senderCipher = (await auth.getNostrSecret('bob')) as Uint8Array;
    const { decryptNostrSecret, zeroizeSecret } = await import('@/lib/nostr/keys');
    const senderSecret = await decryptNostrSecret(senderCipher, KEK, 'bob');
    const cipher = encryptKind4(senderSecret, recipient, 'legacy hi');
    const signed = finalizeEvent(
      { kind: 4, created_at: 1_700_000_000, tags: [['p', recipient]], content: cipher },
      senderSecret,
    );
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags as string[][],
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => true,
      }),
    );
    const listed = await conversations.listVisible('acc', false, null, 10);
    expect(listed[0]?.kind).toBe('member_member');
    const rows = await conversations.listMessages(listed[0]!.id, 10);
    expect(rows[0]?.text).toBe('legacy hi');
    expect(rows[0]?.senderAccountId).toBe('bob');
  });

  it('enqueues a conversation push after inbound kind:4 persist', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(0),
    });
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const senderCipher = (await auth.getNostrSecret('bob')) as Uint8Array;
    const senderSecret = await decryptNostrSecret(senderCipher, KEK, 'bob');
    const cipher = encryptKind4(senderSecret, recipient, 'legacy hi');
    const signed = finalizeEvent(
      { kind: 4, created_at: 1_700_000_000, tags: [['p', recipient]], content: cipher },
      senderSecret,
    );
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags as string[][],
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        pushStore,
        verifyKind1: () => true,
      }),
    );
    const claimed = await pushStore.claimPending(10, 1_700_000_000_000, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('acc');
    expect(claimed[0]?.type).toBe('conversation');
  });

  it('does not re-ingest a conversation event id', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const sender = generateSecretKey();
    const wrap = wrapNip17(sender, recipient, 'once');
    const thread = await conversations.openMemberDamus('acc', getPublicKey(sender), new Date(0));
    await conversations.appendMessage({
      id: 'm-existing',
      conversationId: thread.id,
      text: 'once',
      createdAt: new Date(0),
      senderAccountId: null,
      senderPubkey: getPublicKey(sender),
      name: 'npub',
      sats: 0,
      eventId: wrap.id,
      nostrPublishState: 'published',
      nostrEvent: { id: wrap.id },
      claimedUntil: null,
    });
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: wrap.tags as string[][],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => true,
      }),
    );
    expect(await conversations.listMessages(thread.id, 10)).toHaveLength(1);
  });

  it('wraps and publishes an outbound conversation message', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-1',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
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
        conversations,
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
        conversations,
      }),
    );
    const row = await conversations.getMessageById('out-1');
    expect(row?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.nostrPublishState).toBe('published');
    expect(publisher.calls.some((call) => call.event['kind'] === 1059)).toBe(true);
  });

  it('wraps member_platform outbound to the current platform account', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-1',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
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
        conversations,
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
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.calls.some((call) => call.event['kind'] === 1059)).toBe(true);
  });

  it('falls back to stored accountB when the platform account has no nostr key', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-1',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
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
        conversations,
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
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.calls.some((call) => call.event['kind'] === 1059)).toBe(true);
  });

  it('leaves a conversation wrap unpublished when space nacks', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-nack',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
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
        conversations,
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
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-nack'))?.nostrPublishState).toBe('pending');
  });

  it('parks a conversation EVENT when public relays are on but only space ACKs', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-park',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const space = 'wss://relay.nostr.space';
    const publisher: RecordingPublisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      return Promise.resolve(urls.map((url) => ({ url, ok: url === space })));
    };
    const env = {
      NOSTR_PUBLISH: '1',
      NOSTR_PUBLISH_PUBLIC: '1',
      NOSTR_RELAY_SPACE: space,
      NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher,
          now: () => 1_700_000_000_000,
          env,
          conversations,
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
          conversations,
        }),
      );
      expect((await conversations.getMessageById('out-park'))?.nostrPublishState).toBe('pending');
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'nostr.dm.publish.ok' && e['parked'] === 1)).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('logs nack and does not throw when conversation publish throws', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-throw',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const publisher: RecordingPublisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (event['kind'] === 1059) {
        throw new Error('relay down');
      }
      return Promise.resolve(urls.map((url) => ({ url, ok: true })));
    };
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher,
          now: () => 1_700_000_000_000,
          env,
          conversations,
        }),
      );
      await expect(
        runNostrWorkerTick(
          deps({
            messages,
            auth,
            kek: KEK,
            publisher,
            now: () => 1_700_000_060_000,
            env,
            conversations,
          }),
        ),
      ).resolves.toBeUndefined();
      expect((await conversations.getMessageById('out-throw'))?.nostrPublishState).toBe('pending');
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'nostr.dm.publish.nack')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips unpublished conversation rows whose stored event is null', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-null-event',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: 'ab'.repeat(32),
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
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
        conversations,
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
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-null-event'))?.nostrPublishState).toBe(
      'pending',
    );
    expect(publisher.calls.every((call) => call.event['kind'] !== 1059)).toBe(true);
  });

  it('skips conversation publish when no conversation store is injected', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await expect(
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
    ).resolves.toBeUndefined();
  });

  it('skips unsigned conversation rows with a null sender account', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    conversations.claimUnsigned = async () => [
      {
        id: 'out-null-sender',
        conversationId: 'c-missing',
        text: 'ping',
        createdAt: new Date(0),
        senderAccountId: null,
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
      }),
    );
    expect(await conversations.getMessageById('out-null-sender')).toBeUndefined();
  });

  it('skips unsigned conversation rows when the thread is missing', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    await conversations.appendMessage({
      id: 'out-nothread',
      conversationId: 'c-missing',
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-nothread'))?.eventId).toBeNull();
  });

  it('skips conversation wrap when the sender secret is missing', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const innerSecret = auth.getNostrSecret.bind(auth);
    auth.getNostrSecret = async (accountId) => {
      if (accountId === 'acc') {
        return undefined;
      }
      return innerSecret(accountId);
    };
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-secret',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          now: () => 1_700_000_000_000,
          env: {},
          conversations,
        }),
      );
      expect((await conversations.getMessageById('out-secret'))?.eventId).toBeNull();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(
        events.some((e) => e['event'] === 'nostr.dm.sign.failed' && e['reason'] === 'secret'),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs sign.failed when the wrapped conversation event id collides', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-collide',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    conversations.updateSignedEvent = async () => false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          now: () => 1_700_000_000_000,
          env: {},
          conversations,
        }),
      );
      expect((await conversations.getMessageById('out-collide'))?.eventId).toBeNull();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(
        events.some((e) => e['event'] === 'nostr.dm.sign.failed' && e['reason'] === 'event_id'),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs sign.failed when wrapping a conversation message throws', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'bob', new Date(0));
    await conversations.appendMessage({
      id: 'out-sign-throw',
      conversationId: thread.id,
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    conversations.updateSignedEvent = async () => {
      throw new Error('store boom');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        runNostrWorkerTick(
          deps({
            messages,
            auth,
            kek: KEK,
            publisher: new RecordingPublisher(),
            now: () => 1_700_000_000_000,
            env: {},
            conversations,
          }),
        ),
      ).resolves.toBeUndefined();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(
        events.some(
          (e) => e['event'] === 'nostr.dm.sign.failed' && e['messageId'] === 'out-sign-throw',
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips unsigned conversation rows when the counterpart has no pubkey', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore([
      {
        id: 'c-nokey',
        kind: 'member_damus',
        accountA: 'acc',
        accountB: null,
        counterpartPubkey: null,
        createdAt: new Date(0),
        lastMessageAt: new Date(0),
        name: '',
        lastText: '',
        lastMessageId: null,
        lastSenderAccountId: null,
        lastActorAccountId: null,
        lastSats: 0,
      },
    ]);
    await conversations.appendMessage({
      id: 'out-nokey',
      conversationId: 'c-nokey',
      text: 'ping',
      createdAt: new Date(0),
      senderAccountId: 'acc',
      senderPubkey: (await auth.getNostrPublicKey('acc')) ?? null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
      }),
    );
    expect((await conversations.getMessageById('out-nokey'))?.eventId).toBeNull();
  });

  it('skips inbound DMs with an invalid signature', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', (await auth.getNostrPublicKey('acc')) as string]],
        content: 'nope',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => false,
      }),
    );
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('ingests a kind:4 from the platform account onto a member_platform thread', async () => {
    const { auth, messages } = await seed();
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
    await ensureAccountNostrKey(auth, 'plat', KEK);
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const { decryptNostrSecret, zeroizeSecret } = await import('@/lib/nostr/keys');
    const senderSecret = await decryptNostrSecret(
      (await auth.getNostrSecret('plat')) as Uint8Array,
      KEK,
      'plat',
    );
    const cipher = encryptKind4(senderSecret, recipient, 'official hello');
    const signed = finalizeEvent(
      { kind: 4, created_at: 1_700_000_000, tags: [['p', recipient]], content: cipher },
      senderSecret,
    );
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags as string[][],
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => true,
      }),
    );
    const listed = await conversations.listVisible('acc', false, 'plat', 10);
    expect(listed[0]?.kind).toBe('member_platform');
    expect((await conversations.listMessages(listed[0]!.id, 10))[0]?.text).toBe('official hello');
  });

  it('skips inbound DMs that lack created_at after verify', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', (await auth.getNostrPublicKey('acc')) as string]],
        content: 'cipher',
        sig: 'ef'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations,
        verifyKind1: () => true,
      }),
    );
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips inbound DM query when no account has a pubkey', async () => {
    const auth = new InMemoryAuthStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', 'aa'.repeat(32)]],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await inboundTick(auth, new InMemoryMessageStore(), new InMemoryConversationStore(), querier);
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.some((kind) => kind === 1059);
      }),
    ).toBe(false);
  });

  it('skips inbound DMs that are the wrong kind, lack an id, or tag someone else', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: '11'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 1,
        tags: [['p', recipient]],
        content: 'note',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
      {
        id: '',
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', recipient]],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
      {
        id: 1 as unknown as string,
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', recipient]],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
      {
        id: '22'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', 'ff'.repeat(32)]],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
      {
        id: '33'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p']],
        content: 'cipher',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips a kind:1059 wrap that cannot be unwrapped', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 1059,
        tags: [['p', (await auth.getNostrPublicKey('acc')) as string]],
        content: 'not-a-wrap',
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips a kind:4 whose NIP-04 decrypt returns null', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ab'.repeat(32),
        pubkey: 'cd'.repeat(32),
        kind: 4,
        tags: [['p', (await auth.getNostrPublicKey('acc')) as string]],
        created_at: 1,
        sig: 'ef'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips inbound DMs whose plaintext is rejected after normalisation', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const sender = generateSecretKey();
    const wrap = wrapNip17(sender, recipient, 'hello\u0001');
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: wrap.tags as string[][],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips inbound DMs whose plaintext is empty after normalisation', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const sender = generateSecretKey();
    const wrap = wrapNip17(sender, recipient, '   ');
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: wrap.tags as string[][],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips inbound DMs sent from an account to itself', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const { decryptNostrSecret, zeroizeSecret } = await import('@/lib/nostr/keys');
    const senderSecret = await decryptNostrSecret(
      (await auth.getNostrSecret('acc')) as Uint8Array,
      KEK,
      'acc',
    );
    const wrap = wrapNip17(senderSecret, recipient, 'hello self');
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: wrap.tags as string[][],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    expect(await conversations.listVisible('acc', false, null, 10)).toEqual([]);
  });

  it('skips an unknown p-tag then ingests the wrap for our pubkey', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('acc')) as string;
    const sender = generateSecretKey();
    const wrap = wrapNip17(sender, recipient, 'hello from damus');
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: wrap.id,
        pubkey: wrap.pubkey,
        kind: wrap.kind,
        tags: [['p', 'ff'.repeat(32)], ...(wrap.tags as string[][]), ['p', recipient]],
        content: wrap.content,
        created_at: wrap.created_at,
        sig: wrap.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    const listed = await conversations.listVisible('acc', false, null, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe('member_damus');
    const stored = (await conversations.listMessages(listed[0]!.id, 10))[0];
    expect(stored?.text).toBe('hello from damus');
    const ciphertext = await auth.getNostrSecret('acc');
    expect(ciphertext).toBeDefined();
    const secret = await decryptNostrSecret(ciphertext as Uint8Array, KEK, 'acc');
    const rumor = unwrapNip17(wrap, secret);
    expect(rumor).not.toBeNull();
    expect(stored?.createdAt.getTime()).toBe(rumor!.createdAt * 1000);
  });

  it('ingests a kind:4 from a member onto a member_platform thread', async () => {
    const { auth, messages } = await seed();
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
    await ensureAccountNostrKey(auth, 'plat', KEK);
    const conversations = new InMemoryConversationStore();
    const recipient = (await auth.getNostrPublicKey('plat')) as string;
    const { decryptNostrSecret, zeroizeSecret } = await import('@/lib/nostr/keys');
    const senderSecret = await decryptNostrSecret(
      (await auth.getNostrSecret('acc')) as Uint8Array,
      KEK,
      'acc',
    );
    const cipher = encryptKind4(senderSecret, recipient, 'member to platform');
    const signed = finalizeEvent(
      { kind: 4, created_at: 1_700_000_000, tags: [['p', recipient]], content: cipher },
      senderSecret,
    );
    zeroizeSecret(senderSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags as string[][],
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
    ];
    await inboundTick(auth, messages, conversations, querier);
    const listed = await conversations.listVisible('acc', false, 'plat', 10);
    expect(listed[0]?.kind).toBe('member_platform');
    expect((await conversations.listMessages(listed[0]!.id, 10))[0]?.text).toBe(
      'member to platform',
    );
  });

  it('logs inbound.failed when appending the conversation message throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { auth, messages } = await seed();
      const conversations = new InMemoryConversationStore();
      conversations.appendMessage = async () => {
        throw new Error('boom');
      };
      const recipient = (await auth.getNostrPublicKey('acc')) as string;
      const sender = generateSecretKey();
      const wrap = wrapNip17(sender, recipient, 'hello from damus');
      const querier = new RecordingQuerier();
      querier.events = [
        {
          id: wrap.id,
          pubkey: wrap.pubkey,
          kind: wrap.kind,
          tags: wrap.tags as string[][],
          content: wrap.content,
          created_at: wrap.created_at,
          sig: wrap.sig,
        },
      ];
      await inboundTick(auth, messages, conversations, querier);
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'nostr.dm.inbound.failed')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('persists inbound kind:1 replies from members only and skips unknown npubs', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'nameless',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 4,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'nameless', KEK);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const namelessPubkey = (await auth.getNostrPublicKey('nameless')) as string;
    const memberReplyId = 'bb'.repeat(32);
    const foreignParentId = '14'.repeat(32);
    const selfId = '13'.repeat(32);
    const origList = messages.listPublishedEventIds.bind(messages);
    messages.listPublishedEventIds = async (limit: number) => {
      const ids = await origList(limit);
      return [...ids, selfId];
    };
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: memberReplyId,
        pubkey: accPubkey.toUpperCase(),
        kind: 1,
        tags: [['e', noteEventId, '', 'reply']],
        content: 'member reply',
        created_at: 1_700_000_000,
        sig: 'cc'.repeat(32),
      },
      {
        id: 'dd'.repeat(32),
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'damus reply',
        sig: 'ff'.repeat(32),
      },
      {
        id: '77'.repeat(32),
        pubkey: '88'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId, '', 'root']],
        content: 'root reply',
        created_at: 1_700_000_001,
        sig: '99'.repeat(32),
      },
      {
        id: '66'.repeat(32),
        pubkey: namelessPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'nameless member',
        created_at: 1_700_000_002,
      },
      {
        id: '01'.repeat(32),
        pubkey: 'ee'.repeat(32),
        kind: 4,
        tags: [['e', noteEventId]],
        content: 'not kind 1',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '',
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'empty id',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '02'.repeat(32),
        pubkey: '',
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'empty pubkey',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '03'.repeat(32),
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', foreignParentId]],
        content: 'foreign parent',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: selfId,
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', selfId]],
        content: 'self parent',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: memberReplyId,
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId, '', 'reply']],
        content: 'member reply duplicate',
        created_at: 1_700_000_003,
        sig: 'cc'.repeat(32),
      },
      {
        id: 1,
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'non-string id',
        created_at: 1,
        sig: 'ff'.repeat(32),
      } as unknown as NostrEventFrame,
      {
        id: '05'.repeat(32),
        pubkey: 1,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'non-string pubkey',
        created_at: 1,
        sig: 'ff'.repeat(32),
      } as unknown as NostrEventFrame,
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    const replies = await messages.listReplies('m1');
    expect(replies.map((row) => row.text).sort()).toEqual(['member reply', 'nameless member']);
    expect(replies.find((row) => row.text === 'member reply')?.accountId).toBe('acc');
    expect(replies.find((row) => row.text === 'member reply')?.authorPubkey).toBe(
      accPubkey.toUpperCase(),
    );
    expect(replies.find((row) => row.text === 'nameless member')?.accountId).toBe('nameless');
    expect(replies.find((row) => row.text === 'nameless member')?.name).toBe(
      truncatePubkeyDisplay(namelessPubkey),
    );
    expect(replies.find((row) => row.text === 'member reply')?.name).toBe('Ada');
    const namelessEvent = replies.find((row) => row.text === 'nameless member')?.nostrEvent;
    expect(namelessEvent?.['sig']).toBe('');
    expect(namelessEvent?.['content']).toBe('nameless member');
    expect(await messages.getByEventId('dd'.repeat(32))).toBeUndefined();
    expect(await messages.getByEventId('77'.repeat(32))).toBeUndefined();
    expect(await messages.getByEventId(memberReplyId)).toBeDefined();
    expect(await messages.getByEventId('66'.repeat(32))).toBeDefined();
  });

  it('prefers the reply-marked parent past non-e tags and unknown e tags', async () => {
    const { auth, messages } = await seed();
    const rootEventId = 'a3'.repeat(32);
    const replyEventId = 'a4'.repeat(32);
    await messages.updateSignedEvent('m1', rootEventId, BITCOIN_KIND1);
    await messages.create({
      id: 'm2',
      accountId: 'acc',
      name: 'Ada',
      text: 'second note',
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m2', replyEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob-tags',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '7'.repeat(64),
      createdAt: 8,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob-tags', KEK);
    const bobPubkey = (await auth.getNostrPublicKey('bob-tags')) as string;
    const inboundReplyEventId = 'b3'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: inboundReplyEventId,
        pubkey: bobPubkey,
        kind: 1,
        tags: [
          ['p', 'd3'.repeat(32)],
          ['e'],
          ['e', 'c3'.repeat(32)],
          ['e', rootEventId, '', 'root'],
          ['e', replyEventId, '', 'reply'],
        ],
        content: 'tagged member reply',
        created_at: 1_700_000_000,
        sig: 'c3'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1: () => true,
      }),
    );

    expect(await messages.getByEventId(inboundReplyEventId)).toMatchObject({
      accountId: 'bob-tags',
      parentId: 'm2',
      text: 'tagged member reply',
    });
  });

  it('prefers the root-marked parent over the first plain e tag', async () => {
    const { auth, messages } = await seed();
    const rootEventId = 'a5'.repeat(32);
    const plainEventId = 'a6'.repeat(32);
    await messages.updateSignedEvent('m1', rootEventId, BITCOIN_KIND1);
    await messages.create({
      id: 'm2',
      accountId: 'acc',
      name: 'Ada',
      text: 'second note',
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.updateSignedEvent('m2', plainEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob-root-tags',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '6'.repeat(64),
      createdAt: 8,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob-root-tags', KEK);
    const bobPubkey = (await auth.getNostrPublicKey('bob-root-tags')) as string;
    const inboundReplyEventId = 'b4'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: inboundReplyEventId,
        pubkey: bobPubkey,
        kind: 1,
        tags: [
          ['e', plainEventId],
          ['e', rootEventId, '', 'root'],
        ],
        content: 'rooted member reply',
        created_at: 1_700_000_000,
        sig: 'c4'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1: () => true,
      }),
    );

    expect(await messages.getByEventId(inboundReplyEventId)).toMatchObject({
      accountId: 'bob-root-tags',
      parentId: 'm1',
      text: 'rooted member reply',
    });
  });

  it('keeps an account-owned zapper pubkey on the member inbound path', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a0'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob-zapper',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '8'.repeat(64),
      createdAt: 8,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob-zapper', KEK);
    const bobPubkey = (await auth.getNostrPublicKey('bob-zapper')) as string;
    await messages.recordZapper(bobPubkey, 'receipt-bob-zapper', new Date(1_699_999_000_000));
    expect(await messages.listZapperPubkeys()).toContain(bobPubkey);

    const replyEventId = 'b0'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: replyEventId,
        pubkey: bobPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'member zapper reply',
        created_at: 1_700_000_000,
        sig: 'c0'.repeat(32),
      },
    ];
    const limiter = new ExternalIngestLimiter();
    const tryAcquire = vi.spyOn(limiter, 'tryAcquire');
    const verifyKind1 = vi.fn(() => true);
    const notifications = new InMemoryNotificationStore();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        notificationStore: notifications,
        verifyKind1,
        externalLimiter: limiter,
      }),
    );

    expect(await messages.getByEventId(replyEventId)).toMatchObject({
      accountId: 'bob-zapper',
      authorPubkey: bobPubkey,
      name: 'Bob',
      text: 'member zapper reply',
    });
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.some((kind: unknown) => kind === 0);
      }),
    ).toBe(false);
    expect(tryAcquire).toHaveBeenCalledTimes(0);
    expect(verifyKind1).toHaveBeenCalledTimes(1);
    expect(verifyKind1).toHaveBeenCalledWith(expect.objectContaining({ id: replyEventId }));
    const forParent = await notifications.listByRecipient('acc', 10);
    expect(forParent).toHaveLength(1);
    expect(forParent[0]).toMatchObject({
      type: 'forum_reply',
      parentId: 'm1',
      text: 'member zapper reply',
      actorAccountId: 'bob-zapper',
    });
    expect(await notifications.listByRecipient('bob-zapper', 10)).toEqual([]);

    tryAcquire.mockRestore();
    for (let i = 0; i < 6; i += 1) {
      expect(limiter.tryAcquire(bobPubkey, 1_700_000_000_000)).toBe(true);
    }
    expect(limiter.tryAcquire(bobPubkey, 1_700_000_000_000)).toBe(false);
  });

  it('rejects a non-entitled reply before signature verification or event-id reads', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a6'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const eventId = 'c9'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: eventId,
        pubkey: 'b8'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'unknown reply',
        created_at: 1_700_000_000,
        sig: 'd9'.repeat(32),
      },
    ];
    const verifyKind1 = vi.fn(() => true);
    const getByEventId = vi.spyOn(messages, 'getByEventId');
    const create = vi.spyOn(messages, 'create');

    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1,
      }),
    );

    expect(verifyKind1).not.toHaveBeenCalled();
    expect(getByEventId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a blocked zapper reply before signature verification or event-id reads', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a7'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'b9'.repeat(32);
    await messages.recordZapper(pubkey, 'receipt-blocked-early', new Date(1_699_999_000_000));
    await messages.blockPubkeyAndHideRows(
      pubkey,
      new Date(1_699_999_500_000),
      'acc',
      'blocked-early-message',
    );
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'ca'.repeat(32),
        pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'blocked reply',
        created_at: 1_700_000_000,
        sig: 'da'.repeat(32),
      },
    ];
    const verifyKind1 = vi.fn(() => true);
    const getByEventId = vi.spyOn(messages, 'getByEventId');
    const create = vi.spyOn(messages, 'create');

    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1,
      }),
    );

    expect(verifyKind1).not.toHaveBeenCalled();
    expect(getByEventId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('persists entitled external replies, skips blocked and unknown pubkeys, and clamps future dates', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a1'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const externalPubkey = 'b1'.repeat(32);
    const blockedPubkey = 'b2'.repeat(32);
    const unknownPubkey = 'b3'.repeat(32);
    await messages.recordZapper(externalPubkey, 'receipt-external', new Date(1_699_999_000_000));
    await messages.recordZapper(blockedPubkey, 'receipt-blocked', new Date(1_699_999_000_000));
    await messages.blockPubkeyAndHideRows(
      blockedPubkey,
      new Date(1_699_999_500_000),
      'acc',
      'blocked-message',
    );
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'c1'.repeat(32),
        pubkey: externalPubkey.toUpperCase(),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'external reply',
        created_at: 1_700_000_100,
        sig: 'd1'.repeat(32),
      },
      {
        id: 'c2'.repeat(32),
        pubkey: blockedPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'blocked reply',
        created_at: 1_700_000_000,
        sig: 'd2'.repeat(32),
      },
      {
        id: 'c3'.repeat(32),
        pubkey: unknownPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'unknown reply',
        created_at: 1_700_000_000,
        sig: 'd3'.repeat(32),
      },
    ];
    const verifyKind1 = vi.fn(() => true);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1,
      }),
    );
    const replies = await messages.listReplies('m1');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      accountId: null,
      authorPubkey: externalPubkey,
      name: truncatePubkeyDisplay(externalPubkey),
      text: 'external reply',
      nostrPublishState: 'published',
      sats: 0,
    });
    expect(replies[0]?.createdAt.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(await messages.getByEventId('c2'.repeat(32))).toBeUndefined();
    expect(await messages.getByEventId('c3'.repeat(32))).toBeUndefined();
    expect(verifyKind1).toHaveBeenCalledTimes(1);
    expect(verifyKind1).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1'.repeat(32) }));
  });

  it('guards an external event across overlapping ticks before acquiring limiter budget', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a8'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'facefeed'.repeat(8);
    const eventId = 'cb'.repeat(32);
    await messages.recordZapper(pubkey, 'receipt-overlap', new Date(1_699_999_000_000));
    const frame: NostrEventFrame = {
      id: eventId,
      pubkey,
      kind: 1,
      tags: [['e', noteEventId]],
      content: 'one in flight',
      created_at: 1_700_000_000,
      sig: 'db'.repeat(32),
    };
    let resolveProfile: (events: NostrEventFrame[]) => void = () => {};
    const profileHeld = new Promise<NostrEventFrame[]>((resolve) => {
      resolveProfile = resolve;
    });
    let enteredProfile: () => void = () => {};
    const profileEntered = new Promise<void>((resolve) => {
      enteredProfile = resolve;
    });
    const query = vi.fn((filter: Record<string, unknown>) => {
      const kinds = filter['kinds'];
      const kind = Array.isArray(kinds) ? kinds[0] : undefined;
      if (kind === 1) {
        return Promise.resolve([frame]);
      }
      if (kind === 0) {
        enteredProfile();
        return profileHeld;
      }
      return Promise.resolve([]);
    });
    const limiter = new ExternalIngestLimiter();
    const tryAcquire = vi.spyOn(limiter, 'tryAcquire');
    const create = vi.spyOn(messages, 'create');
    const tickDeps = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      querier: { query },
      now: () => 1_700_000_000_000,
      env: {},
      conversations: new InMemoryConversationStore(),
      verifyKind1: () => true,
      externalLimiter: limiter,
    });

    const first = runNostrWorkerTick(tickDeps);
    await profileEntered;
    const second = runNostrWorkerTick(tickDeps);
    await second;
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    resolveProfile([]);
    await first;
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await messages.getByEventId(eventId)).toBeDefined();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryAcquire(pubkey, 1_700_000_000_000 + i)).toBe(true);
    }
    expect(limiter.tryAcquire(pubkey, 1_700_000_000_005)).toBe(false);
  });

  it('lets an in-flight block win without consuming budget and releases the event guard', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'ad'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'beadfeed'.repeat(8);
    const eventId = 'ce'.repeat(32);
    await messages.recordZapper(pubkey, 'receipt-block-race', new Date(1_699_999_000_000));
    const frame: NostrEventFrame = {
      id: eventId,
      pubkey,
      kind: 1,
      tags: [['e', noteEventId]],
      content: 'blocked while resolving profile',
      created_at: 1_700_000_000,
      sig: 'de'.repeat(32),
    };
    let resolveProfile: (events: NostrEventFrame[]) => void = () => {};
    const profileHeld = new Promise<NostrEventFrame[]>((resolve) => {
      resolveProfile = resolve;
    });
    let enteredProfile: () => void = () => {};
    const profileEntered = new Promise<void>((resolve) => {
      enteredProfile = resolve;
    });
    const query = vi.fn((filter: Record<string, unknown>) => {
      const kinds = filter['kinds'];
      const kind = Array.isArray(kinds) ? kinds[0] : undefined;
      if (kind === 1) {
        return Promise.resolve([frame]);
      }
      if (kind === 0) {
        enteredProfile();
        return profileHeld;
      }
      return Promise.resolve([]);
    });
    const limiter = new ExternalIngestLimiter();
    const tryAcquire = vi.spyOn(limiter, 'tryAcquire');
    const create = vi.spyOn(messages, 'create');
    const tickDeps = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      querier: { query },
      now: () => 1_700_000_000_000,
      env: {},
      conversations: new InMemoryConversationStore(),
      verifyKind1: () => true,
      externalLimiter: limiter,
    });

    const blockedTick = runNostrWorkerTick(tickDeps);
    await profileEntered;
    await messages.blockPubkeyAndHideRows(
      pubkey,
      new Date(1_700_000_000_000),
      'acc',
      'blocked-race',
    );
    resolveProfile([]);
    await blockedTick;

    expect(await messages.getByEventId(eventId)).toBeUndefined();
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    await messages.unblockPubkeyByMessage('blocked-race');
    await runNostrWorkerTick(tickDeps);
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await messages.getByEventId(eventId)).toBeDefined();
  });

  it('releases limiter budget and the in-flight guard when external persistence fails', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a9'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'badc0ffe'.repeat(8);
    const eventId = 'cc'.repeat(32);
    const nowMs = 1_700_000_000_000;
    await messages.recordZapper(pubkey, 'receipt-create-failure', new Date(1_699_999_000_000));
    const limiter = new ExternalIngestLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryAcquire(pubkey, nowMs)).toBe(true);
    }
    const release = vi.spyOn(limiter, 'release');
    const originalCreate = messages.create.bind(messages);
    let rejectReply = true;
    const createReply: typeof messages.create = async (row, photo, video, extraPhotos) => {
      if (row.eventId === eventId && rejectReply) {
        rejectReply = false;
        throw new Error('disk');
      }
      return originalCreate(row, photo, video, extraPhotos);
    };
    const create = vi.fn(createReply);
    messages.create = create;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: eventId,
        pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'retry after failure',
        created_at: 1_700_000_000,
        sig: 'dc'.repeat(32),
      },
    ];
    const tickDeps = deps({
      messages,
      auth,
      kek: KEK,
      publisher: new RecordingPublisher(),
      querier,
      now: () => nowMs,
      env: {},
      conversations: new InMemoryConversationStore(),
      verifyKind1: () => true,
      externalLimiter: limiter,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runNostrWorkerTick(tickDeps);
      expect(await messages.getByEventId(eventId)).toBeUndefined();
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(pubkey, nowMs);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('nostr.reply.inbound.failed')),
      ).toBe(true);

      await runNostrWorkerTick(tickDeps);
      expect(await messages.getByEventId(eventId)).toMatchObject({
        accountId: null,
        authorPubkey: pubkey,
        text: 'retry after failure',
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(limiter.tryAcquire(pubkey, nowMs)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('clamps a future-dated member reply to worker time', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a2'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const memberPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'c4'.repeat(32),
        pubkey: memberPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'future member reply',
        created_at: 1_700_000_100,
        sig: 'd4'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect((await messages.getByEventId('c4'.repeat(32)))?.createdAt.toISOString()).toBe(
      '2023-11-14T22:13:20.000Z',
    );
  });

  it('notifies only the parent author for a recent external reply and suppresses old reply notifications', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'bystander',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '9'.repeat(64),
      createdAt: 9,
      rulesAgreedAt: null,
    });
    const noteEventId = 'a3'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const recentPubkey = 'b4'.repeat(32);
    const oldPubkey = 'b5'.repeat(32);
    await messages.recordZapper(recentPubkey, 'receipt-recent', new Date(1_699_999_000_000));
    await messages.recordZapper(oldPubkey, 'receipt-old', new Date(1_699_999_000_000));
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'c5'.repeat(32),
        pubkey: recentPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'recent external',
        created_at: 1_699_999_999,
        sig: 'd5'.repeat(32),
      },
      {
        id: 'c6'.repeat(32),
        pubkey: oldPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'old external',
        created_at: 1_699_996_399,
        sig: 'd6'.repeat(32),
      },
    ];
    const notifications = new InMemoryNotificationStore();
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier, notifications);
    const forParent = await notifications.listByRecipient('acc', 10);
    expect(forParent).toHaveLength(1);
    expect(forParent[0]).toMatchObject({
      parentId: 'm1',
      name: 'Someone',
      text: 'recent external',
    });
    expect(await notifications.listByRecipient('bystander', 10)).toEqual([]);
    expect(await messages.getByEventId('c5'.repeat(32))).toBeDefined();
    expect(await messages.getByEventId('c6'.repeat(32))).toBeDefined();
  });

  it('notifies within future skew but stores beyond-skew and unknown-age external replies silently', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'ae'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const withinPubkey = 'ba'.repeat(32);
    const beyondPubkey = 'bb'.repeat(32);
    const unknownAgePubkey = 'bc'.repeat(32);
    await messages.recordZapper(withinPubkey, 'receipt-within-skew', new Date(1_699_999_000_000));
    await messages.recordZapper(beyondPubkey, 'receipt-beyond-skew', new Date(1_699_999_000_000));
    await messages.recordZapper(
      unknownAgePubkey,
      'receipt-unknown-age',
      new Date(1_699_999_000_000),
    );
    const withinEventId = 'cf'.repeat(32);
    const beyondEventId = 'd0'.repeat(32);
    const unknownAgeEventId = 'd1'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: withinEventId,
        pubkey: withinPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'within future skew',
        created_at: 1_700_000_600,
        sig: 'df'.repeat(32),
      },
      {
        id: beyondEventId,
        pubkey: beyondPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'beyond future skew',
        created_at: 1_700_000_601,
        sig: 'e0'.repeat(32),
      },
      {
        id: unknownAgeEventId,
        pubkey: unknownAgePubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'unknown age',
        sig: 'e1'.repeat(32),
      },
    ];
    const notifications = new InMemoryNotificationStore();

    await inboundTick(auth, messages, new InMemoryConversationStore(), querier, notifications);

    expect(await messages.getByEventId(withinEventId)).toBeDefined();
    expect(await messages.getByEventId(beyondEventId)).toBeDefined();
    expect(await messages.getByEventId(unknownAgeEventId)).toBeDefined();
    expect((await messages.getByEventId(beyondEventId))?.createdAt.toISOString()).toBe(
      '2023-11-14T22:13:20.000Z',
    );
    expect((await messages.getByEventId(unknownAgeEventId))?.createdAt.toISOString()).toBe(
      '2023-11-14T22:13:20.000Z',
    );
    const forParent = await notifications.listByRecipient('acc', 10);
    expect(forParent).toHaveLength(1);
    expect(forParent[0]).toMatchObject({ text: 'within future skew' });
  });

  it('keeps an external reply and logs when its targeted notification fails', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a5'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'b7'.repeat(32);
    const eventId = 'c8'.repeat(32);
    await messages.recordZapper(pubkey, 'receipt-notify-failure', new Date(1_699_999_000_000));
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: eventId,
        pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'persist despite notify failure',
        created_at: 1_699_999_999,
        sig: 'd8'.repeat(32),
      },
    ];
    const notifications = new InMemoryNotificationStore();
    notifications.create = async () => {
      throw new Error('boom');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inboundTick(auth, messages, new InMemoryConversationStore(), querier, notifications);
      expect(await messages.getByEventId(eventId)).toBeDefined();
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('nostr.reply.notify.failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a rate-limited external event unstored and retries it after the hourly window', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'a4'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const pubkey = 'b6'.repeat(32);
    await messages.recordZapper(pubkey, 'receipt-limited', new Date(1_699_999_000_000));
    const limiter = new ExternalIngestLimiter();
    let nowMs = 1_700_000_000_000;
    for (let i = 0; i < 6; i += 1) {
      expect(limiter.tryAcquire(pubkey, nowMs)).toBe(true);
    }
    const eventId = 'c7'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: eventId,
        pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'retry me',
        created_at: 1_700_000_000,
        sig: 'd7'.repeat(32),
      },
    ];
    const run = async (): Promise<void> =>
      runNostrWorkerTick(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          querier,
          now: () => nowMs,
          env: {},
          conversations: new InMemoryConversationStore(),
          verifyKind1: () => true,
          externalLimiter: limiter,
        }),
      );
    await run();
    expect(await messages.getByEventId(eventId)).toBeUndefined();
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds[0] === 0;
      }),
    ).toBe(true);
    nowMs += 60 * 60 * 1000 + 1;
    await run();
    expect(await messages.getByEventId(eventId)).toMatchObject({
      accountId: null,
      authorPubkey: pubkey,
      text: 'retry me',
    });
  });

  it('notifies the parent author when another member replies inbound', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const bobPubkey = (await auth.getNostrPublicKey('bob')) as string;
    const replyEventId = 'b0'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: replyEventId,
        pubkey: bobPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'bob reply',
        created_at: 1_700_000_000,
        sig: 'cc'.repeat(32),
      },
    ];
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1_700_000_000_000),
    });
    await inboundTick(
      auth,
      messages,
      new InMemoryConversationStore(),
      querier,
      notificationStore,
      pushStore,
    );
    const forAcc = await notificationStore.listByRecipient('acc', 10);
    expect(forAcc).toHaveLength(1);
    expect(forAcc[0]?.type).toBe('forum_reply');
    expect(forAcc[0]?.parentId).toBe('m1');
    expect(forAcc[0]?.text).toBe('bob reply');
    expect(forAcc[0]?.name).toBe('Bob');
    expect(await notificationStore.listByRecipient('bob', 10)).toHaveLength(0);
  });

  it('skips the self-replier on inbound kind:1 and still notifies another subscriber', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const replyEventId = 'b1'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: replyEventId,
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'self',
        created_at: 1_700_000_000,
        sig: 'cc'.repeat(32),
      },
    ];
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1_700_000_000_000),
    });
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/bob',
      accountId: 'bob',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1_700_000_000_000),
    });
    await inboundTick(
      auth,
      messages,
      new InMemoryConversationStore(),
      querier,
      notificationStore,
      pushStore,
    );
    expect(await notificationStore.listByRecipient('acc', 10)).toHaveLength(0);
    const forBob = await notificationStore.listByRecipient('bob', 10);
    expect(forBob).toHaveLength(1);
    expect(forBob[0]?.type).toBe('forum_reply');
    expect(await messages.getByEventId(replyEventId)).toBeDefined();
  });

  it('persists inbound kind:1 when notificationStore.create throws', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    await auth.createAccount({
      id: 'bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 5,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'bob', KEK);
    const bobPubkey = (await auth.getNostrPublicKey('bob')) as string;
    const replyEventId = 'b2'.repeat(32);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: replyEventId,
        pubkey: bobPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'bob reply',
        created_at: 1_700_000_000,
        sig: 'cc'.repeat(32),
      },
    ];
    const notificationStore = new InMemoryNotificationStore();
    notificationStore.create = async () => {
      throw new Error('boom');
    };
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1_700_000_000_000),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inboundTick(
        auth,
        messages,
        new InMemoryConversationStore(),
        querier,
        notificationStore,
        pushStore,
      );
      expect(await messages.getByEventId(replyEventId)).toBeDefined();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'nostr.reply.notify.failed')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips inbound kind:1 when verifyKind1 returns false', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'bb'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'bad sig',
        created_at: 1_700_000_000,
        sig: 'ff'.repeat(32),
      },
    ];
    const verifyKind1 = vi.fn(() => false);
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1,
      }),
    );
    expect(await messages.listReplies('m1')).toHaveLength(0);
    expect(verifyKind1).toHaveBeenCalledTimes(1);
  });

  it('logs inbound.failed when persisting a kind:1 reply throws', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const origCreate = messages.create.bind(messages);
    messages.create = async (row, photo, video) => {
      if (row.parentId === 'm1') {
        throw new Error('disk');
      }
      return origCreate(row, photo, video);
    };
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'bb'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'x',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('nostr.reply.inbound.failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips duplicate inbound kind:1 event ids', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'dd'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'member reply',
        sig: 'ff'.repeat(32),
      },
    ];
    const eventId = 'dd'.repeat(32);
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    const first = (await messages.listReplies('m1')).filter((row) => row.eventId === eventId);
    expect(first).toHaveLength(1);
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    const second = (await messages.listReplies('m1')).filter((row) => row.eventId === eventId);
    expect(second).toHaveLength(1);
  });

  it('skips a duplicate kind:1 event id in the same query batch', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    const eventId = 'dd'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const frame = {
      id: eventId,
      pubkey: accPubkey,
      kind: 1,
      tags: [['e', noteEventId]],
      content: 'member reply',
      created_at: 1_700_000_000,
      sig: 'ff'.repeat(32),
    };
    const querier = new RecordingQuerier();
    querier.events = [frame, { ...frame, tags: [['e', noteEventId]] }];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect(
      (await messages.listReplies('m1')).filter((row) => row.eventId === eventId),
    ).toHaveLength(1);
  });

  it('skips inbound kind:1 with empty content', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'cc'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: '   ',
        created_at: 1_700_000_000,
        sig: 'ff'.repeat(32),
      },
      {
        id: '11'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        created_at: 1_700_000_000,
        sig: '33'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect(await messages.listReplies('m1')).toHaveLength(0);
  });

  it('skips inbound kind:1 when normalised content is null', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'cc'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'A'.repeat(MESSAGE_INBOUND_REPLY_MAX_LENGTH + 1),
        created_at: 1_700_000_000,
        sig: 'ff'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect(await messages.listReplies('m1')).toHaveLength(0);
  });

  it('persists a schnorr-signed inbound kind:1 with the default verifier', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const secret = await decryptNostrSecret(
      (await auth.getNostrSecret('acc')) as Uint8Array,
      KEK,
      'acc',
    );
    const signed = finalizeEvent(
      {
        kind: 1,
        content: 'signed reply',
        created_at: 1_700_000_000,
        tags: [['e', noteEventId, '', 'reply']],
      },
      secret,
    );
    zeroizeSecret(secret);
    const foreignSecret = generateSecretKey();
    const foreignSigned = finalizeEvent(
      {
        kind: 1,
        content: 'foreign reply',
        created_at: 1_700_000_000,
        tags: [['e', noteEventId, '', 'reply']],
      },
      foreignSecret,
    );
    zeroizeSecret(foreignSecret);
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: signed.id,
        pubkey: signed.pubkey,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        created_at: signed.created_at,
        sig: signed.sig,
      },
      {
        id: foreignSigned.id,
        pubkey: foreignSigned.pubkey,
        kind: foreignSigned.kind,
        tags: foreignSigned.tags,
        content: foreignSigned.content,
        created_at: foreignSigned.created_at,
        sig: foreignSigned.sig,
      },
      {
        id: 'cc'.repeat(32),
        pubkey: signed.pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'no sig',
        created_at: 1_700_000_000,
      },
      {
        id: 'dd'.repeat(32),
        pubkey: signed.pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'empty sig',
        created_at: 1_700_000_000,
        sig: '',
      },
      {
        id: '11'.repeat(32),
        pubkey: signed.pubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        created_at: 1_700_000_000,
        sig: 'ff'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
      }),
    );
    expect((await messages.listReplies('m1')).map((row) => row.text)).toEqual(['signed reply']);
    expect((await messages.listReplies('m1')).some((row) => row.text === 'foreign reply')).toBe(
      false,
    );
    expect(await messages.getByEventId(foreignSigned.id)).toBeUndefined();
  });

  it('skips inbound frames that are not a signed kind:1 note', async () => {
    const { auth, messages } = await seed();
    await auth.createAccount({
      id: 'nokey',
      linkingKey: null,
      role: 'basis',
      name: 'NoKey',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await auth.createAccount({
      id: 'emptykey',
      linkingKey: null,
      role: 'basis',
      name: 'EmptyKey',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    const origPubkey = auth.getNostrPublicKey.bind(auth);
    auth.getNostrPublicKey = async (id: string): Promise<string | undefined> =>
      id === 'emptykey' ? '' : origPubkey(id);
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: '11'.repeat(32),
        pubkey: 'ee'.repeat(32),
        kind: 4,
        tags: [['e', noteEventId]],
        content: 'dm',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '',
        pubkey: 'ee'.repeat(32),
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'no id',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '22'.repeat(32),
        pubkey: '',
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'no pubkey',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
      {
        id: '33'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'bad sig',
        created_at: 1,
        sig: 'ff'.repeat(32),
      },
    ];
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
        conversations: new InMemoryConversationStore(),
        verifyKind1: (event) => event.id !== '33'.repeat(32),
      }),
    );
    expect(await messages.listReplies('m1')).toHaveLength(0);
  });

  it('skips inbound kind:1 when e-tag is not our note or equals event id', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const foreignId = '11'.repeat(32);
    const selfId = '22'.repeat(32);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const origList = messages.listPublishedEventIds.bind(messages);
    messages.listPublishedEventIds = async (limit: number) => {
      const ids = await origList(limit);
      return [...ids, selfId];
    };
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: 'bb'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', foreignId]],
        content: 'foreign parent',
        sig: 'ff'.repeat(32),
      },
      {
        id: selfId,
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', selfId]],
        content: 'self parent',
        sig: 'ff'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect(await messages.listReplies('m1')).toHaveLength(0);
  });

  it('skips inbound kind:1 when parent is itself a reply', async () => {
    const { auth, messages } = await seed();
    const noteEventId = 'aa'.repeat(32);
    const replyEventId = 'dd'.repeat(32);
    await messages.updateSignedEvent('m1', noteEventId, BITCOIN_KIND1);
    const accPubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: replyEventId,
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', noteEventId]],
        content: 'member reply',
        sig: 'ff'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    const replies = await messages.listReplies('m1');
    expect(replies).toHaveLength(1);
    const replyRow = replies[0]!;
    expect(replyRow.eventId).toBe(replyEventId);
    expect(replyRow.parentId).toBe('m1');

    const origList = messages.listPublishedEventIds.bind(messages);
    messages.listPublishedEventIds = async (limit: number) => {
      const ids = await origList(limit);
      return [...ids, replyEventId];
    };
    querier.events = [
      {
        id: '11'.repeat(32),
        pubkey: accPubkey,
        kind: 1,
        tags: [['e', replyEventId]],
        content: 'nested',
        sig: '33'.repeat(32),
      },
    ];
    await inboundTick(auth, messages, new InMemoryConversationStore(), querier);
    expect(await messages.listReplies(replyRow.id)).toHaveLength(0);
    expect(await messages.listReplies('m1')).toHaveLength(1);
  });
});

/** Forum invoice attempt fixture for hot-lane zap tests. */
function hotInvoice(overrides: Partial<MessageInvoiceAttempt> = {}): MessageInvoiceAttempt {
  return {
    id: 'inv-hot',
    createdAt: new Date(1_700_000_000_000),
    messageId: 'm1',
    payerAccountId: 'acc',
    authorAccountId: 'acc',
    amountSats: 21,
    lightningAddress: 'ada@example.com',
    zapRequest: { tags: [['e', 'ab'.repeat(32)]] },
    result: 'ok',
    httpStatus: 200,
    pr: 'lnbc-hot',
    paymentHash: '11'.repeat(32),
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    ...overrides,
  };
}

describe('runNostrWorkerTick modes', () => {
  it('fast mode skips receipt query when no ok hot invoices and still signs', async () => {
    const { auth, messages } = await seed();
    const querier = new RecordingQuerier();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: {},
      }),
      'fast',
    );
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.includes(9735);
      }),
    ).toBe(false);
    expect((await messages.getById('m1'))?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fast mode queries hot receipt filters with deduped e-tags and since', async () => {
    const { auth, messages } = await seed();
    const noteA = 'a1'.repeat(32);
    const noteB = 'b2'.repeat(32);
    const nowMs = 1_700_000_000_000;
    const older = new Date(nowMs - 30 * 60_000);
    const newer = new Date(nowMs - 5 * 60_000);
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-skip-result',
        result: 'noZap',
        zapRequest: { tags: [['e', noteA]] },
        createdAt: newer,
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-old',
        createdAt: new Date(nowMs - HOT_ZAP_WINDOW_MS - 1_000),
        zapRequest: { tags: [['e', noteA]] },
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-null-zr',
        zapRequest: null,
        createdAt: newer,
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-tags-not-array',
        zapRequest: { tags: 'nope' },
        createdAt: newer,
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-no-e',
        zapRequest: { tags: [['p', 'aa'.repeat(32)]] },
        createdAt: newer,
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-empty-e',
        zapRequest: { tags: [['e', '']] },
        createdAt: newer,
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-older-ok',
        createdAt: older,
        zapRequest: { tags: [['e', noteA]] },
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-dup',
        createdAt: newer,
        zapRequest: {
          tags: [
            ['e', noteA],
            ['e', noteB],
          ],
        },
      }),
    );
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-b',
        createdAt: newer,
        zapRequest: { tags: [['e', noteB]] },
      }),
    );
    const querier = new RecordingQuerier();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => nowMs,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
      'fast',
    );
    const zapCalls = querier.calls.filter((call) => {
      const kinds = call.filter['kinds'];
      return Array.isArray(kinds) && kinds.includes(9735);
    });
    expect(zapCalls).toHaveLength(1);
    expect(zapCalls[0]?.filter).toEqual({
      kinds: [9735],
      '#e': [noteA, noteB],
      limit: 200,
      since: Math.floor(older.getTime() / 1000) - HOT_ZAP_SINCE_SLACK_S,
    });
    expect(zapCalls[0]?.urls).toEqual(resolveZapReadRelays({ NOSTR_RELAY_SPACE: 'wss://space' }));
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.includes(1);
      }),
    ).toBe(false);
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.includes(4);
      }),
    ).toBe(false);
  });

  it('fast mode still finds an ok invoice when many newer non-ok attempts exist', async () => {
    const { auth, messages } = await seed();
    const noteA = 'c3'.repeat(32);
    const nowMs = 1_700_000_000_000;
    const okAt = new Date(nowMs - 30 * 60_000);
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-ok-buried',
        createdAt: okAt,
        zapRequest: { tags: [['e', noteA]] },
      }),
    );
    for (let i = 0; i < 60; i += 1) {
      await messages.recordInvoiceAttempt(
        hotInvoice({
          id: `inv-bad-${i}`,
          result: 'bad_body',
          createdAt: new Date(nowMs - 5 * 60_000 + i),
          zapRequest: { tags: [['e', 'dd'.repeat(32)]] },
          httpStatus: 400,
          pr: null,
          isNip57Invoice: false,
        }),
      );
    }
    const querier = new RecordingQuerier();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => nowMs,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
      'fast',
    );
    const zapCalls = querier.calls.filter((call) => {
      const kinds = call.filter['kinds'];
      return Array.isArray(kinds) && kinds.includes(9735);
    });
    expect(zapCalls).toHaveLength(1);
    const eTags = zapCalls[0]?.filter['#e'];
    expect(Array.isArray(eTags) && eTags.includes(noteA)).toBe(true);
  });

  it('fast mode indexes a matching hot receipt onto sats', async () => {
    const eventId = 'ab'.repeat(32);
    const providerPubkey = 'cd'.repeat(32);
    const receiptId = 'ef'.repeat(32);
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc-hot',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'hot-zap@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(auth, 'acc-hot', KEK);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: 'm-hot',
      accountId: 'acc-hot',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId,
      nostrEvent: { ...BITCOIN_KIND1, id: eventId },
    });
    const nowMs = 1_700_000_000_000;
    await messages.recordInvoiceAttempt(
      hotInvoice({
        id: 'inv-hot-ok',
        messageId: 'm-hot',
        payerAccountId: 'acc-hot',
        authorAccountId: 'acc-hot',
        lightningAddress: 'hot-zap@example.com',
        createdAt: new Date(nowMs - 60_000),
        zapRequest: { tags: [['e', eventId]] },
      }),
    );
    const querier = new RecordingQuerier();
    querier.events = [
      {
        id: receiptId,
        pubkey: providerPubkey,
        kind: 9735,
        tags: [
          ['e', eventId],
          ['bolt11', 'lnbc-hot'],
        ],
      },
    ];
    mockedDecode.mockReturnValue({ paymentHash: '22'.repeat(32), amountMsat: 21_000 });
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
        now: () => nowMs,
        env: {},
      }),
      'fast',
    );
    expect((await messages.getById('m-hot'))?.sats).toBe(21);
  });

  it('fast mode publishes only when NOSTR_PUBLISH=1', async () => {
    const { auth, messages } = await seed();
    const publisherOff = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: publisherOff,
        now: () => 1_700_000_000_000,
        env: {},
      }),
      'fast',
    );
    expect(publisherOff.calls).toHaveLength(0);

    const { auth: authOn, messages: messagesOn } = await seed();
    const publisherOn = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages: messagesOn,
        auth: authOn,
        kek: KEK,
        publisher: publisherOn,
        now: () => 1_700_000_000_000,
        env: { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      }),
      'fast',
    );
    expect(publisherOn.calls.length).toBeGreaterThan(0);
  });

  it('ingest mode runs full receipt, reply, and DM queries without signing', async () => {
    const { auth, messages } = await seed();
    const conversations = new InMemoryConversationStore();
    const querier = new RecordingQuerier();
    const publisher = new RecordingPublisher();
    const env = { NOSTR_RELAY_SPACE: 'wss://space' };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        querier,
        now: () => 1_700_000_000_000,
        env,
        conversations,
        verifyKind1: () => true,
      }),
      'ingest',
    );
    const zapFilter = querier.calls.find((call) => {
      const kinds = call.filter['kinds'];
      return Array.isArray(kinds) && kinds.includes(9735);
    })?.filter;
    expect(zapFilter).toEqual({
      kinds: [9735],
      '#e': expect.any(Array),
      limit: 200,
    });
    expect('since' in (zapFilter ?? {})).toBe(false);
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && kinds.includes(1);
      }),
    ).toBe(true);
    expect(
      querier.calls.some((call) => {
        const kinds = call.filter['kinds'];
        return Array.isArray(kinds) && (kinds.includes(4) || kinds.includes(1059));
      }),
    ).toBe(true);
    const zapReadUrls = resolveZapReadRelays(env);
    const replyUrls = resolveZapRelays(env);
    for (const call of querier.calls) {
      const kinds = call.filter['kinds'];
      if (!Array.isArray(kinds)) {
        continue;
      }
      if (kinds.includes(9735)) {
        expect(call.urls).toEqual(zapReadUrls);
      }
      if (kinds.includes(1) || kinds.includes(4) || kinds.includes(1059)) {
        expect(call.urls).toEqual(replyUrls);
        expect(call.urls).not.toContain('wss://nostr.wine');
        expect(call.urls).not.toContain('wss://nostr.bitcoiner.social');
      }
    }
    expect((await messages.getById('m1'))?.eventId).toBeNull();
    expect(publisher.calls).toHaveLength(0);
  });
});

describe('startNostrWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('forwards a fiat rate book into zap ingest', async () => {
    const { auth, messages } = await seed();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: {},
        fiatRates: new InMemoryFiatStore(),
      }),
    );
  });

  it('starts ingest immediately and waits for settle before the next pass', async () => {
    vi.useFakeTimers();
    const { auth, messages } = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    let zapQueries = 0;
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(9735)) {
        zapQueries += 1;
        if (holding) {
          await hold;
        }
      }
      return inner(filter, urls, timeoutMs);
    };
    const handle = startNostrWorker(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
      60_000,
      5_000,
    );
    await drainMicrotasks();
    expect(zapQueries).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000 * 3);
    expect(zapQueries).toBe(1);
    holding = false;
    release!();
    await drainMicrotasks();
    expect(zapQueries).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await drainMicrotasks();
    expect(zapQueries).toBe(2);
    handle.stop();
  });

  it('logs nostr.worker.ingest.failed and still reschedules', async () => {
    vi.useFakeTimers();
    const { auth, messages } = await seed();
    const querier = new RecordingQuerier();
    let calls = 0;
    querier.query = async () => {
      calls += 1;
      throw new Error('ingest boom');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const handle = startNostrWorker(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          querier,
          now: () => 1_700_000_000_000,
          env: { NOSTR_RELAY_SPACE: 'wss://space' },
        }),
        60_000,
        1_000,
      );
      await drainMicrotasks();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((row) => row['event'] === 'nostr.worker.ingest.failed')).toBe(true);
      const afterFirst = calls;
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks();
      expect(calls).toBeGreaterThan(afterFirst);
      handle.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it('fires overlapping fast ticks and logs nostr.worker.tick.failed', async () => {
    vi.useFakeTimers();
    const { auth, messages } = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fastStarts = 0;
    const originalClaim = messages.claimUnsigned.bind(messages);
    messages.claimUnsigned = async (limit, nowMs, leaseMs) => {
      fastStarts += 1;
      if (fastStarts === 1) {
        await hold;
      }
      return originalClaim(limit, nowMs, leaseMs);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const handle = startNostrWorker(
        deps({
          messages,
          auth,
          kek: KEK,
          publisher: new RecordingPublisher(),
          now: () => 1_700_000_000_000,
          env: {},
        }),
        100,
        60_000,
      );
      await drainMicrotasks();
      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();
      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();
      expect(fastStarts).toBeGreaterThanOrEqual(2);
      release!();
      await drainMicrotasks();

      messages.claimUnsigned = async () => {
        throw new Error('fast boom');
      };
      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((row) => row['event'] === 'nostr.worker.tick.failed')).toBe(true);
      handle.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it('stop prevents a further ingest pass after an in-flight pass settles', async () => {
    vi.useFakeTimers();
    const { auth, messages } = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    let zapQueries = 0;
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(9735)) {
        zapQueries += 1;
        if (holding) {
          await hold;
        }
      }
      return inner(filter, urls, timeoutMs);
    };
    const handle = startNostrWorker(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        querier,
        now: () => 1_700_000_000_000,
        env: { NOSTR_RELAY_SPACE: 'wss://space' },
      }),
      60_000,
      1_000,
    );
    await drainMicrotasks();
    expect(zapQueries).toBe(1);
    handle.stop();
    holding = false;
    release!();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await drainMicrotasks();
    expect(zapQueries).toBe(1);
  });

  const publicEnv = {
    NOSTR_PUBLISH: '1',
    NOSTR_PUBLISH_PUBLIC: '1',
    NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
    NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
  };

  function loggedEvents(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
  }

  async function tickTwice(
    messages: InMemoryMessageStore,
    auth: InMemoryAuthStore,
    publisher: RecordingPublisher,
    env: Record<string, string>,
    querier?: RecordingQuerier,
  ): Promise<void> {
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        ...(querier === undefined ? {} : { querier }),
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
        ...(querier === undefined ? {} : { querier }),
        now: () => 1_700_000_060_000,
        env,
      }),
    );
  }

  it('publishes a public kind:1 again to the search relay and still marks it published', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    await tickTwice(messages, auth, publisher, publicEnv);
    const notes = publisher.calls.filter((call) => call.event['kind'] === 1);
    expect(notes.some((call) => call.urls.includes('wss://relay.nostr.band'))).toBe(true);
    const primary = notes.find((call) => call.urls.includes('wss://relay.nostr.space'));
    expect(primary?.urls).not.toContain('wss://relay.nostr.band');
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
    expect((await messages.getById('m1'))?.nostrPublishEpoch).toBe('public');
  });

  it('does not copy a kind:1 to the search relay when space nacks', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.ok = false;
    await tickTwice(messages, auth, publisher, publicEnv);
    expect(publisher.calls.some((call) => call.urls.includes('wss://relay.nostr.band'))).toBe(
      false,
    );
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('pending');
  });

  it('publishes a reply to the parent read relay and the search relay', async () => {
    const { auth, messages } = await seed();
    const parentId = 'ab'.repeat(32);
    await messages.updateSignedEvent('m1', parentId, {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await messages.updatePublishState('m1', 'published', 'public');
    await messages.create({
      id: 'm-reply',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:05:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm1',
    });
    const pubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      await inner(filter, urls, timeoutMs);
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(10002)) {
        return [
          {
            id: 'c1'.repeat(32),
            pubkey,
            kind: 10002,
            created_at: 10,
            tags: [['r', 'wss://inbox.example', 'read']],
          },
        ];
      }
      return [];
    };
    const publisher = new RecordingPublisher();
    await tickTwice(messages, auth, publisher, publicEnv, querier);
    const reply = await messages.getById('m-reply');
    expect(reply?.nostrPublishState).toBe('published');
    expect(reply?.nostrEvent?.['tags']).toEqual(
      expect.arrayContaining([
        ['e', parentId, 'wss://relay.damus.io', 'root'],
        ['e', parentId, 'wss://relay.damus.io', 'reply'],
      ]),
    );
    const reach = publisher.calls.find(
      (call) => call.event['kind'] === 1 && call.urls.includes('wss://relay.nostr.band'),
    );
    expect(reach?.urls).toEqual(['wss://relay.nostr.band', 'wss://inbox.example']);
  });

  it('still publishes the reply to the search relay when the inbox query throws', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await messages.updatePublishState('m1', 'published', 'public');
    await messages.create({
      id: 'm-reply',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:05:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm1',
    });
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(10002)) {
        throw new Error('inbox down');
      }
      return inner(filter, urls, timeoutMs);
    };
    const publisher = new RecordingPublisher();
    await tickTwice(messages, auth, publisher, publicEnv, querier);
    expect((await messages.getById('m-reply'))?.nostrPublishState).toBe('published');
    const reach = publisher.calls.find((call) => call.urls.includes('wss://relay.nostr.band'));
    expect(reach?.urls).toEqual(['wss://relay.nostr.band']);
  });

  it('copies a successful profile and relay list to the indexer', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        now: () => 1_700_000_000_000,
        env: publicEnv,
      }),
    );
    expect(
      publisher.calls.some(
        (call) =>
          call.event['kind'] === 0 &&
          call.urls.length === 1 &&
          call.urls[0] === 'wss://purplepag.es',
      ),
    ).toBe(true);
    expect(
      publisher.calls.some(
        (call) =>
          call.event['kind'] === 10002 &&
          call.urls.length === 1 &&
          call.urls[0] === 'wss://purplepag.es',
      ),
    ).toBe(true);
    const listed = publisher.calls.find((call) => call.event['kind'] === 10002);
    expect(listed?.event['tags']).toEqual([
      ['r', 'wss://relay.nostr.space'],
      ['r', 'wss://relay.damus.io'],
    ]);
  });

  it('keeps profile and relay-list success when the indexer nacks', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (urls.length === 1 && urls[0] === 'wss://purplepag.es') {
        if (event['kind'] === 0) {
          return [];
        }
        return [{ url: 'wss://purplepag.es', ok: false }];
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.profile.ok')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.profile.indexer_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.relays.ok')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.relays.indexer_nack')).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const primary = (kind: number) =>
      publisher.calls.filter(
        (call) => call.event['kind'] === kind && call.urls.includes('wss://relay.nostr.space'),
      );
    expect(primary(0)).toHaveLength(1);
    expect(primary(10002)).toHaveLength(1);
  });

  it('logs an indexer nack when the indexer publish throws and keeps the reservation', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (urls.length === 1 && urls[0] === 'wss://purplepag.es') {
        throw new Error('indexer down');
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.profile.indexer_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.relays.indexer_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.profile.ok')).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(
      publisher.calls.filter(
        (call) => call.event['kind'] === 0 && call.urls.includes('wss://relay.nostr.space'),
      ),
    ).toHaveLength(1);
  });

  it('logs a search nack when the search ack is missing and still publishes the note', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (urls.includes('wss://relay.nostr.band')) {
        return [];
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.publish.search_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.publish.inbox_nack')).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('logs a search nack when the reach publish throws', async () => {
    const { auth, messages } = await seed();
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (urls.includes('wss://relay.nostr.band')) {
        throw new Error('search down');
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.publish.search_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.publish.inbox_nack')).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('logs an inbox nack without undoing publish when a read relay nacks', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await messages.updatePublishState('m1', 'published', 'public');
    await messages.create({
      id: 'm-reply',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:05:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm1',
    });
    const pubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      await inner(filter, urls, timeoutMs);
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(10002)) {
        return [
          {
            id: 'c2'.repeat(32),
            pubkey,
            kind: 10002,
            created_at: 1,
            tags: [['r', 'wss://inbox.example']],
          },
        ];
      }
      return [];
    };
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      return urls.map((url) => ({ url, ok: url !== 'wss://inbox.example' }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv, querier);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.publish.inbox_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.publish.search_nack')).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect((await messages.getById('m-reply'))?.nostrPublishState).toBe('published');
  });

  it('logs search and inbox nacks when reach publish throws after inbox relays are known', async () => {
    const { auth, messages } = await seed();
    await messages.updateSignedEvent('m1', 'ab'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
        ['r', 'https://21.gifts'],
      ],
      created_at: 1,
    });
    await messages.updatePublishState('m1', 'published', 'public');
    await messages.create({
      id: 'm-reply',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T00:05:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'm1',
    });
    const pubkey = (await auth.getNostrPublicKey('acc')) as string;
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      await inner(filter, urls, timeoutMs);
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(10002)) {
        return [
          {
            id: 'c3'.repeat(32),
            pubkey,
            kind: 10002,
            tags: [['r', 'wss://inbox.example', 'read']],
          },
        ];
      }
      return [];
    };
    const publisher = new RecordingPublisher();
    publisher.publish = async (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      if (urls.includes('wss://relay.nostr.band')) {
        throw new Error('reach down');
      }
      return urls.map((url) => ({ url, ok: true }));
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await tickTwice(messages, auth, publisher, publicEnv, querier);
      const events = loggedEvents(warn);
      expect(events.some((event) => event['event'] === 'nostr.publish.search_nack')).toBe(true);
      expect(events.some((event) => event['event'] === 'nostr.publish.inbox_nack')).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect((await messages.getById('m-reply'))?.nostrPublishState).toBe('published');
  });

  it('caps inbox relays and keeps the newest kind:10002 per pubkey', async () => {
    const { auth, messages } = await seed();
    const pk = (n: number): string => `${'ab'.repeat(31)}${n.toString(16).padStart(2, '0')}`;
    const tags: unknown[] = [
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
      'nope',
      ['p', 1],
      ['p', 'ab'],
      ['p', 'AB'.repeat(32)],
      ['p', pk(1)],
      ['p', pk(1)],
      ['p', pk(8)],
      ['p', pk(2)],
      ['p', pk(3)],
      ['p', pk(4)],
      ['p', pk(5)],
      ['p', pk(6)],
      ['p', pk(7)],
      ['p', pk(9)],
    ];
    await messages.updateSignedEvent('m1', 'cd'.repeat(32), {
      kind: 1,
      content: 'hello\n\n#bitcoin #21gifts',
      tags: tags as string[][],
      created_at: 1,
    });
    const relay = (name: string): string[] => ['r', `wss://${name}.example`];
    const four = (prefix: string): string[][] =>
      [1, 2, 3, 4].map((n) => ['r', `wss://${prefix}-${n}.example`]);
    const frames: NostrEventFrame[] = [
      {
        id: '11'.repeat(32),
        pubkey: pk(1),
        kind: 10002,
        created_at: 1,
        tags: [relay('old')],
      },
      {
        id: '12'.repeat(32),
        pubkey: pk(1),
        kind: 10002,
        created_at: 5,
        tags: [relay('new')],
      },
      {
        id: '13'.repeat(32),
        pubkey: pk(1),
        kind: 10002,
        created_at: 3,
        tags: [relay('stale')],
      },
      {
        id: '21'.repeat(32),
        pubkey: pk(2),
        kind: 10002,
        tags: [relay('missing-at')],
      },
      {
        id: '22'.repeat(32),
        pubkey: pk(2),
        kind: 10002,
        created_at: 2,
        tags: [relay('later')],
      },
      {
        id: '23'.repeat(32),
        pubkey: pk(2).toUpperCase(),
        kind: 10002,
        created_at: 9,
        tags: [relay('upper')],
      },
      {
        id: '31'.repeat(32),
        pubkey: pk(3),
        kind: 10002,
        created_at: 0,
        tags: undefined as unknown as string[][],
      },
      {
        id: '32'.repeat(32),
        pubkey: pk(3),
        kind: 10002,
        created_at: 4,
        tags: [relay('keep')],
      },
      {
        id: '33'.repeat(32),
        pubkey: pk(3),
        kind: 10002,
        tags: [relay('lose')],
      },
      {
        id: '41'.repeat(32),
        pubkey: pk(4),
        kind: 10002,
        created_at: 1,
        tags: [
          ['r', 'wss://relay.nostr.space'],
          ['r', 'wss://relay.damus.io'],
          ['r', 'wss://relay.nostr.band'],
          relay('new'),
          relay('inbox-a'),
        ],
      },
      { id: '51'.repeat(32), pubkey: pk(5), kind: 10002, created_at: 1, tags: four('e5') },
      { id: '61'.repeat(32), pubkey: pk(6), kind: 10002, created_at: 1, tags: four('e6') },
      { id: '71'.repeat(32), pubkey: pk(7), kind: 10002, created_at: 1, tags: four('e7') },
      {
        id: '81'.repeat(32),
        pubkey: pk(15),
        kind: 10002,
        created_at: 50,
        tags: [relay('stranger')],
      },
      {
        id: '91'.repeat(32),
        pubkey: pk(1),
        kind: 1,
        created_at: 99,
        tags: [relay('not-a-list')],
      },
      {
        id: 'a1'.repeat(32),
        pubkey: 4 as unknown as string,
        kind: 10002,
        tags: [relay('bad-pubkey')],
      },
    ];
    const querier = new RecordingQuerier();
    const inner = querier.query.bind(querier);
    querier.query = async (filter, urls, timeoutMs) => {
      await inner(filter, urls, timeoutMs);
      const kinds = (filter as { kinds?: number[] }).kinds;
      if (Array.isArray(kinds) && kinds.includes(10002)) {
        return frames;
      }
      return [];
    };
    const publisher = new RecordingPublisher();
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher,
        querier,
        now: () => 1_700_000_000_000,
        env: publicEnv,
      }),
    );
    const inboxQuery = querier.calls.find((call) => {
      const kinds = (call.filter as { kinds?: number[] }).kinds;
      return Array.isArray(kinds) && kinds.includes(10002);
    });
    expect(inboxQuery?.timeoutMs).toBe(5000);
    expect(inboxQuery?.urls).toEqual([
      'wss://relay.nostr.space',
      'wss://relay.damus.io',
      'wss://purplepag.es',
    ]);
    expect((inboxQuery?.filter as { authors?: string[] }).authors).toEqual([
      pk(1),
      pk(8),
      pk(2),
      pk(3),
      pk(4),
      pk(5),
      pk(6),
      pk(7),
    ]);
    const reach = publisher.calls.find((call) => call.urls.includes('wss://relay.nostr.band'));
    expect(reach?.urls).toEqual([
      'wss://relay.nostr.band',
      'wss://new.example',
      'wss://upper.example',
      'wss://keep.example',
      'wss://inbox-a.example',
      ...[1, 2, 3, 4].map((n) => `wss://e5-${n}.example`),
      ...[1, 2, 3, 4].map((n) => `wss://e6-${n}.example`),
      ...[1, 2, 3, 4].map((n) => `wss://e7-${n}.example`),
    ]);
    expect((await messages.getById('m1'))?.nostrPublishState).toBe('published');
  });

  it('omits imeta x when photo bytes are empty', async () => {
    const { auth, messages } = await seed();
    await messages.create(
      {
        id: 'm-empty',
        accountId: 'acc',
        name: 'Ada',
        text: 'empty',
        createdAt: new Date('2026-08-28T00:06:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    );
    const photos = messages.getPhoto.bind(messages);
    messages.getPhoto = async (id) => {
      if (id === 'm-empty') {
        return { contentType: 'image/jpeg', bytes: new Uint8Array() };
      }
      return photos(id);
    };
    const extras = messages.listExtraPhotos.bind(messages);
    messages.listExtraPhotos = async (id) => {
      if (id === 'm-empty') {
        return [{ contentType: 'image/jpeg', bytes: new Uint8Array() }];
      }
      return extras(id);
    };
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: { PUBLIC_BASE_URL: 'https://dev.21.gifts' },
      }),
    );
    const tags = (await messages.getById('m-empty'))?.nostrEvent?.['tags'] as string[][];
    const imeta = tags.filter((tag) => tag[0] === 'imeta');
    expect(imeta).toHaveLength(2);
    expect(imeta.some((tag) => tag.some((part) => part.startsWith('x ')))).toBe(false);
  });

  it('adds duration and size on video imeta when mvhd is present', async () => {
    const { auth, messages } = await seed();
    const box = (type: string, payload: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + payload.byteLength);
      const view = new DataView(out.buffer);
      view.setUint32(0, out.byteLength);
      out[4] = type.charCodeAt(0);
      out[5] = type.charCodeAt(1);
      out[6] = type.charCodeAt(2);
      out[7] = type.charCodeAt(3);
      out.set(payload, 8);
      return out;
    };
    const ftypPayload = new Uint8Array(16);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 0);
    const mvhd = new Uint8Array(20);
    const mvhdView = new DataView(mvhd.buffer);
    mvhdView.setUint32(12, 1000);
    mvhdView.setUint32(16, 2500);
    const ftyp = box('ftyp', ftypPayload);
    const moov = box('moov', box('mvhd', mvhd));
    const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]));
    const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
    bytes.set(ftyp, 0);
    bytes.set(moov, ftyp.byteLength);
    bytes.set(mdat, ftyp.byteLength + moov.byteLength);
    await messages.create(
      {
        id: 'm-dur',
        accountId: 'acc',
        name: 'Ada',
        text: 'dur',
        createdAt: new Date('2026-08-28T00:07:00.000Z'),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes },
    );
    await runNostrWorkerTick(
      deps({
        messages,
        auth,
        kek: KEK,
        publisher: new RecordingPublisher(),
        now: () => 1_700_000_000_000,
        env: { PUBLIC_BASE_URL: 'https://dev.21.gifts' },
      }),
    );
    const tags = (await messages.getById('m-dur'))?.nostrEvent?.['tags'] as string[][];
    const imeta = tags.find((tag) => tag[0] === 'imeta');
    expect(imeta).toContain('duration 3');
    expect(imeta?.some((part) => part.startsWith('size '))).toBe(true);
    expect(imeta?.some((part) => /^x [0-9a-f]{64}$/.test(part))).toBe(true);
    expect(imeta?.some((part) => part.startsWith('dim '))).toBe(false);
  });
});

describe('shop identities (S1 keys, S2 profiles)', () => {
  const TILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';
  const ENV = {
    NOSTR_PUBLISH: '1',
    NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
    PUBLIC_BASE_URL: 'https://21.gifts',
  };
  const PUBLIC_ENV = {
    ...ENV,
    NOSTR_PUBLISH_PUBLIC: '1',
    NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
  };

  function uuid(n: number): string {
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }

  function shopNote(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
    return {
      id,
      accountId: 'author',
      name: 'Ada',
      text: TEXT,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      place: {
        lat: 47.3,
        lng: 8.5,
        label: 'Coffee Lab',
        address: {
          street: 'Main Street',
          houseNumber: '1',
          postalCode: '8001',
          city: 'Zürich',
          country: 'CH',
        },
      },
      shopAccount: { id: TILL, username: 'coffee', name: 'Coffee' },
      ...overrides,
    };
  }

  function account(overrides: Partial<Account> = {}): Account {
    return {
      id: TILL,
      linkingKey: null,
      role: 'basis',
      name: 'Coffee',
      username: 'coffee',
      lightningAddress: 'coffee@example.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: '11'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
      ...overrides,
    } as Account;
  }

  const PNG: ForumPhoto = { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
  const JPEG: ForumPhoto = { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) };

  interface Ctx {
    auth: InMemoryAuthStore;
    messages: InMemoryMessageStore;
    shops: InMemoryShopIdentityStore;
    publisher: RecordingPublisher;
  }

  async function context(
    notes: Array<{ row: MessageRow; photos?: ForumPhoto[] }>,
    till: Account | null = account(),
  ): Promise<Ctx> {
    const auth = new InMemoryAuthStore();
    if (till !== null) await auth.createAccount(till);
    const messages = new InMemoryMessageStore();
    for (const { row, photos = [] } of notes) {
      await messages.create(row, photos[0], undefined, photos.slice(1));
    }
    return {
      auth,
      messages,
      shops: new InMemoryShopIdentityStore(messages),
      publisher: new RecordingPublisher(),
    };
  }

  let clock = 1_700_000_000_000;

  async function tick(
    ctx: Ctx,
    env: Record<string, string> = ENV,
    overrides: Partial<NostrWorkerDeps> = {},
  ): Promise<void> {
    clock += 60_000;
    const now = clock;
    await runNostrWorkerTick({
      messages: ctx.messages,
      auth: ctx.auth,
      kek: KEK,
      publisher: ctx.publisher,
      querier: new RecordingQuerier(),
      fetchImpl: async () => new Response('{}', { status: 500 }),
      now: () => now,
      env,
      shopIdentities: ctx.shops,
      ...overrides,
    });
  }

  function shopEvents(ctx: Ctx, identity: ShopIdentityRow, kind: number): NostrEvent[] {
    return ctx.publisher.calls
      .filter(
        (call) =>
          call.event['pubkey'] === identity.nostrPubkey &&
          call.event['kind'] === kind &&
          call.urls.includes('wss://relay.nostr.space'),
      )
      .map((call) => call.event as unknown as NostrEvent);
  }

  function content(event: NostrEvent | undefined): Record<string, unknown> {
    return JSON.parse(String(event?.content)) as Record<string, unknown>;
  }

  /** Same object with some methods replaced; other methods stay bound to the original. */
  function override<T extends object>(target: T, replaced: Partial<T>): T {
    return new Proxy(target, {
      get(object, key) {
        if (Object.hasOwn(replaced, key)) return (replaced as Record<PropertyKey, unknown>)[key];
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(object)
          : value;
      },
    });
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function logged(event: string): Array<Record<string, unknown>> {
    return warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['event'] === event);
  }

  describe('shop key backfill', () => {
    it('creates the key of a listed shop and queues its place push', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await tick(ctx);
      const identity = await ctx.shops.getByMessageId(uuid(1));
      expect(identity).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 1 });
    });

    it('walks past incomplete notes and wraps around', async () => {
      const notes = Array.from({ length: 21 }, (_, index) => ({
        row: shopNote(uuid(index + 1), {
          text: 'Too short #21GiftsShop',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        }),
      }));
      notes.push({ row: shopNote(uuid(99), { createdAt: new Date(Date.UTC(2026, 0, 2)) }) });
      const ctx = await context(notes);
      await tick(ctx);
      expect(await ctx.shops.getByMessageId(uuid(99))).toBeUndefined();
      await tick(ctx);
      expect(await ctx.shops.getByMessageId(uuid(99))).toBeDefined();
      await ctx.messages.updateText(uuid(1), TEXT);
      await tick(ctx);
      expect(await ctx.shops.getByMessageId(uuid(1))).toBeDefined();
    });

    it('pages past keyed shops one bounded raw page per tick', async () => {
      const notes = Array.from({ length: 26 }, (_, index) => ({
        row: shopNote(uuid(index + 1), { createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)) }),
      }));
      const ctx = await context(notes);
      for (let n = 1; n <= 25; n += 1) await ctx.shops.ensureListed(uuid(n), KEK);
      const reads: Array<{ cursor: string | null; ids: string[] }> = [];
      const keyed: string[] = [];
      const shops = override<ShopIdentityStore>(ctx.shops, {
        listCandidates: async (cursor, limit) => {
          const page = await ctx.shops.listCandidates(cursor, limit);
          reads.push({ cursor: cursor?.id ?? null, ids: page.map((row) => row.id) });
          return page;
        },
        ensureListed: (id, kek) => {
          keyed.push(id);
          return ctx.shops.ensureListed(id, kek);
        },
      });
      // First tick: one raw page of WORKER_BATCH keyed shops, no key generated.
      await tick(ctx, {}, { shopIdentities: shops });
      expect(reads).toEqual([
        { cursor: null, ids: Array.from({ length: 20 }, (_, index) => uuid(index + 1)) },
      ]);
      expect(keyed).toEqual([]);
      expect(await ctx.shops.getByMessageId(uuid(26))).toBeUndefined();
      // Second tick: the cursor advanced on the raw page; the short page holds
      // the unkeyed shop, which alone gets its key.
      await tick(ctx, {}, { shopIdentities: shops });
      expect(reads[1]).toEqual({
        cursor: uuid(20),
        ids: Array.from({ length: 6 }, (_, index) => uuid(index + 21)),
      });
      expect(keyed).toEqual([uuid(26)]);
      expect(await ctx.shops.getByMessageId(uuid(26))).toBeDefined();
      // The short raw page reset the cursor to the start.
      await tick(ctx, {}, { shopIdentities: shops });
      expect(reads[2]?.cursor).toBeNull();
      expect(reads.every((read) => read.ids.length <= 20)).toBe(true);
    });

    it('logs shop.nostr_key.failed and continues', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
      let calls = 0;
      const failing = override<ShopIdentityStore>(ctx.shops, {
        ensureListed: (id, kek) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('db')) : ctx.shops.ensureListed(id, kek);
        },
      });
      await tick(ctx, {}, { shopIdentities: failing });
      expect(logged('shop.nostr_key.failed')).toEqual([
        expect.objectContaining({ messageId: uuid(1) }),
      ]);
      expect(await ctx.shops.getByMessageId(uuid(2))).toBeDefined();
    });

    it('does nothing without a shop store', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await tick(ctx, ENV, { shopIdentities: undefined as unknown as ShopIdentityStore });
      expect(await ctx.shops.listAll()).toEqual([]);
    });

    it('skips the backfill of a tick while the previous backfill is in flight', async () => {
      const notes = Array.from({ length: 21 }, (_, index) => ({
        row: shopNote(uuid(index + 1), {
          text: 'Too short #21GiftsShop',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        }),
      }));
      notes.push({ row: shopNote(uuid(99), { createdAt: new Date(Date.UTC(2026, 0, 2)) }) });
      const ctx = await context(notes);
      const step = gate();
      const read = ctx.shops.listCandidates.bind(ctx.shops);
      const cursors: Array<string | null> = [];
      ctx.shops.listCandidates = async (cursor, limit) => {
        cursors.push(cursor?.id ?? null);
        const page = await read(cursor, limit);
        if (cursors.length === 1) {
          step.enter();
          await step.held;
        }
        return page;
      };
      const first = tick(ctx);
      await step.entered;
      // The second tick reads no candidate page and leaves the cursor alone.
      await tick(ctx);
      expect(cursors).toEqual([null]);
      step.release();
      await first;
      expect(await ctx.shops.getByMessageId(uuid(99))).toBeUndefined();
      // The next tick continues after the first page and reaches the shop.
      await tick(ctx);
      expect(cursors).toEqual([null, uuid(20)]);
      expect(await ctx.shops.getByMessageId(uuid(99))).toBeDefined();
    });

    it('clears the backfill in-flight mark when the candidate read fails', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      const read = ctx.shops.listCandidates.bind(ctx.shops);
      let failures = 1;
      ctx.shops.listCandidates = (cursor, limit) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('db down'));
        }
        return read(cursor, limit);
      };
      await expect(tick(ctx)).rejects.toThrow('db down');
      await tick(ctx);
      expect(await ctx.shops.getByMessageId(uuid(1))).toBeDefined();
    });
  });

  describe('shop kind 0', () => {
    it('publishes the listed profile signed by the shop key, once per content', async () => {
      const ctx = await context([
        { row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG, JPEG] },
      ]);
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const events = shopEvents(ctx, identity, 0);
      expect(events).toHaveLength(1);
      expect(verifyEvent(events[0]!)).toBe(true);
      expect(content(events[0])).toEqual({
        name: 'Coffee Lab',
        display_name: 'Coffee Lab',
        website: `https://21.gifts/${shopNpub(identity)}`,
        about: 'Fresh coffee roasted here every morning.',
        banner: `https://api.21.gifts/messages/${uuid(1)}/photo/1.jpg`,
        picture: `https://api.21.gifts/messages/${uuid(1)}/photo.png`,
        lud16: 'coffee@example.com',
        nip05: 'coffee-lab@21.gifts',
      });
      expect(logged('nostr.profile.ok')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      await tick(ctx);
      expect(shopEvents(ctx, identity, 0)).toHaveLength(1);
    });

    it('reads only the photo content types, also for an unchanged shop', async () => {
      const ctx = await context([
        { row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG, JPEG] },
      ]);
      // Byte reads of the shop note only: backfillProfileMessages creates the
      // till account's profile note at the end of the first tick, and signBatch
      // reads that note's photo in the second tick.
      const byteReads: string[] = [];
      const typeReads: string[] = [];
      const metadataOnly = override<MessageStore>(ctx.messages, {
        getPhoto: (id) => {
          if (id === uuid(1)) byteReads.push('getPhoto');
          return ctx.messages.getPhoto(id);
        },
        listExtraPhotos: (id) => {
          if (id === uuid(1)) byteReads.push('listExtraPhotos');
          return ctx.messages.listExtraPhotos(id);
        },
        getPhotoSet: (id) => {
          if (id === uuid(1)) byteReads.push('getPhotoSet');
          return ctx.messages.getPhotoSet(id);
        },
        getPhotoContentTypes: (id) => {
          typeReads.push(id);
          return ctx.messages.getPhotoContentTypes(id);
        },
      });
      // The shop store reads through the counting store as well, so its own
      // queue syncs count towards the byte reads.
      ctx.shops = new InMemoryShopIdentityStore(metadataOnly);
      await tick(ctx, ENV, { messages: metadataOnly });
      // Unchanged content: the second pass skips the publish after its reads.
      await tick(ctx, ENV, { messages: metadataOnly });
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const events = shopEvents(ctx, identity, 0);
      expect(events).toHaveLength(1);
      expect(content(events[0])).toMatchObject({
        banner: `https://api.21.gifts/messages/${uuid(1)}/photo/1.jpg`,
        picture: `https://api.21.gifts/messages/${uuid(1)}/photo.png`,
      });
      expect(typeReads).toEqual([uuid(1), uuid(1)]);
      expect(byteReads).toEqual([]);
    });

    it('follows a rename with a new local part and profile_name', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await tick(ctx);
      await ctx.messages.setPlace(uuid(1), { ...shopNote(uuid(1)).place!, label: 'Roastery' });
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const events = shopEvents(ctx, identity, 0);
      expect(events).toHaveLength(2);
      expect(content(events[1])).toMatchObject({ name: 'Roastery', nip05: 'roastery@21.gifts' });
      expect(events[1]!.created_at).toBeGreaterThan(events[0]!.created_at);
      expect(identity.profileName).toBe('Roastery');
    });

    it('does not put an older name back over a rename that committed during the tick', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await tick(ctx);
      await ctx.messages.setPlace(uuid(1), { ...shopNote(uuid(1)).place!, label: 'Roastery' });
      const seen: string[] = [];
      const racing = override<ShopIdentityStore>(ctx.shops, {
        renameIfListed: async (note) => {
          seen.push(note.place!.label!);
          // A newer rename commits after this tick read the note.
          await ctx.messages.setPlace(uuid(1), { ...shopNote(uuid(1)).place!, label: 'Bakery' });
          await ctx.shops.ensureListed(uuid(1), KEK);
          return ctx.shops.renameIfListed(note);
        },
      });
      await tick(ctx, ENV, { shopIdentities: racing });
      expect(seen).toEqual(['Roastery']);
      expect((await ctx.shops.getByMessageId(uuid(1)))?.profileName).toBe('Bakery');
      // Unlisted before the next tick: the kind 0 keeps the newest name.
      await ctx.messages.setShopAccount(uuid(1), null);
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const events = shopEvents(ctx, identity, 0);
      expect(content(events.at(-1))).toMatchObject({ name: 'Bakery' });
    });

    it('keeps the last listed name for an unlisted shop and uses Shop once it is hidden', async () => {
      const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      await ctx.messages.updateText(uuid(1), 'Too short #21GiftsShop');
      await tick(ctx);
      await ctx.messages.markDeleted(uuid(1), new Date(0), 'staff');
      await tick(ctx);
      const events = shopEvents(ctx, identity, 0);
      expect(events).toHaveLength(3);
      const website = `https://21.gifts/${shopNpub(identity)}`;
      expect(content(events[1])).toEqual({
        name: 'Coffee Lab',
        display_name: 'Coffee Lab',
        website,
        about: 'This shop is no longer listed on 21.gifts.',
      });
      expect(content(events[2])).toEqual({
        name: 'Shop',
        display_name: 'Shop',
        website,
        about: 'This shop is no longer listed on 21.gifts.',
      });
    });

    it('uses Shop when the note is gone', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.shops.ensureListed(uuid(1), KEK);
      const gone = override<MessageStore>(ctx.messages, {
        getById: () => Promise.resolve(undefined),
      });
      await tick(ctx, ENV, { messages: gone });
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(content(shopEvents(ctx, identity, 0)[0])).toMatchObject({ name: 'Shop' });
    });

    it('falls back like an account profile without a public origin', async () => {
      const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
      const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
      await tick(ctx, env);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const body = content(shopEvents(ctx, identity, 0)[0]);
      expect(body).toMatchObject({
        website: `https://21.gifts/${shopNpub(identity)}`,
        picture: KIND0_PICTURE_URL,
        banner: KIND0_BANNER_URL,
      });
      expect(body['nip05']).toBeUndefined();
    });

    it('links a dev shop to its own site and uses the banner fallback for one photo', async () => {
      const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
      await tick(ctx, { ...ENV, PUBLIC_BASE_URL: 'https://dev.21.gifts/' });
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(content(shopEvents(ctx, identity, 0)[0])).toMatchObject({
        website: `https://dev.21.gifts/${shopNpub(identity)}`,
        picture: `https://dev-api.21.gifts/messages/${uuid(1)}/photo.png`,
        banner: KIND0_BANNER_URL,
        nip05: 'coffee-lab@dev.21.gifts',
      });
    });

    it.each([0, 1, 2])(
      'takes picture from photo 0 and banner from the still stored at index 1 when index %i has an unrecognized type',
      async (bad) => {
        const WEBP: ForumPhoto = { contentType: 'image/webp', bytes: new Uint8Array([6]) };
        const stills: ForumPhoto[] = [PNG, JPEG, WEBP, PNG];
        stills[bad] = {
          contentType: 'image/gif',
          bytes: new Uint8Array([7]),
        } as unknown as ForumPhoto;
        const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: stills }]);
        await tick(ctx);
        const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
        // Each field reads its own stored index: an unrecognized photo 0
        // keeps the banner, and an unrecognized still 1 is not replaced by
        // still 2.
        expect(content(shopEvents(ctx, identity, 0)[0])).toMatchObject({
          picture:
            bad === 0 ? KIND0_PICTURE_URL : `https://api.21.gifts/messages/${uuid(1)}/photo.png`,
          banner:
            bad === 1 ? KIND0_BANNER_URL : `https://api.21.gifts/messages/${uuid(1)}/photo/1.jpg`,
        });
      },
    );

    it('omits lud16 when the till account has no kind 0 address or no username', async () => {
      for (const till of [
        account({ lightningAddress: null }),
        account({ lightningAddress: ' ' }),
        account({ name: null }),
        account({ username: null, name: 'Coffee', lightningAddress: 'coffee@example.com' }),
        account({ username: ' ', name: 'Coffee', lightningAddress: 'coffee@example.com' }),
        null,
      ]) {
        const ctx = await context([{ row: shopNote(uuid(1)) }], till);
        await tick(ctx);
        const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
        expect(content(shopEvents(ctx, identity, 0)[0])['lud16']).toBeUndefined();
      }
    });

    it('matches the nostr.json entry when a nameless account holds the slug', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.auth.createAccount(
        account({
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: null,
          username: 'coffee-lab',
          lightningAddress: null,
          viewKey: '22'.repeat(32),
          createdAt: 2,
        }),
      );
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const nip05 = String(content(shopEvents(ctx, identity, 0)[0])['nip05']);
      const json = await buildNostrJson(ctx.auth, ENV, undefined, {
        identities: ctx.shops,
        messages: ctx.messages,
      });
      const local = nip05.split('@')[0]!;
      expect(local).toBe(`coffee-lab-${uuid(1).replace(/-/g, '').slice(0, 8)}`);
      expect(json.names[local]).toBe(identity.nostrPubkey);
      expect(json.names['coffee-lab']).not.toBe(identity.nostrPubkey);
    });

    it('allocates NIP-05 once per tick, only for a visited listed shop with a domain', async () => {
      const allocate = vi.mocked(listShopNip05Entries);
      const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
      allocate.mockClear();
      await tick(ctx);
      expect(allocate).toHaveBeenCalledTimes(1);
      const identity = (await ctx.shops.getByMessageId(uuid(2)))!;
      expect(content(shopEvents(ctx, identity, 0)[0])['nip05']).toMatch(
        /^coffee-lab-.+@21\.gifts$/,
      );

      allocate.mockClear();
      const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
      const noDomain = await context([{ row: shopNote(uuid(1)) }]);
      await tick(noDomain, env);
      expect(shopEvents(noDomain, (await noDomain.shops.getByMessageId(uuid(1)))!, 0)).toHaveLength(
        1,
      );

      const unlisted = await context([{ row: shopNote(uuid(1)) }]);
      await unlisted.shops.ensureListed(uuid(1), KEK);
      await unlisted.messages.updateText(uuid(1), 'Only coffee here, no tag at all.');
      await tick(unlisted);
      const gone = (await unlisted.shops.getByMessageId(uuid(1)))!;
      expect(content(shopEvents(unlisted, gone, 0)[0])['nip05']).toBeUndefined();
      expect(allocate).not.toHaveBeenCalled();
    });

    it('skips shop kind 0 for a tick whose NIP-05 allocation fails, and the tick goes on', async () => {
      const allocate = vi.mocked(listShopNip05Entries);
      const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
      for (const id of [uuid(1), uuid(2)]) await ctx.shops.ensureListed(id, KEK);
      const later: string[] = [];
      const messages = override<InMemoryMessageStore>(ctx.messages, {
        claimUnpublished: (limit, nowMs, leaseMs) => {
          later.push('kind 1');
          return ctx.messages.claimUnpublished(limit, nowMs, leaseMs);
        },
      });
      const store = new InMemoryConversationStore();
      const conversations = override<InMemoryConversationStore>(store, {
        claimUnpublished: (limit, nowMs, leaseMs) => {
          later.push('conversations');
          return store.claimUnpublished(limit, nowMs, leaseMs);
        },
      });
      allocate.mockClear();
      allocate.mockRejectedValueOnce(new Error('db'));
      await tick(ctx, ENV, { messages, conversations });
      expect(allocate).toHaveBeenCalledTimes(1);
      const shops = await ctx.shops.listAll();
      for (const identity of shops) {
        expect(shopEvents(ctx, identity, 0)).toHaveLength(0);
        expect(shopEvents(ctx, identity, 10002)).toHaveLength(1);
      }
      expect(later).toEqual(['kind 1', 'conversations']);
      expect(logged('nostr.profile.nack')).toEqual([
        {
          ts: expect.any(String),
          event: 'nostr.profile.nack',
          messageId: uuid(1),
          reason: 'nip05',
        },
      ]);
      await tick(ctx);
      for (const identity of shops) {
        expect(String(content(shopEvents(ctx, identity, 0)[0])['nip05'])).toMatch(/@21\.gifts$/);
      }
    });

    /** Run `change` once, right after shop `first` publishes its kind 0. */
    function afterShopKind0(ctx: Ctx, first: ShopIdentityRow, change: () => Promise<void>): void {
      const publisher = ctx.publisher;
      const publish = publisher.publish.bind(publisher);
      let done = false;
      publisher.publish = async (event, urls, timeoutMs) => {
        const acks = await publish(event, urls, timeoutMs);
        if (!done && event['pubkey'] === first.nostrPubkey && event['kind'] === 0) {
          done = true;
          await change();
        }
        return acks;
      };
    }

    it('allocates NIP-05 again for a shop renamed after the allocation in the same tick', async () => {
      const allocate = vi.mocked(listShopNip05Entries);
      const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
      for (const id of [uuid(1), uuid(2)]) await ctx.shops.ensureListed(id, KEK);
      const [first, second] = await ctx.shops.listAll();
      afterShopKind0(ctx, first!, async () => {
        await ctx.messages.setPlace(uuid(2), { ...shopNote(uuid(2)).place!, label: 'Roastery' });
      });
      allocate.mockClear();
      await tick(ctx);
      expect(allocate).toHaveBeenCalledTimes(2);
      expect(content(shopEvents(ctx, first!, 0)[0])['nip05']).toBe('coffee-lab@21.gifts');
      const events = shopEvents(ctx, second!, 0);
      expect(events).toHaveLength(1);
      expect(content(events[0])).toMatchObject({ name: 'Roastery', nip05: 'roastery@21.gifts' });
      const json = await buildNostrJson(ctx.auth, ENV, undefined, {
        identities: ctx.shops,
        messages: ctx.messages,
      });
      expect(json.names['roastery']).toBe(second!.nostrPubkey);
      expect(logged('nostr.profile.nack')).toEqual([]);
    });

    it('allocates NIP-05 again for a shop listed after the allocation in the same tick', async () => {
      const allocate = vi.mocked(listShopNip05Entries);
      const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
      for (const id of [uuid(1), uuid(2)]) await ctx.shops.ensureListed(id, KEK);
      await ctx.messages.updateText(uuid(2), 'Only coffee here, no tag at all.');
      const [first, second] = await ctx.shops.listAll();
      afterShopKind0(ctx, first!, async () => {
        await ctx.messages.updateText(uuid(2), TEXT);
      });
      allocate.mockClear();
      await tick(ctx);
      expect(allocate).toHaveBeenCalledTimes(2);
      const events = shopEvents(ctx, second!, 0);
      expect(events).toHaveLength(1);
      expect(content(events[0])).toMatchObject({
        name: 'Coffee Lab',
        nip05: `coffee-lab-${uuid(2).replace(/-/g, '').slice(0, 8)}@21.gifts`,
      });
      expect(logged('nostr.profile.nack')).toEqual([]);
    });

    it('publishes nothing for a shop whose NIP-05 is still stale after the second allocation', async () => {
      const allocate = vi.mocked(listShopNip05Entries);
      const actual = allocate.getMockImplementation()!;
      const ctx = await context([
        { row: shopNote(uuid(1)) },
        { row: shopNote(uuid(2)) },
        { row: shopNote(uuid(3)) },
      ]);
      for (const id of [uuid(1), uuid(2), uuid(3)]) await ctx.shops.ensureListed(id, KEK);
      await ctx.messages.updateText(uuid(3), 'Only coffee here, no tag at all.');
      const [first, second, third] = await ctx.shops.listAll();
      afterShopKind0(ctx, first!, async () => {
        await ctx.messages.setPlace(uuid(2), { ...shopNote(uuid(2)).place!, label: 'Roastery' });
      });
      allocate.mockClear();
      allocate.mockImplementationOnce(actual).mockImplementationOnce(async (...args) => {
        // Renamed again before the second allocation, listed again after it.
        await ctx.messages.setPlace(uuid(2), { ...shopNote(uuid(2)).place!, label: 'Bakery' });
        const rows = await actual(...args);
        await ctx.messages.updateText(uuid(3), TEXT);
        return rows;
      });
      await tick(ctx);
      expect(allocate).toHaveBeenCalledTimes(2);
      expect(shopEvents(ctx, first!, 0)).toHaveLength(1);
      expect(shopEvents(ctx, second!, 0)).toHaveLength(0);
      expect(shopEvents(ctx, third!, 0)).toHaveLength(0);
      expect(logged('nostr.profile.nack')).toEqual([
        {
          ts: expect.any(String),
          event: 'nostr.profile.nack',
          messageId: uuid(2),
          reason: 'nip05_stale',
        },
        {
          ts: expect.any(String),
          event: 'nostr.profile.nack',
          messageId: uuid(3),
          reason: 'nip05_stale',
        },
      ]);
      // No rename was written for the stale shop.
      expect((await ctx.shops.getByMessageId(uuid(2)))?.profileName).toBe('Coffee Lab');
      await tick(ctx);
      expect(content(shopEvents(ctx, second!, 0)[0])).toMatchObject({
        name: 'Bakery',
        nip05: 'bakery@21.gifts',
      });
      expect(content(shopEvents(ctx, third!, 0)[0])).toMatchObject({
        name: 'Coffee Lab',
        nip05: `coffee-lab-${uuid(3).replace(/-/g, '').slice(0, 8)}@21.gifts`,
      });
    });

    it('clears the cache on a nack and retries on the next tick', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      ctx.publisher.ok = false;
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(logged('nostr.profile.nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      expect(logged('nostr.relays.nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      ctx.publisher.ok = true;
      await tick(ctx);
      expect(shopEvents(ctx, identity, 0)).toHaveLength(2);
      expect(shopEvents(ctx, identity, 10002)).toHaveLength(2);
    });

    it('requires the public ack and copies to the indexer when public publishing is on', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      const publisher = ctx.publisher;
      let publicOk = false;
      publisher.publish = (event, urls) => {
        publisher.calls.push({ event, urls: [...urls] });
        return Promise.resolve(
          urls.map((url) => ({
            url,
            ok: url === 'wss://relay.damus.io' ? publicOk : url !== 'wss://purplepag.es',
          })),
        );
      };
      await tick(ctx, PUBLIC_ENV);
      expect(logged('nostr.profile.nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      publicOk = true;
      await tick(ctx, PUBLIC_ENV);
      expect(logged('nostr.profile.indexer_nack')).toContainEqual({
        ts: expect.any(String),
        event: 'nostr.profile.indexer_nack',
        messageId: uuid(1),
      });
      expect(logged('nostr.relays.indexer_nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(
        publisher.calls.some(
          (call) =>
            call.event['pubkey'] === identity.nostrPubkey && call.urls[0] === 'wss://purplepag.es',
        ),
      ).toBe(true);
    });

    it('logs a nack when signing fails', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.shops.ensureListed(uuid(1), KEK);
      const broken = override<ShopIdentityStore>(ctx.shops, {
        getNostrCiphertext: () => Promise.resolve(undefined),
      });
      await tick(ctx, ENV, { shopIdentities: broken });
      expect(logged('nostr.profile.nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
      expect(logged('nostr.relays.nack')).toContainEqual(
        expect.objectContaining({ messageId: uuid(1) }),
      );
    });

    it('publishes a new relay list when the write relays change', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      const first = shopEvents(ctx, identity, 10002);
      await tick(ctx, PUBLIC_ENV);
      const both = shopEvents(ctx, identity, 10002);
      expect(first).toHaveLength(1);
      expect(both).toHaveLength(2);
      expect(both[1]!.created_at).toBeGreaterThan(both[0]!.created_at);
      expect(both[1]!.tags).toEqual([
        ['r', 'wss://relay.nostr.space'],
        ['r', 'wss://relay.damus.io'],
      ]);
    });

    it('attempts at most 20 shops per tick', async () => {
      const notes = Array.from({ length: 21 }, (_, index) => ({ row: shopNote(uuid(index + 1)) }));
      const ctx = await context(notes);
      for (const { row } of notes) await ctx.shops.ensureListed(row.id, KEK);
      const keys = new Set((await ctx.shops.listAll()).map((row) => row.nostrPubkey));
      const count = (kind: number): number =>
        ctx.publisher.calls.filter(
          (call) =>
            call.event['kind'] === kind &&
            keys.has(String(call.event['pubkey'])) &&
            call.urls.includes('wss://relay.nostr.space'),
        ).length;
      await tick(ctx);
      expect(count(0)).toBe(20);
      expect(count(10002)).toBe(20);
      await tick(ctx);
      expect(count(0)).toBe(21);
      expect(count(10002)).toBe(21);
    });

    it('publishes a shop behind 20 permanently failing shops within two ticks', async () => {
      const notes = Array.from({ length: 21 }, (_, index) => ({ row: shopNote(uuid(index + 1)) }));
      const ctx = await context(notes);
      for (const { row } of notes) await ctx.shops.ensureListed(row.id, KEK);
      const failing = new Set(notes.slice(0, 20).map(({ row }) => row.id));
      const broken = override<ShopIdentityStore>(ctx.shops, {
        getNostrCiphertext: (id: string) =>
          failing.has(id) ? Promise.resolve(undefined) : ctx.shops.getNostrCiphertext(id),
      });
      const last = (await ctx.shops.getByMessageId(uuid(21)))!;
      await tick(ctx, ENV, { shopIdentities: broken });
      expect(shopEvents(ctx, last, 0)).toHaveLength(0);
      expect(shopEvents(ctx, last, 10002)).toHaveLength(0);
      await tick(ctx, ENV, { shopIdentities: broken });
      expect(shopEvents(ctx, last, 0)).toHaveLength(1);
      expect(shopEvents(ctx, last, 10002)).toHaveLength(1);
      for (let round = 0; round < 3; round += 1) {
        await tick(ctx, ENV, { shopIdentities: broken });
      }
      expect(shopEvents(ctx, last, 0)).toHaveLength(1);
      expect(logged('nostr.profile.nack').filter((row) => row['messageId'] === uuid(21))).toEqual(
        [],
      );
    });

    it('walks every kind round robin from the last attempted shop and wraps at the end', async () => {
      const notes = Array.from({ length: 25 }, (_, index) => ({ row: shopNote(uuid(index + 1)) }));
      const ctx = await context(notes);
      for (const { row } of notes) await ctx.shops.ensureListed(row.id, KEK);
      ctx.publisher.ok = false;
      const order = (await ctx.shops.listAll()).map((row) => row.messageId);
      expect(order).toEqual(notes.map(({ row }) => row.id));
      const attempts = (event: string): string[] =>
        logged(event)
          .map((row) => row['messageId'])
          .filter((id): id is string => typeof id === 'string');
      const lap = [...order, ...order, ...order];
      for (let round = 1; round <= 3; round += 1) {
        await tick(ctx);
        // 20 attempts per tick and kind, continuing after the last one.
        expect(attempts('nostr.profile.nack')).toEqual(lap.slice(0, 20 * round));
        expect(attempts('nostr.relays.nack')).toEqual(lap.slice(0, 20 * round));
      }
      // Every shop was attempted within two ticks, and the third tick started
      // at shop 16 after wrapping past shop 25 in the second.
      expect(attempts('nostr.profile.nack').slice(40, 41)).toEqual([uuid(16)]);
      expect(new Set(attempts('nostr.relays.nack').slice(0, 40))).toEqual(new Set(order));
    });

    /** Message ids of the shops each kind attempted so far, in order. */
    function attemptsOf(event: string): string[] {
      return logged(event)
        .map((row) => row['messageId'])
        .filter((id): id is string => typeof id === 'string');
    }

    /** `count` listed shops with keys, in `listAll()` order. */
    async function listedShops(count: number): Promise<{ ctx: Ctx; order: string[] }> {
      const notes = Array.from({ length: count }, (_, index) => ({
        row: shopNote(uuid(index + 1)),
      }));
      const ctx = await context(notes);
      for (const { row } of notes) await ctx.shops.ensureListed(row.id, KEK);
      const order = (await ctx.shops.listAll()).map((row) => row.messageId);
      expect(order).toEqual(notes.map(({ row }) => row.id));
      return { ctx, order };
    }

    it('counts a shop whose kind 0 fields cannot be read and moves the cursor past it', async () => {
      const { ctx, order } = await listedShops(25);
      const shopIds = new Set(order);
      const messages = override<MessageStore>(ctx.messages, {
        getById: (id: string) =>
          shopIds.has(id) ? Promise.reject(new Error('db down')) : ctx.messages.getById(id),
      });
      // Without `PUBLIC_BASE_URL` there is no NIP-05 list, so the first
      // failing read is the shop's own note in its kind 0 fields.
      const env = { ...ENV, PUBLIC_BASE_URL: '' };
      await tick(ctx, env, { messages });
      // Exactly 20 attempts, failures included, not a walk over every shop.
      expect(attemptsOf('nostr.profile.nack')).toEqual(order.slice(0, 20));
      await tick(ctx, env, { messages });
      // The next tick continues after shop 20 and wraps at the end.
      expect(attemptsOf('nostr.profile.nack').slice(20)).toEqual([
        ...order.slice(20),
        ...order.slice(0, 15),
      ]);
      const keys = new Set((await ctx.shops.listAll()).map((row) => row.nostrPubkey));
      const shopKind0 = ctx.publisher.calls.filter(
        (call) => call.event['kind'] === 0 && keys.has(String(call.event['pubkey'])),
      );
      expect(shopKind0).toEqual([]);
    });

    it('reads at most 20 identity rows per pass and kind, never every row', async () => {
      const { ctx, order } = await listedShops(45);
      ctx.publisher.ok = false;
      const pages: Array<{ cursor: string | null; ids: string[] }> = [];
      const shops = override<ShopIdentityStore>(ctx.shops, {
        listAll: () => Promise.reject(new Error('listAll must not be read')),
        listRound: async (cursor, limit) => {
          expect(limit).toBe(WORKER_BATCH);
          const rows = await ctx.shops.listRound(cursor, limit);
          pages.push({ cursor: cursor?.messageId ?? null, ids: rows.map((r) => r.messageId) });
          return rows;
        },
      });
      // Without `PUBLIC_BASE_URL` there is no NIP-05 allocation, which reads
      // every shop like `/.well-known/nostr.json` does.
      const env = { ...ENV, PUBLIC_BASE_URL: '' };
      for (let round = 0; round < 3; round += 1) {
        await tick(ctx, env, { shopIdentities: shops });
      }
      // One page per kind and tick, each at most WORKER_BATCH rows; the third
      // tick wraps from shop 45 to shop 1 with a second bounded read.
      expect(pages.map((page) => page.ids.length)).toEqual([20, 20, 20, 20, 20, 20]);
      const lap = [...order, ...order];
      for (const [index, page] of pages.entries()) {
        const start = 20 * Math.floor(index / 2);
        expect(page.ids).toEqual(lap.slice(start, start + 20));
        expect(page.cursor).toBe(start === 0 ? null : lap[start - 1]);
      }
      // No shop starves: every one of the 45 was visited by both kinds.
      expect(new Set(attemptsOf('nostr.profile.nack'))).toEqual(new Set(order));
      expect(new Set(attemptsOf('nostr.relays.nack'))).toEqual(new Set(order));
    });

    it('visits unchanged kind 10002 shops too, so a changed one is reached within a lap', async () => {
      const { ctx, order } = await listedShops(45);
      const env = { ...ENV, PUBLIC_BASE_URL: '' };
      for (let round = 0; round < 3; round += 1) await tick(ctx, env);
      const relayLists = (): string[] =>
        logged('nostr.relays.ok')
          .map((row) => row['messageId'])
          .filter((id): id is string => typeof id === 'string');
      expect(relayLists()).toEqual(order);
      // Every list is cached now; the next three ticks visit 60 rows and
      // publish none of them, then a relay change reaches every shop.
      for (let round = 0; round < 3; round += 1) await tick(ctx, env);
      expect(relayLists()).toHaveLength(45);
      for (let round = 0; round < 3; round += 1)
        await tick(ctx, { ...PUBLIC_ENV, PUBLIC_BASE_URL: '' });
      expect(new Set(relayLists().slice(45))).toEqual(new Set(order));
    });

    it('reaches a newer shop added after the cursor in the same lap', async () => {
      const { ctx, order } = await listedShops(25);
      ctx.publisher.ok = false;
      await tick(ctx);
      expect(attemptsOf('nostr.profile.nack')).toEqual(order.slice(0, 20));
      await ctx.messages.create(shopNote(uuid(26)));
      await ctx.shops.ensureListed(uuid(26), KEK);
      expect((await ctx.shops.listAll()).map((row) => row.messageId).at(-1)).toBe(uuid(26));
      await tick(ctx);
      const next = [...order.slice(20), uuid(26), ...order.slice(0, 14)];
      expect(attemptsOf('nostr.profile.nack').slice(20)).toEqual(next);
      expect(attemptsOf('nostr.relays.nack').slice(20)).toEqual(next);
    });

    it('wraps to the first shop when no row follows the cursor', async () => {
      const { ctx, order } = await listedShops(20);
      ctx.publisher.ok = false;
      // Tick 1 ends on the last row: the cursor is shop 20.
      await tick(ctx);
      expect(attemptsOf('nostr.profile.nack')).toEqual(order);
      // Tick 2 finds no row after the cursor and starts at shop 1.
      await tick(ctx);
      expect(attemptsOf('nostr.profile.nack').slice(20)).toEqual(order);
      expect(attemptsOf('nostr.relays.nack').slice(20)).toEqual(order);
    });
  });

  /** A promise held until `release`, plus one that settles when it is first awaited. */
  function gate(): {
    entered: Promise<void>;
    enter: () => void;
    held: Promise<void>;
    release: () => void;
  } {
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { entered, enter, held, release };
  }

  describe('overlapping shop ticks', () => {
    it('skips the kind 0 pass of a tick while the previous kind 0 pass is in flight', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.shops.ensureListed(uuid(1), KEK);
      const step = gate();
      const read = ctx.shops.getNostrCiphertext.bind(ctx.shops);
      let reads = 0;
      ctx.shops.getNostrCiphertext = async (id) => {
        reads += 1;
        if (reads === 1) {
          step.enter();
          await step.held;
        }
        return read(id);
      };
      const pages = vi.spyOn(ctx.shops, 'listRound');
      const first = tick(ctx);
      await step.entered;
      expect(pages).toHaveBeenCalledTimes(1);
      await ctx.messages.setPlace(uuid(1), { ...shopNote(uuid(1)).place!, label: 'Roastery' });
      await tick(ctx);
      // The second tick read only the kind 10002 page and published no kind 0.
      expect(pages).toHaveBeenCalledTimes(2);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(shopEvents(ctx, identity, 0)).toEqual([]);
      expect(shopEvents(ctx, identity, 10002)).toHaveLength(1);
      step.release();
      await first;
      await tick(ctx);
      const names = shopEvents(ctx, identity, 0).map((event) => content(event)['name']);
      expect(names).toEqual(['Coffee Lab', 'Roastery']);
    });

    it('skips the kind 10002 pass of a tick while the previous kind 10002 pass is in flight', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.shops.ensureListed(uuid(1), KEK);
      const step = gate();
      const read = ctx.shops.getNostrCiphertext.bind(ctx.shops);
      let reads = 0;
      ctx.shops.getNostrCiphertext = async (id) => {
        reads += 1;
        if (reads === 2) {
          step.enter();
          await step.held;
        }
        return read(id);
      };
      const first = tick(ctx);
      await step.entered;
      await tick(ctx, PUBLIC_ENV);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(shopEvents(ctx, identity, 10002)).toEqual([]);
      step.release();
      await first;
      await tick(ctx, PUBLIC_ENV);
      expect(shopEvents(ctx, identity, 10002).map((event) => event.tags)).toEqual([
        [['r', 'wss://relay.nostr.space']],
        [
          ['r', 'wss://relay.nostr.space'],
          ['r', 'wss://relay.damus.io'],
        ],
      ]);
    });

    it('clears the in-flight mark when the page read fails', async () => {
      const ctx = await context([{ row: shopNote(uuid(1)) }]);
      await ctx.shops.ensureListed(uuid(1), KEK);
      const page = ctx.shops.listRound.bind(ctx.shops);
      let failures = 1;
      ctx.shops.listRound = (cursor, limit) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('db down'));
        }
        return page(cursor, limit);
      };
      await expect(tick(ctx)).rejects.toThrow('db down');
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(shopEvents(ctx, identity, 0)).toHaveLength(1);
      expect(shopEvents(ctx, identity, 10002)).toHaveLength(1);
    });
  });
});
