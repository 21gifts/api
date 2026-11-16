import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { InMemoryWalletStore, type WalletPaymentRecord } from '@/lib/wallet-store';
import {
  InMemoryWalletTransferStore,
  type WalletTransferRecord,
} from '@/lib/wallet-transfer-store';
import { walletCounterpartyRoutes } from '@/routes/wallet-counterparties';
import { createApp } from '@/server';

const receiver = '11111111-1111-4111-8111-111111111111';
const sender = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-10-01T12:00:00Z');
const headers = { authorization: 'Bearer token', 'content-type': 'application/json' };
const receiverKey = `02${'a'.repeat(64)}`;
const senderKey = `03${'b'.repeat(64)}`;

interface Fixture {
  auth: InMemoryAuthStore;
  wallet: InMemoryWalletStore;
  transfers: InMemoryWalletTransferStore;
}

async function setup(): Promise<Fixture> {
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
  return {
    auth,
    wallet: new InMemoryWalletStore(),
    transfers: new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async (pubkey) =>
        pubkey === senderKey ? sender : pubkey === receiverKey ? receiver : null,
    }),
  };
}

function routes(fixture: Fixture, limiter?: IpRateLimiter) {
  return walletCounterpartyRoutes({
    authStore: fixture.auth,
    walletStore: fixture.wallet,
    walletTransfers: fixture.transfers,
    now: () => now,
    ...(limiter === undefined ? {} : { limiter }),
  });
}

function reported(
  paymentId: string,
  extra: Partial<WalletPaymentRecord> = {},
): WalletPaymentRecord {
  const time = new Date(now);
  return {
    accountId: receiver,
    paymentId,
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
    ...extra,
  };
}

