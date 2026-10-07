import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { parseWalletReport } from '@/lib/wallet-report';
import {
  InMemoryWalletStore,
  migrateWalletSchema,
  PostgresWalletStore,
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
    expect(WALLET_SCHEMA_SQL).toHaveLength(5);
    expect(WALLET_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS wallet_balance_snapshot/);
    expect(WALLET_SCHEMA_SQL[1]).toMatch(/received_at DESC, id DESC/);
    expect(WALLET_SCHEMA_SQL[2]).toMatch(/PRIMARY KEY \(account_id, payment_id\)/);
    expect(WALLET_SCHEMA_SQL[2]).toContain("'outside_lightning'");
    expect(WALLET_SCHEMA_SQL[3]).toBe(
      'ALTER TABLE wallet_payment ADD COLUMN IF NOT EXISTS invoice text',
    );
    expect(WALLET_SCHEMA_SQL[4]).toMatch(/paid_at DESC, payment_id DESC/);
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

describe('PostgresWalletStore', () => {
  it('inserts balance and payment rows in order with guarded coalescing upserts', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletStore(sql);
    await store.recordBalance(balance());
    await store.upsertPayments([payment({ paymentId: 'a' }), payment({ paymentId: 'b' })]);
    expect(sql.executes[0]).toEqual({
      text: expect.stringContaining('INSERT INTO wallet_balance_snapshot'),
      params: ['a', 'account', 21, T1, T1],
    });
    expect(sql.executes).toHaveLength(3);
    expect(sql.executes[1]?.text).toContain('ON CONFLICT (account_id, payment_id) DO UPDATE');
    expect(sql.executes[1]?.text).toContain('COALESCE(EXCLUDED.invoice, wallet_payment.invoice)');
    expect(sql.executes[1]?.text).toContain('IS DISTINCT FROM');
    expect(sql.executes[1]?.text).toContain('AND EXCLUDED.updated_at >= wallet_payment.updated_at');
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
