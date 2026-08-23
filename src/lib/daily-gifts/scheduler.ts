import type { FetchFn } from '@/lib/btc-usd-rate';
import type { DailyGiftsConfig } from '@/lib/daily-gifts/config';
import { parseDailyGiftsConfig } from '@/lib/daily-gifts/config';
import type { GiftLogFs } from '@/lib/daily-gifts/log';
import { FileGiftLog, nodeGiftLogFs } from '@/lib/daily-gifts/log';
import type { WorkerRunResult } from '@/lib/daily-gifts/worker';
import { runDailyGifts } from '@/lib/daily-gifts/worker';
import { LndhubClient } from '@/lib/lndhub';
import { requestAmountInvoice } from '@/lib/lnurl-pay';
import { logEvent } from '@/lib/log';

/**
 * `setTimeout` adapter used by production {@link startDailyGiftsFromEnv}.
 *
 * @param ms - Delay in milliseconds.
 * @param fn - Callback to run.
 * @returns A handle whose `cancel` clears the timeout.
 */
export function nodeTimeoutSchedule(ms: number, fn: () => void): { cancel: () => void } {
  const t = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(t) };
}

/**
 * Milliseconds until the next `hour:00:00.000` in `timeZone`.
 *
 * DST-safe via `Intl.DateTimeFormat` `formatToParts`. The exact target
 * instant returns `0`; any later time within that local day schedules
 * tomorrow's occurrence.
 *
 * @param nowMs - Current epoch milliseconds.
 * @param hour - Local hour 0–23.
 * @param timeZone - IANA time zone (Europe/Zurich in production).
 * @returns Non-negative delay in milliseconds.
 */
export function msUntilNextHour(nowMs: number, hour: number, timeZone: string): number {
  const partsNow = zonedParts(nowMs, timeZone);
  if (partsNow.hour === hour && partsNow.minute === 0 && partsNow.second === 0) {
    return 0;
  }

  let year = partsNow.year;
  let month = partsNow.month;
  let day = partsNow.day;
  const afterTarget =
    partsNow.hour > hour ||
    (partsNow.hour === hour && (partsNow.minute > 0 || partsNow.second > 0));
  if (afterTarget) {
    const next = nextCalendarDay(year, month, day);
    year = next.year;
    month = next.month;
    day = next.day;
  }

  const targetMs = zonedLocalToUtcMs(year, month, day, hour, 0, 0, timeZone);
  const delta = targetMs - nowMs;
  /* v8 ignore next — DST/clock skew can theoretically undershoot */
  return delta < 0 ? 0 : delta;
}

/**
 * Start the in-process daily-gifts timer loop.
 *
 * Waits until the configured Zurich hour, runs once, then reschedules.
 * Overlapping runs are skipped in memory. Run errors are logged and the
 * loop continues. `stop()` cancels the pending timeout.
 *
 * @param args - Config, run callback, clock, and schedule handle factory.
 * @returns A handle with `stop()`.
 */
export function startDailyGiftsScheduler(args: {
  config: DailyGiftsConfig;
  run: () => Promise<WorkerRunResult>;
  now: () => number;
  schedule: (ms: number, fn: () => void) => { cancel: () => void };
}): { stop: () => void } {
  let stopped = false;
  let running = false;
  let handle: { cancel: () => void } | null = null;

  const scheduleNext = (): void => {
    if (stopped) {
      return;
    }
    const delay = msUntilNextHour(args.now(), args.config.hour, args.config.timeZone);
    handle = args.schedule(delay, () => {
      void tick();
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    if (running) {
      scheduleNext();
      return;
    }
    running = true;
    try {
      await args.run();
    } catch (err) {
      logEvent('daily_gifts.run.error', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      running = false;
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (handle !== null) {
        handle.cancel();
        handle = null;
      }
    },
  };
}

/**
 * Parse env and start the daily-gifts scheduler, or no-op when misconfigured.
 *
 * Production omits `fs` / `now` / `schedule` (defaults: {@link nodeGiftLogFs},
 * `Date.now`, `setTimeout`). Parse failure emits `daily_gifts.unconfigured`
 * and returns a no-op `stop`.
 *
 * @param env - Environment slice.
 * @param deps - Fetch plus optional test doubles.
 * @returns A handle with `stop()`.
 */
export function startDailyGiftsFromEnv(
  env: Record<string, string | undefined>,
  deps: {
    fetchImpl: FetchFn;
    fs?: GiftLogFs;
    now?: () => number;
    schedule?: (ms: number, fn: () => void) => { cancel: () => void };
    pid?: number;
  },
): { stop: () => void } {
  const parsed = parseDailyGiftsConfig(env);
  if (!parsed.ok) {
    logEvent('daily_gifts.unconfigured', { reason: parsed.reason });
    return { stop: () => undefined };
  }
  const config = parsed.config;
  const fetchImpl = deps.fetchImpl;
  const baseFs = deps.fs ?? nodeGiftLogFs();
  const pid = deps.pid ?? process.pid;
  const fs: GiftLogFs = {
    readFile: (path) => baseFs.readFile(path),
    appendFile: (path, data) => baseFs.appendFile(path, data),
    mkdirp: (dir) => baseFs.mkdirp(dir),
    tryLock: (lockPath, _pid) => baseFs.tryLock(lockPath, pid),
    unlock: (lockPath) => baseFs.unlock(lockPath),
  };
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? nodeTimeoutSchedule;

  const client = new LndhubClient({
    baseUrl: config.lndhubUrl,
    login: config.login,
    password: config.password,
    fetchImpl,
  });
  const log = new FileGiftLog({ path: config.logPath, fs });

  return startDailyGiftsScheduler({
    config,
    run: () =>
      runDailyGifts({
        config,
        client,
        fetchImpl,
        log,
        fs,
        now,
        requestInvoice: requestAmountInvoice,
      }),
    now,
    schedule,
  });
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    /* v8 ignore next — formatToParts always includes these types */
    return found?.value ?? '0';
  };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

function nextCalendarDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/**
 * Map a civil local datetime in `timeZone` to a UTC epoch ms (DST-safe).
 */
function zonedLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = targetAsUtc - asUtc;
    if (diff === 0) {
      break;
    }
    guess += diff;
  }
  return guess;
}
