import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import {
  MESSAGE_MAX_LENGTH,
  decodeMessageFeedCursor,
  encodeMessageFeedCursor,
  truncatePubkeyDisplay,
  unsignedNostrDefaults,
} from '@/lib/message';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { FUNDING_REQUIRED_FROM_UTC } from '@/lib/funding';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { messagesRoutes, type MessagesRouteDeps } from '@/routes/messages';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { InMemoryPushStore } from '@/lib/push-store';
import { removeForumVideo, resolveMediaDir, videoFilePath } from '@/lib/video';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

/** Fake BOLT11s are not NIP-57; spy `isNip57Invoice` true for HTTP 200 invoice paths. */
async function withNip57True<T>(run: () => Promise<T>): Promise<T> {
  const bolt11 = await import('@/lib/bolt11');
  const nip57Spy = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
  try {
    return await run();
  } finally {
    nip57Spy.mockRestore();
  }
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');
const JPEG2_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const JPEG2_B64 = Buffer.from(JPEG2_BYTES).toString('base64');
const JPEG3_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
const JPEG3_B64 = Buffer.from(JPEG3_BYTES).toString('base64');

function admittedFunding(accountId = 'acc'): InMemoryFundingStore {
  return new InMemoryFundingStore([
    {
      accountId,
      status: 'admitted',
      appliedAt: 1,
      decidedAt: 1,
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: 1,
      note: null,
    },
  ]);
}

function mount(
  authStore: InMemoryAuthStore,
  store: MessageStore = new InMemoryMessageStore(),
  routeDeps: Partial<MessagesRouteDeps> = {},
): Hono {
  return new Hono().route(
    '/messages',
    messagesRoutes({
      store,
      authStore,
      now,
      postLimiter: new PostRateLimiter(),
      invoiceLimiter: new InvoiceRateLimiter(),
      ...routeDeps,
    }),
  );
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function namedStore(name: string): Promise<InMemoryAuthStore> {
  const store = await seededStore();
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  if (existing === undefined) {
    throw new Error('expected account');
  }
  await store.updateAccount({
    ...existing,
    role: 'verified',
    name,
    username: (() => {
      const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      return slug === '' ? null : slug;
    })(),
    rulesAgreedAt: now(),
    lightningAddress: 'ada@walletofsatoshi.com',
  });
  return store;
}

/** Named session whose role may post unpaid replies (moderator). */
async function staffStore(name: string): Promise<InMemoryAuthStore> {
  const store = await namedStore(name);
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  if (existing === undefined) {
    throw new Error('expected account');
  }
  await store.updateAccount({ ...existing, role: 'moderator' });
  return store;
}

/** Signed-in account with rules agreed (name may still be missing). */
async function rulesStore(
  overrides: { name?: string | null; nameSkippedAt?: number | null } = {},
): Promise<InMemoryAuthStore> {
  const store = await seededStore();
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  if (existing === undefined) {
    throw new Error('expected account');
  }
  const name = overrides.name === undefined ? existing.name : overrides.name;
  await store.updateAccount({
    ...existing,
    name,
    username:
      name !== null && name.trim() !== ''
        ? name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
        : (existing.username ?? null),
    rulesAgreedAt: now(),
    ...(overrides.nameSkippedAt === undefined ? {} : { nameSkippedAt: overrides.nameSkippedAt }),
  });
  return store;
}

function throwingStore(overrides: Partial<MessageStore> = {}): MessageStore {
  const boom = async (): Promise<never> => {
    throw new Error('boom');
  };
  return {
    listLatest: boom,
    listFeed: boom,
    listReplies: boom,
    listDebug: boom,
    postCountsByUtcDay: boom,
    listHidden: boom,
    listIdsByPrefix: boom,
    listPlaces: async () => [],
    listDirectChildren: boom,
    listChildIds: boom,
    listPublishedEventIds: boom,
    create: boom,
    findLiveByAccountContent: boom,
    accountHasLivePost: boom,
    accountHasLiveTopLevelPost: boom,
    accountHasLiveTopLevelMediaPost: boom,
    latestLiveTopLevelMediaId: boom,
    countByAccount: boom,
    countAttributedReplies: boom,
    listPostsByAccount: boom,
    listRepliesByAccount: boom,
    getPhoto: boom,
    getExtraPhoto: boom,
    listExtraPhotos: boom,
    deleteById: boom,
    markDeleted: boom,
    markUndeleted: boom,
    getById: boom,
    getByEventId: boom,
    claimUnsigned: boom,
    claimUnpublished: boom,
    listPendingSigned: boom,
    listSignedMissingPhoto: boom,
    listSignedMissingVideo: boom,
    listSignedMissingHashtags: boom,
    clearSignedEvent: boom,
    resetSignedEvent: boom,
    updateText: boom,
    updatePhoto: boom,
    updateSignedEvent: boom,
    updatePublishState: boom,
    addSats: boom,
    claimZapPayment: boom,
    recordZapReceipt: boom,
    recordInvoiceAttempt: boom,
    listInvoiceAttempts: boom,
    listRecentOkInvoiceAttempts: boom,
    recordZapIngest: boom,
    listZapIngests: boom,
    findOkInvoiceByPaymentHash: boom,
    findOkInvoiceByPr: boom,
    updateZapReceiptGift: boom,
    getZapReceiptGift: boom,
    listZapReceiptsAwaitingGiftReply: boom,
    listInvoiceAttemptsForPayer: boom,
    listIndexedZapIngests: boom,
    listAuthoredMessages: boom,
    listOpenConversationZapEventIds: boom,
    attributeZapReceipt: boom,
    recordZapper: boom,
    listZapperPubkeys: boom,
    listZappers: boom,
    blockPubkeyAndHideRows: boom,
    unblockPubkeyByMessage: boom,
    isPubkeyBlocked: boom,
    isZapperPubkey: boom,
    listBlockedPubkeys: boom,
    listBlockedPubkeyRows: boom,
    listUnattributedIndexedReceipts: (_limit, _before) => boom(),
    ...overrides,
  };
}

describe('GET /messages', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 409 when rules are not agreed', async () => {
    const res = await mount(await seededStore()).request('/messages', { headers: AUTH });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns an empty list', async () => {
    const res = await mount(await rulesStore()).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('drops missing-file video notes from the list', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore([
      {
        id: '5c5051d3-adba-44f9-a964-9bd0df1ce084',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await messageStore.getById('5c5051d3-adba-44f9-a964-9bd0df1ce084')).toBeUndefined();
  });

  it('keeps nextCursor when a full page drops a missing-file parent', async () => {
    const goneId = '5c5051d3-adba-44f9-a964-9bd0df1ce090';
    const liveId = '5c5051d3-adba-44f9-a964-9bd0df1ce091';
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore([
      {
        id: goneId,
        accountId: 'acc',
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: liveId,
        accountId: 'acc',
        name: 'Ada',
        text: 'still here',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(authStore, messageStore).request('/messages?limit=1', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(body.messages).toEqual([]);
    expect(typeof body.nextCursor).toBe('string');
    expect(await messageStore.getById(goneId)).toBeUndefined();
    expect(await messageStore.getById(liveId)).toBeDefined();
  });

  it('keeps replyCount of live attributed children without dropping missing-file video replies on the list path', async () => {
    const parentId = '5c5051d3-adba-44f9-a964-9bd0df1ce085';
    const goneChildId = '5c5051d3-adba-44f9-a964-9bd0df1ce086';
    const keptChildId = '5c5051d3-adba-44f9-a964-9bd0df1ce087';
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'live parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: goneChildId,
        accountId: 'acc',
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: keptChildId,
        accountId: 'acc',
        name: 'Ada',
        text: 'text reply',
        createdAt: new Date(now() + 2),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; replyCount: number; text: string }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(2);
    expect(await messageStore.getById(goneChildId)).toBeDefined();
    expect(await messageStore.getById(keptChildId)).toBeDefined();
    expect(await messageStore.getById(parentId)).toBeDefined();
  });

  it('lists replyCount above the 200-reply list window', async () => {
    const parentId = '5c5051d3-adba-44f9-a964-9bd0df1ce088';
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent with many replies',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    for (let i = 0; i < 201; i++) {
      await messageStore.create({
        id: crypto.randomUUID(),
        accountId: 'acc',
        name: 'Ada',
        text: `reply ${i}`,
        createdAt: new Date(now() + 1 + i),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      });
    }
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; replyCount: number }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(parentId);
    expect(body.messages[0]?.replyCount).toBe(201);
  });

  it('returns newest first', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    const app = mount(authStore, messageStore);
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'older' }),
    });
    expect(first.status).toBe(200);
    await messageStore.create({
      id: 'later',
      accountId: 'acc',
      name: 'Ada',
      text: 'newer',
      createdAt: new Date(now() + 1_000),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
    });
    const res = await app.request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ text: string }> };
    expect(body.messages.map((m) => m.text)).toEqual(['newer', 'older']);
  });

  it('marks a signed note with a Lightning Address as payable', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'pay-1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]?.role).toBe('verified');
  });

  it('includes the live author role for moderator, founder, and verified', async () => {
    for (const role of ['moderator', 'founder', 'verified'] as const) {
      const authStore = await namedStore('Ada');
      const account = await authStore.getAccount('acc');
      expect(account).toBeDefined();
      if (account === undefined) {
        throw new Error('expected account');
      }
      await authStore.updateAccount({ ...account, role });
      const messageStore = new InMemoryMessageStore();
      await messageStore.create({
        id: `msg-${role}`,
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      });
      const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ role: string }> };
      expect(body.messages[0]?.role).toBe(role);
    }
  });

  it('marks a note with an empty eventId as not payable', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'empty-eid',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean }> };
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('marks a signed note without a Lightning Address as not payable', async () => {
    const authStore = await rulesStore({ name: 'Ada' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'nopay',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('basis');
  });

  it('defaults role to basis and payable to false when the author is missing', async () => {
    const authStore = await rulesStore();
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'orphan',
      accountId: 'gone',
      name: 'Ghost',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('basis');
  });

  it('returns 503 and logs when listFeed throws', async () => {
    const res = await mount(await rulesStore(), throwingStore()).request('/messages', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.list.failed')).toBe(true);
  });

  it('lists external and member notes with via only on the external note', async () => {
    const authStore = await rulesStore();
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'damus-list',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ab'.repeat(32),
    });
    await messageStore.create({
      id: 'member-list',
      accountId: 'acc',
      name: 'Ada',
      text: 'member note',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      authorPubkey: 'cd'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        text: string;
        payable: boolean;
        role?: string;
        hasVideo: boolean;
        via?: string;
      }>;
    };
    const external = body.messages.find((row) => row.text === 'hi');
    expect(external).toMatchObject({ payable: false, hasVideo: false, via: 'nostr' });
    expect(external).not.toHaveProperty('role');
    expect(external).not.toHaveProperty('accountId');
    const member = body.messages.find((row) => row.text === 'member note');
    expect(member).toMatchObject({ payable: false, hasVideo: false, role: 'basis' });
    expect(member).not.toHaveProperty('via');
  });

  it('pages with limit and nextCursor', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000001',
      accountId: 'acc',
      name: 'Ada',
      text: 'oldest',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000002',
      accountId: 'acc',
      name: 'Ada',
      text: 'middle',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000003',
      accountId: 'acc',
      name: 'Ada',
      text: 'newest',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = mount(authStore, messageStore);
    const first = await app.request('/messages?limit=2', { headers: AUTH });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(typeof firstBody.nextCursor).toBe('string');
    const cursor = firstBody.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) {
      throw new Error('expected nextCursor');
    }
    const second = await app.request(`/messages?limit=2&cursor=${encodeURIComponent(cursor)}`, {
      headers: AUTH,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(secondBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(secondBody).not.toHaveProperty('nextCursor');
  });

  it('omits notes with sats greater than zero in unpaid mode', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'unpaid-note',
      accountId: 'acc',
      name: 'Ada',
      text: 'unpaid',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: 'paid-note',
      accountId: 'acc',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 21,
    });
    const res = await mount(authStore, messageStore).request('/messages?mode=unpaid', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((row) => row.id)).toEqual(['unpaid-note']);
  });

  it('includes unpaid staff and paid basis in active mode', async () => {
    const authStore = await namedStore('Ada');
    await authStore.createAccount({
      id: 'founder-1',
      linkingKey: null,
      role: 'founder',
      name: 'Founder',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: now(),
      rulesAgreedAt: now(),
    });
    await authStore.createAccount({
      id: 'mod-1',
      linkingKey: null,
      role: 'moderator',
      name: 'Mod',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: now(),
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'unpaid-basis',
      accountId: 'acc',
      name: 'Ada',
      text: 'unpaid basis',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: 'paid-basis',
      accountId: 'acc',
      name: 'Ada',
      text: 'paid basis',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 21,
    });
    await messageStore.create({
      id: 'unpaid-founder',
      accountId: 'founder-1',
      name: 'Founder',
      text: 'unpaid founder',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: 'unpaid-moderator',
      accountId: 'mod-1',
      name: 'Mod',
      text: 'unpaid moderator',
      createdAt: new Date(now() + 3),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages?mode=active', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((row) => row.id).sort()).toEqual(
      ['paid-basis', 'unpaid-founder', 'unpaid-moderator'].sort(),
    );
    expect(body.messages.map((row) => row.id)).not.toContain('unpaid-basis');
  });

  it('lists only positive sats newest-sats-first in popular mode', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000011',
      accountId: 'acc',
      name: 'Ada',
      text: 'zero',
      createdAt: new Date(now() + 3),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000012',
      accountId: 'acc',
      name: 'Ada',
      text: 'low',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 10,
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000013',
      accountId: 'acc',
      name: 'Ada',
      text: 'high',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 50,
    });
    const res = await mount(authStore, messageStore).request('/messages?mode=popular', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; sats: number }> };
    expect(body.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000013',
      '00000000-0000-4000-8000-000000000012',
    ]);
    expect(body.messages.map((row) => row.sats)).toEqual([50, 10]);
    const paged = await mount(authStore, messageStore).request('/messages?mode=popular&limit=1', {
      headers: AUTH,
    });
    expect(paged.status).toBe(200);
    const pagedBody = (await paged.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(pagedBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000013',
    ]);
    expect(typeof pagedBody.nextCursor).toBe('string');
    expect(pagedBody.nextCursor).toBeDefined();
    if (pagedBody.nextCursor === undefined) {
      throw new Error('expected popular nextCursor');
    }
    expect(decodeMessageFeedCursor(pagedBody.nextCursor)).toMatchObject({
      k: 's',
      s: 50,
      i: '00000000-0000-4000-8000-000000000013',
    });
    const secondPopular = await mount(authStore, messageStore).request(
      `/messages?mode=popular&limit=1&cursor=${encodeURIComponent(pagedBody.nextCursor)}`,
      { headers: AUTH },
    );
    expect(secondPopular.status).toBe(200);
    const secondPopularBody = (await secondPopular.json()) as { messages: Array<{ id: string }> };
    expect(secondPopularBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000012',
    ]);
  });

  it('returns 400 for an invalid mode', async () => {
    const res = await mount(await rulesStore()).request('/messages?mode=nope', { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid mode' });
  });

  it('returns 400 for an invalid hashtag', async () => {
    const app = mount(await rulesStore());
    for (const hashtag of [
      '',
      '%2321GiftsShop',
      '21-gifts',
      '_nope',
      'a'.repeat(65),
      '21%20gifts',
    ]) {
      const res = await app.request(`/messages?hashtag=${hashtag}`, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid hashtag' });
    }
  });

  it('lists only notes whose text contains the hashtag token', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000021',
      accountId: 'acc',
      name: 'Ada',
      text: 'Shop #21GiftsShop',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000022',
      accountId: 'acc',
      name: 'Ada',
      text: 'living room',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = mount(authStore, messageStore);
    const filtered = await app.request('/messages?hashtag=21GiftsShop', { headers: AUTH });
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { messages: Array<{ id: string }> };
    expect(filteredBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000021',
    ]);
    const all = await app.request('/messages', { headers: AUTH });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { messages: Array<{ id: string }> };
    expect(allBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000021',
    ]);
  });

  it('pages hashtag matches without mixing in untagged notes', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000023',
      accountId: 'acc',
      name: 'Ada',
      text: 'Shop #21GiftsShop',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000024',
      accountId: 'acc',
      name: 'Ada',
      text: 'also #21giftsshop here',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '00000000-0000-4000-8000-000000000025',
      accountId: 'acc',
      name: 'Ada',
      text: 'living room',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = mount(authStore, messageStore);
    const first = await app.request('/messages?hashtag=21GiftsShop&limit=1', { headers: AUTH });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000023',
    ]);
    expect(typeof firstBody.nextCursor).toBe('string');
    const cursor = firstBody.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) {
      throw new Error('expected nextCursor');
    }
    const second = await app.request(
      `/messages?hashtag=21GiftsShop&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { messages: Array<{ id: string }> };
    expect(secondBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000024',
    ]);
  });

  it('returns 400 for an invalid limit', async () => {
    const app = mount(await rulesStore());
    for (const limit of ['0', '201', 'abc']) {
      const res = await app.request(`/messages?limit=${limit}`, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid limit' });
    }
  });

  it('returns 400 for an invalid cursor', async () => {
    const app = mount(await rulesStore());
    const garbage = await app.request('/messages?cursor=%%%', { headers: AUTH });
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toEqual({ error: 'Invalid cursor' });
    const popularCursor = encodeMessageFeedCursor({
      k: 's',
      s: 21,
      c: new Date(now()).toISOString(),
      i: '00000000-0000-0000-0000-000000000001',
    });
    const wrongKind = await app.request(
      `/messages?mode=all&cursor=${encodeURIComponent(popularCursor)}`,
      { headers: AUTH },
    );
    expect(wrongKind.status).toBe(400);
    expect(await wrongKind.json()).toEqual({ error: 'Invalid cursor' });
    const timeCursor = encodeMessageFeedCursor({
      k: 't',
      c: new Date(now()).toISOString(),
      i: '00000000-0000-0000-0000-000000000001',
    });
    const popularWrongKind = await app.request(
      `/messages?mode=popular&cursor=${encodeURIComponent(timeCursor)}`,
      { headers: AUTH },
    );
    expect(popularWrongKind.status).toBe(400);
    expect(await popularWrongKind.json()).toEqual({ error: 'Invalid cursor' });
    const nonUuidId = encodeMessageFeedCursor({
      k: 't',
      c: new Date(now()).toISOString(),
      i: 'note-1',
    });
    const nonUuid = await app.request(`/messages?cursor=${encodeURIComponent(nonUuidId)}`, {
      headers: AUTH,
    });
    expect(nonUuid.status).toBe(400);
    expect(await nonUuid.json()).toEqual({ error: 'Invalid cursor' });
  });
});

describe('GET /messages/compose-target', () => {
  async function withPlatform(
    authStore: InMemoryAuthStore,
    overrides: { name?: string | null; lightningAddress?: string | null } = {},
  ): Promise<void> {
    await authStore.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'basis',
      name: overrides.name === undefined ? '21.gifts' : overrides.name,
      lightningAddress:
        overrides.lightningAddress === undefined
          ? 'gifts@walletofsatoshi.com'
          : overrides.lightningAddress,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: now(),
      isPlatform: true,
    });
  }

  it('returns 401 without a session', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages/compose-target');
    expect(res.status).toBe(401);
  });

  it('returns 409 when forum.post requirements are missing', async () => {
    const res = await mount(await seededStore()).request('/messages/compose-target', {
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules', 'name', 'username', 'lightning-address'],
    });
  });

  it('returns 503 when the platform account is missing', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages/compose-target', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 503 when the platform profile note is missing', async () => {
    const authStore = await namedStore('Ada');
    await withPlatform(authStore, { name: null, lightningAddress: null });
    const res = await mount(authStore).request('/messages/compose-target', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 400 when the platform profile note is not payable', async () => {
    const authStore = await namedStore('Ada');
    await withPlatform(authStore);
    const res = await mount(authStore).request('/messages/compose-target', { headers: AUTH });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
  });

  it('returns the platform profile note when it is payable', async () => {
    const authStore = await namedStore('Ada');
    await withPlatform(authStore);
    const platform = await authStore.getAccount('plat');
    expect(platform).toBeDefined();
    const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await authStore.updateAccount({ ...platform!, profileMessageId: noteId });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'plat',
      name: '21.gifts',
      text: '21.gifts',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages/compose-target', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId: noteId, sats: 0 });
  });

  it('returns 503 when listing accounts throws', async () => {
    const authStore = await namedStore('Ada');
    authStore.listAccounts = async () => {
      throw new Error('boom');
    };
    const res = await mount(authStore).request('/messages/compose-target', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 503 when the stored profile row is gone', async () => {
    const authStore = await namedStore('Ada');
    await withPlatform(authStore);
    const platform = await authStore.getAccount('plat');
    expect(platform).toBeDefined();
    const noteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await authStore.updateAccount({ ...platform!, profileMessageId: noteId });
    const messageStore = new InMemoryMessageStore();
    messageStore.getById = async () => undefined;
    const res = await mount(authStore, messageStore).request('/messages/compose-target', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });
});

describe('POST /messages', () => {
  it('uses the default post limiter when omitted', async () => {
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        })
      ).status;
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
  });

  it('returns 403 when a basis account posts without paying', async () => {
    const store = await namedStore('Ada');
    const acc = await store.getAccount('acc');
    expect(acc).toBeDefined();
    await store.updateAccount({ ...acc!, role: 'basis' });
    const res = await mount(store).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'A post needs a Bitcoin payment' });
  });

  it('allows a basis account to post a photo', async () => {
    const store = await namedStore('Ada');
    const acc = await store.getAccount('acc');
    expect(acc).toBeDefined();
    await store.updateAccount({ ...acc!, role: 'basis' });
    const res = await mount(store).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hi',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPhoto: boolean };
    expect(body.hasPhoto).toBe(true);
  });

  it('returns 429 on a burst of posts', async () => {
    const limiter = new PostRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await staffStore('Ada'),
        now,
        postLimiter: limiter,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        })
      ).status;
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer    ', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('posts and then lists the message with hasPhoto false', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  hello world  ' }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      name: string;
      text: string;
      createdAt: string;
      sats: number;
      payable: boolean;
      hasPhoto: boolean;
      hasVideo: boolean;
      videoContentType: string | null;
      role: string;
      accountId?: string;
    };
    expect(created.name).toBe('Ada');
    expect(created.text).toBe('hello world');
    expect(created.hasPhoto).toBe(false);
    expect(created.hasVideo).toBe(false);
    expect(created.videoContentType).toBeNull();
    expect(created.createdAt).toBe(new Date(now()).toISOString());
    expect(created.sats).toBe(0);
    expect(created.payable).toBe(false);
    expect(created.role).toBe('verified');
    expect(created.accountId).toBe('acc');
    expect(created).not.toHaveProperty('goalSats');
    expect(created.id.length).toBeGreaterThan(8);
    expect(created).not.toHaveProperty('via');

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: (typeof created & { replyCount: number })[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ ...created, replyCount: 0 });
    expect(body.messages[0]).not.toHaveProperty('via');
    expect(body.messages[0]).not.toHaveProperty('goalSats');
  });

  it('posts a top-level note with goalSats 21000', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask', goalSats: 21000 }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as { goalSats?: number };
    expect(created.goalSats).toBe(21000);
    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: { goalSats?: number }[] };
    expect(body.messages[0]?.goalSats).toBe(21000);
  });

  it('posts a top-level note with a place pin', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'pin', place: { lat: 47.3, lng: 8.5, label: 'Zürich' } }),
    });
    expect(post.status).toBe(200);
    const body = (await post.json()) as { place?: { lat: number; lng: number; label: string } };
    expect(body.place).toEqual({ lat: 47.3, lng: 8.5, label: 'Zürich' });
  });

  it('omits place when JSON has no pin', async () => {
    const post = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'plain' }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).not.toHaveProperty('place');
  });

  it('returns 400 when JSON place is missing longitude', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bad', place: { lat: 47.3 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  });

  it('returns 400 when JSON place label is too long', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bad', place: { lat: 1, lng: 2, label: 'A'.repeat(81) } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Place label must be at most 80 characters' });
  });

  it('returns 400 when JSON goalSats is above the max', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask', goalSats: 10_000_001 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
  });

  it.each([0, 21.5])('returns 400 when JSON goalSats is %s', async (goalSats) => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask', goalSats }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
  });

  it('omits goalSats when JSON goalSats is null', async () => {
    const post = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask', goalSats: null }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).not.toHaveProperty('goalSats');
  });

  it('enqueues a forum push for other subscribed accounts, not the author', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/author',
      accountId: 'acc',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello living room' }),
    });
    expect(post.status).toBe(200);
    const claimed = await pushStore.claimPending(20, now() + 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('other');
    expect(claimed[0]?.type).toBe('forum');
  });

  it('still returns 200 when forum push enqueue throws', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    pushStore.enqueue = async () => {
      throw new Error('enqueue failed');
    };
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello living room' }),
    });
    expect(post.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'push.enqueue.failed')).toBe(true);
  });

  it('includes the session account role on POST', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({ ...account, role: 'moderator' });
    const res = await mount(authStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('moderator');
  });

  it('returns 409 when posting without a name after rules and name skip', async () => {
    const store = await rulesStore({ name: null, nameSkippedAt: now() });
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await store.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const res = await mount(store).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['name', 'username'],
    });
  });

  it('returns 409 when posting with a whitespace-only name', async () => {
    const res = await mount(await namedStore('   ')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['name', 'username'],
    });
  });

  it('returns 409 when posting with name and rules but no Lightning Address', async () => {
    const store = await rulesStore({ name: 'Ada' });
    const res = await mount(store).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['lightning-address'],
    });
  });

  it('rejects invalid JSON', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with text and/or photo',
    });
  });

  it('rejects a body without text or photo', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with text and/or photo',
    });
  });

  it('rejects whitespace-only text without a photo', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo`,
    });
  });

  it('rejects too-long text', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A'.repeat(MESSAGE_MAX_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` });
  });

  it('rejects a tab in text', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello\tworld' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` });
  });

  it('returns 404 when inReplyTo is not a uuid', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'reply', inReplyTo: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when inReplyTo is a missing uuid', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'reply',
        inReplyTo: '00000000-0000-4000-8000-000000000001',
      }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('posts a reply to a top-level note via inReplyTo', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await staffStore('Ada'), messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { text: string };
    expect(created.text).toBe('child');
    const replies = await messageStore.listReplies(parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.parentId).toBe(parentId);
    expect(replies[0]?.text).toBe('child');
  });

  it('returns 400 when a reply asks for a goal', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await namedStore('Ada'), messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId, goalSats: 21000 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A reply cannot ask for a goal' });
    expect(await messageStore.listReplies(parentId)).toEqual([]);
  });

  it('returns 400 when a reply includes a place', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await namedStore('Ada'), messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'child',
        inReplyTo: parentId,
        place: { lat: 47.3, lng: 8.5, label: 'Zürich' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A reply cannot include a place' });
    expect(await messageStore.listReplies(parentId)).toEqual([]);
  });

  it('returns 403 when a basis account replies without paying', async () => {
    const authStore = await namedStore('Ada');
    const poster = await authStore.getAccount('acc');
    expect(poster).toBeDefined();
    await authStore.updateAccount({ ...poster!, role: 'basis' });
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'A reply needs a Bitcoin payment' });
    expect(await messageStore.listReplies(parentId)).toEqual([]);
  });

  it('returns 403 when the parent author is below verified', async () => {
    const authStore = await namedStore('Ada');
    const poster = await authStore.getAccount('acc');
    expect(poster).toBeDefined();
    await authStore.updateAccount({ ...poster!, role: 'basis' });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'A reply needs a Bitcoin payment' });
    expect(await messageStore.listReplies(parentId)).toEqual([]);
  });

  it('lets a verified account reply without paying', async () => {
    const authStore = await namedStore('Ada');
    const acc = await authStore.getAccount('acc');
    expect(acc).toBeDefined();
    if (acc === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({ ...acc, role: 'verified' });
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@walletofsatoshi.com',
      lightningAddressVerified: false,
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        inReplyTo: parentId,
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    expect(await messageStore.listReplies(parentId)).toHaveLength(1);
  });

  it('lets a moderator reply without paying', async () => {
    const authStore = await namedStore('Ada');
    const acc = await authStore.getAccount('acc');
    expect(acc).toBeDefined();
    if (acc === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({ ...acc, role: 'moderator' });
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@walletofsatoshi.com',
      lightningAddressVerified: false,
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bless you', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    expect(await messageStore.listReplies(parentId)).toHaveLength(1);
  });

  it('lets a founder reply without paying', async () => {
    const authStore = await namedStore('Ada');
    const acc = await authStore.getAccount('acc');
    expect(acc).toBeDefined();
    if (acc === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({ ...acc, role: 'founder' });
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@walletofsatoshi.com',
      lightningAddressVerified: false,
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'bless you', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    expect(await messageStore.listReplies(parentId)).toHaveLength(1);
  });

  it('notifies a subscribed parent of a forum reply', async () => {
    const authStore = await staffStore('Ada');
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: 'pat@walletofsatoshi.com',
      lightningAddressVerified: false,
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/parent',
      accountId: 'parent',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    const listed = await notificationStore.listByRecipient('parent', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_reply');
    expect(listed[0]?.text).toBe('child');
    const claimed = await pushStore.claimPending(10, now() + 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('parent');
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      title: 'Ada',
      body: 'child',
      url: '/notifications',
      tag: `forum_reply:${listed[0]?.replyId}`,
    });
  });

  it('creates a forum_post notification for other bell subscribers', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello living room' }),
    });
    expect(res.status).toBe(200);
    const listed = await notificationStore.listByRecipient('other', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_post');
    expect(listed[0]?.text).toBe('hello living room');
    expect(await notificationStore.listByRecipient('acc', 10)).toEqual([]);
  });

  it('skips a self-replier when they are the only subscriber', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(await namedStore('Ada'), messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    expect(await notificationStore.listByRecipient('acc', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, now() + 1, 60_000)).toEqual([]);
  });

  it('still returns 200 when reply notify throws', async () => {
    const authStore = await staffStore('Ada');
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const notificationStore = new InMemoryNotificationStore();
    notificationStore.create = async () => {
      throw new Error('boom');
    };
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/parent',
      accountId: 'parent',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.reply.notify.failed')).toBe(
      true,
    );
  });

  it('rejects an unpaid reply to a Damus-only parent', async () => {
    const authStore = await namedStore('Ada');
    const poster = await authStore.getAccount('acc');
    expect(poster).toBeDefined();
    await authStore.updateAccount({ ...poster!, role: 'basis' });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/acc',
      accountId: 'acc',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'A reply needs a Bitcoin payment' });
    expect(await notificationStore.listByRecipient('acc', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, now() + 1, 60_000)).toEqual([]);
  });

  it('enqueues a reply push without a notification store', async () => {
    const authStore = await staffStore('Ada');
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/parent',
      accountId: 'parent',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, { pushStore }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
    });
    expect(res.status).toBe(200);
    const claimed = await pushStore.claimPending(10, now() + 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      title: 'Ada',
      body: 'child',
      url: '/notifications',
      tag: `forum_reply:${claimed[0]?.messageId}`,
    });
  });

  it('creates a notification for a photo-only reply with empty text', async () => {
    const authStore = await staffStore('Ada');
    await authStore.createAccount({
      id: 'parent',
      linkingKey: null,
      role: 'basis',
      name: 'Pat',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const notificationStore = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/parent',
      accountId: 'parent',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const res = await mount(authStore, messageStore, {
      notificationStore,
      pushStore,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        inReplyTo: parentId,
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const listed = await notificationStore.listByRecipient('parent', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('');
  });

  it('returns 404 when inReplyTo is a nested reply', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    const res = await mount(await namedStore('Ada'), messageStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'nested', inReplyTo: childId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(await messageStore.listReplies(childId)).toHaveLength(0);
  });

  it('posts a photo-only message and serves the bytes', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      text: string;
      hasPhoto: boolean;
    };
    expect(created.text).toBe('');
    expect(created.hasPhoto).toBe(true);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: Array<{ hasPhoto: boolean }> };
    expect(body.messages[0]?.hasPhoto).toBe(true);

    const photo = await app.request(`/messages/${created.id}/photo`, { headers: AUTH });
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(photo.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('posts text together with a photo and serves both', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '  hello with photo  ',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      text: string;
      hasPhoto: boolean;
    };
    expect(created.text).toBe('hello with photo');
    expect(created.hasPhoto).toBe(true);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      messages: Array<{ id: string; text: string; hasPhoto: boolean }>;
    };
    expect(body.messages[0]).toMatchObject({
      id: created.id,
      text: 'hello with photo',
      hasPhoto: true,
      photoCount: 1,
    });

    const photo = await app.request(`/messages/${created.id}/photo`, { headers: AUTH });
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('keeps a civil capture time and stores junk as null', async () => {
    const auth = await namedStore('Ada');
    const post = async (body: unknown): Promise<Record<string, unknown>> => {
      const res = await mount(auth).request('/messages', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const kept = await post({
      text: 'kept',
      photo: {
        contentType: 'image/jpeg',
        data: JPEG_B64,
        takenAt: '2026-09-22T11:40:00+08:00',
      },
    });
    expect(kept['photoTakenAts']).toEqual(['2026-09-22T11:40:00+08:00']);
    expect(kept['photoTakenAt']).toBe('2026-09-22T11:40:00+08:00');
    for (const takenAt of ['2026-09-22T11:40:00Z', '2026-02-31T12:00:00', 20250607]) {
      const junk = await post({
        text: `junk-${String(takenAt)}`,
        photo: { contentType: 'image/jpeg', data: JPEG_B64, takenAt },
      });
      expect(junk['photoTakenAts']).toEqual([null]);
      expect(junk['photoTakenAt']).toBeNull();
    }
    const pair = await post({
      text: 'pair',
      photos: [
        {
          contentType: 'image/jpeg',
          data: JPEG_B64,
          takenAt: '2026-09-22T11:40:00+08:00',
        },
        { contentType: 'image/jpeg', data: JPEG2_B64, takenAt: null },
      ],
    });
    expect(pair['photoTakenAts']).toEqual(['2026-09-22T11:40:00+08:00', null]);
    expect(pair).not.toHaveProperty('photoTakenAt');
  });

  it('collapses a repeated photo+text post to the same id without 429', async () => {
    const limiter = new PostRateLimiter();
    const store = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore: await namedStore('Ada'),
        now,
        postLimiter: limiter,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const body = JSON.stringify({
      text: 'same caption',
      photo: { contentType: 'image/jpeg', data: JPEG_B64 },
    });
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { id: string; payable: boolean };
    expect(firstJson.payable).toBe(false);
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as Record<string, unknown>;
    expect(secondJson['id']).toBe(firstJson.id);
    expect(secondJson['payable']).toBe(false);
    expect(secondJson).not.toHaveProperty('contentFp');
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('collapses a repeated photos gallery post to the same id without 429', async () => {
    const limiter = new PostRateLimiter();
    const store = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore: await namedStore('Ada'),
        now,
        postLimiter: limiter,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const body = JSON.stringify({
      text: 'same caption',
      photos: [
        { contentType: 'image/jpeg', data: JPEG_B64 },
        { contentType: 'image/jpeg', data: JPEG2_B64 },
      ],
    });
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { id: string; payable: boolean };
    expect(firstJson.payable).toBe(false);
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as Record<string, unknown>;
    expect(secondJson['id']).toBe(firstJson.id);
    expect(secondJson['payable']).toBe(false);
    expect(secondJson).not.toHaveProperty('contentFp');
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('rejects a repeated photo when the place pin differs', async () => {
    const store = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore: await namedStore('Ada'),
        now,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'same caption',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'same caption',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
        place: { lat: 47.3, lng: 8.5, label: 'Stall' },
      }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'A live note with this media already exists' });
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('collapses onto a signed note as payable when the account has a Lightning Address', async () => {
    const store = new InMemoryMessageStore();
    const seeded = await store.create(
      {
        id: 'signed-collapse',
        accountId: 'acc',
        name: 'Ada',
        text: 'signed caption',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const eventId = 'ee'.repeat(32);
    expect(await store.updateSignedEvent(seeded.id, eventId, { id: eventId, kind: 1 })).toBe(true);
    const app = mount(await namedStore('Ada'), store);
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'signed caption',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; payable: boolean };
    expect(body.id).toBe(seeded.id);
    expect(body.payable).toBe(true);
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('creates a new row when the same photo has a different caption', async () => {
    let clock = now();
    const store = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore: await namedStore('Ada'),
        now: () => clock,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'caption-a',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { id: string }).id;
    clock += 11_000;
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'caption-b',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(second.status).toBe(200);
    const secondId = ((await second.json()) as { id: string }).id;
    expect(secondId).not.toBe(firstId);
    expect(await store.listLatest(10)).toHaveLength(2);
  });

  it('collapses a repeated reply photo to the same id with replyCount 1', async () => {
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = mount(await namedStore('Ada'), messageStore);
    const body = JSON.stringify({
      text: 'reply pic',
      inReplyTo: parentId,
      photo: { contentType: 'image/jpeg', data: JPEG_B64 },
    });
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { id: string }).id;
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { id: string; payable: boolean };
    expect(secondJson.id).toBe(firstId);
    expect(secondJson.payable).toBe(false);
    expect(await messageStore.listReplies(parentId)).toHaveLength(1);
    const listed = await messageStore.listLatest(10);
    expect(listed.find((row) => row.id === parentId)?.replyCount).toBe(1);
  });

  it('does not enqueue a second forum push on photo replay', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const body = JSON.stringify({
      text: 'push photo',
      photo: { contentType: 'image/jpeg', data: JPEG_B64 },
    });
    expect(
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(200);
    const claimed = await pushStore.claimPending(20, now() + 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe('forum');
  });

  it('pings spend once on a top-level post', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const res = await mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
  });

  it('does not ping spend on a reply', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await staffStore('Ada'), messageStore, { spendPing }).request(
      '/messages',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'child', inReplyTo: parentId }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('does not ping spend a second time on photo replay', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const app = mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    });
    const body = JSON.stringify({
      text: 'push photo',
      photo: { contentType: 'image/jpeg', data: JPEG_B64 },
    });
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const created = (await first.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    const second = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(created.id);
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
  });

  it('skips spend ping when the poster is not funding-eligible', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const gateNow = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
    const auth = await namedStore('Ada');
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: gateNow });
    const res = await mount(auth, new InMemoryMessageStore(), {
      spendPing,
      now: () => gateNow,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'not_eligible',
      ),
    ).toBe(true);
  });

  it('returns 200 on a top-level post when spendPing is omitted', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
  });

  it('still returns 200 when spendPing.ping throws', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string) => {
        throw new Error('ping boom');
      }),
    };
    const res = await mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('skips spend ping when a top-level post has no media', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const res = await mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'no_media',
      ),
    ).toBe(true);
  });

  it('pings spend once on a top-level post with extra stills only', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const res = await mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photos: [{ contentType: 'image/jpeg', data: JPEG_B64 }],
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
  });

  it('pings spend once on a multipart video top-level post', async () => {
    const spendPing = { ping: vi.fn(async (_address: string, _messageId: string) => undefined) };
    const mp4 = (): Uint8Array => {
      const bytes = new Uint8Array(32);
      bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
      return bytes;
    };
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    form.set('poster', new File([JPEG_BYTES], 'poster.jpg', { type: 'image/jpeg' }));
    const res = await mount(await staffStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
  });

  it('pings spend daily and welcome on a verified top-level JPEG', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const res = await mount(await namedStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(2);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'welcome');
  });

  it('does not welcome-ping spend on a verified text-only post', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const res = await mount(await namedStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.ping).not.toHaveBeenCalledWith(
      'ada@walletofsatoshi.com',
      expect.anything(),
      'welcome',
    );
  });

  it('welcome-pings an existing About-me photo when the new post is text', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const auth = await namedStore('Ada');
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    const photoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create(
      {
        id: photoId,
        accountId: 'acc',
        name: 'Ada',
        text: 'about',
        createdAt: new Date(now() - 1_000),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    await auth.updateAccount({ ...existing, profileMessageId: photoId });
    const res = await mount(auth, messageStore, { spendPing }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello again' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', photoId, 'welcome');
  });

  it('does not welcome-ping spend on a verified reply', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const messageStore = new InMemoryMessageStore();
    const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await messageStore.create({
      id: parentId,
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await namedStore('Ada'), messageStore, { spendPing }).request(
      '/messages',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'child',
          inReplyTo: parentId,
          photo: { contentType: 'image/jpeg', data: JPEG_B64 },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.ping).not.toHaveBeenCalledWith(
      'ada@walletofsatoshi.com',
      expect.anything(),
      'welcome',
    );
  });

  it('does not welcome-ping spend on a founder top-level JPEG', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const auth = await namedStore('Ada');
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...existing, role: 'founder' });
    const res = await mount(auth, new InMemoryMessageStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    expect(spendPing.ping).not.toHaveBeenCalledWith(
      'ada@walletofsatoshi.com',
      created.id,
      'welcome',
    );
  });

  it('welcome-pings spend when a verified poster is not funding-eligible', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => undefined),
    };
    const gateNow = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
    const auth = await namedStore('Ada');
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: gateNow });
    const res = await mount(auth, new InMemoryMessageStore(), {
      spendPing,
      now: () => gateNow,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'welcome');
    expect(spendPing.ping).not.toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'not_eligible',
      ),
    ).toBe(true);
  });

  it('still welcome-pings when the daily spend ping throws', async () => {
    const spendPing = {
      ping: vi.fn(async (_address: string, _messageId: string, _kind?: string) => {
        throw new Error('ping boom');
      }),
    };
    const res = await mount(await namedStore('Ada'), new InMemoryMessageStore(), {
      spendPing,
    }).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(2);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'welcome');
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('returns 503 when findLiveByAccountContent throws', async () => {
    const base = new InMemoryMessageStore();
    const store: MessageStore = {
      ...base,
      listLatest: (limit) => base.listLatest(limit),
      listFeed: (query) => base.listFeed(query),
      listDebug: (limit) => base.listDebug(limit),
      postCountsByUtcDay: () => base.postCountsByUtcDay(),
      listHidden: (limit) => base.listHidden(limit),
      listIdsByPrefix: (prefix) => base.listIdsByPrefix(prefix),
      listPlaces: (limit) => base.listPlaces(limit),
      listDirectChildren: (parentId) => base.listDirectChildren(parentId),
      listChildIds: (parentId) => base.listChildIds(parentId),
      listReplies: (parentId, limit, includeHidden) =>
        base.listReplies(parentId, limit, includeHidden),
      create: (row, photo, video) => base.create(row, photo, video),
      findLiveByAccountContent: async () => {
        throw new Error('find boom');
      },
      accountHasLivePost: (accountId, excludeId) => base.accountHasLivePost(accountId, excludeId),
      accountHasLiveTopLevelPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelPost(accountId, excludeId),
      accountHasLiveTopLevelMediaPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelMediaPost(accountId, excludeId),
      latestLiveTopLevelMediaId: (accountId) => base.latestLiveTopLevelMediaId(accountId),
      countByAccount: (accountId) => base.countByAccount(accountId),
      countAttributedReplies: (parentId) => base.countAttributedReplies(parentId),
      listPostsByAccount: (accountId, limit) => base.listPostsByAccount(accountId, limit),
      listRepliesByAccount: (accountId, limit) => base.listRepliesByAccount(accountId, limit),
      getPhoto: (id) => base.getPhoto(id),
      getExtraPhoto: (id, index) => base.getExtraPhoto(id, index),
      listExtraPhotos: (id) => base.listExtraPhotos(id),
      deleteById: (id) => base.deleteById(id),
      markDeleted: (id, at, by) => base.markDeleted(id, at, by),
      markUndeleted: (id) => base.markUndeleted(id),
      getById: (id) => base.getById(id),
      getByEventId: (eventId) => base.getByEventId(eventId),
      listPublishedEventIds: (limit) => base.listPublishedEventIds(limit),
      claimUnsigned: (limit, nowMs, leaseMs) => base.claimUnsigned(limit, nowMs, leaseMs),
      claimUnpublished: (limit, nowMs, leaseMs) => base.claimUnpublished(limit, nowMs, leaseMs),
      listPendingSigned: (limit) => base.listPendingSigned(limit),
      clearSignedEvent: (id, expected) => base.clearSignedEvent(id, expected),
      listSignedMissingPhoto: (limit) => base.listSignedMissingPhoto(limit),
      listSignedMissingVideo: (limit) => base.listSignedMissingVideo(limit),
      listSignedMissingHashtags: (limit) => base.listSignedMissingHashtags(limit),
      resetSignedEvent: (id, expected) => base.resetSignedEvent(id, expected),
      updateText: (id, text) => base.updateText(id, text),
      updatePhoto: (id, photo) => base.updatePhoto(id, photo),
      updateSignedEvent: (id, eventId, nostrEvent) =>
        base.updateSignedEvent(id, eventId, nostrEvent),
      updatePublishState: (id, state, epoch) => base.updatePublishState(id, state, epoch),
      addSats: (id, extra, delta) => base.addSats(id, extra, delta),
      claimZapPayment: (hash, receiptId, at) => base.claimZapPayment(hash, receiptId, at),
      recordZapReceipt: (receiptId, messageId, sats, delta) =>
        base.recordZapReceipt(receiptId, messageId, sats, delta),
      recordInvoiceAttempt: (row) => base.recordInvoiceAttempt(row),
      listInvoiceAttempts: (limit) => base.listInvoiceAttempts(limit),
      listRecentOkInvoiceAttempts: (since, limit) => base.listRecentOkInvoiceAttempts(since, limit),
      recordZapIngest: (row) => base.recordZapIngest(row),
      listZapIngests: (limit) => base.listZapIngests(limit),
      findOkInvoiceByPaymentHash: (hash) => base.findOkInvoiceByPaymentHash(hash),
      findOkInvoiceByPr: (pr) => base.findOkInvoiceByPr(pr),
      updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
        base.updateZapReceiptGift(...args),
      getZapReceiptGift: (id) => base.getZapReceiptGift(id),
      listZapReceiptsAwaitingGiftReply: (limit) => base.listZapReceiptsAwaitingGiftReply(limit),
      listInvoiceAttemptsForPayer: (payerAccountId) =>
        base.listInvoiceAttemptsForPayer(payerAccountId),
      listIndexedZapIngests: () => base.listIndexedZapIngests(),
      listAuthoredMessages: (accountId) => base.listAuthoredMessages(accountId),
      listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
      attributeZapReceipt: (receiptEventId, attribution) =>
        base.attributeZapReceipt(receiptEventId, attribution),
      recordZapper: (pubkey, receiptEventId, at) => base.recordZapper(pubkey, receiptEventId, at),
      listZapperPubkeys: () => base.listZapperPubkeys(),
      listZappers: (limit) => base.listZappers(limit),
      blockPubkeyAndHideRows: (pubkey, at, byAccountId, messageId) =>
        base.blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId),
      unblockPubkeyByMessage: (messageId) => base.unblockPubkeyByMessage(messageId),
      isPubkeyBlocked: (pubkey) => base.isPubkeyBlocked(pubkey),
      isZapperPubkey: (pubkey) => base.isZapperPubkey(pubkey),
      listBlockedPubkeys: () => base.listBlockedPubkeys(),
      listBlockedPubkeyRows: (limit) => base.listBlockedPubkeyRows(limit),
      listUnattributedIndexedReceipts: (limit, before) =>
        base.listUnattributedIndexedReceipts(limit, before),
    };
    const res = await mount(await namedStore('Ada'), store).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'x',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(503);
  });

  it('skips push when create collapses to an existing id', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const existing = {
      id: 'existing-collapsed',
      accountId: 'acc',
      name: 'Ada',
      text: 'x',
      createdAt: new Date(now()),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    const base = new InMemoryMessageStore();
    const store: MessageStore = {
      ...base,
      listLatest: (limit) => base.listLatest(limit),
      listFeed: (query) => base.listFeed(query),
      listDebug: (limit) => base.listDebug(limit),
      postCountsByUtcDay: () => base.postCountsByUtcDay(),
      listHidden: (limit) => base.listHidden(limit),
      listIdsByPrefix: (prefix) => base.listIdsByPrefix(prefix),
      listPlaces: (limit) => base.listPlaces(limit),
      listDirectChildren: (parentId) => base.listDirectChildren(parentId),
      listChildIds: (parentId) => base.listChildIds(parentId),
      listReplies: (parentId, limit, includeHidden) =>
        base.listReplies(parentId, limit, includeHidden),
      findLiveByAccountContent: async () => undefined,
      accountHasLivePost: (accountId, excludeId) => base.accountHasLivePost(accountId, excludeId),
      accountHasLiveTopLevelPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelPost(accountId, excludeId),
      accountHasLiveTopLevelMediaPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelMediaPost(accountId, excludeId),
      latestLiveTopLevelMediaId: (accountId) => base.latestLiveTopLevelMediaId(accountId),
      countByAccount: (accountId) => base.countByAccount(accountId),
      countAttributedReplies: (parentId) => base.countAttributedReplies(parentId),
      listPostsByAccount: (accountId, limit) => base.listPostsByAccount(accountId, limit),
      listRepliesByAccount: (accountId, limit) => base.listRepliesByAccount(accountId, limit),
      create: async () => ({ ...existing, createdAt: new Date(existing.createdAt.getTime()) }),
      getPhoto: (id) => base.getPhoto(id),
      getExtraPhoto: (id, index) => base.getExtraPhoto(id, index),
      listExtraPhotos: (id) => base.listExtraPhotos(id),
      deleteById: (id) => base.deleteById(id),
      markDeleted: (id, at, by) => base.markDeleted(id, at, by),
      markUndeleted: (id) => base.markUndeleted(id),
      getById: (id) => base.getById(id),
      getByEventId: (eventId) => base.getByEventId(eventId),
      listPublishedEventIds: (limit) => base.listPublishedEventIds(limit),
      claimUnsigned: (limit, nowMs, leaseMs) => base.claimUnsigned(limit, nowMs, leaseMs),
      claimUnpublished: (limit, nowMs, leaseMs) => base.claimUnpublished(limit, nowMs, leaseMs),
      listPendingSigned: (limit) => base.listPendingSigned(limit),
      clearSignedEvent: (id, expected) => base.clearSignedEvent(id, expected),
      listSignedMissingPhoto: (limit) => base.listSignedMissingPhoto(limit),
      listSignedMissingVideo: (limit) => base.listSignedMissingVideo(limit),
      listSignedMissingHashtags: (limit) => base.listSignedMissingHashtags(limit),
      resetSignedEvent: (id, expected) => base.resetSignedEvent(id, expected),
      updateText: (id, text) => base.updateText(id, text),
      updatePhoto: (id, photo) => base.updatePhoto(id, photo),
      updateSignedEvent: (id, eventId, nostrEvent) =>
        base.updateSignedEvent(id, eventId, nostrEvent),
      updatePublishState: (id, state, epoch) => base.updatePublishState(id, state, epoch),
      addSats: (id, extra, delta) => base.addSats(id, extra, delta),
      claimZapPayment: (hash, receiptId, at) => base.claimZapPayment(hash, receiptId, at),
      recordZapReceipt: (receiptId, messageId, sats, delta) =>
        base.recordZapReceipt(receiptId, messageId, sats, delta),
      recordInvoiceAttempt: (row) => base.recordInvoiceAttempt(row),
      listInvoiceAttempts: (limit) => base.listInvoiceAttempts(limit),
      listRecentOkInvoiceAttempts: (since, limit) => base.listRecentOkInvoiceAttempts(since, limit),
      recordZapIngest: (row) => base.recordZapIngest(row),
      listZapIngests: (limit) => base.listZapIngests(limit),
      findOkInvoiceByPaymentHash: (hash) => base.findOkInvoiceByPaymentHash(hash),
      findOkInvoiceByPr: (pr) => base.findOkInvoiceByPr(pr),
      updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
        base.updateZapReceiptGift(...args),
      getZapReceiptGift: (id) => base.getZapReceiptGift(id),
      listZapReceiptsAwaitingGiftReply: (limit) => base.listZapReceiptsAwaitingGiftReply(limit),
      listInvoiceAttemptsForPayer: (payerAccountId) =>
        base.listInvoiceAttemptsForPayer(payerAccountId),
      listIndexedZapIngests: () => base.listIndexedZapIngests(),
      listAuthoredMessages: (accountId) => base.listAuthoredMessages(accountId),
      listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
      attributeZapReceipt: (receiptEventId, attribution) =>
        base.attributeZapReceipt(receiptEventId, attribution),
      recordZapper: (pubkey, receiptEventId, at) => base.recordZapper(pubkey, receiptEventId, at),
      listZapperPubkeys: () => base.listZapperPubkeys(),
      listZappers: (limit) => base.listZappers(limit),
      blockPubkeyAndHideRows: (pubkey, at, byAccountId, messageId) =>
        base.blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId),
      unblockPubkeyByMessage: (messageId) => base.unblockPubkeyByMessage(messageId),
      isPubkeyBlocked: (pubkey) => base.isPubkeyBlocked(pubkey),
      isZapperPubkey: (pubkey) => base.isZapperPubkey(pubkey),
      listBlockedPubkeys: () => base.listBlockedPubkeys(),
      listBlockedPubkeyRows: (limit) => base.listBlockedPubkeyRows(limit),
      listUnattributedIndexedReceipts: (limit, before) =>
        base.listUnattributedIndexedReceipts(limit, before),
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'x',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('existing-collapsed');
    expect(await pushStore.claimPending(20, now() + 1, 60_000)).toHaveLength(0);
  });

  it('rejects a bad photo payload', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: {
          contentType: 'image/gif',
          data: Buffer.from([0x47, 0x49, 0x46, 0x38]).toString('base64'),
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB',
    });
  });

  it('posts a singular photo with photoCount 1 and no extra still', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as { id: string; hasPhoto: boolean; photoCount: number };
    expect(created.hasPhoto).toBe(true);
    expect(created.photoCount).toBe(1);
    const extra = await app.request(`/messages/${created.id}/photo/1.jpg`);
    expect(extra.status).toBe(404);
    expect(await extra.json()).toEqual({ error: 'Photo not found' });
  });

  it('posts a photos gallery of two stills and serves index 0 and 1', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: [
          { contentType: 'image/jpeg', data: JPEG_B64 },
          { contentType: 'image/jpeg', data: JPEG2_B64 },
        ],
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as { id: string; hasPhoto: boolean; photoCount: number };
    expect(created.photoCount).toBe(2);
    expect(created.hasPhoto).toBe(true);
    const photo0 = await app.request(`/messages/${created.id}/photo.jpg`);
    expect(photo0.status).toBe(200);
    expect(new Uint8Array(await photo0.arrayBuffer())).toEqual(JPEG_BYTES);
    const photo1 = await app.request(`/messages/${created.id}/photo/1.jpg`);
    expect(photo1.status).toBe(200);
    expect(new Uint8Array(await photo1.arrayBuffer())).toEqual(JPEG2_BYTES);
  });

  it('uses photos over singular photo when both are sent', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
        photos: [
          { contentType: 'image/jpeg', data: JPEG2_B64 },
          { contentType: 'image/jpeg', data: JPEG3_B64 },
        ],
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as { id: string; photoCount: number };
    expect(created.photoCount).toBe(2);
    const photo0 = await app.request(`/messages/${created.id}/photo`);
    expect(photo0.status).toBe(200);
    expect(new Uint8Array(await photo0.arrayBuffer())).toEqual(JPEG2_BYTES);
    const photo1 = await app.request(`/messages/${created.id}/photo/1.jpg`);
    expect(photo1.status).toBe(200);
    expect(new Uint8Array(await photo1.arrayBuffer())).toEqual(JPEG3_BYTES);
  });

  it('rejects more than 10 photos before decode', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: Array.from({ length: 11 }, () => ({ contentType: 'image/jpeg', data: 'x' })),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'At most 10 photos' });
  });

  it('rejects an invalid gallery item in photos', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: [
          {
            contentType: 'image/gif',
            data: Buffer.from([0x47, 0x49, 0x46, 0x38]).toString('base64'),
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB',
    });
  });

  it('returns 409 when a raced create reports a conflicting place', async () => {
    const res = await mount(
      await namedStore('Ada'),
      throwingStore({
        findLiveByAccountContent: async () => undefined,
        create: async () => {
          throw new Error('place conflicts with live media');
        },
      }),
    ).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'same caption',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A live note with this media already exists' });
  });

  it('returns 503 when create throws a non-error', async () => {
    const res = await mount(
      await namedStore('Ada'),
      throwingStore({
        create: async () => {
          throw 'boom';
        },
      }),
    ).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 503 and logs when create throws', async () => {
    const res = await mount(
      await namedStore('Ada'),
      throwingStore({
        listLatest: async () => [],
        listFeed: async () => [],
      }),
    ).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.create.failed')).toBe(true);
  });
});

