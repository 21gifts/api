import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { POS_CHARGE_TTL_MS, type PosCharge } from '@/lib/pos-charge';
import {
  InMemoryPosStore,
  POS_SCHEMA_SQL,
  migratePosSchema,
  PostgresPosStore,
} from '@/lib/pos-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  expireRows: unknown[] = [];
  pendingRows: unknown[] = [];
  cancelRows: unknown[] = [];
  listRows: unknown[] = [];
  queryError: unknown | undefined;
  executeError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    if (text.includes("SET status = 'expired'")) {
      return this.expireRows as T[];
    }
    if (text.includes("SET status = 'cancelled'")) {
      return this.cancelRows as T[];
    }
    if (text.includes("status = 'pending'") && text.includes('LIMIT 1')) {
      return this.pendingRows as T[];
    }
    return this.listRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
  }
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

const T0 = Date.parse('2026-09-01T12:00:00.000Z');

function charge(partial: Partial<PosCharge> & Pick<PosCharge, 'id'>): PosCharge {
  return {
    accountId: 'acc',
    amountSats: 21,
    status: 'pending',
    createdAt: new Date(T0),
    expiresAt: new Date(T0 + POS_CHARGE_TTL_MS),
    ...partial,
  };
}

describe('POS_SCHEMA_SQL', () => {
  it('creates pos_charge and its account/created_at index', () => {
    expect(POS_SCHEMA_SQL).toHaveLength(2);
    expect(POS_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS pos_charge/i);
    expect(POS_SCHEMA_SQL[0]).toMatch(/account_id uuid NOT NULL REFERENCES account/i);
    expect(POS_SCHEMA_SQL[0]).toMatch(/amount_sats bigint NOT NULL CHECK \(amount_sats > 0\)/);
    expect(POS_SCHEMA_SQL[1]).toMatch(/CREATE INDEX IF NOT EXISTS pos_charge_account_created_idx/i);
  });
});

describe('migratePosSchema', () => {
  it('runs every POS_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migratePosSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...POS_SCHEMA_SQL]);
    expect(sql.queries).toEqual([]);
  });
});

