import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { SESSION_TTL_MS } from '@/lib/config';
import type { PushSendResult, PushSender } from '@/lib/push-sender';
import {
  InMemoryPushStore,
  type PushOutboxRow,
  type PushSubscriptionRecord,
} from '@/lib/push-store';

const logEvent = vi.fn();
vi.mock('@/lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log')>()),
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import {
  PUSH_OUTBOX_RETENTION_MS,
  PUSH_SWEEP_INTERVAL_MS,
  PUSH_WORKER_BATCH,
  PUSH_WORKER_INTERVAL_MS,
  PUSH_WORKER_LEASE_MS,
  enqueueDebugPush,
  enqueueForumPushes,
  enqueueReplyPush,
  enqueueZapPush,
  runPushWorkerTick,
  startPushWorker,
  sweepPushStore,
} from '@/lib/push-worker';

class FakeSender implements PushSender {
  configured: boolean;
  results: PushSendResult[];
  calls: { endpoint: string; payload: string }[] = [];

  constructor(configured = true, results: PushSendResult[] = [{ ok: true }]) {
    this.configured = configured;
    this.results = results;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  send(sub: PushSubscriptionRecord, payload: string): Promise<PushSendResult> {
    this.calls.push({ endpoint: sub.endpoint, payload });
    const next = this.results.shift() ?? { ok: true };
    return Promise.resolve(next);
  }
}

const SUB_A: PushSubscriptionRecord = {
  endpoint: 'https://push.example/a',
  accountId: 'author',
  p256dh: 'p',
  auth: 'a',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  sessionToken: 'tok-author',
};

const SUB_B: PushSubscriptionRecord = {
  endpoint: 'https://push.example/b',
  accountId: 'other',
  p256dh: 'p',
  auth: 'a',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  sessionToken: 'tok-other',
};

const SUB_C: PushSubscriptionRecord = {
  endpoint: 'https://push.example/c',
  accountId: 'third',
  p256dh: 'p',
  auth: 'a',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  sessionToken: 'tok-third',
};

/** Session clock origin; every seeded session is issued here. */
const SESSION_AT = 0;

/** Auth store with one live session `tok-<id>` per account id. */
async function authWithSessions(
  ids: readonly string[],
  refused: readonly string[] = [],
): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  for (const [index, id] of ids.entries()) {
    await auth.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: index.toString(16).padStart(64, '0'),
      createdAt: SESSION_AT,
      rulesAgreedAt: null,
      sessionRefused: refused.includes(id),
    });
    await auth.createSession({ token: `tok-${id}`, accountId: id, createdAt: SESSION_AT });
  }
  return auth;
}

let auth: InMemoryAuthStore;

beforeEach(async () => {
  logEvent.mockReset();
  vi.restoreAllMocks();
  auth = await authWithSessions(['author', 'other', 'third']);
});

describe('push worker constants', () => {
  it('exports batch, lease, interval, sweep, and retention numbers', () => {
    expect(PUSH_WORKER_BATCH).toBe(20);
    expect(PUSH_WORKER_LEASE_MS).toBe(60_000);
    expect(PUSH_WORKER_INTERVAL_MS).toBe(2_000);
    expect(PUSH_SWEEP_INTERVAL_MS).toBe(3_600_000);
    expect(PUSH_OUTBOX_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('enqueueForumPushes', () => {
  it('skips the author and enqueues one row per other subscriber', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'msg-1', 1_700_000_000_000);
    const claimed = await store.claimPending(10, 1_700_000_000_000, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('other');
    expect(claimed[0]?.type).toBe('forum');
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      type: 'forum',
      tag: 'forum_post:msg-1',
      title: 'Someone',
      body: 'Posted in the living room.',
      url: '/messages/msg-1',
    });
  });

  it('enqueues nothing when only the author is subscribed', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await enqueueForumPushes(store, 'author', 'msg-1', 1);
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });
});

describe('enqueueReplyPush', () => {
  it('enqueues one row per subscriber besides the skip id', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await store.upsertSubscription(SUB_B);
    await store.upsertSubscription(SUB_C);
    await enqueueReplyPush(store, 'author', 'reply-1', 'parent-9', 5);
    const claimed = await store.claimPending(10, 5, 1000);
    expect(claimed).toHaveLength(2);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['other', 'third']);
    expect(claimed[0]?.type).toBe('forum');
    expect(claimed[0]?.messageId).toBe('reply-1');
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      title: 'Someone',
      body: 'Replied in the living room.',
      url: '/messages/reply-1',
      tag: 'forum_reply:reply-1',
    });
  });

  it('does nothing when nobody else is subscribed', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await enqueueReplyPush(store, 'author', 'reply-1', 'parent-9', 5);
    expect(await store.claimPending(10, 5, 1000)).toEqual([]);
  });
});

