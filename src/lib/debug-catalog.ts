import {
  EMPTY_DEBUG_NOSTR,
  debugNostrFieldsFromListRow,
  serializeDebugAccount,
  serializeDebugAddressVerification,
  serializeDebugPasskey,
  serializeDebugPasskeyChallenge,
  serializeDebugSession,
} from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import { serializeDebugApiLog, type ApiLogStore } from '@/lib/api-log';
import { serializeDebugContact } from '@/lib/contact';
import type { ContactStore } from '@/lib/contact-store';
import type { ConversationStore } from '@/lib/conversation-store';
import type { GiftStore } from '@/lib/gift-store';
import { MESSAGE_LIST_LIMIT, serializeDebugMessage } from '@/lib/message';
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import { serializeTrustEdge } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';

/** Postgres table names the operator dump may read. */
export const DEBUG_CATALOG_TABLES = [
  'account',
  'passkey_credential',
  'passkey_challenge',
  'auth_session',
  'address_verification',
  'api_log',
  'contact',
  'conversation',
  'conversation_message',
  'conversation_read',
  'message',
  'message_extra_photo',
  'message_invoice',
  'nostr_zap_ingest',
  'nostr_zap_receipt',
  'nostr_zap_payment',
  'nostr_zapper',
  'nostr_blocked_pubkey',
  'notification',
  'push_subscription',
  'push_outbox',
  'trust_edge',
  'gift',
  'btc_usd_daily',
  'usd_fiat_daily',
  'db_change',
] as const;

/** One allowlisted dump table name. */
export type DebugCatalogTable = (typeof DEBUG_CATALOG_TABLES)[number];

const TABLE_SET = new Set<string>(DEBUG_CATALOG_TABLES);

/**
 * Whether `name` is an allowlisted dump table.
 *
 * @param name - Path segment.
 * @returns True when the catalog will serve that table.
 */
export function isDebugCatalogTable(name: string): name is DebugCatalogTable {
  return TABLE_SET.has(name);
}

/** Stores the dump reads. Missing optional stores dump as `[]`. */
export interface DebugCatalogDeps {
  /** Auth rows, passkeys, sessions, challenges, verifications, Nostr envelopes. */
  auth: AuthStore;
  /** Forum notes, invoices, zaps, extra-photo meta. */
  messages: MessageStore;
  /** Contact mailbox. */
  contacts: ContactStore;
  /** HTTP audit log (`api_log`). */
  apiLog?: ApiLogStore;
  /** Private threads (operator listAll, not listVisible). */
  conversations?: ConversationStore;
  /** In-app notifications. */
  notifications?: NotificationStore;
  /** Web Push subscriptions and outbox. */
  push?: PushStore;
  /** Trust edges. */
  trust?: TrustStore;
  /** Outbound house gifts (full gift columns when listDebug is wired). */
  gifts?: GiftStore;
  /** Optional BTC-USD daily dump. */
  listBtcUsdDaily?: (limit: number) => Promise<unknown[]>;
  /** Optional USD-fiat daily dump. */
  listUsdFiatDaily?: (limit: number) => Promise<unknown[]>;
  /** Optional db_change dump. */
  listDbChange?: (limit: number) => Promise<unknown[]>;
}

function cap<T>(rows: T[]): T[] {
  return rows.length > MESSAGE_LIST_LIMIT ? rows.slice(0, MESSAGE_LIST_LIMIT) : rows;
}

function newestByCreatedAt<T extends { createdAt: number }>(
  rows: readonly T[],
  key: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || key(b).localeCompare(key(a)));
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function serializeInvoice(row: MessageInvoiceAttempt): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    messageId: row.messageId,
    payerAccountId: row.payerAccountId,
    authorAccountId: row.authorAccountId,
    amountSats: row.amountSats,
    lightningAddress: row.lightningAddress,
    zapRequest: row.zapRequest,
    result: row.result,
    httpStatus: row.httpStatus,
    pr: row.pr,
    paymentHash: row.paymentHash,
    description: row.description,
    descriptionHash: row.descriptionHash,
    isNip57Invoice: row.isNip57Invoice,
    lnurlResponse: row.lnurlResponse,
    conversationId: row.conversationId ?? null,
    conversationMessageId: row.conversationMessageId ?? null,
  };
}

