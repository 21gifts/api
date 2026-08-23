import { dirname } from 'node:path';
import { decodeBolt11AmountSats } from '@/lib/bolt11-amount';
import { fetchKrakenXbtUsd, usdToSats } from '@/lib/btc-usd-rate';
import type { FetchFn } from '@/lib/btc-usd-rate';
import type { DailyGiftsConfig } from '@/lib/daily-gifts/config';
import type { FileGiftLog, GiftLogEntry, GiftLogFs } from '@/lib/daily-gifts/log';
import { replayDay, zurichDate } from '@/lib/daily-gifts/log';
import type { LndhubClient } from '@/lib/lndhub';
import type { LnurlPayResult } from '@/lib/lnurl-pay';
import { logEvent } from '@/lib/log';

/** Injected collaborators for {@link runDailyGifts}. */
export type WorkerDeps = {
  config: DailyGiftsConfig;
  client: LndhubClient;
  fetchImpl: FetchFn;
  log: FileGiftLog;
  fs: GiftLogFs;
  now: () => number;
  requestInvoice: (args: {
    address: string;
    amountMsat: number;
    fetchImpl: FetchFn;
    comment?: string;
  }) => Promise<LnurlPayResult>;
};

/** Aggregate outcome of one daily-gifts run. */
export type WorkerRunResult = {
  date: string;
  paid: number;
  failed: number;
  uncertain: number;
  skipped: number;
  aborted?: string;
};

/**
 * Run one fail-closed daily gifts payout cycle.
 *
 * Acquires the log lock, loads the idempotency log, fetches the Kraken rate,
 * enforces the USD cap and balance preflight (remaining sats + 1% fee
 * headroom), then sequentially resolves, amount-checks, and pays each
 * remaining recipient. Stops at Zurich midnight without logging unattempted
 * rows. Unlocks in `finally`.
 *
 * @param deps - Config, LNDHub client, log, clock, and invoice helper.
 * @returns Per-day counts and optional abort reason.
 */
