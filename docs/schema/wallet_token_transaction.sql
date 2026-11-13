CREATE TABLE wallet_token_transaction (
  account_id uuid NOT NULL REFERENCES account (id),
  wallet_pubkey text NOT NULL CHECK (wallet_pubkey ~ '^0[23][0-9a-f]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^[0-9a-f]{64}$'),
  token_identifier text,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  amount numeric(39, 0) NOT NULL CHECK (amount >= 0),
  counterparty_pubkeys text[] NOT NULL,
  type text NOT NULL CHECK (type IN ('create', 'mint', 'transfer', 'unknown')),
  status text NOT NULL CHECK (status IN ('started', 'signed', 'revealed', 'finalized', 'cancelled', 'unknown')),
  transaction_created_at timestamptz,
  transaction_expiry_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, wallet_pubkey, transaction_hash)
);

CREATE INDEX wallet_token_transaction_wallet_created_idx
  ON wallet_token_transaction (account_id, wallet_pubkey, transaction_created_at DESC, transaction_hash);
