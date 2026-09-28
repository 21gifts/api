import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  InMemoryDiagnosticStore,
  type DiagnosticEvent,
  type DiagnosticStore,
} from '@/lib/diagnostic-log';
import { diagnosticsRoutes } from '@/routes/diagnostics';

const EVENT = 'client.passkey.register.begin';
const CHALLENGE_ID = 'ab'.repeat(32);
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

class RecordingStore implements DiagnosticStore {
  readonly inner = new InMemoryDiagnosticStore();
  failFirstClient = false;
  rejectRateLimited = false;
  rateLimitedCalls = 0;
  private clientSeen = false;

  async append(row: DiagnosticEvent): Promise<void> {
    if (row.event === 'diagnostics.rate_limited') {
      this.rateLimitedCalls += 1;
      if (this.rejectRateLimited) {
        throw new Error('disk');
      }
    }
    if (row.source === 'client' && this.failFirstClient && !this.clientSeen) {
      this.clientSeen = true;
      throw new Error('disk');
    }
    await this.inner.append(row);
  }

  listLatest(limit: number): Promise<DiagnosticEvent[]> {
    return this.inner.listLatest(limit);
  }
}

function mount(store: DiagnosticStore, now?: () => number): Hono {
  return new Hono().route(
    '/diagnostics',
    now === undefined ? diagnosticsRoutes({ store }) : diagnosticsRoutes({ store, now }),
  );
}

