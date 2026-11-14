import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_LEVEL,
  checkOperator,
  requireOperator,
  type OperatorLevel,
  type OperatorTokens,
} from '@/lib/operator';
import type { DebugDbStore } from '@/lib/debug-db';
import { createApp } from '@/server';

const WRITE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const READ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID = '00000000-0000-4000-8000-000000000001';

/** The seven debug routes that declare `admin`. */
const ADMIN_ROUTES = [
  'PATCH /debug/accounts/:id',
  'POST /debug/accounts/:id/session',
  'POST /debug/accounts/merge',
  'DELETE /debug/sessions',
  'POST /debug/invoices/settle',
  'POST /debug/push-broadcast',
  'POST /debug/shop-keys',
];

/** The only debug routes `DEBUG_READ_TOKEN` opens. */
const READ_TOKEN_DEBUG_ROUTES = ['GET /debug/db', 'GET /debug/accounts/:id/wallet'];

/** Staff GET routes and operator-only reads that `DEBUG_READ_TOKEN` opens. */
const READ_TOKEN_STAFF_PATHS = [
  '/funding/goal',
  '/funding/applications',
  `/funding/applications/${ID}`,
  '/funding/payout-days',
  '/funding/daily-roster',
  '/funding/daily-roster/links',
  '/funding/withdrawals',
  '/trust/proposals',
  `/members/${ID}/activity`,
  '/messages/hidden',
  `/messages/${ID}/edits`,
];

async function refusedFetch(): Promise<Response> {
  throw new Error('no network in this test');
}

/** An app with every debug route mounted (the shop proof route needs the LNURL server). */
function fullApp(tokens: { debugToken?: string; debugReadToken?: string }): Hono {
  return createApp({
    env: { LNURL_SERVER_URL: 'https://lnurl.example', PUBLIC_BASE_URL: 'https://api.example' },
    fetchImpl: refusedFetch,
    ...tokens,
  });
}

/** Every registered debug route (not middleware-only entries) with its declared levels. */
function debugRoutes(app: Hono): Map<string, OperatorLevel[]> {
  const routes = new Map<string, OperatorLevel[]>();
  for (const route of app.routes) {
    if (!route.path.startsWith('/debug') || route.method === 'ALL') {
      continue;
    }
    const key = `${route.method} ${route.path}`;
    const levels = routes.get(key) ?? [];
    const level = levelOf(route.handler);
    if (level !== undefined) {
      levels.push(level);
    }
    routes.set(key, levels);
  }
  return routes;
}

/** Level a handler declares through {@link requireOperator}, if any. */
function levelOf(handler: unknown): OperatorLevel | undefined {
  return (handler as Partial<Record<typeof OPERATOR_LEVEL, OperatorLevel>>)[OPERATOR_LEVEL];
}

function concretePath(path: string): string {
  return path
    .replace(':accountId', ID)
    .replace(':id', ID)
    .replace(':table', 'account')
    .replace(':file', '1');
}

async function call(app: Hono, key: string, bearer: string | undefined): Promise<Response> {
  const [method, path] = key.split(' ') as [string, string];
  return app.request(concretePath(path), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });
}

/** Assert that a response did not come from the operator check (401 or 503 not configured). */
async function expectPastGate(key: string, res: Response): Promise<void> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  expect([key, res.status]).not.toEqual([key, 401]);
  expect([key, body?.error]).not.toEqual([key, 'Debug is not configured']);
}

