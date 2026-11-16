import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { debugPasskeyRenewRoutes } from '@/routes/debug-passkey-renew';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';

const OP_KEYS = await seededOperatorLogin();
const OP_WRITE = OP_KEYS.tokens.write;
const UNCONFIGURED = new OperatorLogin({
  signers: null,
  store: new InMemoryOperatorLoginStore(),
  now: Date.now,
});

const LINKING_KEY = `02${'a'.repeat(64)}`;
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

function mount(args: {
  authStore?: InMemoryAuthStore;
  operatorLogin?: OperatorLogin | undefined;
}): Hono {
  return new Hono().route(
    '/debug/passkey-renew',
    debugPasskeyRenewRoutes({
      authStore: args.authStore ?? new InMemoryAuthStore(),
      operatorLogin: args.operatorLogin,
    }),
  );
}

async function seededStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: ACCOUNT_ID,
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  return store;
}

const attempt = {
  createdAt: 1,
  stage: 'ceremony' as const,
  errorName: 'prfUnsupported',
  errorCode: null,
  httpStatus: null,
  message: null,
  userAgent: null,
};

async function post(app: Hono, body: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers['authorization'] = `Bearer ${token}`;
  }
  return app.request('/debug/passkey-renew/reopen', { method: 'POST', headers, body });
}

describe('POST /debug/passkey-renew/reopen', () => {
  it('returns 503 before JSON when debug is unset', async () => {
    const res = await post(mount({}), 'not-json', OP_WRITE);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 before JSON when the key login is not configured', async () => {
    const res = await post(mount({ operatorLogin: UNCONFIGURED }), 'not-json', OP_WRITE);
    expect(res.status).toBe(503);
  });

  it('returns 401 when the bearer is not a valid key token', async () => {
    const res = await post(mount({ operatorLogin: OP_KEYS.operatorLogin }), 'not-json', 'wrong');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 before JSON for a read key token', async () => {
    const res = await post(
      mount({ operatorLogin: OP_KEYS.operatorLogin }),
      'not-json',
      OP_KEYS.tokens.read,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 400 when the account id is not a uuid', async () => {
    const res = await post(
      mount({ operatorLogin: OP_KEYS.operatorLogin }),
      JSON.stringify({ accountId: 'acc' }),
      OP_WRITE,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid account' });
  });

  it('returns 400 when the body is not json', async () => {
    const res = await post(mount({ operatorLogin: OP_KEYS.operatorLogin }), 'not-json', OP_WRITE);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid account' });
  });

  it('returns 404 when the account is missing', async () => {
    const res = await post(
      mount({ operatorLogin: OP_KEYS.operatorLogin }),
      JSON.stringify({ accountId: ACCOUNT_ID }),
      OP_WRITE,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 409 and deletes nothing when a seed is already stored', async () => {
    const store = await seededStore();
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred-seed',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: ACCOUNT_ID,
        createdAt: 2,
      }),
    ).toBe(true);
    await store.insertPasskeyRenewAttempt({
      ...attempt,
      id: 'f1',
      accountId: ACCOUNT_ID,
      outcome: 'failed',
    });
    const res = await post(
      mount({ authStore: store, operatorLogin: OP_KEYS.operatorLogin }),
      JSON.stringify({ accountId: ACCOUNT_ID.toUpperCase() }),
      OP_WRITE,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Account already has a seed' });
    expect(await store.hasUnacknowledgedPasskeyRenewFailure(ACCOUNT_ID)).toBe(true);
  });

  it('deletes only failed rows and leaves cancelled rows', async () => {
    const store = await seededStore();
    await store.insertPasskeyRenewAttempt({
      ...attempt,
      id: 'c1',
      accountId: ACCOUNT_ID,
      outcome: 'cancelled',
    });
    await store.insertPasskeyRenewAttempt({
      ...attempt,
      id: 's1',
      accountId: ACCOUNT_ID,
      outcome: 'succeeded',
    });
    await store.insertPasskeyRenewAttempt({
      ...attempt,
      id: 'f1',
      accountId: ACCOUNT_ID,
      outcome: 'failed',
    });
    await store.acknowledgePasskeyRenewFailures(ACCOUNT_ID, 9);
    await store.insertPasskeyRenewAttempt({
      ...attempt,
      id: 'f2',
      accountId: '22222222-2222-4222-8222-222222222222',
      outcome: 'failed',
    });
    const res = await post(
      mount({ authStore: store, operatorLogin: OP_KEYS.operatorLogin }),
      JSON.stringify({ accountId: `  ${ACCOUNT_ID}  ` }),
      OP_WRITE,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(await store.hasAcknowledgedPasskeyRenewFailure(ACCOUNT_ID)).toBe(false);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure(ACCOUNT_ID)).toBe(false);
    expect(
      await store.hasUnacknowledgedPasskeyRenewFailure('22222222-2222-4222-8222-222222222222'),
    ).toBe(true);
  });

  it('returns zero when the account has no failed row', async () => {
    const store = await seededStore();
    const res = await post(
      mount({ authStore: store, operatorLogin: OP_KEYS.operatorLogin }),
      JSON.stringify({ accountId: ACCOUNT_ID }),
      OP_WRITE,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0 });
  });
});
