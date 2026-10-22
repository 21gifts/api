import type { GiftKind, GiftRow } from '@/lib/gift';
import type { SqlClient } from '@/lib/auth/sql';

const GIFT_FIAT_COLUMNS_SQL: readonly string[] = [
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2)`,
  `ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2)`,
];

interface GiftKindMatchRow {
  gift_id: number | string;
  message_id: string;
  message_text: string;
  abs_seconds: number | string;
}

const GIFT_KIND_MATCH_SQL = `SELECT g.id AS gift_id, m.id AS message_id, trim(m.text) AS message_text,
            abs(extract(epoch from (m.created_at - g.paid_at))) AS abs_seconds
     FROM gift g
     INNER JOIN message m
       ON m.parent_id IS NOT NULL
      AND trim(m.text) IN ('Welcome', '21gifts daily')
      AND m.sats = g.amount_sats
      AND abs(extract(epoch from (m.created_at - g.paid_at))) <= 3
     INNER JOIN account platform_account
       ON platform_account.id = m.account_id
      AND platform_account.is_platform IS TRUE
     INNER JOIN message parent_message
       ON parent_message.id = m.parent_id
     INNER JOIN account parent_author
       ON parent_author.id = parent_message.account_id
      AND lower(split_part(parent_author.lightning_address, '@', 1)) = lower(g.recipient_wos_user)
     WHERE g.kind IS NULL`;

const GIFT_KIND_TRIGGER_SQL = `SELECT 1
     FROM pg_trigger
     WHERE tgrelid = 'gift'::regclass
       AND tgname = 'trg_db_change'
       AND NOT tgisinternal`;

/**
 * Classify NULL `gift.kind` rows, then require the column.
 *
 * Skips until `trg_db_change` is attached to `gift`, so the UPDATEs land in
 * `db_change` and a boot that is still attaching the trigger retries next time.
 * Description `21gifts moderator` is moderator. Remaining NULL rows are matched
 * one-to-one against platform replies whose text is `Welcome` or `21gifts daily`;
 * only an assigned Welcome sets `welcome`. Welcome and every other still-NULL row
 * are one UPDATE, so a stopped boot cannot reuse that Welcome reply. The check
 * constraint counts only when it is on `gift`.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function repairGiftKind(sql: SqlClient): Promise<void> {
  const trigger = await sql.query<{ present: number }>(GIFT_KIND_TRIGGER_SQL);
  if (trigger.length === 0) {
    return;
  }
  await sql.execute(
    `UPDATE gift SET kind = 'moderator' WHERE kind IS NULL AND description = '21gifts moderator'`,
  );
  const remaining = await sql.query<{ id: number | string }>(
    `SELECT id FROM gift WHERE kind IS NULL LIMIT 1`,
  );
  let classified = false;
  if (remaining.length > 0) {
    const matches = await sql.query<GiftKindMatchRow>(GIFT_KIND_MATCH_SQL);
    const sorted = [...matches].sort((a, b) => Number(a.abs_seconds) - Number(b.abs_seconds));
    const usedGifts = new Set<string>();
    const usedMessages = new Set<string>();
    const welcomeIds: string[] = [];
    for (const row of sorted) {
      const giftId = String(row.gift_id);
      const messageId = String(row.message_id);
      if (usedGifts.has(giftId) || usedMessages.has(messageId)) {
        continue;
      }
      usedGifts.add(giftId);
      usedMessages.add(messageId);
      if (row.message_text === 'Welcome') {
        welcomeIds.push(giftId);
      }
    }
    if (welcomeIds.length > 0) {
      // Bun SQL sends a JS array as a malformed array literal, so the ids are `{1,2}`.
      await sql.execute(
        `UPDATE gift SET kind = CASE WHEN id = ANY($1::bigint[]) THEN 'welcome' ELSE 'daily' END WHERE kind IS NULL`,
        [`{${welcomeIds.join(',')}}`],
      );
      classified = true;
    }
  }
  if (!classified) {
    await sql.execute(`UPDATE gift SET kind = 'daily' WHERE kind IS NULL`);
  }
  const existing = await sql.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conname = 'gift_kind_check'
       AND conrelid = 'gift'::regclass
       AND contype = 'c'`,
  );
  if (existing.length === 0) {
    await sql.execute(
      `ALTER TABLE gift ADD CONSTRAINT gift_kind_check CHECK (kind IN ('daily','welcome','moderator'))`,
    );
  }
  await sql.execute(`ALTER TABLE gift ALTER COLUMN kind SET NOT NULL`);
}

