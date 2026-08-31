-- Private messaging threads and messages (member↔member, member↔platform,
-- member↔Damus). Covered by db_change attach-all-public-tables. Plaintext is
-- not a listed secret. Dedupe outbound/inbound by conversation_message.event_id.

CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('member_member', 'member_platform', 'member_damus')),
  account_a uuid NOT NULL REFERENCES account (id),
  account_b uuid REFERENCES account (id),
  counterpart_pubkey text,
  created_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_member_uidx
  ON conversation (account_a, account_b)
  WHERE kind = 'member_member';
CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_platform_uidx
  ON conversation (account_a)
  WHERE kind = 'member_platform';
CREATE UNIQUE INDEX IF NOT EXISTS conversation_member_damus_uidx
  ON conversation (account_a, counterpart_pubkey)
  WHERE kind = 'member_damus';
CREATE INDEX IF NOT EXISTS conversation_last_message_at_idx
  ON conversation (last_message_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS conversation_message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation (id),
  text text NOT NULL,
  created_at timestamptz NOT NULL,
  sender_account_id uuid REFERENCES account (id),
  sender_pubkey text,
  name text NOT NULL,
  event_id text,
  nostr_publish_state text NOT NULL,
  nostr_event jsonb,
  claimed_until timestamptz
);
CREATE INDEX IF NOT EXISTS conversation_message_conversation_id_idx
  ON conversation_message (conversation_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_event_id_uidx
  ON conversation_message (event_id)
  WHERE event_id IS NOT NULL;
