/**
 * Daily payout roster types, 400 texts, comment folding, and the editor and
 * payout projections. Persistence lives in `daily-roster-store`. Never logs
 * the token, comment text, or Lightning addresses.
 */

import type { Account } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { receivingAddress } from '@/lib/receiving-address';

/** Spend 400 text for a comment the roster will not store. */
export const DAILY_ROSTER_INVALID_COMMENT = 'Invalid comment';

/** Spend 400 text for a payments switch the roster will not store. */
export const DAILY_ROSTER_INVALID_PAYMENTS = 'Invalid payments switch';

/** Spend 400 text for an address or amount the roster will not store. */
export const DAILY_ROSTER_INVALID_ADDRESS = 'Invalid address or amount';

/** Spend 400 text when the account is already on the roster. */
export const DAILY_ROSTER_ADDRESS_LISTED = 'Address already listed';

/** Spend 400 text when the account is not on the roster, or no account has that username or address. */
export const DAILY_ROSTER_UNKNOWN_ADDRESS = 'Unknown address';

/** Route text when the roster cannot be read. */
export const DAILY_ROSTER_UNAVAILABLE = 'Daily roster is unavailable';

/** Route text when the add body is not an account id or username and a finite amount. */
export const DAILY_ROSTER_INVALID_PERSON = 'Invalid person or amount';

/** Route text when no account has the add body's account id or username. */
export const DAILY_ROSTER_UNKNOWN_PERSON = 'Unknown person';

/** Maximum daily payment comment after newline folding and trim. */
export const DAILY_ROSTER_COMMENT_MAX = 500;

/**
 * One listed account and USD amount.
 */
export interface DailyRosterEntry {
  /** Listed account id. */
  accountId: string;
  /** USD amount for this account. */
  amountUsd: number;
}

/**
 * Recipients-only base of {@link DailyRosterDocument}.
 * Session responses use {@link DailyRosterPublic}.
 */
export interface DailyRoster {
  /** Payment comment stored with the roster. */
  comment: string;
  /** Whether daily payments are switched on. */
  paymentsEnabled: boolean;
  /**
   * USD paid to an unlisted admitted or trial grant. Always 1 on every
   * read; not stored.
   */
  defaultAmountUsd: number;
  /** Listed daily recipients and their USD amounts. */
  recipients: DailyRosterEntry[];
}

/**
 * Full stored roster document, including moderator rows and the moderator switch.
 */
export interface DailyRosterDocument extends DailyRoster {
  /** Whether moderator stipends are switched on. */
  moderatorPaymentsEnabled: boolean;
  /** Listed moderators and their USD amounts. */
  moderators: DailyRosterEntry[];
}

/**
 * One listed recipient on the editor roster, with member identity.
 */
export interface DailyRosterRecipientPublic {
  /**
   * Edit key of the row, sent back as `address` on update and delete:
   * `<username>@<host of PUBLIC_BASE_URL>`, the bare username when the
   * LNURL server is off, or the account id when the account has no username.
   * It is not a payout address and does not say whether a wallet is verified.
   */
  address: string;
  /** USD amount for this recipient. */
  amountUsd: number;
  /** Listed account id. */
  accountId: string;
  /** Trimmed lower-case username, or `null` when missing or blank. */
  username: string | null;
  /** Trimmed display name, or `null` when missing or blank. */
  name: string | null;
}

/**
 * One listed row of the spend document, with the address it is paid on.
 */
export interface DailyRosterPayoutEntry {
  /** Listed account id. */
  accountId: string;
  /** Trimmed lower-case username, or `null` when missing or blank. */
  username: string | null;
  /**
   * The account's receiving address at read time (`receivingAddress`), or
   * `null` when the account is missing, has no verified wallet, or the LNURL
   * server is off: the row is then not payable.
   */
  address: string | null;
  /** USD amount for this account. */
  amountUsd: number;
}

/**
 * Spend document: the stored roster with each row's payout address.
 */
export interface DailyRosterPayoutDocument {
  /** Payment comment stored with the roster. */
  comment: string;
  /** Whether daily payments are switched on. */
  paymentsEnabled: boolean;
  /** Whether moderator stipends are switched on. */
  moderatorPaymentsEnabled: boolean;
  /** Always 1 on every read; not stored. */
  defaultAmountUsd: number;
  /** Listed daily recipients. */
  recipients: DailyRosterPayoutEntry[];
  /** Listed moderators. */
  moderators: DailyRosterPayoutEntry[];
}

/** Account fields the roster projections read. */
export type DailyRosterAccount = Pick<
  Account,
  'name' | 'username' | 'sparkPubkey' | 'sparkPubkeyVerifiedAt'
>;

/** Account lookup by id for the roster projections. */
export type DailyRosterAccountLookup = (
  accountId: string,
) => Promise<DailyRosterAccount | undefined>;

/**
 * Editor session JSON for GET and successful POST of `/funding/daily-roster*`.
 * Moderator rows are their own list. They are not mixed into `recipients`.
 */
export interface DailyRosterPublic {
  /** Payment comment stored with the roster. */
  comment: string;
  /** Whether daily payments are switched on. */
  paymentsEnabled: boolean;
  /**
   * USD paid to an unlisted admitted or trial grant. Always 1 on every
   * read; not stored.
   */
  defaultAmountUsd: number;
  /** Listed recipients with amounts and optional member identity. */
  recipients: DailyRosterRecipientPublic[];
  /** Whether moderator stipends are switched on. */
  moderatorPaymentsEnabled: boolean;
  /** Listed moderators with amounts and optional member identity. */
  moderators: DailyRosterRecipientPublic[];
}

