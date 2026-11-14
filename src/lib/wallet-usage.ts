/**
 * Public wallet-usage aggregates for `GET /wallets/usage`.
 * No account, payment, or invoice identifier leaves this module.
 */

import { utcDayKey } from '@/lib/funding';
import { addUtcDays } from '@/lib/member-habit';

/** Production release of the in-app wallet, 2026-11-09 11:17 UTC. */
export const WALLET_RELEASE_AT_MS = Date.parse('2026-11-09T11:17:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;
const FORUM_LOOKBACK_DAYS = 28;
const SHOP_LOOKBACK_DAYS = 14;

/**
 * Who a payment side is.
 * `platform` is `account.is_platform`. `fund` is role `fond`.
 * Every other account, including a shop, is `members`. No account is `outside`.
 */
export type WalletUsageParty = 'outside' | 'members' | 'fund' | 'platform';

/** Why a completed payment moved, first match of {@link walletUsagePurpose}. */
export type WalletUsagePurpose =
  | 'deposit'
  | 'withdrawal'
  | 'shop_purchase'
  | 'forum_gift'
  | 'transfer'
  | 'fund_deposit'
  | 'fund_payout'
  | 'other';

/** One completed payment, both wallet sides already merged. */
export interface WalletUsagePaymentRow {
  /** Earliest `paid_at` of the payment's rows. */
  paidAt: Date;
  /** Greatest `amount_sats` of the payment's rows. */
  amountSats: number;
  /** Sum of `fee_sats` of the payment's rows. A missing fee counts as 0. */
  feeSats: number;
  /**
   * Category of the outgoing row when that category is not `unknown`,
   * otherwise any non-`unknown` category, otherwise `unknown`.
   */
  category: string;
  /** Account of the outgoing row, or null when the payer is outside. */
  payerAccountId: string | null;
  /**
   * Account of the incoming row, otherwise the outgoing row's
   * `counterparty_account_id`, otherwise null.
   */
  payeeAccountId: string | null;
  /** Party of {@link WalletUsagePaymentRow.payerAccountId}. */
  payerParty: WalletUsageParty;
  /** Party of {@link WalletUsagePaymentRow.payeeAccountId}. */
  payeeParty: WalletUsageParty;
  /**
   * True when any row's invoice equals `bolt11` or `spark_invoice` of a
   * `fond_payout` whose status is `paid`.
   */
  isFundPayout: boolean;
  /**
   * True when the payment is a paid forum gift or paid heart: one of its
   * candidate hashes (its `payment_hash`, or the `spark_invoice.payment_hash`
   * whose `invoice` equals the row's `invoice` or `destination`) or its
   * invoice matches a `message_invoice` with
   * `result = 'ok'`, no conversation, no `repay:` / `repayp:` description, a
   * claimed `nostr_zap_payment` hash, and a note whose `deleted_at` is null;
   * or a zap receipt gift or paid heart on such a note. A non-heart invoice on
   * a note authored by the platform account is the compose fee and does not
   * qualify; a heart on that note still does.
   */
  isForumGift: boolean;
}

/**
 * One successful forum invoice (`message_invoice.result = 'ok'`) in the forum
 * series. A non-heart invoice on a platform-authored note is the compose fee
 * and is not included.
 */
export interface WalletUsageForumRow {
  /** When the invoice row was stored. */
  createdAt: Date;
  /** Invoice amount in whole sats. */
  amountSats: number;
  /** True for a heart. A null column counts as false. */
  heart: boolean;
}

/** One point-of-sale charge. */
export interface WalletUsageChargeRow {
  /** When the charge was created. */
  createdAt: Date;
  /** Stored status, including `paid`. */
  status: string;
}

/** Rows {@link buildWalletUsage} turns into the public body. */
export interface WalletUsageInput {
  /** Completed payments. */
  payments: readonly WalletUsagePaymentRow[];
  /** Successful forum invoices. */
  forumInvoices: readonly WalletUsageForumRow[];
  /** Point-of-sale charges. */
  shopCharges: readonly WalletUsageChargeRow[];
}

/** Count and sat sum for one purpose. Zeros are present. */
export interface WalletUsagePurposeTotals {
  /** Payments of this purpose. */
  count: number;
  /** Sum of their `amountSats`. */
  sats: number;
}

/** Inclusive sat range. `maxSats` is null for the open top bucket. */
export interface WalletUsageBucket {
  /** Stable key, in ascending range order. */
  key: '1' | '2-10' | '11-100' | '101-1k' | '1k-10k' | '10k-100k' | '100k+';
  /** Lowest amount in the bucket, in whole sats. */
  minSats: number;
  /** Highest amount in the bucket, or null when the bucket is open. */
  maxSats: number | null;
  /** Payments in the bucket. */
  count: number;
  /** Sum of their `amountSats`. */
  sats: number;
}

/** One observed direction of value on one UTC day. */
export interface WalletUsageFlow {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  /** Payer party. */
  from: WalletUsageParty;
  /** Payee party. */
  to: WalletUsageParty;
  /** Classified purpose. */
  purpose: WalletUsagePurpose;
  /** Payments in this cell. */
  count: number;
  /** Sum of their `amountSats`. */
  sats: number;
  /** Sum of their `feeSats`. */
  feeSats: number;
}

/** Public `GET /wallets/usage` body. Aggregates only. */
export interface WalletUsage {
  /** ISO instant of {@link WALLET_RELEASE_AT_MS}. */
  releasedAt: string;
  /** ISO instant of the newest counted payment, or null when none. */
  asOf: string | null;
  /**
   * Payment totals and `heartCount` start at release. `paidShopChargeCount` is
   * the sum of the published daily `shopCharges[].paid` cells over the whole
   * shop window, from `2026-10-26 11:17 UTC`.
   */
  totals: {
    /** Counted payments. */
    paymentCount: number;
    /** Sum of counted `amountSats`. */
    volumeSats: number;
    /** Sum of counted `feeSats`. */
    feeSats: number;
    /**
     * Median `amountSats`. An even count is the mean of the two middle
     * values, rounded down. 0 when there is no payment.
     */
    medianSats: number;
    /** `Math.round(volumeSats / paymentCount)`, or 0 when there is no payment. */
    averageSats: number;
    /** Distinct member or fund accounts that paid or were paid. */
    activeWalletCount: number;
    /** Distinct member or fund accounts that paid. */
    sendingWalletCount: number;
    /** Distinct member or fund accounts that were paid. */
    receivingWalletCount: number;
    /**
     * Share of `volumeSats` held by the five sending wallets with the highest
     * summed `amountSats`, from 0 to 1, four decimal places. A sending wallet
     * is a member or fund payer, so the platform account and outside payers
     * are not ranked. 0 when `volumeSats` is 0.
     */
    topFiveSenderShare: number;
    /** Hearts with `createdAt` on or after release. */
    heartCount: number;
    /**
     * Sum of the published daily `shopCharges[].paid` cells over the whole
     * shop window, from `2026-10-26 11:17 UTC`, including days before release.
     */
    paidShopChargeCount: number;
  };
  /** Gap-free UTC days from the release day through today. */
  days: Array<{
    /** `YYYY-MM-DD` in UTC. */
    day: string;
    /** Every purpose, including zeros. */
    purposes: Record<WalletUsagePurpose, WalletUsagePurposeTotals>;
    /** Distinct member or fund accounts that paid or were paid this day. */
    activeWalletCount: number;
    /** Distinct member or fund accounts that paid this day. */
    sendingWalletCount: number;
    /** Distinct member or fund accounts that were paid this day. */
    receivingWalletCount: number;
  }>;
  /** Non-empty `(day, from, to, purpose)` cells, sorted by those fields. */
  flows: WalletUsageFlow[];
  /** All seven amount buckets, in ascending order. */
  amountBuckets: WalletUsageBucket[];
  /** All 24 UTC hours, 0 through 23. */
  hours: Array<{ hourUtc: number; count: number }>;
  /** Gap-free UTC days from 28 days before release through today. */
  forum: Array<{ day: string; gifts: number; hearts: number; sats: number }>;
  /** Gap-free UTC days from 14 days before release through today. */
  shopCharges: Array<{ day: string; created: number; paid: number }>;
}

/** Store read instants for {@link buildWalletUsage}. */
export interface WalletUsageReadSince {
  /** Completed payments from the release instant. */
  payments: number;
  /** Forum invoices from 28 days before release. */
  forumInvoices: number;
  /** Shop charges from 14 days before release. */
  shopCharges: number;
}

const PURPOSES: readonly WalletUsagePurpose[] = [
  'deposit',
  'withdrawal',
  'shop_purchase',
  'forum_gift',
  'transfer',
  'fund_deposit',
  'fund_payout',
  'other',
];

const BUCKETS: readonly WalletUsageBucket[] = [
  { key: '1', minSats: 1, maxSats: 1, count: 0, sats: 0 },
  { key: '2-10', minSats: 2, maxSats: 10, count: 0, sats: 0 },
  { key: '11-100', minSats: 11, maxSats: 100, count: 0, sats: 0 },
  { key: '101-1k', minSats: 101, maxSats: 1000, count: 0, sats: 0 },
  { key: '1k-10k', minSats: 1001, maxSats: 10000, count: 0, sats: 0 },
  { key: '10k-100k', minSats: 10001, maxSats: 100000, count: 0, sats: 0 },
  { key: '100k+', minSats: 100001, maxSats: null, count: 0, sats: 0 },
];

/**
 * Instants the usage route passes to the store.
 *
 * Payments start at {@link WALLET_RELEASE_AT_MS}. Forum invoices start 28 days
 * earlier and shop charges 14 days earlier, so the public series can show the
 * run-up to release.
 *
 * @returns Epoch milliseconds for the three reads.
 */
export function walletUsageReadSince(): WalletUsageReadSince {
  return {
    payments: WALLET_RELEASE_AT_MS,
    forumInvoices: WALLET_RELEASE_AT_MS - FORUM_LOOKBACK_DAYS * DAY_MS,
    shopCharges: WALLET_RELEASE_AT_MS - SHOP_LOOKBACK_DAYS * DAY_MS,
  };
}

/**
 * Classify one merged payment. First match wins.
 *
 * `forum_gift` is only a paid forum gift or paid heart ({@link
 * WalletUsagePaymentRow.isForumGift}). A stored `gift` or `platform` category
 * that is not a forum gift is `transfer` when both parties are `members`,
 * otherwise `other`.
 *
 * @param row - Merged payment. Account ids are not read.
 * @returns The purpose used in the public totals, days, and flows.
 */
export function walletUsagePurpose(row: WalletUsagePaymentRow): WalletUsagePurpose {
  if (row.isFundPayout) {
    return 'fund_payout';
  }
  if (row.payeeParty === 'fund' && row.payerParty !== 'outside') {
    return 'fund_deposit';
  }
  if (row.isForumGift) {
    return 'forum_gift';
  }
  if (row.category === 'shop') {
    return 'shop_purchase';
  }
  if (row.category === 'member') {
    return 'transfer';
  }
  if (row.category === 'gift' || row.category === 'platform') {
    return row.payerParty === 'members' && row.payeeParty === 'members' ? 'transfer' : 'other';
  }
  if (row.category === 'outside_lightning' || row.category === 'onchain') {
    return row.payerParty === 'outside' ? 'deposit' : 'withdrawal';
  }
  return 'other';
}

function asSats(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
  }
  return BigInt(value);
}

