import { Hono, type Context } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import {
  dueDayCount,
  formatCents,
  payerDebtUnits,
  repaymentDescription,
  repaymentDueDate,
  repaymentLedger,
  repaymentSchedule,
  repaymentStartMs,
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
const DEFAULT_INVOICE_EXPIRY_MS = 3_600_000;

/**
 * Whether a stored BOLT11 can still be paid. An invoice that does not decode
 * uses the one-hour default.
 *
 * @param pr - Stored invoice.
 * @param createdAtMs - When the attempt was recorded.
 * @param nowMs - Clock.
 * @returns False once the invoice has expired.
 */
function invoiceStillOpen(pr: string, createdAtMs: number, nowMs: number): boolean {
  const seconds = inspectBolt11(pr)?.expirySeconds;
  const expiryMs = typeof seconds === 'number' ? seconds * 1000 : DEFAULT_INVOICE_EXPIRY_MS;
  return nowMs < createdAtMs + expiryMs;
}

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
   * module limiter (1/10s, 20/h).
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
 * snapshot is missing, and that weight is not repaid.
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
  return {
    payers,
    unassignedSats,
    owed: payerDebtUnits(row.goalCurrency, row.goalAmount, [
      ...payers,
      { accountId: '', sats: unassignedSats },
    ]),
  };
}

/** Most bills one `POST /messages/:id/repayment/due` makes; the rest come on the next call. */
export const REPAYMENT_BILLS_MAX = 60;

/** Characters of the note text in a `GET /me/loans` row. */
const LOAN_TEXT_CHARS = 160;

/** One due, unpaid share, and whether its giver can receive right now. */
interface DueShare {
  dayIndex: number;
  accountId: string;
  /** Whole sats or whole cents. */
  units: bigint;
  canReceive: boolean;
}

/** Schedule state of one funded credit at `nowMs`. */
interface DuePlan {
  daysDue: number;
  /** Leading due days with no unpaid share. */
  daysPaid: number;
  schedule: RepaymentSlice[];
  paid: Awaited<ReturnType<MessageStore['listRepayments']>>;
  /** Due, unpaid shares: oldest day first, then schedule order. */
  due: DueShare[];
}

/**
 * Whether each account can receive (`receivingAddress(...) !== null`).
 *
 * @param deps - Auth store and the optional LNURL server.
 * @param accountIds - Accounts to check; repeats are read once.
 * @returns Account id → can receive.
 */
async function receiverMap(
  deps: RepaymentDeps,
  accountIds: readonly string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (const id of accountIds) {
    if (!result.has(id)) {
      const account = await deps.authStore.getAccount(id);
      result.set(id, account !== undefined && receivingAddress(account, deps.lnurlServer) !== null);
    }
  }
  return result;
}

/**
 * Due, unpaid shares of a funded credit.
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
  const daysDue = dueDayCount(fundedAt.getTime(), nowMs, termDays);
  const paid = await deps.store.listRepayments(row.id);
  const { owed } = await creditOwed(deps, row);
  if (owed === 'unavailable') {
    return 'unavailable';
  }
  const schedule = repaymentSchedule(termDays, owed);
  const settled = new Set(paid.map((item) => `${item.dayIndex}:${item.recipientAccountId}`));
  const unpaid = schedule.filter(
    (slice) => slice.dayIndex < daysDue && !settled.has(`${slice.dayIndex}:${slice.accountId}`),
  );
  const receivers = await receiverMap(
    deps,
    unpaid.map((slice) => slice.accountId),
  );
  let daysPaid = 0;
  while (daysPaid < daysDue && !unpaid.some((slice) => slice.dayIndex === daysPaid)) {
    daysPaid += 1;
  }
  return {
    daysDue,
    daysPaid,
    schedule,
    paid,
    due: unpaid.map((slice) => ({
      dayIndex: slice.dayIndex,
      accountId: slice.accountId,
      units: slice.units,
      canReceive: receivers.get(slice.accountId) as boolean,
    })),
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
 * @param deps - Store, auth, and clock.
 * @param c - Request. No session is required.
 * @returns The givers and the plan, or an error.
 */
