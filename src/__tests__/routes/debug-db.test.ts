import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DebugDbCursorError,
  type DebugDbPage,
  type DebugDbStore,
  type DebugDbTable,
} from '@/lib/debug-db';
import { debugDbRoutes } from '@/routes/debug-db';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function store(partial: Partial<DebugDbStore> = {}): DebugDbStore {
  return {
    listTables: () => Promise.resolve([{ name: 'message', rowCount: 3 }]),
    readPage: () =>
      Promise.resolve({
        table: 'message',
        columns: ['id'],
        rows: [{ id: '1' }],
        nextCursor: null,
      }),
    ...partial,
  };
}

function app(deps: { store: DebugDbStore | undefined; debugToken: string | undefined }): Hono {
  return new Hono().route('/debug/db', debugDbRoutes(deps));
}

describe('debugDbRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const res = await app({ store: store(), debugToken: undefined }).request('/debug/db');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the debug token is blank', async () => {
    const res = await app({ store: store(), debugToken: '   ' }).request('/debug/db', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 when the bearer does not match', async () => {
    const res = await app({ store: store(), debugToken: 'secret' }).request('/debug/db', {
      headers: { authorization: 'Bearer other' },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when a cursor is sent without a table', async () => {
    const res = await app({ store: store(), debugToken: 'secret' }).request(
      '/debug/db?cursor=abc',
      { headers: { authorization: 'Bearer secret' } },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid cursor' });
  });

  it('returns 503 when no database is configured', async () => {
    const res = await app({ store: undefined, debugToken: 'secret' }).request('/debug/db', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Database is not configured' });
  });

  it('lists tables', async () => {
    const tables: DebugDbTable[] = [{ name: 'message', rowCount: 3 }];
    const res = await app({
      store: store({ listTables: () => Promise.resolve(tables) }),
      debugToken: 'secret',
    }).request('/debug/db', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tables });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.db.listed', count: 1 }),
    );
  });

  it('omits nextCursor on the last page and returns 404 for an unknown table', async () => {
    const readPage = vi.fn((table: string) =>
      Promise.resolve(
        table === 'message'
          ? {
              table: 'message',
              columns: ['id'],
              rows: [{ id: '1' }],
              nextCursor: null,
            }
          : undefined,
      ),
    );
    const client = app({ store: store({ readPage }), debugToken: 'secret' });
    const ok = await client.request('/debug/db?table=message', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      table: 'message',
      columns: ['id'],
      rows: [{ id: '1' }],
    });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.db.page', table: 'message', count: 1 }),
    );
    const missing = await client.request('/debug/db?table=nope', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('returns nextCursor when another page exists', async () => {
    const page: DebugDbPage = {
      table: 'message',
      columns: ['id'],
      rows: [{ id: '1' }],
      nextCursor: 'next',
    };
    const res = await app({
      store: store({ readPage: () => Promise.resolve(page) }),
      debugToken: 'secret',
    }).request('/debug/db?table=message&cursor=prev', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(page);
  });

  it('returns 400 when the cursor is rejected and 503 when the store throws', async () => {
    const bad = app({
      store: store({
        readPage: () => Promise.reject(new DebugDbCursorError()),
      }),
      debugToken: 'secret',
    });
    const cursor = await bad.request('/debug/db?table=message&cursor=nope', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(cursor.status).toBe(400);
    await expect(cursor.json()).resolves.toEqual({ error: 'Invalid cursor' });

    const broken = app({
      store: store({
        listTables: () => Promise.reject(new Error('down')),
        readPage: () => Promise.reject(new Error('down')),
      }),
      debugToken: 'secret',
    });
    const listed = await broken.request('/debug/db', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(listed.status).toBe(503);
    await expect(listed.json()).resolves.toEqual({ error: 'Database is unavailable' });
    const paged = await broken.request('/debug/db?table=message', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(paged.status).toBe(503);
    expect(parsedEvents(warn).filter((event) => event['event'] === 'debug.db.failed')).toHaveLength(
      2,
    );
  });
});
