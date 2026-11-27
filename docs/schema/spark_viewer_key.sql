CREATE TABLE spark_viewer_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  viewer_identity_public_key text NOT NULL UNIQUE
    CHECK (viewer_identity_public_key ~ '^0[23][0-9a-f]{64}$'),
  viewer_mnemonic_ciphertext bytea NOT NULL,
  -- NOSTR_NSEC_KEK_ID the mnemonic is sealed under; KEK rotation replaces a
  -- row under another id with a fresh mnemonic (rotateSparkViewerKey).
  viewer_kek_id integer NOT NULL CHECK (viewer_kek_id >= 1),
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

-- Replace an older viewer_kek_id CHECK (= 1) with the named >= 1 constraint;
-- a no-op once it exists.
DO $spark_viewer_kek_id$
DECLARE
  c record;
BEGIN
  PERFORM pg_advisory_xact_lock(21499021);
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'public.spark_viewer_key'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%viewer_kek_id%'
  LOOP
    IF c.conname <> 'spark_viewer_key_viewer_kek_id_check' OR c.def NOT LIKE '%viewer_kek_id >= 1%' THEN
      EXECUTE format('ALTER TABLE spark_viewer_key DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.spark_viewer_key'::regclass
      AND conname = 'spark_viewer_key_viewer_kek_id_check'
  ) THEN
    ALTER TABLE spark_viewer_key
      ADD CONSTRAINT spark_viewer_key_viewer_kek_id_check CHECK (viewer_kek_id >= 1);
  END IF;
END;
$spark_viewer_kek_id$;
