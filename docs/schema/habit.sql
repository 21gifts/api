-- Habit-Tracker durable history; mirrored by HABIT_SCHEMA_SQL.

CREATE TABLE IF NOT EXISTS habit (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
    role text NOT NULL CHECK (role IN ('founder', 'initiator')),
    name text NOT NULL, text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
    first_week text NOT NULL, last_week text,
    CHECK (last_week IS NULL OR last_week >= first_week)
  );

CREATE TABLE IF NOT EXISTS habit_result (
    habit_id uuid NOT NULL REFERENCES habit(id), week text NOT NULL,
    status text NOT NULL CHECK (status IN ('achieved', 'partial', 'missed')),
    PRIMARY KEY (habit_id, week)
  );

CREATE TABLE IF NOT EXISTS habit_comment (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
    name text NOT NULL, text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    week text NOT NULL, created_at double precision NOT NULL
  );

CREATE INDEX IF NOT EXISTS habit_result_week_idx ON habit_result (week);

CREATE INDEX IF NOT EXISTS habit_comment_week_idx ON habit_comment (week, created_at, id);
