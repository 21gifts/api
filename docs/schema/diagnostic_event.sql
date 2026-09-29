-- Rows outlive passkey_challenge so a failed ceremony can be reconstructed.
-- fields holds allowlisted scalars only. migrateDiagnosticSchema runs after
-- migrateBannerSchema and before migrateDbChangeSchema so trg_db_change attaches.

CREATE TABLE IF NOT EXISTS diagnostic_event (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('server', 'client')),
  event text NOT NULL,
  fields jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS diagnostic_event_created_at_idx
  ON diagnostic_event (created_at DESC, id DESC);
