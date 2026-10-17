-- Shop payments in USDT and USDC (docs/shop-stablecoin-payment.md, Rows).
-- One shop_payment per BOLT11 of a till charge or a payer-entered amount; its
-- quotes (shop_quote) serve the OpenCryptoPay transferAmounts, each quote holds
-- one committed Orchestra quote per method and asset (shop_offer), every
-- deposit to an offer's address is one shop_proof, and a tx hash whose
-- receipt was not found yet waits in shop_proof_lookup. Needs account and
-- pos_charge. Mirrors SHOP_PAYMENT_SCHEMA_SQL in src/lib/shop-payment-store.ts.

CREATE TABLE IF NOT EXISTS shop_payment (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES account (id),
  amount_sats        bigint NOT NULL CHECK (amount_sats > 0),
  pos_charge_id      uuid UNIQUE REFERENCES pos_charge (id) ON DELETE SET NULL,
  bolt11             text NOT NULL,
  payment_hash       text NOT NULL UNIQUE,
  bolt11_expires_at  timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('open', 'accepted', 'paid', 'ended')),
  end_reason         text CHECK (end_reason IN ('window', 'superseded', 'replaced', 'cancelled',
                       'charge_paid', 'orchestra_refunded', 'orchestra_failed', 'proof_refused',
                       'expired_unpaid')),
  window_ends_at     timestamptz NOT NULL,
  replacements       integer NOT NULL DEFAULT 0 CHECK (replacements BETWEEN 0 AND 4),
  next_settle_at     timestamptz,
  next_history_at    timestamptz,
  history_offset     integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  paid_at            timestamptz,
  ended_at           timestamptz,
  closed_at          timestamptz,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (closed_at IS NULL OR status = 'ended')
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_payment_account_open_idx
  ON shop_payment (account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS shop_payment_history_idx
  ON shop_payment (next_history_at) WHERE next_history_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_payment_settle_idx
  ON shop_payment (next_settle_at) WHERE status <> 'paid' AND closed_at IS NULL;

CREATE TABLE IF NOT EXISTS shop_quote (
  id                uuid PRIMARY KEY,
  payment_id        uuid NOT NULL REFERENCES shop_payment (id),
  expires_at        timestamptz NOT NULL,
  transfer_amounts  jsonb NOT NULL,
  created_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_quote_payment_idx ON shop_quote (payment_id, created_at);

CREATE TABLE IF NOT EXISTS shop_offer (
  id                uuid PRIMARY KEY,
  quote_id          uuid NOT NULL REFERENCES shop_quote (id),
  method            text NOT NULL,
  chain_id          integer NOT NULL,
  asset             text NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  token_address     text NOT NULL,
  deposit_address   text NOT NULL,
  amount_in         numeric(78, 0) NOT NULL CHECK (amount_in > 0),
  required_amount_in     numeric(78, 0),
  max_accepted_amount_in numeric(78, 0),
  decimals          smallint NOT NULL,
  min_fee           numeric(78, 0) NOT NULL,
  provider_ref      text NOT NULL,
  idempotency_key   text NOT NULL,
  expires_at        timestamptz NOT NULL,
  detail_issued_at  timestamptz,
  created_at        timestamptz NOT NULL,
  UNIQUE (quote_id, method, asset)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_offer_deposit_idx ON shop_offer (deposit_address);

CREATE TABLE IF NOT EXISTS shop_proof (
  id                 uuid PRIMARY KEY,
  offer_id           uuid NOT NULL REFERENCES shop_offer (id),
  payment_id         uuid NOT NULL REFERENCES shop_payment (id),
  source             text NOT NULL CHECK (source IN ('tx', 'hex', 'detected')),
  chain_id           integer NOT NULL,
  tx_hash            text NOT NULL,
  log_index          integer,
  user_op_hash       text,
  raw_hex            text,
  transfer_amount    numeric(78, 0),
  idempotency_key    text NOT NULL,
  result             text CHECK (result IN ('accepted', 'superseded', 'late', 'refunded', 'failed',
                       'refused', 'stuck')),
  provider_order     text,
  order_status       text,
  order_found_at     timestamptz,
  refusal            text CHECK (refusal IN ('mismatch', 'expired_order', 'hex_rejected', 'tx_used')),
  submit_stopped     boolean NOT NULL DEFAULT false, -- set when a submit answered 409 quote_expired
  sent_at            timestamptz,
  last_submit_at     timestamptz,
  give_up_at         timestamptz NOT NULL,
  next_submit_at     timestamptz,
  next_receipt_at    timestamptz,
  next_status_at     timestamptz,
  tries              integer NOT NULL DEFAULT 0,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL,
  CHECK (source <> 'tx' OR (log_index IS NOT NULL AND transfer_amount IS NOT NULL)),
  CHECK (source <> 'hex' OR raw_hex IS NOT NULL),
  CHECK (result NOT IN ('accepted', 'superseded', 'refunded', 'failed') OR provider_order IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_log_idx
  ON shop_proof (chain_id, tx_hash, log_index) WHERE log_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_unlogged_idx
  ON shop_proof (chain_id, tx_hash, offer_id) WHERE log_index IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_order_idx
  ON shop_proof (provider_order) WHERE provider_order IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_payment_accepted_idx
  ON shop_proof (payment_id) WHERE result = 'accepted';
CREATE INDEX IF NOT EXISTS shop_proof_user_op_idx
  ON shop_proof (chain_id, user_op_hash) WHERE user_op_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_proof_submit_idx ON shop_proof (next_submit_at);
CREATE INDEX IF NOT EXISTS shop_proof_receipt_idx ON shop_proof (next_receipt_at);
CREATE INDEX IF NOT EXISTS shop_proof_status_idx ON shop_proof (next_status_at);

CREATE TABLE IF NOT EXISTS shop_proof_lookup (
  id           uuid PRIMARY KEY,
  quote_id     uuid NOT NULL REFERENCES shop_quote (id),
  method       text NOT NULL,
  asset        text,
  chain_id     integer NOT NULL,
  hash         text NOT NULL,
  next_try_at  timestamptz NOT NULL,
  tries        integer NOT NULL DEFAULT 0,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (chain_id, hash, quote_id)
);
CREATE INDEX IF NOT EXISTS shop_proof_lookup_due_idx
  ON shop_proof_lookup (next_try_at) WHERE done_at IS NULL;
