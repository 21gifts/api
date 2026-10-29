import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { RECOVERY_SETTLE_AFTER_MS } from '@/lib/auth/recovery';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import { InMemoryPushStore } from '@/lib/push-store';
import { encodeSparkAddress } from '@/lib/spark-address';
import type { LnurlServerConfig } from '@/lib/config';
import { LNURL_BODY_LIMIT_BYTES } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { decodeBolt11 } from '@/lib/bolt11';
import type { PosCharge } from '@/lib/pos-charge';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { shopError, shopErrorBody, waitBody, type ShopPayments } from '@/lib/shop-payment';
import * as shopProof from '@/lib/shop-proof';
import { lnurlServerRoutes } from '@/routes/lnurl-server';
import { WAIT_SATS_TIMEOUT_MS } from '@/lib/message';
import {
  PAYMENT_ID,
  QUOTE_ID,
  getPayment,
  harness,
  seed,
  txHash,
} from '@/__tests__/helpers/shop-proof-fixture';
import {
  PINNED,
  PINNED_PRIVATE_KEYS,
  RECOVERY_USERNAME,
  lookupHolds,
  lookupUserNotFound,
  scriptedLnurlFetch,
  seedPinnedAccount,
  stagePendingRecovery,
  transferAccepted,
  transferBody,
} from '@/__tests__/helpers/recovery';

