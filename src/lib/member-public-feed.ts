import { aboutMeFromNote } from '@/lib/about-me';
import { staffTagOf, type Account, type AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { attachHeartStats } from '@/lib/heart-stats';
import { logEvent } from '@/lib/log';
import {
  MESSAGE_LIST_LIMIT,
  messagePay,
  serializeMessage,
  type MessageRow,
  type PublicMessage,
} from '@/lib/message';
import { type MessageListRow, type MessageStore } from '@/lib/message-store';
import { forumVideoFilePresent, resolveMediaDir } from '@/lib/video';

/** Which public list both profile addresses share. */
export type MemberFeedKind = 'posts' | 'shops' | 'credits' | 'replies';

/** Public message JSON plus the heart fields every list already returns. */
export type HeartedPublicMessage = PublicMessage & {
  heartCount: number;
  hearted: boolean;
};

/** Live profile note as the member card already publishes it. */
export interface MemberProfileNote {
  /** Serialized note, including hearts for `viewerAccountId`. */
  profileMessage: HeartedPublicMessage;
  /** Real bio, or `null` when the note is only the display name. */
  aboutMe: string | null;
  /** True when the live note has a stored photo. */
  aboutMeHasPhoto: boolean;
}

/**
 * Delete a `hasVideo` row whose file is missing or empty. Notes without video
 * are unchanged.
 *
 * @param store - Message store.
 * @param row - Store row.
 * @returns The row, or `null` when it was deleted. A row the store keeps, such as a
 *   credit with sats, is read again and returned while it is live; `null` when
 *   it is gone or hidden.
 */
async function dropMissingVideoRow(
  store: MessageStore,
  row: MessageRow,
): Promise<MessageRow | null> {
  if (
    row.hasVideo !== true ||
    row.videoContentType === undefined ||
    row.videoContentType === null
  ) {
    return row;
  }
  const present = await forumVideoFilePresent(resolveMediaDir(), row.id, row.videoContentType);
  if (present) {
    return row;
  }
  if (!(await store.deleteById(row.id))) {
    const kept = await store.getById(row.id);
    return kept !== undefined && kept.deletedAt === null ? kept : null;
  }
  logEvent('messages.video.dropped');
  return null;
}

/**
 * Serialize one top-level row the way the member post, shop, and credit lists do.
 *
 * @param row - Listed row, including its live `replyCount`.
 * @param kept - Row after a missing video file was dropped, or the same row.
 * @param dropped - Missing-file direct replies already deleted.
 * @param author - Author account. Undefined for an external shop author.
 * @param role - Live role, or undefined when the author is external.
 * @param lnurlServer - LNURL server, or omitted when off.
 * @returns Public message JSON without heart fields.
 */
function serializeListed(
  row: MessageListRow,
  kept: MessageRow,
  dropped: number,
  author: Account | undefined,
  role: Account['role'] | undefined,
  lnurlServer: LnurlServerConfig | undefined,
): PublicMessage {
  return serializeMessage(
    kept,
    messagePay(kept, author, lnurlServer),
    role,
    Math.max(0, row.replyCount - dropped),
    true,
    undefined,
    staffTagOf(author?.staffTag),
  );
}

/**
 * Load the same public post, shop, credit, or reply list the member card uses.
 *
 * Both `GET /members/:accountId/...` and `GET /view/:viewKey/...` call this.
 * `viewerAccountId` is the session account, or `null` on the share link.
 *
 * @param input - List kind, subject account, stores, and the heart viewer.
 * @returns Messages in list order, each with `heartCount` and `hearted`.
 */
export async function memberPublicMessages(input: {
  kind: MemberFeedKind;
  account: Account;
  messageStore: MessageStore;
  authStore: AuthStore;
  lnurlServer?: LnurlServerConfig | undefined;
  viewerAccountId: string | null;
}): Promise<HeartedPublicMessage[]> {
  const { kind, account, messageStore, authStore, lnurlServer, viewerAccountId } = input;
  const messages: PublicMessage[] = [];
  if (kind === 'replies') {
    const rows = await messageStore.listRepliesByAccount(account.id, MESSAGE_LIST_LIMIT);
    for (const row of rows) {
      const kept = await dropMissingVideoRow(messageStore, row);
      if (kept === null) {
        continue;
      }
      try {
        messages.push(
          serializeMessage(
            kept,
            messagePay(kept, account, lnurlServer),
            account.role,
            undefined,
            true,
            undefined,
            staffTagOf(account.staffTag),
          ),
        );
      } catch {
        continue;
      }
    }
  } else {
    const rows =
      kind === 'posts'
        ? await messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT)
        : kind === 'shops'
          ? await messageStore.listShopsByAccount(account.id, MESSAGE_LIST_LIMIT)
          : await messageStore.listCreditsByAccount(account.id, MESSAGE_LIST_LIMIT);
    for (const row of rows) {
      const kept = await dropMissingVideoRow(messageStore, row);
      if (kept === null) {
        continue;
      }
      const children = await messageStore.listReplies(kept.id, MESSAGE_LIST_LIMIT);
      let dropped = 0;
      for (const child of children) {
        const keptChild = await dropMissingVideoRow(messageStore, child);
        if (keptChild === null) {
          dropped += 1;
        }
      }
      const author =
        kind === 'shops'
          ? kept.accountId === null
            ? undefined
            : await authStore.getAccount(kept.accountId)
          : account;
      const role =
        kind === 'shops'
          ? kept.accountId === null
            ? undefined
            : (author?.role ?? 'basis')
          : account.role;
      messages.push(serializeListed(row, kept, dropped, author, role, lnurlServer));
    }
  }
  return attachHeartStats(
    (ids, viewer) => messageStore.heartStats(ids, viewer),
    viewerAccountId,
    messages,
  );
}

/**
 * Load the live profile note the member card already returns.
 *
 * Missing, blank, and soft-hidden notes are `null`. `hearted` follows
 * `viewerAccountId` and is false when that id is `null`.
 *
 * @param input - Subject account, message store, optional LNURL server, heart viewer.
 * @returns The note plus derived About me fields, or `null`.
 */
export async function loadMemberProfileNote(input: {
  account: Account;
  messageStore: MessageStore;
  lnurlServer?: LnurlServerConfig | undefined;
  viewerAccountId: string | null;
}): Promise<MemberProfileNote | null> {
  const { account, messageStore, lnurlServer, viewerAccountId } = input;
  const profileId = account.profileMessageId;
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    return null;
  }
  const row = await messageStore.getById(profileId);
  if (row === undefined || row.deletedAt !== null) {
    return null;
  }
  const children = await messageStore.listReplies(row.id, MESSAGE_LIST_LIMIT);
  const serialized = serializeMessage(
    row,
    messagePay(row, account, lnurlServer),
    account.role,
    children.length,
    true,
    undefined,
    staffTagOf(account.staffTag),
  );
  const attached = await attachHeartStats(
    (ids, viewer) => messageStore.heartStats(ids, viewer),
    viewerAccountId,
    [serialized],
  );
  const profileMessage = attached[0];
  /* v8 ignore next 3 -- attachHeartStats returns one object per input */
  if (profileMessage === undefined) {
    throw new Error('attachHeartStats returned no message');
  }
  return {
    profileMessage,
    aboutMe: aboutMeFromNote(account.name, row.text, row.name),
    aboutMeHasPhoto: row.hasPhoto === true,
  };
}
