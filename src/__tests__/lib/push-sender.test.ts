import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscriptionRecord } from '@/lib/push-store';

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

import { UnconfiguredPushSender, WebPushSender } from '@/lib/push-sender';

const SUB: PushSubscriptionRecord = {
  endpoint: 'https://push.example/a',
  accountId: 'acc',
  p256dh: 'p256',
  auth: 'auth',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('UnconfiguredPushSender', () => {
  it('reports not configured and refuses send', async () => {
    const sender = new UnconfiguredPushSender();
    expect(sender.isConfigured()).toBe(false);
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('WebPushSender', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
  });

  it('sets VAPID details and sends with TTL and topic from tag', async () => {
    sendNotification.mockResolvedValue(undefined);
    const sender = new WebPushSender({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://21.gifts',
    });
    expect(setVapidDetails).toHaveBeenCalledWith('https://21.gifts', 'pub', 'priv');
    expect(sender.isConfigured()).toBe(true);
    const payload = JSON.stringify({ tag: 'forum-😀-extra-long-tag-value-here' });
    expect(await sender.send(SUB, payload)).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: 'p256', auth: 'auth' } },
      payload,
      expect.objectContaining({
        TTL: 86400,
        topic: expect.stringMatching(/^forum-/),
      }),
    );
    const options = sendNotification.mock.calls[0]?.[2] as { topic: string };
    expect(options.topic.length).toBeLessThanOrEqual(32);
    expect(options.topic.includes('😀')).toBe(false);
  });

  it('omits topic when payload JSON is invalid or tag missing', async () => {
    sendNotification.mockResolvedValue(undefined);
    const sender = new WebPushSender({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://21.gifts',
    });
    await sender.send(SUB, 'not-json');
    expect(sendNotification.mock.calls[0]?.[2]).toEqual({ TTL: 86400 });
    await sender.send(SUB, JSON.stringify({ title: 'x' }));
    expect(sendNotification.mock.calls[1]?.[2]).toEqual({ TTL: 86400 });
    await sender.send(SUB, JSON.stringify({ tag: '😀😀' }));
    expect(sendNotification.mock.calls[2]?.[2]).toEqual({ TTL: 86400 });
    await sender.send(SUB, 'null');
    expect(sendNotification.mock.calls[3]?.[2]).toEqual({ TTL: 86400 });
    await sender.send(SUB, '"x"');
    expect(sendNotification.mock.calls[4]?.[2]).toEqual({ TTL: 86400 });
  });

  it('maps 404/410 to gone and other errors to fail', async () => {
    const sender = new WebPushSender({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://21.gifts',
    });
    sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'gone' });
    sendNotification.mockRejectedValueOnce({ statusCode: 404 });
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'gone' });
    sendNotification.mockRejectedValueOnce({ statusCode: 500 });
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
    sendNotification.mockRejectedValueOnce('boom');
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
    sendNotification.mockRejectedValueOnce(null);
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
  });
});