describe('POST /messages/:id/invoice', () => {
  it('returns 409 when the payer has not agreed to rules', async () => {
    const res = await mount(await seededStore()).request(
      '/messages/11111111-1111-4111-8111-111111111111/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 400 not 409 lightning-address when the note is unsigned', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/11111111-1111-4111-8111-111111111111/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
  });

  it('returns 429 on a burst of invoice requests', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '55555555-5555-4555-8555-555555555555',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages/55555555-5555-4555-8555-555555555555/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    await withNip57True(async () => {
      expect(await hit()).toBe(200);
    });
    expect(await hit()).toBe(429);
  });

  it('does not consume the invoice limiter on a missing id', async () => {
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages/00000000-0000-4000-8000-000000000001/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    expect(await hit()).toBe(404);
    expect(await hit()).toBe(404);
  });

  it('does not consume the invoice limiter on an unpayable note', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '66666666-6666-4666-8666-666666666666',
      accountId: 'acc',
      name: 'Ada',
      text: 'unsigned',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '77777777-7777-4777-8777-777777777777',
      accountId: 'acc',
      name: 'Ada',
      text: 'payable',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (id: string): Promise<number> =>
      (
        await app.request(`/messages/${id}/invoice`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    expect(await hit('66666666-6666-4666-8666-666666666666')).toBe(400);
    expect(await hit('66666666-6666-4666-8666-666666666666')).toBe(400);
    await withNip57True(async () => {
      expect(await hit('77777777-7777-4777-8777-777777777777')).toBe(200);
    });
  });

  it('returns 400 for a non-integer sats body', async () => {
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 and persists bad_body when sats exceed 10 million', async () => {
    const messageStore = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 10_000_001 }),
    });
    expect(res.status).toBe(400);
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('bad_body');
    expect(attempts[0]?.httpStatus).toBe(400);
    expect(attempts[0]?.pr).toBeNull();
  });

  it('returns 400 when invoice text is too long', async () => {
    const messageStore = new InMemoryMessageStore();
    const app = mount(await namedStore('Ada'), messageStore);
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21, text: 'A'.repeat(MESSAGE_MAX_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` });
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts[0]?.result).toBe('bad_body');
  });

  it('stores the fiat shown with the invoice even when the text is rejected', async () => {
    const messageStore = new InMemoryMessageStore();
    const app = mount(await namedStore('Ada'), messageStore);
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        sats: 21,
        text: 'A'.repeat(MESSAGE_MAX_LENGTH + 1),
        amountUsd: '5.00',
        amountChf: '4.00',
        amountEur: '4.50',
        amountPhp: '280.00',
      }),
    });
    expect(res.status).toBe(400);
    const attempt = (await messageStore.listInvoiceAttempts(1))[0];
    expect(attempt?.result).toBe('bad_body');
    expect(attempt?.fiatPinned).toBe(true);
    expect(attempt?.amountUsd).toBe('5.00');
    expect(attempt?.amountChf).toBe('4.00');
    expect(attempt?.amountEur).toBe('4.50');
    expect(attempt?.amountPhp).toBe('280.00');
  });

  it('rejects a shown amount that is not a fiat string', async () => {
    const messageStore = new InMemoryMessageStore();
    const app = mount(await namedStore('Ada'), messageStore);
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21, amountUsd: 'nope' }),
    });
    expect(res.status).toBe(400);
    const attempt = (await messageStore.listInvoiceAttempts(1))[0];
    expect(attempt?.result).toBe('bad_body');
    expect(attempt?.fiatPinned).toBe(false);
    expect(attempt?.amountUsd).toBeNull();
  });

  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages/m1/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 without a KEK', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await authStore.setNostrKeyIfAbsent('acc', {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '88888888-8888-4888-8888-888888888888',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/88888888-8888-4888-8888-888888888888/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(503);
  });

  it('issues a zap invoice when the note is payable', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const prevPublishPublic = process.env['NOSTR_PUBLISH_PUBLIC'];
    delete process.env['NOSTR_PUBLISH_PUBLIC'];
    let callbackUrl: string | undefined;
    try {
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('/.well-known/lnurlp/')) {
          return new Response(
            JSON.stringify({
              callback: 'https://walletofsatoshi.com/lnurlp/callback',
              minSendable: 1000,
              maxSendable: 10_000_000_000,
              allowsNostr: true,
              nostrPubkey: 'aa'.repeat(32),
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        callbackUrl = url;
        return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      await withNip57True(async () => {
        const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
        expect(callbackUrl).toBeDefined();
        const nostrParam = new URL(callbackUrl ?? '').searchParams.get('nostr');
        expect(nostrParam).toBeTruthy();
        const zapRequest = JSON.parse(nostrParam ?? '') as { tags: string[][] };
        const relaysTag = zapRequest.tags.find((tag) => tag[0] === 'relays');
        expect(relaysTag).toBeDefined();
        expect(relaysTag?.slice(1)).toContain('wss://relay.damus.io');
      });
    } finally {
      if (prevPublishPublic === undefined) {
        delete process.env['NOSTR_PUBLISH_PUBLIC'];
      } else {
        process.env['NOSTR_PUBLISH_PUBLIC'] = prevPublishPublic;
      }
    }
  });

  it('issues a zap invoice when a signed reply is payable', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    const parentId = '11111111-1111-4111-8111-111111111111';
    const replyId = '12121212-1212-4121-8121-121212121212';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    await messageStore.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'ee'.repeat(32),
    });
    const prevPublishPublic = process.env['NOSTR_PUBLISH_PUBLIC'];
    delete process.env['NOSTR_PUBLISH_PUBLIC'];
    let callbackUrl: string | undefined;
    try {
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('/.well-known/lnurlp/')) {
          return new Response(
            JSON.stringify({
              callback: 'https://walletofsatoshi.com/lnurlp/callback',
              minSendable: 1000,
              maxSendable: 10_000_000_000,
              allowsNostr: true,
              nostrPubkey: 'aa'.repeat(32),
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        callbackUrl = url;
        return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      await withNip57True(async () => {
        const res = await app.request(`/messages/${replyId}/invoice`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
        expect(callbackUrl).toBeDefined();
        const nostrParam = new URL(callbackUrl ?? '').searchParams.get('nostr');
        expect(nostrParam).toBeTruthy();
        const zapRequest = JSON.parse(nostrParam ?? '') as { tags: string[][] };
        const relaysTag = zapRequest.tags.find((tag) => tag[0] === 'relays');
        expect(relaysTag).toBeDefined();
        expect(relaysTag?.slice(1)).toContain('wss://relay.damus.io');
      });
    } finally {
      if (prevPublishPublic === undefined) {
        delete process.env['NOSTR_PUBLISH_PUBLIC'];
      } else {
        process.env['NOSTR_PUBLISH_PUBLIC'] = prevPublishPublic;
      }
    }
  });

  it('ensures a Nostr key for a payer who has none yet', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    await authStore.createAccount({
      id: 'payer',
      linkingKey: `02${'b'.repeat(64)}`,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    await authStore.createSession({ token: 'payer-tok', accountId: 'payer', createdAt: now() });
    expect(await authStore.getNostrPublicKey('payer')).toBeUndefined();
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '44444444-4444-4444-8444-444444444444',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    await withNip57True(async () => {
      const res = await app.request('/messages/44444444-4444-4444-8444-444444444444/invoice', {
        method: 'POST',
        headers: {
          authorization: 'Bearer payer-tok',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
      expect(await authStore.getNostrPublicKey('payer')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('returns 400 when the note is unsigned', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '22222222-2222-4222-8222-222222222222',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/22222222-2222-4222-8222-222222222222/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 no_author when the live author has no Lightning Address', async () => {
    const authStore = await rulesStore({ name: 'Ada' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/33333333-3333-4333-8333-333333333333/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_author');
    expect(attempts[0]?.httpStatus).toBe(400);
    expect(attempts[0]?.pr).toBeNull();
  });

  it('returns 400 no_author when a signed reply author Lightning Address is whitespace', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: '   ',
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = '11111111-1111-4111-8111-111111111111';
    const replyId = '12121212-1212-4121-8121-121212121212';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    await messageStore.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = vi.fn(async (_input: string | URL | Request): Promise<Response> => {
      throw new Error('lnurl must not run');
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: new Uint8Array(32).fill(1),
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/messages/${replyId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_author');
    expect(attempts[0]?.httpStatus).toBe(400);
    expect(attempts[0]?.pr).toBeNull();
  });

  it('returns 404 for an unknown message', async () => {
    const authStore = await namedStore('Ada');
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/00000000-0000-4000-8000-000000000001/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 no_author when invoicing a Damus-only reply', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '14141414-1414-4141-8141-141414141414',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '13131313-1313-4131-8131-131313131313',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '14141414-1414-4141-8141-141414141414',
      authorPubkey: 'ab'.repeat(32),
      eventId: 'ee'.repeat(32),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/13131313-1313-4131-8131-131313131313/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_author');
    expect(attempts[0]?.httpStatus).toBe(400);
    expect(attempts[0]?.pr).toBeNull();
  });

  it('returns 400 no_author when invoicing a top-level Damus-only note', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '16161616-1616-4161-8161-161616161616',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ab'.repeat(32),
      eventId: 'ee'.repeat(32),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/16161616-1616-4161-8161-161616161616/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_author');
    expect(attempts[0]?.httpStatus).toBe(400);
    expect(attempts[0]?.authorAccountId).toBe('acc');
    expect(attempts[0]?.pr).toBeNull();
  });

  it('persists an ok invoice attempt with pr and isNip57Invoice from inspect', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: 'bb'.repeat(32),
      expirySeconds: 86400,
    });
    const nip57Spy = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.result).toBe('ok');
      expect(attempts[0]?.isNip57Invoice).toBe(true);
      expect(attempts[0]?.httpStatus).toBe(200);
      expect(attempts[0]?.pr).toBe('lnbc21n1test');
      expect(attempts[0]?.paymentHash).toBe('aa'.repeat(32));
      expect(attempts[0]?.descriptionHash).toBe('bb'.repeat(32));
      expect(attempts[0]?.zapRequest).not.toBeNull();
    } finally {
      inspectSpy.mockRestore();
      nip57Spy.mockRestore();
    }
  });

  it('persists not_zap when LNURL returns a non-NIP-57 invoice', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '99999999-9999-4999-8999-999999999999',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: 'Wallet of Satoshi',
      descriptionHash: null,
      expirySeconds: 86400,
    });
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/99999999-9999-4999-8999-999999999999/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        error: "The author's wallet cannot receive this Bitcoin payment",
      });
      expect(body).not.toHaveProperty('pr');
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.result).toBe('not_zap');
      expect(attempts[0]?.httpStatus).toBe(400);
      expect(attempts[0]?.pr).toBe('lnbc21n1test');
      expect(attempts[0]?.isNip57Invoice).toBe(false);
      expect(attempts[0]?.description).toBe('Wallet of Satoshi');
      expect(attempts[0]?.descriptionHash).toBeNull();
      expect(attempts[0]?.paymentHash).toBe('aa'.repeat(32));
      expect(attempts[0]?.zapRequest).not.toBeNull();
    } finally {
      inspectSpy.mockRestore();
    }
  });

  it('persists not_zap when inspectBolt11 cannot decode the invoice', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '12121212-1212-4121-8121-121212121212',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/12121212-1212-4121-8121-121212121212/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    expect(body).not.toHaveProperty('pr');
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('not_zap');
    expect(attempts[0]?.pr).toBe('lnbc21n1test');
    expect(attempts[0]?.paymentHash).toBeNull();
    expect(attempts[0]?.description).toBeNull();
    expect(attempts[0]?.descriptionHash).toBeNull();
    expect(attempts[0]?.isNip57Invoice).toBe(false);
  });

  it('persists noZap and unreachable with pr null and http 400', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const noZapFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 500 });
    };
    const appNoZap = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl: noZapFetch,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const noZapRes = await appNoZap.request(
      '/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(noZapRes.status).toBe(400);
    expect(await noZapRes.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    expect((await messageStore.listInvoiceAttempts(1))[0]?.result).toBe('noZap');
    expect((await messageStore.listInvoiceAttempts(1))[0]?.pr).toBeNull();
    expect((await messageStore.listInvoiceAttempts(1))[0]?.httpStatus).toBe(400);

    const unreachableFetch = async (): Promise<Response> => new Response('{}', { status: 500 });
    const appUnreachable = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl: unreachableFetch,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const unreachableRes = await appUnreachable.request(
      '/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(unreachableRes.status).toBe(400);
    expect(await unreachableRes.json()).toEqual({
      error: 'Could not start the Bitcoin payment',
    });
    const attempts = await messageStore.listInvoiceAttempts(2);
    expect(attempts.some((row) => row.result === 'unreachable')).toBe(true);
    expect(attempts.find((row) => row.result === 'unreachable')?.pr).toBeNull();
  });

  it('returns 404 for a non-uuid invoice id without persisting', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/not-a-uuid/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(404);
    expect(await messageStore.listInvoiceAttempts(10)).toHaveLength(0);
  });

  it('persists no_event when the note eventId is empty', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'abababab-abab-4bab-8bab-abababababab',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: '',
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/abababab-abab-4bab-8bab-abababababab/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_event');
    expect(attempts[0]?.httpStatus).toBe(400);
  });

  it('persists no_event when the note has no eventId', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/cccccccc-cccc-4ccc-8ccc-cccccccccccc/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_event');
    expect(attempts[0]?.httpStatus).toBe(400);
  });

  it('still returns 200 when recordInvoiceAttempt throws after LNURL ok', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const base = new InMemoryMessageStore();
    await base.create({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const store: MessageStore = {
      listLatest: (limit) => base.listLatest(limit),
      listFeed: (query) => base.listFeed(query),
      listDebug: (limit) => base.listDebug(limit),
      postCountsByUtcDay: () => base.postCountsByUtcDay(),
      listHidden: (limit) => base.listHidden(limit),
      listIdsByPrefix: (prefix) => base.listIdsByPrefix(prefix),
      listPlaces: (limit) => base.listPlaces(limit),
      listDirectChildren: (parentId) => base.listDirectChildren(parentId),
      listChildIds: (parentId) => base.listChildIds(parentId),
      listReplies: (parentId, limit, includeHidden) =>
        base.listReplies(parentId, limit, includeHidden),
      listPublishedEventIds: (limit) => base.listPublishedEventIds(limit),
      create: (row, photo) => base.create(row, photo),
      findLiveByAccountContent: (...args) => base.findLiveByAccountContent(...args),
      accountHasLivePost: (accountId, excludeId) => base.accountHasLivePost(accountId, excludeId),
      accountHasLiveTopLevelPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelPost(accountId, excludeId),
      accountHasLiveTopLevelMediaPost: (accountId, excludeId) =>
        base.accountHasLiveTopLevelMediaPost(accountId, excludeId),
      latestLiveTopLevelMediaId: (accountId) => base.latestLiveTopLevelMediaId(accountId),
      countByAccount: (accountId) => base.countByAccount(accountId),
      countAttributedReplies: (parentId) => base.countAttributedReplies(parentId),
      listPostsByAccount: (accountId, limit) => base.listPostsByAccount(accountId, limit),
      listRepliesByAccount: (accountId, limit) => base.listRepliesByAccount(accountId, limit),
      getPhoto: (id) => base.getPhoto(id),
      getExtraPhoto: (id, index) => base.getExtraPhoto(id, index),
      listExtraPhotos: (id) => base.listExtraPhotos(id),
      getById: (id) => base.getById(id),
      deleteById: (id) => base.deleteById(id),
      markDeleted: (id, at, by) => base.markDeleted(id, at, by),
      markUndeleted: (id) => base.markUndeleted(id),
      getByEventId: (id) => base.getByEventId(id),
      claimUnsigned: (...args) => base.claimUnsigned(...args),
      claimUnpublished: (...args) => base.claimUnpublished(...args),
      listPendingSigned: (limit) => base.listPendingSigned(limit),
      listSignedMissingPhoto: (limit) => base.listSignedMissingPhoto(limit),
      listSignedMissingVideo: (limit) => base.listSignedMissingVideo(limit),
      listSignedMissingHashtags: (limit) => base.listSignedMissingHashtags(limit),
      clearSignedEvent: (...args) => base.clearSignedEvent(...args),
      resetSignedEvent: (...args) => base.resetSignedEvent(...args),
      updateText: (...args) => base.updateText(...args),
      updatePhoto: (...args) => base.updatePhoto(...args),
      updateSignedEvent: (...args) => base.updateSignedEvent(...args),
      updatePublishState: (...args) => base.updatePublishState(...args),
      addSats: (...args) => base.addSats(...args),
      claimZapPayment: (...args) => base.claimZapPayment(...args),
      recordZapReceipt: (...args) => base.recordZapReceipt(...args),
      recordInvoiceAttempt: async () => {
        throw new Error('persist boom');
      },
      listInvoiceAttempts: (limit) => base.listInvoiceAttempts(limit),
      listRecentOkInvoiceAttempts: (since, limit) => base.listRecentOkInvoiceAttempts(since, limit),
      recordZapIngest: (row) => base.recordZapIngest(row),
      listZapIngests: (limit) => base.listZapIngests(limit),
      findOkInvoiceByPaymentHash: (hash) => base.findOkInvoiceByPaymentHash(hash),
      findOkInvoiceByPr: (pr) => base.findOkInvoiceByPr(pr),
      updateZapReceiptGift: (...args: Parameters<InMemoryMessageStore['updateZapReceiptGift']>) =>
        base.updateZapReceiptGift(...args),
      getZapReceiptGift: (id) => base.getZapReceiptGift(id),
      listZapReceiptsAwaitingGiftReply: (limit) => base.listZapReceiptsAwaitingGiftReply(limit),
      listInvoiceAttemptsForPayer: (payerAccountId) =>
        base.listInvoiceAttemptsForPayer(payerAccountId),
      listIndexedZapIngests: () => base.listIndexedZapIngests(),
      listAuthoredMessages: (accountId) => base.listAuthoredMessages(accountId),
      listOpenConversationZapEventIds: () => base.listOpenConversationZapEventIds(),
      attributeZapReceipt: (receiptEventId, attribution) =>
        base.attributeZapReceipt(receiptEventId, attribution),
      recordZapper: (pubkey, receiptEventId, at) => base.recordZapper(pubkey, receiptEventId, at),
      listZapperPubkeys: () => base.listZapperPubkeys(),
      listZappers: (limit) => base.listZappers(limit),
      blockPubkeyAndHideRows: (pubkey, at, byAccountId, messageId) =>
        base.blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId),
      unblockPubkeyByMessage: (messageId) => base.unblockPubkeyByMessage(messageId),
      isPubkeyBlocked: (pubkey) => base.isPubkeyBlocked(pubkey),
      isZapperPubkey: (pubkey) => base.isZapperPubkey(pubkey),
      listBlockedPubkeys: () => base.listBlockedPubkeys(),
      listBlockedPubkeyRows: (limit) => base.listBlockedPubkeyRows(limit),
      listUnattributedIndexedReceipts: (limit, before) =>
        base.listUnattributedIndexedReceipts(limit, before),
    };
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    await withNip57True(async () => {
      const res = await app.request('/messages/dddddddd-dddd-4ddd-8ddd-dddddddddddd/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
      expect(parsedEvents(warn).some((e) => e['event'] === 'message.invoice.record_failed')).toBe(
        true,
      );
    });
  });

  it('persists sign_failed when signing throws', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const signMod = await import('@/lib/nostr/sign');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const spy = vi.spyOn(signMod, 'signEventForAccount').mockRejectedValue(new Error('sign boom'));
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(503);
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts[0]?.result).toBe('sign_failed');
      expect(attempts[0]?.httpStatus).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it('persists ok path with null zapRequest when the signed event is not an object', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const signMod = await import('@/lib/nostr/sign');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const spy = vi
      .spyOn(signMod, 'signEventForAccount')
      .mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof signMod.signEventForAccount>>,
      );
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 100000000000,
            allowsNostr: true,
            nostrPubkey: 'be1d89794bf92de5dd64c1e60f6a2c70c140abac9932418fee30c5c637fe9479',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), { status: 200 });
    };
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      await withNip57True(async () => {
        const res = await app.request('/messages/ffffffff-ffff-4fff-8fff-ffffffffffff/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        });
        expect(res.status).toBe(200);
        const attempts = await messageStore.listInvoiceAttempts(10);
        expect(attempts[0]?.result).toBe('ok');
        expect(attempts[0]?.zapRequest).toBeNull();
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /messages/places', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages/places');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 409 when rules are not agreed', async () => {
    const res = await mount(await seededStore()).request('/messages/places', { headers: AUTH });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'missing_requirements', missing: ['rules'] });
  });

  it('lists live top-level pins and excludes replies, hidden notes, and rows with no place', async () => {
    const hiddenAt = new Date('2026-09-01T00:00:00.000Z');
    const same = new Date('2026-08-03T00:00:00.000Z');
    const store = new InMemoryMessageStore([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        accountId: 'acc',
        name: 'Ada',
        text: 'pin',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        place: { lat: 1, lng: 2, label: null },
      },
      {
        id: 'plain',
        accountId: 'acc',
        name: 'Ada',
        text: 'plain',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      {
        id: 'reply',
        accountId: 'acc',
        name: 'Ada',
        text: 'reply',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        parentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        place: { lat: 3, lng: 4, label: 'reply' },
      },
      {
        id: 'hidden',
        accountId: 'acc',
        name: 'Ada',
        text: 'hidden',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        deletedAt: hiddenAt,
        deletedBy: 'staff',
        place: { lat: 5, lng: 6, label: 'hid' },
      },
      {
        id: 'za',
        accountId: 'acc',
        name: 'Ada',
        text: 'za',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        place: { lat: 7, lng: 8, label: 'A' },
      },
      {
        id: 'zb',
        accountId: 'acc',
        name: 'Ada',
        text: 'zb',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        place: { lat: 9, lng: 10, label: 'B' },
      },
    ]);
    const res = await mount(await namedStore('Ada'), store).request('/messages/places', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      places: Array<{
        id: string;
        name: string;
        createdAt: string;
        lat: number;
        lng: number;
        label: string | null;
      }>;
    };
    expect(body.places.map((row) => row.id)).toEqual([
      'zb',
      'za',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(body.places[0]).toEqual({
      id: 'zb',
      name: 'Ada',
      createdAt: same.toISOString(),
      lat: 9,
      lng: 10,
      label: 'B',
    });
    expect(body.places[1]?.label).toBe('A');
    expect(body.places[2]?.label).toBeNull();
    expect(body.places[2]?.createdAt).toBe(new Date('2026-08-01T00:00:00.000Z').toISOString());
  });

  it('defaults limit to 1000', async () => {
    let seen: number | undefined;
    const res = await mount(
      await rulesStore(),
      throwingStore({
        listPlaces: async (limit: number) => {
          seen = limit;
          return [];
        },
      }),
    ).request('/messages/places', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ places: [] });
    expect(seen).toBe(1000);
  });

  it('honours limit=1', async () => {
    const same = new Date(now());
    const store = new InMemoryMessageStore([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        accountId: 'acc',
        name: 'Ada',
        text: 'pin a',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        place: { lat: 1, lng: 2, label: null },
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        accountId: 'acc',
        name: 'Ada',
        text: 'pin b',
        createdAt: same,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        place: { lat: 47.3, lng: 8.5, label: 'Zürich' },
      },
    ]);
    const res = await mount(await namedStore('Ada'), store).request('/messages/places?limit=1', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { places: Array<{ id: string }> };
    expect(body.places).toHaveLength(1);
    expect(body.places[0]?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('returns 400 for an invalid limit', async () => {
    const app = mount(await rulesStore());
    for (const limit of ['0', '1001', 'abc']) {
      const res = await app.request(`/messages/places?limit=${limit}`, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid limit' });
    }
  });

  it('returns 503 when listPlaces throws', async () => {
    const res = await mount(
      await rulesStore(),
      throwingStore({
        listPlaces: async () => {
          throw new Error('boom');
        },
      }),
    ).request('/messages/places', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });
});

describe('GET /messages/:id', () => {
  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededStore()).request('/messages/not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the note is missing', async () => {
    const res = await mount(await seededStore()).request(
      '/messages/14141414-1414-4141-8141-141414141414',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 503 when getById throws', async () => {
    const res = await mount(await seededStore(), throwingStore()).request(
      '/messages/14141414-1414-4141-8141-141414141414',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.get.failed')).toBe(true);
  });

  it('returns 503 when countAttributedReplies throws', async () => {
    const noteId = 'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0';
    const base = new InMemoryMessageStore();
    await base.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    warn.mockClear();
    const res = await mount(
      await seededStore(),
      throwingStore({ getById: (id) => base.getById(id) }),
    ).request(`/messages/${noteId}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.get.failed')).toBe(true);
  });

  it('returns 200 with via nostr for a live external reply', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '14141414-1414-4141-8141-141414141414',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
      authorPubkey: 'ab'.repeat(32),
      eventId: 'ee'.repeat(32),
    });
    await messageStore.recordZapper('ab'.repeat(32), 'receipt-legacy', new Date(now()));
    const res = await mount(new InMemoryAuthStore(), messageStore).request(
      '/messages/14141414-1414-4141-8141-141414141414',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: '14141414-1414-4141-8141-141414141414',
      parentId: '15151515-1515-4151-8151-151515151515',
      text: 'from damus',
      payable: false,
      via: 'nostr',
    });
    expect(body).not.toHaveProperty('role');
    expect(body).not.toHaveProperty('accountId');
    expect(body).not.toHaveProperty('authorPubkey');
  });

  it('returns 404 for a live external reply until its pubkey is a recorded zapper', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create(
      {
        id: '14141414-1414-4141-8141-141414141414',
        accountId: null,
        name: 'aabbccdd…8899',
        text: 'from damus',
        createdAt: new Date(now()),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
        parentId: '15151515-1515-4151-8151-151515151515',
        authorPubkey: 'AB'.repeat(32),
        eventId: 'ee'.repeat(32),
      },
      undefined,
    );
    const app = mount(new InMemoryAuthStore(), messageStore);
    const before = await app.request('/messages/14141414-1414-4141-8141-141414141414');
    expect(before.status).toBe(404);
    expect(await before.json()).toEqual({ error: 'Not found' });
    await messageStore.recordZapper('ab'.repeat(32), 'receipt-late', new Date(now()));
    const after = await app.request('/messages/14141414-1414-4141-8141-141414141414');
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ text: 'from damus', via: 'nostr' });
  });

  it('returns 404 for a null-account reply without an author pubkey', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '14141414-1414-4141-8141-141414141414',
      accountId: null,
      name: 'Legacy',
      text: 'hidden legacy row',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
      authorPubkey: null,
    });
    const res = await mount(new InMemoryAuthStore(), messageStore).request(
      '/messages/14141414-1414-4141-8141-141414141414',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('omits role for a top-level Damus-only note and is not payable', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '19191919-1919-4191-8191-191919191919',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ab'.repeat(32),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(new InMemoryAuthStore(), messageStore).request(
      '/messages/19191919-1919-4191-8191-191919191919',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: '19191919-1919-4191-8191-191919191919',
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()).toISOString(),
      sats: 0,
      amountUsd: null,
      amountChf: null,
      amountEur: null,
      amountPhp: null,
      payable: false,
      hasPhoto: false,
      photoCount: 0,
      photoTakenAts: [],
      hasVideo: false,
      videoContentType: null,
      via: 'nostr',
      replyCount: 0,
    });
    expect(body).not.toHaveProperty('role');
    expect(body).not.toHaveProperty('accountId');
  });

  it('includes replyCount of live attributed children on a top-level note', async () => {
    const parentId = 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0';
    const replyA = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
    const replyB = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
    const hiddenReply = 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3';
    const unattributed = 'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: replyA,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply a',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    await messageStore.create({
      id: replyB,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply b',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    await messageStore.create({
      id: hiddenReply,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await messageStore.markDeleted(hiddenReply, new Date(now()), 'acc')).toBe(true);
    await messageStore.create({
      id: unattributed,
      accountId: null,
      name: 'Legacy',
      text: 'unattributed',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
      authorPubkey: null,
    });
    const parentRes = await mount(await namedStore('Ada'), messageStore).request(
      `/messages/${parentId}`,
    );
    expect(parentRes.status).toBe(200);
    expect(((await parentRes.json()) as { replyCount: number }).replyCount).toBe(2);
    const replyRes = await mount(await namedStore('Ada'), messageStore).request(
      `/messages/${replyA}`,
    );
    expect(replyRes.status).toBe(200);
    expect(await replyRes.json()).not.toHaveProperty('replyCount');
  });

  it('deletes a hasVideo note when the file is missing on disk', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore([
      {
        id: '5c5051d3-adba-44f9-a964-9bd0df1ce084',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip gone',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(authStore, messageStore).request(
      '/messages/5c5051d3-adba-44f9-a964-9bd0df1ce084',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(await messageStore.getById('5c5051d3-adba-44f9-a964-9bd0df1ce084')).toBeUndefined();
  });

  it('includes the live author role for a 21gifts note', async () => {
    const authStore = await rulesStore({ name: 'Ada' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '16161616-1616-4161-8161-161616161616',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ab'.repeat(32),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/16161616-1616-4161-8161-161616161616',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; payable: boolean; hasVideo: boolean };
    expect(body.role).toBe('basis');
    expect(body.payable).toBe(false);
    expect(body.hasVideo).toBe(false);
    expect(body).not.toHaveProperty('accountId');
    expect(body).not.toHaveProperty('via');
  });

  it('marks a signed note with a Lightning Address as payable', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '19191919-1919-4191-8191-191919191919',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/19191919-1919-4191-8191-191919191919',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payable: boolean; role: string };
    expect(body.payable).toBe(true);
    expect(body.role).toBe('verified');
  });

  it('marks a signed reply with a Lightning Address as payable', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const messageStore = new InMemoryMessageStore();
    const parentId = '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b';
    const replyId = '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c';
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    await messageStore.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(`/messages/${replyId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payable: boolean; role: string; parentId?: string };
    expect(body.payable).toBe(true);
    expect(body.role).toBe('verified');
    expect(body.parentId).toBe(parentId);
  });

  it('defaults role to basis when the author account is missing', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a',
      accountId: 'gone',
      name: 'Ghost',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
    });
    const res = await mount(await seededStore(), messageStore).request(
      '/messages/1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payable: boolean; role: string };
    expect(body.payable).toBe(false);
    expect(body.role).toBe('basis');
  });

  it('returns 400 when sinceSats is not a non-negative integer', async () => {
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await seededStore(), messageStore).request(
      '/messages/2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b?sinceSats=abc',
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected sinceSats to be a non-negative integer',
    });
  });

  it('returns immediately when sats already exceed sinceSats', async () => {
    const noteId = '3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.addSats(noteId, 21, null);
    const res = await mount(await seededStore(), messageStore, {
      waitSatsSleep: async () => {
        throw new Error('waitSatsSleep must not be called');
      },
    }).request(`/messages/${noteId}?sinceSats=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sats: number; replyCount: number };
    expect(body.sats).toBe(21);
    expect(body.replyCount).toBe(0);
  });

  it('waits until sats increase past sinceSats', async () => {
    const noteId = '4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await seededStore(), messageStore, {
      waitSatsSleep: async () => {
        await messageStore.addSats(noteId, 7, null);
      },
    }).request(`/messages/${noteId}?sinceSats=0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sats: number }).sats).toBe(7);
  });

  it('returns 200 with unchanged sats when the sinceSats wait times out', async () => {
    const noteId = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await seededStore(), messageStore, {
      waitSatsTimeoutMs: 0,
    }).request(`/messages/${noteId}?sinceSats=0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sats: number }).sats).toBe(0);
  });

  it('awaits defaultWaitSatsSleep before returning on sinceSats timeout', async () => {
    const noteId = '70707070-7070-4707-8707-707070707070';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const T = 1_700_000_000_000;
    let nowCalls = 0;
    const res = await mount(await seededStore(), messageStore, {
      waitSatsTimeoutMs: 30,
      waitSatsPollMs: 5,
      now: () => {
        nowCalls += 1;
        return nowCalls <= 2 ? T : T + 30;
      },
    }).request(`/messages/${noteId}?sinceSats=0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sats: number }).sats).toBe(0);
  });

  it('returns 404 when the note disappears while waiting for sinceSats', async () => {
    const noteId = '6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await seededStore(), messageStore, {
      waitSatsSleep: async () => {
        await messageStore.deleteById(noteId);
      },
      waitSatsTimeoutMs: 60_000,
    }).request(`/messages/${noteId}?sinceSats=0`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for a hidden note without a session and omits deletedAt', async () => {
    const id = '81818181-8181-4181-8181-818181818181';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: true,
      videoContentType: 'video/mp4',
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(new InMemoryAuthStore(), messageStore).request(`/messages/${id}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'Not found' });
    expect(body).not.toHaveProperty('deletedAt');
  });

  it('returns 404 for a hidden note for a basis session', async () => {
    const id = '82828282-8282-4282-8282-828282828282';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(await namedStore('Ada'), messageStore).request(`/messages/${id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'Not found' });
    expect(body).not.toHaveProperty('deletedAt');
  });

  it('returns a hidden 21gifts note with hide stamps for a moderator', async () => {
    const id = '83838383-8383-4383-8383-838383838383';
    const auth = await staffStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden clip',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: true,
      videoContentType: 'video/mp4',
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['text']).toBe('hidden clip');
    expect(body['deletedAt']).toBe(new Date(now()).toISOString());
    expect(body['deletedBy']).toEqual({ id: 'acc', name: 'Ada', role: 'moderator' });
    expect(body['payable']).toBe(false);
    expect(body['accountId']).toBe('acc');
    expect(await messageStore.getById(id)).toBeDefined();
  });

  it('returns a hidden 21gifts note with hide stamps for a founder', async () => {
    const id = '84848484-8484-4484-8484-848484848484';
    const auth = await staffStore('Ada');
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...existing, role: 'founder' });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden founder',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['text']).toBe('hidden founder');
    expect(body['deletedAt']).toBe(new Date(now()).toISOString());
    expect(body['deletedBy']).toEqual({ id: 'acc', name: 'Ada', role: 'founder' });
    expect(body['payable']).toBe(false);
    expect(body['accountId']).toBe('acc');
  });

  it('returns a hidden Damus-only note without role for staff', async () => {
    const id = '86868686-8686-4686-8686-868686868686';
    const auth = await staffStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: null,
      name: 'npub',
      text: 'hidden damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['text']).toBe('hidden damus');
    expect(body).not.toHaveProperty('accountId');
    expect(body).not.toHaveProperty('role');
    expect(body['deletedAt']).toBe(new Date(now()).toISOString());
  });

  it('uses basis when a hidden 21gifts author account is missing', async () => {
    const id = '87878787-8787-4787-8787-878787878787';
    const auth = await staffStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'gone',
      name: 'Ghost',
      text: 'hidden ghost',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messageStore.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['role']).toBe('basis');
    expect(body['accountId']).toBe('gone');
  });

  it('includes replyCount of live children on a staff hidden top-level note', async () => {
    const parentId = 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0';
    const replyA = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
    const replyB = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
    const auth = await staffStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: replyA,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply a',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    await messageStore.create({
      id: replyB,
      accountId: 'acc',
      name: 'Ada',
      text: 'reply b',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await messageStore.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    expect(await messageStore.markUndeleted(replyA)).toBe(true);
    expect(await messageStore.markUndeleted(replyB)).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${parentId}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replyCount: number }).replyCount).toBe(2);
  });

  it('omits replyCount on a staff hidden reply', async () => {
    const parentId = 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0';
    const replyId = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
    const auth = await staffStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await messageStore.markDeleted(replyId, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, messageStore).request(`/messages/${replyId}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('replyCount');
  });

  it('omits deletedAt and deletedBy on a live note', async () => {
    const id = '85858585-8585-4585-8585-858585858585';
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'live',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await namedStore('Ada'), messageStore).request(`/messages/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('deletedAt');
    expect(body).not.toHaveProperty('deletedBy');
  });
});

describe('GET /messages/:id/replies', () => {
  it('drops replies whose video file is missing', async () => {
    const parentId = '14141414-1414-4141-8141-141414141414';
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: '15151515-1515-4151-8151-151515151515',
        accountId: 'acc',
        name: 'Ada',
        text: 'member clip a',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
      {
        id: '16161616-1616-4161-8161-161616161616',
        accountId: 'acc',
        name: 'Ada',
        text: 'member clip',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
      },
    ]);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(await store.getById('15151515-1515-4151-8151-151515151515')).toBeUndefined();
    expect(await store.getById('16161616-1616-4161-8161-161616161616')).toBeUndefined();
  });

  it('returns 200 without a session and omits accountId', async () => {
    const parentId = '28282828-2828-4282-8282-282828282828';
    const replyId = '29292929-2929-4292-8292-292929292929';
    const store = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: replyId,
        accountId: 'acc',
        name: 'Ada',
        text: 'member reply',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(await namedStore('Ada'), store).request(
      `/messages/${parentId}/replies`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; accountId?: string; payable: boolean }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.text).toBe('member reply');
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]).not.toHaveProperty('accountId');
  });

  it('marks a signed reply with a Lightning Address as payable in the thread', async () => {
    const parentId = '2a2a2a2a-2a2a-42a2-82a2-2a2a2a2a2a2a';
    const replyId = '2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b';
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    await store.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'signed reply',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'ee'.repeat(32),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const res = await mount(await namedStore('Ada'), store).request(
      `/messages/${parentId}/replies`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; payable: boolean }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.text).toBe('signed reply');
    expect(body.messages[0]?.payable).toBe(true);
  });

  it('marks a signed reply with a whitespace Lightning Address as not payable in the thread', async () => {
    const parentId = '2e2e2e2e-2e2e-42e2-82e2-2e2e2e2e2e2e';
    const replyId = '2f2f2f2f-2f2f-42f2-82f2-2f2f2f2f2f2f';
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    await store.create({
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'signed reply',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      parentId,
      eventId: 'ee'.repeat(32),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: '   ',
    });
    const res = await mount(authStore, store).request(`/messages/${parentId}/replies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; payable: boolean }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.text).toBe('signed reply');
    expect(body.messages[0]?.payable).toBe(false);
  });

  it('returns 404 for a non-uuid id without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages/not-a-uuid/replies');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seededStore()).request('/messages/not-a-uuid/replies', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the parent is missing', async () => {
    const res = await mount(await seededStore()).request(
      '/messages/14141414-1414-4141-8141-141414141414/replies',
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });

  it('returns 503 when listing replies throws', async () => {
    const res = await mount(await seededStore(), throwingStore()).request(
      '/messages/14141414-1414-4141-8141-141414141414/replies',
      { headers: AUTH },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.replies.failed')).toBe(true);
  });

  it('includes external replies with via nostr and roles only for member replies', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '17171717-1717-4171-8171-171717171717',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
      authorPubkey: 'ab'.repeat(32),
    });
    await messageStore.recordZapper('ab'.repeat(32), 'receipt-legacy', new Date(now()));
    await messageStore.create({
      id: '18181818-1818-4181-8181-181818181818',
      accountId: 'acc',
      name: 'Ada',
      text: 'member reply',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
      authorPubkey: 'cd'.repeat(32),
    });
    await messageStore.create({
      id: '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d',
      accountId: 'acc',
      name: 'Ada',
      text: 'member gift reply',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
      authorPubkey: 'ef'.repeat(32),
      sats: 21,
      nostrPublishState: 'skipped',
    });
    await messageStore.create({
      id: '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b',
      accountId: 'gone',
      name: 'Ghost',
      text: 'orphan reply',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: '15151515-1515-4151-8151-151515151515',
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/15151515-1515-4151-8151-151515151515/replies',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        text: string;
        role?: string;
        accountId?: string;
        hasVideo: boolean;
        payable: boolean;
        via?: string;
      }>;
    };
    expect(body.messages).toHaveLength(4);
    const external = body.messages.find((row) => row.text === 'from damus');
    expect(external).toMatchObject({ payable: false, via: 'nostr' });
    expect(external).not.toHaveProperty('role');
    expect(external).not.toHaveProperty('accountId');
    const member = body.messages.find((row) => row.text === 'member reply');
    expect(member?.role).toBe('verified');
    expect(member?.accountId).toBe('acc');
    expect(member).not.toHaveProperty('via');
    const giftReply = body.messages.find((row) => row.text === 'member gift reply');
    expect(giftReply?.role).toBe('verified');
    expect(giftReply?.accountId).toBe('acc');
    expect(giftReply).not.toHaveProperty('via');
    const orphan = body.messages.find((row) => row.text === 'orphan reply');
    expect(orphan?.role).toBe('basis');
    expect(orphan?.accountId).toBe('gone');
    expect(orphan).not.toHaveProperty('via');
  });

  it('returns 200 with an empty-name member reply coerced to a display name', async () => {
    const parentId = '19191919-1919-4191-8191-191919191919';
    const firstId = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
    const secondId = '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c';
    const authorPubkey = 'ab'.repeat(32);
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: firstId,
        accountId: 'acc',
        name: 'Ada',
        text: 'first reply',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: secondId,
        accountId: 'acc',
        name: '',
        text: 'empty name reply',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        authorPubkey,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; name: string; text: string }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.id).toBe(firstId);
    expect(body.messages[0]?.name).toBe('Ada');
    expect(body.messages[0]?.text).toBe('first reply');
    expect(body.messages[1]?.id).toBe(secondId);
    expect(body.messages[1]?.name).toBe(truncatePubkeyDisplay(authorPubkey));
    expect(body.messages[1]?.text).toBe('empty name reply');
  });

  it('returns 200 skipping a reply whose createdAt is invalid', async () => {
    const parentId = '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d';
    const badId = '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e';
    const goodId = '1f1f1f1f-1f1f-41f1-81f1-1f1f1f1f1f1f';
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: badId,
        accountId: 'acc',
        name: 'Ada',
        text: 'bad date',
        createdAt: new Date(NaN),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: goodId,
        accountId: 'acc',
        name: 'Ada',
        text: 'good date',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; text: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(goodId);
    expect(body.messages[0]?.text).toBe('good date');
  });

  it('returns 200 skipping a reply whose author lookup throws', async () => {
    const parentId = '25252525-2525-4252-8252-252525252525';
    const throwId = '26262626-2626-4262-8262-262626262626';
    const goodId = '27272727-2727-4272-8272-272727272727';
    const auth = await namedStore('Ada');
    await auth.createAccount({
      id: 'thrower',
      linkingKey: `02${'c'.repeat(64)}`,
      role: 'basis',
      name: 'Thrower',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: now(),
    });
    const original = auth.getAccount.bind(auth);
    vi.spyOn(auth, 'getAccount').mockImplementation(async (id: string) => {
      if (id === 'thrower') {
        throw new Error('store down');
      }
      return original(id);
    });
    const store = new InMemoryMessageStore([
      {
        id: parentId,
        accountId: 'acc',
        name: 'Ada',
        text: 'parent',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: throwId,
        accountId: 'thrower',
        name: 'Thrower',
        text: 'throwing lookup',
        createdAt: new Date(now()),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
      {
        id: goodId,
        accountId: 'acc',
        name: 'Ada',
        text: 'good sibling',
        createdAt: new Date(now() + 1),
        ...unsignedNostrDefaults(),
        parentId,
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; text: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(goodId);
    expect(body.messages[0]?.text).toBe('good sibling');
  });

  it('serializes a listed external reply with via and leaves it absent on the member', async () => {
    const parentId = '20202020-2020-4202-8202-202020202020';
    const memberId = '21212121-2121-4212-8212-212121212121';
    const auth = await namedStore('Ada');
    const parent = {
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    };
    const member = {
      id: memberId,
      accountId: 'acc',
      name: 'Ada',
      text: 'member reply',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      parentId,
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    };
    const damusOnly = {
      id: '22222222-2222-4222-8222-222222222222',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'from damus',
      createdAt: new Date(now() + 1),
      ...unsignedNostrDefaults(),
      parentId,
      authorPubkey: 'ab'.repeat(32),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    };
    const base = new InMemoryMessageStore([parent, member]);
    const store = throwingStore({
      getById: (id) => base.getById(id),
      listReplies: async () => [member, damusOnly],
      deleteById: (id) => base.deleteById(id),
    });
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; text: string; via?: string }>;
    };
    expect(body.messages).toHaveLength(2);
    const listedMember = body.messages.find((row) => row.id === memberId);
    expect(listedMember?.text).toBe('member reply');
    expect(listedMember).not.toHaveProperty('via');
    expect(body.messages.find((row) => row.id === damusOnly.id)).toMatchObject({
      text: 'from damus',
      via: 'nostr',
    });
  });

  it('returns 503 when deleting a missing-video reply throws', async () => {
    const parentId = '23232323-2323-4232-8232-232323232323';
    const replyId = '24242424-2424-4242-8242-242424242424';
    const auth = await namedStore('Ada');
    const parent = {
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    };
    const missingVideo = {
      id: replyId,
      accountId: 'acc',
      name: 'Ada',
      text: 'missing clip',
      createdAt: new Date(now()),
      ...unsignedNostrDefaults(),
      parentId,
      hasPhoto: false,
      hasVideo: true,
      videoContentType: 'video/mp4' as const,
    };
    const base = new InMemoryMessageStore([parent, missingVideo]);
    const store = throwingStore({
      getById: (id) => base.getById(id),
      listReplies: async () => [missingVideo],
    });
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.replies.failed')).toBe(true);
  });

  it('returns 404 when the parent is hidden without a staff session', async () => {
    const parentId = '86868686-8686-4686-8686-868686868686';
    const childId = '87878787-8787-4787-8787-878787878787';
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await store.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    const res = await mount(await namedStore('Ada'), store).request(
      `/messages/${parentId}/replies`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns hidden children with hide stamps for a moderator session', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const childId = '89898989-8989-4989-8989-898989898989';
    const auth = await staffStore('Ada');
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await store.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.['text']).toBe('hidden child');
    expect(body.messages[0]?.['deletedAt']).toBe(new Date(now()).toISOString());
    expect(body.messages[0]?.['deletedBy']).toEqual({
      id: 'acc',
      name: 'Ada',
      role: 'moderator',
    });
    expect(body.messages[0]?.['payable']).toBe(false);
    expect(body.messages[0]?.['accountId']).toBe('acc');
  });

  it('returns hidden children under a live parent for a moderator session', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const childId = '89898989-8989-4989-8989-898989898989';
    const auth = await staffStore('Ada');
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await store.markDeleted(childId, new Date(now()), 'acc')).toBe(true);
    expect((await store.getById(parentId))?.deletedAt).toBeNull();
    const unsigned = await mount(auth, store).request(`/messages/${parentId}/replies`);
    expect(unsigned.status).toBe(200);
    expect(
      ((await unsigned.json()) as { messages: Array<{ id: string }> }).messages.map(
        (row) => row.id,
      ),
    ).toEqual([]);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.['id']).toBe(childId);
    expect(body.messages[0]?.['deletedAt']).toBe(new Date(now()).toISOString());
  });

  it('omits a hidden child that cannot serialize and still 200', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const childId = '89898989-8989-4989-8989-898989898989';
    const badId = '87878787-8787-4878-8878-878787878787';
    const auth = await staffStore('Ada');
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    await store.create({
      id: badId,
      accountId: 'acc',
      name: 'Ada',
      text: 'bad child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await store.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    const wrapped: MessageStore = throwingStore({
      getById: (id) => store.getById(id),
      listReplies: async (parent, limit, includeHidden) => {
        const rows = await store.listReplies(parent, limit, includeHidden);
        return rows.map((row) =>
          row.id === badId ? { ...row, createdAt: new Date(Number.NaN) } : row,
        );
      },
    });
    const res = await mount(auth, wrapped).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages.map((row) => row['id'])).toEqual([childId]);
  });

  it('uses basis when a hidden child author account is missing', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const childId = '89898989-8989-4989-8989-898989898989';
    const auth = await staffStore('Ada');
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: 'gone',
      name: 'Ghost',
      text: 'hidden child',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
    });
    expect(await store.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.['role']).toBe('basis');
  });

  it('serializes a hidden zapper child without looking up an account', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const childId = '89898989-8989-4989-8989-898989898989';
    const auth = await staffStore('Ada');
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create({
      id: childId,
      accountId: null,
      name: 'Visitor',
      text: 'hidden zapper',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId,
      authorPubkey: 'ab'.repeat(32),
    });
    await store.recordZapper('ab'.repeat(32), 'receipt-hidden', new Date(now()));
    expect(await store.markDeleted(parentId, new Date(now()), 'acc')).toBe(true);
    const res = await mount(auth, store).request(`/messages/${parentId}/replies`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.['text']).toBe('hidden zapper');
    expect(body.messages[0]?.['via']).toBe('nostr');
    expect(body.messages[0]).not.toHaveProperty('accountId');
    expect(body.messages[0]).not.toHaveProperty('role');
    expect(body.messages[0]?.['payable']).toBe(false);
    expect(body.messages[0]?.['deletedAt']).toBe(new Date(now()).toISOString());
  });
});

