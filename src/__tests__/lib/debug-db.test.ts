import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { DEBUG_DB_PAGE_SIZE, DebugDbCursorError, PostgresDebugDbStore } from '@/lib/debug-db';

interface Call {
  text: string;
  params: readonly unknown[];
}

/**
 * Scripted SQL. Catalog names include one unsafe name that must never be quoted into `FROM`.
 *
 * @param pages - How many data rows the next `message` page returns.
 * @param loosePages - How many data rows the next `loose` page returns.
 * @param omitLastKey - When true, the last `message` row has no `id`.
 * @returns A client and the recorded calls.
 */
function scripted(
  pages = 1,
  loosePages = 1,
  omitLastKey = false,
): { sql: SqlClient; calls: Call[] } {
  const calls: Call[] = [];
  const sql: SqlClient = {
    query: <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
      calls.push({ text, params });
      if (text.includes('relkind')) {
        return Promise.resolve([
          { name: 'message' },
          { name: 'bad name' },
          { name: 'loose' },
          { name: 'bare' },
          { name: 'sessions' },
          { name: 'pushes' },
          { name: 4 },
        ] as T[]);
      }
      if (text.startsWith('SELECT count')) {
        if (text.includes('"message"')) {
          return Promise.resolve([{ n: '2' }] as T[]);
        }
        if (text.includes('"loose"')) {
          return Promise.resolve([] as T[]);
        }
        return Promise.resolve([{ n: null }] as T[]);
      }
      if (text.includes('pg_index')) {
        const regclass = String(params[0]);
        if (regclass.endsWith('loose')) {
          return Promise.resolve([{ name: null }, { name: 'bad-key' }] as T[]);
        }
        if (regclass.endsWith('sessions')) {
          return Promise.resolve([{ name: 'token' }] as T[]);
        }
        if (regclass.endsWith('pushes')) {
          return Promise.resolve([{ name: 'endpoint' }] as T[]);
        }
        if (regclass.endsWith('bare')) {
          return Promise.resolve([{ name: 'id' }] as T[]);
        }
        return Promise.resolve([{ name: 'id' }] as T[]);
      }
      if (text.includes('pg_attribute')) {
        const regclass = String(params[0]);
        if (regclass.endsWith('bare')) {
          return Promise.resolve([{ name: 'bad-col', type: 'text' }] as T[]);
        }
        if (regclass.endsWith('loose')) {
          return Promise.resolve([
            { name: 'id', type: 'text' },
            { name: null, type: 'text' },
          ] as T[]);
        }
        if (regclass.endsWith('sessions')) {
          return Promise.resolve([{ name: 'token', type: 'text' }] as T[]);
        }
        if (regclass.endsWith('pushes')) {
          return Promise.resolve([{ name: 'endpoint', type: 'text' }] as T[]);
        }
        return Promise.resolve([
          { name: 'id', type: 'uuid' },
          { name: 'photo', type: 'bytea' },
          { name: 'token', type: 'text' },
          { name: 'nostr_nsec_ciphertext', type: 'bytea' },
          { name: 'note', type: 'text' },
          { name: 'bad-col', type: 'text' },
        ] as T[]);
      }
      if (text.includes('ctid::text')) {
        return Promise.resolve(
          Array.from({ length: loosePages }, (_, index) => ({
            id: `loose-${index}`,
            token: `sekret-${index}`,
            endpoint: `https://push.example/${index}`,
            debug_db_ctid: `(0,${index})`,
          })) as T[],
        );
      }
      if (text.includes('octet_length')) {
        return Promise.resolve(
          Array.from({ length: pages }, (_, index) => {
            const row: Record<string, unknown> = {
              photo: index === 0 ? null : '12',
              token: index === 0 ? null : 'secret-token',
              nostr_nsec_ciphertext: index === 0 ? undefined : 32,
              note: index === 0 ? undefined : 'hello',
            };
            if (!(omitLastKey && index === DEBUG_DB_PAGE_SIZE - 1)) {
              row['id'] = `id-${index}`;
            }
            return row;
          }) as T[],
        );
      }
      return Promise.resolve([] as T[]);
    },
    execute: () => Promise.resolve(),
  };
  return { sql, calls };
}

function cursorOf(values: unknown): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

