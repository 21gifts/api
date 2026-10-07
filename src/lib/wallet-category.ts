/** Server-side classification of reported wallet payments. */

import type { AuthStore, Account } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import type { LnurlServerConfig } from '@/lib/config';
import { textHasHashtagToken, type MessageStore } from '@/lib/message-store';
import type { PosStore } from '@/lib/pos-store';
import { accountByReceivingAddress } from '@/lib/receiving-address';
import { decodeSparkAddress } from '@/lib/spark-address';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';
import type { ReportedWalletPayment } from '@/lib/wallet-report';

/** Categories assigned to wallet payments, in public display order. */
export type WalletPaymentCategory =
  'member' | 'shop' | 'platform' | 'gift' | 'outside_lightning' | 'onchain' | 'unknown';

/** Every wallet payment category in its stable public order. */
export const WALLET_PAYMENT_CATEGORIES: readonly WalletPaymentCategory[] = [
  'member',
  'shop',
  'platform',
  'gift',
  'outside_lightning',
  'onchain',
  'unknown',
];

/** Collaborators used to resolve a reported payment against server knowledge. */
export interface WalletCategoryDeps {
  /** Account lookups by id, username, and verified Spark key. */
  authStore: Pick<
    AuthStore,
    'getAccount' | 'getAccountByUsername' | 'getAccountByVerifiedSparkPubkey'
  >;
  /** Forum invoice, zap receipt, message, and shop-note lookups. */
  messages: Pick<
    MessageStore,
    | 'findOkInvoiceByPaymentHash'
    | 'zapPaymentReceiptId'
    | 'getZapReceiptGift'
    | 'getById'
    | 'listLiveAssignedShops'
  >;
  /** Point-of-sale payment lookup. */
  posStore: Pick<PosStore, 'findChargeForPayment'>;
  /** Self-hosted receiving-address configuration, when enabled. */
  lnurlServer?: LnurlServerConfig;
}

/** Category and optional known account on the other side of a payment. */
export interface WalletPaymentClass {
  /** Server-derived payment category. */
  category: WalletPaymentCategory;
  /** Known counterparty account id, excluding the reporting account itself. */
  counterpartyAccountId: string | null;
}

/**
 * Build one request-scoped asynchronous wallet payment classifier.
 *
 * The live shop account set is loaded only if member classification needs it,
 * and at most once for this classifier.
 *
 * @param deps - Account, message, POS, and optional LNURL dependencies.
 * @param ownAccountId - Account that submitted the report.
 * @returns A classifier whose lookup failures propagate to the caller.
 */
