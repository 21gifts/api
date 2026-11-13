import type { SqlClient } from '@/lib/auth/sql';
import { invoiceStillOpen } from '@/lib/bolt11';
import {
  fiatAmountToCents,
  parseRepaymentDescription,
  parseRepaymentPartDescription,
  payerDebtUnits,
  repaymentSchedule,
} from '@/lib/credit-repayment';
import {
  ACCOUNT_ADVISORY_LOCK_NAMESPACE,
  MESSAGE_ADVISORY_LOCK_NAMESPACE,
  PostgresMessageStore,
} from '@/lib/message-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

/** One reserved database transaction connection used by an account merge. */
export interface MergeTx {
  /**
   * Run a parameterised query and return rows.
   *
   * @param text - SQL with `$1`, `$2`, … placeholders.
   * @param params - Bound values, in order.
   * @returns Result rows.
   */
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Database port that keeps the complete account merge on one transaction. */
export interface MergeDb {
  /**
   * Run a callback on one reserved transaction connection.
   *
   * @param run - Callback that receives the transaction.
   * @returns The callback result.
   */
  begin<T>(run: (tx: MergeTx) => Promise<T>): Promise<T>;
}

type MergeInput = { from: string; into: string; verify: 'from' | 'into' };

type MergeResult =
  | { ok: true; messages: number }
  | {
      ok: false;
      error:
        | 'not_found'
        | 'same_account'
        | 'platform'
        | 'both_grants'
        | 'shop_payment_open'
        | 'repayment_unavailable';
    };

interface LockedAccountRow {
  id: string;
  is_platform: boolean;
  role: string;
  profile_message_id: string | null;
}

interface CatalogColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
}

interface LegacyRepaymentRow {
  message_id: string;
  day_index: number | string;
  recipient_account_id: string;
  due_sats: number | string;
  paid_at: Date | string;
  goal_currency: string | null;
  goal_amount: string | null;
  goal_term_days: number | string | null;
  goal_debt_frozen: boolean;
}

interface OpenRepaymentInvoiceRow {
  message_id: string;
  author_account_id: string;
  amount_sats: number | string;
  payment_hash: string | null;
  description: string;
  created_at: Date | string;
  pr: string;
  payment_claimed: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const FROZEN_FIAT_FIELDS = {
  USD: 'usd',
  CHF: 'chf',
  EUR: 'eur',
  PHP: 'php',
} as const;

/** Quote a catalog identifier after the strict public-schema allowlist check. */
function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error('invalid account foreign key identifier');
  }
  return `"${identifier}"`;
}

/**
 * Fold one account into another on one reserved transaction connection.
 *
 * Under both account row locks it refuses with `shop_payment_open`, before
 * any write, while the merged account has a shop payment that is neither
 * paid nor closed, or has an unexpired pending charge while the surviving
 * account has no unexpired pending charge and has an `open` shop payment.
 * Before its first write to a charge or payment row it locks every
 * `pos_charge` row of both accounts, then the merged account's
 * `shop_payment` rows, each in id order
 * (`SELECT … ORDER BY id FOR UPDATE`). Charges come before payments, as
 * every transaction that writes both takes them, and payments follow
 * `lockPaymentsForProofs`. It then marks due pending charges on both
 * accounts `expired`. When both still have an unexpired pending charge, it
 * deletes the merged account's `pos_charge_invoice` rows and the charge.
 * The catalog update moves the rest. A due pending charge does not delete a
 * charge that can still be paid. A daily
 * roster row of the merged account in a bucket where the surviving account
 * is listed too is deleted; the catalog update moves its other roster rows.
 * Before the passkey challenges and the catalog-listed rows move, it deletes
 * the merged account's `recovery_share`, `pending_recovery`, and
 * `previous_wallet` rows and its `recovery` passkey challenges: they belong
 * to the merged account's wallets, which go with its row. It also deletes the
 * merged account's `held_share_box` rows: each box is sealed to the merged
 * account's id and words, so the surviving account could never open it.
 * Frozen credit snapshots are combined by message. Before either identity is
 * moved, the merge refuses without writes when both identities gave to one
 * credit with a settled repayment, when a still-payable repayment invoice
 * embeds either identity on an affected source-funded credit, or when such an
 * invoice has a payment claim but no exact settlement row (including part
 * index, units, and sats for a part). Otherwise,
 * legacy full-share repayments are reconstructed from the original loan
 * schedule and converted to canonical parts. A schedule that cannot be
 * reconstructed refuses the merge without writes. Parts from both identities
 * are then moved without changing their immutable part indexes. A remaining
 * source/survivor part-key collision refuses the merge before any write.
 *
 * @param db - Transaction-capable database port.
 * @param input - Source, destination, and verify-edge choice.
 * @returns A merge count or an operator-safe refusal.
 * @throws Error('invalid account foreign key identifier') when a catalog
 *   identifier fails the allowlist in `quoteIdentifier`.
 * @throws Error('composite account foreign key') when a catalog foreign key
 *   is composite.
 */
