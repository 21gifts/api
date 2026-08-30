-- Web Push subscriptions (per account) and outbox for the push worker.
-- Endpoint is the primary key so a device rebinding on login moves ownership.
-- Outbox rows are claimed with a lease (same idea as message.claimed_until).

CREATE TABLE IF NOT EXISTS push_subscription (
  endpoint text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscription_account_id_idx ON push_subscription (account_id);

CREATE TABLE IF NOT EXISTS push_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  type text NOT NULL CHECK (type IN ('forum', 'zap')),
  message_id uuid,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS push_outbox_pending_idx ON push_outbox (created_at, id) WHERE status = 'pending';
