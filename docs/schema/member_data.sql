-- Reported wallet data, interaction events, and the team access audit log.
--
-- wallet_balance_snapshot, wallet_payment, and member_event are written by
-- POST /me/wallet/report and POST /me/events and read by the team member data
-- routes (GET /team/members/:id/wallet|events and their /debug/team
-- equivalents). Both sides carry this same idempotent DDL, so either can
-- create the tables first. team_access_audit gets one row for every team read
-- of a member's wallet data or events; GET /team/audit lists it.
--
-- No table has a column for a recovery phrase, seed, PRF output, preimage, or
-- private key. trg_db_change covers all four tables.

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
CREATE TABLE IF NOT EXISTS member_event (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  at timestamptz NOT NULL,
  path text,
  props jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS member_event_account_at_idx ON member_event (account_id, at DESC, id DESC);
CREATE TABLE IF NOT EXISTS team_access_audit (
  id uuid PRIMARY KEY,
  viewer_account_id uuid NOT NULL REFERENCES account (id),
  member_account_id uuid NOT NULL REFERENCES account (id),
  what text NOT NULL CHECK (what IN ('wallet', 'events')),
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS team_access_audit_at_idx ON team_access_audit (at DESC, id DESC);
