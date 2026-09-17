-- Public forum messages (GET/POST /messages, GET /messages/:id/photo,
-- GET /messages/:id/video.*, POST /messages/:id/invoice). Author display name
-- is snapshotted at post time. Indexed newest-first for listLatest; listFeed
-- keyset pages use message_feed_created_idx (created_at, id) and
-- message_feed_popular_idx (sats, created_at, id). Nostr
-- columns are filled by the worker (event_id, signed JSON, publish state,
-- sats). Optional photo (bytea) + photo_content_type; list queries must not
-- SELECT the photo column — use (photo IS NOT NULL) AS has_photo only.
-- Optional video_content_type; bytes on disk under MEDIA_DIR (not bytea).
-- ALTER ADD COLUMN IF NOT EXISTS keeps existing databases additive.
-- On every boot, migrateMessageSchema runs an idempotent repair unwrapping
-- nostr_event values stored as jsonb string scalars; it matches no rows once
-- complete. The repair is skipped until the db_change audit trigger is attached
-- and retried on the next boot. A value that cannot be parsed is skipped with a
-- warning instead of failing the migration. The statement lives in the store's
-- MESSAGE_SCHEMA_SQL array, not in this file.

CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  text text NOT NULL,
  photo bytea,
  photo_content_type text,
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
ALTER TABLE message ADD COLUMN IF NOT EXISTS photo bytea;
ALTER TABLE message ADD COLUMN IF NOT EXISTS photo_content_type text;
-- Video MIME only; bytes live on disk under MEDIA_DIR (not bytea).
ALTER TABLE message ADD COLUMN IF NOT EXISTS video_content_type text;
CREATE UNIQUE INDEX IF NOT EXISTS message_event_id_uidx ON message (event_id) WHERE event_id IS NOT NULL;
ALTER TABLE message ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES message (id);
ALTER TABLE message ADD COLUMN IF NOT EXISTS author_pubkey text;
ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC);
CREATE TABLE IF NOT EXISTS nostr_zap_receipt (
  event_id text PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message (id),
  sats bigint NOT NULL
);
ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS payer_account_id uuid;
ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS gift_reply_id uuid REFERENCES message (id);
ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS comment text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS nostr_zap_receipt_gift_reply_id_uidx ON nostr_zap_receipt (gift_reply_id) WHERE gift_reply_id IS NOT NULL;

-- Payment-hash ownership tombstones intentionally outlive message deletion.
-- No message foreign key: deleting and restoring a message must not reopen a payment.
CREATE TABLE IF NOT EXISTS nostr_zap_payment (
  payment_hash text PRIMARY KEY,
  receipt_event_id text NOT NULL,
  created_at timestamptz NOT NULL
);

-- Invoice attempts from POST /messages/:id/invoice (success and failure).
-- No FK on message_id so not_found attempts still persist.
CREATE TABLE IF NOT EXISTS message_invoice (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  message_id uuid NOT NULL,
  payer_account_id uuid NOT NULL,
  author_account_id uuid NOT NULL,
  amount_sats bigint NOT NULL,
  lightning_address text,
  zap_request jsonb,
  result text NOT NULL,
  http_status integer NOT NULL,
  pr text,
  payment_hash text,
  description text,
  description_hash text,
  is_nip57_invoice boolean NOT NULL DEFAULT false
);
ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb;
ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS conversation_message_id uuid;
CREATE INDEX IF NOT EXISTS message_invoice_created_at_idx
  ON message_invoice (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS message_invoice_message_id_idx
  ON message_invoice (message_id, created_at DESC);

-- kind:9735 ingest decisions (indexed or rejected) for operator debug.
CREATE TABLE IF NOT EXISTS nostr_zap_ingest (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  receipt_id text NOT NULL,
  note_event_id text,
  message_id uuid,
  outcome text NOT NULL,
  reason text,
  amount_sats bigint,
  receipt_pubkey text,
  receipt jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS nostr_zap_ingest_receipt_id_idx
  ON nostr_zap_ingest (receipt_id);
CREATE INDEX IF NOT EXISTS nostr_zap_ingest_created_at_idx
  ON nostr_zap_ingest (created_at DESC, id DESC);

-- Profile note FK (account.profile_message_id is added in AUTH_SCHEMA_SQL without FK).
ALTER TABLE account DROP CONSTRAINT IF EXISTS account_profile_message_id_fkey;
ALTER TABLE account ADD CONSTRAINT account_profile_message_id_fkey
  FOREIGN KEY (profile_message_id) REFERENCES message (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_profile_message_uidx
  ON account (profile_message_id) WHERE profile_message_id IS NOT NULL;

-- Soft-hide stamps (HTTP DELETE /messages/:id). No FK on deleted_by.
ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_by uuid;
CREATE INDEX IF NOT EXISTS message_feed_created_idx ON message (created_at DESC, id DESC) WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS message_feed_popular_idx ON message (sats DESC, created_at DESC, id DESC) WHERE parent_id IS NULL AND deleted_at IS NULL AND sats > 0;
CREATE INDEX IF NOT EXISTS message_nostr_event_unrepaired_idx
  ON message (id)
  WHERE nostr_event IS NOT NULL AND jsonb_typeof(nostr_event) = 'string';

-- Live media dedupe fingerprint (photo/video POST collapse). Not selected on list/get.
ALTER TABLE message ADD COLUMN IF NOT EXISTS content_fp text;

-- Backfill live photo-only rows. CREATE EXTENSION ensures pgcrypto (digest)
-- is available here even when db_change has not run yet.
-- Do not hash poster-on-video rows; those stay content_fp null (runtime
-- fingerprints video bytes, not the poster). On-disk videos have no bytea.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE message
SET content_fp = encode(
  digest(
    convert_to(text, 'UTF8') || decode('00', 'hex') || digest(photo, 'sha256'),
    'sha256'
  ),
  'hex'
)
WHERE photo IS NOT NULL AND content_fp IS NULL AND video_content_type IS NULL;

-- Salt extra live duplicates so the unique index can be created (keep oldest).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY account_id, content_fp
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM message
  WHERE deleted_at IS NULL AND parent_id IS NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL
)
UPDATE message
SET content_fp = content_fp || ':' || message.id::text
FROM ranked
WHERE message.id = ranked.id AND ranked.rn > 1;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY account_id, parent_id, content_fp
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM message
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL
)
UPDATE message
SET content_fp = content_fp || ':' || message.id::text
FROM ranked
WHERE message.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS message_live_top_content_fp_uidx
  ON message (account_id, content_fp)
  WHERE deleted_at IS NULL AND parent_id IS NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS message_live_reply_content_fp_uidx
  ON message (account_id, parent_id, content_fp)
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL
    AND account_id IS NOT NULL AND content_fp IS NOT NULL;

-- Extra stills only (indices 1–9). Photo 0 stays on message.photo.
-- List queries never SELECT extra bytes.
CREATE TABLE IF NOT EXISTS message_extra_photo (
  message_id uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  idx smallint NOT NULL,
  photo bytea NOT NULL,
  photo_content_type text NOT NULL,
  PRIMARY KEY (message_id, idx),
  CONSTRAINT message_extra_photo_idx_range CHECK (idx >= 1 AND idx <= 9)
);