describe('checkOperator grants', () => {
  it('refuses as unconfigured when both tokens are empty', () => {
    expect(checkOperator('read', {}, `Bearer ${WRITE}`)).toBe('unconfigured');
    expect(
      checkOperator('read', { debugToken: '  ', debugReadToken: '  ' }, `Bearer ${WRITE}`),
    ).toBe('unconfigured');
  });

  it('grants admin when the bearer matches the write token', () => {
    expect(
      checkOperator('admin', { debugToken: WRITE, debugReadToken: READ }, `Bearer ${WRITE}`),
    ).toBe(true);
    expect(checkOperator('admin', { debugToken: WRITE }, `Bearer ${WRITE}`)).toBe(true);
  });

  it('grants read when the bearer matches the read token', () => {
    expect(
      checkOperator('read', { debugToken: WRITE, debugReadToken: READ }, `Bearer ${READ}`),
    ).toBe(true);
    expect(checkOperator('read', { debugReadToken: READ }, `Bearer ${READ}`)).toBe(true);
  });

  it('refuses as unauthorized when the bearer matches neither configured token', () => {
    expect(checkOperator('read', { debugToken: WRITE, debugReadToken: READ }, 'Bearer other')).toBe(
      'unauthorized',
    );
    expect(checkOperator('read', { debugToken: WRITE }, 'Bearer other')).toBe('unauthorized');
    expect(checkOperator('read', { debugReadToken: READ }, 'Bearer other')).toBe('unauthorized');
    expect(checkOperator('read', { debugToken: WRITE, debugReadToken: READ }, undefined)).toBe(
      'unauthorized',
    );
  });

  it('does not accept the read token where the route is not given it', () => {
    expect(checkOperator('read', { debugToken: WRITE }, `Bearer ${READ}`)).toBe('unauthorized');
  });
});

describe('checkOperator', () => {
  const tokens: OperatorTokens = { debugToken: WRITE, debugReadToken: READ };

  it('passes the write or the read token at read', () => {
    expect(checkOperator('read', tokens, `Bearer ${WRITE}`)).toBe(true);
    expect(checkOperator('read', tokens, `Bearer ${READ}`)).toBe(true);
  });

  it('refuses a wrong bearer, a missing header, or no configured token', () => {
    expect(checkOperator('read', tokens, 'Bearer other')).toBe('unauthorized');
    expect(checkOperator('read', tokens, undefined)).toBe('unauthorized');
    expect(checkOperator('read', {}, `Bearer ${WRITE}`)).toBe('unconfigured');
  });

  it('passes the write token at every level', () => {
    for (const level of ['read', 'write', 'admin'] as const) {
      expect(checkOperator(level, tokens, `Bearer ${WRITE}`)).toBe(true);
    }
  });

  it('refuses the read token above read', () => {
    expect(checkOperator('write', tokens, `Bearer ${READ}`)).toBe('unauthorized');
    expect(checkOperator('admin', tokens, `Bearer ${READ}`)).toBe('unauthorized');
  });
});

