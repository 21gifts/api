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

import { UnconfiguredPushSender, WebPushSender, webPushTopicFromTag } from '@/lib/push-sender';

const SUB: PushSubscriptionRecord = {
  endpoint: 'https://push.example/a',
  accountId: 'acc',
  p256dh: 'p256',
  auth: 'auth',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('webPushTopicFromTag', () => {
  it('strips colons from production tags and stays within RFC 8030', () => {
    const forumPost = webPushTopicFromTag('forum_post:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(forumPost).toBe('forum_postaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'.slice(0, 32));
    expect(forumPost).toBe('forum_postaaaaaaaa-bbbb-cccc-ddd');
    expect(forumPost?.includes(':')).toBe(false);
    expect(forumPost?.length).toBeLessThanOrEqual(32);
    expect(forumPost).toMatch(/^[A-Za-z0-9_-]+$/);

    const forumReply = webPushTopicFromTag('forum_reply:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(forumReply?.includes(':')).toBe(false);
    expect(forumReply).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(forumReply?.length).toBeLessThanOrEqual(32);

    const zap = webPushTopicFromTag('zap:42');
    expect(zap).toBe('zap42');
    expect(zap?.includes(':')).toBe(false);
  });

  it('truncates to 32 allowed characters', () => {
    const topic = webPushTopicFromTag('abcdefghijklmnopqrstuvwxyz0123456789_-XXXX');
    expect(topic).toBe('abcdefghijklmnopqrstuvwxyz012345');
    expect(topic).toHaveLength(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns undefined when empty after sanitizing', () => {
    expect(webPushTopicFromTag('')).toBeUndefined();
    expect(webPushTopicFromTag('😀😀')).toBeUndefined();
    expect(webPushTopicFromTag(':::')).toBeUndefined();
  });

  it('drops emoji and keeps hyphens', () => {
    expect(webPushTopicFromTag('forum-😀-post')).toBe('forum--post');
    expect(webPushTopicFromTag('forum😀-post')).toBe('forum-post');
  });
});

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

    const productionPayload = JSON.stringify({ tag: 'forum_post:msg-1' });
    expect(await sender.send(SUB, productionPayload)).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: 'p256', auth: 'auth' } },
      productionPayload,
      {
        TTL: 86400,
        urgency: 'high',
        topic: 'forum_postmsg-1',
      },
    );
    const productionOptions = sendNotification.mock.calls[0]?.[2] as { topic: string };
    expect(productionOptions.topic).toBe('forum_postmsg-1');
    expect(productionOptions.topic.includes(':')).toBe(false);
    expect(productionOptions.topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(productionOptions.topic.length).toBeLessThanOrEqual(32);

    const payload = JSON.stringify({ tag: 'forum-😀-extra-long-tag-value-here' });
    expect(await sender.send(SUB, payload)).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: 'p256', auth: 'auth' } },
      payload,
      expect.objectContaining({
        TTL: 86400,
        urgency: 'high',
        topic: expect.stringMatching(/^forum-/),
      }),
    );
    const options = sendNotification.mock.calls[1]?.[2] as { topic: string };
    expect(options.topic.includes(':')).toBe(false);
    expect(options.topic.includes('😀')).toBe(false);
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(options.topic.length).toBeLessThanOrEqual(32);
  });

  it('omits topic when payload JSON is invalid or tag missing', async () => {
    sendNotification.mockResolvedValue(undefined);
    const sender = new WebPushSender({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://21.gifts',
    });
    await sender.send(SUB, 'not-json');
    expect(sendNotification.mock.calls[0]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, JSON.stringify({ title: 'x' }));
    expect(sendNotification.mock.calls[1]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, JSON.stringify({ tag: '😀😀' }));
    expect(sendNotification.mock.calls[2]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, 'null');
    expect(sendNotification.mock.calls[3]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, '"x"');
    expect(sendNotification.mock.calls[4]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, JSON.stringify({ tag: '' }));
    expect(sendNotification.mock.calls[5]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
    await sender.send(SUB, JSON.stringify({ tag: ':::' }));
    expect(sendNotification.mock.calls[6]?.[2]).toEqual({ TTL: 86400, urgency: 'high' });
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
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail', status: 500 });
    sendNotification.mockRejectedValueOnce({ statusCode: 400 });
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail', status: 400 });
    sendNotification.mockRejectedValueOnce('boom');
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
    sendNotification.mockRejectedValueOnce(null);
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
    sendNotification.mockRejectedValueOnce({ statusCode: '410' });
    expect(await sender.send(SUB, '{}')).toEqual({ ok: false, reason: 'fail' });
  });
});
