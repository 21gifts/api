import type { Context } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import {
  dueDayCount,
  formatCents,
  payerDebtUnits,
  repaymentDescription,
  repaymentLedger,
  repaymentSchedule,
} from '@/lib/credit-repayment';
import { fiatToSats, type GoalFiatCode, type GoalRateDay } from '@/lib/goal-rate';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import type { MessageRow } from '@/lib/message';
import type { MessageInvoiceAttempt, MessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
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
}

const limiter = new InvoiceRateLimiter();

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
  const payers = await deps.store.listCreditPayers(row.id);
  const unassignedSats = await deps.store.sumUnassignedCreditSats(row.id);
  const owed = payerDebtUnits(row.goalCurrency, row.goalAmount, payers);
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
  const names = new Map<string, { name: string; username: string | null }>();
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
  return c.json(
    {
      currency: fiat ? row.goalCurrency : 'BTC',
      fundedAt: fundedAt === null ? null : fundedAt.toISOString(),
      termDays: row.goalTermDays,
      daysDue,
      daysPaid,
      unassignedSats,
      givers: payers.map((payer) => {
        const identity = names.get(payer.accountId) as { name: string; username: string | null };
        /* v8 ignore next -- every listed payer is in the debt map; a miss is zero */
        const units = owedById.get(payer.accountId) ?? 0n;
        return {
          accountId: payer.accountId,
          name: identity.name,
          username: identity.username,
          givenSats: payer.sats,
          givenAmount: fiat ? formatCents(units) : null,
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
): Promise<{ name: string; username: string | null }> {
  const account = await deps.authStore.getAccount(accountId);
  if (account === undefined) {
    return { name: '', username: null };
  }
  return {
    name: account.name ?? '',
    username: account.username ?? null,
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

/**
 * BOLT11 that pays the next giver their share, at that giver's Lightning address.
 *
 * @param deps - Store, auth, clock, and LNURL fetch.
 * @param c - Request.
 * @returns `{ pr, amountSats }`, or an error.
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
  if (!limiter.allow(opened.account.id, opened.nowMs)) {
    c.header('Retry-After', '10');
    return c.json({ error: 'Too many payments' }, 429);
  }
  const next = await nextShare(deps, opened.row, opened.nowMs);
  if (next.error !== null) {
    return c.json({ error: next.error }, next.status);
  }
  if (next.share === null) {
    return c.json({ error: 'Nothing is due' }, 400);
  }
  if (opened.row.eventId === null || opened.row.eventId === '') {
    return c.json({ error: 'This message cannot be paid yet' }, 400);
  }
  const recipient = await deps.authStore.getAccount(next.share.accountId);
  const address =
    recipient === undefined ? null : normalizeLightningAddress(recipient.lightningAddress ?? '');
  if (recipient === undefined || address === null) {
    return c.json({ error: 'A giver has no Lightning address' }, 400);
  }
  const recipientPubkey = await deps.authStore.getNostrPublicKey(recipient.id);
  if (recipientPubkey === undefined) {
    return c.json({ error: 'A giver has no Lightning address' }, 400);
  }
  const kek = deps.nostrKek;
  if (kek === undefined) {
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
  const amountMsat = next.share.sats * 1000;
  const description = repaymentDescription(next.share.dayIndex, next.share.accountId);
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
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
  const zapRequestJson = JSON.stringify(signed);
  const fetchImpl: FetchFn = deps.fetchImpl ?? fetch;
  const zap = await requestZapInvoice({
    address,
    amountMsat,
    zapRequestJson,
    fetchImpl,
  });
  if (!zap.ok) {
    if (zap.reason === 'noZap') {
      return c.json({ error: "The author's wallet cannot receive this Bitcoin payment" }, 400);
    }
    return c.json({ error: 'Could not start the Bitcoin payment' }, 400);
  }
  const inspected = inspectBolt11(zap.pr);
  if (!isNip57Invoice(inspected?.descriptionHash ?? null, zapRequestJson)) {
    return c.json({ error: "The author's wallet cannot receive this Bitcoin payment" }, 400);
  }
  const attempt: MessageInvoiceAttempt = {
    id: crypto.randomUUID(),
    createdAt: new Date(opened.nowMs),
    messageId: opened.row.id,
    payerAccountId: opened.account.id,
    authorAccountId: recipient.id,
    amountSats: next.share.sats,
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
    return c.json({ error: 'Messages are unavailable' }, 503);
  }
  return c.json({ pr: zap.pr, amountSats: next.share.sats }, 200);
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

async function nextShare(
  deps: RepaymentDeps,
  row: MessageRow,
  nowMs: number,
): Promise<{
  daysDue: number;
  daysPaid: number;
  share: { dayIndex: number; accountId: string; sats: number } | null;
  error: string | null;
  status: 400 | 503;
}> {
  const termDays = row.goalTermDays as number;
  const fundedAt = row.goalFundedAt as Date;
  const daysDue = dueDayCount(fundedAt.getTime(), nowMs, termDays);
  const payers = await deps.store.listCreditPayers(row.id);
  const paid = await deps.store.listRepayments(row.id);
  const owed = payerDebtUnits(row.goalCurrency, row.goalAmount, payers);
  if (owed === 'unavailable') {
    return {
      daysDue,
      daysPaid: 0,
      share: null,
      error: 'Ask amount is unavailable',
      status: 503,
    };
  }
  const schedule = repaymentSchedule(termDays, owed);
  const fiat = isFiatCredit(row);
  const rateDay = fiat && deps.goalRateDay !== undefined ? await deps.goalRateDay() : null;
  let daysPaid = 0;
  for (let day = 0; day < daysDue; day += 1) {
    const unpaid = schedule.find(
      (slice) =>
        slice.dayIndex === day &&
        !paid.some((item) => item.dayIndex === day && item.recipientAccountId === slice.accountId),
    );
    if (unpaid !== undefined) {
      const sats = fiat
        ? fiatToSats(Number(unpaid.units) / 100, rateDay, row.goalCurrency as GoalFiatCode)
        : Number(unpaid.units);
      if (sats === null) {
        return {
          daysDue,
          daysPaid,
          share: null,
          error: 'Ask amount is unavailable',
          status: 503,
        };
      }
      return {
        daysDue,
        daysPaid,
        share: { dayIndex: day, accountId: unpaid.accountId, sats },
        error: null,
        status: 400,
      };
    }
    daysPaid += 1;
  }
  return { daysDue, daysPaid, share: null, error: null, status: 400 };
}

const FIAT_CURRENCIES = new Set(['USD', 'CHF', 'EUR', 'PHP']);

function isFiatCredit(row: MessageRow): boolean {
  return FIAT_CURRENCIES.has(row.goalCurrency ?? '');
}