function safeSatsTotal(total: bigint): number {
  const value = Number(total);
  if (!Number.isSafeInteger(value)) {
    throw new Error('wallet sats total exceeds Number.MAX_SAFE_INTEGER');
  }
  return value;
}

function emptyPurposes(): Record<WalletUsagePurpose, WalletUsagePurposeTotals> {
  const purposes = {} as Record<WalletUsagePurpose, WalletUsagePurposeTotals>;
  for (const purpose of PURPOSES) {
    purposes[purpose] = { count: 0, sats: 0 };
  }
  return purposes;
}

function emptyBuckets(): WalletUsageBucket[] {
  return BUCKETS.map((bucket) => ({ ...bucket }));
}

function dayKeys(startMs: number, endDay: string): string[] {
  const keys: string[] = [];
  for (let day = utcDayKey(startMs); day <= endDay; day = addUtcDays(day, 1)) {
    keys.push(day);
  }
  return keys;
}

function walletAccountId(accountId: string | null, party: WalletUsageParty): string | null {
  if (accountId === null || (party !== 'members' && party !== 'fund')) {
    return null;
  }
  return accountId;
}

function bucketIndex(amount: bigint): number | undefined {
  if (amount === 1n) {
    return 0;
  }
  if (amount >= 2n && amount <= 10n) {
    return 1;
  }
  if (amount >= 11n && amount <= 100n) {
    return 2;
  }
  if (amount >= 101n && amount <= 1000n) {
    return 3;
  }
  if (amount >= 1001n && amount <= 10000n) {
    return 4;
  }
  if (amount >= 10001n && amount <= 100000n) {
    return 5;
  }
  if (amount > 100000n) {
    return 6;
  }
  return undefined;
}

