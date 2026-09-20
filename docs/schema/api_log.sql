-- HTTP request audit log. One row per request after the handler (except
-- OPTIONS and `/healthz`). Path is redacted (`/view/:viewKey`); no query
-- string, Authorization, or bodies. Covered by db_change attach-all-public-tables
-- when migrateApiLogSchema runs before migrateDbChangeSchema.

CREATE TABLE IF NOT EXISTS api_log (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  ms integer NOT NULL,
  account_id uuid REFERENCES account (id),
  auth_kind text NOT NULL CHECK (auth_kind IN ('session', 'debug', 'spend', 'none'))
);
CREATE INDEX IF NOT EXISTS api_log_created_at_idx ON api_log (created_at DESC, id DESC);
