/** Serialized background synchronization of every current and previous Spark wallet. */

import type { AuthStore } from '@/lib/auth/store';
import { effectiveStatus, utcDayKey } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import { pingTodayMedia, type TodayMediaPingDeps } from '@/lib/funding-ping';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { logEvent } from '@/lib/log';
import { bytesToHex } from '@/lib/nostr/kek';
import type { SparkViewer, SparkViewerTransfer } from '@/lib/spark-viewer';
import type { WalletStore } from '@/lib/wallet-store';
import type {
  WalletTransferRecord,
  WalletTransferStatus,
  WalletTransferStore,
  WalletTransferType,
  WalletTransferWallet,
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

function normalizedTransfer(
  wallet: WalletTransferWallet,
  transfer: SparkViewerTransfer,
  seenAt: Date,
): WalletTransferRecord | null {
  const sender = bytesToHex(transfer.senderIdentityPublicKey);
  const receiver = bytesToHex(transfer.receiverIdentityPublicKey);
  const direction =
    sender === wallet.sparkPubkey ? 'out' : receiver === wallet.sparkPubkey ? 'in' : null;
  const counterpartyPubkey = direction === 'out' ? receiver : sender;
  if (
    direction === null ||
    !/^0[23][0-9a-f]{64}$/.test(counterpartyPubkey) ||
    transfer.id === '' ||
    !Number.isSafeInteger(transfer.totalValue) ||
    transfer.totalValue < 0
  ) {
    return null;
  }
  return {
    accountId: wallet.accountId,
    walletPubkey: wallet.sparkPubkey,
    transferId: transfer.id,
    direction,
    type: transferType(transfer.type),
    status: transferStatus(transfer.status),
    amountSats: transfer.totalValue,
    counterpartyPubkey,
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
    state.oldestPendingCreatedAt?.getTime() ?? null,
  ].filter((value): value is number => value !== null);
  return candidates.length === 0 ? undefined : new Date(Math.min(...candidates));
}

async function syncWallet(
  deps: WalletTransferWorkerDeps,
  wallet: WalletTransferWallet,
): Promise<{ inserted: number; updated: number }> {
  const state = await deps.transfers.syncState(wallet.accountId, wallet.sparkPubkey);
  const createdAfter = createdAfterOf(state);
  let offset = 0;
  let inserted = 0;
  let updated = 0;
  let catchUp = false;
  const today = utcDayKey(deps.now());
  let hadShopPaymentToday = await deps.transfers.hasShopPayment(wallet.accountId, today, today);
  do {
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
      const paidAt = row.transferUpdatedAt ?? row.transferCreatedAt;
      if (
        outcome.shopPaymentBecameCompleted &&
        !hadShopPaymentToday &&
        paidAt !== null &&
        utcDayKey(paidAt.getTime()) === today
      ) {
        catchUp = true;
        hadShopPaymentToday = true;
      }
    }
    offset = page.offset;
  } while (offset !== -1);

  if (catchUp) {
    const account = await deps.auth.getAccount(wallet.accountId);
    if (account !== undefined) {
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
        await pingTodayMedia(deps.ping, account, nowMs, effectiveStatus(payout.grant, nowMs), true);
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
