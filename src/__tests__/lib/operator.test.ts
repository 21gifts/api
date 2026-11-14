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
import { OperatorLogin } from '@/lib/operator-login';
import { createApp } from '@/server';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';

const WRITE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STATIC_READ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const keys = await seededOperatorLogin();
const READ = keys.tokens.read;
const WRITE_KEY = keys.tokens.write;
const ADMIN_KEY = keys.tokens.admin;
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

/** Staff GET routes and operator-only reads that a `read` key token opens. */
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
function fullApp(debugToken: string, withKeys = true): Hono {
  return createApp({
    env: { LNURL_SERVER_URL: 'https://lnurl.example', PUBLIC_BASE_URL: 'https://api.example' },
    fetchImpl: refusedFetch,
    debugToken,
    operatorSigners: withKeys ? keys.operatorSigners : null,
    operatorLoginStore: keys.operatorLoginStore,
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

/** Assert that a response did not come from the operator check (401, 403, or 503 not configured). */
async function expectPastGate(key: string, res: Response): Promise<void> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  expect([key, res.status]).not.toEqual([key, 401]);
  expect([key, body?.error]).not.toEqual([key, 'Forbidden']);
  expect([key, body?.error]).not.toEqual([key, 'Debug is not configured']);
}

describe('checkOperator grants', () => {
  const login = keys.operatorLogin;

  it('refuses as unconfigured when neither DEBUG_TOKEN nor a key login is configured', async () => {
    expect(await checkOperator('read', {}, `Bearer ${WRITE}`)).toBe('unconfigured');
    expect(await checkOperator('read', { debugToken: '  ' }, `Bearer ${WRITE}`)).toBe(
      'unconfigured',
    );
    const unloaded = new OperatorLogin({
      signers: null,
      store: keys.operatorLoginStore,
      now: Date.now,
    });
    expect(await checkOperator('read', { operatorLogin: unloaded }, `Bearer ${READ}`)).toBe(
      'unconfigured',
    );
  });

  it('grants admin when the bearer matches DEBUG_TOKEN', async () => {
    expect(await checkOperator('admin', { debugToken: WRITE }, `Bearer ${WRITE}`)).toBe(true);
    expect(
      await checkOperator('admin', { debugToken: WRITE, operatorLogin: login }, `Bearer ${WRITE}`),
    ).toBe(true);
  });

  it('grants a key token its own level and the levels below it', async () => {
    const tokens: OperatorTokens = { operatorLogin: login };
    expect(await checkOperator('read', tokens, `Bearer ${READ}`)).toBe(true);
    expect(await checkOperator('read', tokens, `Bearer ${WRITE_KEY}`)).toBe(true);
    expect(await checkOperator('write', tokens, `Bearer ${WRITE_KEY}`)).toBe(true);
    for (const level of ['read', 'write', 'admin'] as const) {
      expect(await checkOperator(level, tokens, `Bearer ${ADMIN_KEY}`)).toBe(true);
    }
  });

  it('refuses a key token below the required level as forbidden', async () => {
    const tokens: OperatorTokens = { debugToken: WRITE, operatorLogin: login };
    expect(await checkOperator('write', tokens, `Bearer ${READ}`)).toBe('forbidden');
    expect(await checkOperator('admin', tokens, `Bearer ${READ}`)).toBe('forbidden');
    expect(await checkOperator('admin', tokens, `Bearer ${WRITE_KEY}`)).toBe('forbidden');
  });

  it('refuses as unauthorized when the bearer matches no credential', async () => {
    const tokens: OperatorTokens = { debugToken: WRITE, operatorLogin: login };
    expect(await checkOperator('read', tokens, 'Bearer other')).toBe('unauthorized');
    expect(await checkOperator('read', tokens, `Bearer op_${'z'.repeat(43)}`)).toBe('unauthorized');
    expect(await checkOperator('read', tokens, undefined)).toBe('unauthorized');
    expect(await checkOperator('read', { debugToken: WRITE }, `Bearer ${READ}`)).toBe(
      'unauthorized',
    );
  });
});

describe('requireOperator', () => {
  function app(level: OperatorLevel, tokens: OperatorTokens): Hono {
    return new Hono().get('/', requireOperator(level, tokens), (c) => c.json({ ok: true }, 200));
  }

  it('answers 503 when no credential is configured', async () => {
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

  it('lets DEBUG_TOKEN through at every level', async () => {
    for (const level of ['read', 'write', 'admin'] as const) {
      const res = await app(level, { debugToken: WRITE }).request('/', {
        headers: { authorization: `Bearer ${WRITE}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it('answers 403 for a key token below the declared level', async () => {
    const tokens = { debugToken: WRITE, operatorLogin: keys.operatorLogin };
    expect(
      (await app('read', tokens).request('/', { headers: { authorization: `Bearer ${READ}` } }))
        .status,
    ).toBe(200);
    for (const level of ['write', 'admin'] as const) {
      const res = await app(level, tokens).request('/', {
        headers: { authorization: `Bearer ${READ}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
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
  const routes = debugRoutes(fullApp(WRITE));

  it('finds the debug routes', () => {
    expect(routes.size).toBeGreaterThan(40);
  });

  it('declares exactly one level on every debug route except the two login routes', () => {
    const undeclared = [...routes].filter(([, levels]) => levels.length !== 1).map(([k]) => k);
    expect(undeclared.sort()).toEqual(['GET /debug/auth/challenge', 'POST /debug/auth']);
  });

  it('declares admin on exactly the seven admin routes', () => {
    const admin = [...routes].filter(([, levels]) => levels[0] === 'admin').map(([k]) => k);
    expect(admin.sort()).toEqual([...ADMIN_ROUTES].sort());
  });

  it('declares read on every GET and write on every other method outside the admin routes', () => {
    for (const [key, levels] of routes) {
      if (
        ADMIN_ROUTES.includes(key) ||
        key.startsWith('GET /debug/auth') ||
        key === 'POST /debug/auth'
      ) {
        continue;
      }
      expect([key, levels[0]]).toEqual([key, key.startsWith('GET ') ? 'read' : 'write']);
    }
  });
});

describe('operator tokens across the app', () => {
  const app = fullApp(WRITE);
  const routes = [...debugRoutes(app).keys()].filter((key) => !key.includes('/debug/auth'));
  const levels = debugRoutes(app);

  it('lets DEBUG_TOKEN past the operator check of every debug route', async () => {
    for (const key of routes) {
      await expectPastGate(key, await call(app, key, WRITE));
    }
  });

  it('lets each key token past every route its level covers and answers 403 above it', async () => {
    const byLevel = { read: READ, write: WRITE_KEY, admin: ADMIN_KEY } as const;
    for (const [tokenLevel, token] of Object.entries(byLevel)) {
      for (const key of routes) {
        const declared = levels.get(key)?.[0] as OperatorLevel;
        const res = await call(app, key, token);
        const covers =
          ['read', 'write', 'admin'].indexOf(tokenLevel) >=
          ['read', 'write', 'admin'].indexOf(declared);
        if (covers) {
          await expectPastGate(key, res);
        } else {
          expect([tokenLevel, key, res.status]).toEqual([tokenLevel, key, 403]);
        }
      }
    }
  });

  it('opens HEAD on every GET debug route to a read key token', async () => {
    const store: DebugDbStore = {
      listTables: async () => [],
      readPage: async () => undefined,
    };
    const withStore = createApp({
      env: { LNURL_SERVER_URL: 'https://lnurl.example', PUBLIC_BASE_URL: 'https://api.example' },
      fetchImpl: refusedFetch,
      debugToken: WRITE,
      operatorSigners: keys.operatorSigners,
      operatorLoginStore: keys.operatorLoginStore,
      debugDbStore: store,
    });
    expect((await call(withStore, 'HEAD /debug/db', READ)).status).toBe(200);
    // An unknown account answers 404 only after the operator check passed.
    expect((await call(withStore, 'HEAD /debug/accounts/:id/wallet', READ)).status).toBe(404);
    for (const key of routes.filter((k) => k.startsWith('GET '))) {
      const res = await call(withStore, key.replace('GET ', 'HEAD '), READ);
      expect([key, res.status]).not.toEqual([key, 401]);
      expect([key, res.status]).not.toEqual([key, 403]);
    }
    expect((await call(withStore, 'HEAD /debug/db', 'other')).status).toBe(401);
  });

  it('answers 401 on every debug route without DEBUG_TOKEN when the key login is loaded', async () => {
    const keysOnly = fullApp('');
    for (const key of routes) {
      const res = await call(keysOnly, key, 'other');
      expect([key, res.status]).toEqual([key, 401]);
      await expectPastGate(key, await call(keysOnly, key, ADMIN_KEY));
    }
  });

  it('answers 503 on every debug route without DEBUG_TOKEN and without the key login', async () => {
    const off = fullApp('', false);
    for (const key of routes) {
      expect([key, (await call(off, key, READ)).status]).toEqual([key, 503]);
    }
  });

  it('opens the staff and operator reads to a read key token and refuses a wrong bearer', async () => {
    for (const path of READ_TOKEN_STAFF_PATHS) {
      const read = await app.request(path, { headers: { authorization: `Bearer ${READ}` } });
      expect([path, read.status]).not.toEqual([path, 401]);
      const wrong = await app.request(path, { headers: { authorization: 'Bearer other' } });
      expect([path, wrong.status]).toEqual([path, 401]);
    }
  });

  it('no longer opens anything to a DEBUG_READ_TOKEN value', async () => {
    const saved = process.env['DEBUG_READ_TOKEN'];
    process.env['DEBUG_READ_TOKEN'] = STATIC_READ;
    try {
      const withEnv = createApp({
        env: {
          LNURL_SERVER_URL: 'https://lnurl.example',
          PUBLIC_BASE_URL: 'https://api.example',
          DEBUG_READ_TOKEN: STATIC_READ,
        },
        fetchImpl: refusedFetch,
        debugToken: WRITE,
        operatorSigners: keys.operatorSigners,
        operatorLoginStore: keys.operatorLoginStore,
      });
      for (const key of [...debugRoutes(withEnv).keys()].filter(
        (k) => !k.includes('/debug/auth'),
      )) {
        expect([key, (await call(withEnv, key, STATIC_READ)).status]).toEqual([key, 401]);
      }
      for (const path of READ_TOKEN_STAFF_PATHS) {
        const res = await withEnv.request(path, {
          headers: { authorization: `Bearer ${STATIC_READ}` },
        });
        expect([path, res.status]).toEqual([path, 401]);
      }
    } finally {
      if (saved === undefined) {
        delete process.env['DEBUG_READ_TOKEN'];
      } else {
        process.env['DEBUG_READ_TOKEN'] = saved;
      }
    }
  });
});
