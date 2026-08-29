import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { logEvent, requestLog, requestLogPath } from '@/lib/log';

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

  it('leaves /view with extra segments unchanged', () => {
    expect(requestLogPath('/view/a/b')).toBe('/view/a/b');
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

  function appWithRequestLog(): Hono {
    const app = new Hono();
    app.use('*', requestLog());
    app.get('/healthz', (c) => c.text('ok'));
    app.get('/info', (c) => c.text('info'));
    app.options('/info', (c) => c.body(null, 204));
    app.get('/view/:viewKey', (c) => c.json({ error: 'Not found' }, 404));
    return app;
  }

  it('skips http.request for GET /healthz', async () => {
    await appWithRequestLog().request('/healthz');
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('skips http.request for OPTIONS', async () => {
    await appWithRequestLog().request('/info', { method: 'OPTIONS' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('emits http.request for GET /info', async () => {
    await appWithRequestLog().request('/info');
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    const line = httpEvents[0];
    expect(line?.['method']).toBe('GET');
    expect(line?.['path']).toBe('/info');
    expect(typeof line?.['status']).toBe('number');
    expect(Number.isInteger(line?.['ms'])).toBe(true);
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
