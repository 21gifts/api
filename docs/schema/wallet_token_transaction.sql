CREATE TABLE wallet_token_transaction (
  account_id uuid NOT NULL REFERENCES account (id),
  wallet_pubkey text NOT NULL CHECK (wallet_pubkey ~ '^0[23][0-9a-f]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^[0-9a-f]{64}$'),
  token_identifier text,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  amount numeric(39, 0) NOT NULL CHECK (amount >= 0),
  counterparty_pubkeys text[] NOT NULL,
  input_count integer,
  resolved_input_count integer,
  spark_invoices text[] NOT NULL DEFAULT ARRAY[]::text[],
  type text NOT NULL CHECK (type IN ('create', 'mint', 'transfer', 'unknown')),
  status text NOT NULL CHECK (status IN ('started', 'signed', 'revealed', 'finalized', 'cancelled', 'unknown')),
  transaction_created_at timestamptz,
  transaction_expiry_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, wallet_pubkey, transaction_hash),
  CONSTRAINT wallet_token_transaction_input_resolution_check CHECK (
    (input_count IS NULL AND resolved_input_count IS NULL)
    OR (input_count IS NOT NULL AND input_count >= 0
        AND (resolved_input_count IS NULL
             OR (resolved_input_count >= 0 AND resolved_input_count <= input_count)))
  )
);

CREATE INDEX wallet_token_transaction_wallet_created_idx
  ON wallet_token_transaction (account_id, wallet_pubkey, transaction_created_at DESC, transaction_hash);
