import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';

describe('AUTH_SCHEMA_SQL', () => {
  it('creates the auth tables and backfills account.name idempotently', () => {
    expect(AUTH_SCHEMA_SQL.length).toBeGreaterThanOrEqual(8);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS account/i);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/\bname text\b/i);
    expect(AUTH_SCHEMA_SQL[0]).not.toMatch(/linking_key text NOT NULL/i);
    expect(AUTH_SCHEMA_SQL[0]).not.toMatch(/view_key/i);
    expect(AUTH_SCHEMA_SQL[1]).toMatch(/ALTER TABLE account ADD COLUMN IF NOT EXISTS name text/i);
    expect(AUTH_SCHEMA_SQL[2]).toMatch(
      /ALTER TABLE account ALTER COLUMN linking_key DROP NOT NULL/i,
    );
    expect(AUTH_SCHEMA_SQL[3]).toMatch(/DROP TABLE IF EXISTS auth_challenge/i);
    expect(AUTH_SCHEMA_SQL[4]).toMatch(/CREATE TABLE IF NOT EXISTS auth_session/i);
    expect(AUTH_SCHEMA_SQL[5]).toMatch(/CREATE TABLE IF NOT EXISTS address_verification/i);
    expect(AUTH_SCHEMA_SQL[6]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_challenge/i);
    expect(AUTH_SCHEMA_SQL[7]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_credential/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/nostr_pubkey/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/forum_laws_dismissed/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS view_key text/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /UPDATE account SET view_key = replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\) WHERE view_key IS NULL/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS account_view_key_uidx ON account \(view_key\) WHERE view_key IS NOT NULL/i,
    );
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/\brules_agreed_at timestamptz\b/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS rules_agreed_at timestamptz/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS account_lightning_address_uidx/i,
    );
    expect(AUTH_SCHEMA_SQL).toContain(
      'ALTER TABLE account ALTER COLUMN lightning_address_verified SET DEFAULT false',
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(/DROP COLUMN/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /DROP INDEX IF EXISTS passkey_credential_account_uidx/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS passkey_credential_account_uidx/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS account_is_platform_uidx ON account \(is_platform\) WHERE is_platform/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS name_skipped_at timestamptz/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS lightning_address_skipped_at timestamptz/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS profile_message_id uuid/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS location text/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS notification_level/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/account_notification_level_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS amount_unit/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/account_amount_unit_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS locale/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/account_locale_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS fiat/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/account_fiat_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(/UPDATE account SET locale/);
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(/UPDATE account SET fiat/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS username text/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS account_username_uidx\s+ON account \(lower\(trim\(username\)\)\) WHERE username IS NOT NULL AND trim\(username\) <> ''/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS session_refused boolean NOT NULL DEFAULT false/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS wallet_required boolean NOT NULL DEFAULT false/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS wallet_backup_seen_at timestamptz/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS wallet_intro_seen boolean NOT NULL DEFAULT false/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(/DROP INDEX IF EXISTS account_username_uidx/);
    expect(AUTH_SCHEMA_SQL.join('\n')).not.toMatch(/account_profile_message_id_fkey/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/pater-severin/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /UPDATE account SET role = 'initiator' WHERE lower\(trim\(username\)\) = 'pater-severin' AND role = 'moderator'/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS passkey_renew_attempt/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_stage_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/stage IN \('begin', 'ceremony', 'finish'\)/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_outcome_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/outcome IN \('failed', 'succeeded', 'cancelled'\)/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/authenticator_attachment text/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_attachment_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_aaguid_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/authenticator_flags integer/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_flags_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_alg_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_cred_protect_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/passkey_renew_attempt_capabilities_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE INDEX IF NOT EXISTS passkey_renew_attempt_account_idx\s+ON passkey_renew_attempt \(account_id, created_at DESC\)/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE passkey_challenge ADD COLUMN IF NOT EXISTS requested_name text/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS spark_pubkey text/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS spark_pubkey_verified_at timestamptz/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account DROP CONSTRAINT IF EXISTS account_spark_pubkey_chk/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/account_spark_pubkey_chk/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/spark_pubkey ~ '\^0\[23\]\[0-9a-f\]\{64\}\$'/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE INDEX IF NOT EXISTS account_spark_pubkey_idx ON account \(spark_pubkey\) WHERE spark_pubkey IS NOT NULL/,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS notify_hearts boolean NOT NULL DEFAULT true/,
    );
    const notifyHeartsAt = AUTH_SCHEMA_SQL.indexOf(
      'ALTER TABLE account ADD COLUMN IF NOT EXISTS notify_hearts boolean NOT NULL DEFAULT true',
    );
    const tail = AUTH_SCHEMA_SQL.slice(notifyHeartsAt + 1);
    expect(tail).toHaveLength(12);
    expect(tail.slice(0, 3)).toEqual([
      'ALTER TABLE account ADD COLUMN IF NOT EXISTS spark_address text',
      'ALTER TABLE account DROP CONSTRAINT IF EXISTS account_spark_address_chk',
      `ALTER TABLE account ADD CONSTRAINT account_spark_address_chk
  CHECK (spark_address IS NULL OR (spark_pubkey IS NOT NULL AND spark_address ~ '^spark1[02-9ac-hj-np-z]{62}$'))`,
    ]);
    expect(tail.slice(3).map((statement) => statement.split('\n')[0]?.trim())).toEqual([
      'CREATE TABLE IF NOT EXISTS recovery_share (',
      'CREATE TABLE IF NOT EXISTS pending_recovery (',
      'CREATE UNIQUE INDEX IF NOT EXISTS pending_recovery_new_spark_pubkey_uidx ON pending_recovery (new_spark_pubkey)',
      'CREATE UNIQUE INDEX IF NOT EXISTS pending_recovery_credential_id_uidx ON pending_recovery (credential_id)',
      'CREATE TABLE IF NOT EXISTS previous_wallet (',
      'CREATE INDEX IF NOT EXISTS previous_wallet_spark_pubkey_idx ON previous_wallet (spark_pubkey)',
      'CREATE TABLE IF NOT EXISTS held_share_box (',
      'CREATE INDEX IF NOT EXISTS held_share_box_account_idx ON held_share_box (account_id)',
      'CREATE INDEX IF NOT EXISTS passkey_challenge_open_account_type_idx',
    ]);
    const staffTagAt = AUTH_SCHEMA_SQL.indexOf(
      'ALTER TABLE account ADD COLUMN IF NOT EXISTS staff_tag text',
    );
    expect(staffTagAt).toBeGreaterThan(
      AUTH_SCHEMA_SQL.indexOf(
        'ALTER TABLE passkey_challenge ADD COLUMN IF NOT EXISTS requested_name text',
      ),
    );
    expect(AUTH_SCHEMA_SQL[staffTagAt + 1]).toBe(
      'ALTER TABLE account DROP CONSTRAINT IF EXISTS account_staff_tag_chk',
    );
    expect(AUTH_SCHEMA_SQL[staffTagAt + 2]).toBe(
      "ALTER TABLE account ADD CONSTRAINT account_staff_tag_chk CHECK (staff_tag IS NULL OR staff_tag IN ('software_developer'))",
    );
    expect(AUTH_SCHEMA_SQL[staffTagAt + 3]).toBe(
      "UPDATE account SET staff_tag = 'software_developer' WHERE lower(trim(username)) = 'dansw' AND staff_tag IS DISTINCT FROM 'software_developer'",
    );
  });

  it('creates the social recovery tables with key, address, and size checks', () => {
    const joined = AUTH_SCHEMA_SQL.join('\n');
    const share = AUTH_SCHEMA_SQL.find((statement) =>
      statement.startsWith('CREATE TABLE IF NOT EXISTS recovery_share'),
    );
    expect(share).toMatch(/recovery_share_ciphertext bytea NOT NULL/);
    expect(share).toMatch(/account_id uuid NOT NULL REFERENCES account \(id\)/);
    expect(share).toMatch(/PRIMARY KEY \(account_id, spark_pubkey\)/);
    expect(share).toMatch(/octet_length\(recovery_share_ciphertext\) BETWEEN 34 AND 1024/);
    expect(share).toMatch(
      /recovery_share_spark_pubkey_chk CHECK \(spark_pubkey ~ '\^0\[23\]\[0-9a-f\]\{64\}\$'\)/,
    );
    const pending = AUTH_SCHEMA_SQL.find((statement) =>
      statement.startsWith('CREATE TABLE IF NOT EXISTS pending_recovery'),
    );
    expect(pending).toMatch(/account_id uuid PRIMARY KEY REFERENCES account \(id\)/);
    expect(pending).toMatch(/public_key bytea NOT NULL/);
    expect(pending).toMatch(/forwarded_at timestamptz,/);
    expect(pending).toMatch(/old_spark_pubkey <> new_spark_pubkey/);
    expect(pending).toMatch(/pending_recovery_sign_count_chk CHECK \(sign_count >= 0\)/);
    const previous = AUTH_SCHEMA_SQL.find((statement) =>
      statement.startsWith('CREATE TABLE IF NOT EXISTS previous_wallet'),
    );
    expect(previous).toMatch(/PRIMARY KEY \(account_id, spark_pubkey\)/);
    expect(previous).toMatch(/spark_address ~ '\^spark1\[02-9ac-hj-np-z\]\{62\}\$'/);
    expect(joined).toMatch(
      /passkey_challenge_open_account_type_idx\s+ON passkey_challenge \(account_id, type\) WHERE consumed = false/,
    );
    const boxes = AUTH_SCHEMA_SQL.find((statement) =>
      statement.startsWith('CREATE TABLE IF NOT EXISTS held_share_box'),
    );
    expect(boxes).toMatch(/id text PRIMARY KEY/);
    expect(boxes).toMatch(/account_id uuid NOT NULL REFERENCES account \(id\) ON DELETE CASCADE/);
    expect(boxes).toMatch(/ciphertext bytea NOT NULL/);
    expect(boxes).toMatch(/held_share_box_id_chk CHECK \(id ~ '\^\[0-9a-f\]\{32\}\$'\)/);
    expect(boxes).toMatch(/octet_length\(ciphertext\) BETWEEN 29 AND 1024/);
    expect(boxes).toContain("substring(ciphertext FROM 1 FOR 1) = '\\x01'::bytea");
    expect(joined).not.toMatch(/composite|REFERENCES account \(id, /i);
  });

  it('matches the docs/schema reference of each social recovery table', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const docs = (table: string): string =>
      flat(readFileSync(join(process.cwd(), `docs/schema/${table}.sql`), 'utf8'));
    const statementsOf = (table: string): string[] =>
      AUTH_SCHEMA_SQL.filter((statement) =>
        new RegExp(
          `^CREATE (TABLE IF NOT EXISTS|(UNIQUE )?INDEX IF NOT EXISTS \\w+ ON) ${table} `,
        ).test(statement),
      );
    for (const [table, count] of [
      ['recovery_share', 1],
      ['pending_recovery', 3],
      ['previous_wallet', 2],
      ['held_share_box', 2],
    ] as const) {
      const statements = statementsOf(table);
      expect(statements).toHaveLength(count);
      for (const statement of statements) {
        expect(docs(table)).toContain(flat(statement));
      }
    }
  });
});
