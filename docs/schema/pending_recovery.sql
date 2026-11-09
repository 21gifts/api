-- Applied by migrateAuthSchema / AUTH_SCHEMA_SQL. At most one pending social
-- recovery per account (POST /auth/passkey/recovery/finish), until it commits
-- (POST /lnurlpay/:pubkey/transfer or a settling lookup) or is dropped. An
-- unforwarded row counts as absent after CHALLENGE_TTL_MS. Stores the new
-- passkey's public key, never a secret. Deleted by an account merge. Covered
-- by db_change.

CREATE TABLE IF NOT EXISTS pending_recovery (
  account_id uuid PRIMARY KEY REFERENCES account (id),
  old_spark_pubkey text NOT NULL,
  new_spark_pubkey text NOT NULL,
  credential_id text NOT NULL,
  public_key bytea NOT NULL,
  sign_count integer NOT NULL,
  created_at timestamptz NOT NULL,
  forwarded_at timestamptz,
  CONSTRAINT pending_recovery_keys_chk CHECK (
    old_spark_pubkey ~ '^0[23][0-9a-f]{64}$'
    AND new_spark_pubkey ~ '^0[23][0-9a-f]{64}$'
    AND old_spark_pubkey <> new_spark_pubkey),
  CONSTRAINT pending_recovery_sign_count_chk CHECK (sign_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_recovery_new_spark_pubkey_uidx ON pending_recovery (new_spark_pubkey);
CREATE UNIQUE INDEX IF NOT EXISTS pending_recovery_credential_id_uidx ON pending_recovery (credential_id);
