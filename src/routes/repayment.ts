import { Hono, type Context } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { inspectBolt11, invoiceStillOpen, isNip57Invoice } from '@/lib/bolt11';
import {
  allocateRepayment,
  dueDayCount,
  fiatAmountToCents,
  formatCents,
  parseRepaymentDescription,
  parseRepaymentPartDescription,
  payerDebtUnits,
  repaymentDescription,
  repaymentPartDescription,
  repaymentDueDate,
  repaymentLedger,
  repaymentSchedule,
  repaymentStartMs,
  type RepaymentAllocationPart,
  type RepaymentSlice,
} from '@/lib/credit-repayment';
import type { LnurlServerConfig } from '@/lib/config';
import { fiatToSats, type GoalFiatCode, type GoalRateDay } from '@/lib/goal-rate';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import type { MessageRow } from '@/lib/message';
import type { MessageInvoiceAttempt, MessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest, serializeZapRequest } from '@/lib/nostr/zap-request';
import type { VerifiedEvent } from 'nostr-tools/pure';
import { normalizeSignedEvent } from '@/lib/nostr/publish';
import { CANNOT_RECEIVE, lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import { issueSparkInvoice } from '@/lib/spark-invoice';
import type { SparkInvoiceStore } from '@/lib/spark-invoice-store';
import { isSundayRestHeader } from '@/lib/sunday-rest';
import { bearerToken } from '@/routes/me';

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What repayment needs from the forum routes. */
export interface RepaymentDeps {
  store: MessageStore;
  authStore: AuthStore;
  now: () => number;
  nostrKek?: Uint8Array;
  fetchImpl?: FetchFn;
  goalRateDay?: () => Promise<GoalRateDay | null>;
  /** LNURL server; omitted when off. A giver with a verified wallet is repaid on it. */
  lnurlServer?: LnurlServerConfig;
  /** Issued Spark invoices; omitted when free in-app payments are off. */
  sparkInvoices?: SparkInvoiceStore;
  /**
   * Test-only override of the process-wide invoice limiter. Omitted → the
   * module limiter (1/s, 20/h).
   */
  repaymentLimiter?: InvoiceRateLimiter;
}

const limiter = new InvoiceRateLimiter();

/**
 * The repayment invoice limiter: the test override, else the module limiter.
 *
 * @param deps - Route deps.
 * @returns The limiter both pay routes use.
 */
function repaymentLimiterOf(deps: RepaymentDeps): InvoiceRateLimiter {
  return deps.repaymentLimiter ?? limiter;
}

/**
 * Debt of one credit. Sats with no account are weight only when a fiat
 * snapshot is missing, and that weight is not repaid. Frozen fiat debt comes
 * only from its snapshot; an empty snapshot owes nothing.
 *
 * @param deps - Store.
 * @param row - Credit note.
 * @returns Payers, unassigned sats, and the units each account owes.
 */
async function creditOwed(
  deps: RepaymentDeps,
  row: MessageRow,
): Promise<{
  payers: Awaited<ReturnType<MessageStore['listCreditPayers']>>;
  unassignedSats: number;
  owed: ReturnType<typeof payerDebtUnits>;
}> {
  const payers = await deps.store.listCreditPayers(row.id);
  const unassignedSats = await deps.store.sumUnassignedCreditSats(row.id);
  const debtPayers =
    row.goalDebtFrozen && isFiatCredit(row)
      ? payers
      : [...payers, { accountId: '', sats: unassignedSats }];
  return {
    payers,
    unassignedSats,
    owed:
      row.goalDebtFrozen && isFiatCredit(row) && debtPayers.length === 0
        ? []
        : payerDebtUnits(
            row.goalCurrency,
            row.goalDebtFrozen && isFiatCredit(row) ? null : row.goalAmount,
            debtPayers,
          ),
  };
}

/** Most bills one `POST /messages/:id/repayment/due` makes; the rest come on the next call. */
export const REPAYMENT_BILLS_MAX = 60;

/** Characters of the note text in a `GET /me/loans` row. */
const LOAN_TEXT_CHARS = 160;

/** One paid part or open bill of a giver-day share. */
interface SharePart {
  partIndex: number;
  units: bigint;
}

/** An open invoice that still reserves part of a share. */
interface OpenSharePart extends RepaymentAllocationPart {
  open: true;
  description: string;
}

/** One giver-day share with what is settled and what is open. */
interface ShareState {
  dayIndex: number;
  accountId: string;
  units: bigint;
  paidUnits: bigint;
  parts: SharePart[];
  openParts: OpenSharePart[];
  /** A still-payable legacy or oversized bill conflicts with the current remainder. */
  legacyOpen: boolean;
  nextPartIndex: number;
  canReceive: boolean;
  /** The giver cannot receive, or had no verified wallet yet on the share's day: never behind. */
  excused: boolean;
}

/** Schedule state of one funded credit at `nowMs`. */
interface DuePlan {
  daysDue: number;
  /** Leading due days with no unpaid remainder that is not excused. */
  daysPaid: number;
  schedule: RepaymentSlice[];
  paid: Awaited<ReturnType<MessageStore['listRepayments']>>;
  /** Every giver-day share with paid and open parts, in schedule order. */
  shares: ShareState[];
  /** Due, unpaid shares: oldest day first, then schedule order. */
  due: ShareState[];
}

/**
 * Since when each account can receive (`receivingAddress(...) !== null`).
 *
 * @param deps - Auth store and the optional LNURL server.
 * @param accountIds - Accounts to check; repeats are read once.
 * @returns Account id → `sparkPubkeyVerifiedAt`, or null when it cannot receive.
 */
async function receiverMap(
  deps: RepaymentDeps,
  accountIds: readonly string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const id of accountIds) {
    if (!result.has(id)) {
      const account = await deps.authStore.getAccount(id);
      result.set(
        id,
        account === undefined || receivingAddress(account, deps.lnurlServer) === null
          ? null
          : (account.sparkPubkeyVerifiedAt as number),
      );
    }
  }
  return result;
}

/**
 * Due, unpaid shares of a funded credit, with settled parts and open bills.
 *
 * Open bills never reserve a share twice: they are read from successful
 * invoice attempts by description and kept only while still payable.
 *
 * @param deps - Store, auth, and the optional LNURL server.
 * @param row - Funded credit note.
 * @param nowMs - Clock.
 * @returns The plan, or `unavailable` when the debt cannot be computed.
 */
