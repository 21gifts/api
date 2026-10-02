/**
 * Daily payout roster types, 400 texts, comment folding, and the public
 * recipient-identity projection. Persistence lives in `daily-roster-store`.
 * Never logs the token, comment text, or Lightning addresses.
 */

/** Spend 400 text for a comment the roster will not store. */
export const DAILY_ROSTER_INVALID_COMMENT = 'Invalid comment';

/** Spend 400 text for a payments switch the roster will not store. */
export const DAILY_ROSTER_INVALID_PAYMENTS = 'Invalid payments switch';

/** Spend 400 text for an address or amount the roster will not store. */
export const DAILY_ROSTER_INVALID_ADDRESS = 'Invalid address or amount';

/** Spend 400 text when the address is already on the roster. */
export const DAILY_ROSTER_ADDRESS_LISTED = 'Address already listed';

/** Spend 400 text when the address is not on the roster. */
export const DAILY_ROSTER_UNKNOWN_ADDRESS = 'Unknown address';

/** Route text when the roster cannot be read. */
export const DAILY_ROSTER_UNAVAILABLE = 'Daily roster is unavailable';

/** Route text when the add body is not a person id and a finite amount. */
export const DAILY_ROSTER_INVALID_PERSON = 'Invalid person or amount';

/** Route text when the add account id is not in the store. */
export const DAILY_ROSTER_UNKNOWN_PERSON = 'Unknown person';

/** Route text when the add account has no receiving address (no verified wallet). */
export const DAILY_ROSTER_NO_LIGHTNING = 'Person has no Lightning address';

/** Maximum daily payment comment after newline folding and trim. */
export const DAILY_ROSTER_COMMENT_MAX = 500;

/**
 * One listed address and USD amount.
 */
export interface DailyRosterEntry {
  /** Stored Lightning address (trim then lower-case on write). */
  address: string;
  /** USD amount for this address. */
  amountUsd: number;
}

/**
 * Daily roster JSON used by GET and successful POST of `/funding/daily-roster*`.
 * Moderator rows stay off this public shape.
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
 * One listed recipient on the public daily roster, with optional member identity.
 */
export interface DailyRosterRecipientPublic {
  /** Stored Lightning address. */
  address: string;
  /** USD amount for this recipient. */
  amountUsd: number;
  /** Matching account id, or `null` when none. */
  accountId: string | null;
  /** Trimmed display name, or `null` when missing or blank. */
  name: string | null;
}

/**
 * Daily roster JSON returned by GET and successful POST of `/funding/daily-roster*`.
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

/**
 * Copy a daily roster and attach account id and display name per recipient.
 *
 * Lookup is called once per recipient with the stored address, in parallel.
 * Recipient order, address, and amountUsd are unchanged. A miss is null
 * identity fields. A found name is trimmed; null, missing, or trim-empty
 * becomes null. Lookup errors are not caught. Moderator rows are not copied.
 *
 * @param roster - Daily roster (recipients only).
 * @param lookup - Account lookup by the stored address (the member's receiving address).
 * @returns The public roster.
 */
export async function withRecipientIdentities(
  roster: DailyRoster,
  lookup: (address: string) => Promise<{ id: string; name: string | null } | undefined>,
): Promise<DailyRosterPublic> {
  const recipients = await Promise.all(
    roster.recipients.map(async (recipient): Promise<DailyRosterRecipientPublic> => {
      const found = await lookup(recipient.address);
      if (found === undefined) {
        return {
          address: recipient.address,
          amountUsd: recipient.amountUsd,
          accountId: null,
          name: null,
        };
      }
      const rawName = found.name;
      if (typeof rawName !== 'string') {
        return {
          address: recipient.address,
          amountUsd: recipient.amountUsd,
          accountId: found.id,
          name: null,
        };
      }
      const trimmed = rawName.trim();
      return {
        address: recipient.address,
        amountUsd: recipient.amountUsd,
        accountId: found.id,
        name: trimmed === '' ? null : trimmed,
      };
    }),
  );
  return {
    comment: roster.comment,
    paymentsEnabled: roster.paymentsEnabled,
    defaultAmountUsd: roster.defaultAmountUsd,
    recipients,
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
