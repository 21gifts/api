-- Spark invoices issued next to member-to-member zap invoices.
-- One row per zap invoice payment hash. The Spark invoice worker polls open
-- rows issued in the last 60 minutes and marks a row settled once the Spark
-- transfer is finalized and the zap receipt for `bolt11` was ingested.

CREATE TABLE IF NOT EXISTS spark_invoice (
  payment_hash text PRIMARY KEY,
  invoice text NOT NULL UNIQUE,
  receiver_pubkey text NOT NULL,
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  bolt11 text NOT NULL,
  zap_request text NOT NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'settled')),
  transfer_id text,
  receipt_event_id text
);
CREATE INDEX IF NOT EXISTS spark_invoice_open_created_idx
  ON spark_invoice (created_at) WHERE status = 'open';
