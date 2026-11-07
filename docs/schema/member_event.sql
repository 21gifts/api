-- First-party member interaction events (POST /me/events).
-- props holds allowlisted scalars only. Unknown body fields are ignored.
-- Covered by trg_db_change on the next SQL boot after the table exists.

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
