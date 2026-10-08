import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IP_RATE_WINDOW_MS, IpRateLimiter } from '@/lib/ip-rate-limit';
import {
  InMemoryMemberEventStore,
  type MemberEvent,
  type MemberEventStore,
} from '@/lib/member-event-store';
import { MEMBER_EVENT_BATCH_MAX, MEMBER_EVENT_PROPS_MAX } from '@/lib/member-event';
import {
  MEMBER_EVENTS_BODY_LIMIT_BYTES,
  MEMBER_EVENTS_PER_MINUTE,
  memberEventRoutes,
} from '@/routes/member-events';

const LINKING_KEY = `02${'a'.repeat(64)}`;
const AUTH = { authorization: 'Bearer tok' };
const PHRASE_12 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';
const NSEC1 = 'nsec1abcdefghijklmnopqrstuvwxyz123456';
const SECRETS = [
  'preimage-secret-aaaa',
  'seed-secret-bbbb',
  'mnemonic-secret-cccc',
  'prf-secret-dddd',
  'privateKey-secret-eeee',
  'nsec-secret-ffff',
  PHRASE_12,
  NSEC1,
];

let clock = 1_700_000_000_000;
const now = (): number => clock;

function atIso(): string {
  return new Date(clock - 1_000).toISOString();
}

function validEvent(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'login', at: atIso(), ...partial };
}

class FailingStore implements MemberEventStore {
  async appendMany(_rows: readonly MemberEvent[]): Promise<void> {
    throw new Error('disk');
  }
  async listForAccount(_accountId: string, _limit: number): Promise<MemberEvent[]> {
    return [];
  }
}

function mount(opts: {
  authStore: InMemoryAuthStore;
  store?: MemberEventStore;
  limiter?: IpRateLimiter;
}): { app: Hono; store: MemberEventStore } {
  const store = opts.store ?? new InMemoryMemberEventStore();
  const deps = {
    authStore: opts.authStore,
    store,
    now,
    ...(opts.limiter === undefined ? {} : { limiter: opts.limiter }),
  };
  const app = new Hono().route('/', memberEventRoutes(deps));
  return { app, store };
}