describe('InMemoryPosStore', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('lists nothing when constructed empty', async () => {
    const store = new InMemoryPosStore();
    expect(await store.listLatest(10)).toEqual([]);
    expect(await store.listForAccount('acc', 10)).toEqual([]);
    expect(await store.currentPending('acc', T0)).toBeNull();
  });

  it('copies created and listed rows so callers cannot mutate store state', async () => {
    const store = new InMemoryPosStore();
    const input = charge({ id: 'a' });
    const created = await store.create(input);
    input.amountSats = 99;
    input.createdAt.setTime(0);
    created.amountSats = 1;
    created.createdAt.setTime(0);
    created.expiresAt.setTime(0);
    const listed = await store.listLatest(10);
    expect(listed).toHaveLength(1);
    listed[0]!.amountSats = 2;
    listed[0]!.createdAt.setTime(1);
    const again = await store.listLatest(10);
    expect(again[0]?.amountSats).toBe(21);
    expect(again[0]?.createdAt.getTime()).toBe(T0);
  });

  it('returns newest createdAt first and breaks ties by id descending', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'm', createdAt: new Date(T0 + 1) }));
    await store.create(charge({ id: 'z', createdAt: new Date(T0 + 1) }));
    await store.create(charge({ id: 'a', createdAt: new Date(T0) }));
    expect((await store.listLatest(10)).map((row) => row.id)).toEqual(['z', 'm', 'a']);
    expect((await store.listForAccount('acc', 2)).map((row) => row.id)).toEqual(['z', 'm']);
  });

  it('keeps equal id and createdAt as a sort tie', async () => {
    const store = new InMemoryPosStore();
    const row = charge({ id: 'z' });
    await store.create(row);
    await store.create(row);
    expect((await store.listLatest(10)).map((r) => r.id)).toEqual(['z', 'z']);
  });

  it('listForAccount filters by account and caps at limit', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'a', accountId: 'acc' }));
    await store.create(charge({ id: 'b', accountId: 'other', createdAt: new Date(T0 + 1) }));
    expect((await store.listForAccount('acc', 10)).map((row) => row.id)).toEqual(['a']);
    expect((await store.listLatest(1)).map((row) => row.id)).toEqual(['b']);
  });

  it('create logs pos.create with accountId only', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'a' }));
    const events = parsedEvents(warn).filter((e) => e['event'] === 'pos.create');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ event: 'pos.create', accountId: 'acc' }));
    expect(events[0]).not.toHaveProperty('amountSats');
  });

  it('currentPending expires due rows once, logs pos.expired, and returns the live row', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'old', expiresAt: new Date(T0), createdAt: new Date(T0 - 1) }));
    await store.create(charge({ id: 'live', createdAt: new Date(T0) }));
    const pending = await store.currentPending('acc', T0);
    expect(pending?.id).toBe('live');
    expect((await store.listForAccount('acc', 10)).map((row) => row.status).sort()).toEqual([
      'expired',
      'pending',
    ]);
    const expiredLogs = parsedEvents(warn).filter((e) => e['event'] === 'pos.expired');
    expect(expiredLogs).toHaveLength(1);
    expect(expiredLogs[0]).toEqual(
      expect.objectContaining({ event: 'pos.expired', accountId: 'acc' }),
    );
    expect(expiredLogs[0]).not.toHaveProperty('amountSats');
    await store.currentPending('acc', T0);
    expect(parsedEvents(warn).filter((e) => e['event'] === 'pos.expired')).toHaveLength(1);
  });

  it('currentPending returns null and does not log when nothing is open', async () => {
    const store = new InMemoryPosStore();
    expect(await store.currentPending('acc', T0)).toBeNull();
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.expired')).toBe(false);
  });

  it('cancelPending cancels the newest live row and logs pos.cancel', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'a', createdAt: new Date(T0) }));
    await store.create(charge({ id: 'b', createdAt: new Date(T0 + 1) }));
    const cancelled = await store.cancelPending('acc', T0);
    expect(cancelled?.id).toBe('b');
    expect(cancelled?.status).toBe('cancelled');
    expect((await store.currentPending('acc', T0))?.id).toBe('a');
    const cancelLogs = parsedEvents(warn).filter((e) => e['event'] === 'pos.cancel');
    expect(cancelLogs).toHaveLength(1);
    expect(cancelLogs[0]).toEqual(
      expect.objectContaining({ event: 'pos.cancel', accountId: 'acc' }),
    );
    expect(cancelLogs[0]).not.toHaveProperty('amountSats');
  });

  it('cancelPending of an already-expired row marks it expired and returns null', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge({ id: 'old', expiresAt: new Date(T0) }));
    expect(await store.cancelPending('acc', T0)).toBeNull();
    expect((await store.listForAccount('acc', 10))[0]?.status).toBe('expired');
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.expired')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.cancel')).toBe(false);
  });
});

