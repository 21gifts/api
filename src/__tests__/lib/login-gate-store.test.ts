import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryLoginGateStore,
  LOGIN_GATE_SCHEMA_SQL,
  migrateLoginGateSchema,
  PostgresLoginGateStore,
} from '@/lib/login-gate-store';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function recordingClient(rows: unknown[] = []): {
  client: SqlClient;
  calls: { kind: 'query' | 'execute'; text: string; params: readonly unknown[] }[];
} {
  const calls: { kind: 'query' | 'execute'; text: string; params: readonly unknown[] }[] = [];
  const client: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      calls.push({ kind: 'query', text, params });
      return rows as T[];
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      calls.push({ kind: 'execute', text, params });
    },
  };
  return { client, calls };
}

describe('migrateLoginGateSchema', () => {
  it('creates app_setting and login_allowlist', async () => {
    const { client, calls } = recordingClient();
    await migrateLoginGateSchema(client);
    expect(calls.map((c) => c.text)).toEqual([...LOGIN_GATE_SCHEMA_SQL]);
    expect(calls[0]?.text).toContain('CREATE TABLE IF NOT EXISTS app_setting');
    expect(calls[1]?.text).toContain('REFERENCES account (id) ON DELETE CASCADE');
  });
});

describe('InMemoryLoginGateStore', () => {
  it('has no stored switch until set', async () => {
    const store = new InMemoryLoginGateStore();
    await expect(store.loginsOpen()).resolves.toBeNull();
    await store.setLoginsOpen(false);
    await expect(store.loginsOpen()).resolves.toBe(false);
    await store.setLoginsOpen(true);
    await expect(store.loginsOpen()).resolves.toBe(true);
  });

  it('adds, lists oldest first, and removes allowlist rows', async () => {
    const store = new InMemoryLoginGateStore();
    await expect(store.addToAllowlist(B, 5)).resolves.toBe(true);
    await expect(store.addToAllowlist(A, 5)).resolves.toBe(true);
    await expect(store.addToAllowlist(A, 9)).resolves.toBe(false);
    await expect(store.addToAllowlist('00000000-0000-4000-8000-000000000001', 7)).resolves.toBe(
      true,
    );
    await expect(store.listAllowlist()).resolves.toEqual([
      { accountId: A, createdAt: 5 },
      { accountId: B, createdAt: 5 },
      { accountId: '00000000-0000-4000-8000-000000000001', createdAt: 7 },
    ]);
    await expect(store.isAllowlisted(A)).resolves.toBe(true);
    await expect(store.removeFromAllowlist(A)).resolves.toBe(true);
    await expect(store.removeFromAllowlist(A)).resolves.toBe(false);
    await expect(store.isAllowlisted(A)).resolves.toBe(false);
  });
});

describe('PostgresLoginGateStore', () => {
  it('reads null without a row, true for open, false otherwise', async () => {
    const none = recordingClient([]);
    await expect(new PostgresLoginGateStore(none.client).loginsOpen()).resolves.toBeNull();
    expect(none.calls[0]?.params).toEqual(['logins_open']);
    const open = recordingClient([{ value: 'open' }]);
    await expect(new PostgresLoginGateStore(open.client).loginsOpen()).resolves.toBe(true);
    const closed = recordingClient([{ value: 'closed' }]);
    await expect(new PostgresLoginGateStore(closed.client).loginsOpen()).resolves.toBe(false);
  });

  it('upserts the switch as open or closed', async () => {
    const { client, calls } = recordingClient();
    const store = new PostgresLoginGateStore(client);
    await store.setLoginsOpen(true, 1000);
    await store.setLoginsOpen(false, 2000);
    expect(calls[0]?.text).toContain('ON CONFLICT (key) DO UPDATE');
    expect(calls[0]?.params).toEqual(['logins_open', 'open', 1000]);
    expect(calls[1]?.params).toEqual(['logins_open', 'closed', 2000]);
  });

  it('maps allowlist rows with Date or string timestamps', async () => {
    const { client, calls } = recordingClient([
      { account_id: A, created_at: new Date(1000) },
      { account_id: B, created_at: '1970-01-01T00:00:02.000Z' },
    ]);
    await expect(new PostgresLoginGateStore(client).listAllowlist()).resolves.toEqual([
      { accountId: A, createdAt: 1000 },
      { accountId: B, createdAt: 2000 },
    ]);
    expect(calls[0]?.text).toContain('ORDER BY created_at ASC, account_id ASC');
  });

  it('reports membership, insert, and delete by returned rows', async () => {
    const hit = recordingClient([{ account_id: A }]);
    const hitStore = new PostgresLoginGateStore(hit.client);
    await expect(hitStore.isAllowlisted(A)).resolves.toBe(true);
    await expect(hitStore.addToAllowlist(A, 3000)).resolves.toBe(true);
    await expect(hitStore.removeFromAllowlist(A)).resolves.toBe(true);
    expect(hit.calls.map((c) => c.params)).toEqual([[A], [A, 3000], [A]]);
    expect(hit.calls[1]?.text).toContain('ON CONFLICT (account_id) DO NOTHING');
    const miss = recordingClient([]);
    const missStore = new PostgresLoginGateStore(miss.client);
    await expect(missStore.isAllowlisted(A)).resolves.toBe(false);
    await expect(missStore.addToAllowlist(A, 3000)).resolves.toBe(false);
    await expect(missStore.removeFromAllowlist(A)).resolves.toBe(false);
  });
});
