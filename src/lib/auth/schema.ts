/**
 * Idempotent DDL for the auth tables. Applied once at process boot when
 * `DATABASE_URL` is set. `CREATE TABLE IF NOT EXISTS` is safe to re-run;
 * `ALTER TABLE` backfills `account.name`, nullable `linking_key`, and
 * `forum_laws_dismissed` on databases created before those columns existed.
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
    created_at timestamptz NOT NULL
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
];
