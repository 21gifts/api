/**
 * Persistence for private messaging threads (member↔member, member↔platform,
 * member↔Damus, closed moderator_group singleton).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. New public tables are covered by `db_change` attach.
 */

import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { FetchFn } from '@/lib/btc-usd-candles';
import {
  CONVERSATION_LIST_LIMIT,
  conversationIsInbound,
  type ConversationKind,
  type ConversationMessageRow,
  type ConversationThread,
} from '@/lib/conversation';
import type { ForumPhoto, ForumPhotoContentType, NostrPublishState } from '@/lib/message';
import {
  fiatFromSats,
  satsToUsdCents,
  usdCentsToFiatCents,
  usdCentsToString,
  type FiatAmounts,
} from '@/lib/money';
import { normalizeSignedEvent } from '@/lib/nostr/publish';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';

/** Spot + daily crosses used when a conversation payment omits an explicit snapshot. */
interface PaymentFiatStoreOptions {
  fetchImpl?: FetchFn;
  fiatRates?: FiatRateBook;
  now?: () => number;
}

interface ConversationFiatBackfillRow {
  id: string;
  created_at: Date | string;
  amount_sats: number | string | bigint;
}

interface ConversationFiatBackfillRateRow {
  day: Date | string;
  usd_per_btc: string | number;
  quote: string | null;
  rate: string | number | null;
}

/**
 * Resolve the optional payment snapshot.
 *
 * An explicit `null` stays null (caller already tried). Omitted fiat on a
 * positive-sat row fetches one spot; a null spot or a Frankfurter failure
 * does not throw.
 *
 * @param sats - Whole sats on the row.
 * @param createdAt - Row creation instant (UTC day for crosses).
 * @param supplied - Caller snapshot, `null`, or omitted.
 * @param options - Spot fetch, rate book, and clock.
 * @returns Snapshot, `null` when pricing failed, or `undefined` when the row is unpaid
 *   and the caller omitted fiat.
 */
async function resolveConversationFiat(
  sats: number,
  createdAt: Date,
  supplied: FiatAmounts | null | undefined,
  options: Required<PaymentFiatStoreOptions>,
): Promise<FiatAmounts | null | undefined> {
  if (supplied !== undefined) {
    return supplied;
  }
  if (sats <= 0) {
    return undefined;
  }
  const spot = await fetchBtcUsdSpot(options.fetchImpl);
  if (spot === null) {
    return null;
  }
  const day = createdAt.toISOString().slice(0, 10);
  try {
    const crosses = (await options.fiatRates.ensureDays([day], options.now())).get(day) ?? {};
    return fiatFromSats(sats, spot, crosses);
  } catch {
    try {
      return fiatFromSats(sats, spot, {});
    } catch {
      return null;
    }
  }
}

/**
 * Copy amount fields from an explicit snapshot. `undefined` leaves the row.
 *
 * @param row - Message being stored.
 * @param fiat - Snapshot, `null`, or omitted.
 * @returns Row with payment-time amounts applied when `fiat` was passed.
 */
function withConversationFiat(
  row: ConversationMessageRow,
  fiat: FiatAmounts | null | undefined,
): ConversationMessageRow {
  if (fiat === undefined) {
    return row;
  }
  if (fiat === null) {
    return {
      ...row,
      amountUsd: null,
      amountChf: null,
      amountEur: null,
      amountPhp: null,
    };
  }
  return {
    ...row,
    amountUsd: fiat.usd,
    amountChf: fiat.chf,
    amountEur: fiat.eur,
    amountPhp: fiat.php,
  };
}

function paymentFiatOptions(options: PaymentFiatStoreOptions): Required<PaymentFiatStoreOptions> {
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    fiatRates: options.fiatRates ?? new InMemoryFiatStore(),
    now: options.now ?? Date.now,
  };
}

function textOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

