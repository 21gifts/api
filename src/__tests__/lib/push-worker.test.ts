import { describe, expect, it, vi } from 'vitest';
import type { PushSendResult, PushSender } from '@/lib/push-sender';
import {
  InMemoryPushStore,
  type PushOutboxRow,
  type PushSubscriptionRecord,
} from '@/lib/push-store';
import {
  PUSH_WORKER_BATCH,
  PUSH_WORKER_INTERVAL_MS,
  PUSH_WORKER_LEASE_MS,
  enqueueDebugPush,
  enqueueForumPushes,
  enqueueZapPush,
  runPushWorkerTick,
  startPushWorker,
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
};

const SUB_B: PushSubscriptionRecord = {
  endpoint: 'https://push.example/b',
  accountId: 'other',
  p256dh: 'p',
  auth: 'a',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('push worker constants', () => {
  it('exports batch, lease, and interval numbers', () => {
    expect(PUSH_WORKER_BATCH).toBe(20);
    expect(PUSH_WORKER_LEASE_MS).toBe(60_000);
    expect(PUSH_WORKER_INTERVAL_MS).toBe(2_000);
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
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({ type: 'forum', tag: 'forum' });
  });

  it('enqueues nothing when only the author is subscribed', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await enqueueForumPushes(store, 'author', 'msg-1', 1);
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });
});

describe('enqueueZapPush', () => {
  it('enqueues when the author has subscriptions', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_A);
    await enqueueZapPush(store, 'author', 'msg-9', 5);
    const claimed = await store.claimPending(10, 5, 1000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe('zap');
    expect(claimed[0]?.deliveredEndpoints).toEqual([]);
    expect(JSON.parse(claimed[0]?.payload ?? '{}').tag).toBe('zap:msg-9');
  });

  it('does nothing when the author has no subscriptions', async () => {
    const store = new InMemoryPushStore();
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
  it('returns immediately when sender is unconfigured', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(false);
    await runPushWorkerTick({ store, sender, now: () => 1 });
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
      createdAt: new Date(1),
      deliveredEndpoints: [],
    };
    await store.enqueue(row);
    const sender = new FakeSender(true);
    await runPushWorkerTick({ store, sender, now: () => 1 });
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });

  it('deletes gone subscriptions and marks sent when all gone', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'gone' }]);
    await runPushWorkerTick({ store, sender, now: () => 1 });
    expect(await store.listByAccount('other')).toEqual([]);
    expect(await store.claimPending(10, 1, 1000)).toEqual([]);
  });

  it('marks failed when any send fails', async () => {
    const store = new InMemoryPushStore();
    await store.upsertSubscription(SUB_B);
    await enqueueForumPushes(store, 'author', 'm', 1);
    const sender = new FakeSender(true, [{ ok: false, reason: 'fail' }]);
    await runPushWorkerTick({ store, sender, now: () => 1 });
    const again = await store.claimPending(10, 1, 1000);
    expect(again).toHaveLength(1);
    expect(again[0]?.attempts).toBe(1);
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
    await runPushWorkerTick({ store, sender, now: () => 1 });
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
    await runPushWorkerTick({ store, sender, now: () => 1 });
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
    await runPushWorkerTick({ store, sender, now: () => 1 });
    expect(sender.calls).toHaveLength(2);
    const afterFail = await store.claimPending(10, 1, 1000);
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0]?.attempts).toBe(1);
    expect(afterFail[0]?.deliveredEndpoints).toEqual(['https://push.example/a']);

    sender.results = [{ ok: true }];
    // Previous claimPending held a lease; advance past it so the retry can claim.
    await runPushWorkerTick({ store, sender, now: () => 2_000 });
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
    await runPushWorkerTick({ store, sender, now: () => 1 });
    expect(sender.calls).toHaveLength(2);
    await store.deleteSubscription('other', 'https://push.example/b');
    const callsBefore = sender.calls.length;
    sender.results = [{ ok: true }];
    await runPushWorkerTick({ store, sender, now: () => 2 });
    expect(sender.calls).toHaveLength(callsBefore);
    expect(await store.claimPending(10, 2, 1000)).toEqual([]);
  });
});

describe('startPushWorker', () => {
  it('returns a stop handle that clears the interval', () => {
    vi.useFakeTimers();
    const store = new InMemoryPushStore();
    const sender = new FakeSender(false);
    const handle = startPushWorker({ store, sender, now: () => 1 }, 5_000);
    handle.stop();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
  });
});