async function duePlan(
  deps: RepaymentDeps,
  row: MessageRow,
  nowMs: number,
): Promise<DuePlan | 'unavailable'> {
  const termDays = row.goalTermDays as number;
  const fundedAt = row.goalFundedAt as Date;
  const daysDue = dueDayCount(fundedAt.getTime(), nowMs, termDays, row.id);
  const paid = await deps.store.listRepayments(row.id);
  const parts = await deps.store.listRepaymentParts(row.id);
  const { owed } = await creditOwed(deps, row);
  if (owed === 'unavailable') {
    return 'unavailable';
  }
  const schedule = repaymentSchedule(termDays, owed);
  const invoiceAttempts = await deps.store.listInvoiceAttemptsForMessage(row.id);
  const sharesWithParts = new Set(
    parts.map((part) => `${part.dayIndex}:${part.recipientAccountId}`),
  );
  const settled = new Set(
    paid
      .filter((item) => !sharesWithParts.has(`${item.dayIndex}:${item.recipientAccountId}`))
      .map((item) => `${item.dayIndex}:${item.recipientAccountId}`),
  );
  const paidByShare = new Map<string, bigint>();
  const partsByShare = new Map<string, SharePart[]>();
  for (const part of parts) {
    const key = `${part.dayIndex}:${part.recipientAccountId}`;
    paidByShare.set(key, (paidByShare.get(key) ?? 0n) + part.units);
    const list = partsByShare.get(key) ?? [];
    list.push({ partIndex: part.partIndex, units: part.units });
    partsByShare.set(key, list);
  }
  const receivers = await receiverMap(
    deps,
    schedule.map((slice) => slice.accountId),
  );
  const startMs = repaymentStartMs(fundedAt.getTime(), row.id);
  const shares: ShareState[] = [];
  for (const slice of schedule) {
    const key = `${slice.dayIndex}:${slice.accountId}`;
    const since = receivers.get(slice.accountId) as number | null;
    const sharePaid = settled.has(key);
    const settledUnits = sharePaid ? slice.units : (paidByShare.get(key) ?? 0n);
    const paidParts = partsByShare.get(key) ?? [];
    const openParts: OpenSharePart[] = [];
    let legacyOpen = false;
    let reserved = settledUnits;
    for (const attempt of invoiceAttempts) {
      if (
        attempt.result !== 'ok' ||
        attempt.pr === null ||
        !invoiceStillOpen(attempt.pr, attempt.createdAt.getTime(), nowMs)
      ) {
        continue;
      }
      const whole = parseRepaymentDescription(attempt.description);
      const part = parseRepaymentPartDescription(attempt.description);
      const parsed = part ?? whole;
      if (
        parsed === null ||
        parsed.dayIndex !== slice.dayIndex ||
        parsed.recipientAccountId !== slice.accountId
      ) {
        continue;
      }
      if (
        attempt.paymentHash !== null &&
        (await deps.store.zapPaymentReceiptId(attempt.paymentHash)) !== undefined
      ) {
        continue;
      }
      if (part === null && settledUnits > 0n) {
        // The old full-share bill is still payable, so it blocks every new
        // remainder bill until it expires. Reusing it would overpay the share.
        legacyOpen = true;
        continue;
      }
      if (part !== null && paidParts.some((paidPart) => paidPart.partIndex === part.partIndex)) {
        continue;
      }
      const units = part === null ? slice.units : part.units;
      const left = slice.units > reserved ? slice.units - reserved : 0n;
      if (left <= 0n) {
        break;
      }
      if (units > left) {
        legacyOpen = true;
        continue;
      }
      openParts.push({
        dayIndex: slice.dayIndex,
        accountId: slice.accountId,
        partIndex: part?.partIndex ?? 0,
        units,
        open: true,
        description: attempt.description as string,
      });
      reserved += units;
    }
    openParts.sort((a, b) => a.partIndex - b.partIndex);
    shares.push({
      dayIndex: slice.dayIndex,
      accountId: slice.accountId,
      units: slice.units,
      paidUnits: settledUnits,
      parts: paidParts,
      openParts,
      legacyOpen,
      nextPartIndex: [
        ...paidParts,
        ...invoiceAttempts.flatMap((attempt) => {
          const historical = parseRepaymentPartDescription(attempt.description);
          return historical !== null &&
            historical.dayIndex === slice.dayIndex &&
            historical.recipientAccountId === slice.accountId
            ? [{ partIndex: historical.partIndex, units: historical.units }]
            : [];
        }),
      ].reduce((next, part) => Math.max(next, part.partIndex + 1), 0),
      canReceive: since !== null,
      excused: since === null || slice.dayIndex < Math.floor((since - startMs) / 86_400_000),
    });
  }
  const due = shares.filter((share) => share.dayIndex < daysDue && share.paidUnits < share.units);
  let daysPaid = 0;
  while (
    daysPaid < daysDue &&
    !due.some((share) => share.dayIndex === daysPaid && !share.excused)
  ) {
    daysPaid += 1;
  }
  return { daysDue, daysPaid, schedule, paid, shares, due };
}

/**
 * The deps with the rate loader read at most once, so every figure of one
 * response is priced at the same rate.
 *
 * @param deps - Deps with an optional rate loader.
 * @returns The same deps, the loader memoized.
 */
function withOneRate<D extends Pick<RepaymentDeps, 'goalRateDay'>>(deps: D): D {
  const load = deps.goalRateDay;
  if (load === undefined) {
    return deps;
  }
  let day: Promise<GoalRateDay | null> | undefined;
  return {
    ...deps,
    goalRateDay: () => {
      day ??= load();
      return day;
    },
  };
}

/**
 * Prices shares of one credit in sats: a bitcoin share is its units, a fiat
 * share is priced at the rate the pay route uses now. The rate is read once.
 *
 * @param deps - Optional rate loader.
 * @param row - Credit note.
 * @returns Units → sats, or null when a fiat share has no rate.
 */
async function sharePricer(
  deps: RepaymentDeps,
  row: MessageRow,
): Promise<(units: bigint) => number | null> {
  if (!isFiatCredit(row)) {
    return (units) => Number(units);
  }
  const rateDay = deps.goalRateDay === undefined ? null : await deps.goalRateDay();
  return (units) => fiatToSats(Number(units) / 100, rateDay, row.goalCurrency as GoalFiatCode);
}

/**
 * Public ledger of one credit: who gave what, and each Lightning repayment.
 *
 * @param routeDeps - Store, auth, clock, and rate loader.
 * @param c - Request. No session is required.
 * @returns The givers and the plan, or an error.
 */
