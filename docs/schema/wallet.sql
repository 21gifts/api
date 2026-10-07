-- Member wallet balance snapshots and idempotent reported payments.
-- Boot migration precedes db_change attachment so every durable write is audited.

CREATE TABLE IF NOT EXISTS wallet_balance_snapshot (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  balance_sats bigint NOT NULL CHECK (balance_sats >= 0),
  synced_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);

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

CREATE INDEX IF NOT EXISTS wallet_payment_account_paid_idx ON wallet_payment (account_id, paid_at DESC, payment_id DESC);
