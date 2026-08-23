import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { createApp } from '@/server';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

const GIFT: GiftRow = {
  paidAt: new Date('2026-06-01T12:00:00.000Z'),
  amountSats: 1000,
  recipientWosUser: 'alice',
};

describe('GET /gifts/stats', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns empty stats from the default store', async () => {
    const res = await createApp().request('/gifts/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalSats: 0,
      giftCount: 0,
      recipientCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      spendOverTime: [],
      byRecipient: [],
      byMonth: [],
    });
  });

  it('aggregates gifts from an injected store', async () => {
    const res = await createApp({ giftStore: new InMemoryGiftStore([GIFT]) }).request(
      '/gifts/stats',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { giftCount: number; totalSats: number };
    expect(body.giftCount).toBe(1);
    expect(body.totalSats).toBe(1000);
  });

  it('returns 503 when the store throws', async () => {
    const giftStore: GiftStore = {
      listOutbound: async () => {
        throw new Error('db down');
      },
    };
    const res = await createApp({ giftStore }).request('/gifts/stats');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.stats.failed')).toBe(true);
  });
});
