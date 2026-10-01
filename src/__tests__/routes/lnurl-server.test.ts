import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { LNURL_BODY_LIMIT_BYTES } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { lnurlServerRoutes } from '@/routes/lnurl-server';

const PUBKEY = `02${'a'.repeat(64)}`;
const PUBKEY_OTHER = `03${'b'.repeat(64)}`;
const CONFIG: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};
const NOW = 1_000_000;

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchFn; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

async function seedWallet(
  store: InMemoryAuthStore,
  opts: {
    id: string;
    username: string;
    pubkey?: string;
    verified?: boolean;
    viewKey?: string;
  },
): Promise<void> {
  const pubkey = opts.pubkey ?? PUBKEY;
  await store.createAccount({
    id: opts.id,
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: opts.username,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: opts.viewKey ?? `${opts.id.replace(/-/g, '').slice(0, 8)}${'c'.repeat(56)}`,
    createdAt: 1,
    rulesAgreedAt: null,
    walletRequired: true,
  });
  await store.claimSparkPubkey(opts.id, pubkey);
  if (opts.verified === true) {
    await store.markSparkPubkeyVerified(opts.id, pubkey, opts.username, NOW);
  }
}

function mount(
  store: InMemoryAuthStore,
  fetchImpl: FetchFn,
  clock: () => number = () => NOW,
): Hono {
  return new Hono().route(
    '/',
    lnurlServerRoutes({ auth: store, config: CONFIG, fetchImpl, now: clock }),
  );
}

/** Valid register JSON padded with ASCII `x` to exactly `byteLength` bytes. */
function paddedRegisterBody(byteLength: number): string {
  const prefix = '{"username":"ada","pad":"';
  const suffix = '"}';
  const padLen = byteLength - prefix.length - suffix.length;
  return `${prefix}${'x'.repeat(padLen)}${suffix}`;
}

