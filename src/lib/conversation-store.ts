/**
 * Persistence for private messaging threads (member↔member, member↔platform,
 * member↔Damus, closed moderator_group singleton).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. New public tables are covered by `db_change` attach.
 */

import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';
import {
  CONVERSATION_LIST_LIMIT,
  conversationIsInbound,
  type ConversationKind,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import type { NostrPublishState } from '@/lib/message';
import { normalizeSignedEvent } from '@/lib/nostr/publish';

/**
 * Persistence port for conversation threads and messages.
 */
export interface ConversationStore {
  /** One thread by id, or `undefined`. */
  getById(id: string): Promise<ConversationThread | undefined>;

  /**
   * Existing closed `moderator_group` singleton, if any. Does not insert.
   *
   * @returns The thread, or `undefined` when none exists.
   */
  getModeratorGroup(): Promise<ConversationThread | undefined>;

  /**
   * Threads the viewer may see: own participation, plus every platform
   * thread when `staff` is true. The `moderator_group` singleton is
   * included only when `moderator` is true — never via participation or
   * the staff / platform-id bypass. Newest `lastMessageAt` first, then
   * `id` descending, capped at `limit`.
   *
   * @param accountId - Session account.
   * @param staff - Founder/moderator (sees all platform threads).
   * @param platformId - Official platform account id, or `null` when none.
   * @param limit - Maximum rows.
   * @param moderator - When true, include `moderator_group`. Default false.
   */
  listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
    moderator?: boolean,
  ): Promise<ConversationThread[]>;

  /**
   * True when the thread has at least one inbound message for the viewer
   * (`conversationIsInbound`). Used by GET /conversations to omit empty
   * and outbound-only threads.
   *
   * @param conversationId - Thread to inspect.
   * @param viewerId - Session account.
   * @param staff - Founder/moderator (platform sends count as fromMe).
   * @param platformId - Official platform account id, or `null` when none.
   * @returns Whether any stored message is inbound for that viewer.
   */
  hasInboundMessage(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean>;

  /**
   * True when the thread has at least one inbound message whose `createdAt`
   * is strictly greater than this viewer's last-read stamp. Missing last-read
   * means never read (any inbound is unread). Outbound-only and empty are
   * false.
   *
   * @param conversationId - Thread to inspect.
   * @param viewerId - Session account.
   * @param staff - Founder/moderator (platform sends count as fromMe).
   * @param platformId - Official platform account id, or `null` when none.
   * @returns Whether the viewer has unread inbound messages in that thread.
   */
  hasUnread(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean>;

  /**
   * Count of listed inbox threads with unread inbound for this viewer.
   * Same visibility as GET `/conversations` `unreadCount`: listed threads
   * with `hasUnread`. Outbound-only own platform tickets are listed but
   * unread false. Empty/outbound-only member threads omitted. Scan capped
   * at `CONVERSATION_LIST_LIMIT`.
   *
   * @param accountId - Session account.
   * @param staff - Founder/moderator (sees all platform threads).
   * @param platformId - Official platform account id, or `null` when none.
   * @param moderator - When true, include `moderator_group` (same as GET list).
   * @returns Number of listed unread threads.
   */
  unreadCount(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    moderator?: boolean,
  ): Promise<number>;

  /**
   * Upsert last-read for `(accountId, conversationId)` to `readAt`. Always
   * overwrites an existing stamp.
   *
   * @param conversationId - Thread to stamp.
   * @param accountId - Session account.
   * @param readAt - Stamp instant.
   */
  markRead(conversationId: string, accountId: string, readAt: Date): Promise<void>;

  /**
   * Open or return the member↔member thread (`account_a`/`account_b`
   * ordered by id).
   */
  openMemberMember(accountA: string, accountB: string, now: Date): Promise<ConversationThread>;

  /**
   * Open or return the member→platform thread. When an existing thread's
   * `accountB` is not `platformId`, update it to the current platform id.
   */
  openMemberPlatform(memberId: string, platformId: string, now: Date): Promise<ConversationThread>;

  /**
   * Point every member→platform thread at `platformId` (operator retarget),
   * except rows whose member (`accountA`) is already that account.
   *
   * @param platformId - Current official platform account.
   */
  retargetMemberPlatform(platformId: string): Promise<void>;

  /** Open or return the member↔Damus thread. */
  openMemberDamus(
    memberId: string,
    counterpartPubkey: string,
    now: Date,
  ): Promise<ConversationThread>;

  /**
   * Open or insert the closed singleton `moderator_group` thread.
   * `accountA` is the platform account; `accountB` and `counterpartPubkey`
   * are null. Unique on `kind`. Concurrent unique-violation re-selects.
   *
   * @param platformId - Official platform account id.
   * @param now - Creation / last-message instant when inserting.
   */
  ensureModeratorGroup(platformId: string, now: Date): Promise<ConversationThread>;

  /** One message by id, or `undefined`. */
  getMessageById(id: string): Promise<ConversationMessageRow | undefined>;

  /** One message by Nostr event id, or `undefined`. */
  getMessageByEventId(eventId: string): Promise<ConversationMessageRow | undefined>;

  /**
   * Oldest messages first for a conversation, capped at `limit`.
   *
   * @param conversationId - Parent thread.
   * @param limit - Maximum rows.
   */
  listMessages(conversationId: string, limit: number): Promise<ConversationMessageRow[]>;

  /**
   * Persist a message and bump `lastMessageAt`. Duplicate message `id` or
   * `eventId` returns the existing row.
   *
   * @param row - Fully formed message.
   */
  appendMessage(row: ConversationMessageRow): Promise<ConversationMessageRow>;

  /**
   * Claim unsigned pending rows (`eventId` null, sender account set) for wrap.
   *
   * @param limit - Max rows.
   * @param nowMs - Clock.
   * @param leaseMs - Lease duration.
   */
  claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<ConversationMessageRow[]>;

  /** Claim signed-but-unpublished pending rows for fan-out. */
  claimUnpublished(
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): Promise<ConversationMessageRow[]>;

  /** Persist a signed wrap id + JSON. Returns false on event-id collision. */
  updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean>;

  /** Mark space ACK or published after public quorum. */
  updatePublishState(id: string, state: NostrPublishState): Promise<void>;
}

/**
 * Listed GET `/conversations` unread count (same filter/cap as the list).
 */
async function listedUnreadCount(
  store: Pick<
    ConversationStore,
    'listVisible' | 'hasInboundMessage' | 'hasUnread' | 'getModeratorGroup'
  >,
  accountId: string,
  staff: boolean,
  platformId: string | null,
  moderator = false,
): Promise<number> {
  let threads = await store.listVisible(
    accountId,
    staff,
    platformId,
    CONVERSATION_LIST_LIMIT,
    moderator,
  );
  if (moderator) {
    const group = await store.getModeratorGroup();
    if (group !== undefined) {
      threads = [group, ...threads.filter((thread) => thread.id !== group.id)].slice(
        0,
        CONVERSATION_LIST_LIMIT,
      );
    }
  }
  let count = 0;
  for (const thread of threads) {
    const inbound = await store.hasInboundMessage(thread.id, accountId, staff, platformId);
    const ownContactTicket =
      thread.kind === 'member_platform' && thread.accountA === accountId && thread.lastText !== '';
    if (!inbound && !ownContactTicket && thread.kind !== 'moderator_group') {
      continue;
    }
    if (await store.hasUnread(thread.id, accountId, staff, platformId)) {
      count += 1;
    }
  }
  return count;
}

/** Idempotent SQL for conversation tables (DDL plus boot-time unwrap of `nostr_event` values stored as jsonb string scalars in `conversation_message`; `docs/schema/conversation.sql` mirrors the DDL and documents the boot repair statement by comment, the `DO $unwrap$` block lives only in this array). */
export const CONVERSATION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('member_member', 'member_platform', 'member_damus', 'moderator_group')),
  account_a uuid NOT NULL REFERENCES account (id),
  account_b uuid REFERENCES account (id),
  counterpart_pubkey text,
  created_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_member_uidx
  ON conversation (account_a, account_b)
  WHERE kind = 'member_member'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_platform_uidx
  ON conversation (account_a)
  WHERE kind = 'member_platform'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_damus_uidx
  ON conversation (account_a, counterpart_pubkey)
  WHERE kind = 'member_damus'`,
  `CREATE INDEX IF NOT EXISTS conversation_last_message_at_idx
  ON conversation (last_message_at DESC, id DESC)`,
  `ALTER TABLE conversation DROP CONSTRAINT IF EXISTS conversation_kind_check`,
  `ALTER TABLE conversation ADD CONSTRAINT conversation_kind_check
  CHECK (kind IN ('member_member', 'member_platform', 'member_damus', 'moderator_group'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_moderator_group_uidx
  ON conversation (kind) WHERE kind = 'moderator_group'`,
  `CREATE TABLE IF NOT EXISTS conversation_message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation (id),
  text text NOT NULL,
  created_at timestamptz NOT NULL,
  sender_account_id uuid REFERENCES account (id),
  sender_pubkey text,
  name text NOT NULL,
  event_id text,
  nostr_publish_state text NOT NULL,
  nostr_event jsonb,
  claimed_until timestamptz
)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS conversation_message_conversation_id_idx
  ON conversation_message (conversation_id, created_at ASC, id ASC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_event_id_uidx
  ON conversation_message (event_id)
  WHERE event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS conversation_message_nostr_event_unrepaired_idx
  ON conversation_message (id)
  WHERE nostr_event IS NOT NULL AND jsonb_typeof(nostr_event) = 'string'`,
  `CREATE TABLE IF NOT EXISTS conversation_read (
  account_id uuid NOT NULL REFERENCES account (id),
  conversation_id uuid NOT NULL REFERENCES conversation (id),
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
)`,
  `CREATE INDEX IF NOT EXISTS conversation_read_conversation_id_idx
  ON conversation_read (conversation_id)`,
  `DO $unwrap$
   DECLARE
     repair_row RECORD;
     unwrapped jsonb;
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_trigger
       WHERE tgrelid = 'conversation_message'::regclass
         AND tgname = 'trg_db_change'
         AND NOT tgisinternal
     ) THEN
       RETURN;
     END IF;

     FOR repair_row IN
       SELECT id, nostr_event
       FROM conversation_message
       WHERE nostr_event IS NOT NULL
         AND jsonb_typeof(nostr_event) = 'string'
     LOOP
       BEGIN
         unwrapped := (repair_row.nostr_event #>> '{}')::jsonb;
       EXCEPTION WHEN data_exception OR statement_too_complex THEN
         RAISE WARNING 'Could not unwrap nostr_event for conversation_message id %',
           repair_row.id;
         CONTINUE;
       END;

       UPDATE conversation_message
       SET nostr_event = unwrapped
       WHERE id = repair_row.id
         AND nostr_event IS NOT NULL
         AND jsonb_typeof(nostr_event) = 'string'
         AND nostr_event = repair_row.nostr_event;
     END LOOP;
   END;
   $unwrap$;`,
];

const THREAD_SELECT = `c.id, c.kind, c.account_a, c.account_b, c.counterpart_pubkey, c.created_at, c.last_message_at,
  COALESCE((
    SELECT m.text FROM conversation_message m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ), '') AS last_text,
  (SELECT m.sender_account_id FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_sender_account_id,
  COALESCE((
    SELECT m.sats FROM conversation_message m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ), 0) AS last_sats`;

const MESSAGE_SELECT = `id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name, sats,
  event_id, nostr_publish_state, nostr_event, claimed_until`;

/**
 * Apply {@link CONVERSATION_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateConversationSchema(sql: SqlClient): Promise<void> {
  for (const statement of CONVERSATION_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link ConversationStore}. Used in tests and when no
 * database URL is configured — the process still boots.
 */
export class InMemoryConversationStore implements ConversationStore {
  readonly #threads: ConversationThread[];
  readonly #messages: ConversationMessageRow[];
  readonly #lastRead: Map<string, Date>;

  /**
   * @param seedThreads - Optional seed threads; copied into private storage.
   * @param seedMessages - Optional seed messages; copied into private storage.
   * @param seedLastRead - Optional last-read stamps; Dates copied into a private map.
   */
  constructor(
    seedThreads: readonly ConversationThread[] = [],
    seedMessages: readonly ConversationMessageRow[] = [],
    seedLastRead: readonly {
      accountId: string;
      conversationId: string;
      lastReadAt: Date;
    }[] = [],
  ) {
    this.#threads = seedThreads.map((thread) => copyThread(thread));
    this.#messages = seedMessages.map((row) => copyMessage(row));
    this.#lastRead = new Map(
      seedLastRead.map((row) => [
        lastReadKey(row.accountId, row.conversationId),
        new Date(row.lastReadAt.getTime()),
      ]),
    );
  }

  getById(id: string): Promise<ConversationThread | undefined> {
    const thread = this.#threads.find((item) => item.id === id);
    return Promise.resolve(thread === undefined ? undefined : this.#hydrate(thread));
  }

  getModeratorGroup(): Promise<ConversationThread | undefined> {
    const thread = this.#threads.find((item) => item.kind === 'moderator_group');
    return Promise.resolve(thread === undefined ? undefined : this.#hydrate(thread));
  }

  listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
    moderator = false,
  ): Promise<ConversationThread[]> {
    const listed = this.#threads
      .filter((thread) => visibleTo(thread, accountId, staff, platformId, moderator))
      .sort(compareThreadsNewestFirst)
      .slice(0, limit)
      .map((thread) => this.#hydrate(thread));
    return Promise.resolve(listed);
  }

  hasInboundMessage(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean> {
    return Promise.resolve(
      this.#messages.some(
        (row) =>
          row.conversationId === conversationId &&
          conversationIsInbound({
            senderAccountId: row.senderAccountId,
            viewerId,
            staff,
            platformId,
          }),
      ),
    );
  }

  hasUnread(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean> {
    const stamp = this.#lastRead.get(lastReadKey(viewerId, conversationId));
    return Promise.resolve(
      this.#messages.some((row) => {
        if (row.conversationId !== conversationId) {
          return false;
        }
        if (
          !conversationIsInbound({
            senderAccountId: row.senderAccountId,
            viewerId,
            staff,
            platformId,
          })
        ) {
          return false;
        }
        if (stamp === undefined) {
          return true;
        }
        return row.createdAt.getTime() > stamp.getTime();
      }),
    );
  }

  /**
   * Count listed unread threads for this viewer (GET list rules).
   *
   * @param accountId - Session account.
   * @param staff - Founder/moderator.
   * @param platformId - Official platform account id, or `null`.
   * @param moderator - When true, include `moderator_group` (same as GET list).
   * @returns Listed unread count.
   */
  unreadCount(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    moderator = false,
  ): Promise<number> {
    return listedUnreadCount(this, accountId, staff, platformId, moderator);
  }

  markRead(conversationId: string, accountId: string, readAt: Date): Promise<void> {
    this.#lastRead.set(lastReadKey(accountId, conversationId), new Date(readAt.getTime()));
    return Promise.resolve();
  }

  openMemberMember(accountA: string, accountB: string, now: Date): Promise<ConversationThread> {
    const [left, right] = orderedPair(accountA, accountB);
    const existing = this.#threads.find(
      (thread) =>
        thread.kind === 'member_member' && thread.accountA === left && thread.accountB === right,
    );
    if (existing !== undefined) {
      return Promise.resolve(this.#hydrate(existing));
    }
    return Promise.resolve(
      this.#insertThread({
        kind: 'member_member',
        accountA: left,
        accountB: right,
        counterpartPubkey: null,
        now,
      }),
    );
  }

  openMemberPlatform(memberId: string, platformId: string, now: Date): Promise<ConversationThread> {
    const existing = this.#threads.find(
      (thread) => thread.kind === 'member_platform' && thread.accountA === memberId,
    );
    if (existing !== undefined) {
      if (existing.accountB !== platformId) {
        existing.accountB = platformId;
      }
      return Promise.resolve(this.#hydrate(existing));
    }
    return Promise.resolve(
      this.#insertThread({
        kind: 'member_platform',
        accountA: memberId,
        accountB: platformId,
        counterpartPubkey: null,
        now,
      }),
    );
  }

  openMemberDamus(
    memberId: string,
    counterpartPubkey: string,
    now: Date,
  ): Promise<ConversationThread> {
    const pubkey = counterpartPubkey.toLowerCase();
    const existing = this.#threads.find(
      (thread) =>
        thread.kind === 'member_damus' &&
        thread.accountA === memberId &&
        thread.counterpartPubkey === pubkey,
    );
    if (existing !== undefined) {
      return Promise.resolve(this.#hydrate(existing));
    }
    return Promise.resolve(
      this.#insertThread({
        kind: 'member_damus',
        accountA: memberId,
        accountB: null,
        counterpartPubkey: pubkey,
        now,
      }),
    );
  }

  /**
   * Open or insert the closed singleton `moderator_group` thread.
   *
   * @param platformId - Official platform account id.
   * @param now - Creation / last-message instant when inserting.
   * @returns The existing or newly inserted thread.
   */
  ensureModeratorGroup(platformId: string, now: Date): Promise<ConversationThread> {
    const existing = this.#threads.find((thread) => thread.kind === 'moderator_group');
    if (existing !== undefined) {
      return Promise.resolve(this.#hydrate(existing));
    }
    return Promise.resolve(
      this.#insertThread({
        kind: 'moderator_group',
        accountA: platformId,
        accountB: null,
        counterpartPubkey: null,
        now,
      }),
    );
  }

  getMessageById(id: string): Promise<ConversationMessageRow | undefined> {
    const row = this.#messages.find((item) => item.id === id);
    return Promise.resolve(row === undefined ? undefined : copyMessage(row));
  }

  getMessageByEventId(eventId: string): Promise<ConversationMessageRow | undefined> {
    const row = this.#messages.find((item) => item.eventId === eventId);
    return Promise.resolve(row === undefined ? undefined : copyMessage(row));
  }

  listMessages(conversationId: string, limit: number): Promise<ConversationMessageRow[]> {
    const listed = this.#messages
      .filter((row) => row.conversationId === conversationId)
      .sort(compareMessagesOldestFirst)
      .slice(0, limit)
      .map((row) => copyMessage(row));
    return Promise.resolve(listed);
  }

  appendMessage(row: ConversationMessageRow): Promise<ConversationMessageRow> {
    const existingById = this.#messages.find((item) => item.id === row.id);
    if (existingById !== undefined) {
      return Promise.resolve(copyMessage(existingById));
    }
    if (row.eventId !== null) {
      const existing = this.#messages.find((item) => item.eventId === row.eventId);
      if (existing !== undefined) {
        return Promise.resolve(copyMessage(existing));
      }
    }
    const stored = copyMessage(row);
    this.#messages.push(stored);
    const thread = this.#threads.find((item) => item.id === row.conversationId);
    if (thread !== undefined && row.createdAt.getTime() >= thread.lastMessageAt.getTime()) {
      thread.lastMessageAt = new Date(row.createdAt.getTime());
    }
    return Promise.resolve(copyMessage(stored));
  }

  claimUnsigned(limit: number, nowMs: number, leaseMs: number): Promise<ConversationMessageRow[]> {
    return Promise.resolve(
      this.#claim(
        (row) =>
          row.eventId === null &&
          row.nostrPublishState === 'pending' &&
          row.senderAccountId !== null,
        limit,
        nowMs,
        leaseMs,
      ),
    );
  }

  claimUnpublished(
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): Promise<ConversationMessageRow[]> {
    return Promise.resolve(
      this.#claim(
        (row) => row.eventId !== null && row.nostrPublishState === 'pending',
        limit,
        nowMs,
        leaseMs,
      ),
    );
  }

  updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.#messages.some((row) => row.eventId === eventId && row.id !== id)) {
      return Promise.resolve(false);
    }
    const row = this.#messages.find((item) => item.id === id);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    row.eventId = eventId;
    row.nostrEvent = { ...nostrEvent };
    return Promise.resolve(true);
  }

  updatePublishState(id: string, state: NostrPublishState): Promise<void> {
    const row = this.#messages.find((item) => item.id === id);
    if (row !== undefined) {
      row.nostrPublishState = state;
    }
    return Promise.resolve();
  }

  /**
   * Point every member→platform thread at `platformId`.
   *
   * @param platformId - Current official platform account.
   * @returns Resolves when every matching thread is updated.
   */
  retargetMemberPlatform(platformId: string): Promise<void> {
    for (const thread of this.#threads) {
      if (thread.kind === 'member_platform' && thread.accountA !== platformId) {
        thread.accountB = platformId;
      }
    }
    return Promise.resolve();
  }

  #insertThread(args: {
    kind: ConversationKind;
    accountA: string;
    accountB: string | null;
    counterpartPubkey: string | null;
    now: Date;
  }): ConversationThread {
    const stored: ConversationThread = {
      id: crypto.randomUUID(),
      kind: args.kind,
      accountA: args.accountA,
      accountB: args.accountB,
      counterpartPubkey: args.counterpartPubkey,
      createdAt: new Date(args.now.getTime()),
      lastMessageAt: new Date(args.now.getTime()),
      name: '',
      lastText: '',
      lastSenderAccountId: null,
      lastSats: 0,
    };
    this.#threads.push(stored);
    return this.#hydrate(stored);
  }

  #hydrate(thread: ConversationThread): ConversationThread {
    const last = [...this.#messages]
      .filter((row) => row.conversationId === thread.id)
      .sort(compareMessagesNewestFirst)[0];
    return {
      ...copyThread(thread),
      lastText: last?.text ?? '',
      lastSenderAccountId: last?.senderAccountId ?? null,
      lastSats: last?.sats ?? 0,
    };
  }

  #claim(
    predicate: (row: ConversationMessageRow) => boolean,
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): ConversationMessageRow[] {
    const claimed: ConversationMessageRow[] = [];
    const sorted = [...this.#messages].sort(compareMessagesOldestFirst);
    for (const row of sorted) {
      if (claimed.length >= limit) {
        break;
      }
      if (!predicate(row)) {
        continue;
      }
      if (row.claimedUntil !== null && row.claimedUntil > nowMs) {
        continue;
      }
      row.claimedUntil = nowMs + leaseMs;
      claimed.push(copyMessage(row));
    }
    return claimed;
  }
}

/** Row shape selected from `conversation` plus computed `last_text` / `last_sender_account_id`. */
interface ConversationSqlRow {
  id: string;
  kind: string;
  account_a: string;
  account_b: string | null;
  counterpart_pubkey: string | null;
  created_at: Date | string;
  last_message_at: Date | string;
  last_text?: string | null;
  last_sender_account_id?: string | null;
  last_sats?: string | number | null;
}

/** Row shape selected from `conversation_message`. */
interface ConversationMessageSqlRow {
  id: string;
  conversation_id: string;
  text: string;
  created_at: Date | string;
  sender_account_id: string | null;
  sender_pubkey: string | null;
  name: string;
  sats?: string | number | null;
  event_id: string | null;
  nostr_publish_state: string | null;
  nostr_event: Record<string, unknown> | string | null;
  claimed_until: Date | string | null;
}

/**
 * Durable {@link ConversationStore} backed by Postgres.
 */
export class PostgresConversationStore implements ConversationStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async getById(id: string): Promise<ConversationThread | undefined> {
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c WHERE c.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapThread(row);
  }

  async getModeratorGroup(): Promise<ConversationThread | undefined> {
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c WHERE c.kind = 'moderator_group' LIMIT 1`,
      [],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapThread(row);
  }

  async listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
    moderator = false,
  ): Promise<ConversationThread[]> {
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT}
       FROM conversation c
       WHERE (
         (c.kind <> 'moderator_group' AND (
           c.account_a = $1 OR c.account_b = $1
           OR ($2::boolean AND c.kind = 'member_platform')
           OR ($2::boolean AND $3::uuid IS NOT NULL AND (c.account_a = $3 OR c.account_b = $3))
         ))
         OR ($5::boolean AND c.kind = 'moderator_group')
       )
       ORDER BY c.last_message_at DESC, c.id DESC
       LIMIT $4`,
      [accountId, staff, platformId, limit, moderator],
    );
    return rows.map((row) => mapThread(row));
  }

  async hasInboundMessage(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean> {
    const rows = await this.#sql.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM conversation_message
         WHERE conversation_id = $1
           AND (
             sender_account_id IS NULL
             OR (
               sender_account_id IS DISTINCT FROM $2
               AND NOT ($3::boolean AND $4::uuid IS NOT NULL AND sender_account_id = $4)
             )
           )
       ) AS exists`,
      [conversationId, viewerId, staff, platformId],
    );
    return rows[0]?.exists === true;
  }

  async hasUnread(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<boolean> {
    const rows = await this.#sql.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM conversation_message
         LEFT JOIN conversation_read
           ON conversation_read.account_id = $2
          AND conversation_read.conversation_id = conversation_message.conversation_id
         WHERE conversation_message.conversation_id = $1
           AND (
             sender_account_id IS NULL
             OR (
               sender_account_id IS DISTINCT FROM $2
               AND NOT ($3::boolean AND $4::uuid IS NOT NULL AND sender_account_id = $4)
             )
           )
           AND (
             conversation_read.last_read_at IS NULL
             OR conversation_message.created_at > conversation_read.last_read_at
           )
       ) AS exists`,
      [conversationId, viewerId, staff, platformId],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Count listed unread threads for this viewer (GET list rules).
   *
   * @param accountId - Session account.
   * @param staff - Founder/moderator.
   * @param platformId - Official platform account id, or `null`.
   * @param moderator - When true, include `moderator_group` (same as GET list).
   * @returns Listed unread count.
   */
  unreadCount(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    moderator = false,
  ): Promise<number> {
    return listedUnreadCount(this, accountId, staff, platformId, moderator);
  }

  async markRead(conversationId: string, accountId: string, readAt: Date): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO conversation_read (account_id, conversation_id, last_read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, conversation_id)
       DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [accountId, conversationId, readAt],
    );
  }

  async openMemberMember(
    accountA: string,
    accountB: string,
    now: Date,
  ): Promise<ConversationThread> {
    const [left, right] = orderedPair(accountA, accountB);
    const existing = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_member' AND c.account_a = $1 AND c.account_b = $2`,
      [left, right],
    );
    const found = existing[0];
    if (found !== undefined) {
      return mapThread(found);
    }
    const id = crypto.randomUUID();
    try {
      await this.#sql.execute(
        `INSERT INTO conversation (id, kind, account_a, account_b, counterpart_pubkey, created_at, last_message_at)
         VALUES ($1, 'member_member', $2, $3, NULL, $4, $4)`,
        [id, left, right, now],
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_member' AND c.account_a = $1 AND c.account_b = $2`,
      [left, right],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('conversation open failed');
    }
    return mapThread(row);
  }

  async openMemberPlatform(
    memberId: string,
    platformId: string,
    now: Date,
  ): Promise<ConversationThread> {
    const existing = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_platform' AND c.account_a = $1`,
      [memberId],
    );
    const found = existing[0];
    if (found !== undefined) {
      return alignMemberPlatformAccountB(this.#sql, found, platformId);
    }
    const id = crypto.randomUUID();
    try {
      await this.#sql.execute(
        `INSERT INTO conversation (id, kind, account_a, account_b, counterpart_pubkey, created_at, last_message_at)
         VALUES ($1, 'member_platform', $2, $3, NULL, $4, $4)`,
        [id, memberId, platformId, now],
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_platform' AND c.account_a = $1`,
      [memberId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('conversation open failed');
    }
    return alignMemberPlatformAccountB(this.#sql, row, platformId);
  }

  async openMemberDamus(
    memberId: string,
    counterpartPubkey: string,
    now: Date,
  ): Promise<ConversationThread> {
    const pubkey = counterpartPubkey.toLowerCase();
    const existing = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_damus' AND c.account_a = $1 AND c.counterpart_pubkey = $2`,
      [memberId, pubkey],
    );
    const found = existing[0];
    if (found !== undefined) {
      return mapThread(found);
    }
    const id = crypto.randomUUID();
    try {
      await this.#sql.execute(
        `INSERT INTO conversation (id, kind, account_a, account_b, counterpart_pubkey, created_at, last_message_at)
         VALUES ($1, 'member_damus', $2, NULL, $3, $4, $4)`,
        [id, memberId, pubkey, now],
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'member_damus' AND c.account_a = $1 AND c.counterpart_pubkey = $2`,
      [memberId, pubkey],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('conversation open failed');
    }
    return mapThread(row);
  }

  /**
   * Open or insert the closed singleton `moderator_group` thread.
   *
   * @param platformId - Official platform account id.
   * @param now - Creation / last-message instant when inserting.
   * @returns The existing or newly inserted thread.
   */
  async ensureModeratorGroup(platformId: string, now: Date): Promise<ConversationThread> {
    const existing = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'moderator_group'`,
      [],
    );
    const found = existing[0];
    if (found !== undefined) {
      return mapThread(found);
    }
    const id = crypto.randomUUID();
    try {
      await this.#sql.execute(
        `INSERT INTO conversation (id, kind, account_a, account_b, counterpart_pubkey, created_at, last_message_at)
         VALUES ($1, 'moderator_group', $2, NULL, NULL, $3, $3)`,
        [id, platformId, now],
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT} FROM conversation c
       WHERE c.kind = 'moderator_group'`,
      [],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('conversation open failed');
    }
    return mapThread(row);
  }

  async getMessageById(id: string): Promise<ConversationMessageRow | undefined> {
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `SELECT ${MESSAGE_SELECT} FROM conversation_message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessage(row);
  }

  async getMessageByEventId(eventId: string): Promise<ConversationMessageRow | undefined> {
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `SELECT ${MESSAGE_SELECT} FROM conversation_message WHERE event_id = $1`,
      [eventId],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapMessage(row);
  }

  async listMessages(conversationId: string, limit: number): Promise<ConversationMessageRow[]> {
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `SELECT ${MESSAGE_SELECT}
       FROM conversation_message
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map((row) => mapMessage(row));
  }

  async appendMessage(row: ConversationMessageRow): Promise<ConversationMessageRow> {
    try {
      await this.#sql.execute(
        `INSERT INTO conversation_message (
           id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name, sats,
           event_id, nostr_publish_state, nostr_event, claimed_until
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
        [
          row.id,
          row.conversationId,
          row.text,
          row.createdAt,
          row.senderAccountId,
          row.senderPubkey,
          row.name,
          row.sats,
          row.eventId,
          row.nostrPublishState,
          row.nostrEvent,
          row.claimedUntil === null ? null : new Date(row.claimedUntil),
        ],
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const existingById = await this.getMessageById(row.id);
        if (existingById !== undefined) {
          return existingById;
        }
        if (row.eventId !== null) {
          const existingByEventId = await this.getMessageByEventId(row.eventId);
          if (existingByEventId !== undefined) {
            return existingByEventId;
          }
        }
      }
      throw error;
    }
    await this.#sql.execute(
      `UPDATE conversation SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1`,
      [row.conversationId, row.createdAt],
    );
    return copyMessage(row);
  }

  async claimUnsigned(
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): Promise<ConversationMessageRow[]> {
    const until = new Date(nowMs + leaseMs);
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `UPDATE conversation_message SET claimed_until = $1
       WHERE id IN (
         SELECT id FROM conversation_message
         WHERE event_id IS NULL AND nostr_publish_state = 'pending'
           AND sender_account_id IS NOT NULL
           AND (claimed_until IS NULL OR claimed_until <= $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${MESSAGE_SELECT}`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapMessage(row));
  }

  async claimUnpublished(
    limit: number,
    nowMs: number,
    leaseMs: number,
  ): Promise<ConversationMessageRow[]> {
    const until = new Date(nowMs + leaseMs);
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `UPDATE conversation_message SET claimed_until = $1
       WHERE id IN (
         SELECT id FROM conversation_message
         WHERE event_id IS NOT NULL AND nostr_publish_state = 'pending'
           AND (claimed_until IS NULL OR claimed_until <= $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${MESSAGE_SELECT}`,
      [until, new Date(nowMs), limit],
    );
    return rows.map((row) => mapMessage(row));
  }

  async updateSignedEvent(
    id: string,
    eventId: string,
    nostrEvent: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const rows = await this.#sql.query<{ id: string }>(
        `UPDATE conversation_message SET event_id = $2, nostr_event = $3::jsonb WHERE id = $1 RETURNING id`,
        [id, eventId, nostrEvent],
      );
      return rows[0] !== undefined;
      /* v8 ignore next 3 -- unique_violation on event_id */
    } catch {
      return false;
    }
  }

  async updatePublishState(id: string, state: NostrPublishState): Promise<void> {
    await this.#sql.execute(
      `UPDATE conversation_message SET nostr_publish_state = $2 WHERE id = $1`,
      [id, state],
    );
  }

  /**
   * Point every member→platform thread at `platformId`.
   *
   * @param platformId - Current official platform account.
   * @returns Resolves when the UPDATE has run.
   */
  async retargetMemberPlatform(platformId: string): Promise<void> {
    await this.#sql.execute(
      `UPDATE conversation SET account_b = $1
       WHERE kind = 'member_platform' AND account_a <> $1`,
      [platformId],
    );
  }
}

