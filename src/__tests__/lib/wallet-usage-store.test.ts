import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type {
  WalletUsageChargeRow,
  WalletUsageForumRow,
  WalletUsagePaymentRow,
} from '@/lib/wallet-usage';
import { InMemoryWalletUsageStore, PostgresWalletUsageStore } from '@/lib/wallet-usage-store';

const AT = new Date('2026-11-11T12:00:00.000Z');
const BEFORE = new Date(AT.getTime() - 1);
const AFTER = new Date(AT.getTime() + 1);

function paymentFields(paidAt: Date, amountSats = 1): Omit<WalletUsagePaymentRow, 'isForumGift'> {
  return {
    paidAt,
    amountSats,
    feeSats: 0,
    category: 'member',
    payerAccountId: 'payer',
    payeeAccountId: 'payee',
    payerParty: 'members',
    payeeParty: 'members',
    isFundPayout: false,
  };
}

function payment(paidAt: Date, amountSats = 1): WalletUsagePaymentRow {
  return { ...paymentFields(paidAt, amountSats), isForumGift: false };
}

class MockSql implements SqlClient {
  queries: Array<{ text: string; params: readonly unknown[] }> = [];
  rows: unknown[] = [];
  error: Error | undefined;

  query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.rows as T[]);
  }

  execute(): Promise<void> {
    return Promise.resolve();
  }
}

describe('InMemoryWalletUsageStore', () => {
  it('returns empty lists when it is constructed without a seed', async () => {
    const store = new InMemoryWalletUsageStore();
    await expect(store.payments(0)).resolves.toEqual([]);
    await expect(store.forumInvoices(0)).resolves.toEqual([]);
    await expect(store.shopCharges(0)).resolves.toEqual([]);
  });

  it('keeps rows on or after the bound and returns copies', async () => {
    const payments = [payment(BEFORE, 1), payment(AT, 2), payment(AFTER, 3)];
    const forum: WalletUsageForumRow[] = [
      { createdAt: BEFORE, amountSats: 1, heart: false },
      { createdAt: AT, amountSats: 2, heart: true },
    ];
    const charges: WalletUsageChargeRow[] = [
      { createdAt: BEFORE, status: 'pending' },
      { createdAt: AT, status: 'paid' },
    ];
    const store = new InMemoryWalletUsageStore({
      payments,
      forumInvoices: forum,
      shopCharges: charges,
    });
    payments.push(payment(AFTER, 9));
    const first = await store.payments(AT.getTime());
    expect(first.map((row) => row.amountSats)).toEqual([2, 3]);
    const firstPaid = first[0];
    if (firstPaid === undefined) {
      throw new Error('expected the boundary payment');
    }
    firstPaid.paidAt.setTime(0);
    firstPaid.amountSats = 0;
    const again = await store.payments(AT.getTime());
    expect(again.map((row) => [row.amountSats, row.paidAt.toISOString()])).toEqual([
      [2, AT.toISOString()],
      [3, AFTER.toISOString()],
    ]);
    const forumRows = await store.forumInvoices(AT.getTime());
    expect(forumRows).toEqual([{ createdAt: AT, amountSats: 2, heart: true }]);
    const forumRow = forumRows[0];
    if (forumRow === undefined) {
      throw new Error('expected the boundary forum row');
    }
    forumRow.createdAt.setTime(0);
    expect((await store.forumInvoices(AT.getTime()))[0]?.createdAt.toISOString()).toBe(
      AT.toISOString(),
    );
    const chargesOut = await store.shopCharges(AT.getTime());
    expect(chargesOut).toEqual([{ createdAt: AT, status: 'paid' }]);
    const charge = chargesOut[0];
    if (charge === undefined) {
      throw new Error('expected the boundary charge');
    }
    charge.createdAt.setTime(0);
    expect((await store.shopCharges(AT.getTime()))[0]?.createdAt.toISOString()).toBe(
      AT.toISOString(),
    );
  });
});

