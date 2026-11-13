CREATE TABLE wallet_transfer_sync (
  account_id uuid NOT NULL REFERENCES account (id),
  wallet_pubkey text NOT NULL CHECK (wallet_pubkey ~ '^0[23][0-9a-f]{64}$'),
  last_full_sync_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, wallet_pubkey)
);
