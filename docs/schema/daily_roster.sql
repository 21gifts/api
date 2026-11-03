-- Daily payout roster owned by the API (not spend).
-- Applied by migrateDailyRosterSchema / DAILY_ROSTER_SCHEMA_SQL.
-- Singleton settings: no row means the document has never been written.
-- Recipients and moderators share daily_roster_entry; the same account may
-- appear in both buckets. Insertion order is serial id. A row is listed and
-- paid only with an account_id; its payout address is resolved from the
-- account when it is paid, never stored. address is the legacy address of a
-- row from before accounts (linked by linkDailyRosterAccounts); a row whose
-- address matches no account keeps a null account_id and is never paid.

CREATE TABLE IF NOT EXISTS daily_roster (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  comment text NOT NULL,
  payments_enabled boolean NOT NULL,
  moderator_payments_enabled boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_roster_entry (
  id serial PRIMARY KEY,
  address text NOT NULL,
  amount_usd double precision NOT NULL CHECK (amount_usd > 0),
  bucket text NOT NULL CHECK (bucket IN ('daily', 'moderator')),
  UNIQUE (address, bucket)
);

ALTER TABLE daily_roster_entry ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES account (id);
ALTER TABLE daily_roster_entry ALTER COLUMN address DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daily_roster_entry_account_bucket_uidx
  ON daily_roster_entry (account_id, bucket);
