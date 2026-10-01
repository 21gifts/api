import { describe, expect, it } from 'vitest';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import { activeShopDays } from '@/lib/shop-activity';

const TODAY = '2026-03-15';
const FIRST = '2026-02-14';
const START_MS = Date.parse(`${FIRST}T00:00:00.000Z`);
const TODAY_MS = Date.parse(`${TODAY}T00:00:00.000Z`);
const NEXT_MIDNIGHT_MS = Date.parse('2026-03-16T00:00:00.000Z');

function shop(partial: Partial<ShopNoteRef> & Pick<ShopNoteRef, 'id'>): ShopNoteRef {
  return {
    accountId: 'acc',
    text: 'Cafe #21GiftsShop',
    ...partial,
  };
}

function charge(partial: Partial<PosChargeRef> = {}): PosChargeRef {
  return {
    accountId: 'acc',
    createdAtMs: Date.parse(`${TODAY}T12:00:00.000Z`),
    ...partial,
  };
}

describe('activeShopDays', () => {
  it('returns 30 zero-filled UTC days ending on today, oldest first', () => {
    const days = activeShopDays([], [], TODAY);
    expect(days).toHaveLength(30);
    expect(days[0]?.day).toBe(FIRST);
    expect(days[29]?.day).toBe(TODAY);
    expect(days.every((row) => row.shopCount === 0)).toBe(true);
  });

  it('counts #21giftsshop and rejects #21GiftsShopping', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'ok', text: 'visit #21giftsshop today' }),
      shop({ id: 'long', text: 'visit #21GiftsShopping today' }),
    ];
    const days = activeShopDays(notes, [charge()], TODAY);
    expect(days[29]).toEqual({ day: TODAY, shopCount: 1 });
    expect(days.slice(0, 29).every((row) => row.shopCount === 0)).toBe(true);
  });

  it('counts each qualifying note once when two notes share one account', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'n1', accountId: 'acc' }),
      shop({ id: 'n2', accountId: 'acc' }),
    ];
    const days = activeShopDays(notes, [charge(), charge({ createdAtMs: TODAY_MS + 1 })], TODAY);
    expect(days[29]?.shopCount).toBe(2);
  });

  it('counts a duplicate note id once', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'same', text: 'first #21GiftsShop' }),
      shop({ id: 'same', text: 'second #21GiftsShop' }),
    ];
    const days = activeShopDays(notes, [charge()], TODAY);
    expect(days[29]?.shopCount).toBe(1);
  });

  it('includes a charge on the first-day midnight and excludes the next UTC day', () => {
    const notes: ShopNoteRef[] = [shop({ id: 'n1' })];
    const onStart = activeShopDays(notes, [charge({ createdAtMs: START_MS })], TODAY);
    expect(onStart[0]).toEqual({ day: FIRST, shopCount: 1 });
    expect(onStart[29]?.shopCount).toBe(0);

    const beforeStart = activeShopDays(notes, [charge({ createdAtMs: START_MS - 1 })], TODAY);
    expect(beforeStart.every((row) => row.shopCount === 0)).toBe(true);

    const lastMs = NEXT_MIDNIGHT_MS - 1;
    const onToday = activeShopDays(notes, [charge({ createdAtMs: lastMs })], TODAY);
    expect(onToday[29]).toEqual({ day: TODAY, shopCount: 1 });

    const nextDay = activeShopDays(notes, [charge({ createdAtMs: NEXT_MIDNIGHT_MS })], TODAY);
    expect(nextDay.every((row) => row.shopCount === 0)).toBe(true);
  });
});