function lastReadKey(accountId: string, conversationId: string): string {
  return `${accountId}\0${conversationId}`;
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function visibleTo(
  thread: ConversationThread,
  accountId: string,
  staff: boolean,
  platformId: string | null,
  moderator = false,
): boolean {
  if (thread.kind === 'moderator_group') {
    return moderator === true;
  }
  if (thread.accountA === accountId || thread.accountB === accountId) {
    return true;
  }
  if (!staff) {
    return false;
  }
  if (thread.kind === 'member_platform') {
    return true;
  }
  return platformId !== null && (thread.accountA === platformId || thread.accountB === platformId);
}

function compareThreadsNewestFirst(a: ConversationThread, b: ConversationThread): number {
  const byTime = b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return b.id.localeCompare(a.id);
}

function compareMessagesOldestFirst(a: ConversationMessageRow, b: ConversationMessageRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return a.id.localeCompare(b.id);
}

function compareMessagesNewestFirst(a: ConversationMessageRow, b: ConversationMessageRow): number {
  return compareMessagesOldestFirst(b, a);
}

function copyThread(thread: ConversationThread): ConversationThread {
  return {
    ...thread,
    createdAt: new Date(thread.createdAt.getTime()),
    lastMessageAt: new Date(thread.lastMessageAt.getTime()),
  };
}

function copyMessage(row: ConversationMessageRow): ConversationMessageRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    nostrEvent: row.nostrEvent === null ? null : { ...row.nostrEvent },
  };
}

