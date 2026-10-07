import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SqlClient } from '@/lib/auth/sql';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryPosStore } from '@/lib/pos-store';
import type { WalletStore } from '@/lib/wallet-store';
import { InMemoryWalletStore, PostgresWalletStore } from '@/lib/wallet-store';
import { WALLET_REPORT_BODY_LIMIT_BYTES, walletReportRoutes } from '@/routes/wallet-report';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'wallet-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const START = Date.parse('2026-10-01T12:00:00.000Z');

class CapturingSql implements SqlClient {
  readonly executes: Array<{ text: string; params: readonly unknown[] }> = [];

  query<T>(): Promise<T[]> {
    return Promise.resolve([]);
  }

  execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    return Promise.resolve();
  }
}

async function authStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: ACCOUNT,
    linkingKey: null,
    role: 'verified',
    name: 'Ada',
    location: null,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
  });
  await store.createSession({ token: TOKEN, accountId: ACCOUNT, createdAt: START });
  return store;
}

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { balanceSats: 100, syncedAt: new Date(START).toISOString(), payments: [], ...extra };
}

function reported(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    direction: 'out',
    status: 'pending',
    amountSats: 21,
    feeSats: 1,
    timestamp: new Date(START - 1_000).toISOString(),
    method: 'spark',
    ...extra,
  };
}

async function mount(
  options: {
    now?: () => number;
    walletStore?: WalletStore;
    posStore?: InMemoryPosStore;
    limiter?: IpRateLimiter;
    auth?: InMemoryAuthStore;
  } = {},
): Promise<{ app: Hono; walletStore: WalletStore }> {
  const walletStore = options.walletStore ?? new InMemoryWalletStore();
  const app = new Hono().route(
    '/',
    walletReportRoutes({
      authStore: options.auth ?? (await authStore()),
      walletStore,
      messages: new InMemoryMessageStore(),
      posStore: options.posStore ?? new InMemoryPosStore(),
      now: options.now ?? (() => START),
      ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    }),
  );
  return { app, walletStore };
}

