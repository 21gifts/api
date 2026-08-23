import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import type { DailyGiftsConfig } from '@/lib/daily-gifts/config';
import { FileGiftLog, type GiftLogFs } from '@/lib/daily-gifts/log';
import { runDailyGifts } from '@/lib/daily-gifts/worker';
import { WosClient } from '@/lib/wos';
import type { LnurlPayResult } from '@/lib/lnurl-pay';

const ADDRESS = 'alice@walletofsatoshi.com';
const CONFIG: DailyGiftsConfig = {
  apiToken: 'tok',
  apiSecret: 'sec',
  recipients: [{ address: ADDRESS, usd: 1 }],
  dailyCapUsd: 50,
  rateMinUsd: 10_000,
  rateMaxUsd: 200_000,
  logPath: '/tmp/gifts.jsonl',
  hour: 20,
  timeZone: 'Europe/Zurich',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tickerFetch(price = 100_000): FetchFn {
  return async (input) => {
    const url = String(input);
    if (url.includes('kraken.com')) {
      return jsonResponse({ error: [], result: { XXBTZUSD: { c: [price] } } });
    }
    if (url.endsWith('/wallet/balance')) {
      return jsonResponse({ btc: 0.01 });
    }
    if (url.endsWith('/wallet/payment')) {
      return jsonResponse({ status: 'PAID', transactionId: 'hash' });
    }
    return jsonResponse({}, 404);
  };
}

function memoryFs(locked = false): GiftLogFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (locked) files.set('/tmp/gifts.jsonl.lock', '1');
  return {
    files,
    async readFile(path) {
      return files.has(path) ? (files.get(path) ?? '') : null;
    },
    async appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data);
    },
    async mkdirp() {
      return;
    },
    async tryLock(lockPath) {
      if (files.has(lockPath)) return false;
      files.set(lockPath, '1');
      return true;
    },
    async unlock(lockPath) {
      files.delete(lockPath);
    },
  };
}

function client(fetchImpl: FetchFn): WosClient {
  return new WosClient({
    apiToken: CONFIG.apiToken,
    apiSecret: CONFIG.apiSecret,
    fetchImpl,
  });
}

const NOW = Date.UTC(2026, 7, 23, 18, 0, 0);

