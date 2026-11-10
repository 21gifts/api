-- Decided payout instructions the `fond` member pays from its own wallet
-- when PAYOUT_SIGNER=fond. The ping path writes the amount and comment the
-- API already decided; the /fond invoice route issues the invoice and the
-- paid worker detects its settlement.
-- Dedupe matches spend: one daily/moderator row per (utc_day, kind, address),
-- one welcome row ever per address. No ENUM types: text + CHECK constraints.

CREATE TABLE IF NOT EXISTS fond_payout (
  id uuid PRIMARY KEY,
  utc_day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('daily', 'moderator', 'welcome')),
  address text NOT NULL,
  amount_usd text NOT NULL,
  comment text NOT NULL,
  message_id text,
  group_message_id text,
  status text NOT NULL CHECK
    (status IN ('owed', 'issuing', 'invoiced', 'settling', 'paid', 'failed')),
  failure text,
  invoice_id text,
  payment_hash text,
  bolt11 text,
  spark_invoice text,
  amount_msat bigint,
  claimed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fond_payout DROP CONSTRAINT IF EXISTS fond_payout_status_check;
ALTER TABLE fond_payout ADD CONSTRAINT fond_payout_status_check
  CHECK (status IN ('owed', 'issuing', 'invoiced', 'settling', 'paid', 'failed'));
ALTER TABLE fond_payout ADD COLUMN IF NOT EXISTS amount_msat bigint;
ALTER TABLE fond_payout ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;
ALTER TABLE fond_payout ADD COLUMN IF NOT EXISTS spark_invoice text NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_daily_moderator_uidx
  ON fond_payout (utc_day, kind, address)
  WHERE kind IN ('daily', 'moderator');
CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_welcome_uidx
  ON fond_payout (kind, address)
  WHERE kind = 'welcome';
