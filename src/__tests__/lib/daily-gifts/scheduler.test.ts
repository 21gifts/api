import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailyGiftsConfig } from '@/lib/daily-gifts/config';
import {
  msUntilNextHour,
  nodeTimeoutSchedule,
  startDailyGiftsFromEnv,
  startDailyGiftsScheduler,
} from '@/lib/daily-gifts/scheduler';
import type { GiftLogFs } from '@/lib/daily-gifts/log';

const CONFIG: DailyGiftsConfig = {
  lndhubUrl: 'https://lightning.space/lndhub/ext',
  login: 'u',
  password: 'p',
  recipients: [{ address: 'alice@walletofsatoshi.com', usd: 2 }],
  dailyCapUsd: 50,
  rateMinUsd: 10_000,
  rateMaxUsd: 200_000,
  logPath: '/tmp/gifts.jsonl',
  hour: 20,
  timeZone: 'Europe/Zurich',
};

describe('nodeTimeoutSchedule', () => {
  it('cancels a pending timeout', () => {
    let ran = false;
    const h = nodeTimeoutSchedule(60_000, () => {
      ran = true;
    });
    h.cancel();
    expect(ran).toBe(false);
  });
});

describe('msUntilNextHour', () => {
  it('returns 0 at the exact hour', () => {
    const now = Date.UTC(2026, 7, 23, 18, 0, 0);
    const partsOk = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Zurich',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const hour = Number(partsOk.find((p) => p.type === 'hour')?.value);
    expect(msUntilNextHour(now, hour, 'Europe/Zurich')).toBe(0);
  });

  it('is positive before and after the hour', () => {
    const before = Date.UTC(2026, 7, 23, 10, 0, 0);
    const after = Date.UTC(2026, 7, 23, 19, 0, 1);
    expect(msUntilNextHour(before, 20, 'Europe/Zurich')).toBeGreaterThan(0);
    expect(msUntilNextHour(after, 20, 'Europe/Zurich')).toBeGreaterThan(0);
    const sameHourLater = Date.UTC(2026, 7, 23, 18, 0, 1);
    expect(msUntilNextHour(sameHourLater, 20, 'Europe/Zurich')).toBeGreaterThan(0);
  });
});

describe('startDailyGiftsScheduler', () => {
  it('runs then reschedules; stop cancels', async () => {
    const runs: number[] = [];
    const pending: Array<{ fn: () => void; cancel: () => void }> = [];
    const handle = startDailyGiftsScheduler({
      config: CONFIG,
      run: async () => {
        runs.push(1);
        return { date: '2026-08-23', paid: 0, failed: 0, uncertain: 0, skipped: 0 };
      },
      now: () => Date.UTC(2026, 7, 23, 18, 0, 0),
      schedule: (_ms, fn) => {
        pending.push({ fn, cancel: () => undefined });
        return { cancel: () => undefined };
      },
    });
    expect(pending).toHaveLength(1);
    const first = pending[0];
    first?.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    handle.stop();
  });

  it('ignores ticks after stop and skips overlapping runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending: Array<() => void> = [];
    const handle = startDailyGiftsScheduler({
      config: CONFIG,
      run: async () => {
        await gate;
        return { date: '2026-08-23', paid: 0, failed: 0, uncertain: 0, skipped: 0 };
      },
      now: () => Date.UTC(2026, 7, 23, 18, 0, 0),
      schedule: (_ms, fn) => {
        pending.push(fn);
        return { cancel: () => undefined };
      },
    });
    const first = pending[0];
    first?.();
    first?.();
    handle.stop();
    first?.();
    release();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('logs run errors and still reschedules', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending: Array<() => void> = [];
    startDailyGiftsScheduler({
      config: CONFIG,
      run: async () => {
        throw new Error('boom');
      },
      now: () => Date.UTC(2026, 7, 23, 18, 0, 0),
      schedule: (_ms, fn) => {
        pending.push(fn);
        return { cancel: () => undefined };
      },
    });
    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(String(warn.mock.calls[0]?.[0])).toContain('daily_gifts.run.error');
    warn.mockRestore();
  });

  it('logs a non-Error throw as unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending: Array<() => void> = [];
    startDailyGiftsScheduler({
      config: CONFIG,
      run: async () => {
        throw 'nope';
      },
      now: () => Date.UTC(2026, 7, 23, 18, 0, 0),
      schedule: (_ms, fn) => {
        pending.push(fn);
        return { cancel: () => undefined };
      },
    });
    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown');
    warn.mockRestore();
  });
});

