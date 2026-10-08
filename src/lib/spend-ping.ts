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
 * Read the roster from {@link DailyRosterStore}, then POST `{spendUrl}/ping`
 * with Bearer `SPEND_API_TOKEN`. A decided amount adds `amountUsd` and
 * `comment` to the ping JSON. Skipped reasons `payments_disabled`,
 * `not_listed`, `undecided`, and `welcome_paid` log `spend.ping.skipped`
 * and do not POST.
 *
 * 2xx (including 200 skipped and 202 accepted) logs `spend.ping.ok`.
 * Network, abort, non-2xx, a store read throw, and a gift-ledger throw log
 * `spend.ping.failed` and resolve. Never throws. Never logs the token.
 * Optional `grantStatus` is passed to {@link decideSpendInstruction} only
 * when the resolved kind is daily.
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
   * Read the roster store, then POST the decided ping JSON to
   * `{spendUrl}/ping`. A skip, including welcome already paid today,
   * logs `spend.ping.skipped` and does not POST. A store read throw logs
   * `spend.ping.failed` and does not POST. Resolves on success and failure.
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
    let roster: unknown;
    try {
      roster = await this.#rosterStore.get();
    } catch {
      logEvent('spend.ping.failed', { address });
      return;
    }
    let welcomePaidOnUtcDay: boolean | undefined;
    if (resolvedKind === 'daily' && this.#gifts !== undefined) {
      try {
        welcomePaidOnUtcDay = welcomeGiftPaidOnUtcDay(
          await this.#gifts.listOutbound(),
          address,
          new Date(this.#now()).toISOString().slice(0, 10),
        );
      } catch {
        logEvent('spend.ping.failed', { address });
        return;
      }
    }
    const decision = decideSpendInstruction({
      address,
      kind: resolvedKind,
      roster,
      ...(resolvedKind === 'daily' && grantStatus !== undefined ? { grantStatus } : {}),
      ...(welcomePaidOnUtcDay === undefined ? {} : { welcomePaidOnUtcDay }),
    });
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
