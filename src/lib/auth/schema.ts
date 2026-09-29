/**
 * Idempotent DDL for the auth tables. Applied once at process boot when
 * `DATABASE_URL` is set. `CREATE TABLE IF NOT EXISTS` is safe to re-run;
 * `ALTER TABLE` backfills `account.name`, nullable `linking_key`,
 * `forum_laws_dismissed`, `rules_agreed_at`, `notification_level`,
 * `amount_unit`, `locale`, `fiat`, `session_refused`, `wallet_required`,
 * `wallet_backup_seen_at`, and `passkey_challenge.requested_name` on
 * databases created before those columns existed.
 * Also creates `passkey_renew_attempt` (failed, cancelled, and
 * server-written succeeded seed rows).
 * `locale` and `fiat` are backfilled as nullable (no value backfill of
 * existing rows).
 * Drops leftover `auth_challenge` from LNURL-auth.
 */

/** Ordered CREATE/ALTER statements for the auth schema. */
export const AUTH_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS account (
    id uuid PRIMARY KEY,
    linking_key text UNIQUE,
    role text NOT NULL,
    name text,
    lightning_address text,
    lightning_address_verified boolean NOT NULL,
    forum_laws_dismissed boolean NOT NULL,
    created_at timestamptz NOT NULL,
    rules_agreed_at timestamptz
  )`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS name text`,
  `ALTER TABLE account ALTER COLUMN linking_key DROP NOT NULL`,
  `DROP TABLE IF EXISTS auth_challenge`,
  `CREATE TABLE IF NOT EXISTS auth_session (
    token text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account (id),
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS address_verification (
    account_id uuid PRIMARY KEY REFERENCES account (id),
    address text NOT NULL,
    nonce text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS passkey_challenge (
    id text PRIMARY KEY,
    type text NOT NULL,
    challenge text NOT NULL,
    account_id uuid NULL,
    consumed boolean NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS passkey_credential (
    credential_id text PRIMARY KEY,
    public_key bytea NOT NULL,
    sign_count integer NOT NULL,
    account_id uuid NOT NULL REFERENCES account (id),
    created_at timestamptz NOT NULL
  )`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS nostr_pubkey text`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS nostr_nsec_ciphertext bytea`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS nostr_kek_id integer NOT NULL DEFAULT 1`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS nostr_key_custody text NOT NULL DEFAULT 'custodial'`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS nostr_key_created_at timestamptz`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_nostr_pubkey_uidx
    ON account (nostr_pubkey) WHERE nostr_pubkey IS NOT NULL`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_nostr_key_custody_chk`,
  `ALTER TABLE account ADD CONSTRAINT account_nostr_key_custody_chk
    CHECK (nostr_key_custody IN ('custodial', 'user'))`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS forum_laws_dismissed boolean NOT NULL DEFAULT false`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS view_key text`,
  `UPDATE account SET view_key = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE view_key IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_view_key_uidx ON account (view_key) WHERE view_key IS NOT NULL`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS rules_agreed_at timestamptz`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_lightning_address_uidx
    ON account (lower(trim(lightning_address))) WHERE lightning_address IS NOT NULL`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_is_platform_uidx ON account (is_platform) WHERE is_platform`,
  // Skip / profile-note columns: no FK to message here (auth migrates before message).
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS name_skipped_at timestamptz`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS lightning_address_skipped_at timestamptz`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS profile_message_id uuid`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS location text`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS notification_level text NOT NULL DEFAULT 'all'`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_notification_level_chk`,
  `ALTER TABLE account ADD CONSTRAINT account_notification_level_chk
    CHECK (notification_level IN ('all', 'active', 'mentions'))`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS amount_unit text NOT NULL DEFAULT 'btc'`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_amount_unit_chk`,
  `ALTER TABLE account ADD CONSTRAINT account_amount_unit_chk
    CHECK (amount_unit IN ('btc', 'fiat'))`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS locale text`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_locale_chk`,
  `ALTER TABLE account ADD CONSTRAINT account_locale_chk
    CHECK (locale IS NULL OR locale IN ('en', 'de', 'es', 'fil'))`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS fiat text`,
  `ALTER TABLE account DROP CONSTRAINT IF EXISTS account_fiat_chk`,
  `ALTER TABLE account ADD CONSTRAINT account_fiat_chk
    CHECK (fiat IS NULL OR fiat IN ('CHF', 'EUR', 'USD', 'PHP'))`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS username text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_username_uidx
    ON account (lower(trim(username))) WHERE username IS NOT NULL AND trim(username) <> ''`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS session_refused boolean NOT NULL DEFAULT false`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS wallet_required boolean NOT NULL DEFAULT false`,
  `ALTER TABLE account ADD COLUMN IF NOT EXISTS wallet_backup_seen_at timestamptz`,
  // One account may hold a login passkey plus one later seed passkey.
  `DROP INDEX IF EXISTS passkey_credential_account_uidx`,
  `UPDATE account SET role = 'initiator' WHERE lower(trim(username)) = 'pater-severin' AND role = 'moderator'`,
  `CREATE TABLE IF NOT EXISTS passkey_renew_attempt (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account (id),
    created_at timestamptz NOT NULL,
    stage text NOT NULL,
    outcome text NOT NULL,
    error_name text,
    error_code text,
    http_status integer,
    message text,
    user_agent text,
    acknowledged_at timestamptz,
    authenticator_attachment text,
    transports text,
    aaguid text,
    prf_enabled boolean,
    prf_present boolean,
    extensions text,
    authenticator_flags integer,
    public_key_algorithm integer,
    resident_key boolean,
    hmac_secret boolean,
    cred_protect text,
    client_capabilities text,
    CONSTRAINT passkey_renew_attempt_stage_chk CHECK (stage IN ('begin', 'ceremony', 'finish')),
    CONSTRAINT passkey_renew_attempt_outcome_chk CHECK (outcome IN ('failed', 'succeeded', 'cancelled'))
  )`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS authenticator_attachment text`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS transports text`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS aaguid text`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS prf_enabled boolean`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS prf_present boolean`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS extensions text`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS authenticator_flags integer`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS public_key_algorithm integer`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS resident_key boolean`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS hmac_secret boolean`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS cred_protect text`,
  `ALTER TABLE passkey_renew_attempt ADD COLUMN IF NOT EXISTS client_capabilities text`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_attachment_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_attachment_chk
    CHECK (authenticator_attachment IS NULL OR authenticator_attachment IN ('platform', 'cross-platform'))`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_aaguid_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_aaguid_chk
    CHECK (aaguid IS NULL OR aaguid ~ '^[0-9a-f]{32}$')`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_flags_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_flags_chk
    CHECK (authenticator_flags IS NULL OR (authenticator_flags >= 0 AND authenticator_flags <= 255))`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_alg_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_alg_chk
    CHECK (public_key_algorithm IS NULL OR (public_key_algorithm >= -65536 AND public_key_algorithm <= 65535))`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_cred_protect_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_cred_protect_chk
    CHECK (cred_protect IS NULL OR cred_protect IN ('userVerificationOptional', 'userVerificationOptionalWithCredentialIDList', 'userVerificationRequired'))`,
  `ALTER TABLE passkey_renew_attempt DROP CONSTRAINT IF EXISTS passkey_renew_attempt_capabilities_chk`,
  `ALTER TABLE passkey_renew_attempt ADD CONSTRAINT passkey_renew_attempt_capabilities_chk
    CHECK (client_capabilities IS NULL OR (char_length(client_capabilities) <= 1200 AND client_capabilities ~ '^[A-Za-z][A-Za-z0-9]{0,40}(,[A-Za-z][A-Za-z0-9]{0,40})*$'))`,
  `CREATE INDEX IF NOT EXISTS passkey_renew_attempt_account_idx
    ON passkey_renew_attempt (account_id, created_at DESC)`,
  `ALTER TABLE passkey_challenge ADD COLUMN IF NOT EXISTS requested_name text`,
];
