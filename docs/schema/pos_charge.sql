-- Member point-of-sale charges (GET/POST/DELETE /pos).
-- One unexpired pending amount in whole sats. Expired rows are not a live
-- invoice. Settlement goes to the member's receiving address. The api watches
-- the invoices it handed out for a pending charge (spark_invoice and the
-- BOLT11 payment hashes in pos_charge_invoice) and marks the charge paid once
-- one of them settles.

CREATE TABLE IF NOT EXISTS pos_charge (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  spark_invoice text
);
CREATE INDEX IF NOT EXISTS pos_charge_account_created_idx
  ON pos_charge (account_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pos_charge_account_pending_idx
  ON pos_charge (account_id) WHERE status = 'pending';
-- Tables created before the paid status.
ALTER TABLE pos_charge ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE pos_charge ADD COLUMN IF NOT EXISTS spark_invoice text;
ALTER TABLE pos_charge DROP CONSTRAINT IF EXISTS pos_charge_status_check;
ALTER TABLE pos_charge ADD CONSTRAINT pos_charge_status_check
  CHECK (status IN ('pending', 'paid', 'cancelled', 'expired'));
CREATE INDEX IF NOT EXISTS pos_charge_watch_idx
  ON pos_charge (expires_at) WHERE status IN ('pending', 'expired');

-- BOLT11 payment hashes handed out for a charge while it was pending
-- (POST /pay/:username/invoice and the forwarded GET /lnurlp/:username/invoice).
CREATE TABLE IF NOT EXISTS pos_charge_invoice (
  payment_hash text PRIMARY KEY,
  charge_id uuid NOT NULL REFERENCES pos_charge (id),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_charge_invoice_charge_idx
  ON pos_charge_invoice (charge_id, created_at);
