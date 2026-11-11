import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { WalletAccountKind } from '@/lib/wallet-category';
import { parseWalletReport } from '@/lib/wallet-report';
import {
  InMemoryWalletStore,
  migrateWalletSchema,
  PostgresWalletStore,
  repairWalletPaymentPairs,
  WALLET_SCHEMA_SQL,
  type WalletBalanceSnapshot,
  type WalletPaymentRecord,
} from '@/lib/wallet-store';

class MockSql implements SqlClient {
  executes: Array<{ text: string; params: readonly unknown[] }> = [];
  queries: Array<{ text: string; params: readonly unknown[] }> = [];
  rows: unknown[] = [];
  failAt: number | undefined;

  query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return Promise.resolve(this.rows as T[]);
  }

  execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.failAt === this.executes.length) {
      return Promise.reject(new Error('sql failed'));
    }
    return Promise.resolve();
  }
}

const T1 = new Date('2026-10-01T00:00:00.000Z');
const T2 = new Date('2026-10-02T00:00:00.000Z');

function balance(extra: Partial<WalletBalanceSnapshot> = {}): WalletBalanceSnapshot {
  return {
    id: 'a',
    accountId: 'account',
    balanceSats: 21,
    syncedAt: T1,
    receivedAt: T1,
    ...extra,
  };
}

function payment(extra: Partial<WalletPaymentRecord> = {}): WalletPaymentRecord {
  return {
    accountId: 'account',
    paymentId: 'p',
    direction: 'out',
    status: 'pending',
    amountSats: 21,
    feeSats: 1,
    paidAt: T1,
    method: 'bolt11',
    paymentHash: 'a'.repeat(64),
    invoice: 'lnbc',
    destination: 'alice@example.test',
    description: 'one',
    lnurlComment: 'two',
    category: 'member',
    counterpartyAccountId: 'other',
    firstSeenAt: T1,
    updatedAt: T1,
    ...extra,
  };
}

describe('wallet schema', () => {
  it('contains the exact idempotent tables, migration order, and mirrored documentation', async () => {
    expect(WALLET_SCHEMA_SQL).toHaveLength(7);
    expect(WALLET_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS wallet_balance_snapshot/);
    expect(WALLET_SCHEMA_SQL[1]).toMatch(/received_at DESC, id DESC/);
    expect(WALLET_SCHEMA_SQL[2]).toMatch(/PRIMARY KEY \(account_id, payment_id\)/);
    expect(WALLET_SCHEMA_SQL[2]).toContain("'outside_lightning'");
    expect(WALLET_SCHEMA_SQL[3]).toBe(
      'ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS invoice text',
    );
    expect(WALLET_SCHEMA_SQL[4]).toBe(
      'ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS last_observed_at timestamptz',
    );
    expect(WALLET_SCHEMA_SQL[5]).toMatch(/paid_at DESC, payment_id DESC/);
    expect(WALLET_SCHEMA_SQL[6]).toBe(
      'CREATE INDEX IF NOT EXISTS wallet_payment_payment_id_idx ON wallet_payment (payment_id)',
    );
    const documented = readFileSync(join(process.cwd(), 'docs/schema/wallet.sql'), 'utf8');
    for (const statement of WALLET_SCHEMA_SQL) {
      expect(documented).toContain(statement);
    }
    const sql = new MockSql();
    await migrateWalletSchema(sql);
    expect(sql.executes.map((entry) => entry.text)).toEqual([...WALLET_SCHEMA_SQL]);
    sql.failAt = 1;
    sql.executes = [];
    await expect(migrateWalletSchema(sql)).rejects.toThrow('sql failed');
    expect(sql.executes).toHaveLength(1);
  });
});

