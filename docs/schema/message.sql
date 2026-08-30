-- Public forum messages (GET/POST /messages, GET /messages/:id/photo,
-- GET /messages/:id/video.*, POST /messages/:id/invoice). Author display name
-- is snapshotted at post time. Indexed newest-first for listLatest. Nostr
-- columns are filled by the worker (event_id, signed JSON, publish state,
-- sats). Optional photo (bytea) + photo_content_type; list queries must not
-- SELECT the photo column — use (photo IS NOT NULL) AS has_photo only.
-- Optional video_content_type; bytes on disk under MEDIA_DIR (not bytea).
-- ALTER ADD COLUMN IF NOT EXISTS keeps existing databases additive.

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
CREATE TABLE IF NOT EXISTS nostr_zap_receipt (
  event_id text PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message (id),
  sats bigint NOT NULL
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
