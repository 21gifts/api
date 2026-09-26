import type { Context } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import {
  dayUnits,
  dueDayCount,
  fiatAmountToCents,
  repaymentDescription,
  shareSats,
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
 * Status of one credit's daily repayment, for its author.
 *
 * @param deps - Store, auth, and clock.
 * @param c - Request.
 * @returns The schedule, or an error.
 */
export async function repaymentStatus(deps: RepaymentDeps, c: Context): Promise<Response> {
  const opened = await openCredit(deps, c);
  if (opened instanceof Response) {
    return opened;
  }
  const next = await nextShare(deps, opened.row, opened.nowMs);
  if (next.error !== null) {
    return c.json({ error: next.error }, next.status);
  }
  return c.json(
    {
      fundedAt: opened.row.goalFundedAt?.toISOString() ?? null,
      termDays: opened.row.goalTermDays,
      daysDue: next.daysDue,
      daysPaid: next.daysPaid,
      next:
        next.share === null
          ? null
          : {
              dayIndex: next.share.dayIndex,
              sats: next.share.sats,
              recipientAccountId: next.share.accountId,
            },
    },
    200,
  );
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
  const id = c.req.param('id') ?? '';
  if (!MESSAGE_ID_RE.test(id)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const row = await deps.store.getById(id);
  if (
    row === undefined ||
    row.deletedAt !== null ||
    row.goalRepayable !== true ||
    row.goalTermDays == null ||
    row.goalFundedAt == null ||
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
  const termDays = row.goalTermDays ?? 0;
  const fundedAt = row.goalFundedAt ?? new Date(0);
  const daysDue = dueDayCount(fundedAt.getTime(), nowMs, termDays);
  const payers = await deps.store.listCreditPayers(row.id);
  const paid = await deps.store.listRepayments(row.id);
  const rateDay =
    row.goalCurrency !== null &&
    row.goalCurrency !== undefined &&
    row.goalCurrency !== 'BTC' &&
    deps.goalRateDay !== undefined
      ? await deps.goalRateDay()
      : null;
  let daysPaid = 0;
  for (let day = 0; day < daysDue; day += 1) {
    const shares = sharesForDay(row, payers, day, rateDay);
    if (shares === 'unavailable') {
      return {
        daysDue,
        daysPaid,
        share: null,
        error: 'Ask amount is unavailable',
        status: 503,
      };
    }
    const unpaid = shares.find(
      (share) =>
        !paid.some((item) => item.dayIndex === day && item.recipientAccountId === share.accountId),
    );
    if (unpaid !== undefined) {
      return { daysDue, daysPaid, share: { dayIndex: day, ...unpaid }, error: null, status: 400 };
    }
    if (shares.length > 0 || dayUnits(debtUnits(row) ?? 0n, termDays, day) === 0n) {
      daysPaid += 1;
    }
  }
  return { daysDue, daysPaid, share: null, error: null, status: 400 };
}

function debtUnits(row: MessageRow): bigint | null {
  if (row.goalCurrency === null || row.goalCurrency === undefined || row.goalCurrency === 'BTC') {
    return BigInt(row.goalSats ?? 0);
  }
  if (row.goalAmount === null || row.goalAmount === undefined) {
    return null;
  }
  return fiatAmountToCents(row.goalAmount);
}

function sharesForDay(
  row: MessageRow,
  payers: { accountId: string; sats: number }[],
  day: number,
  rateDay: GoalRateDay | null,
): { accountId: string; sats: number }[] | 'unavailable' {
  const termDays = row.goalTermDays ?? 0;
  const debt = debtUnits(row);
  if (debt === null) {
    return 'unavailable';
  }
  const units = dayUnits(debt, termDays, day) ?? 0n;
  if (row.goalCurrency === null || row.goalCurrency === undefined || row.goalCurrency === 'BTC') {
    return shareSats(Number(units), payers);
  }
  const priced = fiatToSats(Number(units) / 100, rateDay, row.goalCurrency as GoalFiatCode);
  if (priced === null) {
    return 'unavailable';
  }
  return shareSats(priced, payers);
}