export async function repaymentStatus(routeDeps: RepaymentDeps, c: Context): Promise<Response> {
  const deps = withOneRate(routeDeps);
  const row = await readableCredit(deps, c);
  if (row instanceof Response) {
    return row;
  }
  const nowMs = deps.now();
  const { payers, unassignedSats, owed } = await creditOwed(deps, row);
  if (owed === 'unavailable') {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  const paid = await deps.store.listRepayments(row.id);
  const parts = await deps.store.listRepaymentParts(row.id);
  const fundedAt = row.goalFundedAt instanceof Date ? row.goalFundedAt : null;
  const partKeys = new Set(parts.map((part) => `${part.dayIndex}:${part.recipientAccountId}`));
  const ledgerPaid = [
    ...paid
      .filter((item) => !partKeys.has(`${item.dayIndex}:${item.recipientAccountId}`))
      .map((item) => ({
        dayIndex: item.dayIndex,
        accountId: item.recipientAccountId,
      })),
    ...parts.map((part) => ({
      dayIndex: part.dayIndex,
      accountId: part.recipientAccountId,
      dueSats: Number(part.units),
    })),
  ];
  const lines = repaymentLedger(
    row.goalTermDays as number,
    owed,
    ledgerPaid,
    fundedAt === null ? null : fundedAt.getTime(),
    nowMs,
    row.id,
  );
  const names = new Map<string, { name: string; username: string | null; canReceive: boolean }>();
  for (const payer of payers) {
    names.set(payer.accountId, await publicGiver(deps, payer.accountId));
  }
  const owedById = new Map(owed.map((payer) => [payer.accountId, payer.units]));
  const fiat = isFiatCredit(row);
  const paidSats = new Map<string, number>();
  for (const item of paid) {
    const key = `${item.dayIndex}:${item.recipientAccountId}`;
    if (!partKeys.has(key)) {
      paidSats.set(key, (paidSats.get(key) ?? 0) + item.dueSats);
    }
  }
  for (const part of parts) {
    const key = `${part.dayIndex}:${part.recipientAccountId}`;
    paidSats.set(key, (paidSats.get(key) ?? 0) + part.sats);
  }
  let daysDue = 0;
  let daysPaid = 0;
  let next: { dayIndex: number; sats: number; recipientAccountId: string } | null = null;
  let price: Awaited<ReturnType<typeof sharePricer>> | null = null;
  if (fundedAt !== null) {
    const share = await nextShare(deps, row, nowMs);
    if (share.error !== null) {
      return c.json({ error: share.error }, share.status);
    }
    daysDue = share.daysDue;
    daysPaid = share.daysPaid;
    price = lines.some((line) => line.status === 'due') ? await sharePricer(deps, row) : null;
    if (share.share !== null) {
      const nextShareState = share.share;
      const nextLine = lines.find(
        (line) =>
          line.dayIndex === nextShareState.dayIndex && line.accountId === nextShareState.accountId,
      ) as (typeof lines)[number];
      const unpaidSats = (price as (units: bigint) => number)(nextLine.units - nextLine.paidUnits);
      next = {
        dayIndex: nextShareState.dayIndex,
        sats: unpaidSats,
        recipientAccountId: nextShareState.accountId,
      };
    }
  }
  const waits = (line: (typeof lines)[number]): boolean =>
    line.status === 'due' && !(names.get(line.accountId) as { canReceive: boolean }).canReceive;
  return c.json(
    {
      currency: fiat ? row.goalCurrency : 'BTC',
      fundedAt: fundedAt === null ? null : fundedAt.toISOString(),
      closedAt: row.goalClosedAt instanceof Date ? row.goalClosedAt.toISOString() : null,
      startsOn: fundedAt === null ? null : repaymentDueDate(fundedAt.getTime(), 0, row.id),
      termDays: row.goalTermDays,
      daysDue,
      daysPaid,
      waitingShares: lines.filter(waits).length,
      unassignedSats,
      givers: payers.map((payer) => {
        const identity = names.get(payer.accountId) as {
          name: string;
          username: string | null;
          canReceive: boolean;
        };
        /* v8 ignore next -- every listed payer is in the debt map; a miss is zero */
        const units = owedById.get(payer.accountId) ?? 0n;
        return {
          accountId: payer.accountId,
          name: identity.name,
          username: identity.username,
          givenSats: payer.sats,
          givenAmount: fiat ? formatCents(units) : null,
          canReceive: identity.canReceive,
        };
      }),
      repayments: lines.map((line) => {
        const identity = names.get(line.accountId) as { name: string; username: string | null };
        const paidForLine = paidSats.get(`${line.dayIndex}:${line.accountId}`) ?? 0;
        const remainder = line.units - line.paidUnits;
        return {
          dayIndex: line.dayIndex,
          dueOn: line.dueOn,
          accountId: line.accountId,
          name: identity.name,
          username: identity.username,
          amount: fiat ? formatCents(line.units) : null,
          sats: fiat ? (line.status === 'paid' ? paidForLine : null) : Number(line.units),
          paidSats: paidForLine,
          paidAmount: fiat ? formatCents(line.paidUnits) : null,
          status: line.status,
          waiting: waits(line),
          via: 'lightning',
          dueSats:
            line.status === 'due' && price !== null && remainder > 0n ? price(remainder) : null,
        };
      }),
      next,
    },
    200,
  );
}

async function publicGiver(
  deps: RepaymentDeps,
  accountId: string,
): Promise<{ name: string; username: string | null; canReceive: boolean }> {
  const account = await deps.authStore.getAccount(accountId);
  if (account === undefined) {
    return { name: '', username: null, canReceive: false };
  }
  return {
    name: account.name ?? '',
    username: account.username ?? null,
    canReceive: receivingAddress(account, deps.lnurlServer) !== null,
  };
}

async function readableCredit(deps: RepaymentDeps, c: Context): Promise<Response | MessageRow> {
  const id = c.req.param('id') as string;
  if (!MESSAGE_ID_RE.test(id)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const row = await deps.store.getById(id);
  if (
    row === undefined ||
    row.deletedAt !== null ||
    row.goalRepayable !== true ||
    row.goalTermDays === null ||
    /* v8 ignore next -- copyRow stores null, never undefined */
    row.goalTermDays === undefined
  ) {
    return c.json({ error: 'Not found' }, 404);
  }
  return row;
}

/** Re-read and authorize a credit after its message lock has been acquired. */
async function lockedCredit(
  store: MessageStore,
  opened: { account: Account; row: MessageRow },
  allowCollecting = false,
): Promise<MessageRow | undefined> {
  const row = await store.getById(opened.row.id);
  if (
    row === undefined ||
    row.deletedAt !== null ||
    row.goalRepayable !== true ||
    row.goalTermDays === null ||
    /* v8 ignore next -- copyRow stores null, never undefined */
    row.goalTermDays === undefined ||
    (!allowCollecting &&
      (row.goalFundedAt === null ||
        /* v8 ignore next -- copyRow stores null, never undefined */
        row.goalFundedAt === undefined)) ||
    row.accountId !== opened.account.id
  ) {
    return undefined;
  }
  return row;
}

/** A bill for one share, or the error the pay route answers. */
type RepaymentBill =
  | { ok: true; pr: string; amountSats: number; sparkInvoice: string | null }
  | {
      ok: false;
      status: 400 | 409 | 429 | 503;
      body: { error: string; code?: typeof CANNOT_RECEIVE };
    };

/** Mint or reuse a bill while the common message lock is held. */
async function repaymentBillLocked(
  deps: RepaymentDeps,
  opened: { account: Account; row: MessageRow; nowMs: number },
  share: {
    dayIndex: number;
    accountId: string;
    shareUnits: bigint;
    sats: number;
    description: string;
  },
  mayMint: () => boolean,
): Promise<RepaymentBill> {
  if (opened.row.eventId === null || opened.row.eventId === '') {
    return { ok: false, status: 400, body: { error: 'This message cannot be paid yet' } };
  }
  const recipient = await deps.authStore.getAccount(share.accountId);
  const receiving = recipient === undefined ? null : receivingAddress(recipient, deps.lnurlServer);
  if (recipient === undefined || receiving === null) {
    return {
      ok: false,
      status: 400,
      body: { error: 'A giver has no Lightning address', code: CANNOT_RECEIVE },
    };
  }
  const address = receiving.address;
  const recipientPubkey = await deps.authStore.getNostrPublicKey(recipient.id);
  if (recipientPubkey === undefined) {
    return { ok: false, status: 400, body: { error: 'A giver has no Lightning address' } };
  }
  const kek = deps.nostrKek;
  if (kek === undefined) {
    return { ok: false, status: 503, body: { error: 'Messages are unavailable' } };
  }
  const amountMsat = share.sats * 1000;
  const description = share.description;
  const requestedPart = parseRepaymentPartDescription(description);
  const paidParts = (await deps.store.listRepaymentParts(opened.row.id)).filter(
    (part) => part.dayIndex === share.dayIndex && part.recipientAccountId === share.accountId,
  );
  const paidUnits = paidParts.reduce((sum, part) => sum + part.units, 0n);
  const legacyPaid = (await deps.store.listRepayments(opened.row.id)).some(
    (paid) =>
      paid.dayIndex === share.dayIndex &&
      paid.recipientAccountId === share.accountId &&
      paidParts.length === 0,
  );
  const attempts = await deps.store.listInvoiceAttemptsForMessage(opened.row.id);
  const openAttempts: Array<{
    attempt: MessageInvoiceAttempt;
    part: ReturnType<typeof parseRepaymentPartDescription>;
  }> = [];
  for (const attempt of attempts) {
    const parsed = parseRepaymentDescription(attempt.description);
    if (
      attempt.result !== 'ok' ||
      attempt.pr === null ||
      parsed === null ||
      parsed.dayIndex !== share.dayIndex ||
      parsed.recipientAccountId !== share.accountId ||
      !invoiceStillOpen(attempt.pr, attempt.createdAt.getTime(), opened.nowMs)
    ) {
      continue;
    }
    if (
      attempt.paymentHash !== null &&
      (await deps.store.zapPaymentReceiptId(attempt.paymentHash)) !== undefined
    ) {
      continue;
    }
    openAttempts.push({
      attempt,
      part: parseRepaymentPartDescription(attempt.description),
    });
  }
  const outstanding = openAttempts.find(
    (item) => item.attempt.description === description,
  )?.attempt;
  if (requestedPart === null) {
    if (legacyPaid || paidUnits > 0n || openAttempts.some((item) => item.attempt !== outstanding)) {
      return { ok: false, status: 409, body: { error: 'A payment for this share is still open' } };
    }
  } else {
    let reservedUnits = paidUnits;
    let nextPartIndex = paidParts.reduce((next, part) => Math.max(next, part.partIndex + 1), 0);
    const immutableParts = new Map<number, { units: bigint; sats: number }>();
    for (const paidPart of paidParts) {
      immutableParts.set(paidPart.partIndex, { units: paidPart.units, sats: paidPart.sats });
    }
    for (const attempt of attempts) {
      const historical = parseRepaymentPartDescription(attempt.description);
      if (
        historical !== null &&
        historical.dayIndex === share.dayIndex &&
        historical.recipientAccountId === share.accountId
      ) {
        nextPartIndex = Math.max(nextPartIndex, historical.partIndex + 1);
      }
    }
    for (const open of openAttempts) {
      const part = open.part;
      const immutable = part === null ? undefined : immutableParts.get(part.partIndex);
      if (
        part === null ||
        part.shareUnits !== share.shareUnits ||
        immutable !== undefined ||
        (!isFiatCredit(opened.row) && open.attempt.amountSats !== Number(part.units))
      ) {
        return {
          ok: false,
          status: 409,
          body: { error: 'A payment for this share is still open' },
        };
      }
      immutableParts.set(part.partIndex, { units: part.units, sats: open.attempt.amountSats });
      reservedUnits += part.units;
    }
    if (
      legacyPaid ||
      reservedUnits > share.shareUnits ||
      (outstanding === undefined &&
        (requestedPart.partIndex !== nextPartIndex ||
          requestedPart.units > share.shareUnits - reservedUnits))
    ) {
      return { ok: false, status: 409, body: { error: 'A payment for this share is still open' } };
    }
  }
  if (
    outstanding !== undefined &&
    outstanding.pr !== null &&
    invoiceStillOpen(outstanding.pr, outstanding.createdAt.getTime(), opened.nowMs) &&
    outstanding.lightningAddress !== address
  ) {
    // Minted for an earlier receiving address and still payable: a second
    // invoice could pay the same share twice, so wait until it expires.
    return { ok: false, status: 409, body: { error: 'A payment for this share is still open' } };
  }
  if (
    outstanding !== undefined &&
    outstanding.pr !== null &&
    invoiceStillOpen(outstanding.pr, outstanding.createdAt.getTime(), opened.nowMs)
  ) {
    const storedRequest = normalizeSignedEvent(outstanding.zapRequest);
    const sparkInvoice =
      storedRequest === null
        ? null
        : await issueSparkInvoice(deps, receiving, {
            pr: outstanding.pr,
            paymentHash: outstanding.paymentHash,
            prAmountMsat: inspectBolt11(outstanding.pr)?.amountMsat ?? null,
            amountSats: outstanding.amountSats,
            zapRequestJson: serializeZapRequest(storedRequest as unknown as VerifiedEvent),
          });
    return { ok: true, pr: outstanding.pr, amountSats: outstanding.amountSats, sparkInvoice };
  }
  if (!mayMint()) {
    return { ok: false, status: 429, body: { error: 'Too many payments' } };
  }
  const unsigned = buildZapRequest({
    recipientPubkey,
    eventId: opened.row.eventId,
    amountMsat,
    relays: resolveZapRelays(process.env),
    content: description,
  });
  let signed;
  try {
    await ensureAccountNostrKey(deps.authStore, opened.account.id, kek);
    signed = await signEventForAccount(deps.authStore, opened.account.id, kek, unsigned);
  } catch {
    logEvent('nostr.sign.failed', { messageId: opened.row.id });
    return { ok: false, status: 503, body: { error: 'Messages are unavailable' } };
  }
  const zapRequestJson = serializeZapRequest(signed);
  const fetchImpl: FetchFn = deps.fetchImpl ?? fetch;
  const zap = await requestZapInvoice({
    address,
    amountMsat,
    zapRequestJson,
    fetchImpl: lnurlServerFetch(deps.lnurlServer, fetchImpl, deps.authStore),
  });
  if (!zap.ok) {
    if (zap.reason === 'noZap') {
      return {
        ok: false,
        status: 400,
        body: {
          error: "The recipient's wallet cannot receive this Bitcoin payment",
          code: CANNOT_RECEIVE,
        },
      };
    }
    return { ok: false, status: 400, body: { error: 'Could not start the Bitcoin payment' } };
  }
  const inspected = inspectBolt11(zap.pr);
  if (!isNip57Invoice(inspected?.descriptionHash ?? null, zapRequestJson)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "The recipient's wallet cannot receive this Bitcoin payment",
        code: CANNOT_RECEIVE,
      },
    };
  }
  const attempt: MessageInvoiceAttempt = {
    id: crypto.randomUUID(),
    createdAt: new Date(opened.nowMs),
    messageId: opened.row.id,
    payerAccountId: opened.account.id,
    authorAccountId: recipient.id,
    amountSats: share.sats,
    lightningAddress: address,
    zapRequest: signed as unknown as Record<string, unknown>,
    result: 'ok',
    httpStatus: 200,
    pr: zap.pr,
    paymentHash: inspected?.paymentHash ?? null,
    description,
    descriptionHash: inspected?.descriptionHash ?? null,
    isNip57Invoice: true,
    lnurlResponse: zap.lnurlResponse,
    conversationId: null,
    conversationMessageId: null,
    fiatPinned: false,
    amountUsd: null,
    amountChf: null,
    amountEur: null,
    amountPhp: null,
  };
  try {
    await deps.store.recordInvoiceAttempt(attempt);
  } catch {
    logEvent('message.invoice.record_failed');
    return { ok: false, status: 503, body: { error: 'Messages are unavailable' } };
  }
  const sparkInvoice = await issueSparkInvoice(deps, receiving, {
    pr: zap.pr,
    paymentHash: attempt.paymentHash,
    prAmountMsat: inspected?.amountMsat ?? null,
    amountSats: share.sats,
    zapRequestJson,
  });
  return { ok: true, pr: zap.pr, amountSats: share.sats, sparkInvoice };
}