describe('enqueueZapPush', () => {
  it('enqueues one row per subscriber besides the payer skip id', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await store.upsertSubscription(SUB_B);
    await store.upsertSubscription(SUB_C);
    await enqueueZapPush(store, 'author', 'msg-9', 5);
    const claimed = await store.claimPending(10, 5, 1000);
    expect(claimed).toHaveLength(2);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['other', 'third']);
    expect(claimed[0]?.type).toBe('zap');
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      title: 'Someone',
      body: 'Sent 0 sats.',
      url: '/messages/msg-9',
      tag: 'zap:msg-9',
    });
  });

  it('does nothing when nobody else is subscribed', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await enqueueZapPush(store, 'author', 'msg-9', 5);
    expect(await store.claimPending(10, 5, 1000)).toEqual([]);
  });
});

describe('enqueueDebugPush', () => {
  it('returns 0 or 1 and uses the debug payload', async () => {
    const store = new InMemoryPushStore();
    expect(await enqueueDebugPush(store, 'author', 1)).toBe(0);
    await store.upsertSubscription(SUB_A);
    expect(await enqueueDebugPush(store, 'author', 2)).toBe(1);
    const claimed = await store.claimPending(10, 2, 1000);
    expect(claimed[0]?.messageId).toBeNull();
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      type: 'zap',
      tag: 'debug',
      title: 'Test notification',
    });
  });
});

