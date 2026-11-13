CREATE TABLE spark_viewer_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  viewer_identity_public_key text NOT NULL UNIQUE
    CHECK (viewer_identity_public_key ~ '^0[23][0-9a-f]{64}$'),
  viewer_mnemonic_ciphertext bytea NOT NULL,
  viewer_kek_id integer NOT NULL CHECK (viewer_kek_id = 1),
  created_at timestamptz NOT NULL
);

DO $spark_viewer_columns$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'nostr_nsec_ciphertext'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'viewer_mnemonic_ciphertext'
  ) THEN
    ALTER TABLE spark_viewer_key RENAME COLUMN nostr_nsec_ciphertext TO viewer_mnemonic_ciphertext;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'nostr_kek_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'viewer_kek_id'
  ) THEN
    ALTER TABLE spark_viewer_key RENAME COLUMN nostr_kek_id TO viewer_kek_id;
  END IF;
END;
$spark_viewer_columns$;
