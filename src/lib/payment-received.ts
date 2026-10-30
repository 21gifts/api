/**
 * Web Push for a payment a member received on their lightning address.
 *
 * The self-hosted LNURL server sends one `spark_payment_received` webhook per
 * settled invoice, signed with HMAC-SHA256 of the raw body in
 * `X-Breez-Signature`. Every field used here comes from that signed body; a
 * sender is named only from a signed NIP-57 zap request that names the
 * receiver. One push per payment hash (`PushStore.enqueuePaymentReceived`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import type { AuthStore } from '@/lib/auth/store';
import type { MessageStore } from '@/lib/message-store';
import { parseNotificationLevel, wantsNotification } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import { normalizeHex32 } from '@/lib/proof';
import { buildPaymentReceivedPushPayload } from '@/lib/push';
import type { PushStore } from '@/lib/push-store';

/** One settled payment from a signed LNURL server webhook. */
export interface PaymentReceived {
  /** BOLT11 payment hash, lowercase hex. */
  paymentHash: string;
  /** Receiver's Spark identity pubkey, as the LNURL server stores it. */
  userPubkey: string;
  /** Received amount in whole sats. */
  amountSats: number;
  /** Raw kind:9734 zap request bound to the invoice, or `null`. */
  zapRequest: string | null;
}

/** Collaborators for {@link notifyPaymentReceived}. */
export interface PaymentReceivedDeps {
  /** Accounts, verified wallets, and custodial Nostr keys. */
  auth: Pick<
    AuthStore,
    'getAccountByVerifiedSparkPubkey' | 'getAccountByPubkey' | 'getNostrPublicKey'
  >;
  /** Forum notes, to leave zaps on a note to the zap notification. */
  messages: Pick<MessageStore, 'getByEventId'>;
  /** Subscriptions and outbox. */
  pushStore: PushStore;
  /** In-app unread for the badge. */
  notifications: Pick<NotificationStore, 'unreadCount'>;
  /** Listed inbox unread for the badge. */
  inboxUnreadCount: (accountId: string) => Promise<number>;
  /** Clock in epoch milliseconds. */
  now: () => number;
}

/** What {@link notifyPaymentReceived} did with one payment. */
export type PaymentReceivedOutcome =
  'queued' | 'duplicate' | 'unknown' | 'self' | 'zap' | 'off' | 'no_device';

/**
 * Read the webhook secret shared with the LNURL server.
 *
 * @param env - Process environment slice.
 * @returns The trimmed `LNURL_WEBHOOK_SECRET`, or `null` when unset or blank.
 */
export function resolvePaymentWebhookSecret(
  env: Record<string, string | undefined>,
): string | null {
  const secret = env['LNURL_WEBHOOK_SECRET']?.trim() ?? '';
  return secret === '' ? null : secret;
}

/**
 * Check `X-Breez-Signature`: lowercase or uppercase hex of
 * HMAC-SHA256(secret, raw body), compared in constant time.
 *
 * @param secret - Shared webhook secret.
 * @param body - Raw request body.
 * @param signature - Header value, or `null` when absent.
 * @returns `true` only for a 64-hex signature that matches.
 */
