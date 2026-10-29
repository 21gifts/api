import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { WELCOME_GIFT_DESCRIPTION } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { receivingAddress } from '@/lib/receiving-address';
import type { SpendPing } from '@/lib/spend-ping';

/**
 * The operator switch of the 15-minute welcome sweep. A process starts with it
 * off; `PUT /debug/welcome-sweep` sets it.
 */
export interface WelcomeSweepSwitch {
  /** `true` once an operator turned the sweep on. */
  enabled: boolean;
}

/** One account the welcome sweep would ping now. */
export interface WelcomeSweepCandidate {
  /** Account id. */
  accountId: string;
  /** The account's username. */
  username: string;
  /** Its wallet address, the one the ping names. */
  address: string;
  /** Newest live top-level photo or video, including the About-me note. */
  messageId: string;
}

/** One recorded welcome gift: lower-case recipient handle and payment time. */
interface WelcomeRecord {
  handle: string;
  paidAtMs: number;
}

/** Everything that marks a paid welcome gift, read once per check or sweep. */
interface WelcomeLedger {
  platformId: string | null;
  records: readonly WelcomeRecord[];
  legacyAccountIds: ReadonlySet<string>;
}

/** Gift store reads behind the welcome check. */
type WelcomeGifts = Pick<GiftStore, 'listOutbound' | 'listLegacyWelcomeAccountIds'>;

/**
 * Read the welcome ledger: the platform account, every welcome gift paid to a
 * wallet address ({@link WELCOME_GIFT_DESCRIPTION}, recorded under the
 * member's username), and the accounts whose legacy external address received
 * a welcome gift.
 *
 * @param accounts - Every stored account.
 * @param gifts - Outbound gift store, or `undefined` (no gift records read).
 * @returns The ledger.
 */
async function loadWelcomeLedger(
  accounts: readonly Account[],
  gifts: WelcomeGifts | undefined,
): Promise<WelcomeLedger> {
  const records =
    gifts === undefined
      ? []
      : (await gifts.listOutbound())
          .filter((row) => row.kind === 'welcome' && row.description === WELCOME_GIFT_DESCRIPTION)
          .map((row) => ({
            handle: row.recipientWosUser.trim().toLowerCase(),
            paidAtMs: row.paidAt.getTime(),
          }));
  const legacy = (await gifts?.listLegacyWelcomeAccountIds?.()) ?? [];
  return {
    platformId: accounts.find((account) => account.isPlatform === true)?.id ?? null,
    records,
    legacyAccountIds: new Set(legacy),
  };
}

/**
 * Whether the account already received the one-time welcome gift, whichever
 * address it went to: a platform `Welcome` reply under one of its notes, a
 * welcome gift paid to its legacy external address, or a welcome gift
 * recorded under its username at or after its wallet was verified. Before that
 * the username may have belonged to another account.
 *
 * @param ledger - The welcome ledger.
 * @param messages - Forum store.
 * @param account - Account to check.
 * @returns `true` when the welcome gift was already paid.
 */
async function welcomedBefore(
  ledger: WelcomeLedger,
  messages: Pick<MessageStore, 'accountHasWelcomeGift'>,
  account: Pick<Account, 'id' | 'username' | 'sparkPubkeyVerifiedAt'>,
): Promise<boolean> {
  if (ledger.legacyAccountIds.has(account.id)) {
    return true;
  }
  const username = account.username?.trim().toLowerCase() ?? '';
  const verifiedAtMs = account.sparkPubkeyVerifiedAt;
  if (
    username !== '' &&
    typeof verifiedAtMs === 'number' &&
    ledger.records.some((record) => record.handle === username && record.paidAtMs >= verifiedAtMs)
  ) {
    return true;
  }
  return (
    ledger.platformId !== null &&
    (await messages.accountHasWelcomeGift(account.id, ledger.platformId))
  );
}

/**
 * Whether the account already received the one-time welcome gift: a platform
 * `Welcome` reply under one of its notes, a `welcome` gift paid to its legacy
 * external address, or a welcome gift with description `21gifts welcome`
 * recorded under its username at or after its wallet was verified.
 *
 * @param args - Auth store (platform lookup), forum store, optional gift
 *   store, and the account.
 * @returns `true` when the welcome gift was already paid.
 */
export async function accountWelcomed(args: {
  auth: Pick<AuthStore, 'listAccounts'>;
  messages: Pick<MessageStore, 'accountHasWelcomeGift'>;
  gifts?: WelcomeGifts | undefined;
  account: Pick<Account, 'id' | 'username' | 'sparkPubkeyVerifiedAt'>;
}): Promise<boolean> {
  const ledger = await loadWelcomeLedger(await args.auth.listAccounts(), args.gifts);
  return welcomedBefore(ledger, args.messages, args.account);
}

