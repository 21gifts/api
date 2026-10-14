/**
 * Outbound ping so the spend worker can pay a listed recipient after a
 * new top-level forum post or a moderator-group conversation message.
 * Missing env skips the ping; the process still boots. Failures never throw.
 */

import type { DailyRosterStore } from '@/lib/daily-roster-store';
import type { GiftStore } from '@/lib/gift-store';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import {
  decideSpendInstruction,
  welcomeGiftPaidOnUtcDay,
  type SpendGrantStatus,
} from '@/lib/spend-instruction';

/** Default HTTP timeout for {@link HttpSpendPing}. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Result of {@link SpendPing.pingOnDay}; never includes the Lightning address. */
export type SpendPingOutcome =
  { status: 'accepted' } | { status: 'skipped'; reason: string } | { status: 'failed' };

/**
 * Outbound ping so the spend worker can pay a listed recipient.
 */
export interface SpendPing {
  /**
   * Notify spend that `address` just created a top-level forum post
   * (`kind` omitted or `'daily'`), a moderator-group message
   * (`kind === 'moderator'`), or a verified welcome media post
   * (`kind === 'welcome'`). Daily JSON uses `messageId`; welcome JSON is
   * `{ address, messageId, kind: "welcome" }`.
   *
   * @param address - Recipient Lightning Address.
   * @param messageId - Forum post id (daily JSON `messageId` / welcome
   *   JSON `messageId`) or conversation message id (moderator JSON
   *   `groupMessageId`).
   * @param kind - `'daily'` (default), `'moderator'`, or `'welcome'`.
   * @param grantStatus - Effective grant status; daily only.
   */
  ping(
    address: string,
    messageId: string,
    kind?: 'daily' | 'moderator' | 'welcome',
    grantStatus?: SpendGrantStatus,
  ): Promise<void>;

  /**
   * Daily ping booked on `day` (`YYYY-MM-DD`) instead of the clock UTC day.
   *
   * @param address - Recipient Lightning Address.
   * @param messageId - Forum post id.
   * @param day - UTC day key `YYYY-MM-DD`.
   * @param grantStatus - Effective grant status; daily only.
   */
  pingOnDay?(
    address: string,
    messageId: string,
    day: string,
    grantStatus?: SpendGrantStatus,
  ): Promise<SpendPingOutcome>;
}

/**
 * No-op ping when tests inject a collaborator that must not call HTTP.
 */
export class NoopSpendPing implements SpendPing {
  /**
   * Ignore the address, message id (daily `messageId` / welcome
   * `messageId` / moderator `groupMessageId`), optional kind, and
   * optional grant status.
   *
   * @param _address - Unused.
   * @param _messageId - Unused.
   * @param _kind - Unused.
   * @param _grantStatus - Unused.
   */
  ping(
    _address: string,
    _messageId: string,
    _kind?: 'daily' | 'moderator' | 'welcome',
    _grantStatus?: SpendGrantStatus,
  ): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Until the roster store has been written, `GET {spendUrl}/daily-roster`
 * and decide from that JSON without importing it. After a roster has been
 * stored, read only the store (no GET). Then POST `{spendUrl}/ping` with
 * Bearer `SPEND_API_TOKEN`. A decided amount adds `amountUsd` and
 * `comment` to the ping JSON. Skipped reasons `payments_disabled`,
 * `not_listed`, `undecided`, and `welcome_paid` log `spend.ping.skipped`
 * and do not POST.
 *
 * For `ping`, 2xx (including 200 skipped and 202 accepted) logs
 * `spend.ping.ok`. For `pingOnDay`, 202 and 200 `accepted` log
 * `spend.ping.ok`, 200 `skipped` with a non-empty `reason` logs
 * `spend.ping.skipped`, and any other status or body logs
 * `spend.ping.failed`.
 * Network, abort, non-2xx, a store read throw, a live GET failure, and a
 * gift-ledger throw log `spend.ping.failed` and resolve. Never throws.
 * Never logs the token. Optional `grantStatus` is passed to
 * {@link decideSpendInstruction} only when the resolved kind is daily.
 */
export class HttpSpendPing implements SpendPing {
  readonly #spendUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;
  readonly #rosterStore: DailyRosterStore;
  readonly #gifts: Pick<GiftStore, 'listOutbound'> | undefined;
  readonly #now: () => number;

