-- Applied by migrateAuthSchema / AUTH_SCHEMA_SQL. One AES-256-GCM envelope of
-- the 21.gifts SLIP-39 share per account and wallet key, under
-- RECOVERY_SHARE_KEK, with the account id as additional data. Written by
-- PUT /me/recovery-share; deleted with its previous wallet
-- (DELETE /me/previous-wallets/:sparkPubkey) and by an account merge. No route
-- returns it and nothing in the api decrypts it. recovery_share_ciphertext is a
-- secret column: db_change keeps only its SHA-256. Covered by db_change.

CREATE TABLE IF NOT EXISTS recovery_share (
  account_id uuid NOT NULL REFERENCES account (id),
  spark_pubkey text NOT NULL,
  recovery_share_ciphertext bytea NOT NULL,
  stored_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, spark_pubkey),
  CONSTRAINT recovery_share_spark_pubkey_chk CHECK (spark_pubkey ~ '^0[23][0-9a-f]{64}$'),
  CONSTRAINT recovery_share_ciphertext_chk CHECK (octet_length(recovery_share_ciphertext) BETWEEN 34 AND 1024)
);
