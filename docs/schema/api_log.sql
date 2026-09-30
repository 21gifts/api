-- HTTP request audit log. One row per request after the handler (except
-- OPTIONS and `/healthz`). Path is redacted (`/view/:viewKey`); no query
-- string, request body, Authorization, Cookie, or tokens. Validated client
-- fields are stored by the nullable columns added below. Covered by db_change
-- attach-all-public-tables when migrateApiLogSchema runs before migrateDbChangeSchema.

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
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS client_ip text;
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS client_country text;
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS cf_ray text;
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS accept_language text;
ALTER TABLE api_log ADD COLUMN IF NOT EXISTS origin text;