/**
 * The welcome ping `account` is owed: a `verified` account with a receiving
 * address and a live top-level photo or video that has not received the
 * welcome gift.
 *
 * @param ledger - The welcome ledger.
 * @param messages - Forum store.
 * @param account - Account to check.
 * @param lnurlServer - LNURL server config.
 * @returns The candidate, `'welcomed'` when the gift was already paid, or
 *   `null` when nothing is owed for another reason.
 */
async function welcomeOwed(
  ledger: WelcomeLedger,
  messages: MessageStore,
  account: Account,
  lnurlServer: LnurlServerConfig | undefined,
): Promise<WelcomeSweepCandidate | 'welcomed' | null> {
  const address = receivingAddress(account, lnurlServer)?.address ?? null;
  if (account.role !== 'verified' || address === null) {
    return null;
  }
  const messageId = await messages.latestLiveTopLevelMediaId(account.id);
  if (messageId === null) {
    return null;
  }
  if (await welcomedBefore(ledger, messages, account)) {
    return 'welcomed';
  }
  return {
    accountId: account.id,
    username: address.slice(0, address.lastIndexOf('@')),
    address,
    messageId,
  };
}

/**
 * Every account the welcome sweep would ping now: `verified`, with a receiving
 * address (a verified wallet and the LNURL server on) and a live top-level
 * photo or video, and not welcomed before (see {@link accountWelcomed}). Reads
 * only; pings nobody. Read failures reject.
 *
 * @param args - Auth store, forum store, optional gift store, and LNURL server
 *   config.
 * @returns The candidates, in account order.
 */
export async function welcomeSweepCandidates(args: {
  auth: Pick<AuthStore, 'listAccounts'>;
  messages: MessageStore;
  gifts?: WelcomeGifts | undefined;
  lnurlServer?: LnurlServerConfig | undefined;
}): Promise<WelcomeSweepCandidate[]> {
  const accounts = await args.auth.listAccounts();
  const ledger = await loadWelcomeLedger(accounts, args.gifts);
  const candidates: WelcomeSweepCandidate[] = [];
  for (const account of accounts) {
    const owed = await welcomeOwed(ledger, args.messages, account, args.lnurlServer);
    if (owed !== null && owed !== 'welcomed') {
      candidates.push(owed);
    }
  }
  return candidates;
}

/**
 * Tell spend a verified account is owed the one-time welcome gift.
 *
 * Pass `account` after a new top-level post, an About-me save, or a
 * verification. Omit `account` for the sweep, which pings every
 * {@link welcomeSweepCandidates} entry, and only while `sweep.enabled` is
 * true; an omitted or off switch pings nobody. Omitted spend ping, a role
 * other than `verified`, no receiving address (no verified wallet, or the
 * LNURL server off), no photo/video, or a welcome gift already paid to the
 * account ({@link accountWelcomed}) is a no-op. The gift is once per account,
 * not once per address. Failures are logged; does not throw.
 *
 * @param args - Spend ping, forum store, auth store, optional gift store,
 *   optional LNURL server config, optionally one account, and the sweep switch.
 */
export async function syncWelcomePing(args: {
  spendPing?: SpendPing;
  messages: MessageStore;
  auth: Pick<AuthStore, 'listAccounts'>;
  gifts?: WelcomeGifts | undefined;
  account?: Account;
  lnurlServer?: LnurlServerConfig;
  sweep?: WelcomeSweepSwitch;
}): Promise<void> {
  if (args.spendPing === undefined) {
    return;
  }
  if (args.account === undefined && args.sweep?.enabled !== true) {
    logEvent('spend.ping.skipped', { reason: 'sweep_off' });
    return;
  }
  let owed: WelcomeSweepCandidate[];
  try {
    if (args.account === undefined) {
      owed = await welcomeSweepCandidates(args);
    } else {
      const ledger = await loadWelcomeLedger(await args.auth.listAccounts(), args.gifts);
      const one = await welcomeOwed(ledger, args.messages, args.account, args.lnurlServer);
      if (one === 'welcomed') {
        logEvent('spend.ping.skipped', { reason: 'welcomed' });
      }
      owed = one === null || one === 'welcomed' ? [] : [one];
    }
  } catch {
    logEvent('spend.ping.failed');
    return;
  }
  for (const candidate of owed) {
    try {
      await args.spendPing.ping(candidate.address, candidate.messageId, 'welcome');
    } catch {
      logEvent('spend.ping.failed');
    }
  }
}
