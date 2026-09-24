-- Outbound gifts recorded for public statistics (GET /gifts/stats).
-- The api reads paid_at, amount_sats, recipient_wos_user, and kind.

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
ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_usd numeric(20, 2);
ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_chf numeric(20, 2);
ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_eur numeric(20, 2);
ALTER TABLE gift ADD COLUMN IF NOT EXISTS fiat_php numeric(20, 2);
ALTER TABLE gift ADD COLUMN IF NOT EXISTS kind text;
-- NULL rows with description 21gifts moderator become moderator; remaining NULL
-- rows are matched one-to-one only to platform replies whose trimmed text is
-- Welcome or 21gifts daily (same sats, lightning local-part, within 3 seconds),
-- and only an assigned Welcome becomes welcome;
-- remaining NULL becomes daily; then, only if absent, gift_kind_check CHECK
-- (kind IN ('daily','welcome','moderator')); then kind is SET NOT NULL.
-- 'other' is not a database value.