describe('PostgresDebugDbStore', () => {
  it('lists only safe tables and never quotes an unsafe name into FROM', async () => {
    const { sql, calls } = scripted();
    const store = new PostgresDebugDbStore(sql);
    const tables = await store.listTables();
    expect(tables).toEqual([
      { name: 'message', rowCount: 2 },
      { name: 'loose', rowCount: 0 },
      { name: 'bare', rowCount: 0 },
      { name: 'sessions', rowCount: 0 },
      { name: 'pushes', rowCount: 0 },
    ]);
    expect(calls.some((call) => call.text.includes('bad name'))).toBe(false);
    expect(calls.some((call) => call.text.includes('FROM "message"'))).toBe(true);
  });

  it('returns undefined for an unsafe or unknown table without a data query', async () => {
    const { sql, calls } = scripted();
    const store = new PostgresDebugDbStore(sql);
    await expect(store.readPage('message;drop', null)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    await expect(store.readPage('nope', null)).resolves.toBeUndefined();
    expect(calls.some((call) => call.text.includes('FROM "nope"'))).toBe(false);
    expect(calls.some((call) => call.text.includes('octet_length'))).toBe(false);
  });

  it('returns an empty page when every column name is unsafe', async () => {
    const { sql, calls } = scripted();
    const store = new PostgresDebugDbStore(sql);
    await expect(store.readPage('bare', null)).resolves.toEqual({
      table: 'bare',
      columns: [],
      rows: [],
      nextCursor: null,
    });
    expect(
      calls.some((call) => call.text.includes('octet_length') || call.text.includes('ctid')),
    ).toBe(false);
  });

  it('redacts secrets, returns byte lengths, and pages on the primary key', async () => {
    const full = scripted(DEBUG_DB_PAGE_SIZE + 1, 1, true);
    const store = new PostgresDebugDbStore(full.sql);
    const page = await store.readPage('message', null);
    expect(page?.columns).toEqual(['id', 'photo', 'token', 'nostr_nsec_ciphertext', 'note']);
    expect(page?.rows).toHaveLength(DEBUG_DB_PAGE_SIZE);
    expect(page?.rows[0]).toEqual({
      id: 'id-0',
      photo: null,
      token: null,
      nostr_nsec_ciphertext: null,
      note: null,
    });
    expect(page?.rows[1]).toEqual({
      id: 'id-1',
      photo: 12,
      token: 'redacted',
      nostr_nsec_ciphertext: 32,
      note: 'hello',
    });
    expect(page?.nextCursor).toBe(cursorOf([null]));
    const select = full.calls.find((call) => call.text.includes('octet_length'));
    expect(select?.text).not.toContain('bad-col');
    expect(select?.text).toContain('LIMIT 201');
    expect(select?.params).toEqual([]);

    const next = scripted(1);
    const nextStore = new PostgresDebugDbStore(next.sql);
    const rest = await nextStore.readPage('message', page?.nextCursor ?? null);
    expect(rest?.nextCursor).toBeNull();
    expect(rest?.rows).toHaveLength(1);
    const paged = next.calls.find((call) => call.text.includes('octet_length'));
    expect(paged?.text).toContain('WHERE ("id") > ($1)');
    expect(paged?.params).toEqual([null]);
  });

  it('pages a table with no primary key by ctid', async () => {
    const full = scripted(1, DEBUG_DB_PAGE_SIZE + 1);
    const store = new PostgresDebugDbStore(full.sql);
    const page = await store.readPage('loose', null);
    expect(page?.columns).toEqual(['id']);
    expect(page?.rows[0]).toEqual({ id: 'loose-0' });
    expect(page?.nextCursor).toBe(cursorOf([`(0,${DEBUG_DB_PAGE_SIZE - 1})`]));
    const select = full.calls.find((call) => call.text.includes('ctid::text'));
    expect(select?.text).toContain('ORDER BY ctid');
    expect(select?.text).not.toContain('WHERE');

    const next = scripted(1, 1);
    const rest = await new PostgresDebugDbStore(next.sql).readPage(
      'loose',
      page?.nextCursor ?? null,
    );
    const paged = next.calls.find((call) => call.text.includes('ctid::text'));
    expect(paged?.text).toContain('WHERE ctid > $1::tid');
    expect(paged?.params).toEqual([`(0,${DEBUG_DB_PAGE_SIZE - 1})`]);
    expect(rest?.nextCursor).toBeNull();
  });

  it('pages a secret primary key by ctid so the cursor is not the secret', async () => {
    const full = scripted(1, DEBUG_DB_PAGE_SIZE + 1);
    const store = new PostgresDebugDbStore(full.sql);
    const sessions = await store.readPage('sessions', null);
    const pushes = await store.readPage('pushes', null);
    expect(sessions?.rows[0]).toEqual({ token: 'redacted' });
    expect(pushes?.rows[0]).toEqual({ endpoint: 'redacted' });
    const ctid = `(0,${DEBUG_DB_PAGE_SIZE - 1})`;
    expect(sessions?.nextCursor).toBe(cursorOf([ctid]));
    expect(pushes?.nextCursor).toBe(cursorOf([ctid]));
    const decoded = JSON.parse(
      Buffer.from(sessions?.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as unknown[];
    expect(JSON.stringify(decoded)).not.toContain('sekret');
    expect(JSON.stringify(decoded)).not.toContain('push.example');
  });

  it('rejects a cursor that is not a JSON array or has the wrong arity', async () => {
    const { sql } = scripted();
    const store = new PostgresDebugDbStore(sql);
    await expect(store.readPage('message', '%%%')).rejects.toBeInstanceOf(DebugDbCursorError);
    await expect(store.readPage('message', cursorOf({ not: 'array' }))).rejects.toBeInstanceOf(
      DebugDbCursorError,
    );
    await expect(store.readPage('message', cursorOf(['a', 'b']))).rejects.toBeInstanceOf(
      DebugDbCursorError,
    );
    await expect(store.readPage('loose', cursorOf(['a', 'b']))).rejects.toBeInstanceOf(
      DebugDbCursorError,
    );
  });
});
