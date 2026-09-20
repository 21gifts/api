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
  /** Discriminator (`forum`, `zap`, or `conversation`). */
  type: 'forum' | 'zap' | 'conversation';
  /** Notification title. */
  title: string;
  /** Notification body. */
  body: string;
  /** In-app path to open. */
  url: string;
  /** Collapse / topic tag. */
  tag: string;
  /**
   * Recipient's current home-screen badge: in-app notification unread plus
   * listed inbox unread (a missing source contributes 0). Omit from shared
   * templates; fan-out adds it per recipient.
   */
  unreadCount?: number;
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
 * Forum post payload for every bell subscriber except the actor.
 *
 * @param postId - Top-level forum message id (used in `tag`).
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildForumPushPayload(postId: string): PushPayload {
  return {
    type: 'forum',
    title: 'New post on 21.gifts',
    body: 'Someone posted in the living room.',
    url: '/notifications',
    tag: `forum_post:${postId}`,
  };
}

/**
 * Zap payload for every bell subscriber except the payer skip id.
 *
 * @param messageId - Tag id (receipt UUID on the `notifyZap` path).
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildZapPushPayload(messageId: string): PushPayload {
  return {
    type: 'zap',
    title: 'Bitcoin on 21.gifts',
    body: 'Someone sent sats.',
    url: '/notifications',
    tag: `zap:${messageId}`,
  };
}

/**
 * Forum reply payload for every bell subscriber except the actor.
 *
 * @param replyId - Reply forum message id (`tag` / collapse key; not the parent).
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildReplyPushPayload(replyId: string): PushPayload {
  return {
    type: 'forum',
    title: 'New reply on 21.gifts',
    body: 'Someone replied in the living room.',
    url: '/notifications',
    tag: `forum_reply:${replyId}`,
  };
}

/**
 * Moderator-appointed payload for the subject only (not a living-room fan-out).
 *
 * @param subjectId - Appointed account id (used in `tag`).
 * @returns Payload object; callers `JSON.stringify`.
 */
export function buildModeratorAppointedPushPayload(subjectId: string): PushPayload {
  return {
    type: 'forum',
    title: 'You are a moderator',
    body: 'You were appointed a moderator in the living room.',
    url: '/welcome',
    tag: `moderator_appointed:${subjectId}`,
  };
}

/**
 * Private-message payload for one 21.gifts recipient with a bell subscription.
 *
 * @param args - Conversation id, sender display name, message body, optional
 *   open URL (inbox `/messages?c=<id>` when omitted or empty).
 * @returns Payload object; callers `JSON.stringify` and add `unreadCount`.
 */
export function buildConversationPushPayload(args: {
  conversationId: string;
  name: string;
  text: string;
  url?: string;
}): PushPayload {
  return {
    type: 'conversation',
    title: args.name !== '' ? args.name : '21.gifts',
    body: args.text,
    url:
      args.url !== undefined && args.url !== '' ? args.url : `/messages?c=${args.conversationId}`,
    tag: `conversation:${args.conversationId}`,
  };
}
