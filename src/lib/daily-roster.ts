/**
 * HTTP client for the spend daily payout roster.
 *
 * Bearer token, 5000 ms timeout, base URL trimmed with no trailing slash —
 * the same transport rules as the spend ping client. Missing or blank
 * `SPEND_URL` or `SPEND_API_TOKEN` yields no client, so the route can
 * answer 503 without calling fetch. Never logs the token, comment text,
 * or Lightning addresses.
 */

import type { FetchFn } from '@/lib/lnurlp';

/** Default HTTP timeout for {@link HttpDailyRoster}. */
const DEFAULT_TIMEOUT_MS = 5_000;

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

/** Spend 400 text when the error string is not one of the forwarded ones. */
export const DAILY_ROSTER_INVALID_CHANGE = 'Invalid daily roster change';

/** Route text when spend cannot return a roster. */
export const DAILY_ROSTER_UNAVAILABLE = 'Daily roster is unavailable';

/** Route text when spend URL or token is missing or blank. */
export const DAILY_ROSTER_NOT_CONFIGURED = 'Daily roster is not configured';

const FORWARDED_DAILY_ROSTER_ERRORS: ReadonlySet<string> = new Set([
  DAILY_ROSTER_INVALID_COMMENT,
  DAILY_ROSTER_INVALID_PAYMENTS,
  DAILY_ROSTER_INVALID_ADDRESS,
  DAILY_ROSTER_ADDRESS_LISTED,
  DAILY_ROSTER_UNKNOWN_ADDRESS,
]);

/**
 * Spend daily payout roster JSON.
 */
export interface DailyRoster {
  /** Payment comment stored with the roster. */
  comment: string;
  /** Whether daily payments are switched on. */
  paymentsEnabled: boolean;
  /**
   * USD paid to an unlisted admitted or trial grant. Spend sends
   * `NEW_MEMBER_DAILY_USD`. Not stored in the roster file.
   */
  defaultAmountUsd: number;
  /** Listed recipients and their USD amounts. */
  recipients: { address: string; amountUsd: number }[];
}

/**
 * Read and edit the spend daily payout roster.
 */
export interface DailyRosterClient {
  /**
   * Read the current roster.
   *
   * @returns The roster JSON.
   * @throws {@link DailyRosterRequestError}
   */
  get(): Promise<DailyRoster>;

  /**
   * Replace the payment comment.
   *
   * @param comment - Comment text proxied to spend.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  setComment(comment: string): Promise<DailyRoster>;

  /**
   * Turn daily payments on or off.
   *
   * @param enabled - Payments switch.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  setPaymentsEnabled(enabled: boolean): Promise<DailyRoster>;

  /**
   * Add a recipient.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  addRecipient(address: string, amountUsd: number): Promise<DailyRoster>;

  /**
   * Replace the USD amount for an address already on the roster.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  updateRecipient(address: string, amountUsd: number): Promise<DailyRoster>;

  /**
   * Remove a recipient.
   *
   * @param address - Lightning address.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  deleteRecipient(address: string): Promise<DailyRoster>;
}

/** Mapped spend result. `ok: false` is what the route returns as `{ error }`. */
type DailyRosterMapped =
  { ok: true; roster: DailyRoster } | { ok: false; status: 400 | 502; error: string };

/**
 * Thrown when spend rejects a change or the roster cannot be read.
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

function isDailyRosterRecipient(value: unknown): value is { address: string; amountUsd: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const amount = row['amountUsd'];
  return (
    typeof row['address'] === 'string' && typeof amount === 'number' && Number.isFinite(amount)
  );
}

/**
 * @param body - Parsed JSON value.
 * @returns The roster, or `undefined` when the shape does not match.
 */
function parseDailyRoster(body: unknown): DailyRoster | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const comment = record['comment'];
  const paymentsEnabled = record['paymentsEnabled'];
  const defaultAmountUsd = record['defaultAmountUsd'];
  const recipients = record['recipients'];
  if (
    typeof comment !== 'string' ||
    typeof paymentsEnabled !== 'boolean' ||
    typeof defaultAmountUsd !== 'number' ||
    !Number.isFinite(defaultAmountUsd) ||
    !Array.isArray(recipients)
  ) {
    return undefined;
  }
  const parsed: { address: string; amountUsd: number }[] = [];
  for (const item of recipients) {
    if (!isDailyRosterRecipient(item)) {
      return undefined;
    }
    parsed.push({ address: item.address, amountUsd: item.amountUsd });
  }
  return { comment, paymentsEnabled, defaultAmountUsd, recipients: parsed };
}

/**
 * @param body - Parsed JSON value.
 * @returns The spend `error` string, when it is a string.
 */
