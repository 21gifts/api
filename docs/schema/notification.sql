-- In-app notifications for forum replies (GET /notifications; mark-read POST).
-- Actor display name and reply text are snapshotted at reply time. Unique on
-- (recipient, type, reply) so a duplicate persist is idempotent. Indexed
-- newest-first for listByRecipient.

CREATE TABLE IF NOT EXISTS notification (
  id uuid PRIMARY KEY,
  recipient_account_id uuid NOT NULL REFERENCES account (id),
  actor_account_id uuid NOT NULL REFERENCES account (id),
  type text NOT NULL,
  parent_id uuid NOT NULL,
  reply_id uuid NOT NULL,
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_recipient_type_reply_idx
  ON notification (recipient_account_id, type, reply_id);
CREATE INDEX IF NOT EXISTS notification_recipient_created_at_idx
  ON notification (recipient_account_id, created_at DESC, id DESC);