describe('runDailyGifts', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('aborts when locked', async () => {
    const fs = memoryFs(true);
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(result.aborted).toBe('locked');
  });

  it('aborts on corrupt log', async () => {
    const fs = memoryFs();
    fs.files.set(CONFIG.logPath, '{nope\n');
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(result.aborted).toBe('corrupt_log');
  });

  it('aborts on implausible and unavailable rate', async () => {
    const fs = memoryFs();
    const bad: FetchFn = async () => jsonResponse({ error: [], result: { XXBTZUSD: { c: [1] } } });
    const r1 = await runDailyGifts({
      config: CONFIG,
      client: client(bad),
      fetchImpl: bad,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(r1.aborted).toBe('rate_implausible');

    const fs2 = memoryFs();
    const down: FetchFn = async () => {
      throw new Error('x');
    };
    const r2 = await runDailyGifts({
      config: CONFIG,
      client: client(down),
      fetchImpl: down,
      log: new FileGiftLog({ path: CONFIG.logPath, fs: fs2 }),
      fs: fs2,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(r2.aborted).toBe('rate_unavailable');
  });

  it('aborts when recipient usd exceeds daily cap', async () => {
    const fs = memoryFs();
    const result = await runDailyGifts({
      config: { ...CONFIG, dailyCapUsd: 0.5 },
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(result.aborted).toBe('cap');
  });

  it('pays a matching invoice', async () => {
    const fs = memoryFs();
    const fetchImpl = tickerFetch(100_000);
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () =>
        ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }) satisfies LnurlPayResult,
    });
    expect(result.aborted).toBeUndefined();
    expect(result.paid).toBe(1);
    expect(fs.files.get(CONFIG.logPath) ?? '').toContain('"status":"paid"');
  });

  it('counts LNURL and amount-mismatch failures without logging', async () => {
    const fs = memoryFs();
    const fetchImpl = tickerFetch();
    const r1 = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: false, reason: 'unreachable' }),
    });
    expect(r1.failed).toBe(1);
    expect(fs.files.get(CONFIG.logPath)).toBeUndefined();

    const fs2 = memoryFs();
    const r2 = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs: fs2 }),
      fs: fs2,
      now: () => NOW,
      requestInvoice: async () => ({ ok: true, pr: 'lnbc1u1qqqq', payMsat: 100_000 }),
    });
    expect(r2.failed).toBe(1);
  });

  it('aborts on insufficient balance', async () => {
    const fs = memoryFs();
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('kraken.com')) {
        return jsonResponse({ error: [], result: { XXBTZUSD: { c: [100_000] } } });
      }
      if (url.endsWith('/wallet/balance')) {
        return jsonResponse({ btc: 0.00000001 });
      }
      return jsonResponse({}, 404);
    };
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }),
    });
    expect(result.aborted).toBe('insufficient_balance');
  });

  it('logs failed and uncertain pay outcomes', async () => {
    const fs = memoryFs();
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('kraken.com')) {
        return jsonResponse({ error: [], result: { XXBTZUSD: { c: [100_000] } } });
      }
      if (url.endsWith('/wallet/balance')) {
        return jsonResponse({ btc: 0.01 });
      }
      return jsonResponse({ message: 'Invalid invoice' }, 400);
    };
    const failed = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }),
    });
    expect(failed.failed).toBe(1);

    const fs2 = memoryFs();
    const uncertainFetch: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('kraken.com')) {
        return jsonResponse({ error: [], result: { XXBTZUSD: { c: [100_000] } } });
      }
      if (url.endsWith('/wallet/balance')) {
        return jsonResponse({ btc: 0.01 });
      }
      return jsonResponse({ status: 'PENDING', transactionId: 'h' });
    };
    const uncertain = await runDailyGifts({
      config: CONFIG,
      client: client(uncertainFetch),
      fetchImpl: uncertainFetch,
      log: new FileGiftLog({ path: CONFIG.logPath, fs: fs2 }),
      fs: fs2,
      now: () => NOW,
      requestInvoice: async () => ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }),
    });
    expect(uncertain.uncertain).toBe(1);
  });

  it('stops at the Zurich date boundary', async () => {
    const fs = memoryFs();
    let calls = 0;
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => {
        calls += 1;
        return calls === 1 ? NOW : Date.UTC(2026, 7, 24, 22, 0, 0);
      },
      requestInvoice: async () => ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }),
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it('logs non-positive sats as failed', async () => {
    const fs = memoryFs();
    const result = await runDailyGifts({
      config: { ...CONFIG, recipients: [{ address: ADDRESS, usd: 1e-10 }] },
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => {
        throw new Error('no');
      },
    });
    expect(result.failed).toBe(1);
    expect(fs.files.get(CONFIG.logPath) ?? '').toContain('non_positive_sats');
  });

  it('records uncertain without a payment hash', async () => {
    const fs = memoryFs();
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('kraken.com')) {
        return jsonResponse({ error: [], result: { XXBTZUSD: { c: [100_000] } } });
      }
      if (url.endsWith('/wallet/balance')) {
        return jsonResponse({ btc: 0.01 });
      }
      return jsonResponse({ status: 'PENDING' });
    };
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(fetchImpl),
      fetchImpl,
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => ({ ok: true, pr: 'lnbc10u1qqqq', payMsat: 1_000_000 }),
    });
    expect(result.uncertain).toBe(1);
    expect(fs.files.get(CONFIG.logPath) ?? '').not.toContain('payment_hash');
  });

  it('skips already paid recipients', async () => {
    const fs = memoryFs();
    const line = JSON.stringify({
      date: '2026-08-23',
      address: ADDRESS,
      usd: 1,
      sats: 1000,
      rate_usd_per_btc: 100000,
      status: 'paid',
      timestamp: '2026-08-23T18:00:00.000Z',
    });
    fs.files.set(CONFIG.logPath, `${line}\n`);
    const result = await runDailyGifts({
      config: CONFIG,
      client: client(tickerFetch()),
      fetchImpl: tickerFetch(),
      log: new FileGiftLog({ path: CONFIG.logPath, fs }),
      fs,
      now: () => NOW,
      requestInvoice: async () => {
        throw new Error('should not request');
      },
    });
    expect(result.paid).toBe(1);
    expect(result.aborted).toBeUndefined();
  });
});
