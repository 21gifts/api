-- Operator login controls (GET/PUT /debug/logins, POST /debug/logins/allowlist,
-- DELETE /debug/logins/allowlist/:accountId).
-- `app_setting` holds small operator settings as text, one row per key. The
-- login switch is key `logins_open` with value `open` or `closed`; without that
-- row the switch is LOGINS_OPEN_DEFAULT. `login_allowlist` lists the accounts
-- that may still start a session while logins are closed; a row goes with its
-- account. Both tables are covered by `db_change`.

CREATE TABLE IF NOT EXISTS app_setting (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS login_allowlist (
  account_id uuid PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);
