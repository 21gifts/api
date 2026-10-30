-- Applied by migrateAuthSchema / AUTH_SCHEMA_SQL. One opaque box per row: a
-- social recovery share a holder keeps for another member, encrypted in the
-- holder's browser under a key derived from the holder's own 12 words. The api
-- never decrypts it and learns nothing about whose share it holds; the owner
-- side references no box. Written by PUT /me/held-shares/:id, read by
-- GET /me/held-shares, deleted by DELETE /me/held-shares/:id, with the
-- account (ON DELETE CASCADE), and by an account merge (the merged-away
-- account's boxes are dropped, not moved: the survivor could never open them).
-- ciphertext is a secret column: db_change keeps only its SHA-256. Covered by
-- db_change.

CREATE TABLE IF NOT EXISTS held_share_box (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT held_share_box_id_chk CHECK (id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT held_share_box_ciphertext_chk CHECK (
    octet_length(ciphertext) BETWEEN 29 AND 1024 AND substring(ciphertext FROM 1 FOR 1) = '\x01'::bytea)
);

CREATE INDEX IF NOT EXISTS held_share_box_account_idx ON held_share_box (account_id);