describe('InMemoryWalletStore', () => {
  it('records snapshots, returns newest with id tie-break, filters accounts, and copies dates', async () => {
    const store = new InMemoryWalletStore();
    expect(await store.latestBalance('account')).toBeUndefined();
    await store.recordBalance(balance({ id: 'a' }));
    await store.recordBalance(balance({ id: 'b', receivedAt: T2 }));
    await store.recordBalance(balance({ id: 'd', receivedAt: new Date(T2) }));
    await store.recordBalance(balance({ id: 'c', accountId: 'other', receivedAt: T2 }));
    const latest = await store.latestBalance('account');
    expect(latest?.id).toBe('d');
    latest?.syncedAt.setTime(0);
    latest?.receivedAt.setTime(0);
    expect((await store.latestBalance('account'))?.receivedAt).toEqual(T2);
  });

  it('returns the last snapshot per account and UTC day, with the id tie-break', async () => {
    const store = new InMemoryWalletStore();
    await store.recordBalance(balance({ id: 'a', balanceSats: 1 }));
    await store.recordBalance(balance({ id: 'b', balanceSats: 2 }));
    await store.recordBalance(balance({ id: 'c', balanceSats: 3, receivedAt: T2 }));
    await store.recordBalance(balance({ id: 'd', balanceSats: 4, receivedAt: new Date(T2) }));
    await store.recordBalance(balance({ id: 'a0', balanceSats: 6, receivedAt: new Date(T2) }));
    await store.recordBalance(
      balance({ id: 'e', accountId: 'other', balanceSats: 5, receivedAt: T2 }),
    );
    const rows = await store.dailyBalances();
    expect(rows.map((row) => [row.accountId, row.id, row.balanceSats])).toEqual([
      ['account', 'b', 2],
      ['account', 'd', 4],
      ['other', 'e', 5],
    ]);
    rows[0]?.receivedAt.setTime(0);
    expect((await store.dailyBalances())[0]?.receivedAt).toEqual(T1);
  });

  it('inserts, sorts, limits, isolates accounts, and returns date copies', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      payment({ paymentId: 'a' }),
      payment({ paymentId: 'b', paidAt: new Date(T1) }),
      payment({ paymentId: 'c', paidAt: T2 }),
      payment({ accountId: 'other', paymentId: 'z', paidAt: T2 }),
    ]);
    const rows = await store.listPayments('account', 2);
    expect(rows.map((row) => row.paymentId)).toEqual(['c', 'b']);
    rows[0]?.paidAt.setTime(0);
    rows[0]?.firstSeenAt.setTime(0);
    rows[0]?.updatedAt.setTime(0);
    expect((await store.listPayments('account', 1))[0]?.paidAt).toEqual(T2);
  });

  it('aggregates completed payments by direction and ignores other states and accounts', async () => {
    const store = new InMemoryWalletStore();
    expect(await store.paymentTotals('account')).toEqual({
      receivedSats: 0n,
      paidOutSats: 0n,
      feesSats: 0n,
    });
    await store.upsertPayments([
      payment({ paymentId: 'in-1', direction: 'in', status: 'completed', amountSats: 1_000 }),
      payment({ paymentId: 'in-2', direction: 'in', status: 'completed', amountSats: 250 }),
      payment({
        paymentId: 'out-1',
        direction: 'out',
        status: 'completed',
        amountSats: 40,
        feeSats: 2,
      }),
      payment({
        paymentId: 'out-2',
        direction: 'out',
        status: 'completed',
        amountSats: 1,
        feeSats: 3,
      }),
      payment({ paymentId: 'pending', status: 'pending', amountSats: 9_999 }),
      payment({ paymentId: 'failed', direction: 'in', status: 'failed', amountSats: 8_888 }),
      payment({ accountId: 'other', paymentId: 'other', status: 'completed', amountSats: 7_777 }),
    ]);
    expect(await store.paymentTotals('account')).toEqual({
      receivedSats: 1_250n,
      paidOutSats: 41n,
      feesSats: 5n,
    });
  });

  it('updates mutable fields, coalesces null details, preserves firstSeenAt, and advances updatedAt only on change', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([payment()]);
    await store.upsertPayments([
      payment({
        direction: 'in',
        status: 'completed',
        amountSats: 42,
        feeSats: 2,
        paidAt: T2,
        method: 'spark',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: 'changed',
        lnurlComment: null,
        category: 'shop',
        counterpartyAccountId: null,
        firstSeenAt: T2,
        updatedAt: T2,
      }),
    ]);
    const changed = (await store.listPayments('account', 1))[0];
    expect(changed).toMatchObject({
      direction: 'in',
      status: 'completed',
      amountSats: 42,
      feeSats: 2,
      method: 'spark',
      paymentHash: 'a'.repeat(64),
      invoice: 'lnbc',
      destination: 'alice@example.test',
      description: 'changed',
      lnurlComment: 'two',
      category: 'shop',
      counterpartyAccountId: null,
      firstSeenAt: T1,
      updatedAt: T2,
    });
    const later = new Date('2026-10-03T00:00:00.000Z');
    await store.upsertPayments([{ ...changed!, updatedAt: later }]);
    expect((await store.listPayments('account', 1))[0]?.updatedAt).toEqual(T2);
  });

  it('never turns a resolved category back into a fallback one, but upgrades and switches resolved ones', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([payment({ category: 'gift', counterpartyAccountId: 'other' })]);
    await store.upsertPayments([
      payment({ category: 'outside_lightning', counterpartyAccountId: null, updatedAt: T2 }),
    ]);
    expect((await store.listPayments('account', 1))[0]).toMatchObject({
      category: 'gift',
      counterpartyAccountId: 'other',
      updatedAt: T1,
    });
    await store.upsertPayments([
      payment({ category: 'shop', counterpartyAccountId: 'shop-account', updatedAt: T2 }),
    ]);
    expect((await store.listPayments('account', 1))[0]).toMatchObject({
      category: 'shop',
      counterpartyAccountId: 'shop-account',
      updatedAt: T2,
    });

    const fallback = new InMemoryWalletStore();
    await fallback.upsertPayments([payment({ category: 'unknown', counterpartyAccountId: null })]);
    await fallback.upsertPayments([
      payment({ category: 'onchain', updatedAt: T2, counterpartyAccountId: null }),
    ]);
    expect((await fallback.listPayments('account', 1))[0]?.category).toBe('onchain');
    await fallback.upsertPayments([payment({ category: 'member', updatedAt: T2 })]);
    expect((await fallback.listPayments('account', 1))[0]).toMatchObject({
      category: 'member',
      counterpartyAccountId: 'other',
    });
  });

  it('orders equal paidAt by payment id in UTF-8 byte order, like Postgres COLLATE "C"', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      payment({ paymentId: 'B' }),
      payment({ paymentId: 'a' }),
      payment({ paymentId: '\uE000' }),
      payment({ paymentId: '\u{10000}' }),
    ]);
    // UTF-8: U+10000 (F0 …) sorts after U+E000 (EE …), unlike UTF-16 code units.
    expect((await store.listPayments('account', 10)).map((row) => row.paymentId)).toEqual([
      '\u{10000}',
      '\uE000',
      'a',
      'B',
    ]);
  });

  it('pages payments after a paidAt and payment id position in the same newest-first order', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      payment({ paymentId: 'd', paidAt: T2 }),
      payment({ paymentId: 'c', paidAt: T2 }),
      payment({ paymentId: 'b', paidAt: T1 }),
      payment({ paymentId: 'a', paidAt: T1 }),
      payment({ paymentId: '0', paidAt: new Date(T1.getTime() - 1) }),
    ]);
    const first = await store.listPayments('account', 2);
    expect(first.map((row) => row.paymentId)).toEqual(['d', 'c']);
    const second = await store.listPayments('account', 2, {
      paidAt: first[1]?.paidAt ?? T2,
      paymentId: 'c',
    });
    expect(second.map((row) => row.paymentId)).toEqual(['b', 'a']);
    await expect(store.listPayments('account', 2, { paidAt: T2, paymentId: 'c' })).resolves.toEqual(
      second,
    );
    await expect(store.listPayments('account', 2, { paidAt: T1, paymentId: 'a' })).resolves.toEqual(
      [expect.objectContaining({ paymentId: '0' })],
    );
    await expect(
      store.listPayments('account', 2, {
        paidAt: new Date(T1.getTime() - 1),
        paymentId: '0',
      }),
    ).resolves.toEqual([]);
  });

  it('filters by status and applies an exclusive (paidAt, paymentId) keyset', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      payment({ paymentId: 'A', status: 'completed', paidAt: T1 }),
      payment({ paymentId: 'B', status: 'pending', paidAt: T1 }),
      payment({ paymentId: 'C', status: 'completed', paidAt: T1 }),
      payment({ paymentId: 'D', status: 'completed', paidAt: T2 }),
      payment({ accountId: 'other', paymentId: 'E', status: 'completed', paidAt: T1 }),
    ]);
    expect(
      (await store.listPayments('account', 10, undefined, { status: 'completed' })).map(
        (row) => row.paymentId,
      ),
    ).toEqual(['D', 'C', 'A']);
    expect(
      (
        await store.listPayments(
          'account',
          10,
          { paidAt: T1, paymentId: 'C' },
          { status: 'completed' },
        )
      ).map((row) => row.paymentId),
    ).toEqual(['A']);
    expect(
      (
        await store.listPayments('account', 10, { paidAt: T1, paymentId: 'B' })
      ).map((row) => row.paymentId),
    ).toEqual(['A']);
    expect(
      (
        await store.listPayments('account', 10, { paidAt: T2, paymentId: 'D' })
      ).map((row) => row.paymentId),
    ).toEqual(['C', 'B', 'A']);
  });

  it('filters by an exact paid time without changing the unfiltered list', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      payment({ paymentId: 'T1-a', status: 'completed', paidAt: T1 }),
      payment({ paymentId: 'T1-b', status: 'pending', paidAt: T1 }),
      payment({ paymentId: 'T2', status: 'completed', paidAt: T2 }),
    ]);
    expect(await store.listPayments('account', 10)).toHaveLength(3);
    expect(
      (await store.listPayments('account', 10, undefined, { paidAt: new Date(T1) })).map(
        (row) => row.paymentId,
      ),
    ).toEqual(['T1-b', 'T1-a']);
    expect(
      (
        await store.listPayments('account', 10, undefined, {
          status: 'completed',
          paidAt: new Date(T1),
        })
      ).map((row) => row.paymentId),
    ).toEqual(['T1-a']);
    const after = { paidAt: T1, paymentId: 'T1-b' };
    expect(
      (await store.listPayments('account', 10, after, { paidAt: new Date(T1) })).map(
        (row) => row.paymentId,
      ),
    ).toEqual(['T1-a']);
    expect(
      (
        await store.listPayments('account', 10, after, {
          status: 'completed',
          paidAt: new Date(T1),
        })
      ).map((row) => row.paymentId),
    ).toEqual(['T1-a']);
  });

  it('advances the staleness watermark on a no-op re-send, so an older different report is ignored', async () => {
    const t0 = new Date('2026-10-01T00:00:00.000Z');
    const t1 = new Date('2026-10-01T00:00:01.000Z');
    const t2 = new Date('2026-10-01T00:00:02.000Z');
    const store = new InMemoryWalletStore();
    await store.upsertPayments([payment({ status: 'completed', firstSeenAt: t0, updatedAt: t0 })]);
    await store.upsertPayments([payment({ status: 'completed', firstSeenAt: t2, updatedAt: t2 })]);
    expect((await store.listPayments('account', 1))[0]?.updatedAt).toEqual(t0);
    await store.upsertPayments([payment({ status: 'pending', firstSeenAt: t1, updatedAt: t1 })]);
    expect((await store.listPayments('account', 1))[0]).toMatchObject({
      status: 'completed',
      updatedAt: t0,
    });
  });

  it('ignores a report observed before the stored state', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([payment({ status: 'completed', updatedAt: T2, firstSeenAt: T2 })]);
    await store.upsertPayments([payment({ status: 'pending', updatedAt: T1, firstSeenAt: T1 })]);
    expect((await store.listPayments('account', 1))[0]).toMatchObject({
      status: 'completed',
      updatedAt: T2,
    });
  });
});

