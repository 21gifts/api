-- Passkey renew ceremony attempts for members who do not yet have a
-- seed-bearing passkey. Applied by migrateAuthSchema / AUTH_SCHEMA_SQL.
-- Stores only safe error fields. Does not store stack, request body,
-- response body, challenge, credential, attestation, PRF output,
-- mnemonic, session token, or view key.

CREATE TABLE IF NOT EXISTS passkey_renew_attempt (
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
  CONSTRAINT passkey_renew_attempt_stage_chk CHECK (stage IN ('begin', 'ceremony', 'finish')),
  CONSTRAINT passkey_renew_attempt_outcome_chk CHECK (outcome IN ('failed', 'succeeded', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS passkey_renew_attempt_account_idx
  ON passkey_renew_attempt (account_id, created_at DESC);
