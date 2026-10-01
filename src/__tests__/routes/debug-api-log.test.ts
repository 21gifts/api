import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { API_LOG_LIST_LIMIT, InMemoryApiLogStore, type ApiLogRow } from '@/lib/api-log';
import { debugApiLogRoutes } from '@/routes/debug-api-log';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

const ROW: ApiLogRow = {
  id: 'log-1',
  createdAt: new Date('2026-09-19T15:16:52.530Z'),
  method: 'POST',
  path: '/conversations/x',
  status: 200,
  ms: 8,
  accountId: 'staff',
  authKind: 'session',
  clientIp: null,
  clientCountry: null,
  cfRay: null,
  userAgent: null,
  acceptLanguage: null,
  origin: null,
};

describe('debugApiLogRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: undefined }),
    );
    const res = await app.request('/debug/api-log');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('lists logs newest-first for a valid bearer', async () => {
    const store = new InMemoryApiLogStore([ROW]);
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store, debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      logs: [
        {
          id: 'log-1',
          createdAt: '2026-09-19T15:16:52.530Z',
          method: 'POST',
          path: '/conversations/x',
          status: 200,
          ms: 8,
          accountId: 'staff',
          authKind: 'session',
          clientIp: null,
          clientCountry: null,
          cfRay: null,
          userAgent: null,
          acceptLanguage: null,
          origin: null,
        },
      ],
      hasMore: false,
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.api_log.listed')).toBe(true);
  });

  it('returns 503 when the store throws', async () => {
    const store = {
      append: async () => undefined,
      listLatest: async () => {
        throw new Error('disk');
      },
      listPage: async () => {
        throw new Error('disk');
      },
    };
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store, debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Log is unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'api_log.list.failed')).toBe(true);
  });

  it('pages 201 stored rows with hasMore then the remainder', async () => {
    const rows = Array.from({ length: API_LOG_LIST_LIMIT + 1 }, (_, index) => ({
      ...ROW,
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      createdAt: new Date(Date.UTC(2026, 8, 19, 0, 0, index)),
    }));
    const store = new InMemoryApiLogStore(rows);
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store, debugToken: 'secret' }),
    );
    const first = await app.request('/debug/api-log', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      logs: Array<{ id: string; createdAt: string }>;
      hasMore: boolean;
    };
    expect(firstBody.logs).toHaveLength(200);
    expect(firstBody.hasMore).toBe(true);
    const last = firstBody.logs[firstBody.logs.length - 1]!;
    const second = await app.request(
      `/debug/api-log?before=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.id)}`,
      { headers: { authorization: 'Bearer secret' } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      logs: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.logs.map((row) => row.id)).toEqual(['00000000-0000-4000-8000-000000000000']);
    expect(secondBody.hasMore).toBe(false);
  });

  it('filters by accountId', async () => {
    const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const store = new InMemoryApiLogStore([
      { ...ROW, id: '00000000-0000-4000-8000-00000000000a', accountId: accountA },
      { ...ROW, id: '00000000-0000-4000-8000-00000000000b', accountId: accountB },
      { ...ROW, id: '00000000-0000-4000-8000-00000000000c', accountId: null },
    ]);
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store, debugToken: 'secret' }),
    );
    const res = await app.request(`/debug/api-log?accountId=${accountA}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      logs: [
        {
          id: '00000000-0000-4000-8000-00000000000a',
          createdAt: '2026-09-19T15:16:52.530Z',
          method: 'POST',
          path: '/conversations/x',
          status: 200,
          ms: 8,
          accountId: accountA,
          authKind: 'session',
          clientIp: null,
          clientCountry: null,
          cfRay: null,
          userAgent: null,
          acceptLanguage: null,
          origin: null,
        },
      ],
      hasMore: false,
    });
  });

  it('returns 400 for a bad accountId', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log?accountId=not-a-uuid', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid account' });
  });

  it('returns 400 when before is present without beforeId', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log?before=2026-09-19T15:16:52.530Z', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it('returns 400 when beforeId is present without before', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/api-log?beforeId=00000000-0000-4000-8000-000000000001', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it('returns 400 when before is not a date', async () => {
    const app = new Hono().route(
      '/debug/api-log',
      debugApiLogRoutes({ store: new InMemoryApiLogStore(), debugToken: 'secret' }),
    );
    const res = await app.request(
      '/debug/api-log?before=yesterday&beforeId=00000000-0000-4000-8000-000000000001',
      { headers: { authorization: 'Bearer secret' } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });
});