export function breezSignatureValid(
  secret: string,
  body: string,
  signature: string | null,
): boolean {
  if (signature === null || !/^[0-9a-fA-F]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/**
 * Parse a `spark_payment_received` webhook body.
 *
 * @param body - Raw JSON body.
 * @returns The payment, or `null` for another template, malformed JSON, a
 *   payment hash that is not 32-byte hex, a blank pubkey, or an amount that is
 *   not a positive safe integer.
 */
export function parsePaymentReceived(body: string): PaymentReceived | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const envelope = parsed as { template?: unknown; data?: unknown };
  if (envelope.template !== 'spark_payment_received') {
    return null;
  }
  if (envelope.data === null || typeof envelope.data !== 'object') {
    return null;
  }
  const data = envelope.data as Record<string, unknown>;
  const rawHash = data['payment_hash'];
  const paymentHash = typeof rawHash === 'string' ? normalizeHex32(rawHash) : null;
  const userPubkey = data['user_pubkey'];
  const amountSats = data['amount_sat'];
  const zapRequest = data['nostr_zap_request'];
  if (
    paymentHash === null ||
    typeof userPubkey !== 'string' ||
    userPubkey === '' ||
    typeof amountSats !== 'number' ||
    !Number.isSafeInteger(amountSats) ||
    amountSats <= 0
  ) {
    return null;
  }
  return {
    paymentHash,
    userPubkey,
    amountSats,
    zapRequest: typeof zapRequest === 'string' ? zapRequest : null,
  };
}

/** Signer and note targets of a zap request that is signed and names the receiver. */
function verifiedZapRequest(
  raw: string,
  receiverPubkey: string,
  amountSats: number,
): { pubkey: string; noteEventIds: string[] } | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (event === null || typeof event !== 'object') {
    return null;
  }
  const shape = event as { kind?: unknown; tags?: unknown; pubkey?: unknown };
  if (shape.kind !== 9734 || !Array.isArray(shape.tags) || typeof shape.pubkey !== 'string') {
    return null;
  }
  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    return null;
  }
  const tags = (shape.tags as unknown[]).filter(
    (tag): tag is string[] => Array.isArray(tag) && typeof tag[1] === 'string',
  );
  if (!tags.some((tag) => tag[0] === 'p' && tag[1]?.toLowerCase() === receiverPubkey)) {
    return null;
  }
  const amount = tags.find((tag) => tag[0] === 'amount')?.[1];
  if (amount !== undefined && amount !== String(amountSats * 1000)) {
    return null;
  }
  return {
    pubkey: shape.pubkey.toLowerCase(),
    noteEventIds: tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1] as string),
  };
}

/**
 * Enqueue one "You received N sats" Web Push to the receiver of a payment.
 *
 * The receiver is the account whose verified wallet is `userPubkey`. A zap
 * request counts only when it is signed, names the receiver's Nostr pubkey in
 * a `p` tag, and any `amount` tag equals the received amount. Nothing is
 * enqueued when the zap request comes from the receiver, when it targets a
 * forum note this api stores (that zap is notified by `notifyZap` or
 * `notifyHeart`), when the receiver's notification level is `none`, or when
 * the receiver has no push subscription. The push names a sender only when
 * the zap request's signer is a 21.gifts account with a name.
 *
 * @param deps - Stores and clock.
 * @param payment - Parsed signed webhook payment.
 * @returns What was done; `duplicate` when this payment hash was already pushed.
 * @throws If a store read or the enqueue rejects.
 */
export async function notifyPaymentReceived(
  deps: PaymentReceivedDeps,
  payment: PaymentReceived,
): Promise<PaymentReceivedOutcome> {
  const account = await deps.auth.getAccountByVerifiedSparkPubkey(payment.userPubkey);
  if (account === undefined) {
    return 'unknown';
  }
  let senderName: string | null = null;
  const receiverPubkey = (await deps.auth.getNostrPublicKey(account.id))?.toLowerCase();
  const zap =
    payment.zapRequest === null || receiverPubkey === undefined
      ? null
      : verifiedZapRequest(payment.zapRequest, receiverPubkey, payment.amountSats);
  if (zap !== null) {
    const sender = await deps.auth.getAccountByPubkey(zap.pubkey);
    if (sender?.id === account.id) {
      return 'self';
    }
    for (const eventId of zap.noteEventIds) {
      if ((await deps.messages.getByEventId(eventId)) !== undefined) {
        return 'zap';
      }
    }
    const name = sender?.name?.trim() ?? '';
    senderName = name === '' ? null : name;
  }
  if (
    !wantsNotification({
      level: parseNotificationLevel(account.notificationLevel),
      isActive: true,
      mentionedAccountId: account.id,
      recipientAccountId: account.id,
    })
  ) {
    return 'off';
  }
  if ((await deps.pushStore.listByAccount(account.id)).length === 0) {
    return 'no_device';
  }
  const unreadCount =
    (await deps.notifications.unreadCount(account.id)) + (await deps.inboxUnreadCount(account.id));
  const payload = buildPaymentReceivedPushPayload({
    paymentHash: payment.paymentHash,
    amountSats: payment.amountSats,
    name: senderName,
  });
  const queued = await deps.pushStore.enqueuePaymentReceived(payment.paymentHash, {
    id: crypto.randomUUID(),
    accountId: account.id,
    type: 'zap',
    messageId: null,
    payload: JSON.stringify({ ...payload, unreadCount }),
    status: 'pending',
    attempts: 0,
    claimedUntil: null,
    finishedAt: null,
    createdAt: new Date(deps.now()),
    deliveredEndpoints: [],
    skipEndpoints: [],
  });
  return queued ? 'queued' : 'duplicate';
}
