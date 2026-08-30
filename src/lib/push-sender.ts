/**
 * Web Push delivery collaborator (VAPID via `web-push`).
 */

import webpush from 'web-push';
import type { VapidConfig } from '@/lib/push-config';
import type { PushSubscriptionRecord } from '@/lib/push-store';

/** Outcome of one `send` attempt. */
export type PushSendResult =
  { ok: true } | { ok: false; reason: 'gone' | 'fail' | 'not_configured' };

/**
 * Sends a JSON payload to one browser subscription.
 */
export interface PushSender {
  /**
   * Whether VAPID is configured and sends may succeed.
   *
   * @returns Configuration flag.
   */
  isConfigured(): boolean;

  /**
   * Deliver `payload` to `sub`.
   *
   * @param sub - Target subscription.
   * @param payload - JSON string body.
   * @returns Send outcome.
   */
  send(sub: PushSubscriptionRecord, payload: string): Promise<PushSendResult>;
}

/**
 * No-op sender used when VAPID env is missing. Process still boots.
 */
export class UnconfiguredPushSender implements PushSender {
  /**
   * Always false.
   *
   * @returns `false`.
   */
  isConfigured(): boolean {
    return false;
  }

  /**
   * Refuse delivery.
   *
   * @param _sub - Unused.
   * @param _payload - Unused.
   * @returns `{ ok: false, reason: 'not_configured' }`.
   */
  send(_sub: PushSubscriptionRecord, _payload: string): Promise<PushSendResult> {
    return Promise.resolve({ ok: false, reason: 'not_configured' });
  }
}

/** Extract a Web Push HTTP status from a thrown error when present. */
function statusCodeOf(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') {
    return undefined;
  }
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : undefined;
}

/** Build an optional ASCII topic from payload JSON `tag` (max 32). */
function topicFromPayload(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    const tag = (parsed as { tag?: unknown }).tag;
    if (typeof tag !== 'string') {
      return undefined;
    }
    const ascii = [...tag].filter((ch) => ch.charCodeAt(0) <= 127).join('');
    if (ascii === '') {
      return undefined;
    }
    return ascii.slice(0, 32);
  } catch {
    return undefined;
  }
}

/**
 * VAPID Web Push sender using the `web-push` package.
 */
export class WebPushSender implements PushSender {
  /**
   * @param config - Resolved VAPID credentials.
   */
  constructor(config: VapidConfig) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  /**
   * Always true for a constructed sender.
   *
   * @returns `true`.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Call `web-push` `sendNotification`. Maps 404/410 to `gone`.
   *
   * @param sub - Target subscription.
   * @param payload - JSON string body.
   * @returns Send outcome.
   */
  async send(sub: PushSubscriptionRecord, payload: string): Promise<PushSendResult> {
    const topic = topicFromPayload(payload);
    const options: {
      TTL: number;
      topic?: string;
    } = { TTL: 86400 };
    if (topic !== undefined) {
      options.topic = topic;
    }
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
        options,
      );
      return { ok: true };
    } catch (err) {
      const status = statusCodeOf(err);
      if (status === 404 || status === 410) {
        return { ok: false, reason: 'gone' };
      }
      return { ok: false, reason: 'fail' };
    }
  }
}
