-- Operator login with SSH keys. `GET /debug/auth/challenge` stores a random
-- challenge for 60 seconds; `POST /debug/auth` deletes it in one statement, so
-- it is single use. A successful login stores the SHA-256 hex of the issued
-- token with the operator name, the key fingerprint, the level, and the end of
-- validity (15 minutes). The token itself is never stored. Expired rows are
-- deleted on every challenge and every login. Covered by db_change
-- attach-all-public-tables when migrateOperatorLoginSchema runs before
-- migrateDbChangeSchema.

CREATE TABLE IF NOT EXISTS operator_challenge (
  challenge text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS operator_challenge_expires_at_idx ON operator_challenge (expires_at);
CREATE TABLE IF NOT EXISTS operator_token (
  token_hash text PRIMARY KEY,
  operator text NOT NULL,
  key_fingerprint text NOT NULL,
  level text NOT NULL CHECK (level IN ('read', 'write', 'admin')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS operator_token_expires_at_idx ON operator_token (expires_at);