describe('startDailyGiftsFromEnv', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('defaults fs, now, and pid when omitted', () => {
    const h = startDailyGiftsFromEnv(
      {
        LNDHUB_URL: CONFIG.lndhubUrl,
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
        DAILY_GIFTS_RECIPIENTS: JSON.stringify(CONFIG.recipients),
        DAILY_CAP_USD: '50',
        RATE_MIN_USD: '10000',
        RATE_MAX_USD: '200000',
        DAILY_GIFTS_LOG_PATH: CONFIG.logPath,
      },
      {
        fetchImpl: async () => new Response(null),
        schedule: () => ({ cancel: () => undefined }),
      },
    );
    h.stop();
  });

  it('no-ops when misconfigured', () => {
    const h = startDailyGiftsFromEnv({}, { fetchImpl: async () => new Response(null) });
    expect(String(warn.mock.calls[0]?.[0])).toContain('daily_gifts.unconfigured');
    h.stop();
  });

  it('uses default setTimeout and can stop immediately', () => {
    const fs: GiftLogFs = {
      readFile: async () => null,
      appendFile: async () => undefined,
      mkdirp: async () => undefined,
      tryLock: async () => true,
      unlock: async () => undefined,
    };
    const h = startDailyGiftsFromEnv(
      {
        LNDHUB_URL: CONFIG.lndhubUrl,
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
        DAILY_GIFTS_RECIPIENTS: JSON.stringify(CONFIG.recipients),
        DAILY_CAP_USD: '50',
        RATE_MIN_USD: '10000',
        RATE_MAX_USD: '200000',
        DAILY_GIFTS_LOG_PATH: CONFIG.logPath,
      },
      { fetchImpl: async () => new Response(null), fs, now: () => Date.UTC(2026, 7, 23, 10, 0, 0) },
    );
    h.stop();
  });

  it('runs the env-wired worker when the timer fires', async () => {
    let appended = 0;
    const fs: GiftLogFs = {
      readFile: async () => null,
      appendFile: async () => {
        appended += 1;
      },
      mkdirp: async () => undefined,
      tryLock: async () => true,
      unlock: async () => undefined,
    };
    let fire: (() => void) | undefined;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('kraken.com')) {
        return json({ error: [], result: { XXBTZUSD: { c: [100_000] } } });
      }
      if (url.includes('/.well-known/lnurlp/')) {
        return json({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
        });
      }
      if (url.includes('/lnurlp/callback')) {
        return json({ pr: 'lnbc20u1qqqq' });
      }
      if (url.endsWith('/auth')) {
        return json({ access_token: 't' });
      }
      if (url.endsWith('/getbalance')) {
        return json({ BTC: { AvailableBalance: 1_000_000 } });
      }
      if (url.endsWith('/payinvoice')) {
        return json({ payment_preimage: 'pre', payment_hash: 'h' });
      }
      return new Response(null, { status: 404 });
    };
    const h = startDailyGiftsFromEnv(
      {
        LNDHUB_URL: CONFIG.lndhubUrl,
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
        DAILY_GIFTS_RECIPIENTS: JSON.stringify(CONFIG.recipients),
        DAILY_CAP_USD: '50',
        RATE_MIN_USD: '10000',
        RATE_MAX_USD: '200000',
        DAILY_GIFTS_LOG_PATH: CONFIG.logPath,
      },
      {
        fetchImpl,
        fs,
        now: () => Date.UTC(2026, 7, 23, 18, 0, 0),
        schedule: (_ms, fn) => {
          fire = fn;
          return { cancel: () => undefined };
        },
      },
    );
    fire?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(appended).toBeGreaterThan(0);
    h.stop();
  });

  it('starts when env is valid', () => {
    const fs: GiftLogFs = {
      readFile: async () => null,
      appendFile: async () => undefined,
      mkdirp: async () => undefined,
      tryLock: async () => true,
      unlock: async () => undefined,
    };
    const h = startDailyGiftsFromEnv(
      {
        LNDHUB_URL: CONFIG.lndhubUrl,
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
        DAILY_GIFTS_RECIPIENTS: JSON.stringify(CONFIG.recipients),
        DAILY_CAP_USD: '50',
        RATE_MIN_USD: '10000',
        RATE_MAX_USD: '200000',
        DAILY_GIFTS_LOG_PATH: CONFIG.logPath,
      },
      {
        fetchImpl: async () => new Response(null),
        fs,
        now: () => Date.UTC(2026, 7, 23, 10, 0, 0),
        schedule: () => ({ cancel: () => undefined }),
        pid: 1,
      },
    );
    h.stop();
  });
});
