/**
 * Web Push subscription parsing and small English notification payloads.
 */

/** Parsed PushSubscription fields stored for an account. */
export interface ParsedPushSubscription {
  /** Push service endpoint URL. */
  endpoint: string;
  /** Client public key (url-safe base64). */
  p256dh: string;
  /** Auth secret (url-safe base64). */
  auth: string;
}

/** Compact JSON payload delivered to browsers. */
export interface PushPayload {
  /** Discriminator (`forum` or `zap`). */
  type: 'forum' | 'zap';
  /** Notification title. */
  title: string;
  /** Notification body. */
  body: string;
  /** In-app path to open. */
  url: string;
  /** Collapse / topic tag. */
  tag: string;
}

/** Url-safe base64 charset with optional `=` padding. */
const URL_SAFE_B64 = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Validate a browser PushSubscription JSON body.
 *
 * @param input - Unknown request body.
 * @returns Parsed fields, or `null` when invalid.
 */
export function parsePushSubscription(input: unknown): ParsedPushSubscription | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const endpoint = record['endpoint'];
  const keys = record['keys'];
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return null;
  }
  if (keys === null || typeof keys !== 'object') {
    return null;
  }
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = keyRecord['p256dh'];
  const auth = keyRecord['auth'];
  if (typeof p256dh !== 'string' || p256dh === '' || !URL_SAFE_B64.test(p256dh)) {
    return null;
  }
  if (typeof auth !== 'string' || auth === '' || !URL_SAFE_B64.test(auth)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') {
    return { endpoint, p256dh, auth };
  }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { endpoint, p256dh, auth };
  }
  return null;
}

/**
 * Forum notification payload (shared English copy).
 *
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildForumPushPayload(): PushPayload {
  return {
    type: 'forum',
    title: 'New message on 21.gifts',
    body: 'Someone posted in the living room.',
    url: '/welcome',
    tag: 'forum',
  };
}

/**
 * Zap notification payload for a note author.
 *
 * @param messageId - Forum message id (used in `tag`).
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildZapPushPayload(messageId: string): PushPayload {
  return {
    type: 'zap',
    title: 'Bitcoin on your post',
    body: 'Someone sent you sats.',
    url: '/welcome',
    tag: `zap:${messageId}`,
  };
}
