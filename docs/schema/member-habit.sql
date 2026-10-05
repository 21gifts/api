-- Mirrors MEMBER_HABIT_SCHEMA_SQL.
CREATE TABLE IF NOT EXISTS member_habit (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES account (id),
  owner_name text NOT NULL,
  role text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) <= 2000),
  notes text NOT NULL CHECK (char_length(notes) <= 2000),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  time_zone text NOT NULL,
  first_period text NOT NULL,
  last_period text NULL CHECK (last_period IS NULL OR last_period >= first_period)
);

CREATE TABLE IF NOT EXISTS member_habit_revision (
  habit_id uuid NOT NULL REFERENCES member_habit (id),
  period text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (habit_id, period)
);

CREATE TABLE IF NOT EXISTS member_habit_log (
  habit_id uuid NOT NULL REFERENCES member_habit (id),
  period text NOT NULL,
  status text NOT NULL CHECK (status IN ('achieved', 'partial', 'missed')),
  PRIMARY KEY (habit_id, period)
);

CREATE TABLE IF NOT EXISTS member_habit_comment (
  id uuid PRIMARY KEY,
  habit_id uuid NOT NULL REFERENCES member_habit (id),
  account_id uuid NOT NULL REFERENCES account (id),
  name text NOT NULL,
  "text" text NOT NULL CHECK (char_length("text") BETWEEN 1 AND 2000),
  week text NOT NULL,
  created_at double precision NOT NULL,
  deleted_at double precision NULL
);
