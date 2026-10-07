/**
 * Team view of a member's reported wallet data and interaction events.
 *
 * Shared by the team routes (`/team`, session of a moderator or above) and
 * their operator equivalents (`/debug/team`, `DEBUG_TOKEN`). Payloads list
 * fields one by one, so a stored column or prop that carries a secret never
 * reaches a response: there is no field for a recovery phrase, seed, PRF
 * output, preimage, or private key, and event props whose key names one are
 * dropped.
 */

import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeMessageFeedCursor, encodeMessageFeedCursor } from '@/lib/message';
import {
  WALLET_PAYMENT_CATEGORIES,
  type MemberDataCursor,
  type MemberDataStore,
  type MemberEventProp,
  type MemberEventRow,
  type TeamAccessRow,
  type WalletPaymentCategory,
  type WalletPaymentDirection,
  type WalletPaymentRow,
  type WalletPaymentTotalRow,
} from '@/lib/member-data-store';

/** Account and row ids (same shape as forum message ids). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payments per page on the member wallet view. */
export const MEMBER_PAYMENT_PAGE_LIMIT = 50;

/** Events per page on the member events view. */
export const MEMBER_EVENT_PAGE_LIMIT = 100;

/** Audit rows per page. */
export const TEAM_AUDIT_PAGE_LIMIT = 100;

/** Selectable summary periods; `all` has no lower bound. */
export type MemberDataPeriod = '7' | '30' | '90' | 'all';

/** Period used when the query names none. */
export const DEFAULT_MEMBER_DATA_PERIOD: MemberDataPeriod = '30';

/** Categories whose outgoing payments stay inside the community. */
export const COMMUNITY_CATEGORIES: readonly WalletPaymentCategory[] = [
  'member',
  'shop',
  'platform',
  'gift',
];

/** Categories whose outgoing payments leave the community. */
export const OUTSIDE_CATEGORIES: readonly WalletPaymentCategory[] = [
  'outside_lightning',
  'onchain',
];

/**
 * Event prop keys that name a secret. Such a prop is never returned, whatever
 * its value.
 */
const SECRET_PROP_KEY_RE =
  /seed|mnemonic|recovery|phrase|preimage|private|secret|prf|nsec|xprv|spending/i;

/** A member as the team views show it. */
export interface MemberRef {
  /** Account id. */
  id: string;
  /** Display name, or null. */
  name: string | null;
  /** Username, or null. */
  username: string | null;
}

/** Per-category totals in a wallet summary. */
export interface CategoryTotals {
  /** Completed incoming sats. */
  inSats: number;
  /** Completed outgoing sats. */
  outSats: number;
  /** Completed payments in either direction. */
  count: number;
}

/** Totals over a period, from completed payments only. */
export interface WalletSummary {
  /** Period the totals cover. */
  period: MemberDataPeriod;
  /** Lower bound (ISO), or null for `all`. */
  since: string | null;
  /** Completed incoming sats. */
  inSats: number;
  /** Completed outgoing sats. */
  outSats: number;
  /** Fees of completed payments. */
  feeSats: number;
  /** Completed incoming payments. */
  inCount: number;
  /** Completed outgoing payments. */
  outCount: number;
  /** Totals for every category (zero when none). */
  byCategory: Record<WalletPaymentCategory, CategoryTotals>;
  /** Outgoing sats to `member`, `shop`, `platform`, and `gift`. */
  communityOutSats: number;
  /** Outgoing sats to `outside_lightning` and `onchain`. */
  outsideOutSats: number;
  /**
   * `communityOutSats / (communityOutSats + outsideOutSats)`, or null when
   * both are 0. `unknown` counts on neither side.
   */
  communityShare: number | null;
}

/**
 * Parse the `period` query value.
 *
 * @param raw - Query value, or undefined.
 * @returns The period ({@link DEFAULT_MEMBER_DATA_PERIOD} when omitted), or null when invalid.
 */
export function parseMemberDataPeriod(raw: string | undefined): MemberDataPeriod | null {
  if (raw === undefined) {
    return DEFAULT_MEMBER_DATA_PERIOD;
  }
  return raw === '7' || raw === '30' || raw === '90' || raw === 'all' ? raw : null;
}

/**
 * Lower bound of a period.
 *
 * @param period - Selected period.
 * @param nowMs - Current time (epoch ms).
 * @returns `nowMs` minus the period's days, or null for `all`.
 */
export function memberDataPeriodSince(period: MemberDataPeriod, nowMs: number): Date | null {
  if (period === 'all') {
    return null;
  }
  return new Date(nowMs - Number(period) * 24 * 60 * 60 * 1000);
}

/**
 * Encode a keyset position as the opaque `cursor` query value (the same
 * format the forum feed uses).
 *
 * @param cursor - Time and id of the last row on a page.
 * @returns Base64url cursor.
 */