describe('PostgresWalletUsageStore', () => {
  it('does not query when it is constructed', () => {
    const sql = new MockSql();
    new PostgresWalletUsageStore(sql);
    expect(sql.queries).toEqual([]);
  });

  it('reads each series with one parameterized statement', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletUsageStore(sql);
    sql.rows = [];
    await expect(store.payments(AT.getTime())).resolves.toEqual([]);
    await expect(store.forumInvoices(AT.getTime())).resolves.toEqual([]);
    await expect(store.shopCharges(AT.getTime())).resolves.toEqual([]);
    expect(sql.queries).toHaveLength(3);
    const payments = sql.queries[0];
    const forum = sql.queries[1];
    const charges = sql.queries[2];
    if (payments === undefined || forum === undefined || charges === undefined) {
      throw new Error('expected three queries');
    }
    expect(payments.params).toEqual([AT]);
    expect(forum.params).toEqual([AT]);
    expect(charges.params).toEqual([AT]);
    expect(payments.text).toContain("status = 'completed'");
    expect(payments.text).toContain('min(paid_at)');
    expect(payments.text).toContain('max(amount_sats)');
    expect(payments.text).toContain('sum(coalesce(fee_sats, 0))');
    expect(payments.text).toContain("direction = 'out'");
    expect(payments.text).toContain("direction = 'in'");
    expect(payments.text).toContain('counterparty_account_id');
    expect(payments.text).toContain("category <> 'unknown'");
    expect(payments.text).toContain('fond_payout');
    expect(payments.text).toContain("fond_payout.status = 'paid'");
    expect(payments.text).toContain('fond_payout.bolt11');
    expect(payments.text).toContain('fond_payout.spark_invoice');
    expect(payments.text).toContain('payer.is_platform');
    expect(payments.text).toContain("payer.role = 'fond'");
    expect(payments.text).toContain('payee.is_platform');
    expect(payments.text).toContain("payee.role = 'fond'");
    expect(payments.text).toContain('HAVING min(paid_at) >= $1');
    expect(payments.text).toContain('AS group_key');
    expect(payments.text).toContain('FROM wallet_payment');
    expect(payments.text).toContain('id_totals.row_count = 2');
    expect(payments.text).toContain('id_totals.completed_count = 2');
    expect(payments.text).toContain('id_totals.completed_account_count = 2');
    expect(payments.text).toContain('id_totals.completed_direction_count = 2');
    expect(payments.text).toContain("THEN 'pair:' || wallet_payment.payment_id");
    expect(payments.text).toContain(
      "'row:' || wallet_payment.account_id::text || ':' || wallet_payment.payment_id",
    );
    expect(payments.text).toContain('GROUP BY group_key');
    expect(payments.text).toContain('ORDER BY group_key, account_id');
    expect(payments.text).toContain('LEFT JOIN outs ON outs.group_key = bounds.group_key');
    expect(payments.text).toContain('LEFT JOIN ins ON ins.group_key = bounds.group_key');
    expect(payments.text).toContain(
      'LEFT JOIN fallback_category ON fallback_category.group_key = bounds.group_key',
    );
    expect(payments.text).toContain(
      'LEFT JOIN fund_hits ON fund_hits.group_key = bounds.group_key',
    );
    expect(payments.text).toContain(
      'LEFT JOIN forum_gifts ON forum_gifts.group_key = bounds.group_key',
    );
    expect(payments.text).toContain('payment_hash');
    expect(payments.text).toContain('destination');
    expect(payments.text).toContain('spark_invoice');
    expect(payments.text).toContain('candidate_hashes');
    expect(payments.text).toContain('lower(spark_invoice.payment_hash)');
    expect(payments.text).toContain('spark_invoice.invoice = completed.invoice');
    expect(payments.text).toContain('spark_invoice.invoice = completed.destination');
    expect(payments.text).toContain('lower(invoice.payment_hash) = candidate_hashes.payment_hash');
    expect(payments.text).toContain('z.payment_hash = candidate_hashes.payment_hash');
    expect(payments.text).toContain(
      'lower(other_invoice.payment_hash) = candidate_hashes.payment_hash',
    );
    expect(payments.text).toContain('AS is_forum_gift');
    expect(payments.text).not.toContain('invoice.heart IS FALSE');
    expect(payments.text.match(/LEFT JOIN candidate_hashes/g)).toHaveLength(2);
    expect(payments.text).toContain('invoice.pr = completed.invoice');
    expect(payments.text).toContain('nostr_zap_receipt');
    expect(payments.text).toContain('receipt.event_id = z.receipt_event_id');
    expect(payments.text).toContain('note.deleted_at IS NULL');
    expect(payments.text).not.toContain('other_invoice.heart');
    expect(payments.text).toContain('other_invoice.conversation_id IS NOT NULL');
    expect(forum.text).toContain('FROM message_invoice invoice');
    expect(forum.text).toContain("invoice.result = 'ok'");
    expect(forum.text).toContain('invoice.conversation_id IS NULL');
    expect(forum.text).toContain("coalesce(invoice.description, '') NOT LIKE 'repay:%'");
    expect(forum.text).toContain("coalesce(invoice.description, '') NOT LIKE 'repayp:%'");
    expect(forum.text).toContain('COALESCE(invoice.heart, false)');
    expect(forum.text).toContain('invoice.created_at >= $1');
    expect(forum.text).toContain('nostr_zap_payment');
    expect(forum.text).toContain('z.payment_hash = lower(invoice.payment_hash)');
    expect(forum.text).not.toContain('lower(z.payment_hash)');
    expect(forum.text).not.toContain('$2');
    expect(forum.text).toContain('JOIN message note ON note.id = invoice.message_id');
    expect(forum.text).toContain('note.deleted_at IS NULL');
    expect(charges.text).toContain('pos_charge');
    expect(charges.text).toContain('created_at');
    expect(charges.text).toContain('status');
    expect(charges.text).toContain('created_at >= $1');
  });

  it('maps merged rows and treats a null heart as false', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletUsageStore(sql);
    sql.rows = [
      {
        paid_at: AT,
        amount_sats: 10n,
        fee_sats: '2',
        category: 'gift',
        payer_account_id: null,
        payee_account_id: 'payee',
        payer_party: 'outside',
        payee_party: 'members',
        is_fund_payout: false,
        is_forum_gift: true,
      },
      {
        paid_at: '2026-11-12T00:00:00.000Z',
        amount_sats: 3,
        fee_sats: 0,
        category: 'shop',
        payer_account_id: 'payer',
        payee_account_id: null,
        payer_party: 'fund',
        payee_party: 'platform',
        is_fund_payout: true,
        is_forum_gift: false,
      },
    ];
    const rows = await store.payments(0);
    expect(rows[0]).toEqual({
      paidAt: AT,
      amountSats: 10,
      feeSats: 2,
      category: 'gift',
      payerAccountId: null,
      payeeAccountId: 'payee',
      payerParty: 'outside',
      payeeParty: 'members',
      isFundPayout: false,
      isForumGift: true,
    });
    expect(rows[1]?.payerParty).toBe('fund');
    expect(rows[1]?.payeeParty).toBe('platform');
    expect(rows[1]?.isForumGift).toBe(false);
    expect(rows[1]?.paidAt.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    const returned = rows[0];
    if (returned === undefined) {
      throw new Error('expected a mapped payment');
    }
    returned.paidAt.setTime(0);
    sql.rows = [
      { created_at: AT, amount_sats: 5, heart: true },
      { created_at: '2026-11-10T00:00:00.000Z', amount_sats: '6', heart: null },
      { created_at: AT, amount_sats: 7n, heart: false },
    ];
    await expect(store.forumInvoices(0)).resolves.toEqual([
      { createdAt: AT, amountSats: 5, heart: true },
      { createdAt: new Date('2026-11-10T00:00:00.000Z'), amountSats: 6, heart: false },
      { createdAt: AT, amountSats: 7, heart: false },
    ]);
    sql.rows = [{ created_at: '2026-11-12T01:00:00.000Z', status: 'paid' }];
    await expect(store.shopCharges(0)).resolves.toEqual([
      { createdAt: new Date('2026-11-12T01:00:00.000Z'), status: 'paid' },
    ]);
  });

  it('derives isForumGift in memory from claimed invoices, gifts, and paid hearts', async () => {
    const basePayment = paymentFields(AT, 1);
    const seed = (paymentHash: string | null, invoice: string | null, isForumGift?: boolean) => {
      return {
        ...basePayment,
        paymentHash,
        invoice,
        ...(isForumGift === undefined ? {} : { isForumGift }),
      };
    };
    const store = new InMemoryWalletUsageStore({
      payments: [
        seed('AA11', null),
        seed(null, 'bolt-forum'),
        seed('bb22', null),
        seed('cc33', null),
        seed('dd44', null),
        seed('ee55', null),
        seed('ff66', null),
        seed('gg77', null),
        seed('hh88', null),
        seed('ii99', null),
        seed('jj00', null),
      ],
      forumInvoices: [],
      shopCharges: [],
      forumGiftInvoices: [
        {
          paymentHash: 'aa11',
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: null,
          pr: 'bolt-forum',
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: 'bb22',
          pr: null,
          conversation: true,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: 'cc33',
          pr: null,
          conversation: false,
          repayment: true,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: 'dd44',
          pr: null,
          conversation: false,
          repayment: false,
          hidden: true,
          claimed: true,
        },
        {
          paymentHash: 'ee55',
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: false,
        },
        {
          paymentHash: 'ff66',
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
      ],
      zapGifts: [
        { paymentHash: 'GG77', hidden: false },
        { paymentHash: 'hh88', hidden: true },
        { paymentHash: 'ii99', hidden: false },
      ],
    });
    const rows = await store.payments(AT.getTime());
    expect(rows.map((row) => row.isForumGift)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
    expect(rows.some((row) => 'paymentHash' in row)).toBe(false);
    expect(rows.some((row) => 'invoice' in row)).toBe(false);
    const explicit = new InMemoryWalletUsageStore({
      payments: [seed(null, null, true), seed(null, null, false)],
      forumInvoices: [],
      shopCharges: [],
      forumGiftInvoices: [
        {
          paymentHash: null,
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
      ],
    });
    expect((await explicit.payments(0)).map((row) => row.isForumGift)).toEqual([true, false]);
  });

  it('rejects a zap gift when a conversation or repayment invoice owns its hash', async () => {
    const basePayment = paymentFields(AT, 1);
    const seed = (paymentHash: string) => ({ ...basePayment, paymentHash, invoice: null });
    const memoryInvoice = (
      paymentHash: string,
      kind: 'conversation' | 'repayment',
      claimed: boolean,
    ) => ({
      paymentHash,
      pr: null,
      conversation: kind === 'conversation',
      repayment: kind === 'repayment',
      hidden: false,
      claimed,
    });
    const store = new InMemoryWalletUsageStore({
      payments: [seed('AA11'), seed('BB22'), seed('CC33'), seed('dd44')],
      forumInvoices: [],
      shopCharges: [],
      forumGiftInvoices: [
        memoryInvoice('aa11', 'conversation', false),
        memoryInvoice('bb22', 'repayment', true),
        memoryInvoice('zz99', 'conversation', true),
      ],
      zapGifts: [
        { paymentHash: 'aa11', hidden: false },
        { paymentHash: 'bb22', hidden: false },
        { paymentHash: 'cc33', hidden: false },
      ],
    });
    expect((await store.payments(0)).map((row) => row.isForumGift)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('correlates zap gift exclusions to the hashes that own them', async () => {
    const basePayment = paymentFields(AT, 1);
    const rawConversationHash = 'aa11'.repeat(16);
    const validZapGiftHash = 'bb22'.repeat(16);
    const ownedZapGiftHash = 'cc33'.repeat(16);
    const store = new InMemoryWalletUsageStore({
      payments: [
        {
          ...basePayment,
          paymentHash: rawConversationHash.toUpperCase(),
          invoice: 'spark-gift',
          destination: null,
        },
        { ...basePayment, paymentHash: ownedZapGiftHash, invoice: null, destination: null },
      ],
      forumInvoices: [],
      shopCharges: [],
      forumGiftInvoices: [
        {
          paymentHash: rawConversationHash,
          pr: null,
          conversation: true,
          repayment: false,
          hidden: false,
          claimed: false,
        },
        {
          paymentHash: ownedZapGiftHash,
          pr: null,
          conversation: true,
          repayment: false,
          hidden: false,
          claimed: true,
        },
      ],
      zapGifts: [
        { paymentHash: validZapGiftHash.toUpperCase(), hidden: false },
        { paymentHash: ownedZapGiftHash, hidden: false },
      ],
      sparkInvoiceHashes: new Map([['spark-gift', validZapGiftHash]]),
    });
    expect((await store.payments(0)).map((row) => row.isForumGift)).toEqual([true, false]);
  });

  it('matches a forum gift paid by Spark invoice through invoice or destination', async () => {
    const basePayment = paymentFields(AT, 1);
    const invoiceHash = 'aa11'.repeat(16);
    const destinationHash = 'bb22'.repeat(16);
    const conversationHash = 'cc33'.repeat(16);
    const unrelatedHash = 'dd44'.repeat(16);
    const store = new InMemoryWalletUsageStore({
      payments: [
        { ...basePayment, paymentHash: null, invoice: 'spark-invoice', destination: null },
        { ...basePayment, paymentHash: null, invoice: null, destination: 'spark-destination' },
        { ...basePayment, paymentHash: null, invoice: 'spark-conversation', destination: null },
        {
          ...basePayment,
          paymentHash: 'unrelated-raw',
          invoice: 'spark-unrelated',
          destination: null,
        },
      ],
      forumInvoices: [],
      shopCharges: [],
      forumGiftInvoices: [
        {
          paymentHash: invoiceHash.toUpperCase(),
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: destinationHash,
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: conversationHash,
          pr: null,
          conversation: true,
          repayment: false,
          hidden: false,
          claimed: true,
        },
        {
          paymentHash: unrelatedHash,
          pr: null,
          conversation: false,
          repayment: false,
          hidden: false,
          claimed: true,
        },
      ],
      sparkInvoiceHashes: new Map([
        ['spark-invoice', invoiceHash],
        ['spark-destination', destinationHash],
        ['spark-conversation', conversationHash],
        ['spark-unrelated', unrelatedHash],
      ]),
    });
    expect((await store.payments(0)).map((row) => row.isForumGift)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it('rejects rows the driver did not shape as usage data', async () => {
    const sql = new MockSql();
    const store = new PostgresWalletUsageStore(sql);
    const base = {
      paid_at: AT,
      amount_sats: 1,
      fee_sats: 0,
      category: 'member',
      payer_account_id: 'payer',
      payee_account_id: 'payee',
      payer_party: 'members',
      payee_party: 'members',
      is_fund_payout: false,
      is_forum_gift: false,
    };
    const rejects = async (row: unknown, message: string): Promise<void> => {
      sql.rows = [row];
      try {
        await store.payments(0);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(message);
        return;
      }
      throw new Error(`expected payments to throw: ${message}`);
    };
    await rejects({ ...base, is_fund_payout: null }, 'wallet usage fund payout flag is invalid');
    await rejects({ ...base, is_forum_gift: null }, 'wallet usage forum gift flag is invalid');
    await rejects({ ...base, is_forum_gift: 'yes' }, 'wallet usage forum gift flag is invalid');
    await rejects({ ...base, paid_at: 'not-a-date' }, 'wallet usage time is invalid');
    await rejects({ ...base, paid_at: new Date('not-a-date') }, 'wallet usage time is invalid');
    await rejects({ ...base, amount_sats: null }, 'wallet usage sats are missing');
    await rejects({ ...base, fee_sats: null }, 'wallet usage sats are missing');
    await rejects({ ...base, amount_sats: 1.5 }, 'wallet usage sats are not a safe integer');
    await rejects({ ...base, amount_sats: -1 }, 'wallet usage sats are not a safe integer');
    await rejects(
      { ...base, amount_sats: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      'wallet usage sats are not a safe integer',
    );
    await rejects({ ...base, category: 4 }, 'wallet usage category is invalid');
    await rejects({ ...base, payer_account_id: 4 }, 'wallet usage account id is invalid');
    await rejects({ ...base, payer_party: 'shop' }, 'wallet usage party is invalid');
    sql.rows = [{ created_at: 'not-a-date', amount_sats: 1, heart: false }];
    await expect(store.forumInvoices(0)).rejects.toThrow('wallet usage time is invalid');
    sql.rows = [{ created_at: AT, status: 4 }];
    await expect(store.shopCharges(0)).rejects.toThrow('wallet usage charge status is invalid');
  });

  it('propagates a query failure', async () => {
    const sql = new MockSql();
    sql.error = new Error('down');
    const store = new PostgresWalletUsageStore(sql);
    await expect(store.payments(0)).rejects.toThrow('down');
    await expect(store.forumInvoices(0)).rejects.toThrow('down');
    await expect(store.shopCharges(0)).rejects.toThrow('down');
  });
});
