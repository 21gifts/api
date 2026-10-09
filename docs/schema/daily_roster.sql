-- Daily payout roster owned by the API (not spend).
-- Applied by migrateDailyRosterSchema / DAILY_ROSTER_SCHEMA_SQL.
-- Singleton settings: no row means the document has never been written.
-- Recipients and moderators share daily_roster_entry; the same address may
-- appear in both buckets. Insertion order is serial id.

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
