/**
 * Outbound ping so a payout signer can pay a listed recipient after a new
 * top-level forum post or a moderator-group conversation message. With
 * `PAYOUT_SIGNER=fond` the decided instruction is queued for the Fond member;
 * unset or blank `PAYOUT_SIGNER` skips the ping and the process still boots.
 * Failures never throw.
 */

import type { AuthStore } from '@/lib/auth/store';
import { resolvePayoutSigner, type LnurlServerConfig } from '@/lib/config';
import type { DailyRosterStore } from '@/lib/daily-roster-store';
import type { FondPayoutStore } from '@/lib/fond-payout-store';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import { accountByReceivingAddress } from '@/lib/receiving-address';
import {
  decideSpendInstruction,
  welcomeGiftPaidOnUtcDay,
  type SpendGrantStatus,
} from '@/lib/spend-instruction';

/** Result of {@link SpendPing.pingOnDay}; never includes the Lightning address. */
export type SpendPingOutcome =
  { status: 'accepted' } | { status: 'skipped'; reason: string } | { status: 'failed' };

/** Result of one {@link PayoutSink.deliver} call. */
export type PayoutDelivery =
  { outcome: 'accepted' } | { outcome: 'skipped'; reason: string } | { outcome: 'failed' };

/**
 * Final delivery step for one decided payout instruction.
 */
export interface PayoutSink {
  /**
   * Deliver `body` for `address`.
   *
   * @param address - Recipient Lightning Address. `FondQueueSink` stores it in
   * `fond_payout`.
   * @param body - Decided instruction body.
   * @returns The delivery outcome, including any skip reason. Never throws.
   */
  deliver(address: string, body: Record<string, string | number>): Promise<PayoutDelivery>;
}

/**
 * Queue one decided instruction into `fond_payout` for the Fond member.
 *
 * A new row and an already-queued row return accepted; a conflicting row
 * that is already `paid` returns skipped with reason `paid`. Store
 * failures return failed and never throw.
 */
export class FondQueueSink implements PayoutSink {
  readonly #store: FondPayoutStore;
  readonly #now: () => number;

  /**
   * @param opts - Queue store and optional clock (default `Date.now`).
   */
  constructor(opts: { store: FondPayoutStore; now?: () => number }) {
    this.#store = opts.store;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Write one row, deduped as `FondPayoutStore.enqueue` does: per UTC day,
   * kind, and address for daily and moderator rows, once per address for
   * welcome.
   *
   * @param address - Recipient Lightning Address.
   * @param body - Decided instruction body.
   * @returns The delivery outcome, including reason `paid` when skipped.
   */
  async deliver(address: string, body: Record<string, string | number>): Promise<PayoutDelivery> {
    const kind =
      body['kind'] === 'moderator' ? 'moderator' : body['kind'] === 'welcome' ? 'welcome' : 'daily';
    const day = typeof body['day'] === 'string' ? body['day'] : utcDay(this.#now());
    const amountUsd = decidedUsd(body['amountUsd']);
    const comment = body['comment'];
    if (amountUsd === null || typeof comment !== 'string') {
      return { outcome: 'failed' };
    }
    const messageId = kind === 'daily' ? textOrNull(body['messageId']) : null;
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
        return { outcome: 'skipped', reason: 'paid' };
      }
      return result === 'accepted' ? { outcome: 'accepted' } : { outcome: 'failed' };
    } catch {
      return { outcome: 'failed' };
    }
  }
}

/** UTC day key `YYYY-MM-DD`. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Canonical decimal text with at most two fraction digits. */
const EXACT_CENTS_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

/**
 * The decided USD value exactly as received when it is an exact number of
 * cents: a finite positive number whose canonical `String(n)` has at most two
 * fraction digits, or a decimal string of that shape with a positive value.
 *
 * @param raw - Body value from the decided instruction.
 * @returns The stored string, or `null` when it is not an exact cent amount.
 */