export async function repaymentStatus(deps: RepaymentDeps, c: Context): Promise<Response> {
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
  const fundedAt = row.goalFundedAt instanceof Date ? row.goalFundedAt : null;
  const lines = repaymentLedger(
    row.goalTermDays as number,
    owed,
    paid.map((item) => ({ dayIndex: item.dayIndex, accountId: item.recipientAccountId })),
    fundedAt === null ? null : fundedAt.getTime(),
    nowMs,
  );
  const names = new Map<string, { name: string; username: string | null; canReceive: boolean }>();
  for (const payer of payers) {
    names.set(payer.accountId, await publicGiver(deps, payer.accountId));
  }
  const owedById = new Map(owed.map((payer) => [payer.accountId, payer.units]));
  const fiat = isFiatCredit(row);
  const paidSats = new Map(
    paid.map((item) => [`${item.dayIndex}:${item.recipientAccountId}`, item.dueSats]),
  );
  let daysDue = 0;
  let daysPaid = 0;
  let next: { dayIndex: number; sats: number; recipientAccountId: string } | null = null;
  if (fundedAt !== null) {
    const share = await nextShare(deps, row, nowMs);
    if (share.error !== null) {
      return c.json({ error: share.error }, share.status);
    }
    daysDue = share.daysDue;
    daysPaid = share.daysPaid;
    next =
      share.share === null
        ? null
        : {
            dayIndex: share.share.dayIndex,
            sats: share.share.sats,
            recipientAccountId: share.share.accountId,
          };
  }
  const price = lines.some((line) => line.status === 'due') ? await sharePricer(deps, row) : null;
  return c.json(
    {
      currency: fiat ? row.goalCurrency : 'BTC',
      fundedAt: fundedAt === null ? null : fundedAt.toISOString(),
      termDays: row.goalTermDays,
      daysDue,
      daysPaid,
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
        const settled = paidSats.get(`${line.dayIndex}:${line.accountId}`);
        return {
          dayIndex: line.dayIndex,
          dueOn: line.dueOn,
          accountId: line.accountId,
          name: identity.name,
          username: identity.username,
          amount: fiat ? formatCents(line.units) : null,
          sats: fiat ? (settled ?? null) : Number(line.units),
          status: line.status,
          via: 'lightning',
          dueSats: line.status === 'due' && price !== null ? price(line.units) : null,
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

/** A bill for one share, or the error the pay route answers. */
type RepaymentBill =
  | { ok: true; pr: string; amountSats: number; sparkInvoice: string | null }
  | {
      ok: false;
      status: 400 | 409 | 429 | 503;
      body: { error: string; code?: typeof CANNOT_RECEIVE };
    };

/**
 * Bill for one share at the giver's receiving address: the open, still
 * payable bill for that share when there is one, else a new zap request,
 * BOLT11, stored invoice row, and Spark invoice.
 *
 * @param deps - Store, auth, LNURL fetch, and the optional LNURL server and Spark store.
 * @param opened - Author, credit, and clock.
 * @param share - Day, giver, and sats.
 * @param mayMint - Asked only before a new bill is minted; false is a 429.
 * @returns The bill, or the error.
 */
async function repaymentBill(
  deps: RepaymentDeps,
  opened: { account: Account; row: MessageRow; nowMs: number },
  share: { dayIndex: number; accountId: string; sats: number },
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
  const description = repaymentDescription(share.dayIndex, share.accountId);
  const outstanding = await deps.store.findOkInvoiceByDescription(opened.row.id, description);
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
  const next = await nextShare(deps, opened.row, opened.nowMs);
  if (next.error !== null) {
    return c.json({ error: next.error }, next.status);
  }
  if (next.share === null) {
    return next.waiting
      ? c.json({ error: 'A giver has no Lightning address', code: CANNOT_RECEIVE }, 400)
      : c.json({ error: 'Nothing is due' }, 400);
  }
  const bill = await repaymentBill(deps, opened, next.share, () =>
    repaymentLimiterOf(deps).allow(opened.account.id, opened.nowMs),
  );
  if (!bill.ok) {
    return billError(c, bill);
  }
  return c.json({ pr: bill.pr, amountSats: bill.amountSats, sparkInvoice: bill.sparkInvoice }, 200);
}

/**
 * Bills for every due, unpaid share whose giver can receive (at most
 * {@link REPAYMENT_BILLS_MAX}), each made as `POST /messages/:id/repayment`
 * makes it, plus the due shares that wait for a giver who cannot receive.
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
  const plan = await duePlan(deps, opened.row, opened.nowMs);
  if (plan === 'unavailable') {
    return c.json({ error: 'Ask amount is unavailable' }, 503);
  }
  const price = await sharePricer(deps, opened.row);
  const fiat = isFiatCredit(opened.row);
  // One limiter hit per call, taken by the first bill that has to be minted.
  let minted: boolean | undefined;
  const mayMint = (): boolean => {
    minted ??= repaymentLimiterOf(deps).allow(opened.account.id, opened.nowMs);
    return minted;
  };
  const bills: Record<string, unknown>[] = [];
  const waiting: Record<string, unknown>[] = [];
  for (const share of plan.due) {
    const sats = price(share.units);
    if (sats === null) {
      return c.json({ error: 'Ask amount is unavailable' }, 503);
    }
    const giver = await publicGiver(deps, share.accountId);
    const line = {
      dayIndex: share.dayIndex,
      recipientAccountId: share.accountId,
      name: giver.name,
      username: giver.username,
      amountSats: sats,
      amount: fiat ? formatCents(share.units) : null,
    };
    if (!share.canReceive) {
      waiting.push(line);
      continue;
    }
    if (bills.length >= REPAYMENT_BILLS_MAX) {
      continue;
    }
    const bill = await repaymentBill(deps, opened, { ...share, sats }, mayMint);
    if (!bill.ok) {
      if (bill.body.code === CANNOT_RECEIVE) {
        waiting.push(line);
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

async function openCredit(
  deps: RepaymentDeps,
  c: Context,
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
    row.goalFundedAt === null ||
    /* v8 ignore next -- copyRow stores null, never undefined */
    row.goalFundedAt === undefined ||
    row.accountId !== account.id
  ) {
    return c.json({ error: 'Not found' }, 404);
  }
  return { account, row, nowMs: deps.now() };
}

/**
 * The oldest due, unpaid share whose giver can receive. Shares of a giver who
 * cannot receive are skipped; `waiting` says some were.
 */
async function nextShare(
  deps: RepaymentDeps,
  row: MessageRow,
  nowMs: number,
): Promise<{
  daysDue: number;
  daysPaid: number;
  share: { dayIndex: number; accountId: string; sats: number } | null;
  waiting: boolean;
  error: string | null;
  status: 400 | 503;
}> {
  const plan = await duePlan(deps, row, nowMs);
  if (plan === 'unavailable') {
    return {
      daysDue: dueDayCount((row.goalFundedAt as Date).getTime(), nowMs, row.goalTermDays as number),
      daysPaid: 0,
      share: null,
      waiting: false,
      error: 'Ask amount is unavailable',
      status: 503,
    };
  }
  const { daysDue, daysPaid } = plan;
  const payable = plan.due.find((share) => share.canReceive);
  if (payable === undefined) {
    return {
      daysDue,
      daysPaid,
      share: null,
      waiting: plan.due.length > 0,
      error: null,
      status: 400,
    };
  }
  const sats = (await sharePricer(deps, row))(payable.units);
  if (sats === null) {
    return {
      daysDue,
      daysPaid,
      share: null,
      waiting: false,
      error: 'Ask amount is unavailable',
      status: 503,
    };
  }
  return {
    daysDue,
    daysPaid,
    share: { dayIndex: payable.dayIndex, accountId: payable.accountId, sats },
    waiting: false,
    error: null,
    status: 400,
  };
}

/** What `GET /me/loans` needs. */
export type MyLoansDeps = Pick<
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
  deps: MyLoansDeps,
  row: MessageRow,
  nowMs: number,
): Promise<Record<string, unknown> | null | 'unavailable'> {
  const fiat = isFiatCredit(row);
  const cents = (units: bigint): string | null => (fiat ? formatCents(units) : null);
  const price = await sharePricer(deps, row);
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
  };
  if (fundedAt === null) {
    const { owed } = await creditOwed(deps, row);
    if (owed === 'unavailable') {
      return 'unavailable';
    }
    return {
      ...base,
      daysDue: 0,
      daysPaid: 0,
      repaidSats: 0,
      totalSats: pricedSum(price, owed),
      due: {
        payableSats: 0,
        payableAmount: cents(0n),
        payablePeople: 0,
        waitingSats: 0,
        waitingAmount: cents(0n),
        waitingPeople: 0,
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
  const settled = new Set(plan.paid.map((item) => `${item.dayIndex}:${item.recipientAccountId}`));
  const open = plan.schedule.filter(
    (slice) => !settled.has(`${slice.dayIndex}:${slice.accountId}`),
  );
  if (open.length === 0) {
    return null;
  }
  const repaidSats = plan.paid.reduce((sum, item) => sum + item.dueSats, 0);
  const openSats = pricedSum(price, open);
  const payable = plan.due.filter((share) => share.canReceive);
  const waiting = plan.due.filter((share) => !share.canReceive);
  const units = (shares: readonly { units: bigint }[]): bigint =>
    shares.reduce((sum, share) => sum + share.units, 0n);
  const people = (shares: readonly { accountId: string }[]): number =>
    new Set(shares.map((share) => share.accountId)).size;
  const today = Math.floor((nowMs - repaymentStartMs(fundedAt.getTime())) / 86_400_000);
  const behind = new Set(
    plan.due.filter((share) => share.dayIndex < today).map((share) => share.dayIndex),
  );
  const nextDay = open.find((slice) => slice.dayIndex >= plan.daysDue)?.dayIndex;
  const nextShares = open.filter((slice) => slice.dayIndex === nextDay);
  return {
    ...base,
    daysDue: plan.daysDue,
    daysPaid: plan.daysPaid,
    repaidSats,
    totalSats: openSats === null ? null : repaidSats + openSats,
    due: {
      payableSats: pricedSum(price, payable),
      payableAmount: cents(units(payable)),
      payablePeople: people(payable),
      waitingSats: pricedSum(price, waiting),
      waitingAmount: cents(units(waiting)),
      waitingPeople: people(waiting),
      behindDays: behind.size,
      lastPayment: payable.length > 0 && payable.length === open.length,
    },
    next:
      nextDay === undefined
        ? null
        : {
            dueOn: repaymentDueDate(fundedAt.getTime(), nextDay),
            sats: pricedSum(price, nextShares),
            amount: cents(units(nextShares)),
          },
  };
}

/**
 * `GET /me/loans`: the caller's live repayable asks that are still collecting
 * or not fully repaid, newest first, with what is due now.
 *
 * @param deps - Store, auth, clock, rate loader, and the optional LNURL server.
 * @returns A Hono app with `GET /me/loans`.
 */
export function myLoansRoutes(deps: MyLoansDeps): Hono {
  return new Hono().get('/me/loans', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const account = token === null ? null : await resolveSession(deps.authStore, deps.now(), token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const nowMs = deps.now();
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
        const loan = await loanRow(deps, row, nowMs);
        if (loan === 'unavailable') {
          return c.json({ error: 'Ask amount is unavailable' }, 503);
        }
        if (loan !== null) {
          loans.push(loan);
        }
      }
      return c.json(
        { sundayRest: isSundayRestHeader(nowMs, c.req.header('Time-Zone')), loans },
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
