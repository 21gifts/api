-- Private messaging threads and messages (member↔member, member↔platform,
-- member↔Damus, closed moderator_group singleton). Covered by db_change
-- attach-all-public-tables. Plaintext is not a listed secret. Dedupe
-- outbound/inbound by conversation_message.event_id.
-- On every boot, migrateConversationSchema runs an idempotent repair unwrapping
-- conversation_message.nostr_event values stored as jsonb string scalars; it
-- matches no rows once complete. The repair is skipped until the db_change audit
-- trigger is attached and retried on the next boot. A value that cannot be parsed
-- is skipped with a warning instead of failing the migration. The statement
-- lives in the store's CONVERSATION_SCHEMA_SQL array, not in this file.

CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('member_member', 'member_platform', 'member_damus', 'moderator_group')),
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
ALTER TABLE conversation DROP CONSTRAINT IF EXISTS conversation_kind_check;
ALTER TABLE conversation ADD CONSTRAINT conversation_kind_check
  CHECK (kind IN ('member_member', 'member_platform', 'member_damus', 'moderator_group'));
CREATE UNIQUE INDEX IF NOT EXISTS conversation_moderator_group_uidx
  ON conversation (kind) WHERE kind = 'moderator_group';

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
ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0;
ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS actor_account_id uuid REFERENCES account (id);
ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS actor_name text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS conversation_message_conversation_id_idx
  ON conversation_message (conversation_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_event_id_uidx
  ON conversation_message (event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_message_nostr_event_unrepaired_idx
  ON conversation_message (id)
  WHERE nostr_event IS NOT NULL AND jsonb_typeof(nostr_event) = 'string';

CREATE TABLE IF NOT EXISTS conversation_read (
  account_id uuid NOT NULL REFERENCES account (id),
  conversation_id uuid NOT NULL REFERENCES conversation (id),
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS conversation_read_conversation_id_idx
  ON conversation_read (conversation_id);
