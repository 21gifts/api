/**
 * Read-only account activity: donation given/received sats, plus outstanding
 * loan balances on the same JSON object.
 *
 * Donation series count confirmed forum zaps on non-loan notes, plus house
 * gifts of kind daily and welcome. Loans (`goalRepayable === true`), repayment
 * invoices, and moderator stipends stay out of `donatedSats` / `receivedSats`.
 * Loan series are not `buildGiftStats`: balances can fall, only movement days
 * are emitted, missing BTC-USD throws `Error('fx.rate.missing')`, and missing
 * CHF/EUR/PHP is JSON `null`. Public JSON never includes invoices, payment
 * hashes, or nsec. Does not change `GET /gifts/stats` (that route remains house
 * outbound only).
 */

import type { Account } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { FX_SOURCE_COINBASE_DAILY_CLOSE, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { parseRepaymentDescription } from '@/lib/credit-repayment';
import {
  buildGiftStats,
  giftsForRecipient,
  type GiftFxQuote,
  type GiftRow,
  type GiftStatsFx,
  type SpendDay,
} from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import {
  satsToBtcString,
  satsToUsdCents,
  usdCentsToFiatCents,
  usdCentsToString,
} from '@/lib/money';
import type {
  LoanLedgerMovement,
  MessageInvoiceAttempt,
  MessageStore,
  ZapIngestRow,
} from '@/lib/message-store';
import {
  FX_SOURCE_FRANKFURTER_ECB,
  InMemoryFiatStore,
  type FiatCross,
  type FiatRateBook,
} from '@/lib/usd-fiat-store';

const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/;
const FALLBACK_RECIPIENT = 'zap';

const USD_FX_QUOTE: GiftFxQuote = {
  code: 'USD',
  pair: 'BTC-USD',
  source: FX_SOURCE_COINBASE_DAILY_CLOSE,
};

/**
 * Donated and received sats with UTC spend series, FX metadata, and
 * outstanding loan balances (`owedSats` / `creditSats` and their series).
 */
export interface AccountActivity {
  /** Confirmed given donation zaps (and platform daily/welcome outbound) in whole sats. */
  donatedSats: number;
  /**
   * Received donation zaps on non-loan authored notes plus daily/welcome house
   * gifts to its handle.
   */
  receivedSats: number;
  /** UTC daily donated series (`buildGiftStats` `spendOverTime`). */
  donatedOverTime: SpendDay[];
  /** UTC daily received series. */
  receivedOverTime: SpendDay[];
  /** Sats this account still owes on credits it received. */
  owedSats: number;
  /** Sats other people still owe this account (Guthaben). */
  creditSats: number;
  /** UTC days with an owed movement; cumulative may fall; no gap days. */
  owedOverTime: SpendDay[];
  /** UTC days with a credit movement; cumulative may fall; no gap days. */
  creditOverTime: SpendDay[];
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
  const byHash = new Map<string, ZapIngestRow>();
  for (const ingest of indexed) {
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
 * Aggregate donation given/received sats and outstanding loan balances for one
 * account.
 *
 * Given: confirmed forum zaps this account paid on notes that are not loans,
 * excluding `repay:` repayment invoices, plus outbound house gifts of kind
 * daily and welcome when `account.isPlatform === true`. Moderator stipends
 * (`kind === 'moderator'`) are omitted. Received: indexed zaps on authored
 * notes that are not loans (including soft-hidden rows and replies), unique by
 * `receiptId` (oldest wins), plus a remainder when `message.sats` exceeds those
 * ingest amounts on **top-level** non-loan notes (a loan note is omitted
 * entirely, including a hidden one; gift-as-reply `sats` do not inflate the
 * payer's Received), plus house gifts of kind daily and welcome whose recipient
 * handle matches the account Lightning Address. A loan is a note with
 * `goalRepayable === true`. Self-zaps on a non-loan note count on both sides.
 * Loan series come from `listLoanLedger`: grants raise a side, repayments lower
 * it, balances are not clamped, only movement days are emitted, and fiat prices
 * the outstanding balance that day. Does not change `GET /gifts/stats`. Empty
 * input (no donations and no loan movements) is zeros without Coinbase and
 * without Frankfurter. Missing BTC-USD for a legacy donation day or a loan
 * movement day throws the same `Error('fx.rate.missing')` as
 * {@link buildGiftStats}. Missing CHF/EUR/PHP is JSON `null`, never a throw;
 * when fiat `ensureDays` throws, log `account.activity.fiat_failed` and continue
 * with an empty fiat map. Donation series (`donatedOverTime` /
 * `receivedOverTime`) are the same `spendOverTime` day objects as
 * `GET /gifts/stats`, including additive CHF/EUR/PHP.
 *
 * @param args - Account, stores, BTC-USD rate book, optional USD→CHF/EUR/PHP
 *   book, and clock.
 * @returns Activity totals and series.
 * @throws `Error('fx.rate.missing')` when a required gift or loan day has no
 *   BTC-USD rate.
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
  const outbound = await args.gifts.listOutbound();
  const house = outbound.filter((row) => row.kind !== 'moderator');
  const handle = args.account.lightningAddress;
  const receivedHouse = handle ? giftsForRecipient(house, handle) : [];
  const givenHouse = args.account.isPlatform === true ? house : [];
  const invoices = await args.messages.listInvoiceAttemptsForPayer(args.account.id);
  const indexed = await args.messages.listIndexedZapIngests();
  const givenZaps = matchConfirmedGivenZaps(
    await donationInvoices(invoices, args.messages),
    indexed,
  );
  const receivedZaps = await receivedZapsForAccount(args.account, args.messages, indexed);
  const givenRows = givenZaps.concat(givenHouse);
  const receivedRows = receivedZaps.concat(receivedHouse);
  const ledger = await args.messages.listLoanLedger(args.account.id);
  const fiatRates = args.fiatRates ?? new InMemoryFiatStore();

  if (givenRows.length === 0 && receivedRows.length === 0 && ledger.length === 0) {
    const empty = buildGiftStats([], new Map());
    return {
      donatedSats: 0,
      receivedSats: 0,
      donatedOverTime: [],
      receivedOverTime: [],
      owedSats: 0,
      creditSats: 0,
      owedOverTime: [],
      creditOverTime: [],
      fx: empty.fx,
    };
  }

  const legacyDays = [
    ...new Set(
      givenRows
        .concat(receivedRows)
        .filter((row) => row.amountUsd === undefined)
        .map((row) => row.paidAt.toISOString().slice(0, 10)),
    ),
  ];
  const loanDays = [...new Set(ledger.map((row) => row.at.toISOString().slice(0, 10)))];
  const rateDays = [...new Set(legacyDays.concat(loanDays))];
  let rateMap: ReadonlyMap<string, string> = new Map();
  if (rateDays.length > 0) {
    rateMap = await args.rates.ensureDays(rateDays, args.now());
    for (const day of legacyDays) {
      if (!rateMap.has(day)) {
        throw new Error('fx.rate.missing');
      }
    }
  }

  let fiatMap: ReadonlyMap<string, FiatCross> = new Map();
  try {
    if (rateDays.length > 0) {
      fiatMap = await fiatRates.ensureDays(rateDays, args.now());
    }
  } catch {
    logEvent('account.activity.fiat_failed');
  }

  const sortedLedger = [...ledger].sort(compareLoanMovements);
  const owedSeries = buildLoanSide(sortedLedger, 'owed', rateMap, fiatMap);
  const creditSeries = buildLoanSide(sortedLedger, 'credit', rateMap, fiatMap);

  if (givenRows.length === 0 && receivedRows.length === 0) {
    return {
      donatedSats: 0,
      receivedSats: 0,
      donatedOverTime: [],
      receivedOverTime: [],
      owedSats: owedSeries.balance,
      creditSats: creditSeries.balance,
      owedOverTime: owedSeries.overTime,
      creditOverTime: creditSeries.overTime,
      fx: loanOnlyFx(loanDays, fiatMap),
    };
  }

  const givenStats = buildGiftStats(givenRows, rateMap, fiatMap);
  const receivedStats = buildGiftStats(receivedRows, rateMap, fiatMap);
  return {
    donatedSats: givenStats.totalSats,
    receivedSats: receivedStats.totalSats,
    donatedOverTime: givenStats.spendOverTime,
    receivedOverTime: receivedStats.spendOverTime,
    owedSats: owedSeries.balance,
    creditSats: creditSeries.balance,
    owedOverTime: owedSeries.overTime,
    creditOverTime: creditSeries.overTime,
    fx: givenRows.length > 0 ? givenStats.fx : receivedStats.fx,
  };
}

/**
 * Stable rank so same-timestamp grants sort before repayments.
 *
 * @param kind - Movement kind.
 * @returns `0` for grant, `1` for repayment.
 */
function loanKindRank(kind: 'grant' | 'repayment'): number {
  return kind === 'grant' ? 0 : 1;
}

/**
 * Order loan ledger rows by time, then grant before repayment.
 *
 * @param a - Left movement.
 * @param b - Right movement.
 * @returns Negative when `a` comes first, zero when equal, positive when `b` first.
 */
function compareLoanMovements(a: LoanLedgerMovement, b: LoanLedgerMovement): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.kind === b.kind) {
    return 0;
  }
  return loanKindRank(a.kind) - loanKindRank(b.kind);
}

/**
 * Outstanding balance series for one loan side.
 *
 * @param ledger - Sorted grant/repayment movements.
 * @param side - `owed` or `credit` flag on each row.
 * @param rateMap - UTC day → BTC-USD.
 * @param fiatMap - UTC day → USD→CHF/EUR/PHP.
 * @returns Final balance and movement-day SpendDay rows.
 * @throws `Error('fx.rate.missing')` when a movement day has no BTC-USD rate.
 */
function buildLoanSide(
  ledger: readonly LoanLedgerMovement[],
  side: 'owed' | 'credit',
  rateMap: ReadonlyMap<string, string>,
  fiatMap: ReadonlyMap<string, FiatCross>,
): { balance: number; overTime: SpendDay[] } {
  let balance = 0;
  const byDay = new Map<string, { net: number; count: number; balanceAfter: number }>();
  for (const movement of ledger) {
    const onSide = side === 'owed' ? movement.owed : movement.credit;
    if (!onSide) {
      continue;
    }
    const signed = movement.kind === 'grant' ? movement.sats : -movement.sats;
    balance += signed;
    const day = movement.at.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { net: 0, count: 0, balanceAfter: 0 };
    bucket.net += signed;
    bucket.count += 1;
    bucket.balanceAfter = balance;
    byDay.set(day, bucket);
  }
  const overTime: SpendDay[] = [];
  for (const [day, bucket] of byDay) {
    const rate = rateMap.get(day);
    if (rate === undefined) {
      throw new Error('fx.rate.missing');
    }
    const outstanding = bucket.balanceAfter;
    const usdCents = satsToUsdCents(Math.abs(outstanding), rate);
    const usd = signedMoneyString(outstanding, usdCentsToString(usdCents));
    const cross = fiatMap.get(day) ?? {};
    const chf = loanFiatString(outstanding, usdCents, cross.CHF);
    const eur = loanFiatString(outstanding, usdCents, cross.EUR);
    const php = loanFiatString(outstanding, usdCents, cross.PHP);
    overTime.push({
      day,
      giftCount: bucket.count,
      officialCount: 0,
      sats: bucket.net,
      cumulativeSats: outstanding,
      btc: signedBtcString(bucket.net),
      cumulativeBtc: signedBtcString(outstanding),
      usd,
      cumulativeUsd: usd,
      chf,
      cumulativeChf: chf,
      eur,
      cumulativeEur: eur,
      php,
      cumulativePhp: php,
    });
  }
  return { balance, overTime };
}

/**
 * FX metadata when the activity has loan movements and no donation rows.
 *
 * @param loanDays - UTC days with at least one loan movement.
 * @param fiatMap - Loaded fiat crosses (may be empty after fiat_failed).
 * @returns GiftStatsFx with USD always and CHF/EUR/PHP when present.
 */
function loanOnlyFx(
  loanDays: readonly string[],
  fiatMap: ReadonlyMap<string, FiatCross>,
): GiftStatsFx {
  const quotes: GiftFxQuote[] = [USD_FX_QUOTE];
  let hasChf = false;
  let hasEur = false;
  let hasPhp = false;
  for (const day of loanDays) {
    const cross = fiatMap.get(day);
    if (typeof cross?.CHF === 'string') {
      hasChf = true;
    }
    if (typeof cross?.EUR === 'string') {
      hasEur = true;
    }
    if (typeof cross?.PHP === 'string') {
      hasPhp = true;
    }
  }
  if (hasChf) {
    quotes.push({ code: 'CHF', pair: 'USD-CHF', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  if (hasEur) {
    quotes.push({ code: 'EUR', pair: 'USD-EUR', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  if (hasPhp) {
    quotes.push({ code: 'PHP', pair: 'USD-PHP', source: FX_SOURCE_FRANKFURTER_ECB });
  }
  return {
    quote: 'BTC-USD',
    dayBasis: 'utc',
    source: FX_SOURCE_COINBASE_DAILY_CLOSE,
    quotes,
  };
}

/**
 * Format a possibly negative sat amount as an eight-decimal BTC string.
 *
 * @param sats - Integer sats (may be negative).
 * @returns BTC string; negatives get a `-` prefix on the absolute value.
 */
function signedBtcString(sats: number): string {
  if (sats < 0) {
    return `-${satsToBtcString(-sats)}`;
  }
  return satsToBtcString(sats);
}

/**
 * Prefix a non-negative money string when the signed balance is negative.
 *
 * @param signed - Outstanding balance (sign source).
 * @param absolute - Absolute formatted amount from a money helper.
 * @returns Signed display string; zero stays unsigned.
 */
function signedMoneyString(signed: number, absolute: string): string {
  if (signed < 0) {
    return `-${absolute}`;
  }
  return absolute;
}

/**
 * Price an outstanding loan balance in one fiat code for that UTC day.
 *
 * @param outstanding - Signed sat balance.
 * @param usdCents - Absolute USD cents of that balance.
 * @param cross - USD→fiat rate string, or missing.
 * @returns Two-decimal string (signed when negative), or JSON `null`.
 */
function loanFiatString(
  outstanding: number,
  usdCents: number,
  cross: string | undefined,
): string | null {
  if (typeof cross !== 'string') {
    return null;
  }
  const fiatCents = usdCentsToFiatCents(usdCents, cross);
  return signedMoneyString(outstanding, usdCentsToString(fiatCents));
}

/**
 * Payer invoices that may count as given donations.
 *
 * Drops repayment invoices (`parseRepaymentDescription` marker) before loading
 * notes. Then drops invoices whose note has `goalRepayable === true`. An unknown
 * note (`getById` undefined) stays a donation. Soft-deleted loan rows are still
 * excluded when `goalRepayable === true` (`deletedAt` is not consulted).
 *
 * @param invoices - Payer invoice attempts.
 * @param messages - Forum store for `getById`.
 * @returns Invoices passed to {@link matchConfirmedGivenZaps}.
 */
async function donationInvoices(
  invoices: readonly MessageInvoiceAttempt[],
  messages: MessageStore,
): Promise<MessageInvoiceAttempt[]> {
  const candidates = invoices.filter(
    (invoice) => parseRepaymentDescription(invoice.description) === null,
  );
  const messageIds = [...new Set(candidates.map((invoice) => invoice.messageId))];
  const notes = await Promise.all(messageIds.map((id) => messages.getById(id)));
  const loanIds = new Set<string>();
  for (const [index, id] of messageIds.entries()) {
    const row = notes[index];
    if (row !== undefined && row.goalRepayable === true) {
      loanIds.add(id);
    }
  }
  return candidates.filter((invoice) => !loanIds.has(invoice.messageId));
}

/**
 * Indexed zaps credited to non-loan messages this account authored, plus a
 * `message.sats` remainder when the stored total exceeds those ingests.
 *
 * Unique by `receiptId` (oldest first). Hidden non-loan notes (`deletedAt` set)
 * still count. A loan note (`goalRepayable === true`) is omitted entirely,
 * including when hidden. A top-level non-loan note with `sats: 21` and no ingest
 * still yields 21 received sats. Remainder is not applied to replies
 * (`parentId` set) so a gift-as-reply does not inflate the payer's Received.
 * Indexed ingests on published replies still count. External/Damus zaps need no
 * payer account.
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
  const creditedFiatByMessageId = new Map<string, FiatCents>();
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
    const authoredNote = authoredById.get(ingest.messageId);
    if (authoredNote === undefined || authoredNote.goalRepayable === true) {
      continue;
    }
    seenReceipts.add(ingest.receiptId);
    rows.push({
      paidAt: ingest.createdAt,
      amountSats: ingest.amountSats,
      recipientWosUser,
      kind: 'other',
      ...storedGiftFiat(ingest),
    });
    const prev = creditedByMessageId.get(ingest.messageId) ?? 0;
    creditedByMessageId.set(ingest.messageId, prev + ingest.amountSats);
    const prevFiat = creditedFiatByMessageId.get(ingest.messageId) ?? ZERO_FIAT;
    creditedFiatByMessageId.set(ingest.messageId, addFiat(prevFiat, fiatCents(ingest)));
  }
  for (const message of authored) {
    if (message.goalRepayable === true) {
      continue;
    }
    if (message.parentId !== null) {
      continue;
    }
    if (message.sats <= 0) {
      continue;
    }
    const credited = creditedByMessageId.get(message.id) ?? 0;
    if (message.sats > credited) {
      const creditedFiat = creditedFiatByMessageId.get(message.id) ?? ZERO_FIAT;
      const fiat =
        credited === 0
          ? storedGiftFiat(message)
          : fiatFromCents(subtractFiat(fiatCents(message), creditedFiat));
      rows.push({
        paidAt: message.createdAt,
        amountSats: message.sats - credited,
        recipientWosUser,
        kind: 'other',
        ...fiat,
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
    kind: 'other',
    ...storedGiftFiat(ingest),
  };
}

/** Four stored cent totals. `null` means that currency cannot be summed. */
interface FiatCents {
  usd: number | null;
  chf: number | null;
  eur: number | null;
  php: number | null;
}

const ZERO_FIAT: FiatCents = { usd: 0, chf: 0, eur: 0, php: 0 };

/** Parse a stored two-decimal amount. Anything else is missing. */
function storedCents(value: string | null | undefined): number | null {
  if (value === undefined || value === null || !/^\d+\.\d{2}$/.test(value)) {
    return null;
  }
  return Number(value.replace('.', ''));
}

function fiatCents(row: {
  amountUsd?: string | null;
  amountChf?: string | null;
  amountEur?: string | null;
  amountPhp?: string | null;
}): FiatCents {
  return {
    usd: storedCents(row.amountUsd),
    chf: storedCents(row.amountChf),
    eur: storedCents(row.amountEur),
    php: storedCents(row.amountPhp),
  };
}

function addFiat(left: FiatCents, right: FiatCents): FiatCents {
  return {
    usd: left.usd === null || right.usd === null ? null : left.usd + right.usd,
    chf: left.chf === null || right.chf === null ? null : left.chf + right.chf,
    eur: left.eur === null || right.eur === null ? null : left.eur + right.eur,
    php: left.php === null || right.php === null ? null : left.php + right.php,
  };
}

function subtractFiat(left: FiatCents, right: FiatCents): FiatCents {
  return {
    usd: left.usd === null || right.usd === null ? null : left.usd - right.usd,
    chf: left.chf === null || right.chf === null ? null : left.chf - right.chf,
    eur: left.eur === null || right.eur === null ? null : left.eur - right.eur,
    php: left.php === null || right.php === null ? null : left.php - right.php,
  };
}

function fiatFromCents(
  cents: FiatCents,
): Pick<GiftRow, 'amountUsd' | 'amountChf' | 'amountEur' | 'amountPhp'> {
  const text = (value: number | null): string | null =>
    value === null || value < 0 ? null : usdCentsToString(value);
  return {
    amountUsd: text(cents.usd),
    amountChf: text(cents.chf),
    amountEur: text(cents.eur),
    amountPhp: text(cents.php),
  };
}

/** Copy a snapshot onto a gift row. A missing field becomes `null`, not omitted. */
function storedGiftFiat(row: {
  amountUsd?: string | null;
  amountChf?: string | null;
  amountEur?: string | null;
  amountPhp?: string | null;
}): Pick<GiftRow, 'amountUsd' | 'amountChf' | 'amountEur' | 'amountPhp'> {
  return {
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
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
