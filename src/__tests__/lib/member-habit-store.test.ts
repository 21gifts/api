import { describe, expect, it } from 'vitest';
import {
  InMemoryMemberHabitStore,
  MEMBER_HABIT_SCHEMA_SQL,
  migrateMemberHabitSchema,
  PostgresMemberHabitStore,
  type MemberHabit,
} from '@/lib/member-habit-store';

function sampleHabit(): MemberHabit {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    accountId: '22222222-2222-2222-2222-222222222222',
    ownerName: 'Ada',
    role: 'initiator',
    name: 'Walk',
    description: 'Walk outside',
    notes: 'keep a secret',
    cadence: 'daily',
    timeZone: 'Asia/Manila',
    firstPeriod: '2026-10-01',
    lastPeriod: null,
  };
}

/** 2026-10-05 12:00 in Asia/Manila. */
const nowMs = Date.parse('2026-10-05T04:00:00.000Z');

function comment(
  patch: Partial<{
    id: string;
    habitId: string;
    createdAt: number;
  }>,
): {
  id: string;
  habitId: string;
  accountId: string;
  name: string;
  text: string;
  week: string;
  createdAt: number;
  deletedAt: null;
} {
  return {
    id: patch.id ?? '33333333-3333-3333-3333-333333333333',
    habitId: patch.habitId ?? '11111111-1111-1111-1111-111111111111',
    accountId: '44444444-4444-4444-4444-444444444444',
    name: 'Bob',
    text: 'nice',
    week: '2026-09-28',
    createdAt: patch.createdAt ?? 1,
    deletedAt: null,
  };
}

type Row = Record<string, unknown>;

function habitRow(patch: Row = {}): Row {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    account_id: '22222222-2222-2222-2222-222222222222',
    owner_name: 'Ada',
    role: 'initiator',
    name: 'Walk',
    description: 'Walk outside',
    notes: 'keep a secret',
    cadence: 'daily',
    time_zone: 'Asia/Manila',
    first_period: '2026-10-01',
    last_period: null,
    ...patch,
  };
}

function revisionRow(patch: Row = {}): Row {
  return {
    habit_id: '11111111-1111-1111-1111-111111111111',
    period: '2026-10-01',
    name: 'Walk',
    description: 'Walk outside',
    ...patch,
  };
}

function scriptedSql(initial: { habits: Row[]; revisions: Row[]; logs: Row[]; comments: Row[] }) {
  const state = {
    habits: initial.habits.map((row) => ({ ...row })),
    revisions: initial.revisions.map((row) => ({ ...row })),
    logs: initial.logs.map((row) => ({ ...row })),
    comments: initial.comments.map((row) => ({ ...row })),
  };
  const sql = {
    query: async (text: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
      if (text.includes('member_habit_comment')) {
        if (text.includes('INSERT')) {
          state.comments.push({
            id: params[0],
            habit_id: params[1],
            account_id: params[2],
            name: params[3],
            text: params[4],
            week: params[5],
            created_at: params[6],
            deleted_at: params[7],
          });
          return { rows: [] };
        }
        if (text.includes('UPDATE')) {
          const found = state.comments.find((row) => row['id'] === params[1]);
          if (found !== undefined) {
            found['deleted_at'] = params[0];
          }
          return { rows: [] };
        }
        if (text.includes('SELECT deleted_at')) {
          const found = state.comments.find((row) => row['id'] === params[0]);
          return { rows: found === undefined ? [] : [{ deleted_at: found['deleted_at'] }] };
        }
        if (text.includes('WHERE id = $1')) {
          const found = state.comments.find(
            (row) => row['id'] === params[0] && row['deleted_at'] === null,
          );
          return { rows: found === undefined ? [] : [found] };
        }
        return { rows: state.comments.filter((row) => row['deleted_at'] === null) };
      }
      if (text.includes('member_habit_revision')) {
        if (text.includes('UPDATE member_habit')) {
          const found = state.habits.find(
            (row) => row['id'] === params[3] && row['account_id'] === params[4],
          );
          if (found === undefined) {
            return { rows: [] };
          }
          found['name'] = params[0];
          found['description'] = params[1];
          found['notes'] = params[2];
          const period = params[5];
          const existing = state.revisions.find(
            (row) => row['habit_id'] === params[3] && row['period'] === period,
          );
          if (existing === undefined) {
            state.revisions.push({
              habit_id: params[3],
              period,
              name: params[0],
              description: params[1],
            });
          } else {
            existing['name'] = params[0];
            existing['description'] = params[1];
          }
          return { rows: [{ habit_id: params[3] }] };
        }
        if (text.includes('INSERT INTO member_habit (')) {
          return { rows: [] };
        }
        if (text.includes('INSERT')) {
          state.revisions.push({
            habit_id: params[0],
            period: params[1],
            name: params[2],
            description: params[3],
          });
          return { rows: [] };
        }
        return { rows: state.revisions };
      }
      if (text.includes('member_habit_log')) {
        if (text.includes('INSERT')) {
          state.logs.push({ habit_id: params[0], period: params[1], status: params[2] });
          return { rows: [] };
        }
        return { rows: state.logs };
      }
      if (text.includes('member_habit')) {
        if (text.includes('INSERT')) {
          return { rows: [] };
        }
        if (text.includes('UPDATE') && text.includes('last_period')) {
          const found = state.habits.find((row) => row['id'] === params[1]);
          if (found !== undefined) {
            found['last_period'] = params[0];
          }
          return { rows: [] };
        }
        if (text.includes('UPDATE')) {
          const found = state.habits.find((row) => row['id'] === params[3]);
          if (found !== undefined) {
            found['name'] = params[0];
            found['description'] = params[1];
            found['notes'] = params[2];
          }
          return { rows: [] };
        }
        if (text.includes('WHERE id = $1')) {
          const found = state.habits.find((row) => row['id'] === params[0]);
          return { rows: found === undefined ? [] : [found] };
        }
        return { rows: state.habits };
      }
      return { rows: [] };
    },
  };
  return sql;
}