/**
 * The pay routes' answer for a bill error (`Retry-After: 10` on 429).
 *
 * @param c - Request.
 * @param bill - The failed bill.
 * @returns The JSON error.
 */
function billError(c: Context, bill: Extract<RepaymentBill, { ok: false }>): Response {
  if (bill.status === 429) {
    c.header('Retry-After', '10');
  }
  return c.json(bill.body, bill.status);
}

/**
 * BOLT11 that pays the next giver who can receive their share, at that giver's
 * receiving address (`receivingAddress`), plus a Spark invoice for it when the
 * giver is wallet-backed.
 *
 * @param deps - Store, auth, clock, LNURL fetch, and the optional LNURL server and
 *   Spark invoice store.
 * @param c - Request.
 * @returns `{ pr, amountSats, sparkInvoice }`, or an error.
 */
export async function repaymentInvoice(deps: RepaymentDeps, c: Context): Promise<Response> {
  const opened = await openCredit(deps, c);
  if (opened instanceof Response) {
    return opened;
  }
  const payGate = requireAction(opened.account, 'forum.pay');
  if (!payGate.ok) {
    return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: payGate.missing }, 409);
  }
  return deps.store.withMessageLock(opened.row.id, async (locked) => {
    const row = await lockedCredit(locked, opened);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    opened.row = row;
    opened.nowMs = deps.now();
    const lockedDeps = { ...deps, store: locked };
    const next = await nextShare(lockedDeps, row, opened.nowMs);
    if (next.error !== null) {
      return c.json({ error: next.error }, next.status);
    }
    if (next.share === null) {
      return next.waiting
        ? c.json({ error: 'A giver has no Lightning address', code: CANNOT_RECEIVE }, 400)
        : c.json({ error: 'Nothing is due' }, 400);
    }
    const bill = await repaymentBillLocked(lockedDeps, opened, next.share, () =>
      repaymentLimiterOf(deps).allow(opened.account.id, opened.nowMs),
    );
    if (!bill.ok) {
      return billError(c, bill);
    }
    return c.json(
      { pr: bill.pr, amountSats: bill.amountSats, sparkInvoice: bill.sparkInvoice },
      200,
    );
  });
}

/** The open bill or unpaid remainder that a due route may bill for one share. */
function billableSharePart(share: ShareState): {
  units: bigint;
  description: string;
} {
  const open = share.openParts[0];
  if (open !== undefined) {
    return { units: open.units, description: open.description };
  }
  const units = share.units - share.paidUnits;
  return {
    units,
    description:
      units === share.units
        ? repaymentDescription(share.dayIndex, share.accountId)
        : repaymentPartDescription(
            share.dayIndex,
            share.accountId,
            share.nextPartIndex,
            units,
            share.units,
          ),
  };
}

/**
 * Bills for every due, unpaid share whose giver can receive (at most
 * {@link REPAYMENT_BILLS_MAX}), each made as `POST /messages/:id/repayment`
 * makes it, plus the due shares that wait for a giver who cannot receive.
 * A giver whose wallet refuses the zap is tried once per call; their other
 * shares wait too.
 *
 * @param deps - Same as {@link repaymentInvoice}.
 * @param c - Request.
 * @returns `{ bills, waiting }`, or an error.
 */
export async function repaymentDueBills(deps: RepaymentDeps, c: Context): Promise<Response> {
  const opened = await openCredit(deps, c);
  if (opened instanceof Response) {
    return opened;
  }
  const payGate = requireAction(opened.account, 'forum.pay');
  if (!payGate.ok) {
    return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: payGate.missing }, 409);
  }
  return deps.store.withMessageLock(opened.row.id, async (locked) => {
    const row = await lockedCredit(locked, opened);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    opened.row = row;
    opened.nowMs = deps.now();
    return repaymentDueBillsLocked({ ...deps, store: locked }, c, opened);
  });
}

