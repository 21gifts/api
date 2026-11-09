-- Applied by migrateAuthSchema / AUTH_SCHEMA_SQL. Wallet keys an account had
-- before a social recovery commit, with their Spark address, until the owner
-- drops them (DELETE /me/previous-wallets/:sparkPubkey). Deleted by an account
-- merge. Covered by db_change.

CREATE TABLE IF NOT EXISTS previous_wallet (
  account_id uuid NOT NULL REFERENCES account (id),
  spark_pubkey text NOT NULL,
  spark_address text NOT NULL,
  replaced_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, spark_pubkey),
  CONSTRAINT previous_wallet_spark_pubkey_chk CHECK (spark_pubkey ~ '^0[23][0-9a-f]{64}$'),
  CONSTRAINT previous_wallet_spark_address_chk CHECK (spark_address ~ '^spark1[02-9ac-hj-np-z]{62}$')
);
CREATE INDEX IF NOT EXISTS previous_wallet_spark_pubkey_idx ON previous_wallet (spark_pubkey);
