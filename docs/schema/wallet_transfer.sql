CREATE TABLE wallet_transfer (
  account_id uuid NOT NULL REFERENCES account (id),
  wallet_pubkey text NOT NULL CHECK (wallet_pubkey ~ '^0[23][0-9a-f]{64}$'),
  transfer_id text NOT NULL CHECK (transfer_id <> ''),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  type text NOT NULL CHECK (type IN ('preimage_swap', 'cooperative_exit', 'transfer', 'utxo_swap', 'primary_swap_v3', 'counter_swap_v3', 'swap', 'counter_swap', 'unrecognized')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'returned')),
  amount_sats bigint NOT NULL CHECK (amount_sats >= 0),
  counterparty_pubkey text NOT NULL CHECK (counterparty_pubkey ~ '^0[23][0-9a-f]{64}$'),
  counterparty_account_id uuid REFERENCES account (id),
  spark_invoice text,
  transfer_created_at timestamptz,
  transfer_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, transfer_id)
);

CREATE INDEX wallet_transfer_wallet_created_idx
  ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at DESC, transfer_id);
CREATE INDEX wallet_transfer_pending_idx
  ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at)
  WHERE status = 'pending';
CREATE INDEX wallet_transfer_shop_payment_idx
  ON wallet_transfer (account_id, COALESCE(transfer_updated_at, transfer_created_at))
  WHERE direction = 'out' AND status = 'completed' AND type = 'transfer'
    AND counterparty_account_id IS NOT NULL;
CREATE INDEX wallet_transfer_counterparty_idx
  ON wallet_transfer (counterparty_account_id)
  WHERE counterparty_account_id IS NOT NULL;
