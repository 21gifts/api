/** Serialized background synchronization of every current and previous Spark wallet. */

import type { AuthStore } from '@/lib/auth/store';
import { effectiveStatus, utcDayKey } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { GiftStore } from '@/lib/gift-store';
import { pingTodayMedia, type TodayMediaPingDeps } from '@/lib/funding-ping';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { logEvent } from '@/lib/log';
import { addUtcDays } from '@/lib/member-habit';
import { bytesToHex } from '@/lib/nostr/kek';
import type { SparkViewer, SparkViewerTransfer } from '@/lib/spark-viewer';
import type { WalletStore } from '@/lib/wallet-store';
import type {
  WalletTransferRecord,
  WalletTransferStatus,
  WalletTransferStore,
  WalletTransferType,
  WalletTransferWallet,
  WalletTokenTransactionStatus,
} from '@/lib/wallet-transfer-store';

/** Default delay between complete wallet sync passes. */
export const WALLET_TRANSFER_INTERVAL_MS = 60_000;

/** Abort a logical SDK call after this period. */
export const WALLET_TRANSFER_CALL_TIMEOUT_MS = 15_000;

const WALLET_TRANSFER_CONCURRENCY = 4;
const WALLET_TRANSFER_PAGE_SIZE = 100;
const WALLET_TRANSFER_OVERLAP_MS = 60 * 60_000;

/** Dependencies for one sync pass and the self-scheduling worker. */
export interface WalletTransferWorkerDeps {
  viewer: SparkViewer;
  transfers: WalletTransferStore;
  balances: Pick<WalletStore, 'recordBalance'>;
  auth: Pick<AuthStore, 'getAccount' | 'hasRecoveryShareForVerifiedWallet'>;
  funding: Pick<FundingStore, 'getByAccountId'>;
  gifts?: Pick<GiftStore, 'listOutbound'>;
  ping: TodayMediaPingDeps;
  now: () => number;
}

function transferType(value: number): WalletTransferType {
  switch (value) {
    case 0:
      return 'preimage_swap';
    case 1:
      return 'cooperative_exit';
    case 2:
      return 'transfer';
    case 3:
      return 'utxo_swap';
    case 4:
      return 'primary_swap_v3';
    case 5:
      return 'counter_swap_v3';
    case 30:
      return 'swap';
    case 40:
      return 'counter_swap';
    default:
      return 'unrecognized';
  }
}

function transferStatus(value: number): WalletTransferStatus {
  if (value === 5) return 'completed';
  if (value === 6) return 'expired';
  if (value === 7) return 'returned';
  return 'pending';
}

function receiverStatuses(rows: ReadonlyArray<{ status: number }>): WalletTransferStatus {
  if (rows.every((row) => row.status === 6)) return 'completed';
  if (rows.some((row) => row.status === 7)) return 'cancelled';
  return 'pending';
}

function tokenStatus(value: number): WalletTokenTransactionStatus {
  if (value === 0) return 'started';
  if (value === 1) return 'signed';
  if (value === 5) return 'revealed';
  if (value === 2) return 'finalized';
  if (value === 3 || value === 4) return 'cancelled';
  return 'unknown';
}

function publicKey(value: Uint8Array): string | null {
  const key = bytesToHex(value);
  return /^0[23][0-9a-f]{64}$/.test(key) ? key : null;
}