  /**
   * @param opts - Already-trimmed base URL (no trailing slash), Bearer token,
   *   fetch, roster store, optional timeout (default 5000 ms), optional gift
   *   ledger, optional clock.
   */
  constructor(opts: {
    spendUrl: string;
    token: string;
    fetchImpl: FetchFn;
    rosterStore: DailyRosterStore;
    timeoutMs?: number;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
  }) {
    this.#spendUrl = opts.spendUrl;
    this.#token = opts.token;
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#rosterStore = opts.rosterStore;
    this.#gifts = opts.gifts;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * A never-written store reads `GET {spendUrl}/daily-roster` (body never
   * imported). A written store reads the store. Then POST the decided ping
   * JSON to `{spendUrl}/ping`. A skip, including welcome already paid today,
   * logs `spend.ping.skipped` and does not POST. A store read throw or live
   * GET failure logs `spend.ping.failed` and does not POST. Resolves on
   * success and failure. Never throws. Never logs the token.
   *
   * @param address - Recipient Lightning Address (JSON body).
   * @param messageId - Forum post id for daily/welcome pings (JSON
   *   `messageId`); conversation message id for moderator pings (JSON
   *   `groupMessageId`).
   * @param kind - `'daily'` (default), `'moderator'`, or `'welcome'`.
   * @param grantStatus - Effective grant status; forwarded only for daily.
   */
  async ping(
    address: string,
    messageId: string,
    kind?: 'daily' | 'moderator' | 'welcome',
    grantStatus?: SpendGrantStatus,
  ): Promise<void> {
    const resolvedKind = kind === 'moderator' || kind === 'welcome' ? kind : 'daily';
    const roster = await this.#loadRoster(address);
    if (roster === undefined) {
      return;
    }
    let welcomePaidOnUtcDay: boolean | undefined;
    if (resolvedKind === 'daily') {
      const welcomePaid = await this.#welcomePaid(
        address,
        new Date(this.#now()).toISOString().slice(0, 10),
      );
      if (welcomePaid === 'failed') {
        return;
      }
      welcomePaidOnUtcDay = welcomePaid;
    }
    const decision = this.#instructionFor(
      address,
      resolvedKind,
      roster,
      grantStatus,
      welcomePaidOnUtcDay,
    );
    if ('skip' in decision) {
      logEvent('spend.ping.skipped', { address, reason: decision.skip });
      return;
    }
    const body =
      resolvedKind === 'moderator'
        ? {
            address,
            kind: 'moderator',
            groupMessageId: messageId,
            amountUsd: decision.amountUsd,
            comment: decision.comment,
          }
        : resolvedKind === 'welcome'
          ? {
              address,
              messageId,
              kind: 'welcome',
              amountUsd: decision.amountUsd,
              comment: decision.comment,
            }
          : {
              address,
              messageId,
              amountUsd: decision.amountUsd,
              comment: decision.comment,
            };
    await this.#postPing(address, body);
  }

