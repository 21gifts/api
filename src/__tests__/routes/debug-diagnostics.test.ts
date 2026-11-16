import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryDiagnosticStore, type DiagnosticStore } from '@/lib/diagnostic-log';
import { debugDiagnosticsRoutes } from '@/routes/debug-diagnostics';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';

const OP_KEYS = await seededOperatorLogin();
const OP_READ = OP_KEYS.tokens.read;
const UNCONFIGURED = new OperatorLogin({
  signers: null,
  store: new InMemoryOperatorLoginStore(),
  now: Date.now,
});

describe('debugDiagnosticsRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function debugApp(store: DiagnosticStore, operatorLogin: OperatorLogin | undefined): Hono {
    return new Hono().route('/debug/diagnostics', debugDiagnosticsRoutes({ store, operatorLogin }));
  }

  it('returns 503 without a key login', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), undefined).request(
      '/debug/diagnostics',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the key login is not configured', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), UNCONFIGURED).request(
      '/debug/diagnostics',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 without a bearer', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), OP_KEYS.operatorLogin).request(
      '/debug/diagnostics',
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await debugApp(new InMemoryDiagnosticStore(), OP_KEYS.operatorLogin).request(
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
    const res = await debugApp(store, OP_KEYS.operatorLogin).request('/debug/diagnostics', {
      headers: { authorization: `Bearer ${OP_READ}` },
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
    const res = await debugApp(store, OP_KEYS.operatorLogin).request('/debug/diagnostics', {
      headers: { authorization: `Bearer ${OP_READ}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Log is unavailable' });
  });
});
