-- Member point-of-sale charges (GET/POST/DELETE /pos).
-- One unexpired pending amount in whole sats. Expired rows are not a live
-- invoice. Settlement stays at Wallet of Satoshi; this API cannot see payment.

CREATE TABLE IF NOT EXISTS pos_charge (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  status text NOT NULL CHECK (status IN ('pending', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_charge_account_created_idx
  ON pos_charge (account_id, created_at DESC, id DESC);
