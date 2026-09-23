import { describe, it, expect } from 'vitest';
import { PLACE_LABEL_MAX, normalizePlace, parseMultipartCoord, placesMatch } from '@/lib/place';

const COORD_ERROR = 'Place must be a latitude and longitude';
const LABEL_ERROR = 'Place label must be at most 80 characters';

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
      value: { lat: -90, lng: -180, label: null },
    });
    expect(normalizePlace({ lat: 90, lng: 180 })).toEqual({
      ok: true,
      value: { lat: 90, lng: 180, label: null },
    });
    expect(normalizePlace({ lat: 47.1234567, lng: 8.1234564 })).toEqual({
      ok: true,
      value: { lat: 47.123457, lng: 8.123456, label: null },
    });
  });

  it('collapses -0 to 0', () => {
    const result = normalizePlace({ lat: -0, lng: -0 });
    expect(result).toEqual({ ok: true, value: { lat: 0, lng: 0, label: null } });
    if (result.ok && result.value !== null) {
      expect(Object.is(result.value.lat, -0)).toBe(false);
      expect(Object.is(result.value.lng, -0)).toBe(false);
    }
  });

  it('treats absent, null, and trim-empty labels as null', () => {
    expect(normalizePlace({ lat: 47.3, lng: 8.5 })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: null })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: '   ' })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: null },
    });
    expect(normalizePlace({ lat: 47.3, lng: 8.5, label: '  Café  ' })).toEqual({
      ok: true,
      value: { lat: 47.3, lng: 8.5, label: 'Café' },
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
      value: { lat: 1, lng: 2, label: max },
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
      value: { lat: 47.3, lng: 8.5, label: 'Zürich' },
    });
  });
});

describe('placesMatch', () => {
  const pin = { lat: 47.3, lng: 8.5, label: 'Stall' as string | null };

  it('matches only when both pins are absent or identical', () => {
    expect(placesMatch(null, null)).toBe(true);
    expect(placesMatch(null, pin)).toBe(false);
    expect(placesMatch(pin, null)).toBe(false);
    expect(placesMatch(pin, { ...pin })).toBe(true);
    expect(placesMatch(pin, { ...pin, lat: 1 })).toBe(false);
    expect(placesMatch(pin, { ...pin, lng: 1 })).toBe(false);
    expect(placesMatch(pin, { ...pin, label: 'Other' })).toBe(false);
    expect(placesMatch(pin, { ...pin, label: null })).toBe(false);
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
    expect(parseMultipartCoord('47.3')).toBe(47.3);
    expect(parseMultipartCoord(' +8 ')).toBe(8);
    expect(parseMultipartCoord('-0.5')).toBe(-0.5);
    expect(parseMultipartCoord('.5')).toBe(0.5);
  });
});
