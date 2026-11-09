/**
 * Outbound ping so a payout signer can pay a listed recipient after a new
 * top-level forum post or a moderator-group conversation message. Whether the
 * decided instruction is POSTed to spend or queued for the Fond member is
 * chosen by `PAYOUT_SIGNER`. Missing env skips the ping; the process still
 * boots. Failures never throw.
 */

import type { AuthStore } from '@/lib/auth/store';
import { resolvePayoutSigner, type LnurlServerConfig } from '@/lib/config';
import type { DailyRosterStore } from '@/lib/daily-roster-store';
import type { FondPayoutStore } from '@/lib/fond-payout-store';
import type { GiftStore } from '@/lib/gift-store';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import { accountByReceivingAddress } from '@/lib/receiving-address';
import {
  decideSpendInstruction,
  welcomeGiftPaidOnUtcDay,
  type SpendGrantStatus,
} from '@/lib/spend-instruction';

/** Default HTTP timeout for {@link HttpPayoutSink}. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Result of {@link SpendPing.pingOnDay}; never includes the Lightning address. */
export type SpendPingOutcome =
  { status: 'accepted' } | { status: 'skipped'; reason: string } | { status: 'failed' };

/**
 * Final delivery step for one decided payout instruction.
 */
export interface PayoutSink {
  /**
   * Deliver `body` for `address`.
   *
   * @param address - Recipient Lightning Address; the HTTP sink only logs it,
   * the fond queue sink stores it in `fond_payout`.
   * @param body - Decided instruction body.
   * @returns `'accepted'`, `'skipped'`, or `'failed'`. Never throws.
   */
  deliver(
    address: string,
    body: Record<string, string | number>,
  ): Promise<'accepted' | 'skipped' | 'failed'>;
}

/**
 * POST `{spendUrl}/ping` with Bearer `SPEND_API_TOKEN`, exactly as the legacy
 * ping did.
 *
 * A `ping` body (no `day`) maps any 2xx to `'accepted'` and everything else
 * to `'failed'`. A `pingOnDay` body (with `day`) uses the strict mapping: 202
 * accepted, 200 whose JSON `status` is `accepted` accepted, 200 whose JSON
 * `status` is `skipped` with a non-empty reason skipped, else failed. Never
 * throws and never logs the token.
 */
export class HttpPayoutSink implements PayoutSink {
  readonly #spendUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;
  #skipReason = '';

  /**
   * @param opts - Already-trimmed base URL (no trailing slash), Bearer token,
   *   fetch, and optional timeout (default 5000 ms).
   */
  constructor(opts: { spendUrl: string; token: string; fetchImpl: FetchFn; timeoutMs?: number }) {
    this.#spendUrl = opts.spendUrl;
    this.#token = opts.token;
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Deliver one instruction. Never throws.
   *
   * @param _address - Unused; the caller logs with the address.
   * @param body - Decided instruction body.
   * @returns Delivery outcome.
   */
  async deliver(
    _address: string,
    body: Record<string, string | number>,
  ): Promise<'accepted' | 'skipped' | 'failed'> {
    this.#skipReason = '';
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
      if (typeof body['day'] !== 'string') {
        return response.ok ? 'accepted' : 'failed';
      }
      if (response.status === 202) {
        return 'accepted';
      }
      if (response.status !== 200) {
        return 'failed';
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return 'failed';
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'failed';
      }
      const record = parsed as Record<string, unknown>;
      const status = record['status'];
      if (status === 'accepted') {
        return 'accepted';
      }
      const reason = record['reason'];
      if (status === 'skipped' && typeof reason === 'string' && reason !== '') {
        this.#skipReason = reason;
        return 'skipped';
      }
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  /**
   * Reason of the most recent skipped delivery.
   *
   * @returns The reason, or `''` when the last delivery was not skipped.
   */
  lastSkipReason(): string {
    return this.#skipReason;
  }
}

/**
 * Queue one decided instruction into `fond_payout` for the Fond member.
 *
 * A new row and an already-queued row return `'accepted'`; a conflicting row
 * that is already `paid` returns `'skipped'` with reason `paid`. Store
 * failures return `'failed'` and never throw.
 */
export class FondQueueSink implements PayoutSink {
  readonly #store: FondPayoutStore;
  readonly #now: () => number;
  #skipReason = '';

  /**
   * @param opts - Queue store and optional clock (default `Date.now`).
   */
  constructor(opts: { store: FondPayoutStore; now?: () => number }) {
    this.#store = opts.store;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Write one row, deduped by spend's keys.
   *
   * @param address - Recipient Lightning Address.
   * @param body - Decided instruction body.
   * @returns `'accepted'`, `'skipped'` (already paid), or `'failed'` (store error).
   */
  async deliver(
    address: string,
    body: Record<string, string | number>,
  ): Promise<'accepted' | 'skipped' | 'failed'> {
    this.#skipReason = '';
    const kind =
      body['kind'] === 'moderator' ? 'moderator' : body['kind'] === 'welcome' ? 'welcome' : 'daily';
    const day = typeof body['day'] === 'string' ? body['day'] : utcDay(this.#now());
    const amountUsd = decidedUsd(body['amountUsd']);
    const comment = body['comment'];
    if (amountUsd === null || typeof comment !== 'string') {
      return 'failed';
    }
    const messageId = kind === 'moderator' ? null : textOrNull(body['messageId']);
    const groupMessageId = kind === 'moderator' ? textOrNull(body['groupMessageId']) : null;
    try {
      const result = await this.#store.enqueue({
        id: crypto.randomUUID(),
        utcDay: day,
        kind,
        address,
        amountUsd,
        comment,
        messageId,
        groupMessageId,
      });
      if (result === 'paid') {
        this.#skipReason = 'paid';
        return 'skipped';
      }
      return result;
    } catch {
      return 'failed';
    }
  }

  /**
   * Reason of the most recent skipped delivery.
   *
   * @returns `paid`, or `''` when the last delivery was not skipped.
   */
  lastSkipReason(): string {
    return this.#skipReason;
  }
}

/** UTC day key `YYYY-MM-DD`. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The decided USD value exactly as received: a finite positive number via
 * `String(number)`, or a non-empty decimal string.
 *
 * @param raw - Body value from the decided instruction.
 * @returns The stored string, or `null` when unusable.
 */
function decidedUsd(raw: string | number | undefined): string | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? String(raw) : null;
  }
  if (typeof raw === 'string') {
    return /^\d+(?:\.\d+)?$/.test(raw) && Number(raw) > 0 ? raw : null;
  }
  return null;
}

