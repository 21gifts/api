/** One reserved database transaction connection used by an account merge. */
export interface MergeTx {
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Database port that keeps the complete account merge on one transaction. */
export interface MergeDb {
  begin<T>(run: (tx: MergeTx) => Promise<T>): Promise<T>;
}

type MergeInput = { from: string; into: string; verify: 'from' | 'into' };

type MergeResult =
  | { ok: true; messages: number }
  | { ok: false; error: 'not_found' | 'same_account' | 'platform' | 'both_grants' };

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

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

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
 * @param db - Transaction-capable database port.
 * @param input - Source, destination, and verify-edge choice.
 * @returns A merge count or an operator-safe refusal.
 */
export async function mergeAccounts(db: MergeDb, input: MergeInput): Promise<MergeResult> {
  if (input.from === input.into) {
    return { ok: false, error: 'same_account' };
  }

  return db.begin(async (tx) => {
    const accountParams = [input.from, input.into] as const;
    const locked = await tx.query<LockedAccountRow>(
      `SELECT id, is_platform, role, profile_message_id
       FROM account
       WHERE id = $1 OR id = $2
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

    const counts = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM message WHERE account_id = $1',
      [input.from],
    );
    const messages = counts[0]?.n ?? 0;
    const savedProfileMessageId = fromAccount.profile_message_id;

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

    const memberPairCollisions = `
      SELECT src.id AS source_id, dst.id AS target_id
      FROM conversation AS src
      JOIN conversation AS dst
        ON dst.kind = 'member_member'
       AND dst.id <> src.id
       AND dst.account_a = LEAST(
         CASE WHEN src.account_a = $1 THEN $2 ELSE src.account_a END,
         CASE WHEN src.account_b = $1 THEN $2 ELSE src.account_b END
       )
       AND dst.account_b = GREATEST(
         CASE WHEN src.account_a = $1 THEN $2 ELSE src.account_a END,
         CASE WHEN src.account_b = $1 THEN $2 ELSE src.account_b END
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
             CASE WHEN account_a = $1 THEN $2 ELSE account_a END,
             CASE WHEN account_b = $1 THEN $2 ELSE account_b END
           ),
           account_b = GREATEST(
             CASE WHEN account_a = $1 THEN $2 ELSE account_a END,
             CASE WHEN account_b = $1 THEN $2 ELSE account_b END
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

    await tx.query(
      `DELETE FROM message_repayment AS src
       USING message_repayment AS dst
       WHERE src.recipient_account_id = $1
         AND dst.recipient_account_id = $2
         AND dst.message_id = src.message_id
         AND dst.day_index = src.day_index`,
      accountParams,
    );
    await tx.query(
      'UPDATE message_repayment SET recipient_account_id = $2 WHERE recipient_account_id = $1',
      accountParams,
    );

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
      await tx.query(
        "DELETE FROM trust_edge WHERE subject_id = $2 AND kind = 'verify'",
        accountParams,
      );
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
      `DELETE FROM pos_charge
       WHERE account_id = $1 AND status = 'pending' AND EXISTS (
         SELECT 1 FROM pos_charge WHERE account_id = $2 AND status = 'pending'
       )`,
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
