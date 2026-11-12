-- Member wallet balance snapshots (viewer or legacy app report), idempotent reported payments,
-- and complete server-observed transfer history.
-- Boot migration precedes db_change attachment so every durable write is audited.

CREATE TABLE IF NOT EXISTS wallet_balance_snapshot (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  balance_sats bigint NOT NULL CHECK (balance_sats >= 0),
  synced_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);

ALTER TABLE wallet_balance_snapshot ADD COLUMN IF NOT EXISTS wallet_pubkey text;
ALTER TABLE wallet_balance_snapshot DROP CONSTRAINT IF EXISTS wallet_balance_snapshot_wallet_pubkey_chk;
ALTER TABLE wallet_balance_snapshot ADD CONSTRAINT wallet_balance_snapshot_wallet_pubkey_chk CHECK (wallet_pubkey IS NULL OR wallet_pubkey ~ '^0[23][0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS wallet_balance_snapshot_account_received_idx ON wallet_balance_snapshot (account_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wallet_payment (
  account_id uuid NOT NULL REFERENCES account (id),
  payment_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  amount_sats bigint NOT NULL CHECK (amount_sats >= 0),
  fee_sats bigint NOT NULL CHECK (fee_sats >= 0),
  paid_at timestamptz NOT NULL,
  method text NOT NULL,
  payment_hash text,
  invoice text,
  destination text,
  description text,
  lnurl_comment text,
  category text NOT NULL CHECK (category IN ('member', 'shop', 'platform', 'gift', 'outside_lightning', 'onchain', 'unknown')),
  counterparty_account_id uuid REFERENCES account (id),
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, payment_id)
);

ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS invoice text;
ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS last_observed_at timestamptz;

CREATE INDEX IF NOT EXISTS wallet_payment_account_paid_idx ON wallet_payment (account_id, paid_at DESC, payment_id DESC);

-- Pairs the two sides of an internal transfer (same payment_id on two accounts).
CREATE INDEX IF NOT EXISTS wallet_payment_payment_id_idx ON wallet_payment (payment_id);

CREATE TABLE IF NOT EXISTS wallet_transfer (
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

CREATE INDEX IF NOT EXISTS wallet_transfer_wallet_created_idx ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at DESC, transfer_id);
CREATE INDEX IF NOT EXISTS wallet_transfer_pending_idx ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wallet_transfer_shop_payment_idx ON wallet_transfer (account_id, COALESCE(transfer_updated_at, transfer_created_at)) WHERE direction = 'out' AND status = 'completed' AND type = 'transfer' AND counterparty_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_transfer_counterparty_idx ON wallet_transfer (counterparty_account_id) WHERE counterparty_account_id IS NOT NULL;
