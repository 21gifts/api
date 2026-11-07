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

-- Member Spark invoices handed out by POST /pay/:username/invoice without a
-- pending charge. The worker deletes rows whose expires_at has passed, and
-- pushes "You received N sats" once for an open row the Spark coordinator
-- reports finalized. Each account keeps at most 20 open rows: the one just
-- stored plus its 19 newest other open ones; storing one more deletes the
-- oldest of the others. Concurrent stores for one account can briefly leave
-- more open rows; the account's next store trims back.
CREATE TABLE IF NOT EXISTS member_spark_invoice (
  invoice text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pay')),
  account_id uuid NOT NULL,
  receiver_pubkey text NOT NULL,
  amount_sats bigint NOT NULL CHECK (amount_sats > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'notified'))
);
CREATE INDEX IF NOT EXISTS member_spark_invoice_account_open_idx
  ON member_spark_invoice (account_id, created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS member_spark_invoice_expires_idx
  ON member_spark_invoice (expires_at);
