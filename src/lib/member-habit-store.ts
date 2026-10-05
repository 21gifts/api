import { comparePeriod, dayKey, nextPeriod, weeklyRatableThrough } from '@/lib/member-habit';

/**
 * Cadence chosen at create time and never changed later.
 */
export type MemberHabitCadence = 'daily' | 'weekly';

/**
 * Outcome recorded for one habit period.
 */
export type MemberHabitStatus = 'achieved' | 'partial' | 'missed';

/**
 * Persisted habit row. `lastPeriod` is null while the habit is active.
 */
export type MemberHabit = {
  id: string;
  accountId: string;
  ownerName: string;
  role: string;
  name: string;
  description: string;
  notes: string;
  cadence: MemberHabitCadence;
  timeZone: string;
  firstPeriod: string;
  lastPeriod: string | null;
};

/**
 * Upserted status for `(habitId, period)`.
 */
export type MemberHabitLog = {
  habitId: string;
  period: string;
  status: MemberHabitStatus;
};

/**
 * Comment on a habit. Live when `deletedAt` is null.
 */
export type MemberHabitComment = {
  id: string;
  habitId: string;
  accountId: string;
  name: string;
  text: string;
  week: string;
  createdAt: number;
  deletedAt: number | null;
};

/**
 * Public name and description that apply from `period` onward until a later revision.
 */
export type MemberHabitRevision = {
  habitId: string;
  period: string;
  name: string;
  description: string;
};

type MemberHabitPeriodPublic = {
  period: string;
  name: string;
  description: string;
  logged: boolean;
  status: MemberHabitStatus | null;
};

/**
 * Public habit view. `notes` is present only when the viewer owns the habit.
 */
export type MemberHabitPublic = {
  id: string;
  accountId: string;
  ownerName: string;
  role: string;
  name: string;
  description: string;
  cadence: MemberHabitCadence;
  timeZone: string;
  firstPeriod: string;
  lastPeriod: string | null;
  periods: MemberHabitPeriodPublic[];
  comments: MemberHabitComment[];
  notes?: string;
};

type SqlClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type LightningAddresses = {
  get: (accountId: string) => Promise<string | null>;
  set: (accountId: string, address: string | null) => Promise<void>;
};

/**
 * Persistence for member habits, logs, comments, revisions, and Lightning addresses.
 */
export interface MemberHabitStore {
  add(habit: MemberHabit): Promise<void>;
  edit(
    id: string,
    accountId: string,
    patch: { name: string; description: string; notes: string },
    atPeriod: string,
  ): Promise<'ok' | 'missing'>;
  archive(id: string, accountId: string, lastPeriod: string): Promise<'ok' | 'missing'>;
  log(
    habitId: string,
    accountId: string,
    period: string,
    status: MemberHabitStatus,
  ): Promise<'ok' | 'missing' | 'closed'>;
  listPublic(viewerAccountId: string | null, nowMs: number): Promise<MemberHabitPublic[]>;
  findComment(id: string): Promise<MemberHabitComment | null>;
  comment(row: MemberHabitComment): Promise<void>;
  deleteComment(id: string): Promise<boolean>;
  setLightning(accountId: string, address: string | null): Promise<void>;
  lightning(accountId: string): Promise<string | null>;
}

/**
 * Idempotent `CREATE TABLE IF NOT EXISTS` statements for the member-habit tables.
 */
