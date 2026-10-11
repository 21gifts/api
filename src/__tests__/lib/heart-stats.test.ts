import { describe, expect, it, vi } from 'vitest';
import { attachHeartStats } from '@/lib/heart-stats';
import { InMemoryMessageStore, type MessageInvoiceAttempt } from '@/lib/message-store';

function invoice(row: {
  id: string;
  messageId: string;
  payerAccountId: string;
  paymentHash: string | null;
  result?: MessageInvoiceAttempt['result'];
  heart?: boolean;
}): MessageInvoiceAttempt {
  return {
    id: row.id,
    createdAt: new Date('2026-08-28T12:00:00.000Z'),
    messageId: row.messageId,
    payerAccountId: row.payerAccountId,
    authorAccountId: 'author',
    amountSats: 1,
    lightningAddress: null,
    zapRequest: { content: 'hi' },
    result: row.result ?? 'ok',
    httpStatus: 200,
    pr: 'lnbc1',
    paymentHash: row.paymentHash,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    heart: row.heart ?? false,
  };
}

describe('heartStats', () => {
  it('counts a claimed ok heart and sets hearted for that payer, lowercasing the hash', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'AA'.repeat(32);
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-1',
        messageId: 'msg-1',
        payerAccountId: 'payer-1',
        paymentHash,
        result: 'ok',
        heart: true,
      }),
    );
    await store.claimZapPayment(paymentHash, 'receipt-1', new Date('2026-08-28T12:00:00.000Z'));
    const stats = await store.heartStats(['msg-1'], 'payer-1');
    expect(stats.get('msg-1')).toEqual({ heartCount: 1, hearted: true });
  });

  it('counts two claimed hearts and sets hearted only for a matching payer', async () => {
    const store = new InMemoryMessageStore();
    const firstHash = 'AA'.repeat(32);
    const secondHash = 'BB'.repeat(32);
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-1',
        messageId: 'msg-1',
        payerAccountId: 'payer-1',
        paymentHash: firstHash,
        result: 'ok',
        heart: true,
      }),
    );
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-2',
        messageId: 'msg-1',
        payerAccountId: 'payer-2',
        paymentHash: secondHash,
        result: 'ok',
        heart: true,
      }),
    );
    await store.claimZapPayment(firstHash, 'receipt-1', new Date('2026-08-28T12:00:00.000Z'));
    await store.claimZapPayment(secondHash, 'receipt-2', new Date('2026-08-28T12:00:01.000Z'));
    expect(await store.heartStats(['msg-1'], 'payer-1')).toEqual(
      new Map([['msg-1', { heartCount: 2, hearted: true }]]),
    );
    expect(await store.heartStats(['msg-1'], 'payer-3')).toEqual(
      new Map([['msg-1', { heartCount: 2, hearted: false }]]),
    );
  });

  it('omits an ok heart that was never claimed', async () => {
    const store = new InMemoryMessageStore();
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-1',
        messageId: 'msg-1',
        payerAccountId: 'payer-1',
        paymentHash: 'AA'.repeat(32),
        result: 'ok',
        heart: true,
      }),
    );
    const stats = await store.heartStats(['msg-1'], 'payer-1');
    expect(stats.has('msg-1')).toBe(false);
  });

  it('omits a claimed ok invoice that is not a heart', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'AA'.repeat(32);
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-1',
        messageId: 'msg-1',
        payerAccountId: 'payer-1',
        paymentHash,
        result: 'ok',
        heart: false,
      }),
    );
    await store.claimZapPayment(paymentHash, 'receipt-1', new Date('2026-08-28T12:00:00.000Z'));
    const stats = await store.heartStats(['msg-1'], 'payer-1');
    expect(stats.has('msg-1')).toBe(false);
  });

  it('returns an empty map for an empty id list even when hearts are stored', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'AA'.repeat(32);
    await store.recordInvoiceAttempt(
      invoice({
        id: 'inv-1',
        messageId: 'msg-1',
        payerAccountId: 'payer-1',
        paymentHash,
        result: 'ok',
        heart: true,
      }),
    );
    await store.claimZapPayment(paymentHash, 'receipt-1', new Date('2026-08-28T12:00:00.000Z'));
    expect(await store.heartStats([], 'payer-1')).toEqual(new Map());
  });
});

describe('attachHeartStats', () => {
  it('calls statsFor once with every id, fills missing stats, keeps order, and does not mutate input', async () => {
    const messages = [{ id: 'known' }, { id: 'unknown' }];
    const statsFor = vi.fn(
      async (
        ids: readonly string[],
        viewerAccountId: string | null,
      ): Promise<ReadonlyMap<string, { heartCount: number; hearted: boolean }>> => {
        expect(ids).toEqual(['known', 'unknown']);
        expect(viewerAccountId).toBe('payer-1');
        return new Map([['known', { heartCount: 3, hearted: true }]]);
      },
    );
    const out = await attachHeartStats(statsFor, 'payer-1', messages);
    expect(statsFor).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { id: 'known', heartCount: 3, hearted: true },
      { id: 'unknown', heartCount: 0, hearted: false },
    ]);
    expect(out[0]).not.toBe(messages[0]);
    expect(messages).toEqual([{ id: 'known' }, { id: 'unknown' }]);
  });
});
