import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryApiLogStore } from '@/lib/api-log';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { errorLogFields, logEvent, requestLog, requestLogPath } from '@/lib/log';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('logEvent', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('writes ts and event with no extra fields', () => {
    logEvent('x');
    expect(warn).toHaveBeenCalledTimes(1);
    const events = parsedEvents(warn);
    expect(events).toHaveLength(1);
    const line = events[0];
    expect(line).toBeDefined();
    expect(typeof line?.['ts']).toBe('string');
    expect(new Date(line?.['ts'] as string).toISOString()).toBe(line?.['ts']);
    expect(line?.['event']).toBe('x');
    expect(Object.keys(line ?? {}).sort()).toEqual(['event', 'ts']);
  });

  it('round-trips extra fields with correct types', () => {
    logEvent('auth.login.ok', { accountId: 'acc', firstLogin: true });
    const events = parsedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]?.['event']).toBe('auth.login.ok');
    expect(events[0]?.['accountId']).toBe('acc');
    expect(events[0]?.['firstLogin']).toBe(true);
  });
});

describe('errorLogFields', () => {
  it('keeps the measured Bun SQL error scalars and drops the message', () => {
    const error = Object.assign(new Error('invalid input syntax for type uuid: "secret-value"'), {
      name: 'PostgresError',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '22P02',
    });
    const fields = errorLogFields(error);
    expect(fields).toEqual({
      name: 'PostgresError',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '22P02',
    });
    expect(JSON.stringify(fields)).not.toContain('secret-value');
  });

  it('keeps code and errno from a plain object', () => {
    expect(errorLogFields({ code: 'ECONNRESET', errno: '08006' })).toEqual({
      code: 'ECONNRESET',
      errno: '08006',
    });
  });

  it('drops names, codes, and errnos outside the allowlist', () => {
    const error = Object.assign(new Error('boom'), {
      name: 'Bad Name: https://pay.example/cb?k=1',
      code: 'has space',
      errno: -61,
    });
    expect(errorLogFields(error)).toEqual({});
    expect(errorLogFields({ code: 'x'.repeat(41), errno: 'y'.repeat(41) })).toEqual({});
  });

  it('returns no fields for primitives and null', () => {
    expect(errorLogFields('invalid input syntax for type uuid: "secret-value"')).toEqual({});
    expect(errorLogFields(null)).toEqual({});
    expect(errorLogFields(undefined)).toEqual({});
  });
});

describe('requestLogPath', () => {
  it('leaves /info unchanged', () => {
    expect(requestLogPath('/info')).toBe('/info');
  });

  it('redacts a 64-hex view key segment', () => {
    expect(requestLogPath('/view/' + 'a'.repeat(64))).toBe('/view/:viewKey');
  });

  it('redacts a non-key single segment after /view/', () => {
    expect(requestLogPath('/view/not-a-key')).toBe('/view/:viewKey');
  });

  it('leaves /view without a segment unchanged', () => {
    expect(requestLogPath('/view')).toBe('/view');
  });

  it('redacts a trailing slash after the view-key segment', () => {
    expect(requestLogPath('/view/' + 'a'.repeat(64) + '/')).toBe('/view/:viewKey/');
  });

  it('redacts extra segments after the view-key segment', () => {
    expect(requestLogPath('/view/a/b')).toBe('/view/:viewKey/b');
  });

  it('leaves unrelated paths unchanged', () => {
    expect(requestLogPath('/preview/x')).toBe('/preview/x');
  });
});

describe('requestLog', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function appWithRequestLog(store = new InMemoryApiLogStore()): Hono {
    const app = new Hono();
    app.use(
      '*',
      requestLog({
        apiLogStore: store,
        authStore: new InMemoryAuthStore(),
        debugToken: undefined,
        spendApiToken: undefined,
      }),
    );
    app.get('/healthz', (c) => c.text('ok'));
    app.get('/info', (c) => c.text('info'));
    app.options('/info', (c) => c.body(null, 204));
    app.get('/view/:viewKey', (c) => c.json({ error: 'Not found' }, 404));
    return app;
  }

  it('skips http.request for GET /healthz', async () => {
    const store = new InMemoryApiLogStore();
    await appWithRequestLog(store).request('/healthz');
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
    expect(await store.listLatest(10)).toEqual([]);
  });

  it('skips http.request for OPTIONS', async () => {
    await appWithRequestLog().request('/info', { method: 'OPTIONS' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('emits http.request for GET /info', async () => {
    const store = new InMemoryApiLogStore();
    await appWithRequestLog(store).request('/info');
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    const line = httpEvents[0];
    expect(line?.['method']).toBe('GET');
    expect(line?.['path']).toBe('/info');
    expect(typeof line?.['status']).toBe('number');
    expect(Number.isInteger(line?.['ms'])).toBe(true);
    const rows = await store.listLatest(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.method).toBe('GET');
    expect(rows[0]?.path).toBe('/info');
    expect(rows[0]?.authKind).toBe('none');
    expect(rows[0]?.accountId).toBeNull();
  });

  it('emits http.request for GET /view/<64-hex> with redacted path', async () => {
    const key = 'a'.repeat(64);
    await appWithRequestLog().request('/view/' + key);
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    expect(httpEvents[0]?.['path']).toBe('/view/:viewKey');
    const raw = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))[0];
    expect(raw).toBeDefined();
    expect(raw).not.toContain(key);
  });

  it('logs api_log.write.failed when append throws and keeps the response', async () => {
    const store = {
      append: async () => {
        throw new Error('disk');
      },
      listLatest: async () => [],
    };
    const app = new Hono();
    app.use(
      '*',
      requestLog({
        apiLogStore: store,
        authStore: new InMemoryAuthStore(),
        debugToken: undefined,
        spendApiToken: undefined,
      }),
    );
    app.get('/info', (c) => c.text('info'));
    const res = await app.request('/info');
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'api_log.write.failed')).toBe(true);
  });

  it('omits the query string from path and the JSON line', async () => {
    await appWithRequestLog().request('/info?sig=secret&key=leak');
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    expect(httpEvents[0]?.['path']).toBe('/info');
    const raw = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))[0];
    expect(raw).toBeDefined();
    expect(raw).not.toContain('?');
    expect(raw).not.toContain('sig');
    expect(raw).not.toContain('key');
  });
});
