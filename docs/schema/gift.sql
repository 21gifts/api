-- Outbound gifts recorded for public statistics (GET /gifts/stats).
-- The api reads paid_at, amount_sats, recipient_wos_user only.

CREATE TABLE IF NOT EXISTS gift (
  id                 bigserial PRIMARY KEY,
  paid_at            timestamptz NOT NULL,
  direction          text NOT NULL CHECK (direction = 'outbound'),
  currency           text NOT NULL,
  amount_sats        bigint NOT NULL CHECK (amount_sats >= 0),
  fee_sats           bigint NOT NULL CHECK (fee_sats >= 0),
  recipient_wos_user text NOT NULL,
  lightning_invoice  text NOT NULL,
  wos_transaction_id text,
  description        text NOT NULL,
  point_of_sale      boolean NOT NULL DEFAULT false,
  wos_status         text,
  source_wallet      text NOT NULL,
  imported_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gift_invoice_uidx
  ON gift (lightning_invoice);

CREATE INDEX IF NOT EXISTS gift_paid_at_idx ON gift (paid_at);
CREATE INDEX IF NOT EXISTS gift_recipient_idx ON gift (recipient_wos_user);
CREATE INDEX IF NOT EXISTS gift_source_wallet_idx ON gift (source_wallet);

-- At most one spend payout per recipient per UTC day. Claimed before a BOLT11
-- is fetched so two workers cannot pay Lightning twice.
CREATE TABLE IF NOT EXISTS gift_day_claim (
  recipient_wos_user text NOT NULL,
  utc_day date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_wos_user, utc_day)
);