describe('requireOperator', () => {
  function app(level: OperatorLevel, tokens: OperatorTokens): Hono {
    return new Hono().get('/', requireOperator(level, tokens), (c) => c.json({ ok: true }, 200));
  }

  it('answers 503 when no token is configured', async () => {
    const res = await app('read', { debugToken: ' ' }).request('/', {
      headers: { authorization: `Bearer ${WRITE}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('answers 401 for a wrong bearer', async () => {
    const res = await app('read', { debugToken: WRITE }).request('/', {
      headers: { authorization: 'Bearer other' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('lets the write token through at every level', async () => {
    for (const level of ['read', 'write', 'admin'] as const) {
      const res = await app(level, { debugToken: WRITE }).request('/', {
        headers: { authorization: `Bearer ${WRITE}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it('answers 401 for the read token above read', async () => {
    const tokens = { debugToken: WRITE, debugReadToken: READ };
    expect(
      (await app('read', tokens).request('/', { headers: { authorization: `Bearer ${READ}` } }))
        .status,
    ).toBe(200);
    for (const level of ['write', 'admin'] as const) {
      const res = await app(level, tokens).request('/', {
        headers: { authorization: `Bearer ${READ}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it('reads the tokens on every request', async () => {
    const tokens: OperatorTokens = { debugToken: undefined };
    const route = app('read', tokens);
    const headers = { authorization: `Bearer ${WRITE}` };
    expect((await route.request('/', { headers })).status).toBe(503);
    tokens.debugToken = WRITE;
    expect((await route.request('/', { headers })).status).toBe(200);
  });

  it('hands the refusal to onRefused', async () => {
    const route = new Hono().get(
      '/',
      requireOperator(
        'read',
        { debugToken: WRITE },
        {
          onRefused: async (c, next, refuse) => {
            if (c.req.header('x-pass') === '1') {
              await next();
              return;
            }
            return refuse();
          },
        },
      ),
      (c) => c.json({ ok: true }, 200),
    );
    expect((await route.request('/', { headers: { 'x-pass': '1' } })).status).toBe(200);
    const refused = await route.request('/');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('OPERATOR_LEVEL', () => {
  it('carries the declared level of a requireOperator middleware', () => {
    expect(levelOf(requireOperator('write', {}))).toBe('write');
  });

  it('is absent on any other handler', () => {
    expect(levelOf(() => undefined)).toBeUndefined();
  });
});

describe('debug route levels', () => {
  const routes = debugRoutes(fullApp({ debugToken: WRITE, debugReadToken: READ }));

  it('finds the debug routes', () => {
    expect(routes.size).toBeGreaterThan(40);
  });

  it('declares exactly one level on every debug route', () => {
    const undeclared = [...routes].filter(([, levels]) => levels.length !== 1).map(([k]) => k);
    expect(undeclared).toEqual([]);
  });

  it('declares admin on exactly the seven admin routes', () => {
    const admin = [...routes].filter(([, levels]) => levels[0] === 'admin').map(([k]) => k);
    expect(admin.sort()).toEqual([...ADMIN_ROUTES].sort());
  });

  it('declares read on every GET and write on every other method outside the admin routes', () => {
    for (const [key, levels] of routes) {
      if (ADMIN_ROUTES.includes(key)) {
        continue;
      }
      expect([key, levels[0]]).toEqual([key, key.startsWith('GET ') ? 'read' : 'write']);
    }
  });
});

describe('operator tokens across the app', () => {
  const app = fullApp({ debugToken: WRITE, debugReadToken: READ });
  const routes = [...debugRoutes(app).keys()];

  it('lets DEBUG_TOKEN past the operator check of every debug route', async () => {
    for (const key of routes) {
      await expectPastGate(key, await call(app, key, WRITE));
    }
  });

  it('opens only GET /debug/db and the account wallet to DEBUG_READ_TOKEN', async () => {
    for (const key of routes) {
      const res = await call(app, key, READ);
      if (READ_TOKEN_DEBUG_ROUTES.includes(key)) {
        await expectPastGate(key, res);
      } else {
        expect([key, res.status]).toEqual([key, 401]);
      }
    }
  });

  it('opens HEAD on GET /debug/db and the account wallet to DEBUG_READ_TOKEN', async () => {
    const store: DebugDbStore = {
      listTables: async () => [],
      readPage: async () => undefined,
    };
    const withStore = createApp({
      env: { LNURL_SERVER_URL: 'https://lnurl.example', PUBLIC_BASE_URL: 'https://api.example' },
      fetchImpl: refusedFetch,
      debugToken: WRITE,
      debugReadToken: READ,
      debugDbStore: store,
    });
    expect((await call(withStore, 'HEAD /debug/db', READ)).status).toBe(200);
    // An unknown account answers 404 only after the operator check passed.
    expect((await call(withStore, 'HEAD /debug/accounts/:id/wallet', READ)).status).toBe(404);
    const wallet = await call(withStore, 'GET /debug/accounts/:id/wallet', READ);
    expect(wallet.status).toBe(404);
    expect(await wallet.json()).toEqual({ error: 'Not found' });
    expect((await call(withStore, 'HEAD /debug/db', 'other')).status).toBe(401);
    expect((await call(withStore, 'HEAD /debug/accounts/:id/wallet', 'other')).status).toBe(401);
  });

  it('answers 503 on the write-token debug routes when only DEBUG_READ_TOKEN is set', async () => {
    const readOnly = fullApp({ debugToken: '', debugReadToken: READ });
    for (const key of routes) {
      const res = await call(readOnly, key, READ);
      if (READ_TOKEN_DEBUG_ROUTES.includes(key)) {
        await expectPastGate(key, res);
      } else {
        expect([key, res.status]).toEqual([key, 503]);
      }
    }
  });

  it('opens the staff and operator reads to DEBUG_READ_TOKEN and refuses a wrong bearer', async () => {
    for (const path of READ_TOKEN_STAFF_PATHS) {
      const read = await app.request(path, { headers: { authorization: `Bearer ${READ}` } });
      expect([path, read.status]).not.toEqual([path, 401]);
      const wrong = await app.request(path, { headers: { authorization: 'Bearer other' } });
      expect([path, wrong.status]).toEqual([path, 401]);
    }
  });
});