describe('runPushWorkerTick', () => {
  beforeEach(() => {
    logEvent.mockReset();
  });

  it('returns immediately when sender is unconfigured', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(false);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toEqual([]);
    expect(await store.claimPending(10, 1, 1000)).toHaveLength(1);
  });

  it('marks sent when there are no subscriptions left', async () => {
    const store = new InMemoryPushStore();
    const row: PushOutboxRow = {
      id: 'o1',
      accountId: 'ghost',
      type: 'forum',
      messageId: 'm',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(1),
      deliveredEndpoints: [],
      skipEndpoints: [],
    };
    await store.enqueue(row);
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
    expect((await store.listAllOutbox(10))[0]?.status).toBe('sent');
    expect(sender.calls).toEqual([]);
  });

  it('marks sent without sending when every subscription is skipped', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await store.enqueue({
      id: 'dismiss-all-skipped',
      accountId: 'other',
      type: 'dismiss',
      messageId: null,
      payload: JSON.stringify({ type: 'dismiss', tags: ['forum_post:m'], unreadCount: 0 }),
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(1),
      deliveredEndpoints: [],
      skipEndpoints: [SUB_B.endpoint],
    });
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toEqual([]);
    expect((await store.listAllOutbox(10))[0]).toMatchObject({
      status: 'sent',
      deliveredEndpoints: [],
    });
  });

  it('skips one device and sends the same dismiss payload to another device', async () => {
    const store = new InMemoryPushStore();
    const skipped = { ...SUB_B, endpoint: 'https://push.example/skipped' };
    const target = { ...SUB_B, endpoint: 'https://push.example/target' };
    await store.upsertSubscription(skipped);
    await store.upsertSubscription(target);
    const payload = JSON.stringify({
      type: 'dismiss',
      tags: ['forum_reply:message'],
      unreadCount: 2,
    });
    await store.enqueue({
      id: 'dismiss-one-skipped',
      accountId: 'other',
      type: 'dismiss',
      messageId: null,
      payload,
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(1),
      deliveredEndpoints: [],
      skipEndpoints: [skipped.endpoint],
    });
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toEqual([{ endpoint: target.endpoint, payload }]);
    expect(sender.calls[0]?.payload).not.toContain(skipped.endpoint);
    expect((await store.listAllOutbox(10))[0]).toMatchObject({
      status: 'sent',
      deliveredEndpoints: [target.endpoint],
    });
  });

  it('keeps a gone endpoint that a re-POST rebound to another session during the send', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'gone' }]);
    const send = sender.send.bind(sender);
    vi.spyOn(sender, 'send').mockImplementation(async (sub, payload) => {
      await store.upsertSubscription({ ...SUB_B, sessionToken: 'tok-other-2' });
      return send(sub, payload);
    });
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect((await store.listByAccount('other')).map((sub) => sub.sessionToken)).toEqual([
      'tok-other-2',
    ]);
  });

  it('deletes gone subscriptions and marks sent when all gone', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'gone' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(await store.listByAccount('other')).toEqual([]);
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });

  it('marks failed when any send fails', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.attempts).toBe(1);
    expect(logEvent).toHaveBeenCalledWith('push.send.failed');
    expect(logEvent.mock.calls[0]).toEqual(['push.send.failed']);
  });

  it('logs numeric HTTP status on push.send.failed', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail', status: 400 }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.attempts).toBe(1);
    expect(logEvent).toHaveBeenCalledWith('push.send.failed', { status: 400 });
    expect(logEvent.mock.calls[0]?.[1]).toEqual({ status: 400 });
  });

  it('marks sent when at least one ok and none fail (gone ok)', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await store.upsertSubscription({
      ...SUB_B,
      endpoint: 'https://push.example/c',
    });
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: true }, { ok: false, reason: 'gone' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const remaining = await store.listByAccount('other');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.endpoint).toBe('https://push.example/b');
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });

  it('treats not_configured mid-send as fail', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'not_configured' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again[0]?.attempts).toBe(1);
  });

  it('skips already-delivered endpoints on mixed-device retry', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription({
      ...SUB_B,
      endpoint: 'https://push.example/a',
    });
    await store.upsertSubscription({
      ...SUB_B,
      endpoint: 'https://push.example/b',
    });
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: true }, { ok: false, reason: 'fail' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toHaveLength(2);
    const afterFail = await store.claimPending(10, 1, 1000);
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0]?.attempts).toBe(1);
    expect(afterFail[0]?.deliveredEndpoints).toEqual(['https://push.example/a']);

    sender.results = [{ ok: true }];
    // Previous claimPending held a lease; advance past it so the retry can claim.
    await runPushWorkerTick({ store, sender, now: () => 2_000, authStore: auth });
    expect(sender.calls).toHaveLength(3);
    expect(sender.calls[2]?.endpoint).toBe('https://push.example/b');
    expect(await store.claimPending(10, 2_000, 1000)).toEqual([]);
  });

  it('marks sent without sending when every remaining subscription was already delivered', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription({
      ...SUB_B,
      endpoint: 'https://push.example/a',
    });
    await store.upsertSubscription({
      ...SUB_B,
      endpoint: 'https://push.example/b',
    });
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: true }, { ok: false, reason: 'fail' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toHaveLength(2);
    await store.deleteSubscription('other', 'https://push.example/b');
    const callsBefore = sender.calls.length;
    sender.results = [{ ok: true }];
    await runPushWorkerTick({ store, sender, now: () => 2, authStore: auth });
    expect(sender.calls).toHaveLength(callsBefore);
    expect(await store.claimPending(10, 2, 1000)).toEqual([]);
  });

  it('marks sent when a failed content send is dismissed in the same claim', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const forumRow = (await store.listAllOutbox(10))[0];
    const tag = JSON.parse(forumRow?.payload ?? '{}').tag;
    await store.enqueue({
      id: 'dismiss-same-claim-tag',
      accountId: forumRow?.accountId ?? 'other',
      type: 'dismiss',
      messageId: null,
      payload: JSON.stringify({ type: 'dismiss', tags: [tag], unreadCount: 0 }),
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(2),
      deliveredEndpoints: [],
      skipEndpoints: [],
    });
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }, { ok: true }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(await store.claimPending(10, 70_000, 1000)).toEqual([]);
    const listed = await store.listAllOutbox(10);
    expect(listed.find((row) => row.id === forumRow?.id)?.status).toBe('sent');
    expect(listed.find((row) => row.id === 'dismiss-same-claim-tag')?.status).toBe('sent');
    const forumPayload = forumRow?.payload;
    const callsAfterFirst = sender.calls.length;
    await runPushWorkerTick({ store, sender, now: () => 70_000, authStore: auth });
    expect(sender.calls).toHaveLength(callsAfterFirst);
    expect(sender.calls.filter((call) => call.payload === forumPayload)).toHaveLength(1);
  });

  it('marks failed when the same tag is dismissed for another account', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const forumRow = (await store.listAllOutbox(10))[0];
    const tag = JSON.parse(forumRow?.payload ?? '{}').tag;
    await store.enqueue({
      id: 'dismiss-other-account',
      accountId: 'author',
      type: 'dismiss',
      messageId: null,
      payload: JSON.stringify({ type: 'dismiss', tags: [tag], unreadCount: 0 }),
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(2),
      deliveredEndpoints: [],
      skipEndpoints: [],
    });
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(forumRow?.id);
    expect(again[0]?.attempts).toBe(1);
    const listed = await store.listAllOutbox(10);
    expect(listed.find((row) => row.id === 'dismiss-other-account')?.status).toBe('sent');
  });

  it('marks failed when same-claim dismiss tags omit the content tag', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const forumRow = (await store.listAllOutbox(10))[0];
    await store.enqueue({
      id: 'dismiss-other-tag',
      accountId: forumRow?.accountId ?? 'other',
      type: 'dismiss',
      messageId: null,
      payload: JSON.stringify({
        type: 'dismiss',
        tags: ['forum_post:other'],
        unreadCount: 0,
      }),
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(2),
      deliveredEndpoints: [],
      skipEndpoints: [],
    });
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }, { ok: true }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(forumRow?.id);
    expect(again[0]?.attempts).toBe(1);
  });

  it.each(['{', 'null', '1', '{"tag":""}', '{"tag":1}'])(
    'marks failed when content payload is %j',
    async (contentPayload) => {
      const store = new InMemoryPushStore();
      await store.upsertSubscription(SUB_B);
      await store.enqueue({
        id: 'content-bad-payload',
        accountId: 'other',
        type: 'forum',
        messageId: 'm',
        payload: contentPayload,
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        finishedAt: null,
        createdAt: new Date(1),
        deliveredEndpoints: [],
        skipEndpoints: [],
      });
      await store.enqueue({
        id: 'dismiss-well-formed',
        accountId: 'other',
        type: 'dismiss',
        messageId: null,
        payload: JSON.stringify({ type: 'dismiss', tags: ['forum_post:covered'], unreadCount: 0 }),
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        finishedAt: null,
        createdAt: new Date(2),
        deliveredEndpoints: [],
        skipEndpoints: [],
      });
      const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }, { ok: true }]);
      await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
      const again = await store.claimPending(10, 1, 1000);
      expect(again).toHaveLength(1);
      expect(again[0]?.id).toBe('content-bad-payload');
      expect(again[0]?.attempts).toBe(1);
      const listed = await store.listAllOutbox(10);
      expect(listed.find((row) => row.id === 'dismiss-well-formed')?.status).toBe('sent');
    },
  );

  it.each([
    '{',
    'null',
    '1',
    '{"type":"nope"}',
    '{"type":"dismiss"}',
    '{"type":"dismiss","tags":[1]}',
  ])('marks failed when same-claim dismiss payload is %j', async (dismissPayload) => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const forumRow = (await store.listAllOutbox(10))[0];
    await store.enqueue({
      id: 'dismiss-bad-payload',
      accountId: forumRow?.accountId ?? 'other',
      type: 'dismiss',
      messageId: null,
      payload: dismissPayload,
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      finishedAt: null,
      createdAt: new Date(2),
      deliveredEndpoints: [],
      skipEndpoints: [],
    });
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }, { ok: true }]);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(forumRow?.id);
    expect(again[0]?.attempts).toBe(1);
    const listed = await store.listAllOutbox(10);
    expect(listed.find((row) => row.id === 'dismiss-bad-payload')?.status).toBe('sent');
  });
});

