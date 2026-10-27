import { describe, it, expect } from 'vitest';
import type { ForumPlace } from '@/lib/place';
import {
  SHOP_DESCRIPTION_MAX,
  SHOP_DESCRIPTION_MIN,
  SHOP_NAME_REQUIRED,
  shopDescription,
  shopPlaceProblem,
  shopTextProblem,
  isListedShop,
  listedShop,
  listedShopName,
  publicShop,
  publicShopName,
  shopListingFingerprint,
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
    expect(SHOP_NAME_REQUIRED).toBe(NAME_REQUIRED);
    expect(shopPlaceProblem({ lat: 1, lng: 2, label: null, address: null })).toBe(
      SHOP_NAME_REQUIRED,
    );
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

describe('listedShop', () => {
  const place = {
    lat: 47.3,
    lng: 8.5,
    label: 'Coffee Lab',
    address: {
      street: 'Main Street',
      houseNumber: '1',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    },
  };
  const note = {
    parentId: null,
    deletedAt: null,
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
    place,
    shopAccount: { id: 'till' },
  };

  it('returns the name, the complete pin and the till account of a listed shop', () => {
    expect(listedShop(note)).toEqual({ name: 'Coffee Lab', place, tillAccountId: 'till' });
    expect(listedShopName(note)).toBe('Coffee Lab');
    expect(isListedShop(note)).toBe(true);
    expect(
      isListedShop({ ...note, text: 'Fresh coffee roasted here every morning. #21giftsshop' }),
    ).toBe(true);
  });

  it('rejects every condition that is not met', () => {
    const withoutTill = { parentId: null, deletedAt: null, text: note.text, place };
    const withoutPlace = {
      parentId: null,
      deletedAt: null,
      text: note.text,
      shopAccount: { id: 'x' },
    };
    for (const row of [
      undefined,
      { ...note, parentId: 'parent' },
      { ...note, deletedAt: new Date(0) },
      withoutTill,
      { ...note, shopAccount: null },
      withoutPlace,
      { ...note, place: null },
      { ...note, place: { ...place, label: null } },
      { ...note, place: { ...place, address: null } },
      { ...note, text: 'Fresh coffee roasted here every morning. #21GiftsShops' },
      { ...note, place: { ...place, label: 'Coffee Lab Main Street' } },
      { ...note, text: 'Too short #21GiftsShop' },
    ]) {
      expect(listedShop(row)).toBeNull();
      expect(listedShopName(row)).toBeNull();
      expect(isListedShop(row)).toBe(false);
    }
  });
});

describe('publicShop', () => {
  const text = 'Fresh coffee roasted here every morning. #21GiftsShop';
  const note = {
    parentId: null,
    deletedAt: null,
    text,
    place: PIN,
    shopAccount: { id: 'till' },
  };

  it('keeps a complete shop and drops an address that has a blank part', () => {
    expect(publicShop(note)).toEqual({
      name: 'Stall',
      place: PIN,
      tillAccountId: 'till',
    });
    expect(
      publicShop({
        ...note,
        place: { ...PIN, address: { ...ADDRESS, street: '  ' } },
      })?.place?.address,
    ).toBeNull();
  });

  it('lists a pin that has no structured address', () => {
    expect(
      publicShop({
        ...note,
        place: { lat: 14.6, lng: 120.9, label: 'Stall', address: null },
      }),
    ).toEqual({
      name: 'Stall',
      place: { lat: 14.6, lng: 120.9, label: 'Stall', address: null },
      tillAccountId: 'till',
    });
    expect(publicShop({ ...note, place: { ...PIN, label: null } })?.place).toEqual({
      ...PIN,
      label: '',
    });
  });

  it('lists a shop with no coordinates and names it from the description', () => {
    expect(publicShop({ ...note, place: null })).toEqual({
      name: 'Fresh coffee roasted here every morning.',
      place: null,
      tillAccountId: 'till',
    });
    expect(publicShop({ ...note, place: { ...PIN, label: '   ' } })?.name).toBe(
      'Fresh coffee roasted here every morning.',
    );
    expect(publicShop({ ...note, place: { ...PIN, lat: Number.NaN } })?.place).toBeNull();
  });

  it('uses Shop when the note has neither a label nor a description', () => {
    expect(publicShopName('#21GiftsShop', null)).toBe('Shop');
    expect(publicShop({ ...note, text: '#21GiftsShop\n\n', place: null })?.name).toBe('Shop');
  });

  it('cuts a description name at 80 characters', () => {
    const line = `${'a'.repeat(90)}`;
    expect(publicShopName(`${line} #21GiftsShop`, null)).toBe('a'.repeat(80));
  });

  it('rejects a reply, a hidden note, a missing till and a missing tag', () => {
    expect(publicShop(undefined)).toBeNull();
    expect(publicShop({ ...note, parentId: 'parent' })).toBeNull();
    expect(publicShop({ ...note, deletedAt: new Date(0) })).toBeNull();
    expect(publicShop({ ...note, shopAccount: null })).toBeNull();
    expect(
      publicShop({
        parentId: note.parentId,
        deletedAt: note.deletedAt,
        text: note.text,
        place: note.place,
      }),
    ).toBeNull();
    expect(publicShop({ ...note, text: 'Fresh coffee roasted here every morning.' })).toBeNull();
  });
});

describe('shopListingFingerprint', () => {
  const note = {
    parentId: null,
    deletedAt: null,
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
    place: PIN,
    shopAccount: { id: 'till' },
  };

  it('is missing for no note and equal for the same listing fields', () => {
    expect(shopListingFingerprint(undefined)).toBe('missing');
    expect(shopListingFingerprint({ ...note, place: { ...PIN } })).toBe(
      shopListingFingerprint(note),
    );
  });

  it('changes with the text, the pin, the till account and deletedAt', () => {
    const base = shopListingFingerprint(note);
    for (const changed of [
      { ...note, text: `${note.text} More beans.` },
      { ...note, place: { ...PIN, label: 'Roastery' } },
      { ...note, place: null },
      { ...note, shopAccount: { id: 'other' } },
      { ...note, shopAccount: null },
      { ...note, deletedAt: new Date(0) },
    ]) {
      expect(shopListingFingerprint(changed)).not.toBe(base);
    }
  });
});
