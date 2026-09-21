-- Funding-program grants: one row per account (pending / trial / admitted / rejected).
-- Applied by migrateFundingSchema / FUNDING_SCHEMA_SQL.

CREATE TABLE IF NOT EXISTS funding_grant (
  account_id uuid PRIMARY KEY REFERENCES account (id),
  status text NOT NULL CHECK (status IN ('pending', 'trial', 'admitted', 'rejected')),
  applied_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by uuid REFERENCES account (id),
  trial_utc_date date,
  admitted_at timestamptz,
  note text
);