describe('PostgresPosStore', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('maps Date-vs-string timestamps and number-vs-bigint-or-string amounts', async () => {
    const sql = new MockSql();
    sql.listRows = [
      {
        id: 'c1',
        account_id: 'acc',
        amount_sats: 21,
        status: 'pending',
        created_at: new Date('2026-09-01T12:00:00.000Z'),
        expires_at: new Date('2026-09-01T12:05:00.000Z'),
      },
      {
        id: 'c2',
        account_id: 'acc',
        amount_sats: 42n,
        status: 'cancelled',
        created_at: '2026-08-31T12:00:00.000Z',
        expires_at: '2026-08-31T12:05:00.000Z',
      },
    ];
    const listed = await new PostgresPosStore(sql).listLatest(50);
    expect(sql.queries[0]?.text).toMatch(
      /SELECT id, account_id, amount_sats, status, created_at, expires_at/,
    );
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT \$1/);
    expect(sql.queries[0]?.text).not.toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed).toEqual([
      {
        id: 'c1',
        accountId: 'acc',
        amountSats: 21,
        status: 'pending',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
        expiresAt: new Date('2026-09-01T12:05:00.000Z'),
      },
      {
        id: 'c2',
        accountId: 'acc',
        amountSats: 42,
        status: 'cancelled',
        createdAt: new Date('2026-08-31T12:00:00.000Z'),
        expiresAt: new Date('2026-08-31T12:05:00.000Z'),
      },
    ]);
  });

  it('listForAccount binds account id and limit', async () => {
    const sql = new MockSql();
    sql.listRows = [
      {
        id: 'c1',
        account_id: 'acc',
        amount_sats: '21',
        status: 'expired',
        created_at: '2026-09-01T12:00:00.000Z',
        expires_at: new Date('2026-09-01T12:05:00.000Z'),
      },
    ];
    const listed = await new PostgresPosStore(sql).listForAccount('acc', 20);
    expect(sql.queries[0]?.text).toMatch(/WHERE account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$2/);
    expect(sql.queries[0]?.params).toEqual(['acc', 20]);
    expect(listed[0]?.amountSats).toBe(21);
    expect(listed[0]?.createdAt).toEqual(new Date('2026-09-01T12:00:00.000Z'));
  });

  it('create binds ISO timestamps and a numeric amount_sats, then logs pos.create', async () => {
    const sql = new MockSql();
    const row = charge({ id: 'c1' });
    const created = await new PostgresPosStore(sql).create(row);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO pos_charge \(id, account_id, amount_sats, status, created_at, expires_at\)/,
    );
    expect(sql.executes[0]?.params).toEqual([
      'c1',
      'acc',
      21,
      'pending',
      row.createdAt.toISOString(),
      row.expiresAt.toISOString(),
    ]);
    expect(typeof sql.executes[0]?.params[2]).toBe('number');
    expect(created).toEqual(row);
    expect(created).not.toBe(row);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'pos.create', accountId: 'acc' }),
    );
  });

  it('currentPending expires with ISO now, logs once when ids return, then selects remaining', async () => {
    const sql = new MockSql();
    sql.expireRows = [{ id: 'old' }];
    sql.pendingRows = [
      {
        id: 'live',
        account_id: 'acc',
        amount_sats: 21,
        status: 'pending',
        created_at: new Date('2026-09-01T12:00:00.000Z'),
        expires_at: new Date('2026-09-01T12:05:00.000Z'),
      },
    ];
    const pending = await new PostgresPosStore(sql).currentPending('acc', T0);
    expect(sql.queries[0]?.text).toMatch(/SET status = 'expired'/);
    expect(sql.queries[0]?.text).toMatch(/RETURNING id/);
    expect(sql.queries[0]?.params).toEqual(['acc', new Date(T0).toISOString()]);
    expect(sql.queries[1]?.text).toMatch(/status = 'pending'/);
    expect(sql.queries[1]?.params).toEqual(['acc']);
    expect(pending?.id).toBe('live');
    expect(parsedEvents(warn).filter((e) => e['event'] === 'pos.expired')).toHaveLength(1);
  });

  it('currentPending returns null and does not log when nothing expired and nothing is pending', async () => {
    const sql = new MockSql();
    sql.expireRows = [];
    sql.pendingRows = [];
    expect(await new PostgresPosStore(sql).currentPending('acc', T0)).toBeNull();
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.expired')).toBe(false);
  });

  it('cancelPending logs pos.cancel when a row is returned', async () => {
    const sql = new MockSql();
    sql.cancelRows = [
      {
        id: 'c1',
        account_id: 'acc',
        amount_sats: 21n,
        status: 'cancelled',
        created_at: '2026-09-01T12:00:00.000Z',
        expires_at: '2026-09-01T12:05:00.000Z',
      },
    ];
    const cancelled = await new PostgresPosStore(sql).cancelPending('acc', T0);
    expect(sql.queries[0]?.text).toMatch(/SET status = 'expired'/);
    expect(sql.queries[1]?.text).toMatch(/SET status = 'cancelled'/);
    expect(sql.queries[1]?.params).toEqual(['acc']);
    expect(cancelled).toEqual({
      id: 'c1',
      accountId: 'acc',
      amountSats: 21,
      status: 'cancelled',
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      expiresAt: new Date('2026-09-01T12:05:00.000Z'),
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.cancel')).toBe(true);
  });

  it('cancelPending returns null and does not log pos.cancel when no row remains', async () => {
    const sql = new MockSql();
    sql.expireRows = [{ id: 'old' }];
    sql.cancelRows = [];
    expect(await new PostgresPosStore(sql).cancelPending('acc', T0)).toBeNull();
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.cancel')).toBe(false);
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.expired')).toBe(true);
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresPosStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('propagates create execute errors and does not log pos.create', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('create boom');
    await expect(new PostgresPosStore(sql).create(charge({ id: 'c1' }))).rejects.toThrow(
      'create boom',
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'pos.create')).toBe(false);
  });
});
