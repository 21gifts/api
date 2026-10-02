import type { SqlClient } from '@/lib/auth/sql';
import type { Habit, HabitComment, HabitResult } from '@/lib/habit-tracker';

/** Durable habit history and a separate comment stream. */
export interface HabitStore {
  firstWeek(): Promise<string | null>;
  habits(): Promise<Habit[]>;
  results(week: string): Promise<HabitResult[]>;
  comments(week: string): Promise<HabitComment[]>;
  add(habit: Habit): Promise<void>;
  retire(id: string, accountId: string, week: string): Promise<void>;
  setResult(result: HabitResult): Promise<void>;
  comment(comment: HabitComment): Promise<void>;
}

/** Local development and test implementation. */
export class InMemoryHabitStore implements HabitStore {
  private readonly rows: Habit[] = [];
  private readonly outcomes = new Map<string, HabitResult>();
  private readonly posts: HabitComment[] = [];
  async firstWeek(): Promise<string | null> {
    return (
      [...this.rows.map((row) => row.firstWeek), ...this.posts.map((row) => row.week)].sort()[0] ??
      null
    );
  }
  async habits(): Promise<Habit[]> {
    return this.rows.map((row) => ({ ...row }));
  }
  async results(week: string): Promise<HabitResult[]> {
    return [...this.outcomes.values()]
      .filter((row) => row.week === week)
      .map((row) => ({ ...row }));
  }
  async comments(week: string): Promise<HabitComment[]> {
    return this.posts.filter((row) => row.week === week).map((row) => ({ ...row }));
  }
  async add(habit: Habit): Promise<void> {
    this.rows.push({ ...habit });
  }
  async retire(id: string, accountId: string, week: string): Promise<void> {
    const row = this.rows.find((habit) => habit.id === id && habit.accountId === accountId);
    if (row && row.lastWeek === null) row.lastWeek = week;
  }
  async setResult(result: HabitResult): Promise<void> {
    this.outcomes.set(`${result.habitId}/${result.week}`, { ...result });
  }
  async comment(comment: HabitComment): Promise<void> {
    this.posts.push({ ...comment });
  }
}

/** Idempotent schema; resolutions are archived, never deleted. */
export const HABIT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS habit (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
    role text NOT NULL CHECK (role IN ('founder', 'initiator')),
    name text NOT NULL, text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
    first_week text NOT NULL, last_week text,
    CHECK (last_week IS NULL OR last_week >= first_week)
  )`,
  `CREATE TABLE IF NOT EXISTS habit_result (
    habit_id uuid NOT NULL REFERENCES habit(id), week text NOT NULL,
    status text NOT NULL CHECK (status IN ('achieved', 'partial', 'missed')),
    PRIMARY KEY (habit_id, week)
  )`,
  `CREATE TABLE IF NOT EXISTS habit_comment (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES account(id),
    name text NOT NULL, text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    week text NOT NULL, created_at double precision NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS habit_result_week_idx ON habit_result (week)`,
  `CREATE INDEX IF NOT EXISTS habit_comment_week_idx ON habit_comment (week, created_at, id)`,
] as const;

/** Apply schema after the account table exists. */
export async function migrateHabitSchema(sql: SqlClient): Promise<void> {
  for (const statement of HABIT_SCHEMA_SQL) await sql.execute(statement);
}

/** Parameter-bound Postgres persistence. */
export class PostgresHabitStore implements HabitStore {
  constructor(private readonly sql: SqlClient) {}
  async firstWeek(): Promise<string | null> {
    const rows = await this.sql.query<{ week: string | null }>(
      `SELECT min(week) AS week FROM (SELECT first_week AS week FROM habit UNION ALL SELECT week FROM habit_comment) history`,
    );
    return rows[0]?.week ?? null;
  }
  async habits(): Promise<Habit[]> {
    return this.sql.query<Habit>(
      `SELECT id, account_id AS "accountId", role, name, text, first_week AS "firstWeek", last_week AS "lastWeek" FROM habit ORDER BY first_week, id`,
    );
  }
  async results(week: string): Promise<HabitResult[]> {
    return this.sql.query<HabitResult>(
      `SELECT habit_id AS "habitId", week, status FROM habit_result WHERE week = $1`,
      [week],
    );
  }
  async comments(week: string): Promise<HabitComment[]> {
    return this.sql.query<HabitComment>(
      `SELECT id, account_id AS "accountId", name, text, week, created_at AS "createdAt" FROM habit_comment WHERE week = $1 ORDER BY created_at, id`,
      [week],
    );
  }
  async add(habit: Habit): Promise<void> {
    await this.sql.execute(
      `INSERT INTO habit (id, account_id, role, name, text, first_week) VALUES ($1,$2,$3,$4,$5,$6)`,
      [habit.id, habit.accountId, habit.role, habit.name, habit.text, habit.firstWeek],
    );
  }
  async retire(id: string, accountId: string, week: string): Promise<void> {
    await this.sql.execute(
      `UPDATE habit SET last_week = $3 WHERE id = $1 AND account_id = $2 AND last_week IS NULL`,
      [id, accountId, week],
    );
  }
  async setResult(result: HabitResult): Promise<void> {
    await this.sql.execute(
      `INSERT INTO habit_result (habit_id, week, status) VALUES ($1,$2,$3) ON CONFLICT (habit_id, week) DO UPDATE SET status = EXCLUDED.status`,
      [result.habitId, result.week, result.status],
    );
  }
  async comment(comment: HabitComment): Promise<void> {
    await this.sql.execute(
      `INSERT INTO habit_comment (id, account_id, name, text, week, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [comment.id, comment.accountId, comment.name, comment.text, comment.week, comment.createdAt],
    );
  }
}