export function encodeMemberDataCursor(cursor: MemberDataCursor): string {
  return encodeMessageFeedCursor({ k: 't', c: cursor.at.toISOString(), i: cursor.id });
}

/** Earliest and latest cursor time Postgres `timestamptz` and the stores both accept. */
const CURSOR_MIN_MS = Date.parse('0001-01-01T00:00:00.000Z');
const CURSOR_MAX_MS = Date.parse('9999-12-31T23:59:59.999Z');

/**
 * Decode a `cursor` query value.
 *
 * @param raw - Query value.
 * @param uuidId - When true, the id must be a UUID (events and audit rows).
 * @returns The keyset position, or null when the value is not a valid cursor:
 *   not a time cursor, an empty id, a non-UUID id where one is required, an id
 *   containing a NUL character (Postgres text cannot hold one), or a time
 *   outside years 1 to 9999.
 */
export function decodeMemberDataCursor(raw: string, uuidId: boolean): MemberDataCursor | null {
  const decoded = decodeMessageFeedCursor(raw);
  if (
    decoded?.k !== 't' ||
    decoded.i === '' ||
    decoded.i.includes('\u0000') ||
    (uuidId && !UUID_RE.test(decoded.i))
  ) {
    return null;
  }
  const at = new Date(decoded.c);
  if (at.getTime() < CURSOR_MIN_MS || at.getTime() > CURSOR_MAX_MS) {
    return null;
  }
  return { at, id: uuidId ? decoded.i.toLowerCase() : decoded.i };
}

/**
 * Fold grouped completed-payment totals into a {@link WalletSummary}.
 *
 * @param period - Period the totals cover.
 * @param since - Lower bound, or null.
 * @param totals - Rows from {@link MemberDataStore.paymentTotals}.
 * @returns The summary.
 */
export function summarizeWalletPayments(
  period: MemberDataPeriod,
  since: Date | null,
  totals: readonly WalletPaymentTotalRow[],
): WalletSummary {
  const byCategory = Object.fromEntries(
    WALLET_PAYMENT_CATEGORIES.map((category) => [category, { inSats: 0, outSats: 0, count: 0 }]),
  ) as Record<WalletPaymentCategory, CategoryTotals>;
  const summary: WalletSummary = {
    period,
    since: since === null ? null : since.toISOString(),
    inSats: 0,
    outSats: 0,
    feeSats: 0,
    inCount: 0,
    outCount: 0,
    byCategory,
    communityOutSats: 0,
    outsideOutSats: 0,
    communityShare: null,
  };
  for (const total of totals) {
    const bucket = byCategory[total.category];
    bucket.count += total.count;
    summary.feeSats += total.feeSats;
    if (total.direction === 'in') {
      bucket.inSats += total.amountSats;
      summary.inSats += total.amountSats;
      summary.inCount += total.count;
      continue;
    }
    bucket.outSats += total.amountSats;
    summary.outSats += total.amountSats;
    summary.outCount += total.count;
    if (COMMUNITY_CATEGORIES.includes(total.category)) {
      summary.communityOutSats += total.amountSats;
    } else if (OUTSIDE_CATEGORIES.includes(total.category)) {
      summary.outsideOutSats += total.amountSats;
    }
  }
  const spent = summary.communityOutSats + summary.outsideOutSats;
  summary.communityShare = spent === 0 ? null : summary.communityOutSats / spent;
  return summary;
}

/**
 * Serialize a member for the team views.
 *
 * @param account - Stored account.
 * @returns Id, name, and username.
 */
export function serializeMemberRef(account: Account): MemberRef {
  return { id: account.id, name: account.name, username: account.username ?? null };
}

/**
 * Serialize one payment for the team views. Lists every field by name.
 *
 * @param row - Stored payment.
 * @param counterparty - Member on the other side, or null.
 * @returns JSON-ready payment.
 */
