import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { InMemoryWalletStore, type WalletPaymentRecord } from '@/lib/wallet-store';
import { walletCounterpartyRoutes } from '@/routes/wallet-counterparties';

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

describe('POST /me/wallet/counterparties', () => {
  it.each([
    ['body is not an object', null],
    ['body is a number', 1],
    ['body is an array', []],
    ['payments is missing', {}],
    ['payments is empty', { payments: [] }],
    [
      'payments has 33 entries',
      { payments: Array(33).fill({ id: 'a', direction: 'in', invoice: 'x' }) },
    ],
    ['payment is not an object', { payments: [1] }],
    ['payment is an array', { payments: [[]] }],
    ['id is missing', { payments: [{ direction: 'in', invoice: 'x' }] }],
    ['direction is missing', { payments: [{ id: 'a', invoice: 'x' }] }],
    ['direction is invalid', { payments: [{ id: 'a', direction: 'other', invoice: 'x' }] }],
    ['id is empty', { payments: [{ id: '', direction: 'in', invoice: 'x' }] }],
    [
      'id is longer than 128 characters',
      { payments: [{ id: 'a'.repeat(129), direction: 'in', invoice: 'x' }] },
    ],
  ])('rejects invalid input when %s', async (_name, body) => {
    const { auth, wallet } = await setup();
    const app = walletCounterpartyRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid counterparty lookup' });
  });

  it('rejects an actual 8193-byte body and the 61st lookup', async () => {
    const { auth, wallet } = await setup();
    const app = walletCounterpartyRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const oversized = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: 'x'.repeat(8193),
    });
    expect(oversized.status).toBe(413);
    const limited = walletCounterpartyRoutes({
      authStore: auth,
      walletStore: wallet,
      now: () => now,
    });
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', direction: 'in', invoice: 'invoice' }] }),
    };
    for (let index = 0; index < 60; index += 1) {
      expect((await limited.request('/me/wallet/counterparties', request)).status).toBe(200);
    }
    expect((await limited.request('/me/wallet/counterparties', request)).status).toBe(429);
  });

  it('authenticates, validates input, caps the body and rate limits', async () => {
    const { auth, wallet } = await setup();
    const app = walletCounterpartyRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    expect((await app.request('/me/wallet/counterparties', { method: 'POST' })).status).toBe(401);
    for (const body of [
      '{',
      'null',
      '{}',
      '{"payments":[]}',
      JSON.stringify({ payments: Array(33).fill({ id: 'a', direction: 'in', invoice: 'x' }) }),
      ...[
        null,
        {},
        { id: '', direction: 'in', invoice: 'x' },
        { id: 'a'.repeat(129), direction: 'in', invoice: 'x' },
        { id: 'a' },
      ].map((item) => JSON.stringify({ payments: [item] })),
    ]) {
      expect(
        (await app.request('/me/wallet/counterparties', { method: 'POST', headers, body })).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request('/me/wallet/counterparties', {
          method: 'POST',
          headers: { ...headers, 'content-length': '8193' },
          body: '{}',
        })
      ).status,
    ).toBe(413);
    const limited = walletCounterpartyRoutes({
      authStore: auth,
      walletStore: wallet,
      now: () => now,
      limiter: new IpRateLimiter(1),
    });
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', direction: 'in', invoice: 'invoice' }] }),
    };
    expect((await limited.request('/me/wallet/counterparties', request)).status).toBe(200);
    expect((await limited.request('/me/wallet/counterparties', request)).status).toBe(429);
  });

  it.each(['in', 'out'] as const)(
    'returns only unambiguous active identities for %s and keeps the first duplicate id',
    async (direction) => {
      const { auth } = await setup();
      const lookup = vi.fn().mockResolvedValue(
        new Map([
          ['a', [sender]],
          ['ambiguous', [sender, 'another']],
          ['missing', ['missing']],
        ]),
      );
      const app = walletCounterpartyRoutes({
        authStore: auth,
        walletStore: { findPaymentCounterparties: lookup },
        now: () => now,
      });
      const response = await app.request('/me/wallet/counterparties', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          payments: [
            { id: 'a', direction, invoice: 42, paymentHash: 'invalid' },
            { id: 'a', direction: direction === 'in' ? 'out' : 'in', invoice: 'second' },
            { id: 'ambiguous', direction, invoice: 'x' },
            { id: 'missing', direction, invoice: 'x' },
            { id: 'none', direction, invoice: 'x' },
          ],
        }),
      });
      expect(await response.json()).toEqual({
        counterparties: [{ id: 'a', accountId: sender, username: 'sender' }],
      });
      expect(lookup.mock.calls[0]?.[1][0]).toEqual({
        id: 'a',
        direction,
      });
      expect(lookup.mock.calls[0]?.[1]).toHaveLength(4);
    },
  );

  it('matches completed payments by id and uses the caller’s outgoing counterparty', async () => {
    const { auth, wallet } = await setup();
    const time = new Date(now);
    const row: WalletPaymentRecord = {
      accountId: sender,
      paymentId: 'shared',
      direction: 'out',
      status: 'completed',
      amountSats: 1,
      feeSats: 0,
      paidAt: time,
      method: 'spark',
      paymentHash: null,
      invoice: null,
      destination: null,
      description: null,
      lnurlComment: null,
      category: 'member',
      counterpartyAccountId: null,
      firstSeenAt: time,
      updatedAt: time,
    };
    await wallet.upsertPayments([
      row,
      { ...row, accountId: receiver, direction: 'in' },
      { ...row, paymentId: 'out', accountId: receiver, counterpartyAccountId: sender },
      { ...row, paymentId: 'null', accountId: receiver },
      { ...row, paymentId: 'self', accountId: receiver, counterpartyAccountId: receiver },
      { ...row, paymentId: 'pending-own' },
      { ...row, paymentId: 'pending-own', accountId: receiver, direction: 'in', status: 'pending' },
      { ...row, paymentId: 'wrong-direction' },
      { ...row, paymentId: 'wrong-direction', accountId: receiver },
      { ...row, paymentId: 'pending-sender', status: 'pending' },
      { ...row, paymentId: 'pending-sender', accountId: receiver, direction: 'in' },
      { ...row, paymentId: 'ambiguous' },
      { ...row, paymentId: 'ambiguous', accountId: '33333333-3333-4333-8333-333333333333' },
      { ...row, paymentId: 'ambiguous', accountId: receiver, direction: 'in' },
    ]);
    const app = walletCounterpartyRoutes({ authStore: auth, walletStore: wallet, now: () => now });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payments: [
          { id: 'shared', direction: 'in', invoice: 42, paymentHash: 'invalid' },
          { id: 'out', direction: 'out' },
          { id: 'null', direction: 'out' },
          { id: 'self', direction: 'out' },
          { id: 'pending-own', direction: 'in' },
          { id: 'wrong-direction', direction: 'in' },
          { id: 'pending-sender', direction: 'in' },
          { id: 'ambiguous', direction: 'in' },
          { id: 'missing', direction: 'in' },
        ],
      }),
    });
    expect(await response.json()).toEqual({
      counterparties: [
        { id: 'shared', accountId: sender, username: 'sender' },
        { id: 'out', accountId: sender, username: 'sender' },
      ],
    });
  });

  it('logs and returns 503 on lookup failure', async () => {
    const { auth } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = walletCounterpartyRoutes({
      authStore: auth,
      walletStore: { findPaymentCounterparties: () => Promise.reject(new Error('secret')) },
      now: () => now,
    });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', direction: 'in', invoice: 'x' }] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Counterparty lookup is unavailable' });
    expect(String(warn.mock.calls[0]?.[0])).toContain('wallet_counterparties.lookup.failed');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it.each(['in', 'out'] as const)(
    'omits a platform account and an account with no username for %s',
    async (direction) => {
      const { auth } = await setup();
      const original = auth.getAccount.bind(auth);
      const app = walletCounterpartyRoutes({
        authStore: auth,
        walletStore: {
          findPaymentCounterparties: () => Promise.resolve(new Map([['a', [sender]]])),
        },
        now: () => now,
      });
      const request = {
        method: 'POST',
        headers,
        body: JSON.stringify({ payments: [{ id: 'a', direction, invoice: 'invoice' }] }),
      };
      for (const change of [
        { isPlatform: true },
        { username: '' },
        { username: '   ' },
        { username: null },
      ]) {
        vi.spyOn(auth, 'getAccount').mockImplementation(async (id) => {
          const account = await original(id);
          return id === sender && account !== undefined ? { ...account, ...change } : account;
        });
        expect(await (await app.request('/me/wallet/counterparties', request)).json()).toEqual({
          counterparties: [],
        });
        vi.restoreAllMocks();
      }
    },
  );
});
