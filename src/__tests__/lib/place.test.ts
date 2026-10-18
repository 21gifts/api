import { describe, it, expect } from 'vitest';
import { PLACE_LABEL_MAX, normalizePlace, parseMultipartCoord, placesMatch } from '@/lib/place';

const COORD_ERROR = 'Place must be a latitude and longitude';
const LABEL_ERROR = 'Place label must be at most 80 characters';
const ADDRESS_ERROR = 'Place address is invalid';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

describe('normalizePlace', () => {
  it('accepts undefined and null as no pin', () => {
    expect(normalizePlace(undefined)).toEqual({ ok: true, value: null });
    expect(normalizePlace(null)).toEqual({ ok: true, value: null });
  });

  it('rejects non-objects, arrays, and missing or non-numeric coordinates', () => {
    expect(normalizePlace('47,8')).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace(1)).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace(true)).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace([])).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace({})).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace({ lat: 47.3 })).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace({ lng: 8.5 })).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizePlace({ lat: '47.3', lng: 8.5 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 47.3, lng: '8.5' })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
  });

  it('rejects NaN, Infinity, and out-of-range coordinates', () => {
    expect(normalizePlace({ lat: Number.NaN, lng: 8.5 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 47.3, lng: Number.NaN })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: Number.POSITIVE_INFINITY, lng: 8.5 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 47.3, lng: Number.NEGATIVE_INFINITY })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: -90.000001, lng: 0 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 90.000001, lng: 0 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 0, lng: -180.000001 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 0, lng: 180.000001 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
  });

  it('accepts range bounds and rounds to six decimal places', () => {
    expect(normalizePlace({ lat: -90, lng: -180 })).toEqual({
      ok: true,
      value: { lat: -90, lng: -180, label: null, address: null },
    });
    expect(normalizePlace({ lat: 90, lng: 180 })).toEqual({
      ok: true,
      value: { lat: 90, lng: 180, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.1234567, lng: 8.1234564 })).toEqual({
      ok: true,
      value: { lat: 47.123457, lng: 8.123456, label: null, address: null },
    });
  });

  it('collapses -0 to 0', () => {
    const result = normalizePlace({ lat: -0, lng: -0 });
    expect(result).toEqual({ ok: true, value: { lat: 0, lng: 0, label: null, address: null } });
    if (result.ok && result.value !== null) {
      expect(Object.is(result.value.lat, -0)).toBe(false);
      expect(Object.is(result.value.lng, -0)).toBe(false);
    }
  });

  it('treats absent, null, and trim-empty labels as null', () => {
    expect(normalizePlace({ lat: 47.3, lng: 8.5 })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: null })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: '   ' })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: '  Café  ' })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: 'Café', address: null },
    });
  });

  it('rejects a non-string label as a latitude error', () => {
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: 1 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: true })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
  });

  it('accepts a label at the maximum length and rejects a longer one', () => {
    const max = 'A'.repeat(PLACE_LABEL_MAX);
    expect(normalizePlace({ lat: 1, lng: 2, label: max })).toEqual({
      ok: true,
      value: { lat: 1, lng: 2, label: max, address: null },
    });
    expect(normalizePlace({ lat: 1, lng: 2, label: `${max}x` })).toEqual({
      ok: false,
      error: LABEL_ERROR,
    });
  });

  it('rejects C0 and DEL characters in the label', () => {
    expect(normalizePlace({ lat: 1, lng: 2, label: 'Cafe\tbar' })).toEqual({
      ok: false,
      error: LABEL_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, label: 'Cafe\nbar' })).toEqual({
      ok: false,
      error: LABEL_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, label: `Cafe${String.fromCharCode(127)}` })).toEqual({
      ok: false,
      error: LABEL_ERROR,
    });
  });

  it('keeps the pin when a valid label is set', () => {
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: 'Zürich' })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: 'Zürich', address: null },
    });
  });

  it('treats absent, undefined, and null address as null', () => {
    expect(normalizePlace({ lat: 47.3, lng: 8.5 })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, address: null })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, address: undefined })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null, address: null },
    });
  });

  it('accepts a complete address and uppercases the country', () => {
    expect(
      normalizePlace({
        lat: 47.3,
        lng: 8.5,
        label: 'Cafe',
        address: { ...ADDRESS, country: ' ch ' },
      }),
    ).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: 'Cafe', address: ADDRESS },
    });
    expect(
      normalizePlace({
        lat: 47.3,
        lng: 8.5,
        address: { ...ADDRESS, houseNumber: '1–3' },
      }),
    ).toEqual({
      ok: true,
      value: {
        lat: 47.3,
        lng: 8.5,
        label: null,
        address: { ...ADDRESS, houseNumber: '1–3' },
      },
    });
  });

  it('rejects a non-object address, extra keys, and missing keys', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: 'x' })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: [] })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, extra: 'x' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: {
          street: ADDRESS.street,
          houseNumber: ADDRESS.houseNumber,
          postalCode: ADDRESS.postalCode,
          country: ADDRESS.country,
        },
      }),
    ).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: {
          street: ADDRESS.street,
          houseNumber: ADDRESS.houseNumber,
          postalCode: ADDRESS.postalCode,
          city: ADDRESS.city,
          extra: 'x',
        },
      }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
  });

  it('rejects a street that is empty, over-long, or has C0/DEL', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, street: '' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, street: 'A'.repeat(121) } }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, street: 'Main\nst' } })).toEqual(
      { ok: false, error: ADDRESS_ERROR },
    );
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: { ...ADDRESS, street: `Main${String.fromCharCode(127)}` },
      }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, street: 1 } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
  });

  it('rejects a house number that does not match the OpenCryptoPay pattern', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, houseNumber: '' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, houseNumber: 'A1' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, houseNumber: '\t1' } })).toEqual(
      { ok: false, error: ADDRESS_ERROR },
    );
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, houseNumber: 1 } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
  });

  it('rejects an unassigned country and accepts GB, not UK', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, country: 'UK' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, country: 'XX' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, country: 1 } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: { ...ADDRESS, country: 'gb', postalCode: 'SW1A 1AA' },
      }),
    ).toEqual({
      ok: true,
      value: {
        lat: 1,
        lng: 2,
        label: null,
        address: { ...ADDRESS, country: 'GB', postalCode: 'SW1A 1AA' },
      },
    });
  });

  it('validates postal codes with the CH/LI four-digit rule and the other pattern', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, postalCode: '800' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: { ...ADDRESS, country: 'LI', postalCode: '9490' },
      }),
    ).toEqual({
      ok: true,
      value: {
        lat: 1,
        lng: 2,
        label: null,
        address: { ...ADDRESS, country: 'LI', postalCode: '9490' },
      },
    });
    expect(
      normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, country: 'DE', postalCode: 'A' } }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: { ...ADDRESS, country: 'DE', postalCode: '10115' },
      }),
    ).toEqual({
      ok: true,
      value: {
        lat: 1,
        lng: 2,
        label: null,
        address: { ...ADDRESS, country: 'DE', postalCode: '10115' },
      },
    });
    expect(
      normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, postalCode: '\t8001' } }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, postalCode: 8001 } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
  });

  it('rejects a city that is empty, over-long, control-laden, or without a letter', () => {
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, city: '' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, city: 'A'.repeat(81) } }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, city: '123' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, city: 'Z\n' } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
    expect(
      normalizePlace({
        lat: 1,
        lng: 2,
        address: { ...ADDRESS, city: `Z${String.fromCharCode(127)}` },
      }),
    ).toEqual({ ok: false, error: ADDRESS_ERROR });
    expect(normalizePlace({ lat: 1, lng: 2, address: { ...ADDRESS, city: 1 } })).toEqual({
      ok: false,
      error: ADDRESS_ERROR,
    });
  });
});

