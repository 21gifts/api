import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { logEvent, requestLog } from '@/lib/log';

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