describe('GET /messages/:id/photo', () => {
  it('returns 404 without an Authorization header when no photo exists', async () => {
    const res = await mount(new InMemoryAuthStore()).request(
      '/messages/00000000-0000-0000-0000-000000000000/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns bytes without a bearer when the photo exists', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: '00000000-0000-4000-8000-000000000001',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(await seededStore(), store).request(
      '/messages/00000000-0000-4000-8000-000000000001/photo',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="photo.jpg"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('withholds the photo of an external reply until its pubkey is a recorded zapper', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create(
      {
        id: '14141414-1414-4141-8141-141414141414',
        accountId: null,
        name: 'aabbccdd…8899',
        text: 'from damus',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
        parentId: '15151515-1515-4151-8151-151515151515',
        authorPubkey: 'AB'.repeat(32),
        eventId: 'ee'.repeat(32),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const app = mount(await seededStore(), store);
    for (const path of ['photo', 'photo.jpg']) {
      const before = await app.request(`/messages/14141414-1414-4141-8141-141414141414/${path}`);
      expect(before.status).toBe(404);
      expect(await before.json()).toEqual({ error: 'Photo not found' });
    }
    await store.recordZapper('ab'.repeat(32), 'receipt-late', new Date(now()));
    const after = await app.request('/messages/14141414-1414-4141-8141-141414141414/photo');
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('withholds the photo of a reply with neither an account nor an author pubkey', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create(
      {
        id: '14141414-1414-4141-8141-141414141414',
        accountId: null,
        name: 'ghost',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
        parentId: '15151515-1515-4151-8151-151515151515',
        authorPubkey: null,
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(await seededStore(), store).request(
      '/messages/14141414-1414-4141-8141-141414141414/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('serves the same bytes at /photo.jpg so Damus treats the URL as an image', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: '00000000-0000-4000-8000-000000000001',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(await seededStore(), store).request(
      '/messages/00000000-0000-4000-8000-000000000001/photo.jpg',
    );
    const jpeg = await mount(await seededStore(), store).request(
      '/messages/00000000-0000-4000-8000-000000000001/photo.jpeg',
    );
    expect(res.status).toBe(200);
    expect(jpeg.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('names png and webp files from the stored type', async () => {
    const store = new InMemoryMessageStore();
    const pngId = '00000000-0000-4000-8000-000000000002';
    const webpId = '00000000-0000-4000-8000-000000000003';
    await store.create(
      {
        id: pngId,
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    );
    await store.create(
      {
        id: webpId,
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/webp', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
    );
    const png = await mount(await seededStore(), store).request(`/messages/${pngId}/photo.png`);
    const webp = await mount(await seededStore(), store).request(`/messages/${webpId}/photo.webp`);
    expect(png.headers.get('Content-Disposition')).toBe('inline; filename="photo.png"');
    expect(webp.headers.get('Content-Disposition')).toBe('inline; filename="photo.webp"');
  });

  it('returns 404 when the photo is missing', async () => {
    const res = await mount(await seededStore()).request(
      '/messages/00000000-0000-0000-0000-000000000000/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 when a live text-only note has no photo bytes', async () => {
    const store = new InMemoryMessageStore();
    const id = '00000000-0000-4000-8000-0000000000a1';
    await store.create({
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(await seededStore(), store).request(`/messages/${id}/photo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 for a non-UUID id without calling the store', async () => {
    const getPhoto = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await mount(await seededStore(), throwingStore({ getPhoto })).request(
      '/messages/not-a-uuid/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
    expect(getPhoto).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.photo.failed')).toBe(false);
  });

  it('returns 404 when the extra still file param fails the index regex', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const app = mount(await seededStore());
    const zero = await app.request(`/messages/${id}/photo/0.jpg`);
    expect(zero.status).toBe(404);
    expect(await zero.json()).toEqual({ error: 'Photo not found' });
    const foo = await app.request(`/messages/${id}/photo/foo.jpg`);
    expect(foo.status).toBe(404);
    expect(await foo.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 503 and logs when getPhoto throws', async () => {
    const res = await mount(
      await seededStore(),
      throwingStore({
        listLatest: async () => [],
        listFeed: async () => [],
        create: async (row) => row,
      }),
    ).request('/messages/00000000-0000-0000-0000-000000000000/photo');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.photo.failed')).toBe(true);
  });

  it('returns 404 for a hidden photo without a staff session', async () => {
    const id = '8a8a8a8a-8a8a-48a8-8a8a-8a8a8a8a8a8a';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id,
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    expect(await store.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const unauth = await mount(new InMemoryAuthStore(), store).request(`/messages/${id}/photo`);
    expect(unauth.status).toBe(404);
    expect(await unauth.json()).toEqual({ error: 'Photo not found' });
    const basis = await mount(await namedStore('Ada'), store).request(`/messages/${id}/photo`, {
      headers: AUTH,
    });
    expect(basis.status).toBe(404);
    expect(await basis.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns hidden photo bytes for a moderator session', async () => {
    const id = '8b8b8b8b-8b8b-48b8-8b8b-8b8b8b8b8b8b';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id,
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    expect(await store.markDeleted(id, new Date(now()), 'acc')).toBe(true);
    const res = await mount(await staffStore('Ada'), store).request(`/messages/${id}/photo`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Authorization');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="photo.jpg"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });
});

describe('forum video', () => {
  const mp4 = (): Uint8Array => {
    const bytes = new Uint8Array(32);
    bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    return bytes;
  };

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

  const mdatFirstMp4 = (): Uint8Array => {
    const ftypPayload = new Uint8Array(16);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 0);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 8);
    const ftyp = box('ftyp', ftypPayload);
    const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]));
    const stcoPayload = new Uint8Array(12);
    const stcoView = new DataView(stcoPayload.buffer);
    stcoView.setUint32(4, 1);
    stcoView.setUint32(8, ftyp.byteLength + 8);
    const stco = box('stco', stcoPayload);
    const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stco)))));
    const out = new Uint8Array(ftyp.byteLength + mdat.byteLength + moov.byteLength);
    out.set(ftyp, 0);
    out.set(mdat, ftyp.byteLength);
    out.set(moov, ftyp.byteLength + mdat.byteLength);
    return out;
  };

  const topLevelTypes = (bytes: Uint8Array): string[] => {
    const types: string[] = [];
    let offset = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 8 <= bytes.byteLength) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > bytes.byteLength) {
        break;
      }
      types.push(
        String.fromCharCode(
          bytes[offset + 4] as number,
          bytes[offset + 5] as number,
          bytes[offset + 6] as number,
          bytes[offset + 7] as number,
        ),
      );
      offset += size;
    }
    return types;
  };

  it('collapses a repeated multipart video+text post to the same id', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const limiter = new PostRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore: auth,
        now,
        postLimiter: limiter,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const buildForm = (): FormData => {
      const form = new FormData();
      form.set('text', 'clip');
      form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
      form.set('poster', new File([JPEG_BYTES], 'poster.jpg', { type: 'image/jpeg' }));
      return form;
    };
    const first = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: buildForm(),
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { id: string }).id;
    const second = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: buildForm(),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(firstId);
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('accepts multipart video and serves Range', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    form.set('poster', new File([JPEG_BYTES], 'poster.jpg', { type: 'image/jpeg' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as {
      id: string;
      hasVideo: boolean;
      hasPhoto: boolean;
      videoContentType: string | null;
    };
    expect(created.hasVideo).toBe(true);
    expect(created.hasPhoto).toBe(true);
    expect(created.videoContentType).toBe('video/mp4');
    const publicGet = await app.request(`/messages/${created.id}`);
    expect(publicGet.status).toBe(200);
    expect(((await publicGet.json()) as { hasVideo: boolean }).hasVideo).toBe(true);
    const full = await app.request(`/messages/${created.id}/video.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    const fullBody = new Uint8Array(await full.arrayBuffer());
    expect(full.headers.get('Content-Length')).toBe(String(fullBody.byteLength));
    const ranged = await app.request(`/messages/${created.id}/video.mp4`, {
      headers: { Range: 'bytes=0-3' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')?.startsWith('bytes 0-3/')).toBe(true);
    expect(ranged.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(mp4().subarray(0, 4));
    const mid = await app.request(`/messages/${created.id}/video.mp4`, {
      headers: { Range: 'bytes=8-11' },
    });
    expect(mid.status).toBe(206);
    expect(mid.headers.get('Content-Range')).toBe(`bytes 8-11/${fullBody.byteLength}`);
    expect(mid.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await mid.arrayBuffer())).toEqual(fullBody.slice(8, 12));
    expect((await app.request(`/messages/${created.id}/video.webm`)).status).toBe(404);
    expect((await app.request('/messages/not-a-uuid/video.mp4')).status).toBe(404);
  });

  it('withholds the video of an external reply until its pubkey is a recorded zapper', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      id: '15151515-1515-4151-8151-151515151515',
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await store.create(
      {
        id: '14141414-1414-4141-8141-141414141414',
        accountId: null,
        name: 'aabbccdd…8899',
        text: 'from damus',
        createdAt: new Date(now()),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
        parentId: '15151515-1515-4151-8151-151515151515',
        authorPubkey: 'AB'.repeat(32),
        eventId: 'ee'.repeat(32),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4() },
    );
    const app = mount(await seededStore(), store);
    try {
      const before = await app.request('/messages/14141414-1414-4141-8141-141414141414/video.mp4');
      expect(before.status).toBe(404);
      expect(await before.json()).toEqual({ error: 'Video not found' });
      await store.recordZapper('ab'.repeat(32), 'receipt-late', new Date(now()));
      const after = await app.request('/messages/14141414-1414-4141-8141-141414141414/video.mp4');
      expect(after.status).toBe(200);
      expect(after.headers.get('Content-Type')).toBe('video/mp4');
    } finally {
      await removeForumVideo('14141414-1414-4141-8141-141414141414', 'video/mp4');
    }
  });

  it('heals mdat-first mp4 on GET and rewrites the file', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    const path = videoFilePath(resolveMediaDir(), created.id, 'video/mp4');
    const mdatFirst = mdatFirstMp4();
    await writeFile(path, mdatFirst);
    expect(topLevelTypes(mdatFirst)).toEqual(['ftyp', 'mdat', 'moov']);
    const full = await app.request(`/messages/${created.id}/video.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    const body = new Uint8Array(await full.arrayBuffer());
    expect(full.headers.get('Content-Length')).toBe(String(body.byteLength));
    expect(topLevelTypes(body)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(topLevelTypes(new Uint8Array(await readFile(path)))).toEqual(['ftyp', 'moov', 'mdat']);
    const again = await app.request(`/messages/${created.id}/video.mp4`);
    expect(again.status).toBe(200);
    expect(again.headers.get('Content-Length')).toBe(
      String((await again.arrayBuffer()).byteLength),
    );
  });

  it('rejects an oversized poster part before decoding', async () => {
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    form.set('poster', new File([new Uint8Array(1_048_577)], 'poster.jpg', { type: 'image/jpeg' }));
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('still returns 200 when video push enqueue throws', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    pushStore.enqueue = async () => {
      throw new Error('enqueue failed');
    };
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'push.enqueue.failed')).toBe(true);
  });

  it('enqueues a forum push for other subscribed accounts after a video post', async () => {
    const authStore = await namedStore('Ada');
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/author',
      accountId: 'acc',
      p256dh: 'p256dh',
      auth: 'authkey',
      createdAt: new Date(now()),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        pushStore,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const claimed = await pushStore.claimPending(20, now() + 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('other');
    expect(claimed[0]?.type).toBe('forum');
  });

  it('rejects an oversized video part before decoding', async () => {
    const form = new FormData();
    form.set('text', 'clip');
    const file = new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'clip.mp4', {
      type: 'video/mp4',
    });
    form.set('video', file);
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('rejects overlong multipart text', async () => {
    const form = new FormData();
    form.set('text', 'a'.repeat(MESSAGE_MAX_LENGTH + 1));
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty multipart', async () => {
    const empty = new FormData();
    empty.set('text', '   ');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: empty,
    });
    expect(res.status).toBe(400);
  });

  it('posts a multipart note with a valid goalSats', async () => {
    const form = new FormData();
    form.set('text', 'ask');
    form.set('goalSats', '21000');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { goalSats?: number }).goalSats).toBe(21000);
    const emptyGoal = new FormData();
    emptyGoal.set('text', 'plain');
    emptyGoal.set('goalSats', '');
    const omitted = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: emptyGoal,
    });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).not.toHaveProperty('goalSats');
  });

  it('posts a multipart note with a valid place pin', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', '47.3');
    form.set('placeLng', '8.5');
    form.set('placeLabel', 'Zürich');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { place?: { lat: number; lng: number; label: string } }).place,
    ).toEqual({ lat: 47.3, lng: 8.5, label: 'Zürich' });
  });

  it('returns 400 when multipart place is incomplete or out of range', async () => {
    const onlyLat = new FormData();
    onlyLat.set('text', 'pin');
    onlyLat.set('placeLat', '47.3');
    const onlyLatRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: onlyLat,
    });
    expect(onlyLatRes.status).toBe(400);
    expect(await onlyLatRes.json()).toEqual({ error: 'Place must be a latitude and longitude' });

    const onlyLng = new FormData();
    onlyLng.set('text', 'pin');
    onlyLng.set('placeLng', '8.5');
    const onlyLngRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: onlyLng,
    });
    expect(onlyLngRes.status).toBe(400);
    expect(await onlyLngRes.json()).toEqual({ error: 'Place must be a latitude and longitude' });

    const outOfRange = new FormData();
    outOfRange.set('text', 'pin');
    outOfRange.set('placeLat', '999');
    outOfRange.set('placeLng', '8.5');
    const outOfRangeRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: outOfRange,
    });
    expect(outOfRangeRes.status).toBe(400);
    expect(await outOfRangeRes.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  });

  it('returns 400 when a multipart coordinate is not a decimal', async () => {
    const badLat = new FormData();
    badLat.set('text', 'pin');
    badLat.set('placeLat', 'north');
    badLat.set('placeLng', '8.5');
    const badLatRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: badLat,
    });
    expect(badLatRes.status).toBe(400);
    expect(await badLatRes.json()).toEqual({ error: 'Place must be a latitude and longitude' });

    const badLng = new FormData();
    badLng.set('text', 'pin');
    badLng.set('placeLat', '47.3');
    badLng.set('placeLng', 'east');
    const badLngRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: badLng,
    });
    expect(badLngRes.status).toBe(400);
    expect(await badLngRes.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  });

  it('omits place when multipart coordinates are blank', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', ' ');
    form.set('placeLng', ' ');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('place');
  });

  it('returns 400 when one multipart coordinate is blank', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', ' ');
    form.set('placeLng', '8.5');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  });

  it('omits place when multipart placeLat and placeLng are empty', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', '');
    form.set('placeLng', '');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('place');
  });

  it('returns 400 when multipart placeLat is empty and placeLng is set', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', '');
    form.set('placeLng', '8.5');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  });

  it('posts a multipart place pin without a placeLabel', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', '47.3');
    form.set('placeLng', '8.5');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { place?: { lat: number; lng: number; label: string | null } }).place,
    ).toEqual({ lat: 47.3, lng: 8.5, label: null });
  });

  it('maps an empty multipart placeLabel to null', async () => {
    const form = new FormData();
    form.set('text', 'pin');
    form.set('placeLat', '47.3');
    form.set('placeLng', '8.5');
    form.set('placeLabel', '');
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { place?: { label: string | null } }).place?.label).toBeNull();
  });

  it('rejects a multipart note with an invalid goalSats', async () => {
    for (const goal of ['nope', '0', '10000001'] as const) {
      const form = new FormData();
      form.set('text', 'ask');
      form.set('goalSats', goal);
      const res = await mount(await namedStore('Ada')).request('/messages', {
        method: 'POST',
        headers: AUTH,
        body: form,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Goal must be a positive whole-sat amount' });
    }
    const fileGoal = new FormData();
    fileGoal.set('text', 'ask');
    fileGoal.set('goalSats', new File([JPEG_BYTES], 'x.bin'));
    const fileRes = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: fileGoal,
    });
    expect(fileRes.status).toBe(400);
    expect(await fileRes.json()).toEqual({ error: 'Goal must be a positive whole-sat amount' });
  });

  it('ignores an empty poster part', async () => {
    const form = new FormData();
    form.set('text', 'hello');
    form.set('poster', new File([], 'p.jpg', { type: 'image/jpeg' }));
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasPhoto: boolean }).hasPhoto).toBe(false);
  });

  it('rejects a bad poster', async () => {
    const badPoster = new FormData();
    badPoster.set('text', 'x');
    badPoster.set(
      'poster',
      new File([new Uint8Array([1, 2, 3])], 'x.bin', { type: 'application/octet-stream' }),
    );
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: badPoster,
    });
    expect(res.status).toBe(400);
  });

  it('rejects multipart when the account has no name', async () => {
    const form = new FormData();
    form.set('text', 'clip');
    const store = await rulesStore({ name: null, nameSkippedAt: now() });
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await store.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const res = await mount(store).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['name', 'username'],
    });
  });

  it('returns 503 when video create throws', async () => {
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await mount(await namedStore('Ada'), throwingStore()).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(503);
  });

  it('returns 404 when no video is stored', async () => {
    const res = await mount(await namedStore('Ada')).request(
      '/messages/00000000-0000-4000-8000-000000000001/video.mp4',
    );
    expect(res.status).toBe(404);
  });

  it('ignores an empty video part and posts text', async () => {
    const form = new FormData();
    form.set('text', 'hello');
    form.set('video', new File([], 'empty.mp4', { type: 'video/mp4' }));
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasVideo: boolean }).hasVideo).toBe(false);
  });

  it('rejects a non-video multipart file', async () => {
    const form = new FormData();
    form.set('text', 'clip');
    form.set(
      'video',
      new File([new Uint8Array([1, 2, 3, 4])], 'x.bin', { type: 'application/octet-stream' }),
    );
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('returns 503 when video GET cannot read the row', async () => {
    const res = await mount(await namedStore('Ada'), throwingStore()).request(
      '/messages/00000000-0000-4000-8000-000000000001/video.mp4',
    );
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(true);
  });

  it('returns 416 for an unsatisfiable Range', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    const size = mp4().byteLength;
    const ranged = await app.request(`/messages/${created.id}/video.mp4`, {
      headers: { Range: `bytes=${size}-` },
    });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('Content-Range')).toBe(`bytes */${size}`);
    expect(ranged.headers.get('Accept-Ranges')).toBe('bytes');
    expect(ranged.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns 404 when the video file is missing without logging 503', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    await removeForumVideo(created.id, 'video/mp4');
    warn.mockClear();
    const missing = await app.request(`/messages/${created.id}/video.mp4`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Video not found' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(false);
  });

  it('returns 404 for an empty video file without logging 503', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    await writeFile(videoFilePath(resolveMediaDir(), created.id, 'video/mp4'), new Uint8Array());
    warn.mockClear();
    const empty = await app.request(`/messages/${created.id}/video.mp4`);
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: 'Video not found' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(false);
  });

  it('returns 404 when remuxed video bytes are empty after a non-empty stat', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    const videoMod = await import('@/lib/video');
    const spy = vi.spyOn(videoMod, 'readForumVideoBytes').mockResolvedValue(new Uint8Array());
    try {
      warn.mockClear();
      const emptyRemux = await app.request(`/messages/${created.id}/video.mp4`);
      expect(emptyRemux.status).toBe(404);
      expect(await emptyRemux.json()).toEqual({ error: 'Video not found' });
      expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns 404 when the video path is not a file', async () => {
    const auth = await namedStore('Ada');
    const store = new InMemoryMessageStore();
    const app = mount(auth, store);
    const form = new FormData();
    form.set('text', 'clip');
    form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
    const res = await app.request('/messages', {
      method: 'POST',
      headers: AUTH,
      body: form,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    await removeForumVideo(created.id, 'video/mp4');
    await mkdir(videoFilePath(resolveMediaDir(), created.id, 'video/mp4'));
    warn.mockClear();
    const notFile = await app.request(`/messages/${created.id}/video.mp4`);
    expect(notFile.status).toBe(404);
    expect(await notFile.json()).toEqual({ error: 'Video not found' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(false);
  });

  it('returns 503 when video file stat fails for a non-ENOENT reason', async () => {
    const prev = process.env['MEDIA_DIR'];
    const dir = join(tmpdir(), `21gifts-video-eacces-${Date.now()}`);
    process.env['MEDIA_DIR'] = dir;
    try {
      const auth = await namedStore('Ada');
      const store = new InMemoryMessageStore();
      const app = mount(auth, store);
      const form = new FormData();
      form.set('text', 'clip');
      form.set('video', new File([mp4()], 'clip.mp4', { type: 'video/mp4' }));
      const res = await app.request('/messages', {
        method: 'POST',
        headers: AUTH,
        body: form,
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as { id: string };
      await chmod(dir, 0o000);
      warn.mockClear();
      try {
        const denied = await app.request(`/messages/${created.id}/video.mp4`);
        expect(denied.status).toBe(503);
        expect(await denied.json()).toEqual({ error: 'Messages are unavailable' });
        expect(parsedEvents(warn).some((e) => e['event'] === 'messages.video.failed')).toBe(true);
      } finally {
        await chmod(dir, 0o755);
      }
    } finally {
      if (prev === undefined) {
        delete process.env['MEDIA_DIR'];
      } else {
        process.env['MEDIA_DIR'] = prev;
      }
    }
  });
});

describe('DELETE /messages/:id', () => {
  const NOTE_ID = '11111111-1111-4111-8111-111111111111';

  async function staffStore(
    role: 'founder' | 'moderator',
  ): Promise<{ auth: InMemoryAuthStore; messages: InMemoryMessageStore }> {
    const auth = await namedStore('Ada');
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...account, role });
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    return { auth, messages };
  }

  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for basis including the author', async () => {
    const auth = await namedStore('Ada');
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'mine',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 for verified', async () => {
    const auth = await namedStore('Ada');
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...account, role: 'verified' });
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'mine',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-uuid id', async () => {
    const { auth, messages } = await staffStore('founder');
    const res = await mount(auth, messages).request('/messages/not-a-uuid', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the note is missing', async () => {
    const { auth } = await staffStore('founder');
    const res = await mount(auth, new InMemoryMessageStore()).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 without side effects when marking the note loses a race', async () => {
    const { auth } = await staffStore('founder');
    const targetId = '77777777-7777-4777-8777-777777777777';
    const base = new InMemoryMessageStore();
    await base.create({
      id: targetId,
      accountId: null,
      name: 'External',
      text: 'raced deletion',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      authorPubkey: '77'.repeat(32),
    });
    const markDeleted = vi.fn<MessageStore['markDeleted']>(async () => false);
    const blockPubkeyAndHideRows = vi.fn<MessageStore['blockPubkeyAndHideRows']>(async () => 0);
    const messages = throwingStore({
      getById: (id) => base.getById(id),
      markDeleted,
      blockPubkeyAndHideRows,
    });
    warn.mockClear();

    const res = await mount(auth, messages).request(`/messages/${targetId}`, {
      method: 'DELETE',
      headers: AUTH,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(markDeleted).toHaveBeenCalledTimes(1);
    expect(blockPubkeyAndHideRows).toHaveBeenCalledTimes(0);
    const events = parsedEvents(warn);
    expect(events.some((event) => event['event'] === 'messages.external.blocked')).toBe(false);
    expect(events.some((event) => event['event'] === 'messages.deleted')).toBe(false);
  });

  it('returns 204 for founder and logs messages.deleted without text', async () => {
    const { auth, messages } = await staffStore('founder');
    warn.mockClear();
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const events = parsedEvents(warn);
    const deleted = events.find((e) => e['event'] === 'messages.deleted');
    expect(deleted).toMatchObject({
      messageId: NOTE_ID,
      accountId: 'acc',
      role: 'founder',
    });
    expect(JSON.stringify(deleted)).not.toContain('hide me');
    const row = await messages.getById(NOTE_ID);
    expect(row?.deletedAt).not.toBeNull();
    expect(await messages.getPhoto(NOTE_ID)).not.toBeNull();
  });

  it('returns 204 for moderator', async () => {
    const { auth, messages } = await staffStore('moderator');
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
  });

  it('returns 204 when already tagged', async () => {
    const { auth, messages } = await staffStore('founder');
    expect(await messages.markDeleted(NOTE_ID, new Date(now() - 1_000), 'acc')).toBe(true);
    const first = await messages.getById(NOTE_ID);
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    const again = await messages.getById(NOTE_ID);
    expect(again?.deletedAt?.getTime()).toBe(first?.deletedAt?.getTime());
  });

  it('blocks an external author and hides every live row by that pubkey', async () => {
    const { auth, messages } = await staffStore('founder');
    const pubkey = 'ab'.repeat(32);
    const targetId = '33333333-3333-4333-8333-333333333333';
    const siblingId = '44444444-4444-4444-8444-444444444444';
    const otherId = '55555555-5555-4555-8555-555555555555';
    for (const [id, authorPubkey] of [
      [targetId, pubkey],
      [siblingId, pubkey],
      [otherId, 'cd'.repeat(32)],
    ] as const) {
      await messages.create({
        id,
        accountId: null,
        name: 'External',
        text: id,
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        authorPubkey,
      });
    }
    warn.mockClear();
    const res = await mount(auth, messages).request(`/messages/${targetId}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(await messages.listBlockedPubkeys()).toEqual([pubkey]);
    expect((await messages.getById(targetId))?.deletedAt).not.toBeNull();
    expect((await messages.getById(siblingId))?.deletedAt).not.toBeNull();
    expect((await messages.getById(otherId))?.deletedAt).toBeNull();
    const blocked = parsedEvents(warn).find(
      (event) => event['event'] === 'messages.external.blocked',
    );
    expect(blocked).toMatchObject({ messageId: targetId, hidden: 2 });
    expect(blocked).not.toHaveProperty('pubkey');
  });

  it('does not block an external child when staff hide its member parent', async () => {
    const { auth, messages } = await staffStore('founder');
    await messages.create({
      id: '66666666-6666-4666-8666-666666666666',
      accountId: null,
      name: 'External',
      text: 'child',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: NOTE_ID,
      authorPubkey: 'ef'.repeat(32),
    });
    const res = await mount(auth, messages).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(await messages.listBlockedPubkeys()).toEqual([]);
  });

  it('returns 503 and logs messages.delete.failed when markDeleted throws', async () => {
    const { auth } = await staffStore('founder');
    warn.mockClear();
    const res = await mount(auth, throwingStore()).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.failed')).toBe(true);
  });

  it('hides the note from public reads, list, invoice, and inReplyTo', async () => {
    const { auth, messages } = await staffStore('founder');
    const mp4Bytes = new Uint8Array(32);
    mp4Bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const videoId = '22222222-2222-4222-8222-222222222222';
    await messages.create(
      {
        id: videoId,
        accountId: 'acc',
        name: 'Ada',
        text: 'clip',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4Bytes },
    );
    const app = mount(auth, messages);
    const live = await app.request(`/messages/${NOTE_ID}`);
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as Record<string, unknown>;
    expect(liveBody).not.toHaveProperty('deletedAt');
    expect(liveBody).not.toHaveProperty('deletedBy');

    expect(
      (await app.request(`/messages/${NOTE_ID}`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(204);
    expect((await app.request(`/messages/${NOTE_ID}`)).status).toBe(404);
    expect((await app.request(`/messages/${NOTE_ID}/photo`)).status).toBe(404);
    expect((await app.request(`/messages/${NOTE_ID}/replies`)).status).toBe(404);
    expect((await app.request(`/messages/${NOTE_ID}/replies`, { headers: AUTH })).status).toBe(200);
    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { messages: Array<{ id: string }> }).messages.map((row) => row.id),
    ).not.toContain(NOTE_ID);

    expect(
      (
        await app.request(`/messages/${NOTE_ID}/invoice`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'reply', inReplyTo: NOTE_ID }),
        })
      ).status,
    ).toBe(404);

    expect(
      (await app.request(`/messages/${videoId}`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(204);
    expect((await app.request(`/messages/${videoId}/video.mp4`)).status).toBe(404);
    const staffVideo = await app.request(`/messages/${videoId}/video.mp4`, { headers: AUTH });
    expect(staffVideo.status).toBe(200);
    expect(staffVideo.headers.get('Cache-Control')).toBe('private, no-store');
    expect(staffVideo.headers.get('Vary')).toBe('Authorization');
    expect(await messages.getById(videoId)).toBeDefined();
  });

  it('publishes NIP-09 for the target and a child author, skips gift-only, still 204 on purge failure', async () => {
    const kek = parseNostrKek('ef'.repeat(32));
    const auth = await namedStore('Ada');
    const founder = await auth.getAccount('acc');
    expect(founder).toBeDefined();
    if (founder === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...founder, role: 'founder' });
    const messages = new InMemoryMessageStore();
    await ensureAccountNostrKey(auth, 'acc', kek);
    await auth.createAccount({
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
    await ensureAccountNostrKey(auth, 'child', kek);
    await messages.create(
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
        eventId: 'aa'.repeat(32),
        nostrPublishState: 'published',
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    await messages.create({
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'child',
      name: 'Bea',
      text: 'reply',
      createdAt: new Date(now() + 1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: NOTE_ID,
      eventId: 'bb'.repeat(32),
      nostrPublishState: 'published',
    });
    await messages.create({
      id: '44444444-4444-4444-8444-444444444444',
      accountId: 'child',
      name: 'Bea',
      text: '',
      createdAt: new Date(now() + 2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: NOTE_ID,
      eventId: null,
      nostrPublishState: 'skipped',
    });
    const publisher = new RecordingPublisher();
    const parentPub = await auth.getNostrPublicKey('acc');
    const childPub = await auth.getNostrPublicKey('child');
    const app = mount(auth, messages, {
      nostrKek: kek,
      nostrPublisher: publisher,
      env: {
        PUBLIC_BASE_URL: 'https://21.gifts',
        CLOUDFLARE_ZONE_ID: 'zone',
        CLOUDFLARE_API_TOKEN: 'secret-token',
      },
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    warn.mockClear();
    const res = await app.request(`/messages/${NOTE_ID}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(204);
    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[0]?.event['kind']).toBe(5);
    expect(publisher.calls[0]?.event['pubkey']).toBe(parentPub);
    expect((publisher.calls[0]?.event['tags'] as string[][])[0]).toEqual(['e', 'aa'.repeat(32)]);
    expect(publisher.calls[1]?.event['pubkey']).toBe(childPub);
    expect((publisher.calls[1]?.event['tags'] as string[][])[0]).toEqual(['e', 'bb'.repeat(32)]);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.purge_failed')).toBe(
      true,
    );
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('secret-token');
  });

  it('still returns 204 and logs messages.delete.retract_failed when retract throws', async () => {
    const kek = parseNostrKek('ef'.repeat(32));
    const auth = await namedStore('Ada');
    const founder = await auth.getAccount('acc');
    expect(founder).toBeDefined();
    if (founder === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...founder, role: 'founder' });
    await ensureAccountNostrKey(auth, 'acc', kek);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'hide me',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
      nostrPublishState: 'published',
    });
    const store = throwingStore({
      markDeleted: (id, at, by) => messages.markDeleted(id, at, by),
      getById: (id) => messages.getById(id),
      listDirectChildren: async () => {
        throw new Error('children boom');
      },
    });
    const app = mount(auth, store, {
      nostrKek: kek,
      nostrPublisher: new RecordingPublisher(),
      env: {},
    });
    warn.mockClear();
    expect(
      (await app.request(`/messages/${NOTE_ID}`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(204);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.retract_failed')).toBe(
      true,
    );
  });

  it('retries NIP-09 on an already-tagged note', async () => {
    const kek = parseNostrKek('ef'.repeat(32));
    const auth = await namedStore('Ada');
    const founder = await auth.getAccount('acc');
    expect(founder).toBeDefined();
    if (founder === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...founder, role: 'founder' });
    const messages = new InMemoryMessageStore();
    await ensureAccountNostrKey(auth, 'acc', kek);
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'hide me',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
      nostrPublishState: 'published',
    });
    expect(await messages.markDeleted(NOTE_ID, new Date(now() - 1_000), 'acc')).toBe(true);
    const publisher = new RecordingPublisher();
    const app = mount(auth, messages, { nostrKek: kek, nostrPublisher: publisher });
    expect(
      (await app.request(`/messages/${NOTE_ID}`, { method: 'DELETE', headers: AUTH })).status,
    ).toBe(204);
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.event['kind']).toBe(5);
  });

  it('retracts notifications whose parentId or replyId is the note or a stamped child', async () => {
    const childId = '33333333-3333-4333-8333-333333333333';
    const keepId = '44444444-4444-4444-8444-444444444444';
    const { auth, messages } = await staffStore('founder');
    await messages.create({
      id: childId,
      accountId: 'acc',
      name: 'Ada',
      text: 'child',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: NOTE_ID,
    });
    const notificationStore = new InMemoryNotificationStore([
      {
        id: 'n-parent',
        recipientAccountId: 'acc',
        actorAccountId: 'acc',
        type: 'forum_reply',
        parentId: NOTE_ID,
        replyId: keepId,
        name: 'Ada',
        text: 'about parent',
        createdAt: new Date(now()),
        readAt: null,
      },
      {
        id: 'n-reply',
        recipientAccountId: 'acc',
        actorAccountId: 'acc',
        type: 'forum_post',
        parentId: keepId,
        replyId: NOTE_ID,
        name: 'Ada',
        text: 'about note as reply',
        createdAt: new Date(now()),
        readAt: null,
      },
      {
        id: 'n-child',
        recipientAccountId: 'acc',
        actorAccountId: 'acc',
        type: 'zap',
        parentId: childId,
        replyId: childId,
        name: 'Ada',
        text: '21',
        createdAt: new Date(now()),
        readAt: null,
      },
      {
        id: 'n-keep',
        recipientAccountId: 'acc',
        actorAccountId: 'acc',
        type: 'forum_reply',
        parentId: keepId,
        replyId: keepId,
        name: 'Ada',
        text: 'unrelated',
        createdAt: new Date(now()),
        readAt: null,
      },
    ]);
    const res = await mount(auth, messages, { notificationStore }).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    const listed = await notificationStore.listByRecipient('acc', 10);
    expect(listed.map((row) => row.id)).toEqual(['n-keep']);
    expect(await notificationStore.getByIdForRecipient('n-parent', 'acc')).toBeUndefined();
    expect(await notificationStore.getByIdForRecipient('n-reply', 'acc')).toBeUndefined();
    expect(await notificationStore.getByIdForRecipient('n-child', 'acc')).toBeUndefined();
  });

  it('returns 204 and logs when deleteByMessageIds throws', async () => {
    const { auth, messages } = await staffStore('founder');
    const notificationStore = new InMemoryNotificationStore([
      {
        id: 'n-throw',
        recipientAccountId: 'acc',
        actorAccountId: 'acc',
        type: 'forum_reply',
        parentId: NOTE_ID,
        replyId: NOTE_ID,
        name: 'Ada',
        text: 'child',
        createdAt: new Date(now()),
        readAt: null,
      },
    ]);
    notificationStore.deleteByMessageIds = async (): Promise<number> => {
      throw new Error('boom');
    };
    warn.mockClear();
    const res = await mount(auth, messages, { notificationStore }).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'messages.delete.notifications_failed'),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.failed')).toBe(false);
    const row = await messages.getById(NOTE_ID);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('returns 204 and logs when listChildIds throws after markDeleted', async () => {
    const { auth, messages } = await staffStore('founder');
    warn.mockClear();
    const store = throwingStore({
      markDeleted: (id, at, byAccountId) => messages.markDeleted(id, at, byAccountId),
      getById: (id) => messages.getById(id),
    });
    const res = await mount(auth, store).request(`/messages/${NOTE_ID}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'messages.delete.notifications_failed'),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.delete.failed')).toBe(false);
    const row = await messages.getById(NOTE_ID);
    expect(row?.deletedAt).not.toBeNull();
  });
});

describe('GET /messages/hidden', () => {
  const NOTE_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_ID = '22222222-2222-4222-8222-222222222222';
  const HIDDEN_AT = new Date(now());

  async function staffAuth(role: 'founder' | 'moderator'): Promise<InMemoryAuthStore> {
    const auth = await namedStore('Ada');
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...account, role });
    return auth;
  }

  it('returns 401 without a bearer', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages/hidden');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for basis including the author', async () => {
    const auth = await namedStore('Ada');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'mine',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 for verified', async () => {
    const auth = await namedStore('Ada');
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...account, role: 'verified' });
    const res = await mount(auth, new InMemoryMessageStore()).request('/messages/hidden', {
      headers: AUTH,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 200 for founder with serialized hidden rows', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [
        {
          id: NOTE_ID,
          name: 'Ada',
          text: 'hide me',
          createdAt: new Date(now()).toISOString(),
          sats: 0,
          amountUsd: null,
          amountChf: null,
          amountEur: null,
          amountPhp: null,
          hasPhoto: false,
          photoCount: 0,
          photoTakenAts: [],
          hasVideo: false,
          videoContentType: null,
          parentId: null,
          deletedAt: HIDDEN_AT.toISOString(),
          deletedBy: { id: 'acc', name: 'Ada', role: 'founder' },
        },
      ],
    });
  });

  it('marks hidden external Nostr rows and omits via from member rows', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hidden member',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        authorPubkey: 'ab'.repeat(32),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
      {
        id: OTHER_ID,
        accountId: null,
        name: 'External',
        text: 'hidden external',
        createdAt: new Date(now() - 1),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        authorPubkey: 'cd'.repeat(32),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; via?: 'nostr' }>;
    };
    expect(body.messages).toHaveLength(2);
    const member = body.messages.find((row) => row.text === 'hidden member');
    const external = body.messages.find((row) => row.text === 'hidden external');
    expect(member).toBeDefined();
    expect(member).not.toHaveProperty('via');
    expect(external).toHaveProperty('via', 'nostr');
    expect(external).not.toHaveProperty('authorPubkey');
  });

  it('returns 200 for moderator', async () => {
    const auth = await staffAuth('moderator');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; deletedBy: { role: string } }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.id).toBe(NOTE_ID);
    expect(body.messages[0]?.deletedBy.role).toBe('moderator');
  });

  it('returns an empty list', async () => {
    const res = await mount(await staffAuth('founder')).request('/messages/hidden', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('lists newest-hidden first and omits live rows', async () => {
    const earlier = new Date(now() - 1_000);
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'live',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: OTHER_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'older hidden',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: earlier,
        deletedBy: 'acc',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        accountId: 'acc',
        name: 'Ada',
        text: 'newer hidden',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((row) => row.id)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      OTHER_ID,
    ]);
  });

  it('resolves a found deleter', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    const body = (await res.json()) as {
      messages: Array<{ deletedBy: { id: string; name: string; role: string } }>;
    };
    expect(body.messages[0]?.deletedBy).toEqual({ id: 'acc', name: 'Ada', role: 'founder' });
  });

  it('keeps a missing deleter id with null name and role', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'gone-staff',
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        deletedBy: { id: string | null; name: string | null; role: string | null };
      }>;
    };
    expect(body.messages[0]?.deletedBy).toEqual({ id: 'gone-staff', name: null, role: null });
  });

  it('emits null deletedBy when the row has no deleter', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: null,
      },
    ]);
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        deletedBy: { id: string | null; name: string | null; role: string | null };
      }>;
    };
    expect(body.messages[0]?.deletedBy).toEqual({ id: null, name: null, role: null });
  });

  it('returns 503 and logs messages.hidden.list_failed when listHidden throws', async () => {
    const auth = await staffAuth('founder');
    warn.mockClear();
    const res = await mount(auth, throwingStore()).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.hidden.list_failed')).toBe(true);
  });

  it('returns 503 and logs messages.hidden.list_failed when getAccount throws', async () => {
    const auth = await staffAuth('founder');
    const original = auth.getAccount.bind(auth);
    vi.spyOn(auth, 'getAccount').mockImplementation(async (id: string) => {
      if (id === 'gone-staff') {
        throw new Error('store down');
      }
      return original(id);
    });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'gone-staff',
      },
    ]);
    warn.mockClear();
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.hidden.list_failed')).toBe(true);
  });

  it('logs messages.hidden.listed with count only', async () => {
    const auth = await staffAuth('founder');
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'hide me',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        deletedAt: HIDDEN_AT,
        deletedBy: 'acc',
      },
    ]);
    warn.mockClear();
    const res = await mount(auth, messages).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    const listed = parsedEvents(warn).find((e) => e['event'] === 'messages.hidden.listed');
    expect(listed).toMatchObject({ event: 'messages.hidden.listed', count: 1 });
    expect(listed).not.toHaveProperty('messageId');
    expect(listed).not.toHaveProperty('text');
    expect(JSON.stringify(listed)).not.toContain('hide me');
    expect(JSON.stringify(listed)).not.toContain(NOTE_ID);
  });

  it('does not require forum.read', async () => {
    const auth = await seededStore();
    const account = await auth.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...account, role: 'founder' });
    const gated = await mount(auth).request('/messages', { headers: AUTH });
    expect(gated.status).toBe(409);
    const res = await mount(auth).request('/messages/hidden', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });
});