export function serializeWalletPayment(
  row: WalletPaymentRow,
  counterparty: MemberRef | null,
): Record<string, unknown> {
  return {
    id: row.paymentId,
    direction: row.direction,
    status: row.status,
    amountSats: row.amountSats,
    feeSats: row.feeSats,
    timestamp: row.paidAt.toISOString(),
    method: row.method,
    paymentHash: row.paymentHash,
    invoice: row.invoice,
    destination: row.destination,
    description: row.description,
    lnurlComment: row.lnurlComment,
    category: row.category,
    counterparty,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize one interaction event for the team views. Props whose key names
 * a secret are dropped; other props keep only scalar values.
 *
 * @param row - Stored event.
 * @returns JSON-ready event.
 */
export function serializeMemberEvent(row: MemberEventRow): Record<string, unknown> {
  const props: Record<string, MemberEventProp> = {};
  for (const [key, value] of Object.entries(row.props)) {
    if (SECRET_PROP_KEY_RE.test(key)) {
      continue;
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      props[key] = value;
    }
  }
  return {
    id: row.id,
    name: row.name,
    at: row.at.toISOString(),
    path: row.path,
    props,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/** Outcome of a team read: the JSON body and its status. */
export type MemberDataResult =
  { status: 200; body: Record<string, unknown> } | { status: 400 | 404; body: { error: string } };

/** Collaborators a team read needs. */
export interface MemberDataReadDeps {
  /** Member data and audit persistence. */
  store: MemberDataStore;
  /** Account lookup for the member and counterparties. */
  auth: AuthStore;
  /** Current time (epoch ms). */
  nowMs: number;
  /**
   * Runs once the request is valid and the member exists, before any member
   * data is read. The team routes write the audit row here; when it throws,
   * nothing is read.
   */
  beforeRead?: () => Promise<void>;
}

/** Query values a wallet read accepts. */
export interface MemberWalletQuery {
  /** `7`, `30`, `90`, or `all`. */
  period?: string | undefined;
  /** A {@link WalletPaymentCategory}. */
  category?: string | undefined;
  /** `in` or `out`. */
  direction?: string | undefined;
  /** Opaque keyset cursor from `nextCursor`. */
  cursor?: string | undefined;
}

/** Load the path member, or a 404 result. */
async function loadMember(
  auth: AuthStore,
  accountId: string,
): Promise<{ ok: true; account: Account } | { ok: false; result: MemberDataResult }> {
  const notFound: MemberDataResult = { status: 404, body: { error: 'Not found' } };
  if (!UUID_RE.test(accountId)) {
    return { ok: false, result: notFound };
  }
  const account = await auth.getAccount(accountId.toLowerCase());
  return account === undefined ? { ok: false, result: notFound } : { ok: true, account };
}

/** Parse an optional `cursor` query value. */
function parseCursor(
  raw: string | undefined,
  uuidId: boolean,
): { ok: true; cursor: MemberDataCursor | null } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, cursor: null };
  }
  const cursor = decodeMemberDataCursor(raw, uuidId);
  return cursor === null ? { ok: false } : { ok: true, cursor };
}

/**
 * Build the member wallet view: latest balance, one page of payments, and a
 * summary over the period. Validation runs before `beforeRead`.
 *
 * @param deps - Store, account lookup, clock, and the pre-read hook.
 * @param accountId - Path member id.
 * @param query - `period`, `category`, `direction`, and `cursor`.
 * @returns 200 with `{ member, balance, period, summary, payments, nextCursor }`,
 *   400 for an invalid query value, or 404 when the member does not exist.
 * @throws When the store, the account lookup, or `beforeRead` throws.
 */
export async function readMemberWallet(
  deps: MemberDataReadDeps,
  accountId: string,
  query: MemberWalletQuery,
): Promise<MemberDataResult> {
  const member = await loadMember(deps.auth, accountId);
  if (!member.ok) {
    return member.result;
  }
  const period = parseMemberDataPeriod(query.period);
  if (period === null) {
    return { status: 400, body: { error: 'Invalid period' } };
  }
  const category = query.category;
  if (
    category !== undefined &&
    !WALLET_PAYMENT_CATEGORIES.includes(category as WalletPaymentCategory)
  ) {
    return { status: 400, body: { error: 'Invalid category' } };
  }
  const direction = query.direction;
  if (direction !== undefined && direction !== 'in' && direction !== 'out') {
    return { status: 400, body: { error: 'Invalid direction' } };
  }
  const cursor = parseCursor(query.cursor, false);
  if (!cursor.ok) {
    return { status: 400, body: { error: 'Invalid cursor' } };
  }
  if (deps.beforeRead !== undefined) {
    await deps.beforeRead();
  }
  const memberId = member.account.id;
  const since = memberDataPeriodSince(period, deps.nowMs);
  const balance = await deps.store.latestBalance(memberId);
  const rows = await deps.store.listPayments(
    memberId,
    {
      since,
      ...(category === undefined ? {} : { category: category as WalletPaymentCategory }),
      ...(direction === undefined ? {} : { direction: direction as WalletPaymentDirection }),
    },
    cursor.cursor,
    MEMBER_PAYMENT_PAGE_LIMIT + 1,
  );
  const page = rows.slice(0, MEMBER_PAYMENT_PAGE_LIMIT);
  const last = page[page.length - 1];
  const counterparties = new Map<string, MemberRef | null>();
  for (const row of page) {
    const id = row.counterpartyAccountId;
    if (id !== null && !counterparties.has(id)) {
      const account = await deps.auth.getAccount(id);
      counterparties.set(id, account === undefined ? null : serializeMemberRef(account));
    }
  }
  const totals = await deps.store.paymentTotals(memberId, since);
  return {
    status: 200,
    body: {
      member: { ...serializeMemberRef(member.account), role: member.account.role },
      balance:
        balance === null
          ? null
          : {
              balanceSats: balance.balanceSats,
              syncedAt: balance.syncedAt.toISOString(),
              receivedAt: balance.receivedAt.toISOString(),
            },
      period,
      summary: summarizeWalletPayments(period, since, totals),
      payments: page.map((row) =>
        serializeWalletPayment(
          row,
          row.counterpartyAccountId === null
            ? null
            : (counterparties.get(row.counterpartyAccountId) ?? null),
        ),
      ),
      nextCursor:
        rows.length > MEMBER_PAYMENT_PAGE_LIMIT && last !== undefined
          ? encodeMemberDataCursor({ at: last.paidAt, id: last.paymentId })
          : null,
    },
  };
}

/**
 * Build the member events view: one page of interaction events, newest first.
 * Validation runs before `beforeRead`.
 *
 * @param deps - Store, account lookup, clock, and the pre-read hook.
 * @param accountId - Path member id.
 * @param rawCursor - `cursor` query value, or undefined.
 * @returns 200 with `{ member, events, nextCursor }`, 400 for an invalid
 *   cursor, or 404 when the member does not exist.
 * @throws When the store, the account lookup, or `beforeRead` throws.
 */
export async function readMemberEvents(
  deps: MemberDataReadDeps,
  accountId: string,
  rawCursor: string | undefined,
): Promise<MemberDataResult> {
  const member = await loadMember(deps.auth, accountId);
  if (!member.ok) {
    return member.result;
  }
  const cursor = parseCursor(rawCursor, true);
  if (!cursor.ok) {
    return { status: 400, body: { error: 'Invalid cursor' } };
  }
  if (deps.beforeRead !== undefined) {
    await deps.beforeRead();
  }
  const rows = await deps.store.listEvents(
    member.account.id,
    cursor.cursor,
    MEMBER_EVENT_PAGE_LIMIT + 1,
  );
  const page = rows.slice(0, MEMBER_EVENT_PAGE_LIMIT);
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      member: { ...serializeMemberRef(member.account), role: member.account.role },
      events: page.map((row) => serializeMemberEvent(row)),
      nextCursor:
        rows.length > MEMBER_EVENT_PAGE_LIMIT && last !== undefined
          ? encodeMemberDataCursor({ at: last.at, id: last.id })
          : null,
    },
  };
}