export async function mergeAccounts(db: MergeDb, input: MergeInput): Promise<MergeResult> {
  if (input.from === input.into) {
    return { ok: false, error: 'same_account' };
  }

  return db.begin(async (tx) => {
    const accountParams = [input.from, input.into] as const;

    // Global order: account advisory locks, message advisory locks, row locks.
    // Both identities are stable before the affected-message query runs, so a
    // concurrent invoice mint cannot add a payer reference after this set was
    // collected and before the source account is deleted.
    await tx.query(
      `SELECT pg_advisory_xact_lock($3::integer, hashtext(locked.account_id::text))
       FROM unnest(ARRAY[$1::uuid, $2::uuid]) AS locked(account_id)
       ORDER BY locked.account_id`,
      [...accountParams, ACCOUNT_ADVISORY_LOCK_NAMESPACE],
    );
    await tx.query(
      `SELECT pg_advisory_xact_lock($3::integer, hashtext(affected.message_id::text))
       FROM (
         SELECT message_id FROM message_repayment
         WHERE recipient_account_id = $1::uuid OR recipient_account_id = $2::uuid
         UNION
         SELECT message_id FROM message_repayment_part
         WHERE recipient_account_id = $1::uuid OR recipient_account_id = $2::uuid
         UNION
         SELECT message_id FROM message_invoice
         WHERE payer_account_id = $1::uuid
            OR payer_account_id = $2::uuid
            OR author_account_id = $1::uuid
            OR author_account_id = $2::uuid
         UNION
         SELECT message_id FROM message_invoice
         WHERE result = 'ok'
           AND (description LIKE 'repay:%' OR description LIKE 'repayp:%')
           AND (
             author_account_id = $1::uuid
             OR author_account_id = $2::uuid
             OR description LIKE 'repay:%:' || $1::text
             OR description LIKE 'repay:%:' || $2::text
             OR description LIKE 'repayp:%:' || $1::text || ':%'
             OR description LIKE 'repayp:%:' || $2::text || ':%'
           )
         UNION
         SELECT message_id FROM nostr_zap_receipt
         WHERE payer_account_id = $1::uuid OR payer_account_id = $2::uuid
         UNION
         SELECT receipt.message_id
         FROM nostr_zap_receipt AS receipt
         JOIN message ON message.id = receipt.message_id
         WHERE message.goal_repayable IS TRUE
           AND (receipt.payer_account_id = $1::uuid OR receipt.payer_account_id = $2::uuid)
         UNION
         SELECT id AS message_id FROM message
         WHERE goal_repayable IS TRUE
           AND (account_id = $1::uuid OR account_id = $2::uuid)
       ) AS affected
       ORDER BY affected.message_id`,
      [...accountParams, MESSAGE_ADVISORY_LOCK_NAMESPACE],
    );
    const locked = await tx.query<LockedAccountRow>(
      `SELECT id, is_platform, role, profile_message_id
       FROM account
       WHERE id = $1::uuid OR id = $2::uuid
       FOR UPDATE`,
      accountParams,
    );
    const byId = new Map(locked.map((row) => [row.id, row]));
    const fromAccount = byId.get(input.from);
    const intoAccount = byId.get(input.into);
    if (byId.size < 2 || fromAccount === undefined || intoAccount === undefined) {
      return { ok: false, error: 'not_found' };
    }
    if (fromAccount.is_platform || intoAccount.is_platform) {
      return { ok: false, error: 'platform' };
    }

    const grants = await tx.query<{ account_id: string }>(
      'SELECT account_id FROM funding_grant WHERE account_id = $1 OR account_id = $2',
      accountParams,
    );
    if (grants.length >= 2) {
      return { ok: false, error: 'both_grants' };
    }

    // A shop payment's BOLT11 pays the merged account's wallet, which the merge
    // does not carry over: wait until every such payment is paid or closed.
    const shopPayments = await tx.query<{ id: string }>(
      `SELECT id FROM shop_payment
       WHERE account_id = $1 AND status <> 'paid' AND closed_at IS NULL
       LIMIT 1`,
      [input.from],
    );
    if (shopPayments.length > 0) {
      return { ok: false, error: 'shop_payment_open' };
    }
    // A pending charge of the merged account would land next to the survivor's
    // open shop payment (a stranger's amount on the sticker), which `POST /pos`
    // never allows: refuse the same way and change nothing. When the survivor
    // has its own unexpired pending charge, the merged account's charge is
    // deleted below instead, and the merge goes on.
    const openBesideCharge = await tx.query<{ id: string }>(
      `SELECT p.id FROM shop_payment AS p
       WHERE p.account_id = $2 AND p.status = 'open'
         AND EXISTS (
           SELECT 1 FROM pos_charge AS c
           WHERE c.account_id = $1 AND c.status = 'pending' AND c.expires_at > now()
         )
         AND NOT EXISTS (
           SELECT 1 FROM pos_charge AS s
           WHERE s.account_id = $2 AND s.status = 'pending' AND s.expires_at > now()
         )
       LIMIT 1`,
      accountParams,
    );
    if (openBesideCharge.length > 0) {
      return { ok: false, error: 'shop_payment_open' };
    }

    const counts = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM message WHERE account_id = $1',
      [input.from],
    );
    const messages = counts[0]?.n ?? 0;
    const savedProfileMessageId = fromAccount.profile_message_id;

    // Combining two givers after any repayment settled can change the rounded
    // day slices of their combined debt. Keep the settled schedule immutable:
    // the operator can merge only before that credit has any paid unit.
    const settledMergeConflicts = await tx.query<{ message_id: string }>(
      `SELECT credit.id AS message_id
       FROM message AS credit
       WHERE credit.goal_repayable IS TRUE
         AND EXISTS (
           SELECT 1 FROM nostr_zap_receipt AS source_gift
           WHERE source_gift.message_id = credit.id
             AND source_gift.payer_account_id = $1::uuid
             AND (
               credit.goal_funded_at IS NULL
               OR source_gift.recorded_at IS NULL
               OR source_gift.recorded_at <= credit.goal_funded_at
             )
         )
         AND EXISTS (
           SELECT 1 FROM nostr_zap_receipt AS survivor_gift
           WHERE survivor_gift.message_id = credit.id
             AND survivor_gift.payer_account_id = $2::uuid
             AND (
               credit.goal_funded_at IS NULL
               OR survivor_gift.recorded_at IS NULL
               OR survivor_gift.recorded_at <= credit.goal_funded_at
             )
         )
         AND (
           EXISTS (
             SELECT 1 FROM message_repayment AS settled
             WHERE settled.message_id = credit.id
           )
           OR EXISTS (
             SELECT 1 FROM message_repayment_part AS settled_part
             WHERE settled_part.message_id = credit.id
           )
         )
       LIMIT 1`,
      accountParams,
    );
    if (settledMergeConflicts.length > 0) {
      return { ok: false, error: 'repayment_unavailable' };
    }
    // Part indexes are immutable invoice identity. Moving the source recipient
    // must not renumber either side; refuse the unique key that would collide.
    const partKeyCollisions = await tx.query<{ message_id: string }>(
      `SELECT source.message_id
       FROM message_repayment_part AS source
       JOIN message_repayment_part AS survivor
         ON survivor.message_id = source.message_id
        AND survivor.day_index = source.day_index
        AND survivor.part_index = source.part_index
       WHERE source.recipient_account_id = $1::uuid
         AND survivor.recipient_account_id = $2::uuid
       LIMIT 1`,
      accountParams,
    );
    if (partKeyCollisions.length > 0) {
      return { ok: false, error: 'repayment_unavailable' };
    }
    // A repayment description is settlement metadata and embeds its original
    // recipient account id. Keep every open reservation that names either
    // identity on a source-funded credit immutable until it settles or
    // expires. A payment-hash claim is settled only when the invoice's current
    // recipient also has the described legacy or part row; a claim-only
    // invoice refuses the merge even after the invoice itself expired.
    const openRepaymentInvoices = await tx.query<OpenRepaymentInvoiceRow>(
      `SELECT invoice.message_id, invoice.author_account_id, invoice.amount_sats,
              invoice.payment_hash, invoice.description, invoice.created_at, invoice.pr,
              invoice.payment_hash IS NOT NULL AND EXISTS (
                SELECT 1 FROM nostr_zap_payment AS claimed
                WHERE claimed.payment_hash = lower(invoice.payment_hash)
              ) AS payment_claimed
       FROM message_invoice AS invoice
       JOIN message AS credit ON credit.id = invoice.message_id
       WHERE invoice.result = 'ok'
         AND invoice.pr IS NOT NULL
         AND (
           invoice.description LIKE 'repay:%'
           OR invoice.description LIKE 'repayp:%'
         )
         AND credit.goal_repayable IS TRUE
         AND EXISTS (
           SELECT 1 FROM nostr_zap_receipt AS source_gift
           WHERE source_gift.message_id = credit.id
             AND source_gift.payer_account_id = $1::uuid
             AND (
               credit.goal_funded_at IS NULL
               OR source_gift.recorded_at IS NULL
               OR source_gift.recorded_at <= credit.goal_funded_at
             )
         )
         AND (
           invoice.author_account_id = $1::uuid
           OR invoice.author_account_id = $2::uuid
           OR invoice.description LIKE 'repay:%:' || $1::text
           OR invoice.description LIKE 'repayp:%:' || $1::text || ':%'
           OR invoice.description LIKE 'repay:%:' || $2::text
           OR invoice.description LIKE 'repayp:%:' || $2::text || ':%'
         )
       ORDER BY invoice.created_at, invoice.id`,
      accountParams,
    );
    const repaymentStore = new PostgresMessageStore(tx as SqlClient);
    for (const invoice of openRepaymentInvoices) {
      const whole = parseRepaymentDescription(invoice.description);
      const part = parseRepaymentPartDescription(invoice.description);
      if (whole === null) {
        continue;
      }
      const claimOnly = await repaymentStore.isClaimOnlyRepaymentInvoice(
        invoice.payment_hash,
        part === null
          ? {
              kind: 'legacy',
              messageId: invoice.message_id,
              dayIndex: whole.dayIndex,
              recipientAccountId: invoice.author_account_id,
            }
          : {
              kind: 'part',
              messageId: invoice.message_id,
              dayIndex: part.dayIndex,
              recipientAccountId: invoice.author_account_id,
              partIndex: part.partIndex,
              units: part.units,
              sats: Number(invoice.amount_sats),
            },
      );
      if (
        claimOnly ||
        (!invoice.payment_claimed &&
          invoiceStillOpen(invoice.pr, new Date(invoice.created_at).getTime(), Date.now()))
      ) {
        return { ok: false, error: 'repayment_unavailable' };
      }
    }
    const legacyRepayments = await tx.query<LegacyRepaymentRow>(
      `SELECT legacy.message_id, legacy.day_index, legacy.recipient_account_id,
              legacy.due_sats, legacy.paid_at, message.goal_currency,
              COALESCE(NULLIF(message.goal_amount_text, ''), message.goal_amount::text) AS goal_amount,
              message.goal_term_days, message.goal_debt_frozen
       FROM message_repayment AS legacy
       JOIN message ON message.id = legacy.message_id
       WHERE legacy.recipient_account_id = $1::uuid
          OR legacy.recipient_account_id = $2::uuid
       ORDER BY legacy.message_id, legacy.day_index, legacy.recipient_account_id
       FOR UPDATE OF legacy, message`,
      accountParams,
    );
    const canonicalLegacy: Array<LegacyRepaymentRow & { units: bigint }> = [];
    for (const legacy of legacyRepayments) {
      const payers = await repaymentStore.listCreditPayers(legacy.message_id);
      const frozenField =
        legacy.goal_debt_frozen === true &&
        legacy.goal_currency !== null &&
        legacy.goal_currency in FROZEN_FIAT_FIELDS
          ? FROZEN_FIAT_FIELDS[legacy.goal_currency as keyof typeof FROZEN_FIAT_FIELDS]
          : undefined;
      if (frozenField === undefined) {
        payers.push({
          accountId: '',
          sats: await repaymentStore.sumUnassignedCreditSats(legacy.message_id),
          usd: null,
          chf: null,
          eur: null,
          php: null,
        });
      }
      const owed =
        frozenField === undefined
          ? payerDebtUnits(legacy.goal_currency, legacy.goal_amount, payers)
          : payers.map((payer) => ({
              accountId: payer.accountId,
              units: fiatAmountToCents(payer[frozenField] as string) as bigint,
            }));
      if (owed === 'unavailable') {
        return { ok: false, error: 'repayment_unavailable' };
      }
      const share = repaymentSchedule(Number(legacy.goal_term_days), owed).find(
        (slice) =>
          slice.dayIndex === Number(legacy.day_index) &&
          slice.accountId === legacy.recipient_account_id,
      );
      if (share === undefined) {
        return { ok: false, error: 'repayment_unavailable' };
      }
      canonicalLegacy.push({ ...legacy, units: share.units });
    }
    for (const legacy of canonicalLegacy) {
      await tx.query(
        `INSERT INTO message_repayment_part (
           message_id, day_index, recipient_account_id, part_index, units, sats, paid_at
         )
         SELECT $1::uuid, $2::integer, $3::uuid,
                COALESCE(MAX(part_index) + 1, 0),
                $4::bigint, $5::bigint, $6::timestamptz
         FROM message_repayment_part
         WHERE message_id = $1::uuid
           AND day_index = $2::integer
           AND recipient_account_id IN ($3::uuid, $7::uuid)`,
        [
          legacy.message_id,
          Number(legacy.day_index),
          legacy.recipient_account_id,
          legacy.units.toString(),
          legacy.due_sats,
          legacy.paid_at,
          legacy.recipient_account_id === input.from ? input.into : input.from,
        ],
      );
      await tx.query(
        `DELETE FROM message_repayment
         WHERE message_id = $1 AND day_index = $2 AND recipient_account_id = $3`,
        [legacy.message_id, Number(legacy.day_index), legacy.recipient_account_id],
      );
    }

    await tx.query('UPDATE account SET profile_message_id = NULL WHERE id = $1', [input.from]);

    await tx.query(
      `UPDATE message AS src
       SET content_fp = src.content_fp || ':' || src.id::text
       WHERE src.account_id = $1
         AND src.parent_id IS NULL
         AND src.content_fp IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM message AS dst
           WHERE dst.account_id = $2
             AND dst.parent_id IS NULL
             AND dst.content_fp = src.content_fp
         )`,
      accountParams,
    );
    await tx.query(
      `UPDATE message AS src
       SET content_fp = src.content_fp || ':' || src.id::text
       WHERE src.account_id = $1
         AND src.parent_id IS NOT NULL
         AND src.content_fp IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM message AS dst
           WHERE dst.account_id = $2
             AND dst.parent_id IS NOT NULL
             AND dst.parent_id = src.parent_id
             AND dst.content_fp = src.content_fp
         )`,
      accountParams,
    );
    await tx.query(
      `UPDATE message AS src
       SET first_post_free = NULL
       WHERE src.account_id = $1
         AND src.first_post_free IS TRUE
         AND EXISTS (
           SELECT 1 FROM message AS dst
           WHERE dst.account_id = $2
             AND dst.first_post_free IS TRUE
         )`,
      accountParams,
    );

    const directMemberPair = `
      SELECT id FROM conversation
      WHERE kind = 'member_member'
        AND ((account_a = $1 AND account_b = $2) OR (account_a = $2 AND account_b = $1))`;
    await tx.query(
      `DELETE FROM conversation_message WHERE conversation_id IN (${directMemberPair})`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM conversation_read WHERE conversation_id IN (${directMemberPair})`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM conversation
       WHERE kind = 'member_member'
         AND ((account_a = $1 AND account_b = $2) OR (account_a = $2 AND account_b = $1))`,
      accountParams,
    );

    // $2 is only a CASE result here and in the following member_member update, so Postgres leaves it untyped unless it is cast.
    const memberPairCollisions = `
      SELECT src.id AS source_id, dst.id AS target_id
      FROM conversation AS src
      JOIN conversation AS dst
        ON dst.kind = 'member_member'
       AND dst.id <> src.id
       AND dst.account_a = LEAST(
         CASE WHEN src.account_a = $1 THEN $2::uuid ELSE src.account_a END,
         CASE WHEN src.account_b = $1 THEN $2::uuid ELSE src.account_b END
       )
       AND dst.account_b = GREATEST(
         CASE WHEN src.account_a = $1 THEN $2::uuid ELSE src.account_a END,
         CASE WHEN src.account_b = $1 THEN $2::uuid ELSE src.account_b END
       )
      WHERE src.kind = 'member_member'
        AND (src.account_a = $1 OR src.account_b = $1)`;
    await tx.query(
      `UPDATE conversation_message AS message
       SET conversation_id = collision.target_id
       FROM (${memberPairCollisions}) AS collision
       WHERE message.conversation_id = collision.source_id`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM conversation_read AS reading
       USING (${memberPairCollisions}) AS collision
       WHERE reading.conversation_id = collision.source_id`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM conversation AS source
       USING (${memberPairCollisions}) AS collision
       WHERE source.id = collision.source_id`,
      accountParams,
    );
    await tx.query(
      `UPDATE conversation
       SET account_a = LEAST(
             CASE WHEN account_a = $1 THEN $2::uuid ELSE account_a END,
             CASE WHEN account_b = $1 THEN $2::uuid ELSE account_b END
           ),
           account_b = GREATEST(
             CASE WHEN account_a = $1 THEN $2::uuid ELSE account_a END,
             CASE WHEN account_b = $1 THEN $2::uuid ELSE account_b END
           )
       WHERE kind = 'member_member' AND (account_a = $1 OR account_b = $1)`,
      accountParams,
    );

    const singleConversationCollision = (kind: 'member_platform' | 'member_damus'): string => `
      SELECT src.id AS source_id, dst.id AS target_id
      FROM conversation AS src
      JOIN conversation AS dst
        ON dst.kind = '${kind}'
       AND dst.account_a = $2
       ${kind === 'member_damus' ? 'AND dst.counterpart_pubkey = src.counterpart_pubkey' : ''}
      WHERE src.kind = '${kind}' AND src.account_a = $1`;
    for (const kind of ['member_platform', 'member_damus'] as const) {
      const collision = singleConversationCollision(kind);
      await tx.query(
        `UPDATE conversation_message AS message
         SET conversation_id = collision.target_id
         FROM (${collision}) AS collision
         WHERE message.conversation_id = collision.source_id`,
        accountParams,
      );
      await tx.query(
        `DELETE FROM conversation_read AS reading
         USING (${collision}) AS collision
         WHERE reading.conversation_id = collision.source_id`,
        accountParams,
      );
      await tx.query(
        `DELETE FROM conversation AS source
         USING (${collision}) AS collision
         WHERE source.id = collision.source_id`,
        accountParams,
      );
      await tx.query(
        `UPDATE conversation SET account_a = $2 WHERE kind = '${kind}' AND account_a = $1`,
        accountParams,
      );
    }
    await tx.query(
      `UPDATE conversation SET account_a = $2
       WHERE kind = 'moderator_group' AND account_a = $1`,
      accountParams,
    );
    await tx.query(
      `UPDATE conversation SET account_b = $2
       WHERE kind = 'moderator_group' AND account_b = $1`,
      accountParams,
    );

    // Frozen fiat debt follows the person. When both ids gave to the same
    // credit, keep one snapshot whose units are the exact sum of both rows.
    await tx.query(
      `INSERT INTO message_credit_payer_snapshot (message_id, account_id, currency, units)
       SELECT message_id, $2::uuid, MIN(currency), SUM(units)::bigint
       FROM message_credit_payer_snapshot
       WHERE account_id = $1 OR account_id = $2
       GROUP BY message_id
       HAVING BOOL_OR(account_id = $1)
       ON CONFLICT (message_id, account_id) DO UPDATE
       SET currency = EXCLUDED.currency,
           units = EXCLUDED.units`,
      accountParams,
    );
    await tx.query('DELETE FROM message_credit_payer_snapshot WHERE account_id = $1', [input.from]);

    // Part indexes are encoded into repayment invoices and remain immutable.
    // The collision check above makes the direct recipient move safe.
    await tx.query(
      `UPDATE message_repayment_part
       SET recipient_account_id = $2::uuid
       WHERE recipient_account_id = $1::uuid`,
      accountParams,
    );

    // The source's social recovery rows belong to its own wallets, which go
    // with the source row, and a share's additional data is the source id:
    // delete them before the moves below would hand them to the survivor. A
    // held-share box is sealed to the source id and the source's words, so
    // the survivor could never open it either.
    for (const statement of [
      'DELETE FROM recovery_share WHERE account_id = $1',
      'DELETE FROM held_share_box WHERE account_id = $1',
      'DELETE FROM pending_recovery WHERE account_id = $1',
      'DELETE FROM previous_wallet WHERE account_id = $1',
      "DELETE FROM passkey_challenge WHERE account_id = $1 AND type = 'recovery'",
    ]) {
      await tx.query(statement, [input.from]);
    }

    for (const statement of [
      'UPDATE message_invoice SET payer_account_id = $2 WHERE payer_account_id = $1',
      'UPDATE message_invoice SET author_account_id = $2 WHERE author_account_id = $1',
      'UPDATE message_edit SET actor_id = $2 WHERE actor_id = $1',
      'UPDATE message SET deleted_by = $2 WHERE deleted_by = $1',
      'UPDATE nostr_zap_receipt SET payer_account_id = $2 WHERE payer_account_id = $1',
      'UPDATE passkey_challenge SET account_id = $2 WHERE account_id = $1',
    ]) {
      await tx.query(statement, accountParams);
    }

    await tx.query(
      `DELETE FROM conversation_read AS src
       USING conversation_read AS dst
       WHERE src.account_id = $1
         AND dst.account_id = $2
         AND dst.conversation_id = src.conversation_id`,
      accountParams,
    );
    await tx.query(
      'UPDATE conversation_read SET account_id = $2 WHERE account_id = $1',
      accountParams,
    );

    await tx.query(
      `DELETE FROM notification AS src
       USING notification AS dst
       WHERE src.recipient_account_id = $1
         AND dst.recipient_account_id = $2
         AND dst.type = src.type
         AND dst.reply_id = src.reply_id`,
      accountParams,
    );
    await tx.query(
      'UPDATE notification SET recipient_account_id = $2 WHERE recipient_account_id = $1',
      accountParams,
    );
    await tx.query(
      'UPDATE notification SET actor_account_id = $2 WHERE actor_account_id = $1',
      accountParams,
    );

    await tx.query(
      `DELETE FROM trust_edge
       WHERE (subject_id = $1 AND actor_id = $2) OR (subject_id = $2 AND actor_id = $1)`,
      accountParams,
    );
    if (input.verify === 'from') {
      // Only the survivor id is bound, so the placeholder stays $1.
      await tx.query("DELETE FROM trust_edge WHERE subject_id = $1 AND kind = 'verify'", [
        input.into,
      ]);
      await tx.query(
        "UPDATE trust_edge SET subject_id = $2 WHERE subject_id = $1 AND kind = 'verify'",
        accountParams,
      );
    } else {
      await tx.query("DELETE FROM trust_edge WHERE subject_id = $1 AND kind = 'verify'", [
        input.from,
      ]);
    }
    await tx.query(
      `DELETE FROM trust_edge AS src
       USING trust_edge AS dst
       WHERE src.subject_id = $1
         AND dst.subject_id = $2
         AND src.kind = dst.kind
         AND src.kind IN ('moderator_confirm', 'moderator_appoint')`,
      accountParams,
    );
    await tx.query(
      `UPDATE trust_edge SET subject_id = $2
       WHERE subject_id = $1 AND kind IN ('moderator_confirm', 'moderator_appoint')`,
      accountParams,
    );
    await tx.query(
      `UPDATE trust_edge SET subject_id = $2
       WHERE subject_id = $1 AND kind IN ('moderator_propose', 'moderator_reject')`,
      accountParams,
    );
    await tx.query('DELETE FROM trust_edge WHERE actor_id = $1 AND subject_id = $2', accountParams);
    await tx.query('UPDATE trust_edge SET actor_id = $2 WHERE actor_id = $1', accountParams);

    await tx.query('UPDATE funding_grant SET decided_by = $2 WHERE decided_by = $1', accountParams);
    await tx.query(
      `DELETE FROM address_verification
       WHERE account_id = $1 AND EXISTS (
         SELECT 1 FROM address_verification WHERE account_id = $2
       )`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM account_image AS src
       USING account_image AS dst
       WHERE src.account_id = $1 AND dst.account_id = $2 AND dst.slot = src.slot`,
      accountParams,
    );
    await tx.query(
      `DELETE FROM daily_roster_entry AS src
       USING daily_roster_entry AS dst
       WHERE src.account_id = $1 AND dst.account_id = $2 AND dst.bucket = src.bucket`,
      accountParams,
    );
    // Every transaction that writes both `pos_charge` and `shop_payment` rows
    // takes the charge rows before the payment rows. The merge writes charge
    // rows of both accounts: it marks due pending rows expired, it deletes the
    // merged account's still-valid pending charge when the survivor still has
    // one, and the catalog loop below moves the rest in one unordered
    // `UPDATE`. Lock every charge of both accounts here first, in id order, so
    // a concurrent `recordInvoice` waits in its foreign-key check (and fails
    // once the charge is gone).
    await tx.query(
      `SELECT id FROM pos_charge
       WHERE account_id = $1 OR account_id = $2
       ORDER BY id
       FOR UPDATE`,
      accountParams,
    );
    // Lock the merged account's payments before any charge write. A submit
    // answer holds one payment row while it waits for another
    // (`lockPaymentsForProofs`). Take them in id order, the order that answer
    // takes them in, so neither waits for the other in opposite order. The
    // charge delete's `ON DELETE SET NULL` then writes a payment row already
    // held.
    await tx.query(
      `SELECT id FROM shop_payment
       WHERE account_id = $1
       ORDER BY id
       FOR UPDATE`,
      [input.from],
    );
    // A due pending row is not a live invoice. Mark those on both accounts
    // before the collision read, so a stale pending charge cannot delete a
    // charge that can still be paid. The rows are already held.
    await tx.query(
      `UPDATE pos_charge
       SET status = 'expired'
       WHERE account_id IN ($1, $2) AND status = 'pending' AND expires_at <= now()`,
      accountParams,
    );
    // The merged account's still-valid pending charge goes when the survivor
    // still has one. Its row is already held; drop its hashes
    // (`pos_charge_invoice.charge_id` has no cascade) and the charge, both by
    // these ids.
    const doomed = await tx.query<{ id: string }>(
      `SELECT id FROM pos_charge
       WHERE account_id = $1 AND status = 'pending' AND expires_at > now() AND EXISTS (
         SELECT 1 FROM pos_charge
         WHERE account_id = $2 AND status = 'pending' AND expires_at > now()
       )
       ORDER BY id`,
      accountParams,
    );
    if (doomed.length > 0) {
      const ids = postgresTextArrayLiteral(doomed.map((row) => row.id));
      await tx.query('DELETE FROM pos_charge_invoice WHERE charge_id = ANY($1::uuid[])', [ids]);
      await tx.query('DELETE FROM pos_charge WHERE id = ANY($1::uuid[])', [ids]);
    }
    await tx.query(
      `DELETE FROM wallet_payment AS src
       WHERE src.account_id = $1
         AND EXISTS (
           SELECT 1 FROM wallet_payment AS dst
           WHERE dst.account_id = $2 AND dst.payment_id = src.payment_id
         )`,
      accountParams,
    );
    // A payment between the two accounts would point at its own account after the merge.
    await tx.query(
      `UPDATE wallet_payment SET counterparty_account_id = NULL
       WHERE account_id IN ($1, $2) AND counterparty_account_id IN ($1, $2)`,
      accountParams,
    );
    await tx.query('DELETE FROM auth_session WHERE account_id = $1', [input.from]);

    const composite = await tx.query<{ constraint_name: string }>(
      `SELECT con.conname AS constraint_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE con.contype = 'f'
         AND con.confrelid = 'public.account'::regclass
         AND ns.nspname = 'public'
         AND (array_length(con.conkey, 1) <> 1 OR array_length(con.confkey, 1) <> 1)`,
    );
    if (composite.length !== 0) {
      throw new Error('composite account foreign key');
    }
    const columns = await tx.query<CatalogColumnRow>(
      `SELECT ns.nspname AS schema_name,
              cl.relname AS table_name,
              att.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN LATERAL unnest(con.conkey) AS key(attnum) ON true
       JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = key.attnum
       WHERE con.contype = 'f'
         AND con.confrelid = 'public.account'::regclass
         AND ns.nspname = 'public'
         AND array_length(con.conkey, 1) = 1
         AND array_length(con.confkey, 1) = 1`,
    );
    for (const column of columns) {
      const schema = quoteIdentifier(column.schema_name);
      const table = quoteIdentifier(column.table_name);
      const name = quoteIdentifier(column.column_name);
      await tx.query(`UPDATE ${schema}.${table} SET ${name} = $1 WHERE ${name} = $2`, [
        input.into,
        input.from,
      ]);
    }

    if (intoAccount.role === 'basis') {
      const verifyRows = await tx.query<{ exists: boolean }>(
        "SELECT true AS exists FROM trust_edge WHERE subject_id = $1 AND kind = 'verify' LIMIT 1",
        [input.into],
      );
      if (verifyRows.length !== 0) {
        await tx.query("UPDATE account SET role = 'verified' WHERE id = $1 AND role = 'basis'", [
          input.into,
        ]);
      }
    }
    if (intoAccount.profile_message_id === null && savedProfileMessageId !== null) {
      await tx.query('UPDATE account SET profile_message_id = $1 WHERE id = $2', [
        savedProfileMessageId,
        input.into,
      ]);
    }
    await tx.query(
      `UPDATE account AS survivor
SET
  created_at = LEAST(survivor.created_at, source.created_at),
  rules_agreed_at = CASE
    WHEN survivor.rules_agreed_at IS NULL THEN source.rules_agreed_at
    WHEN source.rules_agreed_at IS NULL THEN survivor.rules_agreed_at
    ELSE LEAST(survivor.rules_agreed_at, source.rules_agreed_at)
  END,
  wallet_required = survivor.wallet_required OR source.wallet_required,
  wallet_backup_seen_at = CASE
    WHEN survivor.wallet_backup_seen_at IS NULL THEN source.wallet_backup_seen_at
    WHEN source.wallet_backup_seen_at IS NULL THEN survivor.wallet_backup_seen_at
    ELSE LEAST(survivor.wallet_backup_seen_at, source.wallet_backup_seen_at)
  END,
  forum_laws_dismissed = survivor.forum_laws_dismissed OR source.forum_laws_dismissed,
  wallet_intro_seen = survivor.wallet_intro_seen OR source.wallet_intro_seen,
  locale = COALESCE(survivor.locale, source.locale),
  fiat = COALESCE(survivor.fiat, source.fiat)
FROM account AS source
WHERE survivor.id = $2 AND source.id = $1`,
      accountParams,
    );
    await tx.query('DELETE FROM account WHERE id = $1', [input.from]);
    return { ok: true, messages };
  });
}
