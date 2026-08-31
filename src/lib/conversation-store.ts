/**
 * Persistence for private messaging threads (member↔member, member↔platform,
 * member↔Damus).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. New public tables are covered by `db_change` attach.
 */

import type { SqlClient } from '@/lib/auth/sql';
import {
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
   * Threads the viewer may see: own participation, plus every platform
   * thread when `staff` is true. Newest `lastMessageAt` first, then `id`
   * descending, capped at `limit`.
   *
   * @param accountId - Session account.
   * @param staff - Founder/moderator (sees all platform threads).
   * @param platformId - Official platform account id, or `null` when none.
   * @param limit - Maximum rows.
   */
  listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
  ): Promise<ConversationThread[]>;

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
   * Point every member→platform thread at `platformId` (operator retarget).
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
   * Persist a message and bump `lastMessageAt`. Duplicate `eventId` returns
   * the existing row.
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

/** Idempotent DDL for conversation tables (matches `docs/schema/conversation.sql`). */
export const CONVERSATION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('member_member', 'member_platform', 'member_damus')),
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
  `CREATE INDEX IF NOT EXISTS conversation_message_conversation_id_idx
  ON conversation_message (conversation_id, created_at ASC, id ASC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_event_id_uidx
  ON conversation_message (event_id)
  WHERE event_id IS NOT NULL`,
];

const THREAD_SELECT = `c.id, c.kind, c.account_a, c.account_b, c.counterpart_pubkey, c.created_at, c.last_message_at,
  COALESCE((
    SELECT m.text FROM conversation_message m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ), '') AS last_text`;

const MESSAGE_SELECT = `id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name,
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

  /**
   * @param seedThreads - Optional seed threads; copied into private storage.
   * @param seedMessages - Optional seed messages; copied into private storage.
   */
  constructor(
    seedThreads: readonly ConversationThread[] = [],
    seedMessages: readonly ConversationMessageRow[] = [],
  ) {
    this.#threads = seedThreads.map((thread) => copyThread(thread));
    this.#messages = seedMessages.map((row) => copyMessage(row));
  }

  getById(id: string): Promise<ConversationThread | undefined> {
    const thread = this.#threads.find((item) => item.id === id);
    return Promise.resolve(thread === undefined ? undefined : this.#hydrate(thread));
  }

  listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
  ): Promise<ConversationThread[]> {
    const listed = this.#threads
      .filter((thread) => visibleTo(thread, accountId, staff, platformId))
      .sort(compareThreadsNewestFirst)
      .slice(0, limit)
      .map((thread) => this.#hydrate(thread));
    return Promise.resolve(listed);
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
      if (thread.kind === 'member_platform') {
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

/** Row shape selected from `conversation` plus computed `last_text`. */
interface ConversationSqlRow {
  id: string;
  kind: string;
  account_a: string;
  account_b: string | null;
  counterpart_pubkey: string | null;
  created_at: Date | string;
  last_message_at: Date | string;
  last_text?: string | null;
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

  async listVisible(
    accountId: string,
    staff: boolean,
    platformId: string | null,
    limit: number,
  ): Promise<ConversationThread[]> {
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT}
       FROM conversation c
       WHERE c.account_a = $1 OR c.account_b = $1
          OR ($2::boolean AND c.kind = 'member_platform')
          OR ($2::boolean AND $3::uuid IS NOT NULL AND (c.account_a = $3 OR c.account_b = $3))
       ORDER BY c.last_message_at DESC, c.id DESC
       LIMIT $4`,
      [accountId, staff, platformId, limit],
    );
    return rows.map((row) => mapThread(row));
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
           id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name,
           event_id, nostr_publish_state, nostr_event, claimed_until
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          row.id,
          row.conversationId,
          row.text,
          row.createdAt,
          row.senderAccountId,
          row.senderPubkey,
          row.name,
          row.eventId,
          row.nostrPublishState,
          row.nostrEvent === null ? null : JSON.stringify(row.nostrEvent),
          row.claimedUntil === null ? null : new Date(row.claimedUntil),
        ],
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error) && row.eventId !== null) {
        const existing = await this.getMessageByEventId(row.eventId);
        if (existing !== undefined) {
          return existing;
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
        [id, eventId, JSON.stringify(nostrEvent)],
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
      `UPDATE conversation SET account_b = $1 WHERE kind = 'member_platform'`,
      [platformId],
    );
  }
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function visibleTo(
  thread: ConversationThread,
  accountId: string,
  staff: boolean,
  platformId: string | null,
): boolean {
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
  if (raw === 'member_member' || raw === 'member_platform' || raw === 'member_damus') {
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
    eventId: row.event_id,
    nostrPublishState:
      state === 'pending' || state === 'published' || state === 'failed' ? state : 'pending',
    nostrEvent: normalizeSignedEvent(row.nostr_event) ?? null,
    claimedUntil: optionalEpoch(row.claimed_until),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
