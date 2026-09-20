import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryApiLogStore, type ApiLogRow } from '@/lib/api-log';
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
        },
      ],
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.api_log.listed')).toBe(true);
  });

  it('returns 503 when the store throws', async () => {
    const store = {
      append: async () => undefined,
      listLatest: async () => {
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
});