function spendErrorString(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

/**
 * Map a spend status and JSON body to a roster or a route failure.
 *
 * A spend 400 whose `error` is exactly `Invalid comment`,
 * `Invalid payments switch`, `Invalid address or amount`,
 * `Address already listed`, or `Unknown address` stays 400 with that
 * string. Any other spend 400 is 400 `Invalid daily roster change`.
 * Spend 401, 403, 500, any other status, or a 200 body that is not a
 * {@link DailyRoster} is 502 `Daily roster is unavailable`.
 * Network errors and timeouts are not inputs; {@link HttpDailyRoster}
 * maps those to the same 502.
 *
 * @param status - HTTP status from spend.
 * @param body - Parsed JSON, or `undefined` when the body was empty or not JSON.
 * @returns The roster, or a 400/502 failure.
 */
export function mapDailyRosterResponse(status: number, body: unknown): DailyRosterMapped {
  if (status === 400) {
    const error = spendErrorString(body);
    if (error !== undefined && FORWARDED_DAILY_ROSTER_ERRORS.has(error)) {
      return { ok: false, status: 400, error };
    }
    return { ok: false, status: 400, error: DAILY_ROSTER_INVALID_CHANGE };
  }
  if (status === 200) {
    const roster = parseDailyRoster(body);
    if (roster !== undefined) {
      return { ok: true, roster };
    }
  }
  return { ok: false, status: 502, error: DAILY_ROSTER_UNAVAILABLE };
}

/**
 * GET and POST the spend daily-roster JSON API.
 *
 * Constructor `spendUrl` is already trimmed and has no trailing slash.
 * Never logs the token, comment text, or Lightning addresses.
 */
export class HttpDailyRoster implements DailyRosterClient {
  readonly #spendUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;

  /**
   * @param opts - Base URL, Bearer token, fetch, optional timeout (default 5000 ms).
   */
  constructor(opts: { spendUrl: string; token: string; fetchImpl: FetchFn; timeoutMs?: number }) {
    this.#spendUrl = opts.spendUrl;
    this.#token = opts.token;
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET `{spendUrl}/daily-roster`.
   *
   * @returns The roster.
   * @throws {@link DailyRosterRequestError}
   */
  get(): Promise<DailyRoster> {
    return this.#request('/daily-roster');
  }

  /**
   * POST `{spendUrl}/daily-roster/comment`.
   *
   * @param comment - Comment text.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  setComment(comment: string): Promise<DailyRoster> {
    return this.#request('/daily-roster/comment', { comment });
  }

  /**
   * POST `{spendUrl}/daily-roster/payments`.
   *
   * @param enabled - Payments switch.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  setPaymentsEnabled(enabled: boolean): Promise<DailyRoster> {
    return this.#request('/daily-roster/payments', { enabled });
  }

  /**
   * POST `{spendUrl}/daily-roster/recipients`.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  addRecipient(address: string, amountUsd: number): Promise<DailyRoster> {
    return this.#request('/daily-roster/recipients', { address, amountUsd });
  }

  /**
   * POST `{spendUrl}/daily-roster/recipients/update`.
   *
   * @param address - Lightning address.
   * @param amountUsd - USD amount.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  updateRecipient(address: string, amountUsd: number): Promise<DailyRoster> {
    return this.#request('/daily-roster/recipients/update', { address, amountUsd });
  }

  /**
   * POST `{spendUrl}/daily-roster/recipients/delete`.
   *
   * @param address - Lightning address.
   * @returns The roster after the change.
   * @throws {@link DailyRosterRequestError}
   */
  deleteRecipient(address: string): Promise<DailyRoster> {
    return this.#request('/daily-roster/recipients/delete', { address });
  }

  /**
   * One spend call. GET when `body` is omitted. Failures become
   * {@link DailyRosterRequestError} and do not include the token or the body.
   *
   * @param path - Path beginning with `/daily-roster`.
   * @param body - JSON object for POST. Omitted for GET.
   * @returns The roster.
   */
  async #request(
    path: string,
    body?: Record<string, string | number | boolean>,
  ): Promise<DailyRoster> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#spendUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DailyRosterRequestError(502, DAILY_ROSTER_UNAVAILABLE);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new DailyRosterRequestError(502, DAILY_ROSTER_UNAVAILABLE);
    }
    let parsed: unknown;
    try {
      parsed = text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    const mapped = mapDailyRosterResponse(response.status, parsed);
    if (!mapped.ok) {
      throw new DailyRosterRequestError(mapped.status, mapped.error);
    }
    return mapped.roster;
  }
}

/**
 * Resolve a daily roster client from the environment.
 *
 * Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` returns `undefined` and
 * does not call fetch. Trims both values and strips trailing slashes from
 * the URL. Same env rules as the spend ping resolver.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param fetchImpl - HTTP fetch used by {@link HttpDailyRoster}.
 * @returns {@link HttpDailyRoster} when both env values are set; otherwise `undefined`.
 */
export function resolveDailyRoster(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): DailyRosterClient | undefined {
  const rawUrl = env['SPEND_URL'];
  const rawToken = env['SPEND_API_TOKEN'];
  if (
    rawUrl === undefined ||
    rawUrl.trim() === '' ||
    rawToken === undefined ||
    rawToken.trim() === ''
  ) {
    return undefined;
  }
  const spendUrl = rawUrl.trim().replace(/\/+$/u, '');
  return new HttpDailyRoster({ spendUrl, token: rawToken.trim(), fetchImpl });
}
