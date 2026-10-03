import { describe, expect, it } from 'vitest';
import { measureGrantContinuation } from '@/lib/grant-continuation';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';

const TODAY = '2026-03-15';
const FIRST = '2026-03-09';
const START_MS = Date.parse(`${FIRST}T00:00:00.000Z`);
const TODAY_MS = Date.parse(`${TODAY}T12:00:00.000Z`);
const NEXT_MIDNIGHT_MS = Date.parse('2026-03-16T00:00:00.000Z');
const DAY_MS = 86_400_000;

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
    createdAtMs: TODAY_MS,
    ...partial,
  };
}

function atDay(offset: number, accountId = 'acc'): PosChargeRef {
  return charge({ accountId, createdAtMs: START_MS + offset * DAY_MS + 3_600_000 });
}

describe('measureGrantContinuation', () => {
  it('returns 7 zero-filled UTC days ending on today, oldest first', () => {
    const measured = measureGrantContinuation([], [], TODAY);
    expect(measured.days).toHaveLength(7);
    expect(measured.days[0]?.day).toBe(FIRST);
    expect(measured.days[6]?.day).toBe(TODAY);
    expect(measured.days.every((row) => row.shopCount === 0)).toBe(true);
    expect(measured.qualifyingShops).toBe(0);
  });

  it('counts #21giftsshop and rejects #21GiftsShopping', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'ok', text: 'visit #21giftsshop today' }),
      shop({ id: 'long', text: 'visit #21GiftsShopping today' }),
    ];
    const measured = measureGrantContinuation(notes, [charge()], TODAY);
    expect(measured.days[6]).toEqual({ day: TODAY, shopCount: 1 });
    expect(measured.days.slice(0, 6).every((row) => row.shopCount === 0)).toBe(true);
    expect(measured.qualifyingShops).toBe(0);
  });

  it('counts two notes that share one account and one charge as two shops', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'n1', accountId: 'till' }),
      shop({ id: 'n2', accountId: 'till' }),
    ];
    const measured = measureGrantContinuation(
      notes,
      [charge({ accountId: 'till' }), charge({ accountId: 'till', createdAtMs: TODAY_MS + 1 })],
      TODAY,
    );
    expect(measured.days[6]).toEqual({ day: TODAY, shopCount: 2 });
    expect(measured.qualifyingShops).toBe(0);
  });

  it('counts a duplicate note id once', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'same', text: 'first #21GiftsShop' }),
      shop({ id: 'same', text: 'second #21GiftsShop' }),
    ];
    const measured = measureGrantContinuation(notes, [charge()], TODAY);
    expect(measured.days[6]?.shopCount).toBe(1);
  });

  it('skips an empty account id and a note without the shop hashtag', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'blank', accountId: '' }),
      shop({ id: 'plain', text: 'just a cafe' }),
    ];
    const measured = measureGrantContinuation(notes, [charge()], TODAY);
    expect(measured.days.every((row) => row.shopCount === 0)).toBe(true);
    expect(measured.qualifyingShops).toBe(0);
  });

  it('includes a charge on the first-day midnight and excludes the next UTC day', () => {
    const notes: ShopNoteRef[] = [shop({ id: 'n1' })];
    const onStart = measureGrantContinuation(notes, [charge({ createdAtMs: START_MS })], TODAY);
    expect(onStart.days[0]).toEqual({ day: FIRST, shopCount: 1 });
    expect(onStart.days[6]?.shopCount).toBe(0);

    const beforeStart = measureGrantContinuation(
      notes,
      [charge({ createdAtMs: START_MS - 1 })],
      TODAY,
    );
    expect(beforeStart.days.every((row) => row.shopCount === 0)).toBe(true);
    expect(beforeStart.qualifyingShops).toBe(0);

    const onToday = measureGrantContinuation(
      notes,
      [charge({ createdAtMs: NEXT_MIDNIGHT_MS - 1 })],
      TODAY,
    );
    expect(onToday.days[6]).toEqual({ day: TODAY, shopCount: 1 });

    const nextDay = measureGrantContinuation(
      notes,
      [charge({ createdAtMs: NEXT_MIDNIGHT_MS })],
      TODAY,
    );
    expect(nextDay.days.every((row) => row.shopCount === 0)).toBe(true);
  });

  it('counts a note only when the account currently on it has the charge', () => {
    const notes: ShopNoteRef[] = [shop({ id: 'n1', accountId: 'current' })];
    const formerOnly = measureGrantContinuation(notes, [charge({ accountId: 'former' })], TODAY);
    expect(formerOnly.days[6]).toEqual({ day: TODAY, shopCount: 0 });
    expect(formerOnly.qualifyingShops).toBe(0);

    const withCurrent = measureGrantContinuation(
      notes,
      [charge({ accountId: 'former' }), charge({ accountId: 'current' })],
      TODAY,
    );
    expect(withCurrent.days[6]).toEqual({ day: TODAY, shopCount: 1 });
  });

  it('qualifies a shop on 5 days in the window and not on 4', () => {
    const notes: ShopNoteRef[] = [shop({ id: 'n1' })];
    const four = measureGrantContinuation(notes, [atDay(3), atDay(4), atDay(5), atDay(6)], TODAY);
    expect(four.qualifyingShops).toBe(0);
    expect(four.days.map((row) => row.shopCount)).toEqual([0, 0, 0, 1, 1, 1, 1]);

    const five = measureGrantContinuation(
      notes,
      [atDay(0), atDay(1), atDay(2), atDay(3), atDay(4)],
      TODAY,
    );
    expect(five.qualifyingShops).toBe(1);
    expect(five.days.map((row) => row.shopCount)).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });

  it('qualifies both notes when one account has 5 days', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'n1', accountId: 'till' }),
      shop({ id: 'n2', accountId: 'till' }),
      shop({ id: 'other', accountId: 'short' }),
    ];
    const measured = measureGrantContinuation(
      notes,
      [
        atDay(0, 'till'),
        atDay(1, 'till'),
        atDay(2, 'till'),
        atDay(3, 'till'),
        atDay(4, 'till'),
        atDay(6, 'short'),
      ],
      TODAY,
    );
    expect(measured.qualifyingShops).toBe(2);
    expect(measured.days[0]?.shopCount).toBe(2);
    expect(measured.days[6]?.shopCount).toBe(1);
  });
});