/**
 * Build one page of the team access audit log, newest first.
 *
 * @param deps - Store and account lookup.
 * @param rawCursor - `cursor` query value, or undefined.
 * @returns 200 with `{ entries, nextCursor }`, or 400 for an invalid cursor.
 * @throws When the store or the account lookup throws.
 */
export async function readTeamAudit(
  deps: Pick<MemberDataReadDeps, 'store' | 'auth'>,
  rawCursor: string | undefined,
): Promise<MemberDataResult> {
  const cursor = parseCursor(rawCursor, true);
  if (!cursor.ok) {
    return { status: 400, body: { error: 'Invalid cursor' } };
  }
  const rows = await deps.store.listAccess(cursor.cursor, TEAM_AUDIT_PAGE_LIMIT + 1);
  const page = rows.slice(0, TEAM_AUDIT_PAGE_LIMIT);
  const last = page[page.length - 1];
  const refs = new Map<string, MemberRef>();
  const ref = async (id: string): Promise<MemberRef> => {
    const known = refs.get(id);
    if (known !== undefined) {
      return known;
    }
    const account = await deps.auth.getAccount(id);
    const value =
      account === undefined ? { id, name: null, username: null } : serializeMemberRef(account);
    refs.set(id, value);
    return value;
  };
  const entries = [];
  for (const row of page) {
    entries.push(await serializeTeamAccess(row, ref));
  }
  return {
    status: 200,
    body: {
      entries,
      nextCursor:
        rows.length > TEAM_AUDIT_PAGE_LIMIT && last !== undefined
          ? encodeMemberDataCursor({ at: last.at, id: last.id })
          : null,
    },
  };
}

/**
 * Serialize one audit row with the viewer and member resolved.
 *
 * @param row - Stored audit row.
 * @param ref - Resolves an account id to a {@link MemberRef}.
 * @returns JSON-ready audit entry.
 */
export async function serializeTeamAccess(
  row: TeamAccessRow,
  ref: (id: string) => Promise<MemberRef>,
): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    viewer: await ref(row.viewerAccountId),
    member: await ref(row.memberAccountId),
    what: row.what,
    at: row.at.toISOString(),
  };
}