/** Plan and reserve all due bills while the common message lock is held. */
async function repaymentDueBillsLocked(
  deps: RepaymentDeps,
  c: Context,
  opened: { account: Account; row: MessageRow; nowMs: number },
): Promise<Response> {
  const plan = await duePlan(deps, opened.row, opened.nowMs);
  if (plan === 'unavailable') {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  if (plan.due.length === 0) {
    return c.json({ bills: [], waiting: [] }, 200);
  }
  // A rate loader that fails is the same 503 as a missing rate.
  const price = await sharePricer(deps, opened.row).catch(() => null);
  if (price === null) {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  const fiat = isFiatCredit(opened.row);
  // One limiter hit per call, taken by the first bill that has to be minted.
  let minted: boolean | undefined;
  const mayMint = (): boolean => {
    minted ??= repaymentLimiterOf(deps).allow(opened.account.id, opened.nowMs);
    return minted;
  };
  const givers = new Map<string, ReturnType<typeof publicGiver>>();
  const giverOf = (accountId: string): ReturnType<typeof publicGiver> => {
    let giver = givers.get(accountId);
    if (giver === undefined) {
      giver = publicGiver(deps, accountId);
      givers.set(accountId, giver);
    }
    return giver;
  };
  // Givers whose wallet refused a zap in this call; their later shares wait.
  const refused = new Set<string>();
  const bills: Record<string, unknown>[] = [];
  const waiting: Record<string, unknown>[] = [];
  for (const share of plan.due) {
    const payable = share.canReceive && !refused.has(share.accountId);
    // A payable share past the cap comes on the next call; skip it before any work.
    if (payable && bills.length >= REPAYMENT_BILLS_MAX) {
      continue;
    }
    const waitingUnits = share.units - share.paidUnits;
    const waitingSats = price(waitingUnits);
    if (waitingSats === null) {
      return c.json({ error: 'Ask amount is unavailable' }, 503);
    }
    const giver = await giverOf(share.accountId);
    const waitingLine = {
      dayIndex: share.dayIndex,
      recipientAccountId: share.accountId,
      name: giver.name,
      username: giver.username,
      amountSats: waitingSats,
      amount: fiat ? formatCents(waitingUnits) : null,
    };
    if (!payable) {
      waiting.push(waitingLine);
      continue;
    }
    const part = billableSharePart(share);
    const sats = price(part.units) as number;
    const line = {
      dayIndex: share.dayIndex,
      recipientAccountId: share.accountId,
      name: giver.name,
      username: giver.username,
      amountSats: sats,
      amount: fiat ? formatCents(part.units) : null,
    };
    const bill = await repaymentBillLocked(
      deps,
      opened,
      {
        dayIndex: share.dayIndex,
        accountId: share.accountId,
        shareUnits: share.units,
        sats,
        description: part.description,
      },
      mayMint,
    );
    if (!bill.ok) {
      if (bill.body.code === CANNOT_RECEIVE) {
        refused.add(share.accountId);
        waiting.push(waitingLine);
        continue;
      }
      return billError(c, bill);
    }
    bills.push({
      ...line,
      amountSats: bill.amountSats,
      pr: bill.pr,
      sparkInvoice: bill.sparkInvoice,
    });
  }
  return c.json({ bills, waiting }, 200);
}

/** Parsed `POST /messages/:id/repayment/prepay` amount in loan units. */
type PrepayAmount = { units: bigint; typed: string };

const AMOUNT_TOO_HIGH_BODY = 'Amount is above what is left';
const INVALID_AMOUNT_BODY = 'Invalid amount';
const NOTHING_DUE_BODY = 'Nothing is due';
const OPEN_PAYMENT_BODY = 'A payment for this share is still open';
const TOO_MANY_SHARES_BODY = 'Too many shares for one payment';

/**
 * Whole sats from a BTC prepay amount string. Only digits are accepted.
 *
 * @param amount - Request body amount.
 * @returns Units and the typed string, or null.
 */
function btcPrepayAmount(amount: unknown): PrepayAmount | null {
  if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
    return null;
  }
  const units = BigInt(amount);
  return units > 0n ? { units, typed: amount } : null;
}

/**
 * Cents from a fiat prepay amount string with at most two decimals.
 * Comma and dot are both accepted; the typed text is kept for the echo.
 *
 * @param amount - Request body amount.
 * @returns Units and the exact typed decimal string, or null.
 */
function fiatPrepayAmount(amount: unknown): { units: bigint; typed: string } | null {
  if (typeof amount !== 'string') {
    return null;
  }
  const typed = amount;
  if (!/^[0-9]+(?:[.,][0-9]{1,2})?$/.test(typed)) {
    return null;
  }
  const normalized = typed.replace(',', '.');
  const units = fiatAmountToCents(normalized) as bigint;
  if (units <= 0n) {
    return null;
  }
  return { units, typed };
}

/**
 * One payment's worth of plan-order allocation, with open bills represented
 * as the same stored description that minted them.
 */
interface PrepayPlan {
  allocation: ReturnType<typeof allocateRepayment>;
  maxSats: number | null;
  maxAmount: string | null;
  price: (units: bigint) => number | null;
  fiat: boolean;
  shares: ShareState[];
}

/**
 * Read the current plan for a prepayment and allocate one amount.
 *
 * @param deps - Store, auth, rate loader, and optional LNURL server.
 * @param row - Funded credit.
 * @param nowMs - Clock.
 * @param amountUnits - Requested units.
 * @param maxParts - Maximum new bills.
 * @returns The allocation and max, or an error.
 */
async function prepayPlan(
  deps: RepaymentDeps,
  row: MessageRow,
  nowMs: number,
  amountUnits: bigint,
  maxParts: number,
): Promise<PrepayPlan | 'unavailable'> {
  const plan = await duePlan(deps, row, nowMs);
  if (plan === 'unavailable') {
    return 'unavailable';
  }
  const fiat = isFiatCredit(row);
  const price = await sharePricer(deps, row).catch(() => null);
  if (price === null) {
    return 'unavailable';
  }
  const maxUnits = plan.shares
    .filter((share) => share.canReceive && share.paidUnits < share.units)
    .reduce((sum, share) => sum + share.units - share.paidUnits, 0n);
  const allocation = allocateRepayment(
    amountUnits,
    plan.shares.map((share) => ({
      dayIndex: share.dayIndex,
      accountId: share.accountId,
      units: share.units,
      paidUnits: share.paidUnits,
      nextPartIndex: share.nextPartIndex,
      openParts: share.openParts,
      canReceive: share.canReceive,
    })),
    maxParts,
  );
  const maxSats = price(maxUnits);
  return {
    allocation,
    maxSats,
    maxAmount: fiat ? formatCents(maxUnits) : null,
    price,
    fiat,
    shares: plan.shares,
  };
}

/**
 * `POST /messages/:id/repayment/close`: end collecting on the caller's live
 * repayable ask. Sets `goal_closed_at`; a still-collecting ask also gets
 * `goal_funded_at` at the close instant. Idempotent.
 *
 * @param deps - Store, auth, and clock.
 * @param c - Request.
 * @returns The stored timestamps and collected total, or an error.
 */
export async function repaymentClose(deps: RepaymentDeps, c: Context): Promise<Response> {
  const opened = await openCredit(deps, c, { allowCollecting: true });
  if (opened instanceof Response) {
    return opened;
  }
  const payGate = requireAction(opened.account, 'forum.pay');
  if (!payGate.ok) {
    return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: payGate.missing }, 409);
  }
  return deps.store.withMessageLock(opened.row.id, async (locked) => {
    const row = await lockedCredit(locked, opened, true);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const lockedDeps = { ...deps, store: locked };
    const beforeClose = await creditOwed(lockedDeps, row);
    if (beforeClose.owed === 'unavailable' && row.goalFundedAt instanceof Date) {
      return c.json({ error: 'Ask amount is unavailable' }, 503);
    }
    const closed = await locked.closeCredit(row.id, new Date(deps.now()), true);
    if (closed === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const closedRow = await lockedCredit(locked, opened);
    if (closedRow === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    // An early fiat close freezes collected gift-time cents (including missing
    // snapshots as zero), so its final debt comes from the same locked state.
    const { owed } =
      row.goalFundedAt === null && isFiatCredit(row)
        ? await creditOwed(lockedDeps, closedRow)
        : beforeClose;
    if (owed === 'unavailable') {
      return c.json({ error: 'Ask amount is unavailable' }, 503);
    }
    // Debt stays bounded at funding. The close receipt is also immutable: an
    // idempotent call sees only receipts recorded through the first close.
    const fiat = isFiatCredit(closedRow);
    const collectedPayers = await locked.previewCreditPayerSnapshot(
      closedRow.id,
      fiat ? (closedRow.goalCurrency as GoalFiatCode) : 'USD',
      closed.closedAt,
    );
    const collectedUnits = collectedPayers.reduce((sum, payer) => sum + payer.units, 0n);
    const collectedSats =
      collectedPayers.reduce((sum, payer) => sum + payer.sats, 0) +
      (await locked.sumUnassignedCreditSats(closedRow.id, true, closed.closedAt));
    return c.json(
      {
        fundedAt: closed.fundedAt.toISOString(),
        closedAt: closed.closedAt.toISOString(),
        collectedSats,
        collectedAmount: fiat ? formatCents(collectedUnits) : null,
      },
      200,
    );
  });
}

/**
 * Largest amount up to the request that fits into {@link REPAYMENT_BILLS_MAX}
 * bills, counting open bills first. A share reached after the cap contributes
 * nothing.
 *
 * @param shares - Current plan shares in order.
 * @param requested - Requested units.
 * @returns Units covered by the first 60 parts.
 */
function cappedAllocation(shares: readonly ShareState[], requested: bigint): bigint {
  const allocation = allocateRepayment(
    requested,
    shares.map((share) => ({
      dayIndex: share.dayIndex,
      accountId: share.accountId,
      units: share.units,
      paidUnits: share.paidUnits,
      nextPartIndex: share.nextPartIndex,
      openParts: share.openParts,
      canReceive: share.canReceive,
    })),
    REPAYMENT_BILLS_MAX,
  );
  return allocation.parts.reduce((sum, part) => sum + part.units, 0n);
}

/**
 * `POST /messages/:id/repayment/prepay`: pay any amount up to the remaining
 * payable plan, in plan order. A still-collecting ask is closed first.
 *
 * @param deps - Store, auth, clock, rate loader, LNURL fetch, and optional Spark store.
 * @param c - Request.
 * @returns The bills and waiting shares, or an error.
 */
export async function repaymentPrepay(deps: RepaymentDeps, c: Context): Promise<Response> {
  const opened = await openCredit(deps, c, { allowCollecting: true });
  if (opened instanceof Response) {
    return opened;
  }
  const payGate = requireAction(opened.account, 'forum.pay');
  if (!payGate.ok) {
    return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: payGate.missing }, 409);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: INVALID_AMOUNT_BODY, code: 'invalid_amount' }, 400);
  }
  const amount =
    body !== null && typeof body === 'object' ? (body as { amount?: unknown }).amount : undefined;
  const fiat = isFiatCredit(opened.row);
  const parsed: PrepayAmount | null = fiat ? fiatPrepayAmount(amount) : btcPrepayAmount(amount);
  if (parsed === null) {
    return c.json({ error: INVALID_AMOUNT_BODY, code: 'invalid_amount' }, 400);
  }
  return deps.store.withMessageLock(opened.row.id, async (locked) => {
    const row = await lockedCredit(locked, opened, true);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    opened.row = row;
    opened.nowMs = deps.now();
    return repaymentPrepayLocked({ ...deps, store: locked }, c, opened, parsed);
  });
}

