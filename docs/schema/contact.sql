-- Private in-app contact mailbox (POST /contact; GET /debug/contacts).
-- Author display name is snapshotted at post time. Indexed newest-first for
-- listLatest. Never listed on a member-facing route.

CREATE TABLE IF NOT EXISTS contact (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_created_at_idx ON contact (created_at DESC, id DESC);