export function walletPaymentClassifier(
  deps: WalletCategoryDeps,
  ownAccountId: string,
): (payment: ReportedWalletPayment) => Promise<WalletPaymentClass> {
  let shopAccounts: Promise<Set<string>> | undefined;

  const shops = (): Promise<Set<string>> => {
    shopAccounts ??= deps.messages.listLiveAssignedShops().then((notes) => {
      const ids = new Set<string>();
      for (const note of notes) {
        if (note.accountId !== '' && textHasHashtagToken(note.text, '21GiftsShop')) {
          ids.add(note.accountId);
        }
      }
      return ids;
    });
    return shopAccounts;
  };

  const toKnown = async (
    id: string | null | undefined,
    fallback: WalletPaymentCategory,
  ): Promise<WalletPaymentClass> => {
    if (id === null || id === undefined || id === ownAccountId) {
      return { category: fallback, counterpartyAccountId: null };
    }
    const account = await deps.authStore.getAccount(id);
    return {
      category: account?.isPlatform === true ? 'platform' : fallback,
      counterpartyAccountId: id,
    };
  };

  const toMember = async (account: Account): Promise<WalletPaymentClass | null> => {
    if (account.id === ownAccountId) {
      return null;
    }
    if (account.isPlatform === true) {
      return { category: 'platform', counterpartyAccountId: account.id };
    }
    return {
      category: (await shops()).has(account.id) ? 'shop' : 'member',
      counterpartyAccountId: account.id,
    };
  };

  return async (payment): Promise<WalletPaymentClass> => {
    let hash = payment.paymentHash;
    if (hash === null && payment.invoice !== null) {
      hash = decodeBolt11(payment.invoice)?.paymentHash ?? null;
    }
    const sparkSource = payment.invoice ?? payment.destination;
    const spark = sparkSource === null ? null : decodeSparkAddress(sparkSource);
    const zapMemoHash = spark?.memo?.match(/^zap:([0-9a-fA-F]{64})$/)?.[1]?.toLowerCase();
    // A zap memo names the zap invoice the Spark invoice stands in for; try it after the reported hash.
    const knownHashes = [hash, zapMemoHash].filter(
      (candidate, index, all): candidate is string =>
        typeof candidate === 'string' && all.indexOf(candidate) === index,
    );

    for (const candidate of knownHashes) {
      const invoice = await deps.messages.findOkInvoiceByPaymentHash(candidate);
      if (invoice !== undefined) {
        return toKnown(
          payment.direction === 'out' ? invoice.authorAccountId : invoice.payerAccountId,
          'gift',
        );
      }

      const receiptId = await deps.messages.zapPaymentReceiptId(candidate);
      if (receiptId !== undefined) {
        const gift = await deps.messages.getZapReceiptGift(receiptId);
        if (gift !== undefined) {
          if (payment.direction === 'in') {
            return toKnown(gift.payerAccountId, 'gift');
          }
          const message = await deps.messages.getById(gift.messageId);
          return toKnown(message?.accountId, 'gift');
        }
      }
    }

    let charge =
      hash === null ? undefined : await deps.posStore.findChargeForPayment({ paymentHash: hash });
    if (charge === undefined && spark?.memo?.startsWith('pos:') === true) {
      charge = await deps.posStore.findChargeForPayment({ chargeId: spark.memo.slice(4) });
    }
    if (charge !== undefined) {
      return {
        category: 'shop',
        counterpartyAccountId: charge.accountId === ownAccountId ? null : charge.accountId,
      };
    }

    const destination = payment.destination;
    if (destination !== null && destination.includes('@') && deps.lnurlServer !== undefined) {
      const at = destination.lastIndexOf('@');
      const host = destination.slice(at + 1).toLowerCase();
      if (host === deps.lnurlServer.host.toLowerCase()) {
        const resolved = await accountByReceivingAddress(
          deps.authStore,
          destination,
          deps.lnurlServer,
        );
        if (resolved !== undefined) {
          const classified = await toMember(resolved.account);
          if (classified !== null) {
            return classified;
          }
        }
      }
    }

    if (spark !== null) {
      const account = await deps.authStore.getAccountByVerifiedSparkPubkey(spark.identityPublicKey);
      if (account !== undefined) {
        const classified = await toMember(account);
        if (classified !== null) {
          return classified;
        }
      }
    }

    if (destination !== null) {
      const pubkey = normalizeSparkPubkey(destination);
      if (pubkey !== null) {
        const account = await deps.authStore.getAccountByVerifiedSparkPubkey(pubkey);
        if (account !== undefined) {
          const classified = await toMember(account);
          if (classified !== null) {
            return classified;
          }
        }
      }
    }

    if (payment.method === 'onchain' || payment.method === 'bitcoin') {
      return { category: 'onchain', counterpartyAccountId: null };
    }
    const foreignAddress =
      destination !== null &&
      destination.includes('@') &&
      (deps.lnurlServer === undefined ||
        destination.slice(destination.lastIndexOf('@') + 1).toLowerCase() !==
          deps.lnurlServer.host.toLowerCase());
    if (
      payment.method === 'lightning' ||
      payment.method === 'bolt11' ||
      payment.method === 'lnurl' ||
      foreignAddress ||
      payment.invoice?.toLowerCase().startsWith('ln') === true
    ) {
      return { category: 'outside_lightning', counterpartyAccountId: null };
    }
    return { category: 'unknown', counterpartyAccountId: null };
  };
}