function serializeIngest(row: ZapIngestRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    receiptId: row.receiptId,
    noteEventId: row.noteEventId,
    messageId: row.messageId,
    outcome: row.outcome,
    reason: row.reason,
    amountSats: row.amountSats,
    receiptPubkey: row.receiptPubkey,
    receipt: row.receipt,
  };
}

async function loadTable(deps: DebugCatalogDeps, table: DebugCatalogTable): Promise<unknown[]> {
  switch (table) {
    case 'account': {
      const accounts = await deps.auth.listAccounts();
      const nostrById = new Map(
        (await deps.auth.listNostrKeys()).map((row) => [
          row.accountId,
          debugNostrFieldsFromListRow(row),
        ]),
      );
      return newestByCreatedAt(accounts, (row) => row.id).map((account) =>
        serializeDebugAccount(account, nostrById.get(account.id) ?? EMPTY_DEBUG_NOSTR),
      );
    }
    case 'passkey_credential':
      return newestByCreatedAt(
        await deps.auth.listPasskeyCredentials(),
        (row) => row.credentialId,
      ).map(serializeDebugPasskey);
    case 'passkey_challenge':
      return newestByCreatedAt(await deps.auth.listPasskeyChallenges(), (row) => row.id).map(
        serializeDebugPasskeyChallenge,
      );
    case 'auth_session':
      return newestByCreatedAt(await deps.auth.listSessions(), (row) => row.token).map(
        serializeDebugSession,
      );
    case 'address_verification':
      return newestByCreatedAt(
        await deps.auth.listAddressVerifications(),
        (row) => `${row.accountId}\0${row.address}`,
      ).map(serializeDebugAddressVerification);
    case 'api_log':
      return ((await deps.apiLog?.listLatest(MESSAGE_LIST_LIMIT)) ?? []).map(serializeDebugApiLog);
    case 'contact':
      return (await deps.contacts.listLatest(MESSAGE_LIST_LIMIT)).map(serializeDebugContact);
    case 'conversation': {
      const rows = (await deps.conversations?.listAll(MESSAGE_LIST_LIMIT)) ?? [];
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        accountA: row.accountA,
        accountB: row.accountB,
        counterpartPubkey: row.counterpartPubkey,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt.toISOString(),
      }));
    }
    case 'conversation_message': {
      const rows = (await deps.conversations?.listAllMessages(MESSAGE_LIST_LIMIT)) ?? [];
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        text: row.text,
        createdAt: row.createdAt.toISOString(),
        senderAccountId: row.senderAccountId,
        senderPubkey: row.senderPubkey,
        name: row.name,
        actorAccountId: row.actorAccountId ?? null,
        actorName: row.actorName ?? '',
        giftForMessageId: row.giftForMessageId ?? null,
        eventId: row.eventId,
        nostrPublishState: row.nostrPublishState,
        nostrEvent: row.nostrEvent,
        claimedUntil: row.claimedUntil,
        sats: row.sats,
      }));
    }
    case 'conversation_read': {
      const rows = (await deps.conversations?.listAllReads(MESSAGE_LIST_LIMIT)) ?? [];
      return rows.map((row) => ({
        accountId: row.accountId,
        conversationId: row.conversationId,
        lastReadAt: row.lastReadAt.toISOString(),
      }));
    }
    case 'message': {
      const rows = await deps.messages.listDebug(MESSAGE_LIST_LIMIT);
      const out: unknown[] = [];
      for (const row of rows) {
        const photo0 = await deps.messages.getPhoto(row.id);
        const extras = await deps.messages.listExtraPhotos(row.id);
        out.push(
          serializeDebugMessage(row, {
            photoContentType: photo0?.contentType ?? null,
            photoBytes: photo0?.bytes.byteLength ?? 0,
            extraPhotos: extras.map((photo, index) => ({
              idx: index + 1,
              photoContentType: photo.contentType,
              bytes: photo.bytes.byteLength,
            })),
          }),
        );
      }
      return out;
    }
    case 'message_extra_photo':
      return (await deps.messages.listExtraPhotoMeta?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'message_invoice':
      return (await deps.messages.listInvoiceAttempts(MESSAGE_LIST_LIMIT)).map(serializeInvoice);
    case 'nostr_zap_ingest':
      return (await deps.messages.listZapIngests(MESSAGE_LIST_LIMIT)).map(serializeIngest);
    case 'nostr_zap_receipt':
      return (await deps.messages.listZapReceipts?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'nostr_zap_payment':
      return (await deps.messages.listZapPayments?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'nostr_zapper':
      return (await deps.messages.listZappers(MESSAGE_LIST_LIMIT)).map((row) => ({
        pubkey: row.pubkey,
        receiptEventId: row.receiptEventId,
        createdAt: row.createdAt.toISOString(),
      }));
    case 'nostr_blocked_pubkey':
      return (await deps.messages.listBlockedPubkeyRows(MESSAGE_LIST_LIMIT)).map((row) => ({
        pubkey: row.pubkey,
        blockedAt: row.blockedAt.toISOString(),
        blockedBy: row.blockedBy,
        messageId: row.messageId,
      }));
    case 'notification': {
      const rows = (await deps.notifications?.listAll(MESSAGE_LIST_LIMIT)) ?? [];
      return rows.map((row) => ({
        id: row.id,
        recipientAccountId: row.recipientAccountId,
        actorAccountId: row.actorAccountId,
        type: row.type,
        parentId: row.parentId,
        replyId: row.replyId,
        name: row.name,
        text: row.text,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt === null ? null : row.readAt.toISOString(),
      }));
    }
    case 'push_subscription': {
      const rows = (await deps.push?.listAllSubscriptions()) ?? [];
      return cap(rows).map((row) => ({
        endpoint: row.endpoint,
        accountId: row.accountId,
        p256dh: row.p256dh,
        auth: row.auth,
        createdAt: row.createdAt.toISOString(),
      }));
    }
    case 'push_outbox': {
      const rows = (await deps.push?.listAllOutbox(MESSAGE_LIST_LIMIT)) ?? [];
      return rows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        type: row.type,
        messageId: row.messageId,
        payload: row.payload,
        status: row.status,
        attempts: row.attempts,
        claimedUntil: iso(row.claimedUntil),
        createdAt: row.createdAt.toISOString(),
        deliveredEndpoints: row.deliveredEndpoints,
      }));
    }
    case 'trust_edge': {
      const edges = [...((await deps.trust?.listEdges()) ?? [])].sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
      return cap(edges).map(serializeTrustEdge);
    }
    case 'gift':
      return (await deps.gifts?.listDebug?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'btc_usd_daily':
      return (await deps.listBtcUsdDaily?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'usd_fiat_daily':
      return (await deps.listUsdFiatDaily?.(MESSAGE_LIST_LIMIT)) ?? [];
    case 'db_change':
      return (await deps.listDbChange?.(MESSAGE_LIST_LIMIT)) ?? [];
  }
}

/**
 * Load one table or every allowlisted table (each capped at {@link MESSAGE_LIST_LIMIT}).
 *
 * @param deps - Persistence ports.
 * @param only - When set, only that table is populated.
 * @returns Map of table name → rows.
 */
export async function loadDebugTables(
  deps: DebugCatalogDeps,
  only?: DebugCatalogTable,
): Promise<Record<DebugCatalogTable, unknown[]>> {
  const names = only === undefined ? DEBUG_CATALOG_TABLES : ([only] as const);
  const tables = {} as Record<DebugCatalogTable, unknown[]>;
  for (const name of DEBUG_CATALOG_TABLES) {
    tables[name] = [];
  }
  for (const name of names) {
    tables[name] = cap(await loadTable(deps, name));
  }
  return tables;
}