function decidedUsd(raw: string | number | undefined): string | null {
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : null) : raw;
  if (typeof text !== 'string' || !EXACT_CENTS_RE.test(text)) {
    return null;
  }
  return BigInt(text.replace('.', '')) > 0n ? text : null;
}

/** A string body value, or `null`. */
function textOrNull(value: string | number | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Outbound ping so a payout signer can pay a listed recipient.
 */
export interface SpendPing {
  /**
   * Notify the signer that `address` just created a top-level forum post
   * (`kind` omitted or `'daily'`), a moderator-group message
   * (`kind === 'moderator'`), or a verified welcome media post
   * (`kind === 'welcome'`). Daily JSON uses `messageId`; welcome JSON omits
   * it because the one-time payout is not attached to a forum gift reply.
   *
   * @param address - Recipient Lightning Address.
   * @param messageId - Forum post id (daily JSON `messageId`; only used to
   *   trigger, not deliver, a welcome) or conversation message id (moderator
   *   JSON `groupMessageId`).
   * @param kind - `'daily'` (default), `'moderator'`, or `'welcome'`.
   * @param grantStatus - Effective grant status; daily only.
   * @returns Delivery outcome when the implementation can report it; legacy
   *   no-op collaborators may resolve void.
   */
  ping(
    address: string,
    messageId: string,
    kind?: 'daily' | 'moderator' | 'welcome',
    grantStatus?: SpendGrantStatus,
  ): Promise<void | SpendPingOutcome>;

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
 * No-op ping when tests inject a collaborator that must not deliver.
 */
export class NoopSpendPing implements SpendPing {
  /**
   * Ignore the address, message id (daily `messageId` / welcome trigger /
   * moderator `groupMessageId`), optional kind, and
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
 * Read the daily roster from the store; its rows are matched by the account
 * that receives on the pinged address (`accountByReceivingAddress`), so an
 * address no verified wallet receives on matches no stored row. Then deliver
 * the decided instruction through the injected {@link PayoutSink}. A decided
 * amount adds `amountUsd` and `comment` to the instruction body. Skipped
 * reasons `payments_disabled`, `not_listed`, `undecided`, and `welcome_paid`
 * log `spend.ping.skipped` and do not deliver.
 *
 * An accepted delivery logs `spend.ping.ok`, a skipped delivery logs
 * `spend.ping.skipped`, and a failed delivery, a store read throw, an account
 * lookup throw, and a gift-ledger throw log `spend.ping.failed` and resolve.
 * Never throws. Optional `grantStatus` is passed to
 * {@link decideSpendInstruction} only when the resolved kind is daily.
 */
export class HttpSpendPing implements SpendPing {
  readonly #rosterStore: DailyRosterStore;
  readonly #gifts: Pick<GiftStore, 'listOutbound'> | undefined;
  readonly #now: () => number;
  readonly #accounts: Pick<AuthStore, 'getAccountByUsername'> | undefined;
  readonly #lnurlServer: LnurlServerConfig | undefined;
  readonly #sink: PayoutSink;

  /**
   * @param opts - Roster store, payout sink, optional gift ledger, optional
   *   clock, and optional account lookup and LNURL server config (both
   *   omitted → no stored row matches).
   */
  constructor(opts: {
    rosterStore: DailyRosterStore;
    sink: PayoutSink;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
    accounts?: Pick<AuthStore, 'getAccountByUsername'>;
    lnurlServer?: LnurlServerConfig;
  }) {
    this.#rosterStore = opts.rosterStore;
    this.#gifts = opts.gifts;
    this.#now = opts.now ?? (() => Date.now());
    this.#accounts = opts.accounts;
    this.#lnurlServer = opts.lnurlServer;
    this.#sink = opts.sink;
  }

  /**
   * Read the roster store, then deliver the decided instruction through the
   * sink. A skip, including welcome already paid today, logs
   * `spend.ping.skipped` and does not deliver. A store read throw logs
   * `spend.ping.failed` and does not deliver. Resolves with the delivery
   * outcome on success, skip, and failure. Never throws.
   *
   * @param address - Recipient Lightning Address (JSON body).
   * @param messageId - Forum post id for daily JSON or a welcome trigger;
   *   conversation message id for moderator JSON (`groupMessageId`).
   * @param kind - `'daily'` (default), `'moderator'`, or `'welcome'`.
   * @param grantStatus - Effective grant status; forwarded only for daily.
   */
  async ping(
    address: string,
    messageId: string,
    kind?: 'daily' | 'moderator' | 'welcome',
    grantStatus?: SpendGrantStatus,
  ): Promise<SpendPingOutcome> {
    const resolvedKind = kind === 'moderator' || kind === 'welcome' ? kind : 'daily';
    const roster = await this.#loadRoster(address);
    if (roster === undefined) {
      return { status: 'failed' };
    }
    const accountId = await this.#recipientId(address);
    if (accountId === 'failed') {
      return { status: 'failed' };
    }
    let welcomePaidOnUtcDay: boolean | undefined;
    if (resolvedKind === 'daily') {
      const welcomePaid = await this.#welcomePaid(address, utcDay(this.#now()));
      if (welcomePaid === 'failed') {
        return { status: 'failed' };
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
      return { status: 'skipped', reason: decision.skip };
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
    if (outcome.outcome === 'accepted') {
      logEvent('spend.ping.ok', { address });
      return { status: 'accepted' };
    }
    if (outcome.outcome === 'skipped') {
      logEvent('spend.ping.skipped', { address, reason: outcome.reason });
      return { status: 'skipped', reason: outcome.reason };
    }
    logEvent('spend.ping.failed', { address });
    return { status: 'failed' };
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
    if (outcome.outcome === 'accepted') {
      logEvent('spend.ping.ok', { address });
      return { status: 'accepted' };
    }
    if (outcome.outcome === 'skipped') {
      const reason = outcome.reason;
      logEvent('spend.ping.skipped', { address, reason });
      return { status: 'skipped', reason };
    }
    logEvent('spend.ping.failed', { address });
    return { status: 'failed' };
  }

  async #loadRoster(address: string): Promise<unknown> {
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
 * `PAYOUT_SIGNER` unset or blank → `undefined` (no payout sink; the caller
 * skips). `PAYOUT_SIGNER=fond` uses a {@link FondQueueSink}. Any other value,
 * including `spend`, throws `Invalid PAYOUT_SIGNER`.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param opts - Roster store and fond payout store (both required for
 *   `PAYOUT_SIGNER=fond`), optional gift ledger, clock, account lookup, and
 *   LNURL server config.
 * @returns A ping when configured; otherwise `undefined`.
 * @throws Error `Invalid PAYOUT_SIGNER` or a missing required store.
 */
export function resolveSpendPing(
  env: Record<string, string | undefined>,
  opts?: {
    rosterStore?: DailyRosterStore;
    fondPayoutStore?: FondPayoutStore;
    gifts?: Pick<GiftStore, 'listOutbound'>;
    now?: () => number;
    accounts?: Pick<AuthStore, 'getAccountByUsername'>;
    lnurlServer?: LnurlServerConfig;
  },
): SpendPing | undefined {
  if (resolvePayoutSigner(env) === 'none') {
    return undefined;
  }
  const rosterStore = opts?.rosterStore;
  if (rosterStore === undefined) {
    throw new Error('Daily roster store is required');
  }
  const fondPayoutStore = opts?.fondPayoutStore;
  if (fondPayoutStore === undefined) {
    throw new Error('Fond payout store is required');
  }
  const now = opts?.now ?? (() => Date.now());
  return new HttpSpendPing({
    rosterStore,
    ...(opts?.gifts === undefined ? {} : { gifts: opts.gifts }),
    now,
    ...(opts?.accounts === undefined ? {} : { accounts: opts.accounts }),
    ...(opts?.lnurlServer === undefined ? {} : { lnurlServer: opts.lnurlServer }),
    sink: new FondQueueSink({ store: fondPayoutStore, now }),
  });
}