describe('InMemoryWalletStore pairing by payment id', () => {
  const T0 = new Date('2026-09-30T00:00:00.000Z');
  const T3 = new Date('2026-10-03T00:00:00.000Z');

  /** An outgoing transfer the sender's wallet reported without any detail. */
  function bare(extra: Partial<WalletPaymentRecord> = {}): WalletPaymentRecord {
    return payment({
      accountId: 'sender',
      paymentId: 'transfer',
      direction: 'out',
      method: 'spark',
      paymentHash: null,
      invoice: null,
      destination: null,
      description: null,
      lnurlComment: null,
      category: 'unknown',
      counterpartyAccountId: null,
      ...extra,
    });
  }

  /** The receiver's categorized side of the same transfer. */
  function received(extra: Partial<WalletPaymentRecord> = {}): WalletPaymentRecord {
    return payment({
      accountId: 'receiver',
      paymentId: 'transfer',
      direction: 'in',
      method: 'spark',
      description: 'zap:' + 'b'.repeat(64),
      category: 'gift',
      counterpartyAccountId: 'sender',
      ...extra,
    });
  }

  async function only(store: InMemoryWalletStore, accountId: string): Promise<WalletPaymentRecord> {
    const [row] = await store.listPayments(accountId, 10);
    if (row === undefined) {
      throw new Error(`no payment for ${accountId}`);
    }
    return row;
  }

  it('fills an out-row without details from the categorized in-row that is already stored', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([received({ updatedAt: T1, firstSeenAt: T1 })]);
    await store.upsertPayments([bare({ updatedAt: T2, firstSeenAt: T2 })]);
    expect(await only(store, 'sender')).toMatchObject({
      category: 'gift',
      counterpartyAccountId: 'receiver',
      updatedAt: T2,
      description: null,
    });
    expect(await only(store, 'receiver')).toMatchObject({
      category: 'gift',
      counterpartyAccountId: 'sender',
      updatedAt: T1,
    });
  });

  it('fills an earlier uncategorized out-row when the in-row arrives later', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([bare({ updatedAt: T1, firstSeenAt: T1 })]);
    expect(await only(store, 'sender')).toMatchObject({ category: 'unknown' });
    await store.upsertPayments([received({ updatedAt: T2, firstSeenAt: T2 })]);
    expect(await only(store, 'sender')).toMatchObject({
      category: 'gift',
      counterpartyAccountId: 'receiver',
      updatedAt: T2,
      firstSeenAt: T1,
    });
    // A later bare re-send keeps the paired category, as for any resolved one.
    await store.upsertPayments([bare({ updatedAt: T3, firstSeenAt: T3 })]);
    expect(await only(store, 'sender')).toMatchObject({
      category: 'gift',
      counterpartyAccountId: 'receiver',
      updatedAt: T2,
    });
  });

  it('pairs the reverse direction: an in-row without details from a categorized out-row', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      bare({ accountId: 'receiver', direction: 'in', updatedAt: T2, firstSeenAt: T2 }),
    ]);
    // The paired row never moves updatedAt backwards.
    await store.upsertPayments([
      received({
        accountId: 'sender',
        direction: 'out',
        category: 'member',
        counterpartyAccountId: 'receiver',
        updatedAt: T1,
        firstSeenAt: T1,
      }),
    ]);
    expect(await only(store, 'receiver')).toMatchObject({
      category: 'member',
      counterpartyAccountId: 'sender',
      updatedAt: T2,
    });
  });

  it('names the paired account like the classifier: platform, gift, point-of-sale shop, then its kind', async () => {
    const kinds: Record<string, WalletAccountKind> = {
      platform: 'platform',
      shop: 'shop',
      member: 'member',
    };
    const cases: Array<{
      source: Partial<WalletPaymentRecord>;
      expected: string;
    }> = [
      { source: { accountId: 'platform', category: 'gift' }, expected: 'platform' },
      { source: { accountId: 'shop', category: 'gift' }, expected: 'gift' },
      {
        source: { accountId: 'member', category: 'shop', counterpartyAccountId: null },
        expected: 'shop',
      },
      { source: { accountId: 'member', category: 'shop' }, expected: 'member' },
      { source: { accountId: 'shop', category: 'platform' }, expected: 'shop' },
      {
        source: { accountId: 'member', category: 'outside_lightning', counterpartyAccountId: null },
        expected: 'member',
      },
    ];
    for (const { source, expected } of cases) {
      const store = new InMemoryWalletStore((id) => Promise.resolve(kinds[id] ?? 'member'));
      await store.upsertPayments([bare()]);
      await store.upsertPayments([received(source)]);
      expect(await only(store, 'sender')).toMatchObject({
        category: expected,
        counterpartyAccountId: source.accountId,
      });
    }
  });

  it('never overwrites a category or counterparty the row resolved itself', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([
      bare({ category: 'outside_lightning' }),
      received({ updatedAt: T2 }),
    ]);
    expect(await only(store, 'sender')).toMatchObject({
      category: 'outside_lightning',
      counterpartyAccountId: null,
    });
    const member = new InMemoryWalletStore();
    await member.upsertPayments([
      bare({ category: 'member', counterpartyAccountId: 'someone' }),
      received({ updatedAt: T2 }),
    ]);
    expect(await only(member, 'sender')).toMatchObject({
      category: 'member',
      counterpartyAccountId: 'someone',
    });
  });

  it('ignores ambiguous payment ids, same-direction pairs, and two unknown sides', async () => {
    const ambiguous = new InMemoryWalletStore();
    await ambiguous.upsertPayments([
      bare(),
      received(),
      received({ accountId: 'third', updatedAt: T2 }),
    ]);
    expect(await only(ambiguous, 'sender')).toMatchObject({ category: 'gift' });
    await ambiguous.upsertPayments([bare({ accountId: 'fourth', updatedAt: T2 })]);
    expect(await only(ambiguous, 'fourth')).toMatchObject({
      category: 'unknown',
      counterpartyAccountId: null,
    });

    const sameDirection = new InMemoryWalletStore();
    await sameDirection.upsertPayments([bare(), received({ direction: 'out' })]);
    expect(await only(sameDirection, 'sender')).toMatchObject({ category: 'unknown' });

    const bothUnknown = new InMemoryWalletStore();
    await bothUnknown.upsertPayments([
      bare(),
      bare({ accountId: 'receiver', direction: 'in', updatedAt: T0 }),
    ]);
    expect(await only(bothUnknown, 'sender')).toMatchObject({ category: 'unknown' });
    expect(await only(bothUnknown, 'receiver')).toMatchObject({ category: 'unknown' });
  });

  it('keeps a row its own report resolved while the account kind was looked up', async () => {
    let release: (kind: WalletAccountKind) => void = () => undefined;
    const store = new InMemoryWalletStore(
      () =>
        new Promise<WalletAccountKind>((resolve) => {
          release = resolve;
        }),
    );
    await store.upsertPayments([received()]);
    const pairing = store.upsertPayments([bare({ updatedAt: T2 })]);
    await Promise.resolve();
    await store.upsertPayments([
      bare({ category: 'member', counterpartyAccountId: 'someone', updatedAt: T3 }),
    ]);
    release('member');
    await pairing;
    expect(await only(store, 'sender')).toMatchObject({
      category: 'member',
      counterpartyAccountId: 'someone',
    });
  });
});

