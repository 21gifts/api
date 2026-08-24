import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  NoopGiftRecorder,
  SqlGiftRecorder,
  recipientHandleFromAddress,
  type GiftRecord,
} from '@/lib/gift-recorder';

const RECORD: GiftRecord = {
  paidAt: new Date('2026-08-24T12:00:00.000Z'),
  amountSats: 1000,
  feeSats: 0,
  recipientWosUser: 'alice',
  lightningInvoice: 'lnbc1test',
  description: '21gifts daily',
  sourceWallet: 'lightning.space',
};

describe('recipientHandleFromAddress', () => {
  it('returns the local part of a Lightning Address', () => {
    expect(recipientHandleFromAddress('alice@walletofsatoshi.com')).toBe('alice');
  });

  it('returns the input when there is no @', () => {
    expect(recipientHandleFromAddress('alice')).toBe('alice');
  });
});

describe('NoopGiftRecorder', () => {
  it('resolves without calling SQL', async () => {
    await expect(new NoopGiftRecorder().recordOutbound(RECORD)).resolves.toBeUndefined();
  });
});

describe('SqlGiftRecorder', () => {
  it('inserts an outbound gift with ON CONFLICT DO NOTHING', async () => {
    const execute = vi.fn(async () => undefined);
    const sql: SqlClient = {
      query: async () => {
        throw new Error('unused');
      },
      execute,
    };
    await new SqlGiftRecorder(sql).recordOutbound(RECORD);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO gift[\s\S]*ON CONFLICT \(lightning_invoice\) DO NOTHING/),
      [RECORD.paidAt, 1000, 0, 'alice', 'lnbc1test', '21gifts daily', 'lightning.space'],
    );
  });
});
