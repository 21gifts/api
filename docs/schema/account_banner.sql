-- One wide header image per account. Not the About me photo.
CREATE TABLE IF NOT EXISTS account_banner (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data bytea NOT NULL
);