describe('startPushWorker', () => {
  it('returns a stop handle that clears the interval', () => {
    vi.useFakeTimers();
    const store = new InMemoryPushStore();
    const sender = new FakeSender(false);
    const handle = startPushWorker({ store, sender, now: () => 1, authStore: auth }, 5_000);
    handle.stop();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
  });

  it('logs push.tick.failed without the error text and keeps ticking', async () => {
    vi.useFakeTimers();
    const store = new InMemoryPushStore();
    const claim = vi
      .spyOn(store, 'claimPending')
      .mockRejectedValueOnce(
        Object.assign(new Error('token tok-secret in params'), { code: 'ERR_POSTGRES' }),
      );
    const handle = startPushWorker(
      { store, sender: new FakeSender(true), now: () => 1, authStore: auth },
      1_000,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logEvent).toHaveBeenCalledWith('push.tick.failed', {
      name: 'Error',
      code: 'ERR_POSTGRES',
    });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain('tok-secret');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);
    handle.stop();
    vi.useRealTimers();
  });

  it('skips a tick while the previous one is still running', async () => {
    vi.useFakeTimers();
    const store = new InMemoryPushStore();
    let release: () => void = () => undefined;
    const claim = vi.spyOn(store, 'claimPending').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const handle = startPushWorker(
      { store, sender: new FakeSender(true), now: () => 1, authStore: auth },
      1_000,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(claim).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);
    handle.stop();
    vi.useRealTimers();
  });

  it('sweeps once at start and again every PUSH_SWEEP_INTERVAL_MS until stopped', async () => {
    vi.useFakeTimers();
    const store = new InMemoryPushStore();
    const sweepSpy = vi.spyOn(store, 'deleteFinishedOutbox');
    const handle = startPushWorker(
      { store, sender: new FakeSender(false), now: () => 1, authStore: auth },
      PUSH_SWEEP_INTERVAL_MS * 2,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PUSH_SWEEP_INTERVAL_MS);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(PUSH_SWEEP_INTERVAL_MS * 3);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each([
    [
      Object.assign(new Error('token tok-secret in params'), { code: 'ERR_POSTGRES' }),
      { name: 'Error', code: 'ERR_POSTGRES' },
    ],
    ['tok-secret', {}],
  ])(
    'logs push.sweep.failed without the error text when the sweep rejects with %j',
    async (thrown, fields) => {
      vi.useFakeTimers();
      const store = new InMemoryPushStore();
      vi.spyOn(store, 'listAllSubscriptions').mockRejectedValue(thrown);
      const handle = startPushWorker(
        { store, sender: new FakeSender(false), now: () => 1, authStore: auth },
        PUSH_SWEEP_INTERVAL_MS * 2,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(logEvent).toHaveBeenCalledWith('push.sweep.failed', fields);
      expect(JSON.stringify(logEvent.mock.calls)).not.toContain('tok-secret');
      handle.stop();
      vi.useRealTimers();
    },
  );
});

describe('runPushWorkerTick session binding', () => {
  it.each([
    ['has no session (stored before binding)', { sessionToken: null }],
    ['names an unknown session', { sessionToken: 'tok-unknown' }],
    ['names a session of another account', { sessionToken: 'tok-author' }],
  ])('deletes a subscription that %s instead of sending', async (_label, overrides) => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription({ ...SUB_B, ...overrides });
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls).toEqual([]);
    expect(await store.listByAccount('other')).toEqual([]);
    expect((await store.listAllOutbox(10))[0]?.status).toBe('sent');
  });

  it('deletes a subscription once its session expires and keeps sending before that', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    const sender = new FakeSender(true);
    await enqueueForumPushes(store, 'author', 'm1', 1);
    await runPushWorkerTick({
      store,
      sender,
      now: () => SESSION_AT + SESSION_TTL_MS,
      authStore: auth,
    });
    expect(sender.calls).toHaveLength(1);
    await enqueueForumPushes(store, 'author', 'm2', 2);
    await runPushWorkerTick({
      store,
      sender,
      now: () => SESSION_AT + SESSION_TTL_MS + 1,
      authStore: auth,
    });
    expect(sender.calls).toHaveLength(1);
    expect(await store.listByAccount('other')).toEqual([]);
  });

  it('deletes a subscription whose account is refused sessions', async () => {
    const refusedAuth = await authWithSessions(['other'], ['other']);
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: refusedAuth });
    expect(sender.calls).toEqual([]);
    expect(await store.listByAccount('other')).toEqual([]);
  });

  it('sends to a live device and drops a dead one of the same account in one row', async () => {
    const store = new InMemoryPushStore();
    const live = { ...SUB_B, endpoint: 'https://push.example/live' };
    const dead = { ...SUB_B, endpoint: 'https://push.example/dead', sessionToken: 'tok-gone' };
    await store.upsertSubscription(live);
    await store.upsertSubscription(dead);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1, authStore: auth });
    expect(sender.calls.map((call) => call.endpoint)).toEqual([live.endpoint]);
    expect((await store.listByAccount('other')).map((sub) => sub.endpoint)).toEqual([
      live.endpoint,
    ]);
    expect((await store.listAllOutbox(10))[0]).toMatchObject({
      status: 'sent',
      deliveredEndpoints: [live.endpoint],
    });
  });

  it('stamps finishedAt with the tick clock on sent and terminal failed rows', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    await runPushWorkerTick({
      store,
      sender: new FakeSender(true),
      now: () => 42,
      authStore: auth,
    });
    expect((await store.listAllOutbox(10))[0]?.finishedAt?.getTime()).toBe(42);
  });
});

