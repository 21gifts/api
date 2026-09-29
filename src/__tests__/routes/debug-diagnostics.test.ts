import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryDiagnosticStore, type DiagnosticStore } from '@/lib/diagnostic-log';
import { debugDiagnosticsRoutes } from '@/routes/debug-diagnostics';

describe('debugDiagnosticsRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function debugApp(store: DiagnosticStore, debugToken: string | undefined): Hono {
    return new Hono().route('/debug/diagnostics', debugDiagnosticsRoutes({ store, debugToken }));
  }

  it('returns 503 when debugToken is undefined', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), undefined).request(
      '/debug/diagnostics',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when debugToken is blank', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), '').request('/debug/diagnostics');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 without a bearer', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), 'secret').request(
      '/debug/diagnostics',
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), 'secret').request(
      '/debug/diagnostics',
      { headers: { authorization: 'Bearer nope' } },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('lists logs newest-first for a valid bearer', async () => {
    const store = new InMemoryDiagnosticStore();
    await store.append({
      id: 'old',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      source: 'client',
      event: 'client.a',
      fields: { n: 1 },
    });
    await store.append({
      id: 'new',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      source: 'server',
      event: 'server.b',
      fields: {},
    });
    const res = await debugApp(store, 'secret').request('/debug/diagnostics', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      logs: [
        {
          id: 'new',
          createdAt: '2026-01-02T00:00:00.000Z',
          source: 'server',
          event: 'server.b',
          fields: {},
        },
        {
          id: 'old',
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'client',
          event: 'client.a',
          fields: { n: 1 },
        },
      ],
    });
  });

  it('returns 503 when listLatest throws', async () => {
    const store: DiagnosticStore = {
      append: async () => undefined,
      listLatest: async () => {
        throw new Error('disk');
      },
    };
    const res = await debugApp(store, 'secret').request('/debug/diagnostics', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Log is unavailable' });
  });
});
