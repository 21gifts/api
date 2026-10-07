import { describe, expect, it } from 'vitest';
import {
  CLIENT_INSTANT_FUTURE_SKEW_MS,
  CLIENT_INSTANT_MIN_MS,
  parseClientInstant,
} from '@/lib/client-instant';

const NOW = 1_700_000_000_000;

describe('parseClientInstant', () => {
  it('exports the genesis floor and five-minute future skew', () => {
    expect(CLIENT_INSTANT_MIN_MS).toBe(Date.parse('2009-01-03T00:00:00Z'));
    expect(CLIENT_INSTANT_FUTURE_SKEW_MS).toBe(300_000);
  });

  it('parses a finite epoch-seconds number below 1e11', () => {
    const parsed = parseClientInstant(1_700_000_000, NOW);
    expect(parsed?.getTime()).toBe(NOW);
  });

  it('parses a finite epoch-milliseconds number at or above 1e11', () => {
    expect(parseClientInstant(NOW - 1, NOW)?.getTime()).toBe(NOW - 1);
    expect(parseClientInstant(1e11, NOW)).toBeNull();
  });

  it('parses an ISO-8601 string via Date.parse', () => {
    const iso = '2023-11-14T22:13:20.000Z';
    expect(parseClientInstant(iso, NOW)?.getTime()).toBe(Date.parse(iso));
  });

  it('accepts the minimum instant and the future-skew bound', () => {
    expect(parseClientInstant(CLIENT_INSTANT_MIN_MS, NOW)?.getTime()).toBe(CLIENT_INSTANT_MIN_MS);
    expect(parseClientInstant('2009-01-03T00:00:00.000Z', NOW)?.getTime()).toBe(
      CLIENT_INSTANT_MIN_MS,
    );
    expect(parseClientInstant(NOW + CLIENT_INSTANT_FUTURE_SKEW_MS, NOW)?.getTime()).toBe(
      NOW + CLIENT_INSTANT_FUTURE_SKEW_MS,
    );
  });

  it('returns null for non-finite numbers, unparsable strings, and other types', () => {
    expect(parseClientInstant(Number.NaN, NOW)).toBeNull();
    expect(parseClientInstant(Number.POSITIVE_INFINITY, NOW)).toBeNull();
    expect(parseClientInstant(Number.NEGATIVE_INFINITY, NOW)).toBeNull();
    expect(parseClientInstant('not-an-instant', NOW)).toBeNull();
    expect(parseClientInstant('', NOW)).toBeNull();
    expect(parseClientInstant(null, NOW)).toBeNull();
    expect(parseClientInstant(undefined, NOW)).toBeNull();
    expect(parseClientInstant(true, NOW)).toBeNull();
    expect(parseClientInstant({}, NOW)).toBeNull();
    expect(parseClientInstant([], NOW)).toBeNull();
  });

  it('returns null before the minimum instant or after the future skew', () => {
    expect(parseClientInstant(CLIENT_INSTANT_MIN_MS - 1, NOW)).toBeNull();
    expect(parseClientInstant('2009-01-02T23:59:59.999Z', NOW)).toBeNull();
    expect(parseClientInstant(0, NOW)).toBeNull();
    expect(parseClientInstant(NOW + CLIENT_INSTANT_FUTURE_SKEW_MS + 1, NOW)).toBeNull();
  });
});
