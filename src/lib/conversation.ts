/**
 * Private messaging (PN) domain: public JSON projection.
 *
 * Threads are member↔member, member↔platform, or member↔Damus. Member HTTP
 * never exposes account ids, event ids, or npubs (Damus-only display names may
 * use truncated npubs via the routes layer).
 */

import type { NostrPublishState } from '@/lib/message';

/** Cap for `GET /conversations` and `GET /conversations/:id` messages. */
export const CONVERSATION_LIST_LIMIT = 200;

/** Conversation counterpart kind. */
export type ConversationKind = 'member_member' | 'member_platform' | 'member_damus';

/** Persisted conversation thread (store-internal). */
export interface ConversationThread {
  /** Opaque unique conversation id. */
  id: string;
  /** Counterpart kind. */
  kind: ConversationKind;
  /**
   * Lower lexicographic participant for member_member; the member for
   * member_platform and member_damus.
   */
  accountA: string;
  /**
   * Higher lexicographic participant for member_member; platform account for
   * member_platform; `null` for member_damus.
   */
  accountB: string | null;
  /** Damus counterpart hex pubkey when `kind === 'member_damus'`; else null. */
  counterpartPubkey: string | null;
  /** Creation instant. */
  createdAt: Date;
  /** Last message instant (bumped on append). */
  lastMessageAt: Date;
  /** Counterpart display name for member JSON (resolved by routes/store). */
  name: string;
  /** Last message body, or empty when the thread has no messages yet. */
  lastText: string;
  /** Sender account of the newest message, or null when the thread has no messages / Damus inbound. */
  lastSenderAccountId: string | null;
}

/** Persisted conversation message row (store-internal). */
export interface ConversationMessageRow {
  /** Opaque unique message id. */
  id: string;
  /** Parent conversation id. */
  conversationId: string;
  /** Message body (already normalised). */
  text: string;
  /** Creation instant. */
  createdAt: Date;
  /** Sender account id when known; null for Damus-only inbound. */
  senderAccountId: string | null;
  /** Sender Nostr pubkey when known. */
  senderPubkey: string | null;
  /** Sender display name snapshotted at send time. */
  name: string;
  /** Signed/wrapped event id, or null until published. */
  eventId: string | null;
  /** Fan-out state. */
  nostrPublishState: NostrPublishState;
  /** Stored signed/wrapped event JSON, or null. */
  nostrEvent: Record<string, unknown> | null;
  /** Lease expiry (epoch ms), or null. */
  claimedUntil: number | null;
}

/** Member-facing conversation list row. */
export interface PublicConversation {
  /** Opaque unique conversation id. */
  id: string;
  /** Counterpart kind. */
  kind: ConversationKind;
  /** Counterpart display name (or truncated npub for Damus-only). */
  name: string;
  /** Last message text. */
  lastText: string;
  /** ISO-8601 last message time. */
  lastAt: string;
  /** True when the last message was sent by the viewer (or staff-as-platform). */
  lastFromMe: boolean;
}

/** Member-facing conversation message. */
export interface PublicConversationMessage {
  /** Opaque unique message id. */
  id: string;
  /** Sender display name snapshot. */
  name: string;
  /** Message body. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** True when this message was sent by the viewer (or staff-as-platform). */
  fromMe: boolean;
}

/**
 * Whether a stored sender is the viewer (or the platform identity a staff
 * viewer is acting as).
 *
 * @param args - Sender account, viewer, staff flag, and platform id.
 * @returns True when the sender is the viewer or staff-as-platform.
 */
export function conversationFromMe(args: {
  senderAccountId: string | null;
  viewerId: string;
  staff: boolean;
  platformId: string | null;
}): boolean {
  if (args.senderAccountId === null) {
    return false;
  }
  if (args.senderAccountId === args.viewerId) {
    return true;
  }
  return args.staff && args.platformId !== null && args.senderAccountId === args.platformId;
}

/**
 * Project a thread to its public list JSON shape.
 *
 * @param thread - Persisted thread with resolved `name` / `lastText`.
 * @param lastFromMe - Whether the last message was sent by the viewer.
 * @returns Public fields only.
 */
export function serializeConversation(
  thread: ConversationThread,
  lastFromMe: boolean,
): PublicConversation {
  return {
    id: thread.id,
    kind: thread.kind,
    name: thread.name,
    lastText: thread.lastText,
    lastAt: thread.lastMessageAt.toISOString(),
    lastFromMe,
  };
}

/**
 * Project a message row to its public JSON shape.
 *
 * @param row - Persisted message.
 * @param fromMe - Whether this message was sent by the viewer.
 * @returns Public fields only (`accountId` / event id omitted).
 */
export function serializeConversationMessage(
  row: ConversationMessageRow,
  fromMe: boolean,
): PublicConversationMessage {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    fromMe,
  };
}

/**
 * Unsigned / unpublished defaults for a locally persisted conversation message.
 *
 * @returns Pending Nostr columns (no event id).
 */
export function unsignedConversationDefaults(): Pick<
  ConversationMessageRow,
  'eventId' | 'nostrPublishState' | 'nostrEvent' | 'claimedUntil'
> {
  return {
    eventId: null,
    nostrPublishState: 'pending',
    nostrEvent: null,
    claimedUntil: null,
  };
}