async function post(
  app: Hono,
  value: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return app.request('/me/wallet/report', {
    method: 'POST',
    headers,
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /me/wallet/report', () => {
  it('returns 401 before reading the body for missing or invalid sessions', async () => {
    const { app } = await mount();
    const missing = await post(app, body(), { 'content-type': 'application/json' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    const invalid = await post(app, body(), { ...AUTH, authorization: 'Bearer wrong' });
    expect(invalid.status).toBe(401);
  });

  it('rate limits by account id and allows a new one-minute window', async () => {
    let now = START;
    const { app } = await mount({ now: () => now, limiter: new IpRateLimiter(1) });
    expect((await post(app, body())).status).toBe(200);
    const limited = await post(app, body());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
    now += 60_000;
    expect((await post(app, body())).status).toBe(200);
  });

  it('returns 413 for declared and streamed bodies above one MiB', async () => {
    const declaredApp = (await mount()).app;
    const declared = await declaredApp.request('/me/wallet/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-length': String(WALLET_REPORT_BODY_LIMIT_BYTES + 1) },
      body: '{}',
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'Request body is too large' });

    const streamApp = (await mount()).app;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(WALLET_REPORT_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const request = new Request('http://x/me/wallet/report', {
      method: 'POST',
      headers: AUTH,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const streamed = await streamApp.request(request);
    expect(streamed.status).toBe(413);
  });

  it('returns 400 for malformed JSON and invalid report envelopes', async () => {
    const first = await mount();
    const malformed = await post(first.app, '{');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid wallet report' });
    const second = await mount();
    const invalid = await post(second.app, { balanceSats: -1, syncedAt: 'bad' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid wallet report' });
  });

  it('stores a balance and acknowledges only valid payments', async () => {
    const { app, walletStore } = await mount();
    const response = await post(app, body({ payments: [reported(), { id: 'bad' }] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acknowledgedIds: ['p1'] });
    expect(await walletStore.latestBalance(ACCOUNT)).toMatchObject({
      accountId: ACCOUNT,
      balanceSats: 100,
      syncedAt: new Date(START),
      receivedAt: new Date(START),
    });
    expect(await walletStore.listPayments(ACCOUNT, 10)).toEqual([
      expect.objectContaining({ paymentId: 'p1', category: 'unknown' }),
    ]);
  });

  it('idempotently changes pending to completed while keeping firstSeenAt', async () => {
    let now = START;
    const walletStore = new InMemoryWalletStore();
    const { app } = await mount({ walletStore, now: () => now });
    expect((await post(app, body({ payments: [reported()] }))).status).toBe(200);
    now += 1_000;
    expect((await post(app, body({ payments: [reported({ status: 'completed' })] }))).status).toBe(
      200,
    );
    expect(await walletStore.listPayments(ACCOUNT, 10)).toEqual([
      expect.objectContaining({
        status: 'completed',
        firstSeenAt: new Date(START),
        updatedAt: new Date(START + 1_000),
      }),
    ]);
  });

  it('gives a later report in the same millisecond a strictly later observation time', async () => {
    const walletStore = new InMemoryWalletStore();
    const { app } = await mount({ walletStore, now: () => START });
    expect((await post(app, body({ payments: [reported()] }))).status).toBe(200);
    expect((await post(app, body({ payments: [reported({ status: 'completed' })] }))).status).toBe(
      200,
    );
    expect(await walletStore.listPayments(ACCOUNT, 10)).toEqual([
      expect.objectContaining({
        status: 'completed',
        firstSeenAt: new Date(START),
        updatedAt: new Date(START + 1),
      }),
    ]);
    expect((await walletStore.latestBalance(ACCOUNT))?.receivedAt).toEqual(new Date(START + 1));
  });

  it('keeps the observation clock per account and drops idle accounts after the window', async () => {
    let now = START;
    const auth = await authStore();
    const other = '22222222-2222-4222-8222-222222222222';
    await auth.createAccount({
      id: other,
      linkingKey: null,
      role: 'verified',
      name: 'Bea',
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
    });
    await auth.createSession({ token: 'other-token', accountId: other, createdAt: START });
    const otherAuth = { ...AUTH, authorization: 'Bearer other-token' };
    const walletStore = new InMemoryWalletStore();
    const { app } = await mount({ walletStore, auth, now: () => now });
    expect((await post(app, body({ payments: [reported()] }))).status).toBe(200);
    expect((await post(app, body({ payments: [reported()] }), otherAuth)).status).toBe(200);
    // Another account in the same millisecond is not pushed forward.
    expect((await walletStore.latestBalance(other))?.receivedAt).toEqual(new Date(START));
    now = START + 30_000;
    expect((await post(app, body({ payments: [reported()] }), otherAuth)).status).toBe(200);
    now = START + 61_000;
    // The sweep drops the first account (idle for a full window) and keeps the second.
    expect((await post(app, body({ payments: [reported()] }))).status).toBe(200);
    expect((await walletStore.latestBalance(ACCOUNT))?.receivedAt).toEqual(
      new Date(START + 61_000),
    );
  });

  it('deduplicates payment ids with the later entry winning and later-position order', async () => {
    const { app, walletStore } = await mount();
    const response = await post(
      app,
      body({
        payments: [
          reported({ id: 'same', status: 'pending' }),
          reported({ id: 'other' }),
          reported({ id: 'same', status: 'completed', amountSats: 42 }),
        ],
      }),
    );
    expect(await response.json()).toEqual({ acknowledgedIds: ['other', 'same'] });
    expect(
      (await walletStore.listPayments(ACCOUNT, 10)).find((row) => row.paymentId === 'same'),
    ).toMatchObject({ status: 'completed', amountSats: 42 });
  });

  it('returns 503 and logs only the account id when a classification lookup fails', async () => {
    class ThrowingPosStore extends InMemoryPosStore {
      override findChargeForPayment(): Promise<undefined> {
        return Promise.reject(new Error('lookup down'));
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app } = await mount({ posStore: new ThrowingPosStore() });
    const response = await post(
      app,
      body({ payments: [reported({ paymentHash: 'a'.repeat(64) })] }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Wallet data is unavailable' });
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        event: 'wallet_report.write.failed',
        accountId: ACCOUNT,
      }),
    );
    expect(line).not.toContain('lookup down');
  });

  it('returns 503 when persistence fails', async () => {
    class FailingWalletStore extends InMemoryWalletStore {
      override recordBalance(): Promise<void> {
        return Promise.reject(new Error('database down'));
      }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app } = await mount({ walletStore: new FailingWalletStore() });
    expect((await post(app, body())).status).toBe(503);
  });

  it('never stores or logs secret fields or secret-shaped allowed strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const phrase = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega';
    const nsec = `nsec1${'q'.repeat(58)}`;
    const sql = new CapturingSql();
    const { app } = await mount({ walletStore: new PostgresWalletStore(sql) });
    const response = await post(
      app,
      body({
        payments: [
          reported({
            description: phrase,
            lnurlComment: nsec,
            preimage: 'preimage-value',
            seed: 'seed-value',
            mnemonic: 'mnemonic-value',
            prf: 'prf-value',
            privateKey: 'private-value',
            nsec: 'nsec-field-value',
          }),
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(sql.executes).toHaveLength(2);
    expect(sql.executes[1]?.params.slice(11, 13)).toEqual([null, null]);
    const output = JSON.stringify({
      sql: sql.executes,
      warn: warn.mock.calls,
      error: error.mock.calls,
    });
    for (const secret of [
      phrase,
      nsec,
      'preimage-value',
      'seed-value',
      'mnemonic-value',
      'prf-value',
      'private-value',
      'nsec-field-value',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