/** Close when needed, then plan and reserve a prepayment under one message lock. */
async function repaymentPrepayLocked(
  deps: RepaymentDeps,
  c: Context,
  opened: { account: Account; row: MessageRow; nowMs: number },
  parsed: PrepayAmount,
): Promise<Response> {
  if (opened.row.goalFundedAt === null && opened.row.goalClosedAt === null) {
    const closed = await deps.store.closeCredit(opened.row.id, new Date(deps.now()), true);
    if (closed === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const closedRow = await lockedCredit(deps.store, opened);
    // `closeCredit` succeeded while this message lock is still held, so the
    // same credit cannot disappear before this locked read completes.
    opened.row = closedRow!;
  }
  const plan = await prepayPlan(
    deps,
    opened.row,
    opened.nowMs,
    parsed.units,
    Number.MAX_SAFE_INTEGER,
  );
  if (plan === 'unavailable') {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  if (plan.maxSats === null) {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  if (plan.allocation.maxUnits === 0n) {
    return c.json({ error: NOTHING_DUE_BODY }, 400);
  }
  if (parsed.units > plan.allocation.maxUnits) {
    return c.json(
      {
        error: AMOUNT_TOO_HIGH_BODY,
        code: 'amount_too_high',
        maxSats: plan.maxSats,
        maxAmount: plan.maxAmount,
      },
      400,
    );
  }
  if (plan.allocation.openBillExceedsAmount) {
    return c.json({ error: OPEN_PAYMENT_BODY }, 409);
  }
  const initialShares = new Map(
    plan.shares.map((share) => [`${share.dayIndex}:${share.accountId}`, share]),
  );
  if (
    plan.allocation.parts.some(
      (part) => initialShares.get(`${part.dayIndex}:${part.accountId}`)?.legacyOpen === true,
    )
  ) {
    return c.json({ error: OPEN_PAYMENT_BODY }, 409);
  }
  if (plan.allocation.parts.length > REPAYMENT_BILLS_MAX) {
    const capped = cappedAllocation(plan.shares, parsed.units);
    const cappedSats = plan.price(capped);
    return c.json(
      {
        error: TOO_MANY_SHARES_BODY,
        code: 'too_many_shares',
        maxSats: cappedSats,
        maxAmount: plan.fiat ? formatCents(capped) : null,
      },
      400,
    );
  }
  for (const part of plan.allocation.parts) {
    if (part.open && part.description !== undefined) {
      const attempt = await deps.store.findOkInvoiceByDescription(opened.row.id, part.description);
      if (
        !plan.fiat &&
        attempt !== undefined &&
        attempt.pr !== null &&
        attempt.amountSats !== Number(part.units)
      ) {
        return c.json({ error: OPEN_PAYMENT_BODY }, 409);
      }
    }
  }
  let mintAllowed: boolean | undefined;
  const mayMint = (): boolean => {
    mintAllowed ??= repaymentLimiterOf(deps).allow(opened.account.id, opened.nowMs);
    return mintAllowed;
  };
  const givers = new Map<string, ReturnType<typeof publicGiver>>();
  const giverOf = (accountId: string): ReturnType<typeof publicGiver> => {
    let giver = givers.get(accountId);
    if (giver === undefined) {
      giver = publicGiver(deps, accountId);
      givers.set(accountId, giver);
    }
    return giver;
  };
  const refused = new Set<string>();
  const shares = new Map(
    plan.shares.map((share) => [`${share.dayIndex}:${share.accountId}`, share]),
  );
  const allocationShares = (): Parameters<typeof allocateRepayment>[1] =>
    plan.shares.map((share) => ({
      dayIndex: share.dayIndex,
      accountId: share.accountId,
      units: share.units,
      paidUnits: share.paidUnits,
      nextPartIndex: share.nextPartIndex,
      openParts: share.openParts,
      canReceive: share.canReceive && !refused.has(share.accountId),
    }));
  const partKey = (part: (typeof plan.allocation.parts)[number]): string =>
    `${part.dayIndex}:${part.accountId}:${part.partIndex}:${part.units.toString()}`;
  const completed = new Map<string, Record<string, unknown>>();
  const completedParts = new Map<string, (typeof plan.allocation.parts)[number]>();
  const fixedUnitsForShare = (dayIndex: number, accountId: string): bigint =>
    [...completedParts.values()]
      .filter((part) => part.dayIndex === dayIndex && part.accountId === accountId)
      .reduce((sum, part) => sum + part.units, 0n);
  let allocation = plan.allocation;
  allocationLoop: while (true) {
    for (const part of allocation.parts) {
      const key = partKey(part);
      const share = shares.get(`${part.dayIndex}:${part.accountId}`) as ShareState;
      const sats = plan.price(part.units) as number;
      const giver = await giverOf(part.accountId);
      const line = {
        dayIndex: part.dayIndex,
        recipientAccountId: part.accountId,
        name: giver.name,
        username: giver.username,
        amountSats: sats,
        amount: plan.fiat ? formatCents(part.units) : null,
      };
      const bill = await repaymentBillLocked(
        deps,
        opened,
        {
          dayIndex: part.dayIndex,
          accountId: part.accountId,
          shareUnits: share.units,
          sats,
          description:
            part.description ??
            repaymentPartDescription(
              part.dayIndex,
              part.accountId,
              part.partIndex,
              part.units,
              share.units,
            ),
        },
        mayMint,
      );
      if (!bill.ok) {
        if (bill.body.code === CANNOT_RECEIVE) {
          refused.add(part.accountId);
          const fixedUnits = [...completedParts.values()].reduce(
            (sum, completedPart) => sum + completedPart.units,
            0n,
          );
          const remainingUnits = parsed.units - fixedUnits;
          const remainingBillSlots = Math.max(0, REPAYMENT_BILLS_MAX - completedParts.size);
          const replacement = allocateRepayment(
            remainingUnits,
            allocationShares().map((allocationShare) => {
              const fixed = fixedUnitsForShare(allocationShare.dayIndex, allocationShare.accountId);
              const completedIndexes = new Set(
                [...completedParts.values()]
                  .filter(
                    (completedPart) =>
                      completedPart.dayIndex === allocationShare.dayIndex &&
                      completedPart.accountId === allocationShare.accountId,
                  )
                  .map((completedPart) => completedPart.partIndex),
              );
              return {
                ...allocationShare,
                paidUnits: allocationShare.paidUnits + fixed,
                nextPartIndex: Math.max(
                  allocationShare.nextPartIndex,
                  ...[...completedParts.values()]
                    .filter(
                      (completedPart) =>
                        completedPart.dayIndex === allocationShare.dayIndex &&
                        completedPart.accountId === allocationShare.accountId,
                    )
                    .map((completedPart) => completedPart.partIndex + 1),
                ),
                openParts: allocationShare.openParts.filter(
                  (openPart) => !completedIndexes.has(openPart.partIndex),
                ),
              };
            }),
            remainingBillSlots,
          );
          if (
            replacement.parts.length === remainingBillSlots &&
            replacement.usedUnits < remainingUnits
          ) {
            allocation = { ...replacement, parts: [] };
            break allocationLoop;
          }
          allocation = replacement;
          continue allocationLoop;
        }
        return billError(c, bill);
      }
      completed.set(key, {
        ...line,
        amountSats: bill.amountSats,
        pr: bill.pr,
        sparkInvoice: bill.sparkInvoice,
      });
      completedParts.set(key, part);
    }
    break;
  }
  const finalPartMap = new Map(allocation.parts.map((part) => [partKey(part), part] as const));
  for (const [key, part] of completedParts) {
    finalPartMap.set(key, part);
  }
  const finalParts = [...finalPartMap.values()].sort((a, b) => {
    const aOrder = plan.shares.findIndex(
      (share) => share.dayIndex === a.dayIndex && share.accountId === a.accountId,
    );
    const bOrder = plan.shares.findIndex(
      (share) => share.dayIndex === b.dayIndex && share.accountId === b.accountId,
    );
    return aOrder - bOrder || a.partIndex - b.partIndex;
  });
  const bills = finalParts.map((part) => completed.get(partKey(part)) as Record<string, unknown>);
  const waiting: Record<string, unknown>[] = [];
  for (const share of allocation.waiting) {
    const sats = plan.price(share.units) as number;
    const giver = await giverOf(share.accountId);
    waiting.push({
      dayIndex: share.dayIndex,
      recipientAccountId: share.accountId,
      name: giver.name,
      username: giver.username,
      amountSats: sats,
      amount: plan.fiat ? formatCents(share.units) : null,
    });
  }
  const amountSats = bills.reduce((sum, bill) => sum + Number(bill['amountSats']), 0);
  return c.json(
    {
      amountSats,
      amount: plan.fiat ? parsed.typed : null,
      bills,
      waiting,
    },
    200,
  );
}

async function openCredit(
  deps: RepaymentDeps,
  c: Context,
  options?: { allowCollecting?: boolean },
): Promise<Response | { account: Account; row: MessageRow; nowMs: number }> {
  const token = bearerToken(c.req.header('authorization'));
  if (token === null) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const account = await resolveSession(deps.authStore, deps.now(), token);
  if (account === null) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const id = c.req.param('id') as string;
  if (!MESSAGE_ID_RE.test(id)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const row = await deps.store.getById(id);
  if (
    row === undefined ||
    row.deletedAt !== null ||
    row.goalRepayable !== true ||
    row.goalTermDays === null ||
    /* v8 ignore next -- copyRow stores null, never undefined */
    row.goalTermDays === undefined ||
    (options?.allowCollecting !== true &&
      (row.goalFundedAt === null ||
        /* v8 ignore next -- copyRow stores null, never undefined */
        row.goalFundedAt === undefined)) ||
    row.accountId !== account.id
  ) {
    return c.json({ error: 'Not found' }, 404);
  }
  return { account, row, nowMs: deps.now() };
}

/**
 * The oldest due, unpaid share whose giver can receive. Shares of a giver who
 * cannot receive are skipped; `waiting` says some were. A due share that
 * cannot be priced (a fiat loan with no rate, or a rate loader that fails) is
 * 503, whoever its giver is.
 */
async function nextShare(
  deps: RepaymentDeps,
  row: MessageRow,
  nowMs: number,
): Promise<{
  daysDue: number;
  daysPaid: number;
  share: {
    dayIndex: number;
    accountId: string;
    sats: number;
    description: string;
    units: bigint;
    shareUnits: bigint;
    partIndex: number;
  } | null;
  waiting: boolean;
  error: string | null;
  status: 400 | 503;
}> {
  const plan = await duePlan(deps, row, nowMs);
  if (plan === 'unavailable') {
    return {
      daysDue: dueDayCount(
        (row.goalFundedAt as Date).getTime(),
        nowMs,
        row.goalTermDays as number,
        row.id,
      ),
      daysPaid: 0,
      share: null,
      waiting: false,
      error: 'Ask amount is unavailable',
      status: 503,
    };
  }
  const { daysDue, daysPaid } = plan;
  if (plan.due.length === 0) {
    return { daysDue, daysPaid, share: null, waiting: false, error: null, status: 400 };
  }
  // Every due share needs a price, whether or not its giver can receive. A rate
  // loader that fails is the same 503 as a missing rate.
  const price = await sharePricer(deps, row).catch(() => null);
  if (price === null || plan.due.some((share) => price(share.units) === null)) {
    return {
      daysDue,
      daysPaid,
      share: null,
      waiting: false,
      error: 'Ask amount is unavailable',
      status: 503,
    };
  }
  const payable = plan.due.find((share) => share.canReceive && share.paidUnits < share.units);
  if (payable === undefined) {
    return { daysDue, daysPaid, share: null, waiting: true, error: null, status: 400 };
  }
  const openPart = payable.openParts[0];
  const units = openPart === undefined ? payable.units - payable.paidUnits : openPart.units;
  const sats = price(units) as number;
  return {
    daysDue,
    daysPaid,
    share: {
      dayIndex: payable.dayIndex,
      accountId: payable.accountId,
      sats,
      description:
        openPart?.description ??
        (openPart === undefined && units === payable.units
          ? repaymentDescription(payable.dayIndex, payable.accountId)
          : repaymentPartDescription(
              payable.dayIndex,
              payable.accountId,
              payable.nextPartIndex,
              units,
              payable.units,
            )),
      units,
      shareUnits: payable.units,
      partIndex: openPart?.partIndex ?? payable.nextPartIndex,
    },
    waiting: false,
    error: null,
    status: 400,
  };
}

/** What `GET /me/loans` needs. */
export type MyLoansRouteDeps = Pick<
  RepaymentDeps,
  'store' | 'authStore' | 'now' | 'goalRateDay' | 'lnurlServer'
>;

/**
 * Sum of priced shares, or null when one has no price.
 *
 * @param price - Units → sats.
 * @param shares - Shares to price.
 * @returns Sats, or null.
 */
function pricedSum(
  price: (units: bigint) => number | null,
  shares: readonly { units: bigint }[],
): number | null {
  let total = 0;
  for (const share of shares) {
    const sats = price(share.units);
    if (sats === null) {
      return null;
    }
    total += sats;
  }
  return total;
}

/**
 * One row of `GET /me/loans`, or null when the loan is fully repaid.
 *
 * @param deps - Store, auth, rate loader, and the optional LNURL server.
 * @param row - Live repayable ask of the caller.
 * @param nowMs - Clock.
 * @returns The row, null, or `unavailable` when the debt cannot be computed.
 */
async function loanRow(
  deps: MyLoansRouteDeps,
  row: MessageRow,
  nowMs: number,
): Promise<Record<string, unknown> | null | 'unavailable'> {
  const fiat = isFiatCredit(row);
  const cents = (units: bigint): string | null => (fiat ? formatCents(units) : null);
  const fundedAt = row.goalFundedAt instanceof Date ? row.goalFundedAt : null;
  const base = {
    messageId: row.id,
    text: Array.from(row.text).slice(0, LOAN_TEXT_CHARS).join(''),
    createdAt: row.createdAt.toISOString(),
    // A repayable ask always stores goal_sats (message_goal_repayable_chk).
    goalSats: row.goalSats as number,
    sats: row.sats,
    goalCurrency: row.goalCurrency ?? 'BTC',
    goalAmount: row.goalAmount ?? String(row.goalSats),
    goalAmountUsd: row.goalAmountUsd ?? null,
    goalAmountChf: row.goalAmountChf ?? null,
    goalAmountEur: row.goalAmountEur ?? null,
    goalAmountPhp: row.goalAmountPhp ?? null,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
    termDays: row.goalTermDays,
    fundedAt: fundedAt === null ? null : fundedAt.toISOString(),
    closedAt: row.goalClosedAt instanceof Date ? row.goalClosedAt.toISOString() : null,
  };
  if (fundedAt === null) {
    let named: { accountId: string; units: bigint }[];
    if (fiat) {
      named = (
        await deps.store.previewCreditPayerSnapshot(
          row.id,
          row.goalCurrency as GoalFiatCode,
          new Date(nowMs),
        )
      ).map((payer) => ({ accountId: payer.accountId, units: payer.units }));
    } else {
      const { owed } = await creditOwed(deps, row);
      // Sats with no account are not repaid, as in the schedule.
      named = (owed as { accountId: string; units: bigint }[]).filter(
        (payer) => payer.accountId !== '',
      );
    }
    const receivers = await receiverMap(
      deps,
      named.map((payer) => payer.accountId),
    );
    const payable = named.filter((payer) => receivers.get(payer.accountId) !== null);
    // The rate is read only when there is a debt to price. A failing loader is 503; a missing rate leaves sats null.
    const price = named.length === 0 ? undefined : await sharePricer(deps, row).catch(() => null);
    if (price === null) {
      return 'unavailable';
    }
    const maxUnits = payable.reduce((sum, payer) => sum + payer.units, 0n);
    return {
      ...base,
      daysDue: 0,
      daysPaid: 0,
      repaidSats: 0,
      totalSats: price === undefined ? 0 : pricedSum(price, named),
      maxSats: price === undefined ? 0 : price(maxUnits),
      maxAmount: cents(maxUnits),
      due: {
        payableSats: 0,
        payableAmount: cents(0n),
        payablePeople: 0,
        waitingSats: 0,
        waitingAmount: cents(0n),
        waitingPeople: 0,
        waitingShares: 0,
        behindDays: 0,
        lastPayment: false,
      },
      next: null,
    };
  }
  const plan = await duePlan(deps, row, nowMs);
  if (plan === 'unavailable') {
    return 'unavailable';
  }
  const open = plan.shares.filter((share) => share.paidUnits < share.units);
  if (open.length === 0) {
    return null;
  }
  // Read the rate only now: a repaid loan is left out without it. A failing loader is 503; a missing rate leaves sats null.
  const price = await sharePricer(deps, row).catch(() => null);
  if (price === null) {
    return 'unavailable';
  }
  const paidParts = await deps.store.listRepaymentParts(row.id);
  const partKeys = new Set(paidParts.map((part) => `${part.dayIndex}:${part.recipientAccountId}`));
  const legacyRepaidSats = plan.paid
    .filter((item) => !partKeys.has(`${item.dayIndex}:${item.recipientAccountId}`))
    .reduce((sum, item) => sum + item.dueSats, 0);
  const repaidSats = paidParts.reduce((sum, part) => sum + part.sats, legacyRepaidSats);
  const openSats = pricedSum(
    price,
    open.map((share) => ({ units: share.units - share.paidUnits })),
  );
  const payable = plan.due.filter((share) => share.canReceive);
  const waiting = plan.due.filter((share) => !share.canReceive);
  const remainderUnits = (shares: readonly ShareState[]): bigint =>
    shares.reduce((sum, share) => sum + share.units - share.paidUnits, 0n);
  const people = (shares: readonly { accountId: string }[]): number =>
    new Set(shares.map((share) => share.accountId)).size;
  const today = Math.floor((nowMs - repaymentStartMs(fundedAt.getTime(), row.id)) / 86_400_000);
  const behind = new Set(
    plan.due
      .filter((share) => !share.excused && share.dayIndex < today)
      .map((share) => share.dayIndex),
  );
  const nextDay = open.find((share) => share.dayIndex >= plan.daysDue)?.dayIndex;
  const nextShares = open.filter((share) => share.dayIndex === nextDay);
  const maxUnits = open
    .filter((share) => share.canReceive)
    .reduce((sum, share) => sum + share.units - share.paidUnits, 0n);
  return {
    ...base,
    daysDue: plan.daysDue,
    daysPaid: plan.daysPaid,
    repaidSats,
    totalSats: openSats === null ? null : repaidSats + openSats,
    maxSats: price(maxUnits),
    maxAmount: cents(maxUnits),
    due: {
      payableSats: pricedSum(
        price,
        payable.map((share) => ({ units: share.units - share.paidUnits })),
      ),
      payableAmount: cents(remainderUnits(payable)),
      payablePeople: people(payable),
      waitingSats: pricedSum(
        price,
        waiting.map((share) => ({ units: share.units - share.paidUnits })),
      ),
      waitingAmount: cents(remainderUnits(waiting)),
      waitingPeople: people(waiting),
      waitingShares: waiting.length,
      behindDays: behind.size,
      lastPayment: payable.length > 0 && payable.length === open.length,
    },
    next:
      nextDay === undefined
        ? null
        : {
            dueOn: repaymentDueDate(fundedAt.getTime(), nextDay, row.id),
            sats: pricedSum(
              price,
              nextShares.map((share) => ({ units: share.units - share.paidUnits })),
            ),
            amount: cents(remainderUnits(nextShares)),
          },
  };
}

/**
 * Due, unpaid shares owed to a caller who cannot receive, over every live
 * funded loan the caller gave to: found through the caller's in-app invoices,
 * kept only when the caller is one of its payers.
 *
 * @param deps - Store, auth, rate loader, and the optional LNURL server.
 * @param account - The caller.
 * @param nowMs - Clock.
 * @returns Share and loan counts and their sats (null when a fiat share has no
 *   rate), or `unavailable` when a loan's debt cannot be computed.
 */
async function lenderWaiting(
  deps: MyLoansRouteDeps,
  account: Account,
  nowMs: number,
): Promise<{ shares: number; loans: number; sats: number | null } | 'unavailable'> {
  if (receivingAddress(account, deps.lnurlServer) !== null) {
    return { shares: 0, loans: 0, sats: 0 };
  }
  const invoices = await deps.store.listInvoiceAttemptsForPayer(account.id);
  const messageIds = new Set(
    invoices
      .filter((invoice) => parseRepaymentDescription(invoice.description) === null)
      .map((invoice) => invoice.messageId),
  );
  let shares = 0;
  const loanSats: (number | null)[] = [];
  for (const id of messageIds) {
    const row = await deps.store.getById(id);
    if (
      row === undefined ||
      row.deletedAt !== null ||
      row.goalRepayable !== true ||
      typeof row.goalTermDays !== 'number' ||
      !(row.goalFundedAt instanceof Date)
    ) {
      continue;
    }
    const payers = await deps.store.listCreditPayers(id);
    if (!payers.some((payer) => payer.accountId === account.id)) {
      continue;
    }
    const plan = await duePlan(deps, row, nowMs);
    if (plan === 'unavailable') {
      return 'unavailable';
    }
    const mine = plan.due.filter((share) => share.accountId === account.id);
    if (mine.length === 0) {
      continue;
    }
    const price = await sharePricer(deps, row).catch(() => null);
    if (price === null) {
      return 'unavailable';
    }
    shares += mine.length;
    loanSats.push(pricedSum(price, mine));
  }
  return {
    shares,
    loans: loanSats.length,
    sats: loanSats.includes(null)
      ? null
      : loanSats.reduce<number>((sum, sats) => sum + (sats as number), 0),
  };
}

/**
 * `GET /me/loans`: the caller's live repayable asks that are still collecting
 * or not fully repaid, newest first, with what is due now.
 *
 * @param deps - Store, auth, clock, rate loader, and the optional LNURL server.
 * @returns A Hono app with `GET /me/loans`.
 */
export function myLoansRoutes(deps: MyLoansRouteDeps): Hono {
  return new Hono().get('/me/loans', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const account = token === null ? null : await resolveSession(deps.authStore, deps.now(), token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const nowMs = deps.now();
    const oneRate = withOneRate(deps);
    try {
      const authored = await deps.store.listAuthoredMessages(account.id);
      const loans: Record<string, unknown>[] = [];
      for (const row of authored) {
        if (
          row.parentId !== null ||
          row.deletedAt !== null ||
          row.goalRepayable !== true ||
          typeof row.goalTermDays !== 'number'
        ) {
          continue;
        }
        const loan = await loanRow(oneRate, row, nowMs);
        if (loan === 'unavailable') {
          return c.json({ error: 'Ask amount is unavailable' }, 503);
        }
        if (loan !== null) {
          loans.push(loan);
        }
      }
      const waiting = await lenderWaiting(oneRate, account, nowMs);
      if (waiting === 'unavailable') {
        return c.json({ error: 'Ask amount is unavailable' }, 503);
      }
      return c.json(
        {
          sundayRest: isSundayRestHeader(nowMs, c.req.header('Time-Zone')),
          loans,
          lenderWaiting: waiting,
        },
        200,
      );
    } catch {
      logEvent('me.loans.failed');
      return c.json({ error: 'Messages are unavailable' }, 503);
    }
  });
}

const FIAT_CURRENCIES = new Set(['USD', 'CHF', 'EUR', 'PHP']);

function isFiatCredit(row: MessageRow): boolean {
  return FIAT_CURRENCIES.has(row.goalCurrency ?? '');
}
