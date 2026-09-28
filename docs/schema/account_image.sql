-- One image per slot. picture and banner never share a row.
CREATE TABLE IF NOT EXISTS account_image (
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('picture', 'banner')),
  content_type text NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (account_id, slot)
);