describe('sweepPushStore', () => {
  it('deletes subscriptions whose session ended and keeps live ones', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await store.upsertSubscription({ ...SUB_B, sessionToken: null });
    await store.upsertSubscription({ ...SUB_C, sessionToken: 'tok-revoked' });
    const result = await sweepPushStore({ store, now: () => 1, authStore: auth });
    expect(result).toEqual({ subscriptions: 2, outbox: 0 });
    expect((await store.listAllSubscriptions()).map((sub) => sub.endpoint)).toEqual([
      SUB_A.endpoint,
    ]);
    expect(logEvent).toHaveBeenCalledWith('push.sweep', { subscriptions: 2, outbox: 0 });
  });

  it('deletes every subscription once all sessions expired', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await store.upsertSubscription(SUB_B);
    const result = await sweepPushStore({
      store,
      now: () => SESSION_AT + SESSION_TTL_MS + 1,
      authStore: auth,
    });
    expect(result.subscriptions).toBe(2);
    expect(await store.listAllSubscriptions()).toEqual([]);
  });

  it('does not count a subscription removed concurrently', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription({ ...SUB_B, sessionToken: null });
    vi.spyOn(store, 'deleteStaleSubscription').mockResolvedValue(false);
    expect(await sweepPushStore({ store, now: () => 1, authStore: auth })).toEqual({
      subscriptions: 0,
      outbox: 0,
    });
  });

  it('keeps a subscription that was rebound to a live session after the scan read it', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription({ ...SUB_B, sessionToken: null });
    const listAll = store.listAllSubscriptions.bind(store);
    vi.spyOn(store, 'listAllSubscriptions').mockImplementation(async () => {
      const snapshot = await listAll();
      // The device re-registers from its live session between scan and delete.
      await store.upsertSubscription(SUB_B);
      return snapshot;
    });
    expect(await sweepPushStore({ store, now: () => 1, authStore: auth })).toEqual({
      subscriptions: 0,
      outbox: 0,
    });
    expect((await store.listByAccount('other')).map((sub) => sub.sessionToken)).toEqual([
      'tok-other',
    ]);
  });

  it('deletes only terminal outbox rows older than PUSH_OUTBOX_RETENTION_MS', async () => {
    const store = new InMemoryPushStore();
    const now = PUSH_OUTBOX_RETENTION_MS + 10_000;
    const base: PushOutboxRow = {
      id: '',
      accountId: 'other',
      type: 'forum',
      messageId: 'm',
      payload: '{}',
      status: 'sent',
      attempts: 0,
      claimedUntil: null,
      finishedAt: new Date(5_000),
      createdAt: new Date(1_000),
      deliveredEndpoints: [],
      skipEndpoints: [],
    };
    await store.enqueue({ ...base, id: 'old-sent' });
    await store.enqueue({ ...base, id: 'old-failed', status: 'failed', attempts: 8 });
    await store.enqueue({ ...base, id: 'old-pending', status: 'pending', finishedAt: null });
    await store.enqueue({ ...base, id: 'recent-sent', finishedAt: new Date(now - 1_000) });
    const result = await sweepPushStore({ store, now: () => now, authStore: auth });
    expect(result).toEqual({ subscriptions: 0, outbox: 2 });
    expect((await store.listAllOutbox(10)).map((row) => row.id).sort()).toEqual([
      'old-pending',
      'recent-sent',
    ]);
  });

  it('logs nothing when nothing was deleted', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    expect(await sweepPushStore({ store, now: () => 1, authStore: auth })).toEqual({
      subscriptions: 0,
      outbox: 0,
    });
    expect(logEvent).not.toHaveBeenCalledWith('push.sweep', expect.anything());
  });
});
