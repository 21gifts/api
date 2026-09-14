/**
 * Read-only account activity: house gifts plus confirmed forum zaps.
 *
 * Public JSON never includes invoices, payment hashes, or nsec. Forum zaps
 * stay off `GET /gifts/stats` (that route remains house outbound only).
 */

import type { Account } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import type { BtcUsdRateBook } from '@/lib/btc-usd-store';
import {
  buildGiftStats,
  giftsForRecipient,
  type GiftRow,
  type GiftStatsFx,
  type SpendDay,
} from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';
import { InMemoryFiatStore, type FiatCross, type FiatRateBook } from '@/lib/usd-fiat-store';

const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/;
const FALLBACK_RECIPIENT = 'zap';

/** Donated and received sats with UTC spend series and FX metadata. */
export interface AccountActivity {
  /** Confirmed given zaps (and platform house outbound) in whole sats. */
  donatedSats: number;
  /** Received zaps on this account's notes plus house gifts to its handle. */
  receivedSats: number;
  /** UTC daily donated series (`buildGiftStats` `spendOverTime`). */
  donatedOverTime: SpendDay[];
  /** UTC daily received series. */
  receivedOverTime: SpendDay[];
  /** Quote metadata (always present, including empty activity). */
  fx: GiftStatsFx;
}

/**
 * Payment hash from a kind:9735 receipt's `bolt11` tag.
 *
 * Reads `receipt.tags` only when it is an array of arrays of strings. Finds
 * the first tag whose `[0] === 'bolt11'` and `[1]` is a non-empty string,
 * then {@link decodeBolt11}.
 *
 * @param receipt - Kind:9735 event JSON (tags only; never nsec).
 * @returns Lowercase 64-hex payment hash, or `null`.
 */
export function paymentHashFromReceipt(receipt: Record<string, unknown>): string | null {
  const tags = stringMatrix(receipt['tags']);
  if (tags === null) {
    return null;
  }
  for (const tag of tags) {
    const kind = tag[0];
    const pr = tag[1];
    if (kind === 'bolt11' && pr !== undefined && pr !== '') {
      const decoded = decodeBolt11(pr);
      return decoded === null ? null : decoded.paymentHash;
    }
  }
  return null;
}

/**
 * Confirmed given forum zaps: `result === 'ok'` invoices joined to indexed
 * ingests by payment hash. Invoices with a hash that does not match any ingest
 * are skipped (no tuple fallback). Hashless invoices may match a unique
 * `(messageId, amountSats)` ingest. Unmatched invoices are skipped. Each
 * ingest is emitted at most once.
 *
 * @param invoices - Payer invoice attempts (any order).
 * @param indexed - Indexed zap ingests (first hash wins on duplicates).
 * @returns Gift rows (`paidAt` from the ingest).
 */
export function matchConfirmedGivenZaps(
  invoices: readonly MessageInvoiceAttempt[],
  indexed: readonly ZapIngestRow[],
): GiftRow[] {
  const oldestFirst = [...indexed].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return a.id.localeCompare(b.id);
  });
  const byHash = new Map<string, ZapIngestRow>();
  for (const ingest of oldestFirst) {
    const hash = paymentHashFromReceipt(ingest.receipt);
    if (hash === null || byHash.has(hash)) {
      continue;
    }
    byHash.set(hash, ingest);
  }

  const used = new Set<string>();
  const given: GiftRow[] = [];
  const unmatched: MessageInvoiceAttempt[] = [];

  for (const invoice of invoices) {
    if (invoice.result !== 'ok') {
      continue;
    }
    const hash = invoicePaymentHash(invoice);
    if (hash !== null) {
      const ingest = byHash.get(hash);
      if (ingest !== undefined && !used.has(ingest.id)) {
        given.push(zapGiftRow(invoice, ingest));
        used.add(ingest.id);
      }
      continue;
    }
    unmatched.push(invoice);
  }

  for (const invoice of unmatched) {
    let unique: ZapIngestRow | undefined;
    let matches = 0;
    for (const ingest of indexed) {
      if (
        used.has(ingest.id) ||
        ingest.messageId !== invoice.messageId ||
        ingest.amountSats !== invoice.amountSats
      ) {
        continue;
      }
      matches += 1;
      unique = ingest;
      if (matches > 1) {
        break;
      }
    }
    if (matches !== 1 || unique === undefined) {
      continue;
    }
    given.push(zapGiftRow(invoice, unique));
    used.add(unique.id);
  }

  return given;
}