/**
 * Add stored fiat columns. A null stays null. No later read fills it.
 *
 * `kind` is added here as a nullable column. {@link repairGiftKind} classifies
 * it after the audit trigger.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateGiftSchema(sql: SqlClient): Promise<void> {
  for (const statement of GIFT_FIAT_COLUMNS_SQL) {
    await sql.execute(statement);
  }
  await sql.execute(`ALTER TABLE gift ADD COLUMN IF NOT EXISTS kind text`);
}

/** Operator dump of one `gift` row (every stored column). */
export interface GiftDebugRow {
  /** Serial id, or `null` when the adapter does not store one. */
  id: number | null;
  /** Paid-at ISO-8601. */
  paidAt: string;
  /** Always `outbound` in v1. */
  direction: string;
  /** Currency code, or `null` when the adapter does not store one. */
  currency: string | null;
  /** Whole sats. */
  amountSats: number;
  /** Stored USD snapshot. */
  amountUsd: string | null;
  /** Stored CHF snapshot. */
  amountChf: string | null;
  /** Stored EUR snapshot. */
  amountEur: string | null;
  /** Stored PHP snapshot. */
  amountPhp: string | null;
  /** Fee sats, or `null` when the adapter does not store one. */
  feeSats: number | null;
  /** Recipient handle (local part of the receiving address). */
  recipientWosUser: string;
  /** Daily funding, welcome gift, or moderator stipend. */
  kind: GiftKind;
  /** BOLT11, or `null` when the adapter does not store one. */
  lightningInvoice: string | null;
  /** Payout transaction id. */
  wosTransactionId: string | null;
  /** Description, or `null` when the adapter does not store one. */
  description: string | null;
  /** Point-of-sale flag. */
  pointOfSale: boolean;
  /** Payout status. */
  wosStatus: string | null;
  /** Source wallet, or `null` when the adapter does not store one. */
  sourceWallet: string | null;
  /** Import ISO-8601, or `null` when the adapter does not store one. */
  importedAt: string | null;
}

/**
 * Persistence for outbound gifts used by public statistics.
 *
 * v1 default is in-memory (empty). Production boot injects a query against
 * the `gift` table when `DATABASE_URL` is set.
 */
export interface GiftStore {
  /**
   * Every outbound gift, without invoice fields.
   *
   * @returns Gift rows (any order; stats sorting is the aggregator's job).
   */
  listOutbound(): Promise<GiftRow[]>;

  /**
   * Operator dump of stored gift columns, newest `paidAt` first, capped at `limit`.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows.
   */
  listDebug?(limit: number): Promise<GiftDebugRow[]>;
}

/**
 * Process-local {@link GiftStore}. Used in tests and when no database URL is
 * configured — the process still boots.
 */
export class InMemoryGiftStore implements GiftStore {
  /**
   * @param rows - Seed gifts; stored as-is and copied on read.
   */
  constructor(private readonly rows: readonly GiftRow[] = []) {}

  /**
   * Copy of the seed rows sorted by `paidAt` ascending.
   *
   * @returns A new array; the constructor input is not mutated.
   */
  listOutbound(): Promise<GiftRow[]> {
    return Promise.resolve([...this.rows].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }

  /**
   * Operator dump of stored gift columns, newest `paidAt` first.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows.
   */
  listDebug(limit: number): Promise<GiftDebugRow[]> {
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          amountUsd: row.amountUsd ?? null,
          amountChf: row.amountChf ?? null,
          amountEur: row.amountEur ?? null,
          amountPhp: row.amountPhp ?? null,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          kind: row.kind as GiftKind,
          lightningInvoice: null,
          wosTransactionId: null,
          description: row.description ?? null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
  }
}

/**
 * {@link GiftStore} that delegates listing to an injected query.
 *
 * Production boot passes a Postgres SELECT; tests pass a stub.
 */
export class QueryGiftStore implements GiftStore {
  /**
   * @param query - Loader that returns outbound gift rows.
   * @param debugQuery - Optional full-column dump loader.
   */
  constructor(
    private readonly query: () => Promise<GiftRow[]>,
    private readonly debugQuery?: () => Promise<GiftDebugRow[]>,
  ) {}

  /**
   * Runs the injected query.
   *
   * @returns The query result unchanged.
   */
  listOutbound(): Promise<GiftRow[]> {
    return this.query();
  }

  /**
   * Operator dump of stored gift columns, newest `paidAt` first.
   *
   * @param limit - Maximum rows.
   * @returns Debug rows from `debugQuery` when set, otherwise mapped outbound gifts.
   */
  listDebug(limit: number): Promise<GiftDebugRow[]> {
    if (this.debugQuery !== undefined) {
      return this.debugQuery().then((rows) => rows.slice(0, limit));
    }
    return this.listOutbound().then((rows) =>
      [...rows]
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: null,
          paidAt: row.paidAt.toISOString(),
          direction: 'outbound',
          currency: null,
          amountSats: row.amountSats,
          amountUsd: row.amountUsd ?? null,
          amountChf: row.amountChf ?? null,
          amountEur: row.amountEur ?? null,
          amountPhp: row.amountPhp ?? null,
          feeSats: null,
          recipientWosUser: row.recipientWosUser,
          kind: row.kind as GiftKind,
          lightningInvoice: null,
          wosTransactionId: null,
          description: row.description ?? null,
          pointOfSale: false,
          wosStatus: null,
          sourceWallet: null,
          importedAt: null,
        })),
    );
  }
}