function observed(
  transferId: string,
  extra: Partial<WalletTransferRecord> = {},
): WalletTransferRecord {
  const time = new Date(now);
  return {
    accountId: receiver,
    walletPubkey: receiverKey,
    transferId,
    direction: 'out',
    type: 'transfer',
    status: 'completed',
    amountSats: 1,
    counterpartyPubkey: senderKey,
    counterpartyPubkeys: [extra.counterpartyPubkey ?? senderKey],
    sparkInvoice: null,
    transferCreatedAt: time,
    transferUpdatedAt: time,
    seenAt: time,
    ...extra,
  };
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
    ['id is only whitespace', { payments: [{ id: '   ', direction: 'in', invoice: 'x' }] }],
    [
      'id is longer than 256 characters after trim',
      { payments: [{ id: ` ${'a'.repeat(257)} `, direction: 'in', invoice: 'x' }] },
    ],
  ])('rejects invalid input when %s', async (_name, body) => {
    const fixture = await setup();
    const app = routes(fixture);
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid counterparty lookup' });
  });

  it('rejects an actual 16385-byte body and the 61st lookup', async () => {
    const fixture = await setup();
    const app = routes(fixture);
    const oversized = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: 'x'.repeat(16385),
    });
    expect(oversized.status).toBe(413);
    const limited = routes(fixture);
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

  it('finds one trimmed id of 256 characters and drops the duplicate', async () => {
    const { auth } = await setup();
    const id = 'p'.repeat(256);
    const owned = vi.fn().mockResolvedValue(new Set([id]));
    const lookup = vi.fn().mockResolvedValue(new Map([[id, [sender]]]));
    const app = walletCounterpartyRoutes({
      authStore: auth,
      walletStore: { findCompletedPayments: owned },
      walletTransfers: { findObservedCounterparties: lookup },
      now: () => now,
    });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payments: [
          { id: `  ${id}  `, direction: 'in' },
          { id: ` ${id}`, direction: 'out' },
          { id, direction: 'out' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      counterparties: [{ id, accountId: sender, username: 'sender' }],
    });
    expect(owned.mock.calls[0]).toEqual([receiver, [{ id, direction: 'in' }]]);
    expect(lookup.mock.calls[0]).toEqual([receiver, [{ id, direction: 'in' }]]);
  });

  it('accepts 32 ids of 256 characters within 16384 bytes', async () => {
    const fixture = await setup();
    const app = routes(fixture);
    const payments = Array.from({ length: 32 }, (_, index) => ({
      id: `${index}`.padStart(256, 'a'),
      direction: 'in' as const,
    }));
    const body = JSON.stringify({ payments });
    expect(body.length).toBeLessThan(16384);
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counterparties: [] });
  });

  it('authenticates, validates input, caps the body and rate limits', async () => {
    const fixture = await setup();
    const app = routes(fixture);
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
        { id: '   ', direction: 'in', invoice: 'x' },
        { id: ` ${'a'.repeat(257)} `, direction: 'in', invoice: 'x' },
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
          headers: { ...headers, 'content-length': '16385' },
          body: '{}',
        })
      ).status,
    ).toBe(413);
    const limited = routes(fixture, new IpRateLimiter(1));
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
        walletStore: {
          findCompletedPayments: async (_accountId, keys) => new Set(keys.map((key) => key.id)),
        },
        walletTransfers: { findObservedCounterparties: lookup },
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

  it('names only the other side of the caller’s own completed, server-observed transfer', async () => {
    const fixture = await setup();
    await fixture.wallet.upsertPayments([
      reported('observed-in', { direction: 'in' }),
      reported('observed-out'),
      reported('unobserved'),
      reported('pending-own', { status: 'pending' }),
      reported('pending-transfer'),
      reported('self'),
      reported('unresolved'),
      reported('reported-only', { direction: 'in' }),
      reported('reported-only', { accountId: sender, counterpartyAccountId: receiver }),
      reported('sender-transfer', { direction: 'in' }),
    ]);
    for (const row of [
      observed('observed-in', { direction: 'in' }),
      observed('observed-out'),
      observed('pending-own'),
      observed('pending-transfer', { status: 'pending' }),
      observed('self', { counterpartyPubkey: receiverKey }),
      observed('unresolved', { counterpartyPubkey: `02${'c'.repeat(64)}` }),
      observed('not-reported'),
      observed('sender-transfer', {
        accountId: sender,
        walletPubkey: senderKey,
        counterpartyPubkey: receiverKey,
      }),
    ]) {
      await fixture.transfers.upsertTransfer(row);
    }
    const response = await routes(fixture).request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payments: [
          { id: 'observed-in', direction: 'in' },
          { id: 'observed-out', direction: 'out' },
          { id: 'observed-out', direction: 'in' },
          { id: 'unobserved', direction: 'out' },
          { id: 'pending-own', direction: 'out' },
          { id: 'pending-transfer', direction: 'out' },
          { id: 'self', direction: 'out' },
          { id: 'unresolved', direction: 'out' },
          { id: 'not-reported', direction: 'out' },
          { id: 'reported-only', direction: 'in' },
          { id: 'sender-transfer', direction: 'in' },
        ],
      }),
    });
    expect(await response.json()).toEqual({
      counterparties: [
        { id: 'observed-in', accountId: sender, username: 'sender' },
        { id: 'observed-out', accountId: sender, username: 'sender' },
      ],
    });
  });

  it('does not read observed transfers when the caller owns none of the payments', async () => {
    const { auth } = await setup();
    const lookup = vi.fn();
    const app = walletCounterpartyRoutes({
      authStore: auth,
      walletStore: { findCompletedPayments: async () => new Set<string>() },
      walletTransfers: { findObservedCounterparties: lookup },
      now: () => now,
    });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', direction: 'in' }] }),
    });
    expect(await response.json()).toEqual({ counterparties: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the payment report store',
      {
        findCompletedPayments: () => Promise.reject(new Error('secret')),
      },
      { findObservedCounterparties: async () => new Map<string, string[]>() },
    ],
    [
      'the observed transfer store',
      { findCompletedPayments: async () => new Set(['x']) },
      { findObservedCounterparties: () => Promise.reject(new Error('secret')) },
    ],
  ])('logs and returns 503 when %s fails', async (_name, walletStore, walletTransfers) => {
    const { auth } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = walletCounterpartyRoutes({
      authStore: auth,
      walletStore,
      walletTransfers,
      now: () => now,
    });
    const response = await app.request('/me/wallet/counterparties', {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'x', direction: 'in' }] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Counterparty lookup is unavailable' });
    expect(String(warn.mock.calls[0]?.[0])).toContain('wallet_counterparties.lookup.failed');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret');
  });

  it('is mounted by createApp on the observed transfer store it is given', async () => {
    const fixture = await setup();
    await fixture.wallet.upsertPayments([reported('observed-out')]);
    await fixture.transfers.upsertTransfer(observed('observed-out'));
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ payments: [{ id: 'observed-out', direction: 'out' }] }),
    };
    const mounted = createApp({
      authStore: fixture.auth,
      walletStore: fixture.wallet,
      walletTransferStore: fixture.transfers,
      walletCounterparties: fixture.transfers,
      now: () => now,
    });
    expect(await (await mounted.request('/me/wallet/counterparties', request)).json()).toEqual({
      counterparties: [{ id: 'observed-out', accountId: sender, username: 'sender' }],
    });
    const withoutObserved = createApp({
      authStore: fixture.auth,
      walletStore: fixture.wallet,
      now: () => now,
    });
    expect(
      await (await withoutObserved.request('/me/wallet/counterparties', request)).json(),
    ).toEqual({ counterparties: [] });
  });

  it.each(['in', 'out'] as const)(
    'omits a platform account and an account with no username for %s',
    async (direction) => {
      const { auth } = await setup();
      const original = auth.getAccount.bind(auth);
      const app = walletCounterpartyRoutes({
        authStore: auth,
        walletStore: { findCompletedPayments: async () => new Set(['a']) },
        walletTransfers: {
          findObservedCounterparties: () => Promise.resolve(new Map([['a', [sender]]])),
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