/**
 * Aggregate donated and received activity for one account.
 *
 * Given: confirmed forum zaps this account paid, plus every outbound house
 * gift when `account.isPlatform === true`. Received: indexed zaps on messages
 * this account authored (including soft-hidden rows), unique by `receiptId`
 * (oldest wins), plus a remainder when `message.sats` exceeds those ingest
 * amounts on **top-level** notes (so a visible ₿21 post is never “no gifts”;
 * gift-as-reply `sats` do not inflate the payer's Received), plus house gifts whose
 * recipient handle matches the account Lightning Address. Self-zaps count on
 * both sides. Empty input is zeros without Coinbase and without Frankfurter.
 * Missing BTC-USD throws the same `fx.rate.missing` as {@link buildGiftStats}.
 * Missing CHF/EUR/PHP is JSON `null`, never a throw; when fiat `ensureDays`
 * throws, log `account.activity.fiat_failed` and continue with an empty fiat
 * map. Series (`donatedOverTime` / `receivedOverTime`) are the same
 * `spendOverTime` day objects as `GET /gifts/stats`, including additive
 * CHF/EUR/PHP.
 *
 * @param args - Account, stores, BTC-USD rate book, optional USD→CHF/EUR/PHP
 *   book, and clock.
 * @returns Activity totals and series.
 * @throws `Error('fx.rate.missing')` when a gift day has no BTC-USD rate.
 */
export async function buildAccountActivity(args: {
  account: Account;
  gifts: GiftStore;
  messages: MessageStore;
  rates: BtcUsdRateBook;
  now: () => number;
  /**
   * USD→CHF/EUR/PHP book. Default empty `InMemoryFiatStore`.
   * Missing fiat is JSON null, never a throw.
   */
  fiatRates?: FiatRateBook;
}): Promise<AccountActivity> {
  const house = await args.gifts.listOutbound();
  const handle = args.account.lightningAddress;
  const receivedHouse = handle ? giftsForRecipient(house, handle) : [];
  const givenHouse = args.account.isPlatform === true ? house : [];
  const invoices = await args.messages.listInvoiceAttemptsForPayer(args.account.id);
  const indexed = await args.messages.listIndexedZapIngests();
  const givenZaps = matchConfirmedGivenZaps(invoices, indexed);
  const receivedZaps = await receivedZapsForAccount(args.account, args.messages, indexed);
  const givenRows = givenZaps.concat(givenHouse);
  const receivedRows = receivedZaps.concat(receivedHouse);
  const fiatRates = args.fiatRates ?? new InMemoryFiatStore();

  if (givenRows.length === 0 && receivedRows.length === 0) {
    const empty = buildGiftStats([], new Map());
    return {
      donatedSats: 0,
      receivedSats: 0,
      donatedOverTime: [],
      receivedOverTime: [],
      fx: empty.fx,
    };
  }

  const days = [
    ...new Set(givenRows.concat(receivedRows).map((row) => row.paidAt.toISOString().slice(0, 10))),
  ];
  const rateMap = await args.rates.ensureDays(days, args.now());
  for (const day of days) {
    if (!rateMap.has(day)) {
      throw new Error('fx.rate.missing');
    }
  }

  let fiatMap: ReadonlyMap<string, FiatCross> = new Map();
  try {
    fiatMap = await fiatRates.ensureDays(days, args.now());
  } catch {
    logEvent('account.activity.fiat_failed');
  }

  const givenStats = buildGiftStats(givenRows, rateMap, fiatMap);
  const receivedStats = buildGiftStats(receivedRows, rateMap, fiatMap);
  return {
    donatedSats: givenStats.totalSats,
    receivedSats: receivedStats.totalSats,
    donatedOverTime: givenStats.spendOverTime,
    receivedOverTime: receivedStats.spendOverTime,
    fx: givenRows.length > 0 ? givenStats.fx : receivedStats.fx,
  };
}