/** Stream `text` as UTF-8 chunks with no content-length header. */
function streamedRequest(
  url: string,
  text: string,
  options: { onCancel?: () => void; chunkSize?: number } = {},
): Request {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = options.chunkSize ?? 64 * 1024;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      while (offset < bytes.byteLength) {
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
      // Leave open when a cancel probe is attached so reader.cancel() is observable.
      if (options.onCancel === undefined) {
        controller.close();
      }
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Request(url, {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('lnurlServerRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('POST /lnurlpay/:pubkey', () => {
    it('registers, marks verified once, and forwards a repeat without changing the store', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      let now = NOW;
      const app = mount(store, fetchImpl, () => now);
      const body = JSON.stringify({
        username: 'Ada',
        description: 'x',
        signature: 'sig',
        timestamp: 1,
      });
      const first = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-breez-signature': 'sig',
          'x-breez-timestamp': '1',
        },
        body,
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toBe('{"ok":true}');
      expect(first.headers.get('content-type')).toBe('application/json');
      const verifiedAt = (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt;
      expect(verifiedAt).toBe(NOW);
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        username: 'Ada',
        description: 'x',
        signature: 'sig',
        timestamp: 1,
      });

      now = NOW + 5_000;
      const getAccountSpy = vi.spyOn(store, 'getAccount');
      const second = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(second.status).toBe(200);
      expect((await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).toBe(verifiedAt);
      expect(getAccountSpy).toHaveBeenCalledWith('acc');
      expect(
        parsedEvents(warn).filter(
          (e) => e['event'] === 'account.wallet.verified' && e['accountId'] === 'acc',
        ),
      ).toHaveLength(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe(`http://lnurl.test/lnurlpay/${PUBKEY}`);
      expect(calls[0]?.init?.headers).toMatchObject({
        host: 'example.test',
        'content-type': 'application/json',
        'x-breez-signature': 'sig',
        'x-breez-timestamp': '1',
      });
    });

    it('forwards a duplicate username key as the parsed value with username once', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const body =
        '{"username":"other","username":"ada","description":"d","signature":"s","timestamp":1}';
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      const forwarded = String(calls[0]?.init?.body);
      expect(JSON.parse(forwarded)).toEqual({
        username: 'ada',
        description: 'd',
        signature: 's',
        timestamp: 1,
      });
      expect(forwarded.match(/"username"/g)).toHaveLength(1);
    });

    it('returns 404 when a differently cased username key is present', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada', Username: 'other' }),
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('returns 409 when the username changes while registration is in flight', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => {
        const current = await store.getAccount('acc');
        expect(current).toBeDefined();
        await store.updateAccount({ ...current!, username: 'changed' });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Wallet registration could not be confirmed',
      });
      expect(calls).toHaveLength(1);
      expect(typeof (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).not.toBe('number');
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'account.wallet.unconfirmed' && e['accountId'] === 'acc',
        ),
      ).toBe(true);
    });

    it('returns 409 when another account becomes verified on the key during registration', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, {
        id: 'first',
        username: 'ada',
        verified: false,
        viewKey: `a${'d'.repeat(63)}`,
      });
      await seedWallet(store, {
        id: 'second',
        username: 'bob',
        verified: false,
        viewKey: `b${'e'.repeat(63)}`,
      });
      const { fetchImpl, calls } = recordingFetch(async () => {
        await store.markSparkPubkeyVerified('first', PUBKEY, 'ada', NOW);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'bob' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Wallet registration could not be confirmed',
      });
      expect(calls).toHaveLength(1);
      expect(typeof (await store.getAccount('second'))?.sparkPubkeyVerifiedAt).not.toBe('number');
      expect(typeof (await store.getAccount('first'))?.sparkPubkeyVerifiedAt).toBe('number');
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'account.wallet.unconfirmed' && e['accountId'] === 'second',
        ),
      ).toBe(true);
    });

    it('returns 409 when the account is removed while registration is in flight', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl } = recordingFetch(async () => {
        await store.deleteAccount('acc');
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Wallet registration could not be confirmed',
      });
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'account.wallet.unconfirmed' && e['accountId'] === 'acc',
        ),
      ).toBe(true);
    });

    it('returns 409 when the claimed key changes while registration is in flight', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl } = recordingFetch(async () => {
        await store.claimSparkPubkey('acc', PUBKEY_OTHER);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Wallet registration could not be confirmed',
      });
      expect(typeof (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).not.toBe('number');
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'account.wallet.unconfirmed' && e['accountId'] === 'acc',
        ),
      ).toBe(true);
    });

    it('returns 404 when the pubkey does not normalise', async () => {
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(new InMemoryAuthStore(), fetchImpl).request('/lnurlpay/not-a-key', {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('returns 404 for malformed JSON, a non-object body, or a missing username', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const app = mount(store, fetchImpl);
      for (const body of ['{', '[]', 'null', '{}', '{"username":1}']) {
        const res = await app.request(`/lnurlpay/${PUBKEY}`, { method: 'POST', body });
        expect(res.status).toBe(404);
      }
      expect(calls).toHaveLength(0);
    });

    it('returns 404 when the username is invalid or owned by another key', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', pubkey: PUBKEY_OTHER });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const app = mount(store, fetchImpl);
      const badName = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'Ada Lovelace' }),
      });
      expect(badName.status).toBe(404);
      const wrongKey = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(wrongKey.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('returns 404 when another account already verified the same key', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, {
        id: 'first',
        username: 'ada',
        verified: true,
        viewKey: `a${'d'.repeat(63)}`,
      });
      await seedWallet(store, {
        id: 'second',
        username: 'bob',
        verified: false,
        viewKey: `b${'e'.repeat(63)}`,
      });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'bob' }),
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('passes upstream 400, 404, and 409 through without verifying', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      for (const status of [400, 404, 409] as const) {
        const { fetchImpl } = recordingFetch(
          async () =>
            new Response(`{"error":${status}}`, {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
          method: 'POST',
          body: JSON.stringify({ username: 'ada' }),
        });
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(`{"error":${status}}`);
        expect(typeof (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).not.toBe('number');
      }
    });

    it('maps upstream 5xx and unreachable to 503 without verifying', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const five = await mount(store, async () => new Response('err', { status: 502 })).request(
        `/lnurlpay/${PUBKEY}`,
        {
          method: 'POST',
          body: JSON.stringify({ username: 'ada' }),
        },
      );
      expect(five.status).toBe(503);
      expect(await five.json()).toEqual({ error: 'Lightning address service is unavailable' });

      const down = await mount(store, async () => {
        throw new Error('offline');
      }).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(down.status).toBe(503);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.unreachable' && e['route'] === 'register',
        ),
      ).toBe(true);
      expect(typeof (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).not.toBe('number');
    });

    it('returns 413 when content-length exceeds the limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const request = new Request(`http://localhost/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(LNURL_BODY_LIMIT_BYTES + 1),
        },
        body: '{}',
      });
      expect(request.headers.get('content-length')).toBe(String(LNURL_BODY_LIMIT_BYTES + 1));
      const res = await mount(store, fetchImpl).request(request);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is too large' });
      expect(calls).toHaveLength(0);
    });

    it('returns 413 when a streamed body without content-length exceeds the limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      let cancelled = false;
      const request = streamedRequest(
        `http://localhost/lnurlpay/${PUBKEY}`,
        'x'.repeat(LNURL_BODY_LIMIT_BYTES + 1),
        {
          onCancel: () => {
            cancelled = true;
          },
        },
      );
      expect(request.headers.has('content-length')).toBe(false);
      const res = await mount(store, fetchImpl).request(request);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is too large' });
      expect(calls).toHaveLength(0);
      expect(cancelled).toBe(true);
    });

    it('forwards a JSON body just under the limit with equal parsed content', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const body = paddedRegisterBody(LNURL_BODY_LIMIT_BYTES - 1);
      expect(new TextEncoder().encode(body).byteLength).toBe(LNURL_BODY_LIMIT_BYTES - 1);
      const expected = JSON.parse(body) as Record<string, unknown>;

      const { fetchImpl: fetchPlain, calls: callsPlain } = recordingFetch(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const plain = await mount(store, fetchPlain).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(plain.status).toBe(200);
      expect(JSON.parse(String(callsPlain[0]?.init?.body))).toEqual(expected);
      expect(String(callsPlain[0]?.init?.body).match(/"username"/g)).toHaveLength(1);

      const { fetchImpl: fetchStream, calls: callsStream } = recordingFetch(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const streamed = streamedRequest(`http://localhost/lnurlpay/${PUBKEY}`, body);
      expect(streamed.headers.has('content-length')).toBe(false);
      const streamRes = await mount(store, fetchStream).request(streamed);
      expect(streamRes.status).toBe(200);
      expect(JSON.parse(String(callsStream[0]?.init?.body))).toEqual(expected);
    });

    it('passes through upstream 204 with an empty body and marks verified', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl } = recordingFetch(async () => new Response(null, { status: 204 }));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(typeof (await store.getAccount('acc'))?.sparkPubkeyVerifiedAt).toBe('number');
    });

    it('returns 429 after the per-client limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      let t = NOW;
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(store, fetchImpl, () => t);
      for (let i = 0; i < 30; i += 1) {
        const res = await app.request(`/lnurlpay/${PUBKEY}`, {
          method: 'POST',
          headers: { 'cf-connecting-ip': '203.0.113.10' },
          body: JSON.stringify({ username: 'ada' }),
        });
        expect(res.status).toBe(200);
      }
      const limited = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
      expect(calls).toHaveLength(30);
      const other = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.11' },
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(other.status).toBe(200);
      t += 60_001;
      const after = await app.request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.10' },
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(after.status).toBe(200);
    });

    it('returns 503 when the store throws', async () => {
      const store = new InMemoryAuthStore();
      store.getAccountByUsername = async () => {
        throw new Error('db');
      };
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada' }),
      });
      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.failed' && e['route'] === 'register',
        ),
      ).toBe(true);
    });
  });

  describe('POST /lnurlpay/:pubkey/recover', () => {
    it('forwards when the key is claimed', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('{"username":"ada"}', {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          }),
      );
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-breez-signature': 's' },
        body: '{"signature":"s"}',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"username":"ada"}');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(calls[0]?.url).toBe(`http://lnurl.test/lnurlpay/${PUBKEY}/recover`);
    });

    it('returns 404 when the key is unknown or invalid', async () => {
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const app = mount(new InMemoryAuthStore(), fetchImpl);
      expect(
        (await app.request('/lnurlpay/bad/recover', { method: 'POST', body: '{}' })).status,
      ).toBe(404);
      expect(
        (await app.request(`/lnurlpay/${PUBKEY}/recover`, { method: 'POST', body: '{}' })).status,
      ).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('returns 413 when content-length exceeds the limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const request = new Request(`http://localhost/lnurlpay/${PUBKEY}/recover`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(LNURL_BODY_LIMIT_BYTES + 1),
        },
        body: '{}',
      });
      expect(request.headers.get('content-length')).toBe(String(LNURL_BODY_LIMIT_BYTES + 1));
      const res = await mount(store, fetchImpl).request(request);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is too large' });
      expect(calls).toHaveLength(0);
    });

    it('returns 413 when a streamed body without content-length exceeds the limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const request = streamedRequest(
        `http://localhost/lnurlpay/${PUBKEY}/recover`,
        'x'.repeat(LNURL_BODY_LIMIT_BYTES + 1),
      );
      expect(request.headers.has('content-length')).toBe(false);
      const res = await mount(store, fetchImpl).request(request);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is too large' });
      expect(calls).toHaveLength(0);
    });

    it('forwards an absent body as an empty string', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}/recover`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.body).toBe('');
    });

    it('forwards a body at the limit byte-identically, including when streamed', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const body = paddedRegisterBody(LNURL_BODY_LIMIT_BYTES);
      expect(new TextEncoder().encode(body).byteLength).toBe(LNURL_BODY_LIMIT_BYTES);

      const { fetchImpl: fetchPlain, calls: callsPlain } = recordingFetch(
        async () => new Response('ok', { status: 200 }),
      );
      const plain = await mount(store, fetchPlain).request(`/lnurlpay/${PUBKEY}/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(plain.status).toBe(200);
      expect(callsPlain[0]?.init?.body).toBe(body);

      const { fetchImpl: fetchStream, calls: callsStream } = recordingFetch(
        async () => new Response('ok', { status: 200 }),
      );
      const streamed = streamedRequest(`http://localhost/lnurlpay/${PUBKEY}/recover`, body);
      expect(streamed.headers.has('content-length')).toBe(false);
      const streamRes = await mount(store, fetchStream).request(streamed);
      expect(streamRes.status).toBe(200);
      expect(callsStream[0]?.init?.body).toBe(body);
    });

    it('returns 503 when the store throws', async () => {
      const store = new InMemoryAuthStore();
      store.isSparkPubkeyClaimed = async () => {
        throw new Error('db');
      };
      const res = await mount(store, async () => new Response('no')).request(
        `/lnurlpay/${PUBKEY}/recover`,
        { method: 'POST', body: '{}' },
      );
      expect(res.status).toBe(503);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.failed' && e['route'] === 'recover',
        ),
      ).toBe(true);
    });

    it('returns 429 after the per-client limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(store, fetchImpl);
      for (let i = 0; i < 30; i += 1) {
        expect(
          (
            await app.request(`/lnurlpay/${PUBKEY}/recover`, {
              method: 'POST',
              headers: { 'cf-connecting-ip': '198.51.100.1' },
              body: '{}',
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await app.request(`/lnurlpay/${PUBKEY}/recover`, {
            method: 'POST',
            headers: { 'cf-connecting-ip': '198.51.100.1' },
            body: '{}',
          })
        ).status,
      ).toBe(429);
      expect(calls).toHaveLength(30);
    });
  });

  describe('GET /lnurlpay/:pubkey/metadata', () => {
    it('forwards the raw query when the key is verified', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const res = await mount(store, fetchImpl).request(
        `/lnurlpay/${PUBKEY}/metadata?from=1&to=2&a=b%20c`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('[]');
      expect(calls[0]?.url).toBe(
        `http://lnurl.test/lnurlpay/${PUBKEY}/metadata?from=1&to=2&a=b%20c`,
      );
    });

    it('returns 404 when the key is invalid or not verified', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: false });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const app = mount(store, fetchImpl);
      expect((await app.request('/lnurlpay/bad/metadata')).status).toBe(404);
      expect((await app.request(`/lnurlpay/${PUBKEY}/metadata`)).status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('maps store errors to 503', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      store.getAccountByVerifiedSparkPubkey = async () => {
        throw new Error('db');
      };
      const boom = await mount(store, async () => new Response('no')).request(
        `/lnurlpay/${PUBKEY}/metadata`,
      );
      expect(boom.status).toBe(503);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.failed' && e['route'] === 'metadata',
        ),
      ).toBe(true);
    });

    it('returns 429 after the per-client limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(store, fetchImpl);
      for (let i = 0; i < 120; i += 1) {
        expect(
          (
            await app.request(`/lnurlpay/${PUBKEY}/metadata`, {
              headers: { 'cf-connecting-ip': '203.0.113.50' },
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await app.request(`/lnurlpay/${PUBKEY}/metadata`, {
            headers: { 'cf-connecting-ip': '203.0.113.50' },
          })
        ).status,
      ).toBe(429);
      expect(calls).toHaveLength(120);
    });
  });

  describe('GET /lnurlp/:username/invoice', () => {
    it('forwards the raw query for a verified wallet username', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('{"pr":"lnbc1"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const res = await mount(store, fetchImpl).request(
        '/lnurlp/Ada/invoice?amount=1000&comment=hi%2Fthere&nostr=%7B%7D',
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"pr":"lnbc1"}');
      expect(calls[0]?.url).toBe(
        'http://lnurl.test/lnurlp/ada/invoice?amount=1000&comment=hi%2Fthere&nostr=%7B%7D',
      );
    });

    it('returns 404 when the username is invalid or the wallet is not verified', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: false });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const app = mount(store, fetchImpl);
      expect((await app.request('/lnurlp/_/invoice')).status).toBe(404);
      expect((await app.request('/lnurlp/ada/invoice')).status).toBe(404);
      expect((await app.request('/lnurlp/missing/invoice')).status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('maps store errors to 503', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      store.getAccountByUsername = async () => {
        throw new Error('db');
      };
      const boom = await mount(store, async () => new Response('no')).request(
        '/lnurlp/ada/invoice',
      );
      expect(boom.status).toBe(503);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.failed' && e['route'] === 'invoice',
        ),
      ).toBe(true);
    });

    it('returns 429 after the per-client limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(store, fetchImpl);
      for (let i = 0; i < 20; i += 1) {
        expect(
          (
            await app.request('/lnurlp/ada/invoice', {
              headers: { 'cf-connecting-ip': '203.0.113.60' },
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await app.request('/lnurlp/ada/invoice', {
            headers: { 'cf-connecting-ip': '203.0.113.60' },
          })
        ).status,
      ).toBe(429);
      expect(calls).toHaveLength(20);
    });
  });

  describe('GET /verify/:paymentHash', () => {
    it('forwards without a query string', async () => {
      const { fetchImpl, calls } = recordingFetch(
        async () =>
          new Response('{"status":"OK"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const res = await mount(new InMemoryAuthStore(), fetchImpl).request(
        '/verify/abc123?ignored=1',
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"status":"OK"}');
      expect(calls[0]?.url).toBe('http://lnurl.test/verify/abc123');
    });

    it('maps unreachable upstream to 503', async () => {
      const down = await mount(new InMemoryAuthStore(), async () => {
        throw new Error('offline');
      }).request('/verify/abc');
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ error: 'Lightning address service is unavailable' });
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.unreachable' && e['route'] === 'verify',
        ),
      ).toBe(true);
    });

    it('returns 404 for a refused paymentHash segment without contacting upstream', async () => {
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(new InMemoryAuthStore(), fetchImpl).request('/verify/a%2Fb');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(calls).toHaveLength(0);
      expect(parsedEvents(warn).some((e) => e['event'] === 'lnurl_server.unreachable')).toBe(false);
    });

    it('returns 503 when the handler throws before the upstream call', async () => {
      const broken = lnurlServerRoutes({
        auth: new InMemoryAuthStore(),
        config: CONFIG,
        fetchImpl: async () => new Response('no'),
        now: () => {
          throw new Error('clock');
        },
      });
      const res = await broken.request('/verify/abc');
      expect(res.status).toBe(503);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurl_server.failed' && e['route'] === 'verify',
        ),
      ).toBe(true);
    });

    it('returns 429 after the per-client limit', async () => {
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(new InMemoryAuthStore(), fetchImpl);
      for (let i = 0; i < 120; i += 1) {
        expect(
          (
            await app.request('/verify/abc', {
              headers: { 'cf-connecting-ip': '203.0.113.70' },
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await app.request('/verify/abc', {
            headers: { 'cf-connecting-ip': '203.0.113.70' },
          })
        ).status,
      ).toBe(429);
      expect(calls).toHaveLength(120);
    });
  });

  describe('upstream status mapping', () => {
    const cases = [
      {
        name: 'recover',
        seed: { id: 'acc', username: 'ada' } as const,
        request: (app: Hono) =>
          app.request(`/lnurlpay/${PUBKEY}/recover`, { method: 'POST', body: '{}' }),
      },
      {
        name: 'metadata',
        seed: { id: 'acc', username: 'ada', verified: true } as const,
        request: (app: Hono) => app.request(`/lnurlpay/${PUBKEY}/metadata`),
      },
      {
        name: 'invoice',
        seed: { id: 'acc', username: 'ada', verified: true } as const,
        request: (app: Hono) => app.request('/lnurlp/ada/invoice'),
      },
      {
        name: 'verify',
        seed: null,
        request: (app: Hono) => app.request('/verify/abc'),
      },
    ] as const;

    for (const route of cases) {
      it(`maps upstream 404, other 4xx, 5xx, and thrown fetch for ${route.name}`, async () => {
        const store = new InMemoryAuthStore();
        if (route.seed !== null) {
          await seedWallet(store, { ...route.seed });
        }

        const missing = await route.request(
          mount(store, async () => new Response('gone', { status: 404 })),
        );
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'Not found' });

        const bad = await route.request(
          mount(store, async () => new Response('bad', { status: 400 })),
        );
        expect(bad.status).toBe(503);
        expect(await bad.json()).toEqual({ error: 'Lightning address service is unavailable' });

        const five = await route.request(
          mount(store, async () => new Response('err', { status: 500 })),
        );
        expect(five.status).toBe(503);
        expect(await five.json()).toEqual({ error: 'Lightning address service is unavailable' });

        const down = await route.request(
          mount(store, async () => {
            throw new Error('offline');
          }),
        );
        expect(down.status).toBe(503);
        expect(await down.json()).toEqual({ error: 'Lightning address service is unavailable' });
      });
    }
  });
});