function addressesOf(initial: string | null) {
  let stored = initial;
  return {
    get: async (): Promise<string | null> => stored,
    set: async (_accountId: string, address: string | null): Promise<void> => {
      stored = address;
    },
  };
}

describe('InMemoryMemberHabitStore', () => {
  it('omits notes for another viewer and includes them for the owner', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    await store.comment({
      id: '33333333-3333-3333-3333-333333333333',
      habitId: habit.id,
      accountId: '44444444-4444-4444-4444-444444444444',
      name: 'Bob',
      text: 'nice',
      week: '2026-09-28',
      createdAt: 1,
      deletedAt: null,
    });

    const ownerView = await store.listPublic(habit.accountId, nowMs);
    const owner = ownerView[0];
    expect(owner?.notes).toBe('keep a secret');
    expect(owner?.comments).toEqual([
      {
        id: '33333333-3333-3333-3333-333333333333',
        habitId: habit.id,
        accountId: '44444444-4444-4444-4444-444444444444',
        name: 'Bob',
        text: 'nice',
        week: '2026-09-28',
        createdAt: 1,
        deletedAt: null,
      },
    ]);

    const otherView = await store.listPublic('55555555-5555-5555-5555-555555555555', nowMs);
    const other = otherView[0];
    expect(other !== undefined && !('notes' in other)).toBe(true);

    const anonView = await store.listPublic(null, nowMs);
    const anon = anonView[0];
    expect(anon !== undefined && !('notes' in anon)).toBe(true);
  });

  it('shows revision text on an older period and the new text from atPeriod', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    const edited = await store.edit(
      habit.id,
      habit.accountId,
      { name: 'Run', description: 'Run outside', notes: 'keep a secret' },
      '2026-10-03',
    );
    expect(edited).toBe('ok');

    const view = await store.listPublic(habit.accountId, nowMs);
    const listed = view[0];
    expect(listed?.name).toBe('Run');
    expect(listed?.description).toBe('Run outside');
    const older = listed?.periods.find((period) => period.period === '2026-10-01');
    const fromEdit = listed?.periods.find((period) => period.period === '2026-10-03');
    expect(older).toEqual({
      period: '2026-10-01',
      name: 'Walk',
      description: 'Walk outside',
      logged: false,
      status: null,
    });
    expect(fromEdit).toEqual({
      period: '2026-10-03',
      name: 'Run',
      description: 'Run outside',
      logged: false,
      status: null,
    });
  });

  it('blocks a later log after archive and leaves lastPeriod unchanged on a second archive', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    expect(await store.archive(habit.id, habit.accountId, '2026-10-03')).toBe('ok');
    expect(await store.log(habit.id, habit.accountId, '2026-10-03', 'achieved')).toBe('ok');
    expect(await store.log(habit.id, habit.accountId, '2026-10-04', 'partial')).toBe('closed');
    expect(await store.log(habit.id, habit.accountId, '2026-09-30', 'missed')).toBe('closed');
    expect(await store.archive(habit.id, habit.accountId, '2026-10-10')).toBe('ok');
    expect(await store.log(habit.id, habit.accountId, '2026-10-04', 'missed')).toBe('closed');

    const view = await store.listPublic(habit.accountId, nowMs);
    const listed = view[0];
    if (listed === undefined) {
      throw new Error('expected archived habit in listPublic');
    }
    const periods = listed.periods.map((period) => period.period);
    expect(periods[periods.length - 1]).toBe('2026-10-03');
    expect(periods).not.toContain('2026-10-04');
    const logged = listed.periods.find((period) => period.period === '2026-10-03');
    expect(logged?.logged).toBe(true);
    expect(logged?.status).toBe('achieved');
  });

  it('returns missing when a non-owner edits', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    expect(
      await store.edit(
        habit.id,
        '55555555-5555-5555-5555-555555555555',
        { name: 'Other', description: 'nope', notes: 'stolen' },
        '2026-10-01',
      ),
    ).toBe('missing');
    expect(
      await store.edit(
        '66666666-6666-6666-6666-666666666666',
        habit.accountId,
        { name: 'Ghost', description: 'gone', notes: '' },
        '2026-10-01',
      ),
    ).toBe('missing');
    const view = await store.listPublic(habit.accountId, nowMs);
    expect(view[0]?.name).toBe('Walk');
    expect(view[0]?.notes).toBe('keep a secret');
  });

  it('sorts comments by createdAt and then by id in both directions', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    await store.comment(comment({ id: 'm', createdAt: 2, habitId: habit.id }));
    await store.comment(comment({ id: 'a', createdAt: 1, habitId: habit.id }));
    await store.comment(comment({ id: 'c', createdAt: 2, habitId: habit.id }));
    const forward = await store.listPublic(null, nowMs);
    expect(forward[0]?.comments.map((row) => row.id)).toEqual(['a', 'c', 'm']);

    const reverse = new InMemoryMemberHabitStore();
    await reverse.add(habit);
    await reverse.comment(comment({ id: 'a', createdAt: 1, habitId: habit.id }));
    await reverse.comment(comment({ id: 'm', createdAt: 5, habitId: habit.id }));
    await reverse.comment(comment({ id: 'b', createdAt: 5, habitId: habit.id }));
    const backward = await reverse.listPublic(null, nowMs);
    expect(backward[0]?.comments.map((row) => row.id)).toEqual(['a', 'b', 'm']);

    const largerSecond = new InMemoryMemberHabitStore();
    await largerSecond.add(habit);
    await largerSecond.comment(comment({ id: 'b', createdAt: 5, habitId: habit.id }));
    await largerSecond.comment(comment({ id: 'm', createdAt: 5, habitId: habit.id }));
    const greaterId = await largerSecond.listPublic(null, nowMs);
    expect(greaterId[0]?.comments.map((row) => row.id)).toEqual(['b', 'm']);
  });

  it('replaces a revision when the same period is edited twice', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    await store.edit(
      habit.id,
      habit.accountId,
      { name: 'A', description: 'd', notes: 'n' },
      '2026-10-05',
    );
    expect(
      await store.edit(
        habit.id,
        habit.accountId,
        { name: 'B', description: 'e', notes: 'n2' },
        '2026-10-05',
      ),
    ).toBe('ok');
    const view = await store.listPublic(habit.accountId, nowMs);
    expect(view[0]?.name).toBe('B');
    expect(view[0]?.notes).toBe('n2');
    expect(
      await store.edit(
        habit.id,
        habit.accountId,
        { name: 'B', description: 'only description', notes: 'n3' },
        '2026-10-06',
      ),
    ).toBe('ok');
    expect(
      await store.edit(
        habit.id,
        habit.accountId,
        { name: 'B', description: 'only description', notes: 'n4' },
        '2026-10-06',
      ),
    ).toBe('ok');
    const revised = await store.listPublic(habit.accountId, nowMs);
    expect(revised[0]?.name).toBe('B');
    expect(revised[0]?.description).toBe('only description');
    expect(revised[0]?.notes).toBe('n4');
  });

  it('archive and log of an unknown id or another owner are missing', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    expect(await store.archive('missing', habit.accountId, '2026-10-01')).toBe('missing');
    expect(await store.archive(habit.id, 'other', '2026-10-01')).toBe('missing');
    expect(await store.log('missing', habit.accountId, '2026-10-01', 'achieved')).toBe('missing');
    expect(await store.log(habit.id, 'other', '2026-10-01', 'achieved')).toBe('missing');
  });

  it('lists a weekly habit and an empty range when lastPeriod is before firstPeriod', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add({
      ...sampleHabit(),
      id: 'weekly',
      cadence: 'weekly',
      firstPeriod: '2026-09-28',
    });
    await store.add({
      ...sampleHabit(),
      id: 'empty',
      firstPeriod: '2026-10-08',
      lastPeriod: '2026-10-01',
    });
    const view = await store.listPublic(null, nowMs);
    const weekly = view.find((row) => row.id === 'weekly');
    const empty = view.find((row) => row.id === 'empty');
    expect(weekly?.periods[0]?.period).toBe('2026-09-28');
    expect(empty?.periods).toEqual([]);
  });

  it('findComment and deleteComment cover missing and already deleted rows', async () => {
    const store = new InMemoryMemberHabitStore();
    const habit = sampleHabit();
    await store.add(habit);
    expect(await store.findComment('missing')).toBeNull();
    expect(await store.deleteComment('missing')).toBe(false);
    await store.comment(comment({ id: 'c-live', habitId: habit.id }));
    expect((await store.findComment('c-live'))?.text).toBe('nice');
    expect(await store.deleteComment('c-live')).toBe(true);
    expect(await store.findComment('c-live')).toBeNull();
    expect(await store.deleteComment('c-live')).toBe(false);
  });

  it('stores and clears a lightning address', async () => {
    const store = new InMemoryMemberHabitStore();
    expect(await store.lightning('acc')).toBeNull();
    await store.setLightning('acc', 'ada@wallet.example');
    expect(await store.lightning('acc')).toBe('ada@wallet.example');
    await store.setLightning('acc', null);
    expect(await store.lightning('acc')).toBeNull();
  });
});