  /**
   * Daily ping booked on `day` (`YYYY-MM-DD`) instead of the clock UTC day.
   * Kind is always daily. The POST body is
   * `{ address, messageId, amountUsd, comment, day }`. Never throws.
   *
   * @param address - Recipient Lightning Address (JSON body).
   * @param messageId - Forum post id (JSON `messageId`).
   * @param day - UTC day key `YYYY-MM-DD`.
   * @param grantStatus - Effective grant status; forwarded for daily.
   */
  async pingOnDay(
    address: string,
    messageId: string,
    day: string,
    grantStatus?: SpendGrantStatus,
  ): Promise<SpendPingOutcome> {
    const roster = await this.#loadRoster(address);
    if (roster === undefined) {
      return { status: 'failed' };
    }
    const welcomePaid = await this.#welcomePaid(address, day);
    if (welcomePaid === 'failed') {
      return { status: 'failed' };
    }
    const decision = this.#instructionFor(address, 'daily', roster, grantStatus, welcomePaid);
    if ('skip' in decision) {
      logEvent('spend.ping.skipped', { address, reason: decision.skip });
      return { status: 'skipped', reason: decision.skip };
    }
    try {
      const response = await this.#fetchImpl(`${this.#spendUrl}/ping`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address,
          messageId,
          amountUsd: decision.amountUsd,
          comment: decision.comment,
          day,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.status === 202) {
        logEvent('spend.ping.ok', { address });
        return { status: 'accepted' };
      }
      if (response.status !== 200) {
        logEvent('spend.ping.failed', { address });
        return { status: 'failed' };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        logEvent('spend.ping.failed', { address });
        return { status: 'failed' };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        logEvent('spend.ping.failed', { address });
        return { status: 'failed' };
      }
      const rec = parsed as Record<string, unknown>;
      const status = rec['status'];
      if (status === 'accepted') {
        logEvent('spend.ping.ok', { address });
        return { status: 'accepted' };
      }
      const reason = rec['reason'];
      if (status === 'skipped' && typeof reason === 'string' && reason !== '') {
        logEvent('spend.ping.skipped', { address, reason });
        return { status: 'skipped', reason };
      }
      logEvent('spend.ping.failed', { address });
      return { status: 'failed' };
    } catch {
      logEvent('spend.ping.failed', { address });
      return { status: 'failed' };
    }
  }

  async #loadRoster(address: string): Promise<unknown> {
    let written: boolean;
    try {
      written = await this.#rosterStore.hasBeenWritten();
    } catch {
      logEvent('spend.ping.failed', { address });
      return undefined;
    }
    if (!written) {
      try {
        const response = await this.#fetchImpl(`${this.#spendUrl}/daily-roster`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.#token}`,
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!response.ok) {
          logEvent('spend.ping.failed', { address });
          return undefined;
        }
        const parsed: unknown = await response.json();
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          logEvent('spend.ping.failed', { address });
          return undefined;
        }
        return parsed;
      } catch {
        logEvent('spend.ping.failed', { address });
        return undefined;
      }
    }
    try {
      return await this.#rosterStore.get();
    } catch {
      logEvent('spend.ping.failed', { address });
      return undefined;
    }
  }

  async #welcomePaid(address: string, utcDay: string): Promise<boolean | undefined | 'failed'> {
    if (this.#gifts === undefined) {
      return undefined;
    }
    try {
      return welcomeGiftPaidOnUtcDay(await this.#gifts.listOutbound(), address, utcDay);
    } catch {
      logEvent('spend.ping.failed', { address });
      return 'failed';
    }
  }

  #instructionFor(
    address: string,
    kind: 'daily' | 'moderator' | 'welcome',
    roster: unknown,
    grantStatus: SpendGrantStatus | undefined,
    welcomePaidOnUtcDay: boolean | undefined,
  ): ReturnType<typeof decideSpendInstruction> {
    return decideSpendInstruction({
      address,
      kind,
      roster,
      ...(kind === 'daily' && grantStatus !== undefined ? { grantStatus } : {}),
      ...(welcomePaidOnUtcDay === undefined ? {} : { welcomePaidOnUtcDay }),
    });
  }

  async #postPing(address: string, body: Record<string, string | number>): Promise<void> {
    try {
      const response = await this.#fetchImpl(`${this.#spendUrl}/ping`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.ok) {
        logEvent('spend.ping.ok', { address });
        return;
      }
      logEvent('spend.ping.failed', { address });
    } catch {
      logEvent('spend.ping.failed', { address });
    }
  }
}

/**
 * Resolve a spend ping collaborator from the environment.
 *
 * Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller
 * skips). Trims both values and strips trailing slashes from the URL.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param fetchImpl - HTTP fetch used by {@link HttpSpendPing}.
 * @param opts - Roster store (required when both env values are set), optional
 *   gift ledger and clock forwarded to {@link HttpSpendPing}.
 * @returns {@link HttpSpendPing} when both env values are set; otherwise `undefined`.
 */
export function resolveSpendPing(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
  opts?: {
    rosterStore?: DailyRosterStore;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
  },
): SpendPing | undefined {
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
  const rosterStore = opts?.rosterStore;
  if (rosterStore === undefined) {
    throw new Error('Daily roster store is required');
  }
  const spendUrl = rawUrl.trim().replace(/\/+$/u, '');
  return new HttpSpendPing({
    spendUrl,
    token: rawToken.trim(),
    fetchImpl,
    rosterStore,
    ...(opts?.gifts === undefined ? {} : { gifts: opts.gifts }),
    ...(opts?.now === undefined ? {} : { now: opts.now }),
  });
}
