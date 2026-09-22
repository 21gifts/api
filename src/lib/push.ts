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

/** Notification title cap (Unicode code points). */
const PUSH_TITLE_MAX = 80;

/** Notification body preview cap (Unicode code points). */
const PUSH_BODY_MAX = 180;

/** Collapse each whitespace run to one space, then trim. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Keep at most `max` code points (`Array.from`); a longer value keeps `max - 1` and `…`. */
function limitCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length > max) {
    return `${points.slice(0, max - 1).join('')}…`;
  }
  return value;
}

/** Collapsed display name, or `Someone` when blank. */
function pushTitle(name: string): string {
  const collapsed = collapseWhitespace(name);
  if (collapsed === '') {
    return 'Someone';
  }
  return limitCodePoints(collapsed, PUSH_TITLE_MAX);
}

/** Collapsed note text, or `fallback` when blank. The fallback is not cut. */
function pushPreview(text: string, fallback: string): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed === '') {
    return fallback;
  }
  return limitCodePoints(collapsed, PUSH_BODY_MAX);
}

/** Photo/video sentence used only when the note text is empty. Flags count only when `=== true`. */
function mediaFallback(
  hasPhoto: boolean | undefined,
  hasVideo: boolean | undefined,
  copy: { both: string; photo: string; video: string; none: string },
): string {
  const showPhoto = hasPhoto === true;
  const showVideo = hasVideo === true;
  if (showPhoto && showVideo) {
    return copy.both;
  }
  if (showPhoto) {
    return copy.photo;
  }
  if (showVideo) {
    return copy.video;
  }
  return copy.none;
}

/**
 * Forum post payload for every bell subscriber except the actor.
 *
 * Title is the collapsed display name, or `Someone` when blank (at most 80
 * code points). Body is the note on one line (at most 180 code points), or a
 * photo/video sentence when the text is empty.
 *
 * @param args - Post id, author name, note text, and optional media flags.
 * @returns Payload object; callers `JSON.stringify`. Omits `unreadCount`.
 */
export function buildForumPushPayload(args: {
  postId: string;
  name: string;
  text: string;
  hasPhoto?: boolean;
  hasVideo?: boolean;
}): PushPayload {
  return {
    type: 'forum',
    title: pushTitle(args.name),
    body: pushPreview(
      args.text,
      mediaFallback(args.hasPhoto, args.hasVideo, {
        both: 'Posted a photo and a video.',
        photo: 'Posted a photo.',
        video: 'Posted a video.',
        none: 'Posted in the living room.',
      }),
    ),
    url: '/notifications',
    tag: `forum_post:${args.postId}`,
  };
}

/**
 * Zap payload for every bell subscriber except the payer skip id.
 *
 * Title is the collapsed payer name, or `Someone` when blank. Body is
 * `Sent <amountSats> sats.`
 *
 * @param args - Tag id, payer name, and whole-sat amount.
 * @returns Payload object; callers `JSON.stringify`. Omits `unreadCount`.
 */
export function buildZapPushPayload(args: {
  messageId: string;
  name: string;
  amountSats: number;
}): PushPayload {
  return {
    type: 'zap',
    title: pushTitle(args.name),
    body: `Sent ${String(args.amountSats)} sats.`,
    url: '/notifications',
    tag: `zap:${args.messageId}`,
  };
}

/**
 * Forum reply payload for every bell subscriber except the actor.
 *
 * Title matches a forum post. Body is the reply on one line (at most 180
 * code points), or a photo/video sentence when the text is empty. Non-empty
 * text wins over media flags.
 *
 * @param args - Reply id, author name, reply text, and optional media flags.
 * @returns Payload object; callers `JSON.stringify`. Omits `unreadCount`.
 */
export function buildReplyPushPayload(args: {
  replyId: string;
  name: string;
  text: string;
  hasPhoto?: boolean;
  hasVideo?: boolean;
}): PushPayload {
  return {
    type: 'forum',
    title: pushTitle(args.name),
    body: pushPreview(
      args.text,
      mediaFallback(args.hasPhoto, args.hasVideo, {
        both: 'Replied with a photo and a video.',
        photo: 'Replied with a photo.',
        video: 'Replied with a video.',
        none: 'Replied in the living room.',
      }),
    ),
    url: '/notifications',
    tag: `forum_reply:${args.replyId}`,
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