describe('repairWalletPaymentPairs', () => {
  it('runs the pairing over the whole table once and counts the changed rows', async () => {
    const sql = new MockSql();
    sql.rows = [{ account_id: 'a' }, { account_id: 'b' }];
    expect(await repairWalletPaymentPairs(sql, T2)).toBe(2);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.params).toEqual([T2]);
    const text = sql.queries[0]?.text ?? '';
    expect(text).toContain('UPDATE wallet_payment AS t');
    expect(text).not.toContain('$2');
    expect(text).toContain("t.category = 'unknown'");
    expect(text).toContain('t.counterparty_account_id IS NULL');
    expect(text).toContain("s.category <> 'unknown'");
    expect(text).toContain('s.direction <> t.direction');
    expect(text).toContain('s.account_id <> t.account_id');
    expect(text).toContain('WHERE c.payment_id = t.payment_id) = 2');
    expect(text).toContain('last_observed_at = COALESCE(t.last_observed_at, t.updated_at)');
    expect(text).toContain("m.text ~* '#21GiftsShop(?![A-Za-z0-9_])'");
    sql.rows = [];
    expect(await repairWalletPaymentPairs(sql, T2)).toBe(0);
  });
});

describe('PostgresWalletStore', () => {
  it('writes more payments than one concurrency batch, one statement each', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletStore(sql);
    await store.upsertPayments(
      Array.from({ length: 20 }, (_, index) => payment({ paymentId: `p${index}` })),
    );
    // One upsert plus one pairing statement per payment.
    expect(sql.executes).toHaveLength(40);
    expect(
      sql.executes
        .filter((entry) => entry.text.startsWith('INSERT INTO wallet_payment'))
        .map((entry) => entry.params[1]),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `p${index}`));
  });

  it('inserts balance and payment rows in order with guarded coalescing upserts', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletStore(sql);
    await store.recordBalance(balance());
    await store.upsertPayments([payment({ paymentId: 'a' }), payment({ paymentId: 'b' })]);
    expect(sql.executes[0]).toEqual({
      text: expect.stringContaining('INSERT INTO wallet_balance_snapshot'),
      params: ['a', 'account', 21, T1, T1],
    });
    expect(sql.executes).toHaveLength(5);
    // The two payments run concurrently: both upserts, then the pairing of each payment id.
    const pairing = sql.executes.filter((entry) =>
      entry.text.startsWith('UPDATE wallet_payment AS t'),
    );
    expect(pairing.map((entry) => entry.params)).toEqual([
      [T1, 'a'],
      [T1, 'b'],
    ]);
    expect(pairing[0]?.text).toContain('WHERE t.payment_id = $2 AND s.payment_id = t.payment_id');
    expect(sql.executes[1]?.text).toContain('ON CONFLICT (account_id, payment_id) DO UPDATE');
    expect(sql.executes[1]?.text).toContain('COALESCE(EXCLUDED.invoice, wallet_payment.invoice)');
    expect(sql.executes[1]?.text).toContain('IS DISTINCT FROM');
    expect(sql.executes[1]?.text).toContain(
      'WHERE EXCLUDED.last_observed_at >= COALESCE(wallet_payment.last_observed_at, wallet_payment.updated_at)',
    );
    expect(sql.executes[1]?.text).toContain('last_observed_at = EXCLUDED.last_observed_at');
    expect(sql.executes[1]?.text).toContain('$17,$17)');
    expect(sql.executes[1]?.text).toContain(
      "category = CASE WHEN (EXCLUDED.category IN ('outside_lightning', 'onchain', 'unknown') AND wallet_payment.category NOT IN ('outside_lightning', 'onchain', 'unknown')) THEN wallet_payment.category ELSE EXCLUDED.category END",
    );
    expect(sql.executes[1]?.params).toEqual([
      'account',
      'a',
      'out',
      'pending',
      21,
      1,
      T1,
      'bolt11',
      'a'.repeat(64),
      'lnbc',
      'alice@example.test',
      'one',
      'two',
      'member',
      'other',
      T1,
      T1,
    ]);
  });

  it('maps latest balance Date/string timestamps and bigint values, including empty results', async () => {
    const sql = new MockSql();
    sql.rows = [
      {
        id: 'a',
        account_id: 'account',
        balance_sats: 21n,
        synced_at: T1,
        received_at: T2.toISOString(),
      },
    ];
    const store = new PostgresWalletStore(sql);
    await expect(store.latestBalance('account')).resolves.toEqual(balance({ receivedAt: T2 }));
    expect(sql.queries[0]?.text).toContain('ORDER BY received_at DESC, id DESC');
    expect(sql.queries[0]?.params).toEqual(['account']);
    sql.rows = [];
    await expect(store.latestBalance('none')).resolves.toBeUndefined();
  });

  it('maps the one-per-account-and-day snapshot query', async () => {
    const sql = new MockSql();
    sql.rows = [
      {
        id: 'a',
        account_id: 'account',
        balance_sats: 21n,
        synced_at: T1,
        received_at: T2.toISOString(),
      },
    ];
    const rows = await new PostgresWalletStore(sql).dailyBalances();
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.text).toContain(
      "SELECT DISTINCT ON (account_id, ((received_at AT TIME ZONE 'UTC')::date))",
    );
    expect(sql.queries[0]?.text).toContain('received_at DESC, id DESC');
    expect(sql.queries[0]?.params).toEqual([]);
    expect(rows).toEqual([balance({ receivedAt: T2 })]);
  });

  it('aggregates completed payments in one direction-grouped query', async () => {
    const sql = new MockSql();
    sql.rows = [
      { direction: 'in', amount_sats: '1250', fee_sats: 0n },
      { direction: 'out', amount_sats: 41n, fee_sats: '5' },
    ];
    const store = new PostgresWalletStore(sql);
    await expect(store.paymentTotals('account')).resolves.toEqual({
      receivedSats: 1_250n,
      paidOutSats: 41n,
      feesSats: 5n,
    });
    expect(sql.queries[0]?.text).toContain("WHERE account_id = $1 AND status = 'completed'");
    expect(sql.queries[0]?.text).toContain('GROUP BY direction');
    expect(sql.queries[0]?.text).toContain('SUM(amount_sats)');
    expect(sql.queries[0]?.text).toContain('SUM(fee_sats)');
    expect(sql.queries[0]?.params).toEqual(['account']);
  });

  it('returns zero totals for no grouped rows and ignores an unknown direction', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletStore(sql);
    await expect(store.paymentTotals('none')).resolves.toEqual({
      receivedSats: 0n,
      paidOutSats: 0n,
      feesSats: 0n,
    });
    sql.rows = [{ direction: 'sideways', amount_sats: 9, fee_sats: 9 }];
    await expect(store.paymentTotals('account')).resolves.toEqual({
      receivedSats: 0n,
      paidOutSats: 0n,
      feesSats: 0n,
    });
  });

  it('treats null aggregate values as zero', async () => {
    const sql = new MockSql();
    sql.rows = [
      { direction: 'in', amount_sats: null, fee_sats: null },
      { direction: 'out', amount_sats: null, fee_sats: null },
    ];
    await expect(new PostgresWalletStore(sql).paymentTotals('account')).resolves.toEqual({
      receivedSats: 0n,
      paidOutSats: 0n,
      feesSats: 0n,
    });
  });

  it('maps and orders payment rows with number/string/bigint fields and timestamp variants', async () => {
    const sql = new MockSql();
    sql.rows = [
      {
        account_id: 'account',
        payment_id: 'p',
        direction: 'in',
        status: 'failed',
        amount_sats: '42',
        fee_sats: 2n,
        paid_at: T2.toISOString(),
        method: 'spark',
        payment_hash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurl_comment: null,
        category: 'unknown',
        counterparty_account_id: null,
        first_seen_at: T1.toISOString(),
        updated_at: T2,
      },
    ];
    const rows = await new PostgresWalletStore(sql).listPayments('account', 20);
    expect(sql.queries[0]?.text).toContain('ORDER BY paid_at DESC, payment_id COLLATE "C" DESC');
    expect(sql.queries[0]?.params).toEqual(['account', 20]);
    expect(rows).toEqual([
      payment({
        direction: 'in',
        status: 'failed',
        amountSats: 42,
        feeSats: 2,
        paidAt: T2,
        method: 'spark',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: null,
        category: 'unknown',
        counterpartyAccountId: null,
        firstSeenAt: T1,
        updatedAt: T2,
      }),
    ]);
  });

  it('adds the keyset predicate only when after is set and binds both cursor values', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletStore(sql);
    await store.listPayments('account', 20, { paidAt: T2, paymentId: 'p' });
    expect(sql.queries[0]?.text).toContain(
      'WHERE account_id = $1 AND (paid_at < $3 OR (paid_at = $3 AND payment_id COLLATE "C" < $4))',
    );
    expect(sql.queries[0]?.text).toContain('ORDER BY paid_at DESC, payment_id COLLATE "C" DESC');
    expect(sql.queries[0]?.params).toEqual(['account', 20, T2, 'p']);
    await store.listPayments('account', 20);
    expect(sql.queries[1]?.text).not.toContain('paid_at <');
    expect(sql.queries[1]?.params).toEqual(['account', 20]);
  });

  it('adds status and keyset predicates with bound Postgres parameters', async () => {
    const sql = new MockSql();
    const paidAt = new Date('2026-10-02T00:00:00.000Z');
    const store = new PostgresWalletStore(sql);
    await store.listPayments(
      'account',
      51,
      { paidAt, paymentId: 'p' },
      { status: 'completed' },
    );
    expect(sql.queries[0]?.text).toContain(
      'AND (paid_at < $3 OR (paid_at = $3 AND payment_id COLLATE "C" < $4))',
    );
    expect(sql.queries[0]?.text).toContain('status = $5');
    expect(sql.queries[0]?.params).toEqual(['account', 51, paidAt, 'p', 'completed']);
    await store.listPayments('account', 51, undefined, { status: 'completed' });
    expect(sql.queries[1]?.text).not.toContain('paid_at <');
    expect(sql.queries[1]?.text).toContain('status = $3');
    expect(sql.queries[1]?.params).toEqual(['account', 51, 'completed']);
  });

  it('numbers exact paid time and combined filters with and without a keyset', async () => {
    const sql = new MockSql();
    const paidAt = new Date('2026-10-02T00:00:00.000Z');
    const store = new PostgresWalletStore(sql);
    await store.listPayments('account', 51, undefined, { paidAt });
    expect(sql.queries[0]?.text).toContain(`paid_at = $3`);
    expect(sql.queries[0]?.params).toEqual(['account', 51, paidAt]);

    await store.listPayments('account', 51, { paidAt, paymentId: 'p' }, { paidAt });
    expect(sql.queries[1]?.text).toContain('payment_id COLLATE "C" < $4');
    expect(sql.queries[1]?.text).toContain(`paid_at = $5`);
    expect(sql.queries[1]?.params).toEqual(['account', 51, paidAt, 'p', paidAt]);

    await store.listPayments('account', 51, undefined, {
      status: 'completed',
      paidAt,
    });
    expect(sql.queries[2]?.text).toContain(`status = $3`);
    expect(sql.queries[2]?.text).toContain(`paid_at = $4`);
    expect(sql.queries[2]?.params).toEqual(['account', 51, 'completed', paidAt]);

    await store.listPayments(
      'account',
      51,
      { paidAt, paymentId: 'p' },
      {
        status: 'completed',
        paidAt,
      },
    );
    expect(sql.queries[3]?.text).toContain('payment_id COLLATE "C" < $4');
    expect(sql.queries[3]?.text).toContain(`status = $5`);
    expect(sql.queries[3]?.text).toContain(`paid_at = $6`);
    expect(sql.queries[3]?.params).toEqual(['account', 51, paidAt, 'p', 'completed', paidAt]);
  });

  it('never binds secret-shaped optional values after the real report parser filters them', async () => {
    const phrase = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega';
    const nsec = `nsec1${'q'.repeat(58)}`;
    const parsed = parseWalletReport(
      {
        balanceSats: 1,
        syncedAt: T1.toISOString(),
        payments: [
          {
            id: 'safe',
            direction: 'out',
            status: 'completed',
            amountSats: 1,
            timestamp: T1.toISOString(),
            method: 'spark',
            description: phrase,
            lnurlComment: nsec,
            preimage: 'preimage-secret',
            seed: 'seed-secret',
            mnemonic: 'mnemonic-secret',
            prf: 'prf-secret',
            privateKey: 'private-secret',
            nsec: 'field-secret',
          },
        ],
      },
      T2.getTime(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sql = new MockSql();
    await new PostgresWalletStore(sql).upsertPayments(
      parsed.report.payments.map((row) => ({
        ...row,
        accountId: 'account',
        category: 'unknown',
        counterpartyAccountId: null,
        firstSeenAt: T2,
        updatedAt: T2,
      })),
    );
    const serialised = JSON.stringify(sql.executes.flatMap((entry) => entry.params));
    for (const secret of [
      phrase,
      nsec,
      'preimage-secret',
      'seed-secret',
      'mnemonic-secret',
      'prf-secret',
      'private-secret',
      'field-secret',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
