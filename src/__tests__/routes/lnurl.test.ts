import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { InspectedBolt11 } from '@/lib/bolt11';
import { LNURL_RELAY_CAP } from '@/lib/lnurl-relay';
import type { FetchFn } from '@/lib/lnurlp';
import { lnurlRoutes } from '@/routes/lnurl';

const inspectMock = vi.hoisted(() => vi.fn<(pr: string) => InspectedBolt11 | null>());
vi.mock('@/lib/bolt11', () => ({ inspectBolt11: inspectMock }));

const AUTH = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const FROZEN = 1_000_000;
const METADATA = JSON.stringify([['text/plain', 'Pay bob']]);
const PR = 'lnbc10u1prelay';
const PAY_REQUEST = {
  tag: 'payRequest',
  callback: 'https://pay.example.com/cb',
  metadata: METADATA,
  minSendable: 1000,
  maxSendable: 100_000,
  commentAllowed: 5,
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  inspectMock.mockReset();
  inspectMock.mockReturnValue({
    paymentHash: 'a'.repeat(64),
    amountMsat: 21_000,
    description: null,
    descriptionHash: createHash('sha256').update(METADATA, 'utf8').digest('hex'),
    expirySeconds: 600,
  });
});

afterEach(() => {
  warn.mockRestore();
});

async function seeded(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'caller',
    linkingKey: null,
    role: 'basis',
    name: 'Caller',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: FROZEN,
    rulesAgreedAt: FROZEN,
  });
  await store.createSession({ token: 'tok', accountId: 'caller', createdAt: FROZEN });
  return store;
}

const fetchImpl: FetchFn = async (input) => {
  const url = String(input);
  if (url.startsWith('https://example.com/.well-known/lnurlp/bob')) {
    return Response.json(PAY_REQUEST);
  }
  if (url.startsWith('https://pay.example.com/cb')) {
    return Response.json({ pr: PR });
  }
  return new Response('', { status: 404 });
};

async function mount(
  env: Record<string, string | undefined> = { PUBLIC_BASE_URL: 'https://21.gifts' },
): Promise<Hono> {
  const auth = await seeded();
  return new Hono().route('/lnurl', lnurlRoutes({ auth, fetchImpl, now: () => FROZEN, env }));
}

function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = AUTH) {
  return app.request(`/lnurl${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function loggedText(): string {
  return warn.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('POST /lnurl/pay-request', () => {
  it('returns the pay request for a signed-in member', async () => {
    const app = await mount();
    const res = await post(app, '/pay-request', { target: 'bob@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target: 'bob@example.com',
      minSendableMsat: 1000,
      maxSendableMsat: 100_000,
      commentAllowed: 5,
      description: 'Pay bob',
      domain: 'example.com',
    });
  });

  it.each([
    ['no header', {}],
    ['a non-bearer header', { authorization: 'Basic x' }],
    ['an unknown session', { authorization: 'Bearer nope' }],
  ])('is 401 with %s', async (_label, headers) => {
    const app = await mount();
    const res = await post(app, '/pay-request', { target: 'bob@example.com' }, headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['invalid JSON', '{'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a missing target', {}],
    ['a numeric target', { target: 1 }],
  ])('is 400 for %s', async (_label, body) => {
    const app = await mount();
    const res = await post(app, '/pay-request', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Not a payable address' });
  });

  it('is 400 for a target on the own host', async () => {
    const app = await mount();
    const res = await post(app, '/pay-request', { target: 'bob@21.gifts' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Not a payable address' });
  });

  it.each([
    ['unset', {}],
    ['not a URL', { PUBLIC_BASE_URL: 'not a url' }],
  ])('fetches any outside host when PUBLIC_BASE_URL is %s', async (_label, env) => {
    const app = await mount(env);
    const res = await post(app, '/pay-request', { target: 'bob@example.com' });
    expect(res.status).toBe(200);
  });

  it('is 404 when the address is unknown and logs no target or query', async () => {
    const app = await mount();
    const res = await post(app, '/pay-request', { target: 'secret-name@example.org' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Address not found' });
    const logged = loggedText();
    expect(logged).toContain('lnurl.pay_request.failed');
    expect(logged).not.toContain('secret-name');
  });

  it('is 429 after the per-member limit, shared by both routes', async () => {
    const app = await mount();
    for (let i = 0; i < LNURL_RELAY_CAP - 1; i += 1) {
      expect((await post(app, '/pay-request', { target: 'bob@example.com' })).status).toBe(200);
    }
    expect(
      (await post(app, '/invoice', { target: 'bob@example.com', amountMsat: 21_000 })).status,
    ).toBe(200);
    const res = await post(app, '/pay-request', { target: 'bob@example.com' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'Too many requests' });
  });
});

describe('POST /lnurl/invoice', () => {
  it('returns the invoice and never logs the comment or invoice', async () => {
    const app = await mount();
    const res = await post(app, '/invoice', {
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'hush',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: PR });
    const logged = loggedText();
    expect(logged).toContain('lnurl.invoice.ok');
    expect(logged).not.toContain('hush');
    expect(logged).not.toContain(PR);
  });

  it('accepts a null comment', async () => {
    const app = await mount();
    const res = await post(app, '/invoice', {
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: null,
    });
    expect(res.status).toBe(200);
  });

  it('is 401 without a session', async () => {
    const app = await mount();
    const res = await post(app, '/invoice', { target: 'bob@example.com', amountMsat: 21_000 }, {});
    expect(res.status).toBe(401);
  });

  it.each([
    ['invalid JSON', '{', 'Not a payable address'],
    ['a missing target', { amountMsat: 21_000 }, 'Not a payable address'],
    ['a string amount', { target: 'bob@example.com', amountMsat: '21000' }, 'Amount out of range'],
    [
      'a fractional amount',
      { target: 'bob@example.com', amountMsat: 21_000.5 },
      'Amount out of range',
    ],
    [
      'an amount above the maximum',
      { target: 'bob@example.com', amountMsat: 100_001 },
      'Amount out of range',
    ],
    [
      'a non-string comment',
      { target: 'bob@example.com', amountMsat: 21_000, comment: 5 },
      'Comment too long',
    ],
    [
      'a long comment',
      { target: 'bob@example.com', amountMsat: 21_000, comment: 'abcdef' },
      'Comment too long',
    ],
  ])('is 400 for %s', async (_label, body, error) => {
    const app = await mount();
    const res = await post(app, '/invoice', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it('is 502 when the invoice does not match and logs only a reason', async () => {
    inspectMock.mockReturnValue(null);
    const app = await mount();
    const res = await post(app, '/invoice', {
      target: 'bob@example.com',
      amountMsat: 21_000,
      comment: 'hush',
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Address could not be reached' });
    const logged = loggedText();
    expect(logged).toContain('lnurl.invoice.failed');
    expect(logged).toContain('invoice_amount');
    expect(logged).not.toContain('hush');
  });
});