function medianSats(amounts: readonly bigint[]): number {
  if (amounts.length === 0) {
    return 0;
  }
  const sorted = [...amounts].sort((left, right) => (left < right ? -1 : 1));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return safeSatsTotal(sorted[mid] as bigint);
  }
  const left = sorted[mid - 1] as bigint;
  const right = sorted[mid] as bigint;
  return safeSatsTotal((left + right) / 2n);
}

function roundedAverage(volume: bigint, count: number): number {
  if (count === 0) {
    return 0;
  }
  const divisor = BigInt(count);
  return safeSatsTotal((volume + divisor / 2n) / divisor);
}

function topFiveSenderShare(sent: ReadonlyMap<string, bigint>, volume: bigint): number {
  if (volume === 0n) {
    return 0;
  }
  const ranked = [...sent.entries()].map(([id, sats]) => ({ id, sats }));
  ranked.sort((left, right) => {
    if (left.sats !== right.sats) {
      return left.sats > right.sats ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
  let part = 0n;
  const keep = Math.min(5, ranked.length);
  for (let index = 0; index < keep; index += 1) {
    part += (ranked[index] as { id: string; sats: bigint }).sats;
  }
  const scaled = (part * 10000n + volume / 2n) / volume;
  return Number(scaled) / 10000;
}

interface DayAcc {
  purposes: Record<WalletUsagePurpose, WalletUsagePurposeTotals>;
  active: Set<string>;
  sending: Set<string>;
  receiving: Set<string>;
}

interface FlowAcc {
  day: string;
  from: WalletUsageParty;
  to: WalletUsageParty;
  purpose: WalletUsagePurpose;
  count: number;
  sats: bigint;
  feeSats: bigint;
}

/**
 * Build the public usage body from already merged rows.
 *
 * Days are UTC. A payment whose `paidAt` is before release or whose UTC day is
 * after `nowMs` is ignored entirely: it does not enter totals, flows, amount
 * buckets, hours, wallet counts, or `asOf`. Forum and shop rows use their own
 * windows: a row whose UTC day is after `nowMs` is ignored, a heart in the
 * release total needs its instant on or after release, and every paid shop
 * charge in the published shop series is counted. `paidShopChargeCount` is the
 * sum of the published daily `shopCharges[].paid` cells over the whole shop
 * window, from `2026-10-26 11:17 UTC`, while the payment totals and
 * `heartCount` start at release.
 * Sat sums that are not safe integers throw. Active, sending, and receiving
 * wallet counts use member and fund accounts only, both in the totals and per
 * day. `topFiveSenderShare` ranks those sending wallets by their counted sats
 * and divides by the counted payment volume.
 *
 * @param input - Payments, forum invoices, and shop charges. Order is ignored.
 * @param nowMs - Clock in epoch milliseconds. Selects the last UTC day.
 * @returns Aggregates only. Account ids are counted and then dropped.
 * @throws When a sat amount is negative, not an integer, or a sum exceeds
 *   `Number.MAX_SAFE_INTEGER`.
 */
export function buildWalletUsage(input: WalletUsageInput, nowMs: number): WalletUsage {
  const endDay = utcDayKey(nowMs);
  const since = walletUsageReadSince();
  const active = new Set<string>();
  const sending = new Set<string>();
  const receiving = new Set<string>();
  const sentByWallet = new Map<string, bigint>();
  const amounts: bigint[] = [];
  let volume = 0n;
  let fees = 0n;
  let latestPaidAt: Date | undefined;
  const dayMap = new Map<string, DayAcc>();
  for (const day of dayKeys(WALLET_RELEASE_AT_MS, endDay)) {
    dayMap.set(day, {
      purposes: emptyPurposes(),
      active: new Set<string>(),
      sending: new Set<string>(),
      receiving: new Set<string>(),
    });
  }
  const flows = new Map<string, FlowAcc>();
  const buckets = emptyBuckets();
  const hours: Array<{ hourUtc: number; count: number }> = [];
  for (let hourUtc = 0; hourUtc < 24; hourUtc += 1) {
    hours.push({ hourUtc, count: 0 });
  }

  for (const row of input.payments) {
    if (row.paidAt.getTime() < WALLET_RELEASE_AT_MS) {
      continue;
    }
    const day = utcDayKey(row.paidAt.getTime());
    if (day > endDay) {
      continue;
    }
    const amount = asSats(row.amountSats);
    const fee = asSats(row.feeSats);
    volume += amount;
    fees += fee;
    amounts.push(amount);
    if (latestPaidAt === undefined || row.paidAt.getTime() > latestPaidAt.getTime()) {
      latestPaidAt = row.paidAt;
    }
    const purpose = walletUsagePurpose(row);
    const payerWallet = walletAccountId(row.payerAccountId, row.payerParty);
    const payeeWallet = walletAccountId(row.payeeAccountId, row.payeeParty);
    if (payerWallet !== null) {
      active.add(payerWallet);
      sending.add(payerWallet);
      const current = sentByWallet.get(payerWallet);
      sentByWallet.set(payerWallet, (current === undefined ? 0n : current) + amount);
    }
    if (payeeWallet !== null) {
      active.add(payeeWallet);
      receiving.add(payeeWallet);
    }
    const hour = hours[row.paidAt.getUTCHours()] as { hourUtc: number; count: number };
    hour.count += 1;
    const bucketAt = bucketIndex(amount);
    if (bucketAt !== undefined) {
      const bucket = buckets[bucketAt] as WalletUsageBucket;
      bucket.count += 1;
      bucket.sats = safeSatsTotal(asSats(bucket.sats) + amount);
    }
    const dayAcc = dayMap.get(day);
    if (dayAcc !== undefined) {
      const cell = dayAcc.purposes[purpose] as WalletUsagePurposeTotals;
      cell.count += 1;
      cell.sats = safeSatsTotal(asSats(cell.sats) + amount);
      if (payerWallet !== null) {
        dayAcc.active.add(payerWallet);
        dayAcc.sending.add(payerWallet);
      }
      if (payeeWallet !== null) {
        dayAcc.active.add(payeeWallet);
        dayAcc.receiving.add(payeeWallet);
      }
    }
    const flowKey = `${day}\u0000${row.payerParty}\u0000${row.payeeParty}\u0000${purpose}`;
    const flow = flows.get(flowKey);
    if (flow === undefined) {
      flows.set(flowKey, {
        day,
        from: row.payerParty,
        to: row.payeeParty,
        purpose,
        count: 1,
        sats: amount,
        feeSats: fee,
      });
    } else {
      flow.count += 1;
      flow.sats += amount;
      flow.feeSats += fee;
    }
  }

  let heartCount = 0;
  const forum = new Map<string, { gifts: number; hearts: number; sats: bigint }>();
  for (const day of dayKeys(since.forumInvoices, endDay)) {
    forum.set(day, { gifts: 0, hearts: 0, sats: 0n });
  }
  for (const row of input.forumInvoices) {
    const day = utcDayKey(row.createdAt.getTime());
    if (day > endDay) {
      continue;
    }
    if (row.heart && row.createdAt.getTime() >= WALLET_RELEASE_AT_MS) {
      heartCount += 1;
    }
    const cell = forum.get(day);
    if (cell === undefined) {
      continue;
    }
    const amount = asSats(row.amountSats);
    cell.sats += amount;
    if (row.heart) {
      cell.hearts += 1;
    } else {
      cell.gifts += 1;
    }
  }

  const shop = new Map<string, { created: number; paid: number }>();
  for (const day of dayKeys(since.shopCharges, endDay)) {
    shop.set(day, { created: 0, paid: 0 });
  }
  for (const row of input.shopCharges) {
    const day = utcDayKey(row.createdAt.getTime());
    if (day > endDay) {
      continue;
    }
    const cell = shop.get(day);
    if (cell === undefined) {
      continue;
    }
    cell.created += 1;
    if (row.status === 'paid') {
      cell.paid += 1;
    }
  }

  const flowRows = [...flows.keys()].sort().map((key) => {
    const flow = flows.get(key) as FlowAcc;
    return {
      day: flow.day,
      from: flow.from,
      to: flow.to,
      purpose: flow.purpose,
      count: flow.count,
      sats: safeSatsTotal(flow.sats),
      feeSats: safeSatsTotal(flow.feeSats),
    };
  });

  return {
    releasedAt: new Date(WALLET_RELEASE_AT_MS).toISOString(),
    asOf: latestPaidAt === undefined ? null : latestPaidAt.toISOString(),
    totals: {
      paymentCount: amounts.length,
      volumeSats: safeSatsTotal(volume),
      feeSats: safeSatsTotal(fees),
      medianSats: medianSats(amounts),
      averageSats: roundedAverage(volume, amounts.length),
      activeWalletCount: active.size,
      sendingWalletCount: sending.size,
      receivingWalletCount: receiving.size,
      topFiveSenderShare: topFiveSenderShare(sentByWallet, volume),
      heartCount,
      paidShopChargeCount: [...shop.values()].reduce((sum, cell) => sum + cell.paid, 0),
    },
    days: [...dayMap.entries()].map(([day, acc]) => ({
      day,
      purposes: acc.purposes,
      activeWalletCount: acc.active.size,
      sendingWalletCount: acc.sending.size,
      receivingWalletCount: acc.receiving.size,
    })),
    flows: flowRows,
    amountBuckets: buckets,
    hours,
    forum: [...forum.entries()].map(([day, cell]) => ({
      day,
      gifts: cell.gifts,
      hearts: cell.hearts,
      sats: safeSatsTotal(cell.sats),
    })),
    shopCharges: [...shop.entries()].map(([day, cell]) => ({
      day,
      created: cell.created,
      paid: cell.paid,
    })),
  };
}
