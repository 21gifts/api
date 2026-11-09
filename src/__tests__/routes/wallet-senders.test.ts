import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { InMemoryWalletStore, type WalletPaymentRecord } from '@/lib/wallet-store';
import { walletSenderRoutes } from '@/routes/wallet-senders';

const receiver = '11111111-1111-4111-8111-111111111111';
const sender = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-10-01T12:00:00Z');
const headers = { authorization: 'Bearer token', 'content-type': 'application/json' };

async function setup(): Promise<{ auth: InMemoryAuthStore; wallet: InMemoryWalletStore }> {
  const auth = new InMemoryAuthStore();
  for (const [id, username] of [
    [receiver, 'receiver'],
    [sender, 'sender'],
  ]) {
    if (id === undefined || username === undefined) throw new Error('missing fixture');
    await auth.createAccount({
      id,
      username,
      linkingKey: null,
      role: 'verified',
      name: username,
      location: null,
      forumLawsDismissed: false,
      viewKey: id,
      createdAt: 1,
      rulesAgreedAt: 1,
    });
  }
  await auth.createSession({ token: 'token', accountId: receiver, createdAt: now });
  return { auth, wallet: new InMemoryWalletStore() };
}

afterEach(() => vi.restoreAllMocks());

describe('POST /me/wallet/senders', () => {
  it.each([
    ['body is not an object', null],
    ['body is an array', []],
    ['payments is missing', {}],
    ['payments is empty', { payments: [] }],
    ['payments has 33 entries', { payments: Array(33).fill({ id: 'a', invoice: 'x' }) }],
    ['payment is not an object', { payments: [1] }],
    ['payment is an array', { payments: [[]] }],
    ['id is missing', { payments: [{ invoice: 'x' }] }],
    ['id is empty', { payments: [{ id: '', invoice: 'x' }] }],
    ['id is longer than 128 characters', { payments: [{ id: 'a'.repeat(129), invoice: 'x' }] }],
    ['invoice is empty', { payments: [{ id: 'a', invoice: '' }] }],
    [
      'invoice is longer than 4096 characters',
      { payments: [{ id: 'a', invoice: 'x'.repeat(4097) }] },
    ],
    ['invoice is not a string', { payments: [{ id: 'a', invoice: 1 }] }],
    ['invoice contains NUL', { payments: [{ id: 'a', invoice: 'x\u0000y' }] }],
    ['payment hash has 63 characters', { payments: [{ id: 'a', paymentHash: 'a'.repeat(63) }] }],
    ['payment hash is not hexadecimal', { payments: [{ id: 'a', paymentHash: 'g'.repeat(64) }] }],
    ['neither lookup key is present', { payments: [{ id: 'a' }] }],
  ])('rejects invalid input when %s', async (_name, body) => {
    const { auth, wallet } = await setup();
    const app = walletSenderRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const response = await app.request('/me/wallet/senders', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid sender lookup' });
  });

  it('rejects an actual 8193-byte body and the 61st lookup', async () => {
    const { auth, wallet } = await setup();
    const app = walletSenderRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const oversized = await app.request('/me/wallet/senders', {
      method: 'POST',
      headers,
      body: 'x'.repeat(8193),
    });
    expect(oversized.status).toBe(413);
    const limited = walletSenderRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', invoice: 'invoice' }] }),
    };
    for (let index = 0; index < 60; index += 1) {
      expect((await limited.request('/me/wallet/senders', request)).status).toBe(200);
    }
    expect((await limited.request('/me/wallet/senders', request)).status).toBe(429);
  });

  it('authenticates, validates input, caps the body and rate limits', async () => {
    const { auth, wallet } = await setup();
    const app = walletSenderRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    expect((await app.request('/me/wallet/senders', { method: 'POST' })).status).toBe(401);
    for (const body of [
      '{',
      'null',
      '{}',
      '{"payments":[]}',
      JSON.stringify({ payments: Array(33).fill({ id: 'a', invoice: 'x' }) }),
      ...[
        null,
        {},
        { id: '', invoice: 'x' },
        { id: 'a'.repeat(129), invoice: 'x' },
        { id: 'a' },
        { id: 'a', invoice: '' },
        { id: 'a', invoice: 'x'.repeat(4097) },
        { id: 'a', invoice: 1 },
        { id: 'a', paymentHash: 'g'.repeat(64) },
        { id: 'a', paymentHash: 'a'.repeat(63) },
      ].map((item) => JSON.stringify({ payments: [item] })),
    ]) {
      expect(
        (await app.request('/me/wallet/senders', { method: 'POST', headers, body })).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request('/me/wallet/senders', {
          method: 'POST',
          headers: { ...headers, 'content-length': '8193' },
          body: '{}',
        })
      ).status,
    ).toBe(413);
    const limited = walletSenderRoutes({
      authStore: auth,
      walletStore: wallet,
      now: () => now,
      limiter: new IpRateLimiter(1),
    });
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', invoice: 'invoice' }] }),
    };
    expect((await limited.request('/me/wallet/senders', request)).status).toBe(200);
    expect((await limited.request('/me/wallet/senders', request)).status).toBe(429);
  });

  it('returns only unambiguous active sender identities and keeps the first duplicate id', async () => {
    const { auth } = await setup();
    const lookup = vi.fn().mockResolvedValue(
      new Map([
        ['a', [sender]],
        ['ambiguous', [sender, 'another']],
        ['missing', ['missing']],
      ]),
    );
    const app = walletSenderRoutes({
      authStore: auth,
      walletStore: { findPaymentSenders: lookup },
      now: () => now,
    });
    const response = await app.request('/me/wallet/senders', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payments: [
          { id: 'a', paymentHash: 'A'.repeat(64) },
          { id: 'a', invoice: 'second' },
          { id: 'ambiguous', invoice: 'x' },
          { id: 'missing', invoice: 'x' },
          { id: 'none', invoice: 'x' },
        ],
      }),
    });
    expect(await response.json()).toEqual({
      senders: [{ id: 'a', accountId: sender, username: 'sender' }],
    });
    expect(lookup.mock.calls[0]?.[1][0]).toEqual({
      id: 'a',
      invoice: null,
      paymentHash: 'a'.repeat(64),
    });
    expect(lookup.mock.calls[0]?.[1]).toHaveLength(4);
  });

  it('matches invoice or hash but never the client payment id', async () => {
    const { auth, wallet } = await setup();
    const time = new Date(now);
    const row: WalletPaymentRecord = {
      accountId: sender,
      paymentId: 'sdk-id',
      direction: 'out',
      status: 'completed',
      amountSats: 1,
      feeSats: 0,
      paidAt: time,
      method: 'spark',
      paymentHash: 'A'.repeat(64),
      invoice: 'spark1invoice',
      destination: null,
      description: null,
      lnurlComment: null,
      category: 'member',
      counterpartyAccountId: receiver,
      firstSeenAt: time,
      updatedAt: time,
    };
    await wallet.upsertPayments([row, { ...row, paymentId: 'second' }]);
    const app = walletSenderRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const response = await app.request('/me/wallet/senders', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payments: [
          { id: 'invoice', invoice: 'spark1invoice' },
          { id: 'hash', paymentHash: 'A'.repeat(64) },
          { id: 'sdk-id', invoice: 'different' },
        ],
      }),
    });
    expect(await response.json()).toEqual({
      senders: [
        { id: 'invoice', accountId: sender, username: 'sender' },
        { id: 'hash', accountId: sender, username: 'sender' },
      ],
    });
  });

  it('logs and returns 503 on lookup failure', async () => {
    const { auth } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = walletSenderRoutes({
      authStore: auth,
      walletStore: { findPaymentSenders: () => Promise.reject(new Error('secret')) },
      now: () => now,
    });
    const response = await app.request('/me/wallet/senders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', invoice: 'x' }] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Sender lookup is unavailable' });
    expect(String(warn.mock.calls[0]?.[0])).toContain('wallet_senders.lookup.failed');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it('omits a platform account and an account with no username', async () => {
    const { auth } = await setup();
    const original = auth.getAccount.bind(auth);
    const app = walletSenderRoutes({
      authStore: auth,
      walletStore: { findPaymentSenders: () => Promise.resolve(new Map([['a', [sender]]])) },
      now: () => now,
    });
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'a', invoice: 'invoice' }] }),
    };
    for (const change of [{ isPlatform: true }, { username: '' }, { username: null }]) {
      vi.spyOn(auth, 'getAccount').mockImplementation(async (id) => {
        const account = await original(id);
        return id === sender && account !== undefined ? { ...account, ...change } : account;
      });
      expect(await (await app.request('/me/wallet/senders', request)).json()).toEqual({
        senders: [],
      });
      vi.restoreAllMocks();
    }
  });
});
