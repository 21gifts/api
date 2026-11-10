-- Member wallet balance snapshots (viewer or app report), idempotent reported payments,
-- complete server-observed Bitcoin/token history, and full-scan watermarks.
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
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'expired', 'returned')),
  amount_sats bigint NOT NULL CHECK (amount_sats >= 0),
  counterparty_pubkey text NOT NULL CHECK (counterparty_pubkey ~ '^0[23][0-9a-f]{64}$'),
  counterparty_pubkeys text[] NOT NULL,
  counterparty_account_id uuid REFERENCES account (id),
  spark_invoice text,
  transfer_created_at timestamptz,
  transfer_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, wallet_pubkey, transfer_id)
);

DO $wallet_transfer_primary_key$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wallet_transfer'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (account_id, transfer_id)'
  ) THEN
    ALTER TABLE wallet_transfer DROP CONSTRAINT wallet_transfer_pkey;
    ALTER TABLE wallet_transfer ADD CONSTRAINT wallet_transfer_pkey
      PRIMARY KEY (account_id, wallet_pubkey, transfer_id);
  END IF;
END;
$wallet_transfer_primary_key$;

ALTER TABLE wallet_transfer ADD COLUMN IF NOT EXISTS counterparty_pubkeys text[];
UPDATE wallet_transfer SET counterparty_pubkeys = ARRAY[counterparty_pubkey] WHERE counterparty_pubkeys IS NULL;
ALTER TABLE wallet_transfer ALTER COLUMN counterparty_pubkeys SET NOT NULL;
ALTER TABLE wallet_transfer DROP CONSTRAINT IF EXISTS wallet_transfer_status_check;
ALTER TABLE wallet_transfer ADD CONSTRAINT wallet_transfer_status_check CHECK (status IN ('pending', 'completed', 'cancelled', 'expired', 'returned'));

CREATE INDEX IF NOT EXISTS wallet_transfer_wallet_created_idx ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at DESC, transfer_id);
CREATE INDEX IF NOT EXISTS wallet_transfer_pending_idx ON wallet_transfer (account_id, wallet_pubkey, transfer_created_at) WHERE status = 'pending';
DROP INDEX IF EXISTS wallet_transfer_shop_payment_idx;
CREATE INDEX wallet_transfer_shop_payment_idx ON wallet_transfer (account_id, COALESCE(transfer_updated_at, transfer_created_at)) WHERE direction = 'out' AND status = 'completed' AND type = 'transfer';
CREATE INDEX IF NOT EXISTS wallet_transfer_counterparty_idx ON wallet_transfer (counterparty_account_id) WHERE counterparty_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_transfer_sync (
  account_id uuid NOT NULL REFERENCES account (id),
  wallet_pubkey text NOT NULL CHECK (wallet_pubkey ~ '^0[23][0-9a-f]{64}$'),
  last_full_sync_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, wallet_pubkey)
);

CREATE TABLE IF NOT EXISTS wallet_token_transaction (
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
  PRIMARY KEY (account_id, wallet_pubkey, transaction_hash)
);

ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS input_count integer;
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS resolved_input_count integer;
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS token_identifier text;
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS amount numeric(39, 0);
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS counterparty_pubkeys text[];
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS spark_invoices text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE wallet_token_transaction ADD COLUMN IF NOT EXISTS transaction_expiry_at timestamptz;
UPDATE wallet_token_transaction SET direction = 'in', amount = 0, counterparty_pubkeys = ARRAY[]::text[], type = 'unknown' WHERE direction IS NULL OR amount IS NULL OR counterparty_pubkeys IS NULL OR type IS NULL;
ALTER TABLE wallet_token_transaction ALTER COLUMN direction SET NOT NULL;
ALTER TABLE wallet_token_transaction ALTER COLUMN amount SET NOT NULL;
ALTER TABLE wallet_token_transaction ALTER COLUMN counterparty_pubkeys SET NOT NULL;
ALTER TABLE wallet_token_transaction ALTER COLUMN type SET NOT NULL;
ALTER TABLE wallet_token_transaction DROP COLUMN IF EXISTS payload;
ALTER TABLE wallet_token_transaction DROP CONSTRAINT IF EXISTS wallet_token_transaction_direction_check;
ALTER TABLE wallet_token_transaction ADD CONSTRAINT wallet_token_transaction_direction_check CHECK (direction IN ('in', 'out'));
ALTER TABLE wallet_token_transaction DROP CONSTRAINT IF EXISTS wallet_token_transaction_amount_check;
ALTER TABLE wallet_token_transaction ADD CONSTRAINT wallet_token_transaction_amount_check CHECK (amount >= 0);
ALTER TABLE wallet_token_transaction DROP CONSTRAINT IF EXISTS wallet_token_transaction_input_resolution_check;
ALTER TABLE wallet_token_transaction ADD CONSTRAINT wallet_token_transaction_input_resolution_check CHECK (
  (input_count IS NULL AND resolved_input_count IS NULL)
  OR (input_count IS NOT NULL AND input_count >= 0
      AND (resolved_input_count IS NULL
           OR (resolved_input_count >= 0 AND resolved_input_count <= input_count)))
  );
ALTER TABLE wallet_token_transaction DROP CONSTRAINT IF EXISTS wallet_token_transaction_type_check;
ALTER TABLE wallet_token_transaction ADD CONSTRAINT wallet_token_transaction_type_check CHECK (type IN ('create', 'mint', 'transfer', 'unknown'));

CREATE INDEX IF NOT EXISTS wallet_token_transaction_wallet_created_idx ON wallet_token_transaction (account_id, wallet_pubkey, transaction_created_at DESC, transaction_hash);
