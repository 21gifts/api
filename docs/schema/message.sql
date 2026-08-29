-- Public forum messages (GET/POST /messages). Author display name is snapshotted
-- at post time. Indexed newest-first for listLatest. Nostr columns are filled
-- by the worker (event_id, signed JSON, publish state, sats).

CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS message_created_at_idx ON message (created_at DESC, id DESC);
ALTER TABLE message ADD COLUMN IF NOT EXISTS event_id text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_publish_state text NOT NULL DEFAULT 'pending';
ALTER TABLE message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0;
ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_event jsonb;
ALTER TABLE message ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_first_attempt_at timestamptz;
ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_publish_epoch text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS nostr_attempts integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS message_event_id_uidx ON message (event_id) WHERE event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS nostr_zap_receipt (
  event_id text PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message (id),
  sats bigint NOT NULL
);