function safeSum(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function normalizedTransfer(
  wallet: WalletTransferWallet,
  transfer: SparkViewerTransfer,
  seenAt: Date,
): WalletTransferRecord | null {
  let direction: 'in' | 'out' | null = null;
  let counterpartyPubkey: string | null = null;
  let counterpartyPubkeys: string[] = [];
  let amountSats: number | null = null;
  let status: WalletTransferStatus | null = null;
  if (transfer.senders.length > 0 || transfer.receivers.length > 0) {
    const senders = transfer.senders.map((sender) => ({
      ...sender,
      key: publicKey(sender.identityPublicKey),
    }));
    const receivers = transfer.receivers.map((receiver) => ({
      ...receiver,
      key: publicKey(receiver.identityPublicKey),
    }));
    const senderIds = new Set(
      senders
        .filter((sender) => sender.id !== '' && sender.key === wallet.sparkPubkey)
        .map((sender) => sender.id),
    );
    const receiverRows = receivers.filter(
      (receiver) => receiver.id !== '' && receiver.key === wallet.sparkPubkey,
    );
    const receiverIds = new Set(receiverRows.map((receiver) => receiver.id));
    if (senderIds.size > 0) {
      direction = 'out';
      const leaves = transfer.leaves.filter((leaf) => senderIds.has(leaf.senderId));
      amountSats = safeSum(leaves.map((leaf) => leaf.value));
      counterpartyPubkeys = outboundCounterpartiesOf(receivers, leaves, wallet.sparkPubkey);
      counterpartyPubkey = counterpartyPubkeys[0] ?? null;
    } else if (receiverIds.size > 0) {
      direction = 'in';
      const leaves = transfer.leaves.filter((leaf) => receiverIds.has(leaf.receiverId));
      amountSats = safeSum(leaves.map((leaf) => leaf.value));
      status = receiverStatuses(receiverRows);
      counterpartyPubkeys = inboundCounterpartiesOf(senders, leaves);
      counterpartyPubkey = counterpartyPubkeys[0] ?? null;
    }
  } else {
    const sender = publicKey(transfer.senderIdentityPublicKey);
    const receiver = publicKey(transfer.receiverIdentityPublicKey);
    direction =
      sender === wallet.sparkPubkey ? 'out' : receiver === wallet.sparkPubkey ? 'in' : null;
    counterpartyPubkey = direction === 'out' ? receiver : sender;
    counterpartyPubkeys = counterpartyPubkey === null ? [] : [counterpartyPubkey];
    amountSats = transfer.totalValue;
  }
  if (
    direction === null ||
    counterpartyPubkey === null ||
    transfer.id === '' ||
    amountSats === null ||
    !Number.isSafeInteger(amountSats) ||
    amountSats < 0
  ) {
    return null;
  }
  return {
    accountId: wallet.accountId,
    walletPubkey: wallet.sparkPubkey,
    transferId: transfer.id,
    direction,
    type: transferType(transfer.type),
    status: status ?? transferStatus(transfer.status),
    amountSats,
    counterpartyPubkey,
    counterpartyPubkeys,
    sparkInvoice: transfer.sparkInvoice === '' ? null : transfer.sparkInvoice,
    transferCreatedAt: transfer.createdTime ?? null,
    transferUpdatedAt: transfer.updatedTime ?? null,
    seenAt,
  };
}

function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Spark viewer timeout')),
        WALLET_TRANSFER_CALL_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function createdAfterOf(state: {
  newestCreatedAt: Date | null;
  oldestPendingCreatedAt: Date | null;
  pendingWithoutCreatedAt: boolean;
}): Date | undefined {
  if (state.pendingWithoutCreatedAt) return undefined;
  const candidates = [
    state.newestCreatedAt === null
      ? null
      : state.newestCreatedAt.getTime() - WALLET_TRANSFER_OVERLAP_MS,
    state.oldestPendingCreatedAt === null ? null : state.oldestPendingCreatedAt.getTime() - 1,
  ].filter((value): value is number => value !== null);
  return candidates.length === 0 ? undefined : new Date(Math.min(...candidates));
}

async function syncWallet(
  deps: WalletTransferWorkerDeps,
  wallet: WalletTransferWallet,
): Promise<{ inserted: number; updated: number }> {
  const state = await deps.transfers.syncState(wallet.accountId, wallet.sparkPubkey);
  const today = utcDayKey(deps.now());
  const fullScan =
    state.lastFullSyncAt === null || utcDayKey(state.lastFullSyncAt.getTime()) !== today;
  const createdAfter = fullScan ? undefined : createdAfterOf(state);
  let offset = 0;
  let inserted = 0;
  let updated = 0;
  const yesterday = addUtcDays(today, -1);
  const seenOffsets = new Set<number>([0]);
  for (;;) {
    const page = await timed(
      deps.viewer.transfers({
        sparkAddress: wallet.sparkAddress,
        limit: WALLET_TRANSFER_PAGE_SIZE,
        offset,
        ...(createdAfter === undefined ? {} : { createdAfter }),
      }),
    );
    const seenAt = new Date(deps.now());
    for (const transfer of page.transfers) {
      const row = normalizedTransfer(wallet, transfer, seenAt);
      if (row === null) continue;
      const outcome = await deps.transfers.upsertTransfer(row);
      if (outcome.inserted) inserted += 1;
      if (outcome.updated) updated += 1;
    }
    if (shouldStopTransferPaging(page)) break;
    if (seenOffsets.has(page.offset)) {
      throw new Error('Spark viewer transfer offset did not advance');
    }
    seenOffsets.add(page.offset);
    offset = page.offset;
  }

  const tokenCreatedAfter = fullScan
    ? undefined
    : createdAfterOf({
        newestCreatedAt: state.newestTokenCreatedAt ?? null,
        oldestPendingCreatedAt: state.oldestPendingTokenCreatedAt ?? null,
        pendingWithoutCreatedAt: state.pendingTokenWithoutCreatedAt ?? false,
      });
  let cursor: string | undefined;
  const seenTokenCursors = new Set<string>();
  for (;;) {
    const page = await timed(
      deps.viewer.tokenTransactions({
        sparkAddress: wallet.sparkAddress,
        walletPubkey: wallet.sparkPubkey,
        pageSize: WALLET_TRANSFER_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const seenAt = new Date(deps.now());
    for (const transaction of page.transactions) {
      await deps.transfers.upsertTokenTransaction({
        accountId: wallet.accountId,
        walletPubkey: wallet.sparkPubkey,
        transactionHash: transaction.hash,
        tokenIdentifier: transaction.tokenIdentifier,
        direction: transaction.direction,
        amount: transaction.amount,
        counterpartyPubkeys: transaction.counterpartyPubkeys,
        type: transaction.type,
        status: tokenStatus(transaction.status),
        transactionCreatedAt: transaction.createdTime ?? null,
        transactionExpiryAt: transaction.expiryTime ?? null,
        seenAt,
      });
    }
    if (
      (!fullScan && tokenPagePrecedes(page.transactions, tokenCreatedAfter)) ||
      page.rawCount < WALLET_TRANSFER_PAGE_SIZE ||
      !page.hasNextPage
    ) {
      break;
    }
    if (page.nextCursor === null || seenTokenCursors.has(page.nextCursor)) {
      throw new Error('Spark viewer token cursor did not advance');
    }
    seenTokenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const catchUpKey = `${wallet.accountId}\u0000${today}`;
  const successful = successfulCatchUpPingsFor(deps.transfers, today);
  if (
    !successful.has(catchUpKey) &&
    (await deps.transfers.hasShopPayment(wallet.accountId, yesterday, today))
  ) {
    const account = await deps.auth.getAccount(wallet.accountId);
    if (
      account !== undefined &&
      !(await hasDailyPayoutToday(deps.gifts, account.username, today))
    ) {
      const nowMs = deps.now();
      const payout = await loadPayoutEligibility(
        deps.funding,
        deps.auth,
        account,
        nowMs,
        deps.ping.recoveryShareRequiredFrom ?? null,
        deps.transfers,
      );
      if (payout.eligible) {
        const result = await pingTodayMedia(
          deps.ping,
          account,
          nowMs,
          effectiveStatus(payout.grant, nowMs),
          true,
        );
        if (result === 'failed') throw new Error('Daily catch-up ping failed');
        if (result === 'sent') successful.add(catchUpKey);
      }
    }
  }

  const balance = await timed(deps.viewer.balance(wallet.sparkAddress));
  const observedAt = new Date(deps.now());
  await deps.balances.recordBalance({
    id: crypto.randomUUID(),
    accountId: wallet.accountId,
    walletPubkey: wallet.sparkPubkey,
    balanceSats: balance,
    syncedAt: observedAt,
    receivedAt: observedAt,
  });
  if (fullScan) {
    await deps.transfers.markFullSync(wallet.accountId, wallet.sparkPubkey, observedAt);
  }
  return { inserted, updated };
}

/**
 * Synchronize all due wallets once, at most four at a time.
 *
 * @param deps - Viewer, stores, catch-up ping collaborators, and clock.
 * @param retryAfter - Per-wallet epoch deadlines; later wallets are skipped.
 * @returns Attempt-state map: true for failures and false for backoff skips.
 */
export async function runWalletTransferTick(
  deps: WalletTransferWorkerDeps,
  retryAfter: ReadonlyMap<string, number> = new Map(),
): Promise<Map<string, boolean>> {
  const wallets = await deps.transfers.listWallets();
  const failed = new Map<string, boolean>();
  for (let start = 0; start < wallets.length; start += WALLET_TRANSFER_CONCURRENCY) {
    await Promise.all(
      wallets.slice(start, start + WALLET_TRANSFER_CONCURRENCY).map(async (wallet) => {
        const key = `${wallet.accountId}\u0000${wallet.sparkPubkey}`;
        if ((retryAfter.get(key) ?? 0) > deps.now()) {
          failed.set(key, false);
          return;
        }
        try {
          const changed = await syncWallet(deps, wallet);
          if (changed.inserted > 0 || changed.updated > 0) {
            logEvent('wallet_transfer.synced', { accountId: wallet.accountId, ...changed });
          }
        } catch (error) {
          failed.set(key, true);
          logEvent('wallet_transfer.failed', {
            accountId: wallet.accountId,
            reason: error instanceof Error ? error.name : 'unknown',
          });
        }
      }),
    );
  }
  return failed;
}

/**
 * Start an immediate serialized pass and self-schedule later passes.
 *
 * @param deps - Viewer, stores, catch-up ping collaborators, and clock.
 * @param intervalMs - Base tick interval, default 60 seconds.
 * @returns Handle that stops future schedules.
 */
export function startWalletTransferWorker(
  deps: WalletTransferWorkerDeps,
  intervalMs: number = WALLET_TRANSFER_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempts = new Map<string, number>();
  const retryAfter = new Map<string, number>();
  const tick = (): void => {
    void runWalletTransferTick(deps, retryAfter)
      .then((failed) => {
        for (const key of [...attempts.keys()]) {
          if (!failed.has(key)) {
            attempts.delete(key);
            retryAfter.delete(key);
          }
        }
        for (const [key, didFail] of failed) {
          if (!didFail) continue;
          const count = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, count);
          retryAfter.set(
            key,
            deps.now() + Math.min(60 * 60_000, intervalMs * 2 ** Math.min(count, 6)),
          );
        }
      })
      .catch((error: unknown) => {
        logEvent('wallet_transfer.failed', {
          accountId: 'all',
          reason: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
function outboundCounterpartiesOf(
  receivers: ReadonlyArray<{ id: string; key: string | null }>,
  leaves: ReadonlyArray<{ receiverId: string }>,
  walletPubkey: string,
): string[] {
  const receiverById = new Map(
    receivers
      .filter((receiver) => receiver.id !== '')
      .map((receiver) => [receiver.id, receiver.key]),
  );
  const candidates = new Set(leaves.map((leaf) => receiverById.get(leaf.receiverId) ?? null));
  const external = [...candidates]
    .filter((key): key is string => key !== null && key !== walletPubkey)
    .sort();
  return external.length > 0
    ? external
    : [...candidates].filter((key): key is string => key === walletPubkey);
}

function inboundCounterpartiesOf(
  senders: ReadonlyArray<{ id: string; key: string | null }>,
  leaves: ReadonlyArray<{ senderId: string }>,
): string[] {
  const senderById = new Map(
    senders.filter((sender) => sender.id !== '').map((sender) => [sender.id, sender.key]),
  );
  const candidates = new Set(leaves.map((leaf) => senderById.get(leaf.senderId) ?? null));
  return [...candidates].filter((key): key is string => key !== null).sort();
}

function tokenPagePrecedes(
  transactions: ReadonlyArray<{ createdTime: Date | undefined }>,
  createdAfter: Date | undefined,
): boolean {
  return (
    createdAfter !== undefined &&
    transactions.length > 0 &&
    transactions.every(
      (transaction) =>
        transaction.createdTime !== undefined &&
        transaction.createdTime.getTime() < createdAfter.getTime(),
    )
  );
}

const successfulCatchUpPings = new WeakMap<WalletTransferStore, Set<string>>();

function successfulCatchUpPingsFor(store: WalletTransferStore, today: string): Set<string> {
  const successes = successfulCatchUpPings.get(store) ?? new Set<string>();
  for (const key of successes) if (!key.endsWith(`\u0000${today}`)) successes.delete(key);
  successfulCatchUpPings.set(store, successes);
  return successes;
}

async function hasDailyPayoutToday(
  gifts: Pick<GiftStore, 'listOutbound'> | undefined,
  username: string | null | undefined,
  today: string,
): Promise<boolean> {
  if (gifts === undefined) return false;
  const handle = (username ?? '').trim().toLowerCase();
  if (handle === '') return false;
  return (await gifts.listOutbound()).some((gift) => {
    const recipient = gift.recipientWosUser.trim().toLowerCase().split('@')[0]!;
    return (
      gift.kind === 'daily' && recipient === handle && utcDayKey(gift.paidAt.getTime()) === today
    );
  });
}

function shouldStopTransferPaging(page: {
  rawCount?: number | null;
  transfers: ReadonlyArray<unknown>;
  offset: number;
}): boolean {
  const rawCount = page.rawCount ?? page.transfers.length;
  return rawCount < WALLET_TRANSFER_PAGE_SIZE || page.offset < 0;
}