export const MEMBER_HABIT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS member_habit (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  owner_name text NOT NULL,
  role text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) <= 2000),
  notes text NOT NULL CHECK (char_length(notes) <= 2000),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  time_zone text NOT NULL,
  first_period text NOT NULL,
  last_period text NULL CHECK (last_period IS NULL OR last_period >= first_period)
);`,
  `CREATE TABLE IF NOT EXISTS member_habit_revision (
  habit_id uuid NOT NULL,
  period text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (habit_id, period)
);`,
  `CREATE TABLE IF NOT EXISTS member_habit_log (
  habit_id uuid NOT NULL,
  period text NOT NULL,
  status text NOT NULL CHECK (status IN ('achieved', 'partial', 'missed')),
  PRIMARY KEY (habit_id, period)
);`,
  `CREATE TABLE IF NOT EXISTS member_habit_comment (
  id uuid PRIMARY KEY,
  habit_id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  "text" text NOT NULL CHECK (char_length("text") BETWEEN 1 AND 2000),
  week text NOT NULL,
  created_at double precision NOT NULL,
  deleted_at double precision NULL
);`,
];

/**
 * Runs each `MEMBER_HABIT_SCHEMA_SQL` statement. Safe to call more than once.
 *
 * @param sql - SQL client whose `query` returns `{ rows }`.
 * @returns Resolves when every statement has executed.
 */
export async function migrateMemberHabitSchema(sql: SqlClient): Promise<void> {
  for (const statement of MEMBER_HABIT_SCHEMA_SQL) {
    await sql.query(statement);
  }
}

function cloneHabit(habit: MemberHabit): MemberHabit {
  return {
    id: habit.id,
    accountId: habit.accountId,
    ownerName: habit.ownerName,
    role: habit.role,
    name: habit.name,
    description: habit.description,
    notes: habit.notes,
    cadence: habit.cadence,
    timeZone: habit.timeZone,
    firstPeriod: habit.firstPeriod,
    lastPeriod: habit.lastPeriod,
  };
}

function cloneComment(row: MemberHabitComment): MemberHabitComment {
  return {
    id: row.id,
    habitId: row.habitId,
    accountId: row.accountId,
    name: row.name,
    text: row.text,
    week: row.week,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function latestRatableKey(habit: MemberHabit, nowMs: number): string {
  if (habit.cadence === 'daily') {
    return dayKey(nowMs, habit.timeZone);
  }
  return weeklyRatableThrough(nowMs, habit.timeZone);
}

function periodRangeEnd(habit: MemberHabit, nowMs: number): string {
  const latest = latestRatableKey(habit, nowMs);
  if (habit.lastPeriod !== null && comparePeriod(habit.lastPeriod, latest) < 0) {
    return habit.lastPeriod;
  }
  return latest;
}

function revisionForPeriod(revisions: MemberHabitRevision[], key: string): MemberHabitRevision {
  const sorted = [...revisions].sort((a, b) => comparePeriod(a.period, b.period));
  let match: MemberHabitRevision | null = null;
  for (const revision of sorted) {
    if (comparePeriod(revision.period, key) <= 0) {
      match = revision;
    }
  }
  if (match === null) {
    throw new Error(`no revision covering period ${key}`);
  }
  return match;
}

function buildPeriods(
  habit: MemberHabit,
  revisions: MemberHabitRevision[],
  logs: Map<string, MemberHabitStatus>,
  nowMs: number,
): MemberHabitPeriodPublic[] {
  const end = periodRangeEnd(habit, nowMs);
  if (comparePeriod(habit.firstPeriod, end) > 0) {
    return [];
  }
  const periods: MemberHabitPeriodPublic[] = [];
  let key = habit.firstPeriod;
  while (comparePeriod(key, end) <= 0) {
    const revision = revisionForPeriod(revisions, key);
    const status = logs.get(key);
    if (status === undefined) {
      periods.push({
        period: key,
        name: revision.name,
        description: revision.description,
        logged: false,
        status: null,
      });
    } else {
      periods.push({
        period: key,
        name: revision.name,
        description: revision.description,
        logged: true,
        status,
      });
    }
    key = nextPeriod(key, habit.cadence);
  }
  return periods;
}

function toPublic(
  habit: MemberHabit,
  periods: MemberHabitPeriodPublic[],
  comments: MemberHabitComment[],
  viewerAccountId: string | null,
): MemberHabitPublic {
  const base: MemberHabitPublic = {
    id: habit.id,
    accountId: habit.accountId,
    ownerName: habit.ownerName,
    role: habit.role,
    name: habit.name,
    description: habit.description,
    cadence: habit.cadence,
    timeZone: habit.timeZone,
    firstPeriod: habit.firstPeriod,
    lastPeriod: habit.lastPeriod,
    periods,
    comments: comments.map(cloneComment),
  };
  if (viewerAccountId !== null && viewerAccountId === habit.accountId) {
    return { ...base, notes: habit.notes };
  }
  return base;
}

function sortLiveComments(comments: MemberHabitComment[]): MemberHabitComment[] {
  return [...comments].sort((a, b) => {
    if (a.createdAt < b.createdAt) {
      return -1;
    }
    if (a.createdAt > b.createdAt) {
      return 1;
    }
    if (a.id < b.id) {
      return -1;
    }
    /* v8 ignore next 3 -- two comments in the map cannot share createdAt and id */
    if (a.id === b.id) {
      return 0;
    }
    return 1;
  });
}

function logClosed(habit: MemberHabit, period: string): boolean {
  if (comparePeriod(period, habit.firstPeriod) < 0) {
    return true;
  }
  if (habit.lastPeriod !== null && comparePeriod(period, habit.lastPeriod) > 0) {
    return true;
  }
  return false;
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`expected string column ${key}`);
  }
  return value;
}

function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`expected string or null column ${key}`);
  }
  return value;
}

function numberColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new Error(`expected number column ${key}`);
  }
  return value;
}

function nullableNumberColumn(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw new Error(`expected number or null column ${key}`);
  }
  return value;
}

function asCadence(value: string): MemberHabitCadence {
  if (value === 'daily' || value === 'weekly') {
    return value;
  }
  throw new Error(`invalid cadence: ${value}`);
}

function asStatus(value: string): MemberHabitStatus {
  if (value === 'achieved' || value === 'partial' || value === 'missed') {
    return value;
  }
  throw new Error(`invalid status: ${value}`);
}

function habitFromRow(row: Record<string, unknown>): MemberHabit {
  return {
    id: stringColumn(row, 'id'),
    accountId: stringColumn(row, 'account_id'),
    ownerName: stringColumn(row, 'owner_name'),
    role: stringColumn(row, 'role'),
    name: stringColumn(row, 'name'),
    description: stringColumn(row, 'description'),
    notes: stringColumn(row, 'notes'),
    cadence: asCadence(stringColumn(row, 'cadence')),
    timeZone: stringColumn(row, 'time_zone'),
    firstPeriod: stringColumn(row, 'first_period'),
    lastPeriod: nullableStringColumn(row, 'last_period'),
  };
}

function revisionFromRow(row: Record<string, unknown>): MemberHabitRevision {
  return {
    habitId: stringColumn(row, 'habit_id'),
    period: stringColumn(row, 'period'),
    name: stringColumn(row, 'name'),
    description: stringColumn(row, 'description'),
  };
}

function commentFromRow(row: Record<string, unknown>): MemberHabitComment {
  return {
    id: stringColumn(row, 'id'),
    habitId: stringColumn(row, 'habit_id'),
    accountId: stringColumn(row, 'account_id'),
    name: stringColumn(row, 'name'),
    text: stringColumn(row, 'text'),
    week: stringColumn(row, 'week'),
    createdAt: numberColumn(row, 'created_at'),
    deletedAt: nullableNumberColumn(row, 'deleted_at'),
  };
}

function firstRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return row;
}

function pushByKey<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
    return;
  }
  existing.push(value);
}

/**
 * In-process `MemberHabitStore`. Insertion order is list order.
 */
export class InMemoryMemberHabitStore implements MemberHabitStore {
  private readonly habits = new Map<string, MemberHabit>();
  private readonly revisions = new Map<string, MemberHabitRevision[]>();
  private readonly logs = new Map<string, Map<string, MemberHabitStatus>>();
  private readonly comments = new Map<string, MemberHabitComment>();
  private readonly lightningByAccount = new Map<string, string>();

  async add(habit: MemberHabit): Promise<void> {
    const stored = cloneHabit(habit);
    this.habits.set(stored.id, stored);
    this.revisions.set(stored.id, [
      {
        habitId: stored.id,
        period: stored.firstPeriod,
        name: stored.name,
        description: stored.description,
      },
    ]);
  }

  async edit(
    id: string,
    accountId: string,
    patch: { name: string; description: string; notes: string },
    atPeriod: string,
  ): Promise<'ok' | 'missing'> {
    const habit = this.habits.get(id);
    if (habit === undefined || habit.accountId !== accountId) {
      return 'missing';
    }
    habit.notes = patch.notes;
    if (habit.name !== patch.name || habit.description !== patch.description) {
      habit.name = patch.name;
      habit.description = patch.description;
    }
    const list = this.revisions.get(id);
    /* v8 ignore next 3 -- add() always inserts the revision list */
    if (list === undefined) {
      throw new Error(`missing revisions for habit ${id}`);
    }
    const next: MemberHabitRevision = {
      habitId: id,
      period: atPeriod,
      name: patch.name,
      description: patch.description,
    };
    const index = list.findIndex((revision) => revision.period === atPeriod);
    if (index === -1) {
      list.push(next);
    } else {
      list[index] = next;
    }
    return 'ok';
  }

  async archive(id: string, accountId: string, lastPeriod: string): Promise<'ok' | 'missing'> {
    const habit = this.habits.get(id);
    if (habit === undefined || habit.accountId !== accountId) {
      return 'missing';
    }
    if (habit.lastPeriod !== null) {
      return 'ok';
    }
    habit.lastPeriod = lastPeriod;
    return 'ok';
  }

  async log(
    habitId: string,
    accountId: string,
    period: string,
    status: MemberHabitStatus,
  ): Promise<'ok' | 'missing' | 'closed'> {
    const habit = this.habits.get(habitId);
    if (habit === undefined || habit.accountId !== accountId) {
      return 'missing';
    }
    if (logClosed(habit, period)) {
      return 'closed';
    }
    let byPeriod = this.logs.get(habitId);
    if (byPeriod === undefined) {
      byPeriod = new Map<string, MemberHabitStatus>();
      this.logs.set(habitId, byPeriod);
    }
    byPeriod.set(period, status);
    return 'ok';
  }

  async listPublic(viewerAccountId: string | null, nowMs: number): Promise<MemberHabitPublic[]> {
    const result: MemberHabitPublic[] = [];
    for (const habit of this.habits.values()) {
      const revisions = this.revisions.get(habit.id);
      /* v8 ignore next 3 -- add() always inserts the revision list */
      if (revisions === undefined) {
        throw new Error(`missing revisions for habit ${habit.id}`);
      }
      const logs = this.logs.get(habit.id);
      const logMap = logs === undefined ? new Map<string, MemberHabitStatus>() : logs;
      const comments: MemberHabitComment[] = [];
      for (const row of this.comments.values()) {
        if (row.habitId === habit.id && row.deletedAt === null) {
          comments.push(row);
        }
      }
      result.push(
        toPublic(
          habit,
          buildPeriods(habit, revisions, logMap, nowMs),
          sortLiveComments(comments),
          viewerAccountId,
        ),
      );
    }
    return result;
  }

  async findComment(id: string): Promise<MemberHabitComment | null> {
    const row = this.comments.get(id);
    if (row === undefined || row.deletedAt !== null) {
      return null;
    }
    return cloneComment(row);
  }

  async comment(row: MemberHabitComment): Promise<void> {
    this.comments.set(row.id, cloneComment(row));
  }

  async deleteComment(id: string): Promise<boolean> {
    const row = this.comments.get(id);
    if (row === undefined || row.deletedAt !== null) {
      return false;
    }
    row.deletedAt = Date.now();
    return true;
  }

  async setLightning(accountId: string, address: string | null): Promise<void> {
    if (address === null) {
      this.lightningByAccount.delete(accountId);
      return;
    }
    this.lightningByAccount.set(accountId, address);
  }

  async lightning(accountId: string): Promise<string | null> {
    const address = this.lightningByAccount.get(accountId);
    if (address === undefined) {
      return null;
    }
    return address;
  }
}

/**
 * Postgres `MemberHabitStore`. Lightning addresses are stored via `addresses`.
 */
export class PostgresMemberHabitStore implements MemberHabitStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly addresses: LightningAddresses,
  ) {}

  async add(habit: MemberHabit): Promise<void> {
    await this.sql.query(
      `INSERT INTO member_habit (
         id, account_id, owner_name, role, name, description, notes,
         cadence, time_zone, first_period, last_period
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        habit.id,
        habit.accountId,
        habit.ownerName,
        habit.role,
        habit.name,
        habit.description,
        habit.notes,
        habit.cadence,
        habit.timeZone,
        habit.firstPeriod,
        habit.lastPeriod,
      ],
    );
    await this.sql.query(
      `INSERT INTO member_habit_revision (habit_id, period, name, description)
       VALUES ($1, $2, $3, $4)`,
      [habit.id, habit.firstPeriod, habit.name, habit.description],
    );
  }

  async edit(
    id: string,
    accountId: string,
    patch: { name: string; description: string; notes: string },
    atPeriod: string,
  ): Promise<'ok' | 'missing'> {
    const habit = await this.ownedHabit(id, accountId);
    if (habit === null) {
      return 'missing';
    }
    await this.sql.query(
      `UPDATE member_habit SET name = $1, description = $2, notes = $3 WHERE id = $4`,
      [patch.name, patch.description, patch.notes, id],
    );
    await this.sql.query(
      `INSERT INTO member_habit_revision (habit_id, period, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (habit_id, period) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description`,
      [id, atPeriod, patch.name, patch.description],
    );
    return 'ok';
  }

  async archive(id: string, accountId: string, lastPeriod: string): Promise<'ok' | 'missing'> {
    const habit = await this.ownedHabit(id, accountId);
    if (habit === null) {
      return 'missing';
    }
    if (habit.lastPeriod !== null) {
      return 'ok';
    }
    await this.sql.query(`UPDATE member_habit SET last_period = $1 WHERE id = $2`, [
      lastPeriod,
      id,
    ]);
    return 'ok';
  }

  async log(
    habitId: string,
    accountId: string,
    period: string,
    status: MemberHabitStatus,
  ): Promise<'ok' | 'missing' | 'closed'> {
    const habit = await this.ownedHabit(habitId, accountId);
    if (habit === null) {
      return 'missing';
    }
    if (logClosed(habit, period)) {
      return 'closed';
    }
    await this.sql.query(
      `INSERT INTO member_habit_log (habit_id, period, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (habit_id, period) DO UPDATE SET status = EXCLUDED.status`,
      [habitId, period, status],
    );
    return 'ok';
  }

  async listPublic(viewerAccountId: string | null, nowMs: number): Promise<MemberHabitPublic[]> {
    const habitResult = await this.sql.query(
      `SELECT id, account_id, owner_name, role, name, description, notes,
              cadence, time_zone, first_period, last_period
       FROM member_habit
       ORDER BY first_period ASC, id ASC`,
    );
    const revisionResult = await this.sql.query(
      `SELECT habit_id, period, name, description FROM member_habit_revision`,
    );
    const logResult = await this.sql.query(`SELECT habit_id, period, status FROM member_habit_log`);
    const commentResult = await this.sql.query(
      `SELECT id, habit_id, account_id, name, "text", week, created_at, deleted_at
       FROM member_habit_comment
       WHERE deleted_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    );
    const revisionsByHabit = new Map<string, MemberHabitRevision[]>();
    for (const row of revisionResult.rows) {
      const revision = revisionFromRow(row);
      pushByKey(revisionsByHabit, revision.habitId, revision);
    }
    const logsByHabit = new Map<string, Map<string, MemberHabitStatus>>();
    for (const row of logResult.rows) {
      const habitId = stringColumn(row, 'habit_id');
      const period = stringColumn(row, 'period');
      const status = asStatus(stringColumn(row, 'status'));
      let byPeriod = logsByHabit.get(habitId);
      if (byPeriod === undefined) {
        byPeriod = new Map<string, MemberHabitStatus>();
        logsByHabit.set(habitId, byPeriod);
      }
      byPeriod.set(period, status);
    }
    const commentsByHabit = new Map<string, MemberHabitComment[]>();
    for (const row of commentResult.rows) {
      const comment = commentFromRow(row);
      pushByKey(commentsByHabit, comment.habitId, comment);
    }
    const result: MemberHabitPublic[] = [];
    for (const row of habitResult.rows) {
      const habit = habitFromRow(row);
      const revisions = revisionsByHabit.get(habit.id);
      if (revisions === undefined) {
        throw new Error(`missing revisions for habit ${habit.id}`);
      }
      const logs = logsByHabit.get(habit.id);
      const logMap = logs === undefined ? new Map<string, MemberHabitStatus>() : logs;
      const comments = commentsByHabit.get(habit.id);
      const live = comments === undefined ? [] : sortLiveComments(comments);
      result.push(
        toPublic(habit, buildPeriods(habit, revisions, logMap, nowMs), live, viewerAccountId),
      );
    }
    return result;
  }

  async findComment(id: string): Promise<MemberHabitComment | null> {
    const result = await this.sql.query(
      `SELECT id, habit_id, account_id, name, "text", week, created_at, deleted_at
       FROM member_habit_comment
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const row = firstRow(result.rows);
    if (row === null) {
      return null;
    }
    return commentFromRow(row);
  }

  async comment(row: MemberHabitComment): Promise<void> {
    await this.sql.query(
      `INSERT INTO member_habit_comment (
         id, habit_id, account_id, name, "text", week, created_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        row.habitId,
        row.accountId,
        row.name,
        row.text,
        row.week,
        row.createdAt,
        row.deletedAt,
      ],
    );
  }

  async deleteComment(id: string): Promise<boolean> {
    const result = await this.sql.query(
      `SELECT deleted_at FROM member_habit_comment WHERE id = $1`,
      [id],
    );
    const row = firstRow(result.rows);
    if (row === null) {
      return false;
    }
    if (nullableNumberColumn(row, 'deleted_at') !== null) {
      return false;
    }
    await this.sql.query(
      `UPDATE member_habit_comment SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
      [Date.now(), id],
    );
    return true;
  }

  async setLightning(accountId: string, address: string | null): Promise<void> {
    await this.addresses.set(accountId, address);
  }

  async lightning(accountId: string): Promise<string | null> {
    return this.addresses.get(accountId);
  }

  private async ownedHabit(id: string, accountId: string): Promise<MemberHabit | null> {
    const result = await this.sql.query(
      `SELECT id, account_id, owner_name, role, name, description, notes,
              cadence, time_zone, first_period, last_period
       FROM member_habit
       WHERE id = $1`,
      [id],
    );
    const row = firstRow(result.rows);
    if (row === null) {
      return null;
    }
    const habit = habitFromRow(row);
    if (habit.accountId !== accountId) {
      return null;
    }
    return habit;
  }
}
