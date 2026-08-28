-- Public forum messages (GET/POST /messages). Author display name is snapshotted
-- at post time. Indexed newest-first for listLatest.

CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC);