function parseKind(raw: string): ConversationKind {
  if (
    raw === 'member_member' ||
    raw === 'member_platform' ||
    raw === 'member_damus' ||
    raw === 'moderator_group'
  ) {
    return raw;
  }
  throw new Error(`Unknown conversation kind "${raw}"`);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalEpoch(value: Date | string | null): number | null {
  if (value === null) {
    return null;
  }
  return asDate(value).getTime();
}

function mapThread(row: ConversationSqlRow): ConversationThread {
  return {
    id: row.id,
    kind: parseKind(row.kind),
    accountA: row.account_a,
    accountB: row.account_b,
    counterpartPubkey: row.counterpart_pubkey,
    createdAt: asDate(row.created_at),
    lastMessageAt: asDate(row.last_message_at),
    name: '',
    lastText: row.last_text ?? '',
    lastSenderAccountId: row.last_sender_account_id ?? null,
    lastSats: Number(row.last_sats ?? 0),
  };
}

/** Point an existing member→platform thread at the current platform account. */
async function alignMemberPlatformAccountB(
  sql: SqlClient,
  row: ConversationSqlRow,
  platformId: string,
): Promise<ConversationThread> {
  if (row.account_b === platformId) {
    return mapThread(row);
  }
  await sql.execute(
    `UPDATE conversation SET account_b = $1 WHERE id = $2 AND kind = 'member_platform'`,
    [platformId, row.id],
  );
  return mapThread({ ...row, account_b: platformId });
}

function mapMessage(row: ConversationMessageSqlRow): ConversationMessageRow {
  const state = row.nostr_publish_state;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    createdAt: asDate(row.created_at),
    senderAccountId: row.sender_account_id,
    senderPubkey: row.sender_pubkey,
    name: row.name,
    sats: Number(row.sats ?? 0),
    eventId: row.event_id,
    nostrPublishState:
      state === 'pending' || state === 'published' || state === 'failed' || state === 'skipped'
        ? state
        : 'pending',
    nostrEvent: normalizeSignedEvent(row.nostr_event) ?? null,
    claimedUntil: optionalEpoch(row.claimed_until),
  };
}