/** A string body value, or `null`. */
function textOrNull(value: string | number | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Reason of a skipped delivery. Only {@link HttpPayoutSink} and
 * {@link FondQueueSink} record one; any other sink falls back to `paid`.
 */
function skipReasonOf(sink: PayoutSink): string {
  const read = (sink as { lastSkipReason?: () => string }).lastSkipReason;
  const reason = read === undefined ? '' : read.call(sink);
  return reason === '' ? 'paid' : reason;
}

/**
 * Outbound ping so a payout signer can pay a listed recipient.
 */
export interface SpendPing {
  /**
   * Notify the signer that `address` just created a top-level forum post
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
   * Daily or moderator ping booked on `day` (`YYYY-MM-DD`) instead of the
   * clock UTC day.
   *
   * @param address - Recipient Lightning Address.
   * @param messageId - Forum post id (daily) or moderator-group message id (moderator).
   * @param day - UTC day key `YYYY-MM-DD`.
   * @param grantStatus - Effective grant status; daily only.
   * @param kind - `'daily'` (default) or `'moderator'`.
   */
  pingOnDay?(
    address: string,
    messageId: string,
    day: string,
    grantStatus?: SpendGrantStatus,
    kind?: 'daily' | 'moderator',
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
 * stored, read only the store (no GET); its rows are matched by the account
 * that receives on the pinged address (`accountByReceivingAddress`), so an
 * address no verified wallet receives on matches no stored row. Then deliver
 * the decided instruction through the injected {@link PayoutSink}. A decided
 * amount adds `amountUsd` and `comment` to the instruction body. Skipped
 * reasons `payments_disabled`, `not_listed`, `undecided`, and `welcome_paid`
 * log `spend.ping.skipped` and do not deliver.
 *
 * With the default {@link HttpPayoutSink}, 2xx logs `spend.ping.ok`.
 * Network, abort, non-2xx, a store read throw, a live GET failure, an
 * account lookup throw, and a gift-ledger throw log `spend.ping.failed` and
 * resolve. A `FondQueueSink` logs the same three events from its delivery
 * outcome. Never throws. Never logs the token. Optional `grantStatus` is
 * passed to {@link decideSpendInstruction} only when the resolved kind is
 * daily.
 */
export class HttpSpendPing implements SpendPing {
  readonly #spendUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;
  readonly #rosterStore: DailyRosterStore;
  readonly #gifts: Pick<GiftStore, 'listOutbound'> | undefined;
  readonly #now: () => number;
  readonly #accounts: Pick<AuthStore, 'getAccountByUsername'> | undefined;
  readonly #lnurlServer: LnurlServerConfig | undefined;
  readonly #sink: PayoutSink;

  /**
   * @param opts - Already-trimmed base URL (no trailing slash), Bearer token,
   *   fetch, roster store, optional timeout (default 5000 ms), optional gift
   *   ledger, optional clock, optional account lookup and LNURL server config
   *   (both omitted → no stored row matches), and an optional sink. When the
   *   sink is omitted, an {@link HttpPayoutSink} posts to `spendUrl`.
   */
  constructor(opts: {
    spendUrl?: string;
    token?: string;
    fetchImpl: FetchFn;
    rosterStore: DailyRosterStore;
    sink?: PayoutSink;
    timeoutMs?: number;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
    accounts?: Pick<AuthStore, 'getAccountByUsername'>;
    lnurlServer?: LnurlServerConfig;
  }) {
    this.#spendUrl = opts.spendUrl ?? '';
    this.#token = opts.token ?? '';
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#rosterStore = opts.rosterStore;
    this.#gifts = opts.gifts;
    this.#now = opts.now ?? (() => Date.now());
    this.#accounts = opts.accounts;
    this.#lnurlServer = opts.lnurlServer;
    this.#sink =
      opts.sink ??
      new HttpPayoutSink({
        spendUrl: this.#spendUrl,
        token: this.#token,
        fetchImpl: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
      });
  }

  /**
   * A never-written store reads `GET {spendUrl}/daily-roster` (body never
   * imported). A written store reads the store. Then deliver the decided
   * instruction through the sink. A skip, including welcome already paid
   * today, logs `spend.ping.skipped` and does not deliver. A store read throw
   * or live GET failure logs `spend.ping.failed` and does not deliver.
   * Resolves on success and failure. Never throws. Never logs the token.
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
    const accountId = await this.#recipientId(address);
    if (accountId === 'failed') {
      return;
    }
    let welcomePaidOnUtcDay: boolean | undefined;
    if (resolvedKind === 'daily') {
      const welcomePaid = await this.#welcomePaid(address, utcDay(this.#now()));
      if (welcomePaid === 'failed') {
        return;
      }
      welcomePaidOnUtcDay = welcomePaid;
    }
    const decision = this.#instructionFor(
      address,
      accountId,
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
    const outcome = await this.#sink.deliver(address, body);
    if (outcome === 'accepted') {
      logEvent('spend.ping.ok', { address });
      return;
    }
    if (outcome === 'skipped') {
      logEvent('spend.ping.skipped', { address, reason: skipReasonOf(this.#sink) });
      return;
    }
    logEvent('spend.ping.failed', { address });
  }

  /**
   * Daily or moderator ping booked on `day` (`YYYY-MM-DD`) instead of the
   * clock UTC day. The daily body is
   * `{ address, messageId, amountUsd, comment, day }`; the moderator body is
   * `{ address, kind: "moderator", groupMessageId, amountUsd, comment, day }`
   * and skips the welcome-paid check. Never throws.
   *
   * @param address - Recipient Lightning Address (JSON body).
   * @param messageId - Forum post id (daily `messageId`) or moderator-group
   *   message id (moderator `groupMessageId`).
   * @param day - UTC day key `YYYY-MM-DD`.
   * @param grantStatus - Effective grant status; forwarded for daily.
   * @param kind - `'daily'` (default) or `'moderator'`.
   */
  async pingOnDay(
    address: string,
    messageId: string,
    day: string,
    grantStatus?: SpendGrantStatus,
    kind?: 'daily' | 'moderator',
  ): Promise<SpendPingOutcome> {
    const resolvedKind = kind === 'moderator' ? kind : 'daily';
    const roster = await this.#loadRoster(address);
    if (roster === undefined) {
      return { status: 'failed' };
    }
    const accountId = await this.#recipientId(address);
    if (accountId === 'failed') {
      return { status: 'failed' };
    }
    let welcomePaid: boolean | undefined;
    if (resolvedKind === 'daily') {
      const paid = await this.#welcomePaid(address, day);
      if (paid === 'failed') {
        return { status: 'failed' };
      }
      welcomePaid = paid;
    }
    const decision = this.#instructionFor(
      address,
      accountId,
      resolvedKind,
      roster,
      grantStatus,
      welcomePaid,
    );
    if ('skip' in decision) {
      logEvent('spend.ping.skipped', { address, reason: decision.skip });
      return { status: 'skipped', reason: decision.skip };
    }
    const outcome = await this.#sink.deliver(
      address,
      resolvedKind === 'moderator'
        ? {
            address,
            kind: 'moderator',
            groupMessageId: messageId,
            amountUsd: decision.amountUsd,
            comment: decision.comment,
            day,
          }
        : {
            address,
            messageId,
            amountUsd: decision.amountUsd,
            comment: decision.comment,
            day,
          },
    );
    if (outcome === 'accepted') {
      logEvent('spend.ping.ok', { address });
      return { status: 'accepted' };
    }
    if (outcome === 'skipped') {
      const reason = skipReasonOf(this.#sink);
      logEvent('spend.ping.skipped', { address, reason });
      return { status: 'skipped', reason };
    }
    logEvent('spend.ping.failed', { address });
    return { status: 'failed' };
  }

  async #loadRoster(address: string): Promise<unknown> {
    if (this.#spendUrl === '' || this.#token === '') {
      try {
        return await this.#rosterStore.get();
      } catch {
        logEvent('spend.ping.failed', { address });
        return undefined;
      }
    }
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

  async #welcomePaid(address: string, utcDayKey: string): Promise<boolean | undefined | 'failed'> {
    if (this.#gifts === undefined) {
      return undefined;
    }
    try {
      return welcomeGiftPaidOnUtcDay(await this.#gifts.listOutbound(), address, utcDayKey);
    } catch {
      logEvent('spend.ping.failed', { address });
      return 'failed';
    }
  }

  async #recipientId(address: string): Promise<string | undefined | 'failed'> {
    if (this.#accounts === undefined) {
      return undefined;
    }
    try {
      return (await accountByReceivingAddress(this.#accounts, address, this.#lnurlServer))?.account
        .id;
    } catch {
      logEvent('spend.ping.failed', { address });
      return 'failed';
    }
  }

  #instructionFor(
    address: string,
    accountId: string | undefined,
    kind: 'daily' | 'moderator' | 'welcome',
    roster: unknown,
    grantStatus: SpendGrantStatus | undefined,
    welcomePaidOnUtcDay: boolean | undefined,
  ): ReturnType<typeof decideSpendInstruction> {
    return decideSpendInstruction({
      address,
      ...(accountId === undefined ? {} : { accountId }),
      kind,
      roster,
      ...(kind === 'daily' && grantStatus !== undefined ? { grantStatus } : {}),
      ...(welcomePaidOnUtcDay === undefined ? {} : { welcomePaidOnUtcDay }),
    });
  }
}

/**
 * Resolve a spend ping collaborator from the environment.
 *
 * `PAYOUT_SIGNER` unset, blank, or `spend` keeps the legacy HTTP ping: unset
 * or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller skips).
 * `PAYOUT_SIGNER=fond` uses a {@link FondQueueSink} and needs no spend URL or
 * token. Any other value throws `Invalid PAYOUT_SIGNER`.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param fetchImpl - HTTP fetch used by {@link HttpPayoutSink}.
 * @param opts - Roster store (required), optional gift ledger, clock, account
 *   lookup, LNURL server config, and the fond payout store (required for
 *   `PAYOUT_SIGNER=fond`).
 * @returns A ping when configured; otherwise `undefined`.
 * @throws Error `Invalid PAYOUT_SIGNER` or a missing required store.
 */
export function resolveSpendPing(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
  opts?: {
    rosterStore?: DailyRosterStore;
    fondPayoutStore?: FondPayoutStore;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
    accounts?: Pick<AuthStore, 'getAccountByUsername'>;
    lnurlServer?: LnurlServerConfig;
  },
): SpendPing | undefined {
  const signer = resolvePayoutSigner(env);
  const now = opts?.now ?? (() => Date.now());
  if (signer === 'fond') {
    const rosterStore = opts?.rosterStore;
    if (rosterStore === undefined) {
      throw new Error('Daily roster store is required');
    }
    const fondPayoutStore = opts?.fondPayoutStore;
    if (fondPayoutStore === undefined) {
      throw new Error('Fond payout store is required');
    }
    return new HttpSpendPing({
      fetchImpl,
      rosterStore,
      ...(opts?.gifts === undefined ? {} : { gifts: opts.gifts }),
      now,
      ...(opts?.accounts === undefined ? {} : { accounts: opts.accounts }),
      ...(opts?.lnurlServer === undefined ? {} : { lnurlServer: opts.lnurlServer }),
      sink: new FondQueueSink({ store: fondPayoutStore, now }),
    });
  }
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
  const token = rawToken.trim();
  return new HttpSpendPing({
    fetchImpl,
    rosterStore,
    ...(opts?.gifts === undefined ? {} : { gifts: opts.gifts }),
    now,
    ...(opts?.accounts === undefined ? {} : { accounts: opts.accounts }),
    ...(opts?.lnurlServer === undefined ? {} : { lnurlServer: opts.lnurlServer }),
    spendUrl,
    token,
    sink: new HttpPayoutSink({ spendUrl, token, fetchImpl }),
  });
}
