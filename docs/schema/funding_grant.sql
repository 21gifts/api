-- Funding-program grants: one row per account (pending / trial / admitted / rejected / withdrawn).
-- `withdrawn` is a member who left the program on their own (POST /funding/withdraw).
-- Applied by migrateFundingSchema / FUNDING_SCHEMA_SQL. The status check is dropped and
-- added again, so a table created before `withdrawn` existed gains it on the next boot.

CREATE TABLE IF NOT EXISTS funding_grant (
  account_id uuid PRIMARY KEY REFERENCES account (id),
  status text NOT NULL CHECK (status IN ('pending', 'trial', 'admitted', 'rejected', 'withdrawn')),
  applied_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by uuid REFERENCES account (id),
  trial_utc_date date,
  admitted_at timestamptz,
  note text
);
ALTER TABLE funding_grant DROP CONSTRAINT IF EXISTS funding_grant_status_check;
ALTER TABLE funding_grant ADD CONSTRAINT funding_grant_status_check
  CHECK (status IN ('pending', 'trial', 'admitted', 'rejected', 'withdrawn'));