async function seededAuth(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = AUTH,
  raw?: string,
): Promise<Response> {
  return app.request('/me/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

function streamedRequest(
  text: string,
  options: { onCancel?: () => void; headers?: Record<string, string> } = {},
): Request {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (options.onCancel === undefined) {
        controller.close();
      }
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Request('http://localhost/me/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...AUTH,
      ...options.headers,
    },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function capturedOutput(
  warn: ReturnType<typeof vi.spyOn>,
  error: ReturnType<typeof vi.spyOn>,
): string {
  return [...warn.mock.calls, ...error.mock.calls]
    .map((call) => call.map(String).join(' '))
    .join('\n');
}

describe('POST /me/events', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('exports the body cap and per-minute limit', () => {
    expect(MEMBER_EVENTS_BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect(MEMBER_EVENTS_PER_MINUTE).toBe(30);
  });

  it('returns 401 without a bearer header', async () => {
    const { app } = mount({ authStore: new InMemoryAuthStore() });
    const res = await post(app, { events: [] }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a bad token', async () => {
    const { app } = mount({ authStore: await seededAuth() });
    const res = await post(app, { events: [] }, { authorization: 'Bearer nosuch' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 429 after 30 accepted calls in a minute and allows again after the window', async () => {
    const authStore = await seededAuth();
    const { app } = mount({ authStore });
    for (let i = 0; i < MEMBER_EVENTS_PER_MINUTE; i += 1) {
      const res = await post(app, { events: [validEvent()] });
      expect(res.status).toBe(200);
    }
    const limited = await post(app, { events: [validEvent()] });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
    clock += IP_RATE_WINDOW_MS;
    const again = await post(app, { events: [validEvent()] });
    expect(again.status).toBe(200);
  });

  it('uses an injected limiter', async () => {
    const authStore = await seededAuth();
    const { app } = mount({ authStore, limiter: new IpRateLimiter(1) });
    expect((await post(app, { events: [] })).status).toBe(200);
    const limited = await post(app, { events: [] });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
  });

  it('returns 413 when content-length exceeds the limit', async () => {
    const { app } = mount({ authStore: await seededAuth() });
    const request = new Request('http://localhost/me/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...AUTH,
        'content-length': String(MEMBER_EVENTS_BODY_LIMIT_BYTES + 1),
      },
      body: '{}',
    });
    expect(request.headers.get('content-length')).toBe(String(MEMBER_EVENTS_BODY_LIMIT_BYTES + 1));
    const res = await app.request(request);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body is too large' });
  });

  it('returns 413 when a streamed body without content-length exceeds the limit', async () => {
    const { app } = mount({ authStore: await seededAuth() });
    let cancelled = false;
    const request = streamedRequest('x'.repeat(MEMBER_EVENTS_BODY_LIMIT_BYTES + 1), {
      onCancel: () => {
        cancelled = true;
      },
    });
    expect(request.headers.has('content-length')).toBe(false);
    const res = await app.request(request);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body is too large' });
    expect(cancelled).toBe(true);
  });

  it('returns 400 for bad JSON, a non-object body, a non-array events field, and 51 events', async () => {
    const { app, store } = mount({ authStore: await seededAuth() });
    const tooMany = {
      events: Array.from({ length: MEMBER_EVENT_BATCH_MAX + 1 }, () => validEvent()),
    };
    const cases: { name: string; body?: unknown; raw?: string }[] = [
      { name: 'bad JSON', raw: 'not-json' },
      { name: 'empty body', raw: '' },
      { name: 'JSON null', body: null },
      { name: 'JSON number', body: 1 },
      { name: 'array body', body: [] },
      { name: 'events object', body: { events: {} } },
      { name: '51 events', body: tooMany },
    ];
    for (const tc of cases) {
      const res = await post(app, tc.body, AUTH, tc.raw);
      expect(res.status, tc.name).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid events' });
    }
    expect(await store.listForAccount('acc', 10)).toHaveLength(0);
  });

  it('returns 200 with drops counted and strips query or fragment from path', async () => {
    const { app, store } = mount({ authStore: await seededAuth() });
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < MEMBER_EVENT_PROPS_MAX + 1; i += 1) {
      tooMany[`k${i}`] = i;
    }
    const res = await post(app, {
      leftover: true,
      events: [
        validEvent({ name: 'not_an_event' }),
        validEvent({ at: 'nope' }),
        validEvent({ path: 'relative' }),
        validEvent({ props: tooMany }),
        validEvent({ props: [] }),
        validEvent({ path: '/home?x=1#y', extra: 'ignored' }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, dropped: 5 });
    const rows = await store.listForAccount('acc', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('login');
    expect(rows[0]?.path).toBe('/home');
    expect(rows[0]?.accountId).toBe('acc');
    expect(rows[0]?.receivedAt.getTime()).toBe(clock);
    expect(rows[0]?.props).toEqual({});
    expect(JSON.stringify(rows[0])).not.toContain('leftover');
    expect(JSON.stringify(rows[0])).not.toContain('ignored');
    expect(JSON.stringify(rows[0])).not.toContain('not_an_event');
  });

  it('strips secret keys and secret-shaped values and never logs them', async () => {
    const { app, store } = mount({ authStore: await seededAuth() });
    const body = {
      preimage: SECRETS[0],
      seed: SECRETS[1],
      events: [
        {
          name: 'login',
          at: atIso(),
          mnemonic: SECRETS[2],
          prf: SECRETS[3],
          privateKey: SECRETS[4],
          nsec: SECRETS[5],
          props: {
            preimage: SECRETS[0],
            seed: SECRETS[1],
            mnemonic: SECRETS[2],
            prf: SECRETS[3],
            privateKey: SECRETS[4],
            nsec: SECRETS[5],
            note: PHRASE_12,
            query: NSEC1,
            screen: 'home',
          },
        },
      ],
    };
    const res = await post(app, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, dropped: 0 });
    const rows = await store.listForAccount('acc', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props).toEqual({ screen: 'home' });
    const dumped = `${JSON.stringify(rows)}\n${capturedOutput(warn, error)}`;
    for (const secret of SECRETS) {
      expect(dumped).not.toContain(secret);
    }
  });

  it('returns 503 when the store fails and logs only the event name and account id', async () => {
    const { app } = mount({
      authStore: await seededAuth(),
      store: new FailingStore(),
    });
    const res = await post(app, {
      events: [validEvent({ props: { note: PHRASE_12, screen: 'home' } })],
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Log is unavailable' });
    const lines = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    expect(lines.some((line) => line['event'] === 'member_event.write.failed')).toBe(true);
    const failed = lines.find((line) => line['event'] === 'member_event.write.failed');
    expect(failed?.['accountId']).toBe('acc');
    expect(Object.keys(failed ?? {}).sort()).toEqual(['accountId', 'event', 'ts']);
    const dumped = capturedOutput(warn, error);
    expect(dumped).not.toContain(PHRASE_12);
    expect(dumped).not.toContain('home');
  });
});
