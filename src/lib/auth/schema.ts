/**
 * Idempotent DDL for the auth tables. Applied once at process boot when
 * `DATABASE_URL` is set. `CREATE TABLE IF NOT EXISTS` is safe to re-run;
 * `ALTER TABLE` backfills `account.name` and nullable `linking_key` on
 * databases created before passkey accounts existed.
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
];