describe('PostgresMemberHabitStore', () => {
  it('migrates and inserts through a fake sql client', async () => {
    const statements: string[] = [];
    const sql = {
      query: async (
        text: string,
        _params?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        statements.push(text);
        return { rows: [] };
      },
    };
    const lightning = {
      get: async (_accountId: string): Promise<string | null> => null,
      set: async (_accountId: string, _address: string | null): Promise<void> => {
        return;
      },
    };

    await migrateMemberHabitSchema(sql);
    expect(statements).toEqual([...MEMBER_HABIT_SCHEMA_SQL]);
    expect(MEMBER_HABIT_SCHEMA_SQL).toHaveLength(4);
    expect(MEMBER_HABIT_SCHEMA_SQL[0]).toMatch(
      /account_id uuid NOT NULL REFERENCES account \(id\)/,
    );
    expect(MEMBER_HABIT_SCHEMA_SQL[1]).toMatch(
      /habit_id uuid NOT NULL REFERENCES member_habit \(id\)/,
    );
    expect(MEMBER_HABIT_SCHEMA_SQL[2]).toMatch(
      /habit_id uuid NOT NULL REFERENCES member_habit \(id\)/,
    );
    expect(MEMBER_HABIT_SCHEMA_SQL[3]).toMatch(
      /habit_id uuid NOT NULL REFERENCES member_habit \(id\)/,
    );
    expect(MEMBER_HABIT_SCHEMA_SQL[3]).toMatch(
      /account_id uuid NOT NULL REFERENCES account \(id\)/,
    );

    const store = new PostgresMemberHabitStore(sql, lightning);
    await store.add(sampleHabit());
    await store.listPublic(null, nowMs);

    const writes = statements.filter((text) => text.includes('INSERT INTO member_habit ('));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('INSERT INTO member_habit_revision');
    expect(statements.some((text) => text.includes('FROM member_habit'))).toBe(true);
  });

  it('edits the wording and the period revision in one statement', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const habit = sampleHabit();
    const patch = { name: 'Run', description: 'Outside', notes: 'secret' };
    const atPeriod = '2026-10-05';
    const expected = [
      patch.name,
      patch.description,
      patch.notes,
      habit.id,
      habit.accountId,
      atPeriod,
    ];
    const sql = {
      query: async (
        text: string,
        params: unknown[] = [],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        calls.push({ text, params });
        if (text.includes('RETURNING habit_id') && text.includes('account_id = $5')) {
          return { rows: [{ habit_id: habit.id }] };
        }
        return { rows: [] };
      },
    };
    const store = new PostgresMemberHabitStore(sql, addressesOf(null));
    expect(await store.edit(habit.id, habit.accountId, patch, atPeriod)).toBe('ok');
    expect(calls).toHaveLength(1);
    const only = calls[0];
    if (only === undefined) {
      throw new Error('expected the edit statement');
    }
    expect(only.text).toContain('UPDATE member_habit');
    expect(only.text).toContain('INSERT INTO member_habit_revision');
    expect(only.text).toContain('WHERE id = $4 AND account_id = $5');
    expect(only.text).not.toContain('FROM member_habit\n');
    expect(only.params).toEqual(expected);
    const missed: Array<{ text: string; params: unknown[] }> = [];
    const vanished = {
      query: async (
        text: string,
        params: unknown[] = [],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        missed.push({ text, params });
        return { rows: [] };
      },
    };
    const raced = new PostgresMemberHabitStore(vanished, addressesOf(null));
    expect(await raced.edit(habit.id, habit.accountId, patch, atPeriod)).toBe('missing');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.params).toEqual(expected);
  });

  it('edits, archives, logs, lists, comments, and reads lightning through scripted rows', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const accountId = '22222222-2222-2222-2222-222222222222';
    const sql = scriptedSql({
      habits: [
        habitRow(),
        habitRow({
          id: 'weekly',
          cadence: 'weekly',
          first_period: '2026-09-28',
          account_id: 'other',
        }),
        habitRow({
          id: 'ended',
          first_period: '2026-09-01',
          last_period: '2026-09-28',
        }),
      ],
      revisions: [
        revisionRow(),
        revisionRow({ habit_id: 'weekly', period: '2026-09-28' }),
        revisionRow({ habit_id: 'ended', period: '2026-09-01' }),
        revisionRow({ habit_id: id, period: '2026-10-03', name: 'Later', description: 'Later' }),
      ],
      logs: [
        { habit_id: id, period: '2026-10-01', status: 'achieved' },
        { habit_id: id, period: '2026-10-02', status: 'partial' },
        { habit_id: id, period: '2026-10-03', status: 'missed' },
      ],
      comments: [
        {
          id: 'c-b',
          habit_id: id,
          account_id: 'bob',
          name: 'Bob',
          text: 'later',
          week: '2026-09-28',
          created_at: 2,
          deleted_at: null,
        },
        {
          id: 'c-a',
          habit_id: id,
          account_id: 'bob',
          name: 'Bob',
          text: 'earlier',
          week: '2026-09-28',
          created_at: 1,
          deleted_at: null,
        },
      ],
    });
    const addresses = addressesOf('ada@wallet.example');
    const store = new PostgresMemberHabitStore(sql, addresses);
    expect(
      await store.edit(
        'missing',
        accountId,
        { name: 'N', description: '', notes: '' },
        '2026-10-05',
      ),
    ).toBe('missing');
    expect(
      await store.edit(
        id,
        accountId,
        { name: 'Run', description: 'Outside', notes: 'secret' },
        '2026-10-05',
      ),
    ).toBe('ok');
    expect(
      await store.edit(
        'weekly',
        accountId,
        { name: 'Nope', description: '', notes: '' },
        '2026-09-28',
      ),
    ).toBe('missing');
    expect(await store.archive('missing', accountId, '2026-10-05')).toBe('missing');
    expect(await store.archive('ended', accountId, '2026-10-05')).toBe('ok');
    expect(await store.archive(id, accountId, '2026-10-05')).toBe('ok');
    expect(await store.log('missing', accountId, '2026-10-01', 'achieved')).toBe('missing');
    expect(await store.log(id, accountId, '2026-09-01', 'achieved')).toBe('closed');
    expect(await store.log('ended', accountId, '2026-10-08', 'missed')).toBe('closed');
    const fresh = scriptedSql({
      habits: [habitRow({ last_period: null })],
      revisions: [revisionRow()],
      logs: [],
      comments: [],
    });
    const openStore = new PostgresMemberHabitStore(fresh, addressesOf(null));
    expect(await openStore.log(id, accountId, '2026-10-01', 'achieved')).toBe('ok');
    const listed = await store.listPublic(accountId, nowMs);
    const owned = listed.find((row) => row.id === id);
    expect(owned?.notes).toBe('secret');
    expect(owned?.comments.map((row) => row.id)).toEqual(['c-a', 'c-b']);
    const weekly = listed.find((row) => row.id === 'weekly');
    expect(weekly?.notes).toBeUndefined();
    expect(weekly?.periods[0]?.period).toBe('2026-09-28');
    expect(await store.findComment('missing')).toBeNull();
    expect((await store.findComment('c-a'))?.text).toBe('earlier');
    await store.comment({
      id: 'c-new',
      habitId: id,
      accountId: 'bob',
      name: 'Bob',
      text: 'new',
      week: '2026-09-28',
      createdAt: 3,
      deletedAt: null,
    });
    expect(await store.deleteComment('missing')).toBe(false);
    expect(await store.deleteComment('c-new')).toBe(true);
    expect(await store.deleteComment('c-new')).toBe(false);
    expect(await store.lightning(accountId)).toBe('ada@wallet.example');
    await store.setLightning(accountId, null);
    expect(await store.lightning(accountId)).toBeNull();
    await store.setLightning(accountId, 'next@wallet.example');
    expect(await store.lightning(accountId)).toBe('next@wallet.example');
  });

  it('rejects rows the column parsers cannot read', async () => {
    const cases: Array<{
      label: string;
      habits: Row[];
      revisions: Row[];
      logs: Row[];
      comments: Row[];
    }> = [
      {
        label: 'revision id',
        habits: [],
        revisions: [{ habit_id: 1, period: '2026-10-01', name: 'Walk', description: '' }],
        logs: [],
        comments: [],
      },
      {
        label: 'status',
        habits: [],
        revisions: [],
        logs: [{ habit_id: 'h', period: '2026-10-01', status: 'nope' }],
        comments: [],
      },
      {
        label: 'created_at',
        habits: [],
        revisions: [],
        logs: [],
        comments: [
          {
            id: 'c',
            habit_id: 'h',
            account_id: 'a',
            name: 'Bob',
            text: 't',
            week: '2026-09-28',
            created_at: 'x',
            deleted_at: null,
          },
        ],
      },
      {
        label: 'deleted_at',
        habits: [],
        revisions: [],
        logs: [],
        comments: [
          {
            id: 'c',
            habit_id: 'h',
            account_id: 'a',
            name: 'Bob',
            text: 't',
            week: '2026-09-28',
            created_at: 1,
            deleted_at: 'x',
          },
        ],
      },
      {
        label: 'habit id',
        habits: [habitRow({ id: 1 })],
        revisions: [revisionRow({ habit_id: 1 })],
        logs: [],
        comments: [],
      },
      {
        label: 'last_period',
        habits: [habitRow({ last_period: 1 })],
        revisions: [revisionRow()],
        logs: [],
        comments: [],
      },
      {
        label: 'cadence',
        habits: [habitRow({ cadence: 'yearly' })],
        revisions: [revisionRow()],
        logs: [],
        comments: [],
      },
      {
        label: 'missing revision',
        habits: [habitRow()],
        revisions: [],
        logs: [],
        comments: [],
      },
      {
        label: 'uncovered period',
        habits: [habitRow({ first_period: '2026-10-01' })],
        revisions: [revisionRow({ period: '2026-10-15' })],
        logs: [],
        comments: [],
      },
    ];
    for (const entry of cases) {
      const sql =
        entry.label === 'created_at' || entry.label === 'deleted_at'
          ? {
              query: async (text: string): Promise<{ rows: Row[] }> => {
                if (text.includes('member_habit_comment') && !text.includes('WHERE id')) {
                  return { rows: entry.comments };
                }
                return { rows: [] };
              },
            }
          : scriptedSql({
              habits: entry.habits,
              revisions: entry.revisions,
              logs: entry.logs,
              comments: entry.comments,
            });
      const store = new PostgresMemberHabitStore(sql, addressesOf(null));
      await expect(store.listPublic(null, nowMs)).rejects.toThrow(Error);
    }
    const sparse = {
      query: async (text: string): Promise<{ rows: Row[] }> => {
        if (
          text.includes('WHERE id = $1') &&
          text.includes('member_habit_comment') &&
          !text.includes('SELECT deleted_at')
        ) {
          const rows: Row[] = [];
          rows.length = 1;
          return { rows };
        }
        return { rows: [] };
      },
    };
    const sparseStore = new PostgresMemberHabitStore(sparse, addressesOf(null));
    expect(await sparseStore.findComment('c')).toBeNull();
  });
});