describe('placesMatch', () => {
  const pin = { lat: 47.3, lng: 8.5, label: 'Stall' as string | null, address: null };

  it('matches only when both pins are absent or identical', () => {
    expect(placesMatch(null, null)).toBe(true);
    expect(placesMatch(null, pin)).toBe(false);
    expect(placesMatch(pin, null)).toBe(false);
    expect(placesMatch(pin, { ...pin })).toBe(true);
    expect(placesMatch(pin, { ...pin, lat: 1 })).toBe(false);
    expect(placesMatch(pin, { ...pin, lng: 1 })).toBe(false);
    expect(placesMatch(pin, { ...pin, label: 'Other' })).toBe(false);
    expect(placesMatch(pin, { ...pin, label: null })).toBe(false);
    expect(placesMatch(pin, { ...pin, address: ADDRESS })).toBe(false);
    expect(placesMatch({ ...pin, address: ADDRESS }, { ...pin, address: { ...ADDRESS } })).toBe(
      true,
    );
    expect(
      placesMatch({ ...pin, address: ADDRESS }, { ...pin, address: { ...ADDRESS, city: 'Bern' } }),
    ).toBe(false);
  });
});

describe('parseMultipartCoord', () => {
  it('treats blank values as missing and anything else non-decimal as invalid', () => {
    expect(parseMultipartCoord(null)).toBe('missing');
    expect(parseMultipartCoord(undefined)).toBe('missing');
    expect(parseMultipartCoord('')).toBe('missing');
    expect(parseMultipartCoord('  ')).toBe('missing');
    expect(parseMultipartCoord(1)).toBe('invalid');
    expect(parseMultipartCoord(true)).toBe('invalid');
    expect(parseMultipartCoord('north')).toBe('invalid');
    expect(parseMultipartCoord('1e2')).toBe('invalid');
    expect(parseMultipartCoord('+')).toBe('invalid');
    expect(parseMultipartCoord('.')).toBe('invalid');
    expect(parseMultipartCoord('9'.repeat(400))).toBe('invalid');
    expect(parseMultipartCoord('47.3')).toBe(47.3);
    expect(parseMultipartCoord(' +8 ')).toBe(8);
    expect(parseMultipartCoord('-0.5')).toBe(-0.5);
    expect(parseMultipartCoord('.5')).toBe(0.5);
  });
});
