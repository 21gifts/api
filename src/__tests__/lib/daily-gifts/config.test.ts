import { describe, it, expect } from 'vitest';
import { parseDailyGiftsConfig } from '@/lib/daily-gifts/config';

const BASE_ENV = {
  LNDHUB_URL: 'https://lightning.space/lndhub/ext',
  LNDHUB_LOGIN: 'user',
  LNDHUB_PASSWORD: 'pass',
  DAILY_GIFTS_RECIPIENTS: JSON.stringify([{ address: 'alice@walletofsatoshi.com', usd: 2 }]),
  DAILY_CAP_USD: '100',
  RATE_MIN_USD: '10000',
  RATE_MAX_USD: '200000',
  DAILY_GIFTS_LOG_PATH: 'log/daily-gifts.jsonl',
};

describe('parseDailyGiftsConfig', () => {
  it('parses a valid config with defaults', () => {
    const result = parseDailyGiftsConfig(BASE_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.hour).toBe(20);
    expect(result.config.timeZone).toBe('Europe/Zurich');
    expect(result.config.recipients).toEqual([{ address: 'alice@walletofsatoshi.com', usd: 2 }]);
    expect(result.config.dailyCapUsd).toBe(100);
  });

  it('accepts fractional usd and custom hour', () => {
    const result = parseDailyGiftsConfig({
      ...BASE_ENV,
      DAILY_GIFTS_RECIPIENTS: JSON.stringify([{ address: 'alice@walletofsatoshi.com', usd: 4.5 }]),
      DAILY_GIFTS_HOUR: '8',
      DAILY_GIFTS_TZ: 'Europe/Zurich',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.recipients[0]?.usd).toBe(4.5);
    expect(result.config.hour).toBe(8);
  });

  it('rejects missing required fields', () => {
    expect(parseDailyGiftsConfig({}).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_RECIPIENTS: undefined }).ok).toBe(
      false,
    );
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_RECIPIENTS: '   ' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, LNDHUB_URL: '' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, LNDHUB_LOGIN: undefined }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, LNDHUB_PASSWORD: '  ' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_LOG_PATH: '' }).ok).toBe(false);
  });

  it('rejects invalid LNDHub URL and rate corridor', () => {
    expect(parseDailyGiftsConfig({ ...BASE_ENV, LNDHUB_URL: 'https://evil.example' }).ok).toBe(
      false,
    );
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        RATE_MIN_USD: '200000',
        RATE_MAX_USD: '10000',
      }).ok,
    ).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_CAP_USD: '0' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, RATE_MIN_USD: 'nope' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, RATE_MAX_USD: '' }).ok).toBe(false);
  });

  it('rejects bad recipients JSON and duplicates', () => {
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_RECIPIENTS: 'not-json' }).ok).toBe(
      false,
    );
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_RECIPIENTS: '[]' }).ok).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([{ address: 'bad', usd: 1 }]),
      }).ok,
    ).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([
          { address: 'alice@walletofsatoshi.com', usd: 1 },
          { address: 'alice@walletofsatoshi.com', usd: 2 },
        ]),
      }).ok,
    ).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([{ address: 'alice@walletofsatoshi.com', usd: 0 }]),
      }).ok,
    ).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([
          { address: 'alice@walletofsatoshi.com', usd: 10001 },
        ]),
      }).ok,
    ).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([null]),
      }).ok,
    ).toBe(false);
    expect(
      parseDailyGiftsConfig({
        ...BASE_ENV,
        DAILY_GIFTS_RECIPIENTS: JSON.stringify([{ address: 1, usd: 'x' }]),
      }).ok,
    ).toBe(false);
  });

  it('rejects invalid hour and timezone', () => {
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_HOUR: '24' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_HOUR: '-1' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_HOUR: '2.5' }).ok).toBe(false);
    expect(parseDailyGiftsConfig({ ...BASE_ENV, DAILY_GIFTS_TZ: 'America/New_York' }).ok).toBe(
      false,
    );
  });
});