const PUBKEY = `02${'a'.repeat(64)}`;
const PUBKEY_OTHER = `03${'b'.repeat(64)}`;
const CONFIG: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};
const NOW = 1_000_000;
/** BOLT11 for 250_000 sats. */
const TILL_PR =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

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
  posStore: PosStore = new InMemoryPosStore(),
): Hono {
  return new Hono().route(
    '/',
    lnurlServerRoutes({ auth: store, config: CONFIG, fetchImpl, now: clock, posStore }),
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
        username: ' Ada ',
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
        username: ' Ada ',
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

    it('returns 404 when a compatibility-folded username key is present', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
        method: 'POST',
        body: JSON.stringify({ username: 'ada', ['u\u017Fername']: 'other' }),
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it.each(['\uFEFFada', 'ada\u00A0', 'ada\u200B'])(
      'returns 404 when the username contains a non-printable-ASCII character',
      async (username) => {
        const store = new InMemoryAuthStore();
        await seedWallet(store, { id: 'acc', username: 'ada' });
        const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
        const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}`, {
          method: 'POST',
          body: JSON.stringify({ username }),
        });
        expect(res.status).toBe(404);
        expect(calls).toHaveLength(0);
      },
    );

    it('returns 409 when the username changes while registration is in flight', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada' });
      const { fetchImpl, calls } = recordingFetch(async () => {
        expect(await store.setUsername('acc', 'changed')).toMatchObject({ ok: true });
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

  describe('POST /lnurlpay/:pubkey/transfer', () => {
    /** Unix seconds of {@link NOW}. */
    const TS = Math.floor(NOW / 1000);
    const TRANSFER_PATH = `/lnurlpay/${PINNED.newSparkPubkey}/transfer`;

    function signedBody(
      overrides: Partial<Parameters<typeof transferBody>[0]> = {},
    ): Record<string, string | number> {
      return transferBody({
        username: RECOVERY_USERNAME,
        fromPubkey: PINNED.oldSparkPubkey,
        fromPrivKey: PINNED_PRIVATE_KEYS.old,
        toPubkey: PINNED.newSparkPubkey,
        toPrivKey: PINNED_PRIVATE_KEYS.new,
        timestamp: TS,
        ...overrides,
      });
    }

    async function pendingStore(createdAt: number = NOW): Promise<InMemoryAuthStore> {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      await stagePendingRecovery(store, { createdAt });
      return store;
    }

    function transfer(
      app: Hono,
      body: unknown,
      headers: Record<string, string> = {},
    ): Promise<Response> {
      return Promise.resolve(
        app.request(TRANSFER_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      );
    }

    function events(name: string): Array<Record<string, unknown>> {
      return parsedEvents(warn).filter((e) => e['event'] === name);
    }

    it('forwards an admitted claim and commits the recovery on the upstream 2xx', async () => {
      const store = await pendingStore();
      const push = new InMemoryPushStore();
      store.usePushStore(push);
      await push.upsertSubscription({
        endpoint: 'https://push.test/1',
        accountId: PINNED.accountId,
        p256dh: 'p',
        auth: 'a',
        createdAt: new Date(NOW),
      });
      await store.createSession({
        token: 'd'.repeat(64),
        accountId: PINNED.accountId,
        createdAt: NOW,
      });
      const { fetchImpl, calls } = scriptedLnurlFetch({
        transfer: () => transferAccepted(RECOVERY_USERNAME),
      });
      const body = signedBody();
      const raw = `{ "username" : "ADA", ${JSON.stringify(body).slice(1).replace('"username":"ada",', '')}`;
      const res = await transfer(mount(store, fetchImpl), raw, { 'x-breez-signature': 's' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        lnurl: 'lnurlp://example.test/lnurlp/ada',
        lightning_address: 'ada@example.test',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.pubkey).toBe(PINNED.newSparkPubkey);
      expect(calls[0]?.host).toBe('example.test');
      expect(calls[0]?.body).toBe(JSON.stringify(JSON.parse(raw)));

      const account = await store.getAccount(PINNED.accountId);
      expect(account?.sparkPubkey).toBe(PINNED.newSparkPubkey);
      expect(account?.sparkPubkeyVerifiedAt).toBe(2);
      expect(account?.username).toBe(RECOVERY_USERNAME);
      expect(await store.getAccountByVerifiedSparkPubkey(PINNED.newSparkPubkey)).toEqual(account);
      expect((await store.listPasskeyCredentials()).map((c) => c.credentialId)).toEqual([
        PINNED.credentialId,
      ]);
      expect(await store.listSessions()).toEqual([]);
      expect(await push.listByAccount(PINNED.accountId)).toEqual([]);
      expect(await store.listPreviousWallets(PINNED.accountId)).toEqual([
        {
          accountId: PINNED.accountId,
          sparkPubkey: PINNED.oldSparkPubkey,
          sparkAddress: encodeSparkAddress(PINNED.oldSparkPubkey),
          replacedAt: NOW,
        },
      ]);
      expect(await store.getPendingRecovery(PINNED.accountId, NOW)).toBeUndefined();
      expect(events('account.recovery.forwarded')).toEqual([
        expect.objectContaining({ accountId: PINNED.accountId }),
      ]);
      expect(events('account.recovery.committed')).toEqual([
        expect.objectContaining({ accountId: PINNED.accountId, via: 'claim' }),
      ]);
      const logged = JSON.stringify(parsedEvents(warn));
      expect(logged).not.toContain(PINNED.oldSparkPubkey);
      expect(logged).not.toContain(String(body['from_signature']));
    });

    it('answers 404 without forwarding when a gate fails', async () => {
      const store = await pendingStore();
      const { fetchImpl, calls } = scriptedLnurlFetch({
        transfer: () => transferAccepted(RECOVERY_USERNAME),
      });
      const app = mount(store, fetchImpl);
      const body = signedBody();
      const stranger = transferBody({
        username: RECOVERY_USERNAME,
        fromPubkey: PINNED.newSparkPubkey,
        fromPrivKey: PINNED_PRIVATE_KEYS.new,
        toPubkey: PINNED.newSparkPubkey,
        toPrivKey: PINNED_PRIVATE_KEYS.new,
        timestamp: TS,
      });
      const refused: unknown[] = [
        'not json',
        '[]',
        'null',
        { ...body, Username: 'ada' },
        { ...body, ｕｓｅｒｎａｍｅ: 'ada' },
        { ...body, FROM_PUBKEY: PINNED.oldSparkPubkey },
        { ...body, Timestamp: TS },
        { ...body, username: 7 },
        { ...body, username: 'ädä' },
        { ...body, username: 'not a name' },
        signedBody({ description: 'x'.repeat(256) }),
        { ...body, description: 1 },
        { ...body, from_pubkey: 'nope' },
        { ...body, from_pubkey: 1 },
        { ...body, from_signature: 1 },
        { ...body, to_signature: null },
        { ...body, timestamp: String(TS) },
        { ...body, timestamp: 1.5 },
        { ...body, timestamp: -1 },
        signedBody({ timestamp: TS - 601 }),
        signedBody({ timestamp: TS + 601 }),
        { ...body, from_signature: body['to_signature'] },
        { ...body, to_signature: body['from_signature'] },
        { ...body, description: 'Pay to someone else' },
        signedBody({ username: 'bob' }),
        stranger,
      ];
      for (const candidate of refused) {
        const res = await transfer(app, candidate);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
      const badPath = await app.request('/lnurlpay/bad/transfer', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(badPath.status).toBe(404);
      expect(calls).toEqual([]);
      expect((await store.getPendingRecovery(PINNED.accountId, NOW))?.forwardedAt).toBeNull();
    });

    it('accepts a description of 255 code points, and the bounds of the time window', async () => {
      for (const variant of [
        signedBody({ description: '🎁'.repeat(255) }),
        signedBody({ timestamp: TS - 600 }),
        signedBody({ timestamp: TS + 600 }),
      ]) {
        const store = await pendingStore();
        const { fetchImpl } = scriptedLnurlFetch({
          transfer: () => transferAccepted(RECOVERY_USERNAME),
        });
        expect((await transfer(mount(store, fetchImpl), variant)).status).toBe(200);
      }
    });

    it('answers 404 when no pending recovery admits the claim', async () => {
      const { fetchImpl, calls } = scriptedLnurlFetch({
        transfer: () => transferAccepted(RECOVERY_USERNAME),
      });
      const none = new InMemoryAuthStore();
      await seedPinnedAccount(none);
      expect((await transfer(mount(none, fetchImpl), signedBody())).status).toBe(404);

      const expired = await pendingStore(NOW - CHALLENGE_TTL_MS - 1);
      expect((await transfer(mount(expired, fetchImpl), signedBody())).status).toBe(404);

      const refused = await pendingStore();
      await refused.setSessionRefused(PINNED.accountId, true);
      expect((await transfer(mount(refused, fetchImpl), signedBody())).status).toBe(404);

      const forwarded = new InMemoryAuthStore();
      await seedPinnedAccount(forwarded);
      await stagePendingRecovery(forwarded, { createdAt: NOW, forwardedAt: NOW });
      expect((await transfer(mount(forwarded, fetchImpl), signedBody())).status).toBe(404);
      expect(calls).toEqual([]);
    });

    it('answers 409 when the upstream accepted but the commit did not land', async () => {
      const store = await pendingStore();
      vi.spyOn(store, 'commitRecovery').mockResolvedValue('gone');
      const { fetchImpl } = scriptedLnurlFetch({
        transfer: () => transferAccepted(RECOVERY_USERNAME),
      });
      const res = await transfer(mount(store, fetchImpl), signedBody());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Wallet registration could not be confirmed' });
      expect(events('account.recovery.unconfirmed')).toEqual([
        expect.objectContaining({ accountId: PINNED.accountId }),
      ]);
      expect(events('account.recovery.committed')).toEqual([]);
    });

    it('passes upstream 4xx through and keeps the pending recovery forwarded', async () => {
      for (const upstream of [
        new Response('"signature has already been used"', { status: 409 }),
        new Response('"source pubkey does not own this username"', { status: 404 }),
      ]) {
        const store = await pendingStore();
        const text = await upstream.clone().text();
        const { fetchImpl } = scriptedLnurlFetch({ transfer: () => upstream });
        const res = await transfer(mount(store, fetchImpl), signedBody());
        expect(res.status).toBe(upstream.status);
        expect(await res.text()).toBe(text);
        expect((await store.getPendingRecovery(PINNED.accountId, NOW))?.forwardedAt).toBe(NOW);
        expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
      }
    });

    it('answers 503 for upstream 5xx, an unreachable server, or an aborted forward, and changes nothing', async () => {
      const abort = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
      for (const fetchImpl of [
        scriptedLnurlFetch({
          transfer: () => new Response('"internal server error"', { status: 500 }),
        }).fetchImpl,
        (async () => {
          throw new TypeError('fetch failed');
        }) as FetchFn,
        (async () => {
          throw abort;
        }) as FetchFn,
      ]) {
        const store = await pendingStore();
        const res = await transfer(mount(store, fetchImpl), signedBody());
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'Lightning address service is unavailable' });
        const pending = await store.getPendingRecovery(
          PINNED.accountId,
          NOW + CHALLENGE_TTL_MS + 1,
        );
        expect(pending?.forwardedAt).toBe(NOW);
        const account = await store.getAccount(PINNED.accountId);
        expect(account?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
        expect(await store.listPreviousWallets(PINNED.accountId)).toEqual([]);
      }
      expect(
        events('lnurl_server.unreachable').filter((e) => e['route'] === 'transfer'),
      ).toHaveLength(3);
    });

    it('answers 503 when the store throws', async () => {
      const store = await pendingStore();
      vi.spyOn(store, 'markRecoveryForwarded').mockRejectedValue(new Error('db'));
      const { fetchImpl, calls } = scriptedLnurlFetch({
        transfer: () => transferAccepted(RECOVERY_USERNAME),
      });
      const res = await transfer(mount(store, fetchImpl), signedBody());
      expect(res.status).toBe(503);
      expect(calls).toEqual([]);
      expect(events('lnurl_server.failed')).toEqual([
        expect.objectContaining({ route: 'transfer' }),
      ]);
    });

    it('answers 413 for a body over the limit', async () => {
      const store = await pendingStore();
      const { fetchImpl, calls } = scriptedLnurlFetch({});
      const request = new Request(`http://localhost${TRANSFER_PATH}`, {
        method: 'POST',
        headers: { 'content-length': String(LNURL_BODY_LIMIT_BYTES + 1) },
        body: '{}',
      });
      const res = await mount(store, fetchImpl).request(request);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body is too large' });
      expect(calls).toEqual([]);
    });

    it('answers 429 after 30 transfers a minute from one address', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store, scriptedLnurlFetch({}).fetchImpl);
      const headers = { 'cf-connecting-ip': '198.51.100.9' };
      for (let i = 0; i < 30; i += 1) {
        expect((await transfer(app, '{}', headers)).status).toBe(404);
      }
      const limited = await transfer(app, '{}', headers);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
    });
  });

  describe('POST /lnurlpay/:pubkey/recover with a pending social recovery', () => {
    const FORWARDED_AT = NOW;
    const AFTER_WINDOW = FORWARDED_AT + RECOVERY_SETTLE_AFTER_MS + 1;

    async function forwardedStore(): Promise<InMemoryAuthStore> {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      await stagePendingRecovery(store, { createdAt: NOW, forwardedAt: FORWARDED_AT });
      return store;
    }

    function lookup(app: Hono, pubkey: string): Promise<Response> {
      return Promise.resolve(
        app.request(`/lnurlpay/${pubkey}/recover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"signature":"s","timestamp":1}',
        }),
      );
    }

    it("passes the new key of a pending recovery, and an expired unforwarded one's not", async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      await stagePendingRecovery(store, { createdAt: NOW });
      const { fetchImpl, calls } = scriptedLnurlFetch({ recover: () => lookupUserNotFound() });
      const live = await lookup(mount(store, fetchImpl), PINNED.newSparkPubkey);
      expect(live.status).toBe(404);
      expect(calls).toHaveLength(1);
      const expired = await lookup(
        mount(store, fetchImpl, () => NOW + CHALLENGE_TTL_MS + 1),
        PINNED.newSparkPubkey,
      );
      expect(expired.status).toBe(404);
      expect(calls).toHaveLength(1);
    });

    it("commits after the window when the new key's lookup returns the username", async () => {
      const store = await forwardedStore();
      const { fetchImpl } = scriptedLnurlFetch({ recover: () => lookupHolds(RECOVERY_USERNAME) });
      const res = await lookup(
        mount(store, fetchImpl, () => AFTER_WINDOW),
        PINNED.newSparkPubkey,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { username: string }).username).toBe(RECOVERY_USERNAME);
      expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.newSparkPubkey);
      expect(
        parsedEvents(warn).filter(
          (e) => e['event'] === 'account.recovery.committed' && e['via'] === 'lookup',
        ),
      ).toHaveLength(1);
    });

    it("commits after the window when the old key's lookup finds no name, and answers 404", async () => {
      const store = await forwardedStore();
      const { fetchImpl } = scriptedLnurlFetch({ recover: () => lookupUserNotFound() });
      const res = await lookup(
        mount(store, fetchImpl, () => AFTER_WINDOW),
        PINNED.oldSparkPubkey,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.newSparkPubkey);
    });

    it("drops after the window when the old key's lookup still returns the username", async () => {
      const store = await forwardedStore();
      const { fetchImpl } = scriptedLnurlFetch({ recover: () => lookupHolds(RECOVERY_USERNAME) });
      const res = await lookup(
        mount(store, fetchImpl, () => AFTER_WINDOW),
        PINNED.oldSparkPubkey,
      );
      expect(res.status).toBe(200);
      expect(await store.getPendingRecovery(PINNED.accountId, AFTER_WINDOW)).toBeUndefined();
      expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
    });

    it('keeps the pending recovery for lookups sent inside the window', async () => {
      const store = await forwardedStore();
      const atBoundary = FORWARDED_AT + RECOVERY_SETTLE_AFTER_MS;
      const holds = scriptedLnurlFetch({ recover: () => lookupHolds(RECOVERY_USERNAME) });
      await lookup(
        mount(store, holds.fetchImpl, () => atBoundary),
        PINNED.newSparkPubkey,
      );
      await lookup(
        mount(store, holds.fetchImpl, () => atBoundary),
        PINNED.oldSparkPubkey,
      );
      const notFound = scriptedLnurlFetch({ recover: () => lookupUserNotFound() });
      await lookup(
        mount(store, notFound.fetchImpl, () => atBoundary),
        PINNED.oldSparkPubkey,
      );
      expect((await store.getPendingRecovery(PINNED.accountId, atBoundary))?.forwardedAt).toBe(
        FORWARDED_AT,
      );
      expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
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

    it('returns 404 for HEAD without contacting upstream', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request(`/lnurlpay/${PUBKEY}/metadata`, {
        method: 'HEAD',
      });
      expect(res.status).toBe(404);
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

    describe('open till charge', () => {
      const HASH = decodeBolt11(TILL_PR)?.paymentHash ?? '';

      function charge(amountSats: number): PosCharge {
        return {
          id: 'c1',
          accountId: 'acc',
          amountSats,
          status: 'pending',
          createdAt: new Date(NOW),
          expiresAt: new Date(NOW + 60_000),
          paidAt: null,
          sparkInvoice: null,
          amountCurrency: null,
          amountText: null,
          fiatUsd: null,
          fiatChf: null,
          fiatEur: null,
          fiatPhp: null,
        };
      }

      async function forward(posStore: PosStore, body: string, status = 200): Promise<Response> {
        const store = new InMemoryAuthStore();
        await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
        const { fetchImpl } = recordingFetch(
          async () =>
            new Response(body, { status, headers: { 'content-type': 'application/json' } }),
        );
        return mount(store, fetchImpl, () => NOW, posStore).request(
          '/lnurlp/ada/invoice?amount=250000000',
        );
      }

      async function recorded(posStore: PosStore): Promise<string[]> {
        return (await posStore.listWatched(0)).flatMap((entry) => entry.paymentHashes);
      }

      it('records a BOLT11 at the charge amount against the open charge', async () => {
        const posStore = new InMemoryPosStore();
        await posStore.create(charge(250_000));
        const body = JSON.stringify({ pr: TILL_PR, routes: [] });
        const res = await forward(posStore, body);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(body);
        expect(await recorded(posStore)).toEqual([HASH]);
      });

      it('records nothing for another amount, no charge, or a body without a BOLT11', async () => {
        const other = new InMemoryPosStore();
        await other.create(charge(21));
        await forward(other, JSON.stringify({ pr: TILL_PR }));
        expect(await recorded(other)).toEqual([]);
        const none = new InMemoryPosStore();
        expect((await forward(none, JSON.stringify({ pr: TILL_PR }))).status).toBe(200);
        expect(await recorded(none)).toEqual([]);
        const open = new InMemoryPosStore();
        await open.create(charge(250_000));
        for (const body of ['not json', 'null', '{"status":"ERROR"}', '{"pr":"lnbc1"}']) {
          expect((await forward(open, body)).status).toBe(200);
        }
        expect((await forward(open, JSON.stringify({ pr: TILL_PR }), 404)).status).toBe(404);
        expect(await recorded(open)).toEqual([]);
        expect(parsedEvents(warn).some((e) => e['event'] === 'pos.invoice.record_failed')).toBe(
          false,
        );
      });

      it('keeps the hash off a same-amount charge opened while the invoice was minted', async () => {
        const posStore = new InMemoryPosStore();
        await posStore.create(charge(250_000));
        const store = new InMemoryAuthStore();
        await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
        const { fetchImpl } = recordingFetch(async () => {
          await posStore.cancelPending('acc', NOW);
          await posStore.create({ ...charge(250_000), id: 'c2' });
          return new Response(JSON.stringify({ pr: TILL_PR }), { status: 200 });
        });
        const res = await mount(store, fetchImpl, () => NOW, posStore).request(
          '/lnurlp/ada/invoice?amount=250000000',
        );
        expect(res.status).toBe(200);
        expect(await recorded(posStore)).toEqual([]);
      });

      it('answers 503 without the BOLT11 when another payment holds its hash', async () => {
        const posStore = new InMemoryPosStore();
        await posStore.create(charge(250_000));
        posStore.paymentHashClaims.claimShop(HASH, 'sp-other', 'c9');
        const res = await forward(posStore, JSON.stringify({ pr: TILL_PR }));
        expect(res.status).toBe(503);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'Lightning address service is unavailable' });
        expect(text).not.toContain(TILL_PR);
        expect(
          parsedEvents(warn).filter((event) => event['event'] === 'shop.alert.duplicate_invoice'),
        ).toEqual([
          expect.objectContaining({ chargeId: 'c1', holderChargeId: 'c9', paymentId: 'sp-other' }),
        ]);
        expect(await recorded(posStore)).toEqual([]);
      });

      it('forwards the BOLT11 when the hash is already this charge (this_charge)', async () => {
        const posStore = new InMemoryPosStore();
        await posStore.create(charge(250_000));
        posStore.paymentHashClaims.claimShop(HASH, 'sp-own', 'c1');
        const res = await forward(posStore, JSON.stringify({ pr: TILL_PR }));
        expect(res.status).toBe(200);
        expect(
          parsedEvents(warn).some((event) => event['event'] === 'shop.alert.duplicate_invoice'),
        ).toBe(false);
      });

      it('logs when recording the hash fails and still forwards the invoice', async () => {
        const posStore = new InMemoryPosStore();
        await posStore.create(charge(250_000));
        posStore.recordInvoice = async () => {
          throw new Error('db');
        };
        const res = await forward(posStore, JSON.stringify({ pr: TILL_PR }));
        expect(res.status).toBe(200);
        expect(parsedEvents(warn)).toContainEqual(
          expect.objectContaining({ event: 'pos.invoice.record_failed', accountId: 'acc' }),
        );
      });

      it('still forwards the invoice and logs when the charge store fails', async () => {
        const posStore = new InMemoryPosStore();
        posStore.currentPending = async () => {
          throw new Error('db');
        };
        const res = await forward(posStore, JSON.stringify({ pr: TILL_PR }));
        expect(res.status).toBe(200);
        expect(parsedEvents(warn)).toContainEqual(
          expect.objectContaining({ event: 'pos.invoice.record_failed', accountId: 'acc' }),
        );
      });
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

    it('returns 404 for HEAD without contacting upstream', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(store, fetchImpl).request('/lnurlp/ada/invoice', {
        method: 'HEAD',
      });
      expect(res.status).toBe(404);
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

    it('does not count requests without a client address toward the per-address limit', async () => {
      const store = new InMemoryAuthStore();
      await seedWallet(store, { id: 'acc', username: 'ada', verified: true });
      const { fetchImpl, calls } = recordingFetch(async () => new Response('ok', { status: 200 }));
      const app = mount(store, fetchImpl);
      for (let i = 0; i < 21; i += 1) {
        expect((await app.request('/lnurlp/ada/invoice')).status).toBe(200);
      }
      expect(calls).toHaveLength(21);
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

    it('returns 404 for HEAD without contacting upstream', async () => {
      const { fetchImpl, calls } = recordingFetch(async () => new Response('no'));
      const res = await mount(new InMemoryAuthStore(), fetchImpl).request('/verify/abc123', {
        method: 'HEAD',
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
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
        posStore: new InMemoryPosStore(),
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

describe('shop payment routes', () => {
  const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  async function shopApp(
    shop: ShopPayments,
    options: { fetchImpl?: FetchFn; waitTimeoutMs?: number } = {},
  ): Promise<{ app: Hono; store: InMemoryAuthStore }> {
    const store = new InMemoryAuthStore();
    await seedWallet(store, { id: ACCOUNT_ID, username: 'ada', verified: true });
    await seedWallet(store, {
      id: '00000000-0000-4000-8000-0000000000c2',
      username: 'bob',
      pubkey: PUBKEY_OTHER,
      viewKey: `${'e'.repeat(8)}${'c'.repeat(56)}`,
    });
    const fetchImpl =
      options.fetchImpl ??
      (async () => {
        throw new Error('fetch must not be called');
      });
    const app = new Hono().route(
      '/',
      lnurlServerRoutes({
        auth: store,
        config: CONFIG,
        fetchImpl,
        now: () => NOW,
        posStore: new InMemoryPosStore(),
        shopPayments: shop,
        ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }),
      }),
    );
    return { app, store };
  }

  async function expectStoreFailure(
    res: Response,
    warnSpy: ReturnType<typeof vi.spyOn>,
    route: string,
    text: string,
  ): Promise<void> {
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual(shopErrorBody(503, text));
    expect(parsedEvents(warnSpy)).toContainEqual(
      expect.objectContaining({
        event: 'lnurl_server.failed',
        route,
        name: 'Error',
        code: '57P01',
      }),
    );
  }

  function storeError(): Error {
    return Object.assign(new Error('terminating connection'), { code: '57P01' });
  }

  it('does not mount the shop routes without the service', async () => {
    const store = new InMemoryAuthStore();
    await seedWallet(store, { id: ACCOUNT_ID, username: 'ada', verified: true });
    const app = mount(store, async () => {
      throw new Error('fetch must not be called');
    });
    for (const path of ['/lnurlp/cb/ada', '/lnurlp/tx/ada', `/lnurlp/wait/${PAYMENT_ID}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('404 Not Found');
    }
  });

  it('keeps /lnurlp/cb|tx|wait/invoice as the invoice forward of users cb, tx, and wait', async () => {
    const h = harness();
    const callback = vi.spyOn(h.shop, 'callback');
    const wait = vi.spyOn(h.shop, 'wait');
    const proof = vi.spyOn(shopProof, 'handleShopProof');
    const { fetchImpl, calls } = recordingFetch(async () => Response.json({ pr: 'lnbc1' }));
    const { app, store } = await shopApp(h.shop, { fetchImpl });
    let n = 0;
    for (const username of ['cb', 'tx', 'wait']) {
      n += 1;
      await seedWallet(store, {
        id: `00000000-0000-4000-8000-00000000000${n}`,
        username,
        pubkey: `02${String(n).repeat(64)}`,
        viewKey: `${String(n).repeat(8)}${'d'.repeat(56)}`,
        verified: true,
      });
      const res = await app.request(`/lnurlp/${username}/invoice?amount=1000`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pr: 'lnbc1' });
      expect(calls.at(-1)?.url).toBe(`http://lnurl.test/lnurlp/${username}/invoice?amount=1000`);
    }
    expect(calls).toHaveLength(3);
    expect(callback).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  });

  describe('GET /lnurlp/cb/:username', () => {
    it('answers 503 with the shared body and logs when the service throws', async () => {
      const h = harness();
      vi.spyOn(h.shop, 'callback').mockRejectedValue(storeError());
      const { app } = await shopApp(h.shop);
      await expectStoreFailure(
        await app.request('/lnurlp/cb/ada?amount=1000'),
        warn,
        'callback',
        'Lightning address service is unavailable',
      );
    });

    it('answers the LNURL amount path from the real service', async () => {
      const h = harness();
      const { app } = await shopApp(h.shop);
      const res = await app.request('/lnurlp/cb/Ada?amount=1000');
      expect(res.status).toBe(400);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(await res.json()).toEqual(shopErrorBody(400, 'Amount does not match this payment'));
    });

    it('passes the query and the repeated keys to the service', async () => {
      const h = harness();
      const callback = vi
        .spyOn(h.shop, 'callback')
        .mockImplementation(async () => new Response('ok', { status: 200 }));
      const { app } = await shopApp(h.shop);
      expect((await app.request('/lnurlp/cb/ada')).status).toBe(200);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: ACCOUNT_ID }),
        'ada',
        { amount: null, quote: null, method: null, asset: null, repeated: false },
      );
      await app.request('/lnurlp/cb/ada?amount=1&quote=q&method=Polygon&asset=USDT');
      expect(callback.mock.lastCall?.[2]).toEqual({
        amount: '1',
        quote: 'q',
        method: 'Polygon',
        asset: 'USDT',
        repeated: false,
      });
      for (const key of ['quote', 'method', 'asset', 'amount']) {
        await app.request(`/lnurlp/cb/ada?${key}=1&${key}=2`);
        expect(callback.mock.lastCall?.[2]).toMatchObject({ repeated: true });
      }
    });

    it('answers 404 for an invalid, reserved, unknown, or unverified username', async () => {
      const h = harness();
      const callback = vi.spyOn(h.shop, 'callback');
      const { app } = await shopApp(h.shop);
      for (const username of ['_', 'Invoice', 'missing', 'bob']) {
        const res = await app.request(`/lnurlp/cb/${username}`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(shopErrorBody(404, 'Not found'));
      }
      expect(callback).not.toHaveBeenCalled();
    });

    it('answers 503 over 120 requests per minute per client address', async () => {
      const { app } = await shopApp(harness().shop);
      const headers = { 'cf-connecting-ip': '203.0.113.90' };
      for (let i = 0; i < 120; i += 1) {
        expect((await app.request('/lnurlp/cb/missing', { headers })).status).toBe(404);
      }
      const limited = await app.request('/lnurlp/cb/missing', { headers });
      expect(limited.status).toBe(503);
      expect(await limited.json()).toEqual(shopErrorBody(503, 'Too many requests'));
    });

    it('returns 404 for HEAD', async () => {
      const { app } = await shopApp(harness().shop);
      expect((await app.request('/lnurlp/cb/ada', { method: 'HEAD' })).status).toBe(404);
    });
  });

  describe('GET /lnurlp/tx/:username', () => {
    it('answers 503 Payment is being confirmed and logs when the proof handler throws', async () => {
      const h = harness();
      vi.spyOn(shopProof, 'handleShopProof').mockRejectedValue(storeError());
      const { app } = await shopApp(h.shop);
      await expectStoreFailure(
        await app.request(`/lnurlp/tx/ada?quote=${QUOTE_ID}&method=Polygon&tx=${txHash('a1')}`),
        warn,
        'proof',
        'Payment is being confirmed',
      );
    });

    it('answers 404 Quote expired for a quote this username does not have', async () => {
      const h = harness();
      await seed(h);
      const { app } = await shopApp(h.shop);
      const res = await app.request(
        `/lnurlp/tx/ada?quote=${QUOTE_ID}&method=Polygon&tx=${txHash('a1')}`,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(shopErrorBody(404, 'Quote expired'));
    });

    it('passes the query, the repeated keys, and the limit to the proof handler', async () => {
      const h = harness();
      const proof = vi
        .spyOn(shopProof, 'handleShopProof')
        .mockImplementation(async () => new Response('ok', { status: 200 }));
      const { app } = await shopApp(h.shop);
      await app.request('/lnurlp/tx/Ada?quote=q&method=Polygon&asset=USDT&tx=t&hex=h');
      expect(proof).toHaveBeenLastCalledWith(
        h.shop,
        expect.objectContaining({ id: ACCOUNT_ID }),
        'ada',
        { quote: 'q', method: 'Polygon', asset: 'USDT', tx: 't', hex: 'h', repeated: false },
        false,
      );
      await app.request('/lnurlp/tx/ada');
      expect(proof.mock.lastCall?.[3]).toEqual({
        quote: null,
        method: null,
        asset: null,
        tx: null,
        hex: null,
        repeated: false,
      });
      for (const key of ['quote', 'method', 'asset', 'tx', 'hex']) {
        await app.request(`/lnurlp/tx/ada?${key}=1&${key}=2`);
        expect(proof.mock.lastCall?.[3]).toMatchObject({ repeated: true });
      }
    });

    it('answers 404 for an unknown username, and 503 once over the limit', async () => {
      const h = harness();
      const proof = vi
        .spyOn(shopProof, 'handleShopProof')
        .mockImplementation(async () => new Response('ok', { status: 200 }));
      const { app } = await shopApp(h.shop);
      const headers = { 'cf-connecting-ip': '203.0.113.91' };
      for (let i = 0; i < 120; i += 1) {
        const res = await app.request('/lnurlp/tx/missing', { headers });
        expect(res.status).toBe(404);
        // No quote of a shop payment of an unknown username exists.
        expect(await res.json()).toEqual(shopErrorBody(404, 'Quote expired'));
      }
      const limited = await app.request('/lnurlp/tx/missing', { headers });
      expect(limited.status).toBe(503);
      expect(await limited.json()).toEqual(shopErrorBody(503, 'Too many requests'));
      expect(proof).not.toHaveBeenCalled();
      // A known username over the limit still reaches the handler, which may answer from a stored row.
      await app.request('/lnurlp/tx/ada', { headers });
      expect(proof.mock.lastCall?.[4]).toBe(true);
    });

    it('returns 404 for HEAD', async () => {
      const { app } = await shopApp(harness().shop);
      expect((await app.request('/lnurlp/tx/ada', { method: 'HEAD' })).status).toBe(404);
    });
  });

  describe('GET /lnurlp/wait/:payment', () => {
    it('answers 503 with the shared body and logs when the store throws', async () => {
      const h = harness();
      vi.spyOn(h.shop, 'wait').mockRejectedValue(storeError());
      const { app } = await shopApp(h.shop);
      await expectStoreFailure(
        await app.request(`/lnurlp/wait/${PAYMENT_ID}`),
        warn,
        'wait',
        'Lightning address service is unavailable',
      );
    });

    it('answers the stored payment at once without since', async () => {
      const h = harness();
      await seed(h);
      const { app } = await shopApp(h.shop);
      const res = await app.request(`/lnurlp/wait/${PAYMENT_ID.toUpperCase()}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const payment = await getPayment(h);
      expect(payment).not.toBeNull();
      expect(await res.json()).toEqual(waitBody(payment as NonNullable<typeof payment>));
    });

    it('holds with since up to the injected limit', async () => {
      const h = harness();
      await seed(h);
      const wait = vi.spyOn(h.shop, 'wait');
      const { app } = await shopApp(h.shop, { waitTimeoutMs: 0 });
      const res = await app.request(`/lnurlp/wait/${PAYMENT_ID}?since=open`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'Pending', paymentStatus: 'open' });
      expect(wait).toHaveBeenCalledWith(PAYMENT_ID, 'open', 0);
    });

    it('defaults the hold limit to WAIT_SATS_TIMEOUT_MS', async () => {
      const h = harness();
      const wait = vi.spyOn(h.shop, 'wait').mockResolvedValue(null);
      const { app } = await shopApp(h.shop);
      const res = await app.request(`/lnurlp/wait/${PAYMENT_ID}`);
      expect(res.status).toBe(404);
      expect(wait).toHaveBeenCalledWith(PAYMENT_ID, null, WAIT_SATS_TIMEOUT_MS);
    });

    it('answers 404 for a malformed or unknown id', async () => {
      const h = harness();
      const wait = vi.spyOn(h.shop, 'wait');
      const { app } = await shopApp(h.shop);
      const malformed = await app.request('/lnurlp/wait/not-a-uuid');
      expect(malformed.status).toBe(404);
      expect(await malformed.json()).toEqual(shopErrorBody(404, 'Not found'));
      expect(wait).not.toHaveBeenCalled();
      const unknown = await app.request(`/lnurlp/wait/${PAYMENT_ID}`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual(shopErrorBody(404, 'Not found'));
    });

    it('answers 429 over 120 requests per minute per client address', async () => {
      const { app } = await shopApp(harness().shop);
      const headers = { 'cf-connecting-ip': '203.0.113.92' };
      for (let i = 0; i < 120; i += 1) {
        expect((await app.request('/lnurlp/wait/x', { headers })).status).toBe(404);
      }
      const limited = await app.request('/lnurlp/wait/x', { headers });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual(shopErrorBody(429, 'Too many requests'));
      expect(limited.headers.get('Content-Type')).toBe(
        shopError(429, 'Too many requests').headers.get('Content-Type'),
      );
    });

    it('returns 404 for HEAD', async () => {
      const { app } = await shopApp(harness().shop);
      expect((await app.request(`/lnurlp/wait/${PAYMENT_ID}`, { method: 'HEAD' })).status).toBe(
        404,
      );
    });
  });
});
