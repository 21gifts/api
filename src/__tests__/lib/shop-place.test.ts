import { describe, it, expect } from 'vitest';
import type { ForumPlace } from '@/lib/place';
import {
  SHOP_DESCRIPTION_MAX,
  SHOP_DESCRIPTION_MIN,
  shopDescription,
  shopPlaceProblem,
  shopTextProblem,
} from '@/lib/shop-place';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

const PIN: ForumPlace = {
  lat: 47.3,
  lng: 8.5,
  label: 'Stall',
  address: ADDRESS,
};

const NAME_REQUIRED = 'Shop name is required';
const NAME_CONTAINS_ADDRESS = 'Shop name must not contain the address';
const ADDRESS_REQUIRED = 'Shop address is required';
const DESCRIPTION_RANGE =
  'Shop description must be 20 to 1000 characters and longer than the shop name';

describe('shopDescription', () => {
  it('strips every case-insensitive #21GiftsShop token not followed by a word character', () => {
    expect(shopDescription('Hello #21GiftsShop world')).toBe('Hello  world');
    expect(shopDescription('Hello #21giftsshop world')).toBe('Hello  world');
    expect(shopDescription('#21GiftsShop')).toBe('');
    expect(shopDescription('Hello #21GiftsShopper')).toBe('Hello #21GiftsShopper');
    expect(shopDescription('#21GiftsShop_keep')).toBe('#21GiftsShop_keep');
  });

  it('converts CRLF and CR to LF, collapses 3+ newlines to 2, and trims', () => {
    expect(shopDescription('Coffee\r\n\r\n\r\n#21GiftsShop')).toBe('Coffee');
    expect(shopDescription('Coffee\r\r\r#21GiftsShop')).toBe('Coffee');
    expect(shopDescription('  a\n\n\n\nb  #21GiftsShop  ')).toBe('a\n\nb');
    expect(shopDescription('\n\n#21GiftsShop\n\n')).toBe('');
  });
});

describe('shopPlaceProblem', () => {
  it('requires a non-blank name before it requires an address', () => {
    expect(shopPlaceProblem({ lat: 1, lng: 2, label: null, address: null })).toBe(NAME_REQUIRED);
    expect(shopPlaceProblem({ lat: 1, lng: 2, label: '   ', address: ADDRESS })).toBe(
      NAME_REQUIRED,
    );
    expect(shopPlaceProblem({ lat: 1, lng: 2, label: 'Stall', address: null })).toBe(
      ADDRESS_REQUIRED,
    );
  });

  it('rejects a name that contains the street or postal code as a whole word', () => {
    expect(
      shopPlaceProblem({
        ...PIN,
        label: 'Bahnhofstrasse Cafe',
      }),
    ).toBe(NAME_CONTAINS_ADDRESS);
    expect(
      shopPlaceProblem({
        ...PIN,
        label: 'Cafe 8001',
      }),
    ).toBe(NAME_CONTAINS_ADDRESS);
    expect(
      shopPlaceProblem({
        ...PIN,
        label: 'Cafe8001',
      }),
    ).toBeNull();
    expect(
      shopPlaceProblem({
        ...PIN,
        label: 'Bahnhofstrassex',
      }),
    ).toBeNull();
  });

  it('returns null when the name and address are complete', () => {
    expect(shopPlaceProblem(PIN)).toBeNull();
  });
});

describe('shopTextProblem', () => {
  const longEnough = 'Coffee roasted on site and served at the bar.';

  it('requires 20 to 1000 characters and a description longer than the name', () => {
    expect(shopTextProblem('#21GiftsShop', PIN)).toBe(DESCRIPTION_RANGE);
    expect(shopTextProblem('short #21GiftsShop', PIN)).toBe(DESCRIPTION_RANGE);
    expect(shopTextProblem(`${'a'.repeat(SHOP_DESCRIPTION_MAX + 1)} #21GiftsShop`, PIN)).toBe(
      DESCRIPTION_RANGE,
    );
    expect(shopTextProblem(`${PIN.label} extra words here ok #21GiftsShop`, PIN)).toBeNull();
    expect(shopTextProblem(`${longEnough} #21GiftsShop`, PIN)).toBeNull();
  });

  it('rejects a description equal to the name case-insensitively', () => {
    const name = 'İ'.repeat(20);
    const description = 'i\u0307'.repeat(20);
    expect(shopTextProblem(`${description} #21GiftsShop`, { ...PIN, label: name })).toBe(
      DESCRIPTION_RANGE,
    );
  });

  it('skips an empty street or postal token when checking the name', () => {
    expect(
      shopPlaceProblem({
        ...PIN,
        address: { ...ADDRESS, street: '' },
      }),
    ).toBeNull();
    expect(
      shopPlaceProblem({
        ...PIN,
        address: { ...ADDRESS, postalCode: '' },
      }),
    ).toBeNull();
  });

  it('compares a missing label as the empty string', () => {
    expect(shopTextProblem(`${longEnough} #21GiftsShop`, null)).toBeNull();
    expect(
      shopTextProblem(`${longEnough} #21GiftsShop`, {
        lat: 1,
        lng: 2,
        label: null,
        address: ADDRESS,
      }),
    ).toBeNull();
    expect(shopTextProblem('short #21GiftsShop', null)).toBe(DESCRIPTION_RANGE);
  });

  it('measures the stripped description, not the raw note', () => {
    expect(SHOP_DESCRIPTION_MIN).toBe(20);
    expect(SHOP_DESCRIPTION_MAX).toBe(1000);
    expect(shopTextProblem(`${longEnough}\n\n#21GiftsShop`, PIN)).toBeNull();
    expect(shopTextProblem(`${'x'.repeat(19)} #21GiftsShop`, PIN)).toBe(DESCRIPTION_RANGE);
  });
});