/** UTC day, or `null` when `created_at` is not a real timestamp. */
function utcDayOrNull(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Network-free backfill of conversation payments from daily rate tables.
 *
 * Rows that already have `fiat_usd`, or whose UTC day has no BTC close, stay
 * untouched. A `created_at` that is not a real timestamp is skipped. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 */
async function backfillConversationFiat(sql: SqlClient): Promise<void> {
  const candidates = await sql.query<ConversationFiatBackfillRow>(
    `SELECT id, created_at, sats AS amount_sats
     FROM conversation_message
     WHERE sats > 0 AND fiat_usd IS NULL`,
  );
  const days = [
    ...new Set(
      candidates.flatMap((row) => {
        const day = utcDayOrNull(row.created_at);
        return day === null ? [] : [day];
      }),
    ),
  ];
  if (days.length === 0) {
    return;
  }
  const placeholders = days.map((_, index) => `$${index + 1}::date`).join(', ');
  const rateRows = await sql.query<ConversationFiatBackfillRateRow>(
    `SELECT b.day::text AS day, b.usd_per_btc::text AS usd_per_btc,
            f.quote, f.rate::text AS rate
     FROM btc_usd_daily b
     LEFT JOIN usd_fiat_daily f ON f.day = b.day AND f.quote IN ('CHF', 'EUR', 'PHP')
     WHERE b.day IN (${placeholders})`,
    days,
  );
  const rates = new Map<string, { usdPerBtc: string; crosses: Record<string, string> }>();
  for (const row of rateRows) {
    const day = String(row.day).slice(0, 10);
    const value = rates.get(day) ?? { usdPerBtc: String(row.usd_per_btc), crosses: {} };
    if (row.quote !== null && row.rate !== null) {
      value.crosses[row.quote] = String(row.rate);
    }
    rates.set(day, value);
  }
  for (const row of candidates) {
    const day = utcDayOrNull(row.created_at);
    if (day === null) {
      continue;
    }
    const rate = rates.get(day);
    if (rate === undefined) {
      continue;
    }
    const usdCents = satsToUsdCents(Number(row.amount_sats), rate.usdPerBtc);
    const quote = (code: 'CHF' | 'EUR' | 'PHP'): string | null => {
      const cross = rate.crosses[code];
      return cross === undefined ? null : usdCentsToString(usdCentsToFiatCents(usdCents, cross));
    };
    await sql.execute(
      `UPDATE conversation_message
       SET fiat_usd = $2::numeric, fiat_chf = $3::numeric,
           fiat_eur = $4::numeric, fiat_php = $5::numeric
       WHERE id = $1 AND fiat_usd IS NULL`,
      [row.id, usdCentsToString(usdCents), quote('CHF'), quote('EUR'), quote('PHP')],
    );
  }
}

/** Keyset query for one messenger-style conversation page. */
export type ConversationThreadPageQuery = {
  conversationId: string;
  limit: number;
  cursor: { c: Date; i: string } | null;
};

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
   * @param staff - Moderator (sees all platform threads).
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
   * Every thread newest `lastMessageAt` first, then `id` desc, capped at
   * `limit`. Operator dump; not {@link ConversationStore.listVisible}.
   *
   * @param limit - Maximum rows.
   * @returns Thread copies.
   */
  listAll(limit: number): Promise<ConversationThread[]>;

  /**
   * Every conversation message newest `createdAt` first, then `id` desc,
   * capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Message copies.
   */
  listAllMessages(limit: number): Promise<ConversationMessageRow[]>;

  /**
   * Every last-read stamp newest `lastReadAt` first, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Read-row copies.
   */
  listAllReads(
    limit: number,
  ): Promise<Array<{ accountId: string; conversationId: string; lastReadAt: Date }>>;

  /**
   * True when the thread has at least one inbound message for the viewer
   * (`conversationIsInbound`). Used by GET /conversations to omit empty
   * and outbound-only threads.
   *
   * @param conversationId - Thread to inspect.
   * @param viewerId - Session account.
   * @param staff - Moderator (kept for callers; direction uses actor).
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
   * @param staff - Moderator (kept for callers; direction uses actor).
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
   * Number of inbound messages on this thread whose `createdAt` is strictly
   * greater than this viewer's last-read stamp. Missing last-read means never
   * read (every inbound counts). Outbound-only and empty are `0`. Same inbound
   * predicate as `hasUnread` (`hasUnread` is true when this count is greater
   * than `0`).
   *
   * @param conversationId - Thread to inspect.
   * @param viewerId - Session account.
   * @param staff - Moderator (kept for callers; direction uses actor).
   * @param platformId - Official platform account id, or `null` when none.
   * @returns Non-negative inbound unread count for that viewer on this thread.
   */
  countUnread(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<number>;

  /**
   * Count of listed inbox threads with unread inbound for this viewer.
   * Same visibility as GET `/conversations` `unreadCount`: listed threads
   * with `hasUnread`. Outbound-only own platform tickets are listed but
   * unread false. Empty/outbound-only member threads omitted. Scan capped
   * at `CONVERSATION_LIST_LIMIT`.
   *
   * @param accountId - Session account.
   * @param staff - Moderator (sees all platform threads).
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
   * Newest page for a conversation, returned oldest-first within the page.
   *
   * @param query - Conversation, page size, and exclusive older cursor.
   * @returns At most `limit` caller-owned message rows.
   */
  listThreadPage(query: ConversationThreadPageQuery): Promise<ConversationMessageRow[]>;

  /**
   * Persist a message and bump `lastMessageAt`. Duplicate message `id` or
   * `eventId` returns the existing row and does not insert extras.
   *
   * `extraPhotos` are indices 1..length (max 9). Empty/omitted = none. When
   * extras are non-empty, `photo` (index 0) is required.
   *
   * @param row - Fully formed message.
   * @param photo - Optional decoded photo (copied into storage; index 0).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9).
   * @param fiat - Payment-time snapshot. `null` stores null amounts. Omit on
   *   a positive-sat row to freeze one spot (null spot still stores the row).
   * @returns The stored row (a copy) with `hasPhoto` / `photoCount` from
   *   stored stills. On duplicate id / eventId, the existing row.
   * @throws When extras are present without photo 0, when extras exceed 9,
   *   or when persistence fails.
   */
  appendMessage(
    row: ConversationMessageRow,
    photo?: ForumPhoto,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<ConversationMessageRow>;

  /**
   * Load photo bytes for a conversation message id (index 0).
   *
   * @param id - Message id.
   * @returns A copy of the photo, or `null` when missing / no photo.
   */
  getPhoto(id: string): Promise<ForumPhoto | null>;

  /**
   * Load one extra still (indices 1–9) for a conversation message id.
   *
   * @param id - Message id.
   * @param index - Extra index (1–9). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range.
   */
  getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null>;

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

/** Idempotent SQL for conversation tables (DDL plus boot-time unwrap of `nostr_event` values stored as jsonb string scalars in `conversation_message` and a one-time stipend `gift_for_message_id` backfill; `docs/schema/conversation.sql` mirrors the DDL and documents the boot repair statements by comment, the `DO $unwrap$` and stipend-repair `DO` blocks live only in this array). */
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
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS actor_account_id uuid REFERENCES account (id)`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS actor_name text NOT NULL DEFAULT ''`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS gift_for_message_id uuid`,
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
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS photo bytea`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS photo_content_type text`,
  `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS photo_taken_at text`,
  `CREATE TABLE IF NOT EXISTS conversation_message_extra_photo (
  message_id uuid NOT NULL REFERENCES conversation_message (id) ON DELETE CASCADE,
  idx smallint NOT NULL,
  photo bytea NOT NULL,
  photo_content_type text NOT NULL,
  photo_taken_at text,
  PRIMARY KEY (message_id, idx),
  CONSTRAINT conversation_message_extra_photo_idx_range CHECK (idx >= 1 AND idx <= 9)
)`,
  `ALTER TABLE conversation_message_extra_photo ADD COLUMN IF NOT EXISTS photo_taken_at text`,
  `CREATE TABLE IF NOT EXISTS conversation_message_translation (
  message_id uuid NOT NULL REFERENCES conversation_message (id) ON DELETE CASCADE,
  target_lang text NOT NULL,
  source_sha256 text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, target_lang)
)`,
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
  `CREATE INDEX IF NOT EXISTS conversation_message_gift_unlinked_idx
   ON conversation_message (conversation_id, created_at)
   WHERE gift_for_message_id IS NULL AND sats > 0 AND actor_account_id IS NULL`,
  `-- One-time repair for stipend rows written before gift_for_message_id existed.
   -- Links a row only when exactly one message of someone else precedes it within
   -- five minutes; anything ambiguous stays NULL and is not written at all.
   -- A candidate needs an account sender or actor (moderator_group rows always
   -- have one); the partial index above keeps the per-boot check off a full scan.
   -- Skipped until the db_change audit trigger is attached, like the unwrap repair.
   DO $gift_for$
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
     WITH candidate AS (
       SELECT s.id AS stipend_id, (array_agg(m.id))[1] AS trigger_id
       FROM conversation_message s
       JOIN conversation c ON c.id = s.conversation_id AND c.kind = 'moderator_group'
       JOIN conversation_message m
         ON m.conversation_id = s.conversation_id
        AND m.created_at <= s.created_at
        AND m.created_at >= s.created_at - interval '5 minutes'
        AND m.id <> s.id
        AND COALESCE(m.actor_account_id, m.sender_account_id) <> s.sender_account_id
       WHERE s.gift_for_message_id IS NULL
         AND s.sats > 0
         AND s.actor_account_id IS NULL
         AND s.sender_account_id = (SELECT id FROM account WHERE is_platform = true LIMIT 1)
       GROUP BY s.id
       HAVING COUNT(*) = 1
     )
     UPDATE conversation_message s
     SET gift_for_message_id = candidate.trigger_id
     FROM candidate
     WHERE s.id = candidate.stipend_id;
   END;
   $gift_for$;`,
];

const THREAD_SELECT = `c.id, c.kind, c.account_a, c.account_b, c.counterpart_pubkey, c.created_at, c.last_message_at,
  COALESCE((
    SELECT m.text FROM conversation_message m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ), '') AS last_text,
  (SELECT m.id FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_id,
  (SELECT m.sender_account_id FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_sender_account_id,
  (SELECT m.actor_account_id FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_actor_account_id,
  COALESCE((
    SELECT m.sats FROM conversation_message m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ), 0) AS last_sats,
  (SELECT m.fiat_usd::text FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_fiat_usd,
  (SELECT m.fiat_chf::text FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_fiat_chf,
  (SELECT m.fiat_eur::text FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_fiat_eur,
  (SELECT m.fiat_php::text FROM conversation_message m
   WHERE m.conversation_id = c.id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1) AS last_fiat_php`;

const MESSAGE_SELECT = `id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name, sats,
  fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
  fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php,
  event_id, nostr_publish_state, nostr_event, claimed_until, actor_account_id, actor_name, gift_for_message_id,
  (photo IS NOT NULL) AS has_photo,
  ((photo IS NOT NULL)::int + COALESCE((SELECT COUNT(*)::int FROM conversation_message_extra_photo e WHERE e.message_id = conversation_message.id), 0)) AS photo_count`;

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
  await backfillConversationFiat(sql);
}

/**
 * Process-local {@link ConversationStore}. Used in tests and when no
 * database URL is configured — the process still boots.
 */
export class InMemoryConversationStore implements ConversationStore {
  readonly #threads: ConversationThread[];
  readonly #messages: ConversationMessageRow[];
  readonly #lastRead: Map<string, Date>;
  readonly #photos = new Map<string, ForumPhoto>();
  /** Extra stills; array index 0 = idx 1. */
  readonly #extraPhotos = new Map<string, ForumPhoto[]>();
  readonly #paymentFiat: Required<PaymentFiatStoreOptions>;

  /**
   * @param seedThreads - Optional seed threads; copied into private storage.
   * @param seedMessages - Optional seed messages; copied into private storage.
   * @param seedLastRead - Optional last-read stamps; Dates copied into a private map.
   * @param options - Spot fetch and fiat book used when `appendMessage` omits fiat.
   */
  constructor(
    seedThreads: readonly ConversationThread[] = [],
    seedMessages: readonly ConversationMessageRow[] = [],
    seedLastRead: readonly {
      accountId: string;
      conversationId: string;
      lastReadAt: Date;
    }[] = [],
    options: PaymentFiatStoreOptions = {},
  ) {
    this.#threads = seedThreads.map((thread) => copyThread(thread));
    this.#messages = seedMessages.map((row) => copyMessage(row));
    this.#paymentFiat = paymentFiatOptions(options);
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

  listAll(limit: number): Promise<ConversationThread[]> {
    const listed = [...this.#threads]
      .sort(compareThreadsNewestFirst)
      .slice(0, limit)
      .map((thread) => this.#hydrate(thread));
    return Promise.resolve(listed);
  }

  listAllMessages(limit: number): Promise<ConversationMessageRow[]> {
    const listed = [...this.#messages]
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit)
      .map((row) => copyMessage(row));
    return Promise.resolve(listed);
  }

  listAllReads(
    limit: number,
  ): Promise<Array<{ accountId: string; conversationId: string; lastReadAt: Date }>> {
    const listed = [...this.#lastRead.entries()]
      .map(([key, lastReadAt]) => {
        const split = key.indexOf('\0');
        return {
          accountId: key.slice(0, split),
          conversationId: key.slice(split + 1),
          lastReadAt: new Date(lastReadAt.getTime()),
        };
      })
      .sort((a, b) => b.lastReadAt.getTime() - a.lastReadAt.getTime())
      .slice(0, limit);
    return Promise.resolve(listed);
  }

  hasInboundMessage(
    conversationId: string,
    viewerId: string,
    _staff: boolean,
    _platformId: string | null,
  ): Promise<boolean> {
    return Promise.resolve(
      this.#messages.some(
        (row) =>
          row.conversationId === conversationId &&
          conversationIsInbound({
            senderAccountId: row.senderAccountId,
            actorAccountId: row.actorAccountId ?? null,
            viewerId,
          }),
      ),
    );
  }

  hasUnread(
    conversationId: string,
    viewerId: string,
    _staff: boolean,
    _platformId: string | null,
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
            actorAccountId: row.actorAccountId ?? null,
            viewerId,
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

  countUnread(
    conversationId: string,
    viewerId: string,
    _staff: boolean,
    _platformId: string | null,
  ): Promise<number> {
    const stamp = this.#lastRead.get(lastReadKey(viewerId, conversationId));
    return Promise.resolve(
      this.#messages.filter((row) => {
        if (row.conversationId !== conversationId) {
          return false;
        }
        if (
          !conversationIsInbound({
            senderAccountId: row.senderAccountId,
            actorAccountId: row.actorAccountId ?? null,
            viewerId,
          })
        ) {
          return false;
        }
        if (stamp === undefined) {
          return true;
        }
        return row.createdAt.getTime() > stamp.getTime();
      }).length,
    );
  }

  /**
   * Count listed unread threads for this viewer (GET list rules).
   *
   * @param accountId - Session account.
   * @param staff - Moderator.
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

  /** Copy a row and set `hasPhoto` / `photoCount` from the photo maps. */
  #withListedMedia(row: ConversationMessageRow): ConversationMessageRow {
    const copy = copyMessage(row);
    const hasPhoto0 = this.#photos.has(row.id) || row.hasPhoto === true;
    copy.hasPhoto = hasPhoto0;
    copy.photoCount = (hasPhoto0 ? 1 : 0) + (this.#extraPhotos.get(row.id)?.length ?? 0);
    return copy;
  }

  getMessageById(id: string): Promise<ConversationMessageRow | undefined> {
    const row = this.#messages.find((item) => item.id === id);
    return Promise.resolve(row === undefined ? undefined : this.#withListedMedia(row));
  }

  getMessageByEventId(eventId: string): Promise<ConversationMessageRow | undefined> {
    const row = this.#messages.find((item) => item.eventId === eventId);
    return Promise.resolve(row === undefined ? undefined : this.#withListedMedia(row));
  }

  listMessages(conversationId: string, limit: number): Promise<ConversationMessageRow[]> {
    const listed = this.#messages
      .filter((row) => row.conversationId === conversationId)
      .sort(compareMessagesOldestFirst)
      .slice(0, limit)
      .map((row) => this.#withListedMedia(row));
    return Promise.resolve(listed);
  }

  listThreadPage(query: ConversationThreadPageQuery): Promise<ConversationMessageRow[]> {
    const listed = this.#messages
      .filter((row) => {
        if (row.conversationId !== query.conversationId) {
          return false;
        }
        if (query.cursor === null) {
          return true;
        }
        const byTime = row.createdAt.getTime() - query.cursor.c.getTime();
        return byTime < 0 || (byTime === 0 && row.id.localeCompare(query.cursor.i) < 0);
      })
      .sort(compareMessagesNewestFirst)
      .slice(0, query.limit)
      .reverse()
      .map((row) => this.#withListedMedia(row));
    return Promise.resolve(listed);
  }

  /**
   * Persist a message and optional stills; return a copy.
   *
   * @param row - Message to store.
   * @param photo - Optional photo (bytes copied; index 0).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9).
   * @param fiat - Payment-time snapshot, or `null`. Omit to freeze a spot when `sats > 0`.
   * @returns A copy of the stored row with `hasPhoto` / `photoCount` from
   *   stored stills. Duplicate `id` / `eventId` returns the existing row
   *   without inserting extras.
   * @throws When extras are present without photo 0 or extras exceed 9.
   */
  async appendMessage(
    row: ConversationMessageRow,
    photo?: ForumPhoto,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<ConversationMessageRow> {
    const existingById = this.#messages.find((item) => item.id === row.id);
    if (existingById !== undefined) {
      return Promise.resolve(this.#withListedMedia(existingById));
    }
    if (row.eventId !== null) {
      const existing = this.#messages.find((item) => item.eventId === row.eventId);
      if (existing !== undefined) {
        return Promise.resolve(this.#withListedMedia(existing));
      }
    }
    const extras = [...(extraPhotos ?? [])];
    if (extras.length > 0 && photo === undefined) {
      return Promise.reject(new Error('extra photos require photo 0'));
    }
    if (extras.length > 9) {
      return Promise.reject(new Error('at most 9 extra photos'));
    }
    const hasPhoto = photo !== undefined;
    const snapshot = await resolveConversationFiat(
      row.sats,
      row.createdAt,
      fiat,
      this.#paymentFiat,
    );
    const stored = copyMessage(
      withConversationFiat(
        {
          ...row,
          hasPhoto,
          photoCount: (hasPhoto ? 1 : 0) + extras.length,
        },
        snapshot,
      ),
    );
    this.#messages.push(stored);
    if (photo !== undefined) {
      this.#photos.set(stored.id, copyPhoto(photo));
    }
    if (extras.length > 0) {
      this.#extraPhotos.set(
        stored.id,
        extras.map((item) => copyPhoto(item)),
      );
    }
    const thread = this.#threads.find((item) => item.id === row.conversationId);
    if (thread !== undefined && row.createdAt.getTime() >= thread.lastMessageAt.getTime()) {
      thread.lastMessageAt = new Date(row.createdAt.getTime());
    }
    return Promise.resolve(this.#withListedMedia(stored));
  }

  /**
   * Return a copy of the photo for `id`, or `null`.
   *
   * @param id - Message id.
   * @returns Photo copy or `null`.
   */
  getPhoto(id: string): Promise<ForumPhoto | null> {
    const photo = this.#photos.get(id);
    return Promise.resolve(photo === undefined ? null : copyPhoto(photo));
  }

  /**
   * Load one extra still (indices 1–9) for a message id.
   *
   * @param id - Message id.
   * @param index - Extra index (1–9). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range.
   */
  getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null> {
    if (index < 1 || index > 9) {
      return Promise.resolve(null);
    }
    const list = this.#extraPhotos.get(id);
    const photo = list?.[index - 1];
    return Promise.resolve(photo === undefined ? null : copyPhoto(photo));
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
      lastMessageId: null,
      lastSenderAccountId: null,
      lastSats: 0,
      lastActorAccountId: null,
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
      lastMessageId: last?.id ?? null,
      lastSenderAccountId: last?.senderAccountId ?? null,
      lastSats: last?.sats ?? 0,
      lastAmountUsd: last?.amountUsd ?? null,
      lastAmountChf: last?.amountChf ?? null,
      lastAmountEur: last?.amountEur ?? null,
      lastAmountPhp: last?.amountPhp ?? null,
      lastActorAccountId: last?.actorAccountId ?? null,
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
  last_id?: string | null;
  last_sender_account_id?: string | null;
  last_actor_account_id?: string | null;
  last_sats?: string | number | null;
  last_fiat_usd?: string | number | null;
  last_fiat_chf?: string | number | null;
  last_fiat_eur?: string | number | null;
  last_fiat_php?: string | number | null;
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
  fiat_usd?: string | number | null;
  fiat_chf?: string | number | null;
  fiat_eur?: string | number | null;
  fiat_php?: string | number | null;
  event_id: string | null;
  nostr_publish_state: string | null;
  nostr_event: Record<string, unknown> | string | null;
  claimed_until: Date | string | null;
  actor_account_id: string | null;
  actor_name: string | null;
  gift_for_message_id: string | null;
  has_photo?: boolean | number | string | null;
  photo_count?: number | string | null;
}

/** Row shape for `getPhoto` / `getExtraPhoto`. */
interface ConversationPhotoSqlRow {
  photo: Uint8Array | Buffer | number[] | null;
  photo_content_type: string | null;
  photo_taken_at?: string | null;
}

const FORUM_PHOTO_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Durable {@link ConversationStore} backed by Postgres.
 */
export class PostgresConversationStore implements ConversationStore {
  readonly #sql: SqlClient;
  readonly #paymentFiat: Required<PaymentFiatStoreOptions>;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   * @param options - Spot fetch and fiat book used when `appendMessage` omits fiat.
   */
  constructor(sql: SqlClient, options: PaymentFiatStoreOptions = {}) {
    this.#sql = sql;
    this.#paymentFiat = paymentFiatOptions(options);
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

  async listAll(limit: number): Promise<ConversationThread[]> {
    const rows = await this.#sql.query<ConversationSqlRow>(
      `SELECT ${THREAD_SELECT}
       FROM conversation c
       ORDER BY c.last_message_at DESC, c.id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapThread(row));
  }

  async listAllMessages(limit: number): Promise<ConversationMessageRow[]> {
    const rows = await this.#sql.query<ConversationMessageSqlRow>(
      `SELECT ${MESSAGE_SELECT}
       FROM conversation_message
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapMessage(row));
  }

  async listAllReads(
    limit: number,
  ): Promise<Array<{ accountId: string; conversationId: string; lastReadAt: Date }>> {
    const rows = await this.#sql.query<{
      account_id: string;
      conversation_id: string;
      last_read_at: Date | string;
    }>(
      `SELECT account_id, conversation_id, last_read_at
       FROM conversation_read
       ORDER BY last_read_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      conversationId: row.conversation_id,
      lastReadAt: row.last_read_at instanceof Date ? row.last_read_at : new Date(row.last_read_at),
    }));
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
           AND COALESCE(actor_account_id, sender_account_id) IS DISTINCT FROM $2
           AND ($3::boolean IS DISTINCT FROM NULL OR $4::uuid IS NULL OR TRUE)
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
           AND COALESCE(actor_account_id, sender_account_id) IS DISTINCT FROM $2
           AND ($3::boolean IS DISTINCT FROM NULL OR $4::uuid IS NULL OR TRUE)
           AND (
             conversation_read.last_read_at IS NULL
             OR conversation_message.created_at > conversation_read.last_read_at
           )
       ) AS exists`,
      [conversationId, viewerId, staff, platformId],
    );
    return rows[0]?.exists === true;
  }

  async countUnread(
    conversationId: string,
    viewerId: string,
    staff: boolean,
    platformId: string | null,
  ): Promise<number> {
    const rows = await this.#sql.query<{ count: number | string | bigint }>(
      `SELECT COUNT(*)::bigint AS count
       FROM conversation_message
       LEFT JOIN conversation_read
         ON conversation_read.account_id = $2
        AND conversation_read.conversation_id = conversation_message.conversation_id
       WHERE conversation_message.conversation_id = $1
         AND COALESCE(actor_account_id, sender_account_id) IS DISTINCT FROM $2
         AND ($3::boolean IS DISTINCT FROM NULL OR $4::uuid IS NULL OR TRUE)
         AND (
           conversation_read.last_read_at IS NULL
           OR conversation_message.created_at > conversation_read.last_read_at
         )`,
      [conversationId, viewerId, staff, platformId],
    );
    return mapCount(rows[0]?.count);
  }

  /**
   * Count listed unread threads for this viewer (GET list rules).
   *
   * @param accountId - Session account.
   * @param staff - Moderator.
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

  async listThreadPage(query: ConversationThreadPageQuery): Promise<ConversationMessageRow[]> {
    const rows =
      query.cursor === null
        ? await this.#sql.query<ConversationMessageSqlRow>(
            `SELECT ${MESSAGE_SELECT}
             FROM conversation_message
             WHERE conversation_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [query.conversationId, query.limit],
          )
        : await this.#sql.query<ConversationMessageSqlRow>(
            `SELECT ${MESSAGE_SELECT}
             FROM conversation_message
             WHERE conversation_id = $1
               AND (created_at < $3 OR (created_at = $3 AND id < $4))
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [query.conversationId, query.limit, query.cursor.c, query.cursor.i],
          );
    return rows.slice().reverse().map(mapMessage);
  }

  /**
   * Persist a message and optional stills; return a copy.
   *
   * @param row - Message to store.
   * @param photo - Optional photo (bytes copied; index 0).
   * @param extraPhotos - Optional extra stills (indices 1..n, max 9).
   * @param fiat - Payment-time snapshot, or `null`. Omit to freeze a spot when `sats > 0`.
   * @returns The stored row with `hasPhoto` / `photoCount` from stored
   *   stills. Duplicate `id` / `eventId` returns the existing row without
   *   inserting extras.
   * @throws When extras are present without photo 0, when extras exceed 9,
   *   or when persistence fails.
   */
  async appendMessage(
    row: ConversationMessageRow,
    photo?: ForumPhoto,
    extraPhotos?: readonly ForumPhoto[],
    fiat?: FiatAmounts | null,
  ): Promise<ConversationMessageRow> {
    const extras = [...(extraPhotos ?? [])];
    if (extras.length > 0 && photo === undefined) {
      throw new Error('extra photos require photo 0');
    }
    if (extras.length > 9) {
      throw new Error('at most 9 extra photos');
    }
    const hasPhoto = photo !== undefined;
    const snapshot = await resolveConversationFiat(
      row.sats,
      row.createdAt,
      fiat,
      this.#paymentFiat,
    );
    const stored = copyMessage(
      withConversationFiat(
        {
          ...row,
          hasPhoto,
          photoCount: (hasPhoto ? 1 : 0) + extras.length,
        },
        snapshot,
      ),
    );
    try {
      await this.#sql.execute(
        `INSERT INTO conversation_message (
           id, conversation_id, text, created_at, sender_account_id, sender_pubkey, name, sats,
           event_id, nostr_publish_state, nostr_event, claimed_until, actor_account_id, actor_name,
           gift_for_message_id, photo, photo_content_type, photo_taken_at,
           fiat_usd, fiat_chf, fiat_eur, fiat_php
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,
                   $19::numeric,$20::numeric,$21::numeric,$22::numeric)`,
        [
          stored.id,
          stored.conversationId,
          stored.text,
          stored.createdAt,
          stored.senderAccountId,
          stored.senderPubkey,
          stored.name,
          stored.sats,
          stored.eventId,
          stored.nostrPublishState,
          stored.nostrEvent,
          stored.claimedUntil === null ? null : new Date(stored.claimedUntil),
          row.actorAccountId ?? null,
          row.actorName ?? '',
          row.giftForMessageId ?? null,
          photo === undefined ? null : photo.bytes,
          photo === undefined ? null : photo.contentType,
          photo === undefined || typeof photo.takenAt !== 'string' ? null : photo.takenAt,
          stored.amountUsd ?? null,
          stored.amountChf ?? null,
          stored.amountEur ?? null,
          stored.amountPhp ?? null,
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
    for (const [i, extra] of extras.entries()) {
      try {
        await this.#sql.execute(
          `INSERT INTO conversation_message_extra_photo (message_id, idx, photo, photo_content_type, photo_taken_at) VALUES ($1,$2,$3,$4,$5)`,
          [
            stored.id,
            i + 1,
            extra.bytes,
            extra.contentType,
            typeof extra.takenAt === 'string' ? extra.takenAt : null,
          ],
        );
      } catch (error: unknown) {
        await this.#sql.execute(`DELETE FROM conversation_message WHERE id = $1`, [stored.id]);
        throw error;
      }
    }
    await this.#sql.execute(
      `UPDATE conversation SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1`,
      [stored.conversationId, stored.createdAt],
    );
    return stored;
  }

  /**
   * Load photo bytes for a conversation message id (index 0).
   *
   * @param id - Message id (`$1`).
   * @returns Photo copy, or `null` when missing / null photo / bad type.
   */
  async getPhoto(id: string): Promise<ForumPhoto | null> {
    const rows = await this.#sql.query<ConversationPhotoSqlRow>(
      `SELECT photo, photo_content_type, photo_taken_at FROM conversation_message WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined || row.photo === null || row.photo_content_type === null) {
      return null;
    }
    if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
      return null;
    }
    const photo: ForumPhoto = {
      contentType: row.photo_content_type as ForumPhotoContentType,
      bytes: toUint8Array(row.photo),
    };
    if (typeof row.photo_taken_at === 'string') {
      photo.takenAt = row.photo_taken_at;
    }
    return photo;
  }

  /**
   * Load one extra still (indices 1–9) for a conversation message id.
   *
   * @param id - Message id (`$1`).
   * @param index - Extra index (1–9) (`$2`). Values outside that range return `null`.
   * @returns A copy of the extra photo, or `null` when missing / out of range / bad type.
   */
  async getExtraPhoto(id: string, index: number): Promise<ForumPhoto | null> {
    if (index < 1 || index > 9) {
      return null;
    }
    const rows = await this.#sql.query<ConversationPhotoSqlRow>(
      `SELECT photo, photo_content_type, photo_taken_at FROM conversation_message_extra_photo WHERE message_id = $1 AND idx = $2`,
      [id, index],
    );
    const row = rows[0];
    if (row === undefined || row.photo === null || row.photo_content_type === null) {
      return null;
    }
    if (!FORUM_PHOTO_TYPES.has(row.photo_content_type)) {
      return null;
    }
    const photo: ForumPhoto = {
      contentType: row.photo_content_type as ForumPhotoContentType,
      bytes: toUint8Array(row.photo),
    };
    if (typeof row.photo_taken_at === 'string') {
      photo.takenAt = row.photo_taken_at;
    }
    return photo;
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

