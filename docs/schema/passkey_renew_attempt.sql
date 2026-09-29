-- Passkey renew and seed ceremony attempts: failed, cancelled, or a
-- server-written succeeded seed finish. A failed row can exist when a
-- seed is already present. Applied by migrateAuthSchema / AUTH_SCHEMA_SQL.
-- Stores only safe error fields. Does not store stack, request body,
-- response body, challenge, credential id, attestation, PRF output,
-- mnemonic, session token, or view key. Optional debug columns are
-- public authenticator facts only: attachment, allowlisted transports,
-- the 32-hex AAGUID, whether PRF was enabled or present, allowlisted
-- extension names, the WebAuthn flags byte (UP 0x01, UV 0x04, BE 0x08,
-- BS 0x10, AT 0x40, ED 0x80), the COSE algorithm, resident-key and
-- hmac-secret booleans, an allowlisted credProtect policy, and browser
-- capability names that were true. Existing databases receive those
-- columns from AUTH_SCHEMA_SQL.

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
  CONSTRAINT passkey_renew_attempt_outcome_chk CHECK (outcome IN ('failed', 'succeeded', 'cancelled')),
  CONSTRAINT passkey_renew_attempt_attachment_chk CHECK (
    authenticator_attachment IS NULL OR authenticator_attachment IN ('platform', 'cross-platform')
  ),
  CONSTRAINT passkey_renew_attempt_aaguid_chk CHECK (
    aaguid IS NULL OR aaguid ~ '^[0-9a-f]{32}$'
  ),
  CONSTRAINT passkey_renew_attempt_flags_chk CHECK (
    authenticator_flags IS NULL OR (authenticator_flags >= 0 AND authenticator_flags <= 255)
  ),
  CONSTRAINT passkey_renew_attempt_alg_chk CHECK (
    public_key_algorithm IS NULL OR (public_key_algorithm >= -65536 AND public_key_algorithm <= 65535)
  ),
  CONSTRAINT passkey_renew_attempt_cred_protect_chk CHECK (
    cred_protect IS NULL OR cred_protect IN (
      'userVerificationOptional',
      'userVerificationOptionalWithCredentialIDList',
      'userVerificationRequired'
    )
  ),
  CONSTRAINT passkey_renew_attempt_capabilities_chk CHECK (
    client_capabilities IS NULL OR (
      char_length(client_capabilities) <= 1200
      AND client_capabilities ~ '^[A-Za-z][A-Za-z0-9]{0,40}(,[A-Za-z][A-Za-z0-9]{0,40})*$'
    )
  )
);
CREATE INDEX IF NOT EXISTS passkey_renew_attempt_account_idx
  ON passkey_renew_attempt (account_id, created_at DESC);