/**
 * Fold a daily payment comment before it is stored.
 *
 * Newlines become spaces, then trim. Empty after trim is valid.
 * Longer than {@link DAILY_ROSTER_COMMENT_MAX} is refused (`undefined`)
 * and is not cut.
 *
 * @param raw - Comment string from the JSON body.
 * @returns The comment to store, or `undefined` when it is too long.
 */
export function normalizeDailyRosterComment(raw: string): string | undefined {
  const comment = raw.replace(/\r\n|\n|\r/g, ' ').trim();
  if (comment.length > DAILY_ROSTER_COMMENT_MAX) {
    return undefined;
  }
  return comment;
}

/** Trimmed lower-case username, or `null` when missing or blank. */
function rosterUsername(account: DailyRosterAccount | undefined): string | null {
  const username = account?.username?.trim().toLowerCase() ?? '';
  return username === '' ? null : username;
}

/**
 * Attach the edit key, username, and display name to one stored row.
 *
 * @param row - Stored account id and USD amount.
 * @param lookup - Account lookup by id.
 * @param lnurlServer - LNURL server config, or `undefined` when off.
 * @returns The public row.
 */
async function attachRosterIdentity(
  row: DailyRosterEntry,
  lookup: DailyRosterAccountLookup,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<DailyRosterRecipientPublic> {
  const account = await lookup(row.accountId);
  const username = rosterUsername(account);
  const name = account?.name?.trim() ?? '';
  let address = row.accountId;
  if (username !== null) {
    address = lnurlServer === undefined ? username : `${username}@${lnurlServer.host}`;
  }
  return {
    address,
    amountUsd: row.amountUsd,
    accountId: row.accountId,
    username,
    name: name === '' ? null : name,
  };
}

/**
 * Copy a stored roster for the editor: each row gets its edit key,
 * username, and display name.
 *
 * Lookup is called once per recipient and once per moderator, in parallel.
 * Order, account id, and amountUsd are unchanged. A missing account has null
 * identity fields and its account id as edit key. Lookup errors are not
 * caught. Moderator rows stay out of `recipients`.
 *
 * @param roster - Full stored document.
 * @param lookup - Account lookup by id.
 * @param lnurlServer - LNURL server config, or `undefined` when off.
 * @returns The editor session roster.
 */
export async function withRecipientIdentities(
  roster: DailyRosterDocument,
  lookup: DailyRosterAccountLookup,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<DailyRosterPublic> {
  const [recipients, moderators] = await Promise.all([
    Promise.all(roster.recipients.map((row) => attachRosterIdentity(row, lookup, lnurlServer))),
    Promise.all(roster.moderators.map((row) => attachRosterIdentity(row, lookup, lnurlServer))),
  ]);
  return {
    comment: roster.comment,
    paymentsEnabled: roster.paymentsEnabled,
    defaultAmountUsd: roster.defaultAmountUsd,
    recipients,
    moderatorPaymentsEnabled: roster.moderatorPaymentsEnabled,
    moderators,
  };
}

/**
 * Attach username and payout address to one stored row.
 *
 * @param row - Stored account id and USD amount.
 * @param lookup - Account lookup by id.
 * @param lnurlServer - LNURL server config, or `undefined` when off.
 * @returns The payout row.
 */
async function attachPayoutAddress(
  row: DailyRosterEntry,
  lookup: DailyRosterAccountLookup,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<DailyRosterPayoutEntry> {
  const account = await lookup(row.accountId);
  return {
    accountId: row.accountId,
    username: rosterUsername(account),
    address:
      account === undefined ? null : (receivingAddress(account, lnurlServer)?.address ?? null),
    amountUsd: row.amountUsd,
  };
}

/**
 * Copy a stored roster for spend: each row gets the address it is paid on,
 * resolved now from the account's verified wallet through
 * `receivingAddress`, and its username.
 *
 * A missing account, an account without a verified wallet, or the LNURL
 * server being off gives `address: null`. Lookup is called once per row, in
 * parallel. Order, account id, and amountUsd are unchanged. Lookup errors are
 * not caught.
 *
 * @param roster - Full stored document.
 * @param lookup - Account lookup by id.
 * @param lnurlServer - LNURL server config, or `undefined` when off.
 * @returns The spend document.
 */
export async function withPayoutAddresses(
  roster: DailyRosterDocument,
  lookup: DailyRosterAccountLookup,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<DailyRosterPayoutDocument> {
  const [recipients, moderators] = await Promise.all([
    Promise.all(roster.recipients.map((row) => attachPayoutAddress(row, lookup, lnurlServer))),
    Promise.all(roster.moderators.map((row) => attachPayoutAddress(row, lookup, lnurlServer))),
  ]);
  return {
    comment: roster.comment,
    paymentsEnabled: roster.paymentsEnabled,
    moderatorPaymentsEnabled: roster.moderatorPaymentsEnabled,
    defaultAmountUsd: roster.defaultAmountUsd,
    recipients,
    moderators,
  };
}

/**
 * Thrown when a roster change is rejected or the roster cannot be read.
 *
 * `error` is the client-facing string. It is never the token, the comment
 * text, or a Lightning address.
 */
export class DailyRosterRequestError extends Error {
  /** 400 for a rejected change, 502 when the roster is unusable. */
  readonly status: 400 | 502;

  /** JSON `error` string returned to the caller. */
  readonly error: string;

  /**
   * @param status - 400 or 502.
   * @param error - Client-facing `error` string.
   */
  constructor(status: 400 | 502, error: string) {
    super(error);
    this.name = 'DailyRosterRequestError';
    this.status = status;
    this.error = error;
  }
}
