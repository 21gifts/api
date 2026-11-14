import { describe, expect, it } from 'vitest';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import type { ForumPlace } from '@/lib/place';
import {
  activeShopDays,
  activeShopList,
  activeShops,
  type ShopActivityLookups,
} from '@/lib/shop-activity';

const TODAY = '2026-03-15';
const FIRST = '2026-02-14';
const START_MS = Date.parse(`${FIRST}T00:00:00.000Z`);
const TODAY_MS = Date.parse(`${TODAY}T00:00:00.000Z`);
const MS_PER_DAY = 86_400_000;
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

  it('counts a note only when the account currently on it has a charge that day', () => {
    const notes: ShopNoteRef[] = [shop({ id: 'n1', accountId: 'current' })];
    const formerOnly = activeShopDays(notes, [charge({ accountId: 'former' })], TODAY);
    expect(formerOnly[29]).toEqual({ day: TODAY, shopCount: 0 });
    expect(formerOnly.slice(0, 29).every((row) => row.shopCount === 0)).toBe(true);

    const withCurrent = activeShopDays(
      notes,
      [charge({ accountId: 'former' }), charge({ accountId: 'current' })],
      TODAY,
    );
    expect(withCurrent[29]).toEqual({ day: TODAY, shopCount: 1 });
    expect(withCurrent.slice(0, 29).every((row) => row.shopCount === 0)).toBe(true);
  });
});

function lookups(partial: Partial<ShopActivityLookups> = {}): ShopActivityLookups {
  return {
    places: new Map(),
    npubs: new Map(),
    usernames: new Map(),
    lastChargeMs: new Map(),
    ...partial,
  };
}

const PIN: ForumPlace = { lat: 47, lng: 8, label: 'Corner Cafe', address: null };

describe('activeShops', () => {
  it('keeps tagged notes with an account, each note id once, first ref wins', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'a', accountId: 'first' }),
      shop({ id: 'a', accountId: 'second' }),
      shop({ id: 'empty', accountId: '' }),
      shop({ id: 'untagged', text: 'Cafe' }),
      shop({ id: 'b' }),
    ];
    expect(activeShops(notes)).toEqual([shop({ id: 'a', accountId: 'first' }), shop({ id: 'b' })]);
  });
});

describe('activeShopList', () => {
  it('lists a shop with zero charges with null lastChargeDay', () => {
    expect(activeShopList([shop({ id: 'n1' })], [], lookups(), TODAY)).toEqual([
      {
        noteId: 'n1',
        name: 'Cafe',
        npub: null,
        accountId: 'acc',
        username: null,
        activeDays: 0,
        lastChargeDay: null,
      },
    ]);
  });

  it('counts distinct window days and ignores charges outside the window', () => {
    const charges: PosChargeRef[] = [
      charge({ createdAtMs: START_MS - 1 }),
      charge({ createdAtMs: START_MS }),
      charge({ createdAtMs: START_MS + 3_600_000 }),
      charge({ createdAtMs: NEXT_MIDNIGHT_MS - 1 }),
      charge({ createdAtMs: NEXT_MIDNIGHT_MS }),
      charge({ accountId: 'other', createdAtMs: TODAY_MS }),
    ];
    const [row] = activeShopList([shop({ id: 'n1' })], charges, lookups(), TODAY);
    expect(row?.activeDays).toBe(2);
  });

  it('adds up activeDays over all rows to the activeShopDays total', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'n1', accountId: 'a' }),
      shop({ id: 'n2', accountId: 'a' }),
      shop({ id: 'n3', accountId: 'b' }),
      shop({ id: 'n4', accountId: 'c' }),
    ];
    const charges: PosChargeRef[] = [
      charge({ accountId: 'a', createdAtMs: START_MS }),
      charge({ accountId: 'a', createdAtMs: TODAY_MS }),
      charge({ accountId: 'b', createdAtMs: TODAY_MS + 5 }),
    ];
    const rows = activeShopList(notes, charges, lookups(), TODAY);
    const days = activeShopDays(notes, charges, TODAY);
    expect(rows.reduce((sum, row) => sum + row.activeDays, 0)).toBe(
      days.reduce((sum, day) => sum + day.shopCount, 0),
    );
    expect(rows.map((row) => [row.noteId, row.activeDays])).toEqual([
      ['n4', 0],
      ['n1', 2],
      ['n2', 2],
      ['n3', 1],
    ]);
  });

  it('takes lastChargeDay from the stored latest charge outside the window', () => {
    const stored = Date.parse('2025-12-24T18:00:00.000Z');
    const [row] = activeShopList(
      [shop({ id: 'n1' })],
      [],
      lookups({ lastChargeMs: new Map([['acc', stored]]) }),
      TODAY,
    );
    expect(row?.lastChargeDay).toBe('2025-12-24');
    expect(row?.activeDays).toBe(0);
  });

  it('takes the later of the stored latest charge and the window charges', () => {
    const stale = lookups({ lastChargeMs: new Map([['acc', START_MS]]) });
    const [later] = activeShopList([shop({ id: 'n1' })], [charge()], stale, TODAY);
    expect(later?.lastChargeDay).toBe(TODAY);
    const fresh = lookups({ lastChargeMs: new Map([['acc', TODAY_MS]]) });
    const [kept] = activeShopList(
      [shop({ id: 'n1' })],
      [charge({ createdAtMs: START_MS })],
      fresh,
      TODAY,
    );
    expect(kept?.lastChargeDay).toBe(TODAY);
  });

  it('fills name, npub, and username from the lookups', () => {
    const [row] = activeShopList(
      [shop({ id: 'n1', accountId: 'till' })],
      [],
      lookups({
        places: new Map([['n1', PIN]]),
        npubs: new Map([['n1', 'npub1shop']]),
        usernames: new Map([['till', 'cafe']]),
      }),
      TODAY,
    );
    expect(row).toMatchObject({ name: 'Corner Cafe', npub: 'npub1shop', username: 'cafe' });
  });

  it('orders by lastChargeDay with null first, then name, then noteId', () => {
    const notes: ShopNoteRef[] = [
      shop({ id: 'z', accountId: 'today', text: 'Alpha #21GiftsShop' }),
      shop({ id: 'y', accountId: 'old', text: 'Beta #21GiftsShop' }),
      shop({ id: 'x2', accountId: 'never', text: 'Same #21GiftsShop' }),
      shop({ id: 'x1', accountId: 'never', text: 'Same #21GiftsShop' }),
      shop({ id: 'w', accountId: 'old', text: 'Alpha #21GiftsShop' }),
      shop({ id: 'v', accountId: 'never2', text: 'Gamma #21GiftsShop' }),
    ];
    const rows = activeShopList(
      notes,
      [charge({ accountId: 'today' })],
      lookups({ lastChargeMs: new Map([['old', START_MS - MS_PER_DAY]]) }),
      TODAY,
    );
    expect(rows.map((row) => row.noteId)).toEqual(['v', 'x1', 'x2', 'w', 'y', 'z']);
  });
});
