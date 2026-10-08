import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { isDevShopSeedTarget, seedDevShopPlaces } from '@/lib/dev-shop-places';
import * as log from '@/lib/log';
import { textHasHashtagToken } from '@/lib/message-store';

const DEV_ENV = { PUBLIC_BASE_URL: 'https://dev.21.gifts' };

const PINS = [
  {
    id: '9e6642fd-3a62-497d-bcbc-9b9daa9d55c7',
    name: 'Niza Estrera',
    label: 'Rose st.Happyland Barangay 105 Tondo,Manila',
    lat: 14.620311,
    lng: 120.959626,
    createdAt: '2026-10-07T12:16:03.538Z',
  },
  {
    id: '0cc5c2eb-aaf1-4f36-be26-f1b967e7bbe5',
    name: 'Machakos Bitcoin Academy',
    label: null,
    lat: -1.957658,
    lng: 37.840978,
    createdAt: '2026-10-02T12:54:21.602Z',
  },
  {
    id: '23d08047-df13-4f59-a541-99703e1e8fbc',
    name: 'bitcoinmakueni',
    label: null,
    lat: -2.523991,
    lng: 38.029153,
    createdAt: '2026-10-02T01:22:40.115Z',
  },
  {
    id: '5732c809-562e-4df3-b804-f287be068314',
    name: 'Rachel-Ann Mabulay',
    label: 'Happyland Court Barangay 105 Tondo, Manila',
    lat: 14.620756,
    lng: 120.958281,
    createdAt: '2026-09-29T13:59:23.922Z',
  },
] as const;

function sqlWithExecute(execute: SqlClient['execute']): SqlClient {
  return {
    execute,
    query: async () => {
      throw new Error('query is unused');
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isDevShopSeedTarget', () => {
  it('is true for the trimmed dev public base URL including trailing slashes', () => {
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://dev.21.gifts' })).toBe(true);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://dev.21.gifts/' })).toBe(true);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: '  https://dev.21.gifts/// ' })).toBe(true);
  });

  it('is false for any other public base URL', () => {
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://21.gifts' })).toBe(false);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://staging.21.gifts' })).toBe(false);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://dev.21.gifts.example' })).toBe(false);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'http://dev.21.gifts' })).toBe(false);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: 'https://DEV.21.gifts' })).toBe(false);
    expect(isDevShopSeedTarget({ PUBLIC_BASE_URL: '' })).toBe(false);
    expect(isDevShopSeedTarget({})).toBe(false);
  });
});

describe('seedDevShopPlaces', () => {
  it('does not call execute when the public base URL is production', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await seedDevShopPlaces({
      env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      sql: sqlWithExecute(execute),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not throw when the target is dev and sql is omitted', async () => {
    await expect(seedDevShopPlaces({ env: DEV_ENV })).resolves.toBeUndefined();
  });

  it('inserts the four public shop pins once on the dev URL', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await seedDevShopPlaces({
      env: DEV_ENV,
      sql: sqlWithExecute(execute),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0];
    if (call === undefined) {
      throw new Error('execute was not called');
    }
    const sql = call[0];
    const params = call[1];
    if (typeof sql !== 'string') {
      throw new Error('execute sql must be a string');
    }
    if (!Array.isArray(params)) {
      throw new Error('execute params missing');
    }
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql).toContain("'skipped'");
    expect(sql).not.toContain("'pending'");
    expect(params).toHaveLength(28);
    for (const [i, pin] of PINS.entries()) {
      const offset = i * 7;
      const text = params[offset + 2];
      expect(params[offset]).toBe(pin.id);
      expect(params[offset + 1]).toBe(pin.name);
      expect(text).toBe(`${pin.label ?? pin.name}\n\n#21GiftsShop`);
      if (typeof text !== 'string') {
        throw new Error('seeded text must be a string');
      }
      expect(textHasHashtagToken(text, '21GiftsShop')).toBe(true);
      expect(params[offset + 3]).toBe(pin.createdAt);
      expect(params[offset + 4]).toBe(pin.lat);
      expect(params[offset + 5]).toBe(pin.lng);
      expect(params[offset + 6]).toBe(pin.label);
    }
    expect(params[1]).toBe('Niza Estrera');
    expect(params[6]).toBe('Rose st.Happyland Barangay 105 Tondo,Manila');
    expect(params[8]).toBe('Machakos Bitcoin Academy');
    expect(params[13]).toBeNull();
    expect(params[15]).toBe('bitcoinmakueni');
    expect(params[20]).toBeNull();
    expect(params[22]).toBe('Rachel-Ann Mabulay');
    expect(params[27]).toBe('Happyland Court Barangay 105 Tondo, Manila');
  });

  it('resolves and logs without fields when execute rejects', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('execute failed'));
    const logSpy = vi.spyOn(log, 'logEvent').mockImplementation(() => undefined);
    await expect(
      seedDevShopPlaces({
        env: DEV_ENV,
        sql: sqlWithExecute(execute),
      }),
    ).resolves.toBeUndefined();
    expect(logSpy.mock.calls).toEqual([['dev.shop.places.failed']]);
  });
});