async function post(
  app: Hono,
  headers: Record<string, string> = {},
  body: unknown = { event: EVENT },
  raw?: string,
): Promise<Response> {
  return app.request('/diagnostics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

describe('diagnosticsRoutes', () => {
  let clock: number;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
  });

  it('defaults now to Date.now', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store);
    const res = await post(app);
    expect(res.status).toBe(204);
  });

  const invalidBodies: { name: string; body?: unknown; raw?: string }[] = [
    { name: 'invalid JSON', raw: 'not-json' },
    { name: 'JSON null', body: null },
    { name: 'JSON number', body: 1 },
    { name: 'JSON string', body: 'x' },
    { name: 'array body', body: [] },
    { name: 'extra key', body: { event: EVENT, nope: true } },
    { name: 'missing event', body: {} },
    { name: 'event not a string', body: { event: 1 } },
    { name: 'bad event', body: { event: 'not-an-event' } },
    { name: 'name not a string', body: { event: EVENT, name: 1 } },
    { name: 'bad name', body: { event: EVENT, name: 'Not Allowed' } },
    { name: 'message not a string', body: { event: EVENT, message: 1 } },
    { name: 'message with slash', body: { event: EVENT, message: 'a/b' } },
    { name: 'prfPresent not boolean', body: { event: EVENT, prfPresent: 'false' } },
    { name: 'challengeId not a string', body: { event: EVENT, challengeId: 1 } },
    { name: 'short challengeId', body: { event: EVENT, challengeId: 'ab' } },
    { name: 'accountId not a string', body: { event: EVENT, accountId: 1 } },
    { name: 'accountId not a uuid', body: { event: EVENT, accountId: 'not-a-uuid' } },
    { name: 'stage not a string', body: { event: EVENT, stage: 1 } },
    { name: 'bad stage', body: { event: EVENT, stage: 'nope' } },
    { name: 'status too small', body: { event: EVENT, status: 99 } },
    { name: 'status too large', body: { event: EVENT, status: 600 } },
    { name: 'status not integer', body: { event: EVENT, status: 10.5 } },
    { name: 'status not a number', body: { event: EVENT, status: '400' } },
    { name: 'path not a string', body: { event: EVENT, path: 1 } },
    { name: 'path with hex run', body: { event: EVENT, path: `/x/${'a'.repeat(32)}` } },
    { name: 'path with query', body: { event: EVENT, path: '/login?x=1' } },
  ];
  it.each(invalidBodies)('returns 400 for $name', async (tc) => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const res = await post(app, {}, tc.body, tc.raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid diagnostics' });
    expect(await store.listLatest(10)).toHaveLength(0);
  });

  it('accepts an allowlisted event with an empty 204 body and no userAgent', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const res = await post(app);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const rows = await store.listLatest(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('client');
    expect(rows[0]?.event).toBe(EVENT);
    expect(rows[0]?.fields).toEqual({});
  });

  it('stores optional allowlisted fields', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const res = await post(
      app,
      {},
      {
        event: EVENT,
        name: 'NotAllowedError',
        message: 'Failed to finish passkey registration: 400',
        prfPresent: false,
        challengeId: CHALLENGE_ID,
        accountId: ACCOUNT_ID,
        stage: 'register',
        status: 400,
        path: '/login',
      },
    );
    expect(res.status).toBe(204);
    expect((await store.listLatest(1))[0]?.fields).toEqual({
      name: 'NotAllowedError',
      message: 'Failed to finish passkey registration: 400',
      prfPresent: false,
      challengeId: CHALLENGE_ID,
      accountId: ACCOUNT_ID,
      stage: 'register',
      status: 400,
      path: '/login',
    });
  });

  it('strips controls, truncates, and omits empty user agents', async () => {
    async function accept(ua: string): Promise<DiagnosticEvent | undefined> {
      const store = new InMemoryDiagnosticStore();
      const app = mount(store, now);
      expect((await post(app, { 'user-agent': ua })).status).toBe(204);
      return (await store.listLatest(1))[0];
    }
    expect((await accept('A\u0001B\u007fC'))?.fields['userAgent']).toBe('ABC');
    expect((await accept('x'.repeat(250)))?.fields['userAgent']).toBe('x'.repeat(200));
    expect((await accept('\t\t'))?.fields).toEqual({});
  });

  it('accepts a non-IP cf-connecting-ip as 204 without a per-IP bucket', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const res = await post(app, { 'cf-connecting-ip': 'not an ip' });
    expect(res.status).toBe(204);
    expect((await store.listLatest(1))[0]?.source).toBe('client');
  });

  it('rate-limits per IP without filling that bucket for missing or invalid IPs', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '1.2.3.4' };
    for (let i = 0; i < 60; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    const limited = await post(app, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many diagnostics' });
    expect((await post(app)).status).toBe(204);
  });

  it('records one diagnostics.rate_limited row per window and another after the window', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '1.2.3.4' };
    for (let i = 0; i < 60; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    expect((await post(app, ip)).status).toBe(429);
    expect((await post(app, ip)).status).toBe(429);
    const first = await store.listLatest(200);
    expect(first.filter((row) => row.source === 'client')).toHaveLength(60);
    expect(first.filter((row) => row.event === 'diagnostics.rate_limited')).toHaveLength(1);
    clock += 60_000;
    for (let i = 0; i < 60; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    expect((await post(app, ip)).status).toBe(429);
    const second = await store.listLatest(200);
    expect(second.filter((row) => row.event === 'diagnostics.rate_limited')).toHaveLength(2);
  });

  it('rate-limits the global window without an IP header', async () => {
    const store = new InMemoryDiagnosticStore();
    const app = mount(store, now);
    for (let i = 0; i < 600; i++) {
      expect((await post(app)).status).toBe(204);
    }
    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many diagnostics' });
    expect((await post(app, { 'cf-connecting-ip': '9.9.9.9' })).status).toBe(429);
    clock += 60_000;
    expect((await post(app, { 'cf-connecting-ip': '9.9.9.9' })).status).toBe(204);
  });

  it('releases a no-IP slot when the insert throws', async () => {
    const store = new RecordingStore();
    store.failFirstClient = true;
    const app = mount(store, now);
    expect((await post(app)).status).toBe(500);
    expect((await post(app)).status).toBe(204);
  });

  it('does not consume a rate-limit slot when the client append throws', async () => {
    const store = new RecordingStore();
    store.failFirstClient = true;
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '1.2.3.4' };
    const failed = await post(app, ip);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Log is unavailable' });
    for (let i = 0; i < 60; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    expect((await post(app, ip)).status).toBe(429);
  });

  it('keeps the reserved slot while an insert is still in flight', async () => {
    let holdClients = false;
    let releaseHold: () => void = () => undefined;
    let hold = Promise.resolve();
    let entered = 0;
    const store: DiagnosticStore = {
      async append(row) {
        if (row.source !== 'client') {
          return;
        }
        entered += 1;
        if (holdClients) {
          await hold;
        }
      },
      listLatest: async () => [],
    };
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '9.9.9.9' };
    for (let i = 0; i < 59; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    holdClients = true;
    hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    try {
      const first = post(app, ip);
      for (let i = 0; i < 50 && entered < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(entered).toBe(60);
      const second = post(app, ip);
      for (let i = 0; i < 50 && entered < 61; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(entered).toBe(60);
      releaseHold();
      expect((await second).status).toBe(429);
      expect((await first).status).toBe(204);
    } finally {
      releaseHold();
    }
  });

  it('keeps a newer address bucket when an older insert fails after the window', async () => {
    let releaseHold: () => void = () => undefined;
    let gate = Promise.resolve();
    let entered = 0;
    const store: DiagnosticStore = {
      async append(row) {
        if (row.source !== 'client') {
          return;
        }
        entered += 1;
        if (entered === 60) {
          await gate;
          throw new Error('disk');
        }
      },
      listLatest: async () => [],
    };
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '1.2.3.4' };
    for (let i = 0; i < 59; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    gate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    try {
      const first = post(app, ip);
      for (let i = 0; i < 50 && entered < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(entered).toBe(60);
      clock += 60_000;
      expect((await post(app, ip)).status).toBe(204);
      releaseHold();
      expect((await first).status).toBe(500);
      let accepted = 0;
      for (let i = 0; i < 61; i++) {
        if ((await post(app, ip)).status !== 204) {
          break;
        }
        accepted += 1;
      }
      expect(accepted).toBe(59);
    } finally {
      releaseHold();
    }
  });

  it('does not clear a newer refusal stamp when an older refusal fails to record', async () => {
    let releaseHold: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let rateLimited = 0;
    const store = new InMemoryDiagnosticStore();
    const gated: DiagnosticStore = {
      async append(row) {
        if (row.event === 'diagnostics.rate_limited') {
          rateLimited += 1;
          if (rateLimited === 1) {
            await gate;
            throw new Error('disk');
          }
        }
        await store.append(row);
      },
      listLatest: (limit) => store.listLatest(limit),
    };
    const app = mount(gated, now);
    const firstIp = { 'cf-connecting-ip': '1.1.1.1' };
    const secondIp = { 'cf-connecting-ip': '2.2.2.2' };
    for (let i = 0; i < 60; i++) {
      expect((await post(app, firstIp)).status).toBe(204);
    }
    try {
      const first = post(app, firstIp);
      for (let i = 0; i < 50 && rateLimited < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(rateLimited).toBe(1);
      clock += 60_001;
      for (let i = 0; i < 60; i++) {
        expect((await post(app, secondIp)).status).toBe(204);
      }
      expect((await post(app, secondIp)).status).toBe(429);
      expect(rateLimited).toBe(2);
      releaseHold();
      expect((await first).status).toBe(429);
      expect((await post(app, secondIp)).status).toBe(429);
      const rows = await store.listLatest(200);
      expect(rows.filter((row) => row.event === 'diagnostics.rate_limited')).toHaveLength(1);
    } finally {
      releaseHold();
    }
  });

  it('does not remember lastRateLimitedAt when the rate-limited append throws', async () => {
    const store = new RecordingStore();
    const app = mount(store, now);
    const ip = { 'cf-connecting-ip': '1.2.3.4' };
    for (let i = 0; i < 60; i++) {
      expect((await post(app, ip)).status).toBe(204);
    }
    store.rejectRateLimited = true;
    expect((await post(app, ip)).status).toBe(429);
    expect((await post(app, ip)).status).toBe(429);
    expect(store.rateLimitedCalls).toBe(2);
    const rows = await store.listLatest(200);
    expect(rows.filter((row) => row.source === 'client')).toHaveLength(60);
    expect(rows.filter((row) => row.event === 'diagnostics.rate_limited')).toHaveLength(0);
  });
});
