/**
 * Private messaging (PN) domain: public JSON projection.
 *
 * Threads are member↔member, member↔platform, member↔Damus, or the closed
 * moderator_group singleton. Member HTTP may include optional counterpart/sender
 * `accountId` for 21.gifts accounts and never exposes event ids or npubs
 * (Damus-only display names may use truncated npubs via the routes layer).
 */

import type { NostrPublishState } from '@/lib/message';

/** Cap for `GET /conversations` and `GET /conversations/:id` messages. */
export const CONVERSATION_LIST_LIMIT = 200;

/** Conversation counterpart kind. */
export type ConversationKind =
  'member_member' | 'member_platform' | 'member_damus' | 'moderator_group';

/** Persisted conversation thread (store-internal). */
export interface ConversationThread {
  /** Opaque unique conversation id. */
  id: string;
  /** Counterpart kind. */
  kind: ConversationKind;
  /**
   * Lower lexicographic participant for member_member; the member for
   * member_platform and member_damus; the platform account for
   * moderator_group.
   */
  accountA: string;
  /**
   * Higher lexicographic participant for member_member; platform account for
   * member_platform; `null` for member_damus and moderator_group.
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
  /** Last message sats; `0` when the thread has no messages or the last row is unpaid text. */
  lastSats: number;
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
  /** Credited sats on this row; `0` for unpaid text. Gift-only rows use `text: ''` and `sats >= 1`. */
  sats: number;
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
  /** Last message sats; `0` when none / unpaid text. */
  lastSats: number;
  /** True when the viewer has inbound messages newer than last-read. */
  unread: boolean;
  /** Counterpart 21.gifts account id. Omitted for Damus-only counterparts. */
  accountId?: string;
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
  /** Credited sats; `0` for unpaid text. */
  sats: number;
  /** Sender 21.gifts account id. Omitted when senderAccountId is null (Damus inbound). */
  accountId?: string;
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
 * Whether a stored sender is inbound for the viewer (not the viewer, and
 * not staff-as-platform). Null Damus sender is inbound.
 *
 * @param args - Sender account, viewer, staff flag, and platform id.
 * @returns True when the sender is inbound for the viewer.
 */
export function conversationIsInbound(args: {
  senderAccountId: string | null;
  viewerId: string;
  staff: boolean;
  platformId: string | null;
}): boolean {
  return !conversationFromMe(args);
}

/**
 * Project a thread to its public list JSON shape.
 *
 * @param thread - Persisted thread with resolved `name` / `lastText`.
 * @param lastFromMe - Whether the last message was sent by the viewer.
 * @param unread - Whether the viewer has unread inbound messages in this thread.
 * @param accountId - Counterpart 21.gifts account id; omitted when null/empty.
 * @returns Public fields only.
 */
export function serializeConversation(
  thread: ConversationThread,
  lastFromMe: boolean,
  unread: boolean,
  accountId?: string | null,
): PublicConversation {
  const json: PublicConversation = {
    id: thread.id,
    kind: thread.kind,
    name: thread.name,
    lastText: thread.lastText,
    lastAt: thread.lastMessageAt.toISOString(),
    lastFromMe,
    lastSats: thread.lastSats,
    unread,
  };
  if (typeof accountId === 'string' && accountId !== '') {
    json.accountId = accountId;
  }
  return json;
}

/**
 * Project a message row to its public JSON shape.
 *
 * @param row - Persisted message.
 * @param fromMe - Whether this message was sent by the viewer.
 * @returns Public fields only (event id omitted; `accountId` when the
 *   sender is a 21.gifts account).
 */
export function serializeConversationMessage(
  row: ConversationMessageRow,
  fromMe: boolean,
): PublicConversationMessage {
  const json: PublicConversationMessage = {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    fromMe,
    sats: row.sats,
  };
  if (typeof row.senderAccountId === 'string' && row.senderAccountId !== '') {
    json.accountId = row.senderAccountId;
  }
  return json;
}

/**
 * Unsigned / unpublished defaults for a locally persisted conversation message.
 *
 * @returns Pending Nostr columns (no event id).
 */
export function unsignedConversationDefaults(): Pick<
  ConversationMessageRow,
  'sats' | 'eventId' | 'nostrPublishState' | 'nostrEvent' | 'claimedUntil'
> {
  return {
    sats: 0,
    eventId: null,
    nostrPublishState: 'pending',
    nostrEvent: null,
    claimedUntil: null,
  };
}

/**
 * Fixed display name for the closed moderator-group thread.
 *
 * @param kind - Conversation kind.
 * @returns `'Moderators'` when `kind` is `moderator_group`; otherwise `null`.
 */
export function moderatorGroupDisplayName(kind: ConversationKind): string | null {
  return kind === 'moderator_group' ? 'Moderators' : null;
}

/**
 * 21.gifts account ids that should receive a Web Push for this message.
 * Unique, no null, never `senderAccountId`. Damus counterparts have no push.
 * `moderator_group` uses `moderatorIds` (other moderators), not accountA/B.
 *
 * @param thread - Stored thread.
 * @param senderAccountId - Message sender, or `null` for Damus inbound.
 * @param moderatorIds - Moderator account ids; used only for `moderator_group`.
 * @returns Recipient account ids.
 */
export function conversationPushRecipientIds(
  thread: ConversationThread,
  senderAccountId: string | null,
  moderatorIds: readonly string[] = [],
): string[] {
  if (thread.kind === 'moderator_group') {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of moderatorIds) {
      if (id === '' || id === senderAccountId || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  if (thread.kind === 'member_damus') {
    if (senderAccountId === null) {
      return [thread.accountA];
    }
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [thread.accountA, thread.accountB]) {
    if (typeof id !== 'string' || id === '' || id === senderAccountId || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}