function copyPhoto(photo: ForumPhoto): ForumPhoto {
  const copy: ForumPhoto = { contentType: photo.contentType, bytes: photo.bytes.slice() };
  if (typeof photo.takenAt === 'string') {
    copy.takenAt = photo.takenAt;
  }
  return copy;
}

function copyMessage(row: ConversationMessageRow): ConversationMessageRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
    nostrEvent: row.nostrEvent === null ? null : { ...row.nostrEvent },
    actorAccountId: row.actorAccountId ?? null,
    actorName: row.actorName ?? '',
    hasPhoto: row.hasPhoto === true,
    photoCount: typeof row.photoCount === 'number' ? row.photoCount : row.hasPhoto === true ? 1 : 0,
  };
}

/** Coerce Postgres bytea drivers into a fresh {@link Uint8Array}. */
function toUint8Array(value: Uint8Array | Buffer | number[]): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  return Uint8Array.from(value);
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
    lastMessageId: row.last_id ?? null,
    lastSenderAccountId: row.last_sender_account_id ?? null,
    lastSats: Number(row.last_sats ?? 0),
    lastAmountUsd: textOrNull(row.last_fiat_usd),
    lastAmountChf: textOrNull(row.last_fiat_chf),
    lastAmountEur: textOrNull(row.last_fiat_eur),
    lastAmountPhp: textOrNull(row.last_fiat_php),
    lastActorAccountId: row.last_actor_account_id ?? null,
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
  const hasPhoto = Boolean(row.has_photo);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    createdAt: asDate(row.created_at),
    senderAccountId: row.sender_account_id,
    senderPubkey: row.sender_pubkey,
    name: row.name,
    actorAccountId: row.actor_account_id,
    actorName: row.actor_name ?? '',
    giftForMessageId: row.gift_for_message_id,
    sats: Number(row.sats ?? 0),
    amountUsd: textOrNull(row.fiat_usd),
    amountChf: textOrNull(row.fiat_chf),
    amountEur: textOrNull(row.fiat_eur),
    amountPhp: textOrNull(row.fiat_php),
    hasPhoto,
    /* v8 ignore next -- photo_count is selected; null only on a pre-migration row */
    photoCount: Number(row.photo_count ?? (hasPhoto ? 1 : 0)),
    eventId: row.event_id,
    nostrPublishState:
      state === 'pending' || state === 'published' || state === 'failed' || state === 'skipped'
        ? state
        : 'pending',
    nostrEvent: normalizeSignedEvent(row.nostr_event) ?? null,
    claimedUntil: optionalEpoch(row.claimed_until),
  };
}

function mapCount(value: number | string | bigint | undefined): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return 0;
}