/**
 * Indexed zaps credited to messages this account authored, plus a
 * `message.sats` remainder when the stored total exceeds those ingests.
 *
 * Unique by `receiptId` (oldest first). Hidden notes (`deletedAt` set) still
 * count. A top-level note with `sats: 21` and no ingest still yields 21
 * received sats. Remainder is not applied to replies (`parentId` set) so a
 * gift-as-reply does not inflate the payer's Received. Indexed ingests on
 * published replies still count. External/Damus zaps need no payer account.
 *
 * @param account - Author whose notes collect received zaps.
 * @param messages - Forum store (`listAuthoredMessages` includes hidden rows).
 * @param indexed - Indexed ingest rows.
 * @returns Gift rows for this author.
 */
async function receivedZapsForAccount(
  account: Account,
  messages: MessageStore,
  indexed: readonly ZapIngestRow[],
): Promise<GiftRow[]> {
  const authored = await messages.listAuthoredMessages(account.id);
  const authoredById = new Map(authored.map((row) => [row.id, row]));
  const oldestFirst = [...indexed].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return a.id.localeCompare(b.id);
  });
  const seenReceipts = new Set<string>();
  const rows: GiftRow[] = [];
  const creditedByMessageId = new Map<string, number>();
  const recipientWosUser = recipientHandle(account.lightningAddress);
  for (const ingest of oldestFirst) {
    if (seenReceipts.has(ingest.receiptId)) {
      continue;
    }
    if (ingest.messageId === null) {
      continue;
    }
    if (ingest.amountSats === null || ingest.amountSats <= 0) {
      continue;
    }
    if (!authoredById.has(ingest.messageId)) {
      continue;
    }
    seenReceipts.add(ingest.receiptId);
    rows.push({
      paidAt: ingest.createdAt,
      amountSats: ingest.amountSats,
      recipientWosUser,
    });
    const prev = creditedByMessageId.get(ingest.messageId) ?? 0;
    creditedByMessageId.set(ingest.messageId, prev + ingest.amountSats);
  }
  for (const message of authored) {
    if (message.parentId !== null) {
      continue;
    }
    if (message.sats <= 0) {
      continue;
    }
    const credited = creditedByMessageId.get(message.id) ?? 0;
    if (message.sats > credited) {
      rows.push({
        paidAt: message.createdAt,
        amountSats: message.sats - credited,
        recipientWosUser,
      });
    }
  }
  return rows;
}

/**
 * Local-part of a Lightning Address, or `'zap'` when missing.
 *
 * @param lightningAddress - LUD-16 address or null.
 * @returns Handle used as `GiftRow.recipientWosUser`.
 */
function recipientHandle(lightningAddress: string | null): string {
  if (lightningAddress === null) {
    return FALLBACK_RECIPIENT;
  }
  const trimmed = lightningAddress.trim();
  if (trimmed === '') {
    return FALLBACK_RECIPIENT;
  }
  const at = trimmed.indexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/**
 * Payment hash for an invoice: stored 64-hex, else decode `pr`.
 *
 * @param invoice - Invoice attempt.
 * @returns Lowercase hash, or `null`.
 */
function invoicePaymentHash(invoice: MessageInvoiceAttempt): string | null {
  if (invoice.paymentHash !== null) {
    const lower = invoice.paymentHash.toLowerCase();
    if (PAYMENT_HASH_RE.test(lower)) {
      return lower;
    }
  }
  const decoded = decodeBolt11(invoice.pr ?? '');
  return decoded === null ? null : decoded.paymentHash;
}

/**
 * Gift row for a confirmed given zap.
 *
 * @param invoice - Matched ok invoice.
 * @param ingest - Indexed ingest (amount fallback is the invoice).
 * @returns Stats input row.
 */
function zapGiftRow(invoice: MessageInvoiceAttempt, ingest: ZapIngestRow): GiftRow {
  return {
    paidAt: ingest.createdAt,
    amountSats: ingest.amountSats ?? invoice.amountSats,
    recipientWosUser: recipientHandle(invoice.lightningAddress),
  };
}

/**
 * `tags` as an array of arrays of strings, or `null`.
 *
 * @param value - Raw `receipt.tags`.
 * @returns String matrix, or `null` when the shape is wrong.
 */
function stringMatrix(value: unknown): string[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: string[][] = [];
  for (const tag of value) {
    if (!Array.isArray(tag)) {
      return null;
    }
    const cells: string[] = [];
    for (const cell of tag) {
      if (typeof cell !== 'string') {
        return null;
      }
      cells.push(cell);
    }
    rows.push(cells);
  }
  return rows;
}