export async function runDailyGifts(deps: WorkerDeps): Promise<WorkerRunResult> {
  const { config, client, fetchImpl, log, fs, now, requestInvoice } = deps;
  const date = zurichDate(now());
  const result: WorkerRunResult = {
    date,
    paid: 0,
    failed: 0,
    uncertain: 0,
    skipped: 0,
  };

  await fs.mkdirp(dirname(config.logPath));
  const lockPath = `${config.logPath}.lock`;
  const locked = await fs.tryLock(lockPath, process.pid);
  if (!locked) {
    result.aborted = 'locked';
    logEvent('daily_gifts.abort', { reason: 'locked', date });
    return result;
  }

  try {
    const loaded = await log.load();
    if (!loaded.ok) {
      result.aborted = 'corrupt_log';
      logEvent('daily_gifts.abort', { reason: 'corrupt_log', date });
      return result;
    }
    let entries = loaded.entries;

    const rate = await fetchKrakenXbtUsd({
      fetchImpl,
      minUsd: config.rateMinUsd,
      maxUsd: config.rateMaxUsd,
    });
    if (!rate.ok) {
      result.aborted = rate.reason === 'implausible' ? 'rate_implausible' : 'rate_unavailable';
      logEvent('daily_gifts.abort', { reason: result.aborted, date });
      return result;
    }
    const usdPerBtc = rate.usdPerBtc;

    const totalUsd = config.recipients.reduce((sum, r) => sum + r.usd, 0);
    if (totalUsd > config.dailyCapUsd) {
      result.aborted = 'cap';
      logEvent('daily_gifts.abort', { reason: 'cap', date });
      return result;
    }

    const remaining = config.recipients.filter(
      (r) => replayDay(entries, date, r.address) === 'clear',
    );

    type PayTarget = { address: string; usd: number; sats: number };
    const toPay: PayTarget[] = [];
    for (const r of remaining) {
      const sats = usdToSats(r.usd, usdPerBtc);
      if (sats < 1) {
        const entry: GiftLogEntry = {
          date,
          address: r.address,
          usd: r.usd,
          sats,
          rate_usd_per_btc: usdPerBtc,
          status: 'failed',
          timestamp: new Date(now()).toISOString(),
          error: 'non_positive_sats',
        };
        await log.append(entry);
        entries = [...entries, entry];
        result.failed += 1;
        continue;
      }
      toPay.push({ address: r.address, usd: r.usd, sats });
    }

    if (toPay.length > 0) {
      const need = Math.ceil(toPay.reduce((sum, t) => sum + t.sats, 0) * 1.01);
      const balance = await client.getBalanceSats();
      if (!balance.ok || balance.sats < need) {
        result.aborted = 'insufficient_balance';
        logEvent('daily_gifts.abort', { reason: 'insufficient_balance', date });
        recount(result, entries, date, config);
        return result;
      }
    }

    for (let i = 0; i < toPay.length; i++) {
      const target = toPay[i];
      /* v8 ignore next 3 — noUncheckedIndexedAccess; toPay[i] is defined in-range */
      if (target === undefined) {
        continue;
      }
      if (zurichDate(now()) !== date) {
        result.failed += toPay.length - i;
        break;
      }

      const invoice = await requestInvoice({
        address: target.address,
        amountMsat: target.sats * 1000,
        fetchImpl,
      });
      if (!invoice.ok) {
        result.failed += 1;
        continue;
      }

      const decoded = decodeBolt11AmountSats(invoice.pr);
      if (!decoded.ok || decoded.sats !== target.sats) {
        result.failed += 1;
        continue;
      }

      const sending: GiftLogEntry = {
        date,
        address: target.address,
        usd: target.usd,
        sats: target.sats,
        rate_usd_per_btc: usdPerBtc,
        status: 'sending',
        timestamp: new Date(now()).toISOString(),
      };
      await log.append(sending);
      entries = [...entries, sending];

      const pay = await client.payInvoice(invoice.pr);
      if (pay.status === 'paid') {
        const paidEntry: GiftLogEntry = {
          date,
          address: target.address,
          usd: target.usd,
          sats: target.sats,
          rate_usd_per_btc: usdPerBtc,
          status: 'paid',
          timestamp: new Date(now()).toISOString(),
          payment_hash: pay.paymentHash,
          preimage: pay.preimage,
        };
        await log.append(paidEntry);
        entries = [...entries, paidEntry];
        logEvent('daily_gifts.pay', {
          date,
          address: target.address,
          status: 'paid',
          sats: target.sats,
        });
      } else if (pay.status === 'failed') {
        const failedEntry: GiftLogEntry = {
          date,
          address: target.address,
          usd: target.usd,
          sats: target.sats,
          rate_usd_per_btc: usdPerBtc,
          status: 'failed',
          timestamp: new Date(now()).toISOString(),
          error: pay.reason,
        };
        await log.append(failedEntry);
        entries = [...entries, failedEntry];
        result.failed += 1;
        logEvent('daily_gifts.pay', {
          date,
          address: target.address,
          status: 'failed',
          sats: target.sats,
        });
      } else {
        const uncertainEntry: GiftLogEntry = {
          date,
          address: target.address,
          usd: target.usd,
          sats: target.sats,
          rate_usd_per_btc: usdPerBtc,
          status: 'uncertain',
          timestamp: new Date(now()).toISOString(),
          error: pay.reason,
          ...(pay.paymentHash !== undefined && pay.paymentHash !== ''
            ? { payment_hash: pay.paymentHash }
            : {}),
        };
        await log.append(uncertainEntry);
        entries = [...entries, uncertainEntry];
        logEvent('daily_gifts.pay', {
          date,
          address: target.address,
          status: 'uncertain',
          sats: target.sats,
        });
      }
    }

    recount(result, entries, date, config);
    return result;
  } finally {
    await fs.unlock(lockPath);
  }
}

function recount(
  result: WorkerRunResult,
  entries: GiftLogEntry[],
  date: string,
  config: DailyGiftsConfig,
): void {
  let paid = 0;
  let uncertain = 0;
  for (const r of config.recipients) {
    const state = replayDay(entries, date, r.address);
    if (state === 'paid') {
      paid += 1;
    } else if (state === 'uncertain') {
      uncertain += 1;
    }
  }
  result.paid = paid;
  result.uncertain = uncertain;
}
