import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MergeDb } from '@/lib/account-merge';
import { openBootStores } from '@/lib/boot-stores';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { InMemoryBtcUsdStore, PostgresBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryFiatStore, PostgresFiatStore } from '@/lib/usd-fiat-store';
import { InMemoryFxSpotStore, PostgresFxSpotStore } from '@/lib/fx-spot-store';
import { QueryGiftStore } from '@/lib/gift-store';
import { SqlGiftRecorder } from '@/lib/gift-recorder';
import { PostgresContactStore } from '@/lib/contact-store';
import { PostgresMemberHabitStore } from '@/lib/member-habit-store';
import { InMemoryPosStore, PostgresPosStore } from '@/lib/pos-store';

import { PostgresConversationStore } from '@/lib/conversation-store';
import { PostgresMessageStore } from '@/lib/message-store';
import { PostgresTranslationStore } from '@/lib/translation-store';
import { PostgresNotificationStore } from '@/lib/notification-store';
import { RecordingQuerier } from '@/lib/nostr/query';
import { PostgresPushStore } from '@/lib/push-store';
import { PostgresTrustStore } from '@/lib/trust-store';
import { PostgresApiLogStore } from '@/lib/api-log';
import { PostgresDiagnosticStore } from '@/lib/diagnostic-log';
import { logEvent, setDiagnosticSink } from '@/lib/log';
import { PostgresFundingStore } from '@/lib/funding-store';
import {
  DAILY_ROSTER_ACCOUNT_LINK_SQL,
  InMemoryDailyRosterStore,
  PostgresDailyRosterStore,
} from '@/lib/daily-roster-store';
import { PostgresDebugDbStore } from '@/lib/debug-db';
import { PostgresBannerStore } from '@/lib/banner-store';
import { PostgresSparkInvoiceStore } from '@/lib/spark-invoice-store';
import { PostgresWalletStore } from '@/lib/wallet-store';
import { PostgresMemberEventStore } from '@/lib/member-event-store';
import { PostgresShopIdentityStore } from '@/lib/shop-identity';

function unusedClient(): SqlClient {
  return {
    query: async () => {
      throw new Error('unused');
    },
    execute: async () => {
      throw new Error('unused');
    },
  };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('openBootStores', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env['NOSTR_NSEC_KEK'] = 'ab'.repeat(32);
    process.env['RECOVERY_SHARE_KEK'] = 'cd'.repeat(32);
  });

  afterEach(() => {
    warn.mockRestore();
    setDiagnosticSink(null);
    delete process.env['NOSTR_NSEC_KEK'];
    delete process.env['RECOVERY_SHARE_KEK'];
  });

  it('returns in-memory auth, no gift store, and InMemoryBtcUsdStore when unset', async () => {
    const factory = vi.fn(() => unusedClient());
    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      fxSpotStore,
      messageStore,
      translationStore,
      conversationTranslationStore,
      contactStore,
      memberHabitStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      rosterStore,
      bannerStore,
      listDbChange,
      debugDbStore,
      sparkInvoiceStore,
      walletStore,
      memberEventStore,
      nostrKek,
      recoveryShareKek,
    } = await openBootStores(undefined, factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(nostrKek).toBeUndefined();
    expect(recoveryShareKek).toBeUndefined();
    expect(giftStore).toBeUndefined();
    expect(giftRecorder).toBeUndefined();
    expect(messageStore).toBeUndefined();
    expect(translationStore).toBeUndefined();
    expect(conversationTranslationStore).toBeUndefined();
    expect(contactStore).toBeUndefined();
    expect(memberHabitStore).toBeUndefined();
    expect(posStore).toBeInstanceOf(InMemoryPosStore);
    expect(conversationStore).toBeUndefined();
    expect(notificationStore).toBeUndefined();
    expect(pushStore).toBeUndefined();
    expect(trustStore).toBeUndefined();
    expect(apiLogStore).toBeUndefined();
    expect(fundingStore).toBeUndefined();
    expect(rosterStore).toBeInstanceOf(InMemoryDailyRosterStore);
    expect(bannerStore).toBeUndefined();
    expect(listDbChange).toBeUndefined();
    expect(debugDbStore).toBeUndefined();
    expect(sparkInvoiceStore).toBeUndefined();
    expect(walletStore).toBeUndefined();
    expect(memberEventStore).toBeUndefined();
    expect(btcUsdRates).toBeInstanceOf(InMemoryBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(InMemoryFiatStore);
    expect(fxSpotStore).toBeInstanceOf(InMemoryFxSpotStore);
    expect(factory).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['event'] === 'nostr.zap.backfill.done')).toBe(false);
    expect(parsedEvents(warn).some((e) => e['event'] === 'nostr.zapper.backfill.done')).toBe(false);
  });

  it('returns in-memory auth, no gift store, and InMemoryBtcUsdStore when blank', async () => {
    const factory = vi.fn(() => unusedClient());
    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      messageStore,
      translationStore,
      conversationTranslationStore,
      contactStore,
      memberHabitStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      rosterStore,
      bannerStore,
      debugDbStore,
      walletStore,
      memberEventStore,
    } = await openBootStores('   ', factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(giftRecorder).toBeUndefined();
    expect(messageStore).toBeUndefined();
    expect(translationStore).toBeUndefined();
    expect(conversationTranslationStore).toBeUndefined();
    expect(contactStore).toBeUndefined();
    expect(memberHabitStore).toBeUndefined();
    expect(posStore).toBeInstanceOf(InMemoryPosStore);
    expect(conversationStore).toBeUndefined();
    expect(notificationStore).toBeUndefined();
    expect(pushStore).toBeUndefined();
    expect(trustStore).toBeUndefined();
    expect(apiLogStore).toBeUndefined();
    expect(fundingStore).toBeUndefined();
    expect(rosterStore).toBeInstanceOf(InMemoryDailyRosterStore);
    expect(bannerStore).toBeUndefined();
    expect(debugDbStore).toBeUndefined();
    expect(walletStore).toBeUndefined();
    expect(memberEventStore).toBeUndefined();
    expect(btcUsdRates).toBeInstanceOf(InMemoryBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(InMemoryFiatStore);
    expect(factory).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['event'] === 'nostr.zap.backfill.done')).toBe(false);
    expect(parsedEvents(warn).some((e) => e['event'] === 'nostr.zapper.backfill.done')).toBe(false);
  });

  it('throws when a URL is set without a client factory', async () => {
    await expect(openBootStores('postgres://gifts21@localhost/gifts21')).rejects.toThrow(
      /SQL client factory/,
    );
  });

  it('opens durable auth, QueryGiftStore, migrates FX, and returns PostgresBtcUsdStore', async () => {
    const url = ' postgres://gifts21@localhost/gifts21 ';
    const queries: string[] = [];
    const executes: string[] = [];
    const operations: string[] = [];
    const client: SqlClient = {
      query: async <T>(text: string, _params?: readonly unknown[]): Promise<T[]> => {
        queries.push(text);
        operations.push(`query:${text}`);
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        if (text.includes('btc_usd_daily') || text.includes('usd_fiat_daily')) {
          return [] as T[];
        }
        if (text.includes('nostr_zap_ingest')) {
          return [] as T[];
        }
        if (text.includes('FROM account')) {
          return [] as T[];
        }
        return [
          {
            paid_at: '2026-06-01T12:00:00.000Z',
            amount_sats: 42n,
            recipient_wos_user: 'alice',
            kind: 'daily',
          },
        ] as T[];
      },
      execute: async (text: string) => {
        executes.push(text);
        operations.push(`execute:${text}`);
      },
    };
    const factory = vi.fn(() => client);

    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      fxSpotStore,
      messageStore,
      translationStore,
      conversationTranslationStore,
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      diagnosticStore,
      fundingStore,
      rosterStore,
      bannerStore,
      debugDbStore,
      sparkInvoiceStore,
      walletStore,
      memberEventStore,
      recoveryShareKek,
    } = await openBootStores(url, factory, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
      frankfurterUrl: 'https://example.test/frankfurter',
      now: () => Date.parse('2026-06-01T12:00:00.000Z'),
      nostrQuerier: new RecordingQuerier(),
      zapRelayUrls: ['wss://relay.example'],
      nostrRelayTimeoutMs: 50,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(url.trim());
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(recoveryShareKek).toEqual(new Uint8Array(32).fill(0xcd));
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(giftRecorder).toBeInstanceOf(SqlGiftRecorder);
    expect(messageStore).toBeInstanceOf(PostgresMessageStore);
    expect(translationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(conversationTranslationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(conversationTranslationStore).not.toBe(translationStore);
    expect(contactStore).toBeInstanceOf(PostgresContactStore);
    expect(posStore).toBeInstanceOf(PostgresPosStore);
    expect(conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(pushStore).toBeInstanceOf(PostgresPushStore);
    expect(trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(apiLogStore).toBeInstanceOf(PostgresApiLogStore);
    expect(diagnosticStore).toBeInstanceOf(PostgresDiagnosticStore);
    expect(fundingStore).toBeInstanceOf(PostgresFundingStore);
    expect(rosterStore).toBeInstanceOf(PostgresDailyRosterStore);
    expect(bannerStore).toBeInstanceOf(PostgresBannerStore);
    expect(debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(sparkInvoiceStore).toBeInstanceOf(PostgresSparkInvoiceStore);
    expect(walletStore).toBeInstanceOf(PostgresWalletStore);
    expect(memberEventStore).toBeInstanceOf(PostgresMemberEventStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(PostgresFiatStore);
    expect(fxSpotStore).toBeInstanceOf(PostgresFxSpotStore);
    expect(executes.length).toBeGreaterThan(0);
    expect(executes.some((q) => q.includes('message'))).toBe(true);
    expect(executes.some((q) => q.includes('contact'))).toBe(true);
    expect(executes.some((q) => q.includes('pos_charge'))).toBe(true);
    expect(executes.some((q) => q.includes('conversation'))).toBe(true);
    const posChargeIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS pos_charge \(/i.test(q),
    );
    const posInvoiceIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS pos_charge_invoice/i.test(q),
    );
    const shopPaymentIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS shop_payment \(/i.test(q),
    );
    const conversationIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS conversation \(/i.test(q),
    );
    // Shop payment tables reference pos_charge, so they migrate right after it.
    expect(posChargeIdx).toBeGreaterThanOrEqual(0);
    expect(posInvoiceIdx).toBeGreaterThanOrEqual(posChargeIdx);
    expect(shopPaymentIdx).toBeGreaterThan(posInvoiceIdx);
    expect(conversationIdx).toBeGreaterThan(shopPaymentIdx);
    expect(executes.some((q) => q.includes('push_subscription'))).toBe(true);
    expect(executes.some((q) => q.includes('notification'))).toBe(true);
    expect(executes.some((q) => q.includes('trust_edge'))).toBe(true);
    expect(executes.some((q) => q.includes('funding_grant'))).toBe(true);
    expect(executes.some((q) => q.includes('daily_roster'))).toBe(true);
    expect(executes.some((q) => q.includes('api_log'))).toBe(true);
    expect(executes.some((q) => q.includes('db_change'))).toBe(true);
    const trustIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS trust_edge/i.test(q));
    const fundingIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS funding_grant/i.test(q),
    );
    const rosterIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS daily_roster /i.test(q),
    );
    const apiLogIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS api_log/i.test(q));
    const accountImageIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS account_image/i.test(q),
    );
    const diagnosticIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS diagnostic_event/i.test(q),
    );
    const sparkInvoiceIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS spark_invoice/i.test(q),
    );
    const walletIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS wallet_balance_snapshot/i.test(q),
    );
    const memberEventIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS member_event/i.test(q),
    );
    const dbChangeIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS db_change/i.test(q));
    const recoveryTableIdx = ['recovery_share', 'pending_recovery', 'previous_wallet'].map(
      (table) =>
        executes.findIndex((q) => new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`).test(q)),
    );
    // The recovery tables come with the auth schema, so trg_db_change attaches to them too.
    for (const index of recoveryTableIdx) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(dbChangeIdx).toBeGreaterThan(index);
    }
    expect(recoveryTableIdx[1]).toBeGreaterThan(recoveryTableIdx[0] ?? -1);
    expect(recoveryTableIdx[2]).toBeGreaterThan(recoveryTableIdx[1] ?? -1);
    expect(sparkInvoiceIdx).toBeGreaterThanOrEqual(0);
    expect(walletIdx).toBeGreaterThan(sparkInvoiceIdx);
    expect(memberEventIdx).toBeGreaterThan(walletIdx);
    expect(dbChangeIdx).toBeGreaterThan(memberEventIdx);
    expect(dbChangeIdx).toBeGreaterThan(sparkInvoiceIdx);
    expect(trustIdx).toBeGreaterThanOrEqual(0);
    expect(fundingIdx).toBeGreaterThan(trustIdx);
    expect(rosterIdx).toBeGreaterThan(fundingIdx);
    expect(apiLogIdx).toBeGreaterThan(rosterIdx);
    expect(accountImageIdx).toBeGreaterThan(apiLogIdx);
    expect(diagnosticIdx).toBeGreaterThan(accountImageIdx);
    expect(dbChangeIdx).toBeGreaterThan(diagnosticIdx);
    expect(executes.some((q) => q.startsWith('INSERT INTO diagnostic_event'))).toBe(true);
    expect(executes.some((q) => /CREATE TABLE/i.test(q))).toBe(true);
    expect(queries.some((q) => q.includes('min(paid_at)'))).toBe(true);
    const btcUsdIdx = executes.findIndex((q) => q.includes('btc_usd_daily'));
    const fiatIdx = executes.findIndex((q) => q.includes('usd_fiat_daily'));
    expect(btcUsdIdx).toBeGreaterThanOrEqual(0);
    expect(fiatIdx).toBeGreaterThan(btcUsdIdx);
    expect(dbChangeIdx).toBeGreaterThan(fiatIdx);
    const fxSpotIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS btc_fiat_spot/i.test(q),
    );
    expect(fxSpotIdx).toBeGreaterThan(fiatIdx);
    expect(dbChangeIdx).toBeGreaterThan(fxSpotIdx);
    const zapPaymentIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS nostr_zap_payment/i.test(q),
    );
    expect(zapPaymentIdx).toBeGreaterThanOrEqual(0);
    expect(dbChangeIdx).toBeGreaterThan(zapPaymentIdx);
    // Match the attach statement itself: the message migration's unwrap block also names the trigger.
    const dbChangeAttachIdx = operations.findIndex(
      (operation) =>
        operation.startsWith('execute:') &&
        operation.includes('CREATE TRIGGER trg_db_change AFTER INSERT OR UPDATE OR DELETE'),
    );
    const backfillIdx = operations.findIndex(
      (operation) =>
        operation.startsWith('query:') &&
        operation.includes('nostr_zap_ingest') &&
        operation.includes("outcome = 'indexed'"),
    );
    expect(dbChangeAttachIdx).toBeGreaterThanOrEqual(0);
    expect(
      operations.findIndex(
        (operation) =>
          operation.startsWith('execute:') &&
          /CREATE TABLE IF NOT EXISTS db_change/i.test(operation),
      ),
    ).toBeLessThan(dbChangeAttachIdx);
    expect(backfillIdx).toBeGreaterThan(dbChangeAttachIdx);
    const zapperBackfillIdx = operations.findIndex(
      (operation) =>
        operation.startsWith('query:') &&
        operation.includes('nostr_zap_ingest') &&
        operation.includes('JOIN LATERAL'),
    );
    expect(zapperBackfillIdx).toBeGreaterThan(backfillIdx);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zap.backfill.done', claimed: 0, total: 0 }),
    );
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'nostr.zapper.backfill.done',
        scanned: 0,
        verified: 0,
        attributed: 0,
        gifts: 0,
      }),
    );

    if (giftStore === undefined) {
      throw new Error('expected QueryGiftStore');
    }
    const giftQueriesBefore = queries.length;
    const rows = await giftStore.listOutbound();
    expect(queries.length).toBe(giftQueriesBefore + 1);
    const sql = queries[queries.length - 1];
    if (sql === undefined) {
      throw new Error('expected gift SELECT');
    }
    expect(sql).toMatch(/SELECT paid_at, amount_sats, recipient_wos_user/);
    expect(sql).toMatch(/FROM gift/);
    expect(sql).toMatch(/direction = 'outbound'/);
    expect(rows).toEqual([
      {
        paidAt: new Date('2026-06-01T12:00:00.000Z'),
        amountSats: 42,
        recipientWosUser: 'alice',
        kind: 'daily',
        amountUsd: null,
        amountChf: null,
        amountEur: null,
        amountPhp: null,
      },
    ]);
  });

  it('logs gifts.fx.boot_fill.failed and still returns stores when fill throws', async () => {
    const diagnosticInserts: unknown[] = [];
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          throw new Error('range query failed');
        }
        if (text.includes('split_part(btrim(a.lightning_address)')) {
          return [{ id: 'acc-legacy' }] as T[];
        }
        if (text.includes('lightning_invoice')) {
          return [
            {
              id: 1,
              paid_at: new Date('2026-09-01T00:00:00.000Z'),
              direction: 'outbound',
              currency: 'BTC',
              amount_sats: 21,
              fee_sats: 0,
              recipient_wos_user: 'ada',
              kind: 'daily',
              lightning_invoice: 'lnbc',
              wos_transaction_id: null,
              description: 'gift',
              point_of_sale: true,
              wos_status: null,
              source_wallet: 'house',
              imported_at: '2026-09-01T00:00:00.000Z',
              fiat_usd: '1.25',
              fiat_chf: null,
              fiat_eur: 2,
              fiat_php: null,
            },
            {
              id: 2,
              paid_at: new Date('2026-09-02T00:00:00.000Z'),
              direction: 'outbound',
              currency: 'BTC',
              amount_sats: 21,
              fee_sats: 0,
              recipient_wos_user: 'ada',
              kind: 'daily',
              lightning_invoice: 'lnbc2',
              wos_transaction_id: null,
              description: 'gift',
              point_of_sale: false,
              wos_status: null,
              source_wallet: 'house',
              imported_at: '2026-09-02T00:00:00.000Z',
              fiat_usd: null,
              fiat_chf: '0.80',
              fiat_eur: null,
              fiat_php: '50.00',
            },
          ] as T[];
        }
        return [] as T[];
      },
      execute: async (text: string, params?: readonly unknown[]) => {
        if (text.includes('INSERT INTO diagnostic_event')) {
          diagnosticInserts.push(params?.[3]);
        }
      },
    };
    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      messageStore,
      translationStore,
      conversationTranslationStore,
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      diagnosticStore,
      fundingStore,
      listDbChange,
      debugDbStore,
      walletStore,
      memberEventStore,
    } = await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
    });
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(giftRecorder).toBeInstanceOf(SqlGiftRecorder);
    expect(messageStore).toBeInstanceOf(PostgresMessageStore);
    expect(translationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(conversationTranslationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(conversationTranslationStore).not.toBe(translationStore);
    expect(contactStore).toBeInstanceOf(PostgresContactStore);
    expect(posStore).toBeInstanceOf(PostgresPosStore);
    expect(conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(pushStore).toBeInstanceOf(PostgresPushStore);
    expect(trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(apiLogStore).toBeInstanceOf(PostgresApiLogStore);
    expect(diagnosticStore).toBeInstanceOf(PostgresDiagnosticStore);
    expect(fundingStore).toBeInstanceOf(PostgresFundingStore);
    expect(debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(walletStore).toBeInstanceOf(PostgresWalletStore);
    expect(memberEventStore).toBeInstanceOf(PostgresMemberEventStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(PostgresFiatStore);
    expect(typeof listDbChange).toBe('function');
    expect(await listDbChange?.(10)).toEqual([]);
    expect(await giftStore?.listLegacyWelcomeAccountIds?.()).toEqual(['acc-legacy']);
    expect(await giftStore?.listDebug?.(10)).toEqual([
      expect.objectContaining({
        id: 1,
        currency: 'BTC',
        lightningInvoice: 'lnbc',
        pointOfSale: true,
        importedAt: '2026-09-01T00:00:00.000Z',
        amountUsd: '1.25',
        amountChf: null,
        amountEur: '2',
        amountPhp: null,
      }),
      expect.objectContaining({
        id: 2,
        amountUsd: null,
        amountChf: '0.80',
        amountEur: null,
        amountPhp: '50.00',
        pointOfSale: false,
      }),
    ]);
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.fx.boot_fill.failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.fx.fiat_boot_fill.failed')).toBe(
      true,
    );
    expect(diagnosticInserts).toEqual(
      expect.arrayContaining(['gifts.fx.boot_fill.failed', 'gifts.fx.fiat_boot_fill.failed']),
    );
  });

  it('logs diagnostic.write.failed when a boot diagnostic insert throws', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          throw new Error('range query failed');
        }
        return [] as T[];
      },
      execute: async (text: string) => {
        if (text.includes('INSERT INTO diagnostic_event')) {
          throw new Error('disk');
        }
      },
    };
    await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
    });
    await Promise.resolve();
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.fx.boot_fill.failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'diagnostic.write.failed')).toBe(true);
  });

  it('writes api_log and diagnostic_event on logSql', async () => {
    const inserts: string[] = [];
    const client = (label: string): SqlClient => ({
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        return [] as T[];
      },
      execute: async (text: string) => {
        if (text.includes('INSERT INTO api_log')) {
          inserts.push(`${label}:api_log`);
        } else if (text.includes('INSERT INTO diagnostic_event')) {
          inserts.push(`${label}:diagnostic_event`);
        }
      },
    });
    const stores = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client('primary'),
      {
        fetchImpl: async () => new Response('[]', { status: 200 }),
        candlesUrl: 'https://example.test/candles',
        frankfurterUrl: 'https://example.test/frankfurter',
        logSql: client('log'),
      },
    );
    if (stores.apiLogStore === undefined) {
      throw new Error('expected api log store');
    }
    await stores.apiLogStore.append({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: new Date(0),
      method: 'GET',
      path: '/info',
      status: 200,
      ms: 1,
      accountId: null,
      authKind: 'none',
      clientIp: null,
      clientCountry: null,
      cfRay: null,
      userAgent: null,
      acceptLanguage: null,
      origin: null,
    });
    logEvent('boot.test.log_client');
    await vi.waitFor(() => {
      expect(inserts).toContain('log:diagnostic_event');
    });
    expect(inserts.filter((row) => row.startsWith('primary:'))).toEqual([]);
    expect(inserts).toContain('log:api_log');
  });

  it('logs a failed external-zapper backfill and still returns every durable store', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        if (text.includes('JOIN LATERAL')) {
          throw new Error('external-zapper backfill failed');
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };

    const stores = await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
      frankfurterUrl: 'https://example.test/frankfurter',
      nostrQuerier: new RecordingQuerier(),
      zapRelayUrls: ['wss://relay.example'],
    });

    expect(stores.messageStore).toBeInstanceOf(PostgresMessageStore);
    expect(stores.shopIdentityStore).toBeInstanceOf(PostgresShopIdentityStore);
    expect(stores.translationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(stores.conversationTranslationStore).toBeInstanceOf(PostgresTranslationStore);
    expect(stores.conversationTranslationStore).not.toBe(stores.translationStore);
    expect(stores.contactStore).toBeInstanceOf(PostgresContactStore);
    expect(stores.memberHabitStore).toBeInstanceOf(PostgresMemberHabitStore);
    const habits = stores.memberHabitStore;
    if (!(habits instanceof PostgresMemberHabitStore)) {
      throw new Error('expected PostgresMemberHabitStore');
    }
    expect(await habits.lightning('acc')).toBeNull();
    await habits.setLightning('acc', 'ada@example.com');
    expect(await habits.lightning('acc')).toBeNull();
    expect(stores.posStore).toBeInstanceOf(PostgresPosStore);
    expect(stores.conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(stores.notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(stores.pushStore).toBeInstanceOf(PostgresPushStore);
    expect(stores.trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(stores.debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(stores.walletStore).toBeInstanceOf(PostgresWalletStore);
    expect(stores.memberEventStore).toBeInstanceOf(PostgresMemberEventStore);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zapper.backfill.failed' }),
    );
  });

  it('hands the transaction port to the SQL point-of-sale store for the payment hash claim', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> =>
        (text.includes('min(paid_at)') ? [{ min: null, max: null }] : []) as T[],
      execute: async () => undefined,
    };
    const statements: string[] = [];
    const transactions: MergeDb = {
      begin: (run) =>
        run({
          query: async <Q>(text: string): Promise<Q[]> => {
            statements.push(text);
            return [] as Q[];
          },
        }),
    };
    const stores = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client,
      {
        fetchImpl: async () => new Response('[]', { status: 200 }),
        candlesUrl: 'https://example.test/candles',
        frankfurterUrl: 'https://example.test/frankfurter',
        nostrQuerier: new RecordingQuerier(),
        zapRelayUrls: ['wss://relay.example'],
      },
      transactions,
    );
    expect(await stores.posStore.recordInvoice('c1', 'a'.repeat(64), 0)).toEqual({
      outcome: 'not_open',
    });
    expect(statements[0]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
  });

  it('hands the transaction port to the SQL auth store for the social recovery steps', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> =>
        (text.includes('min(paid_at)') ? [{ min: null, max: null }] : []) as T[],
      execute: async () => undefined,
    };
    const statements: string[] = [];
    const transactions: MergeDb = {
      begin: (run) =>
        run({
          query: async <Q>(text: string): Promise<Q[]> => {
            statements.push(text);
            return [] as Q[];
          },
        }),
    };
    const stores = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client,
      {
        fetchImpl: async () => new Response('[]', { status: 200 }),
        candlesUrl: 'https://example.test/candles',
        frankfurterUrl: 'https://example.test/frankfurter',
        nostrQuerier: new RecordingQuerier(),
        zapRelayUrls: ['wss://relay.example'],
      },
      transactions,
    );
    expect(
      await stores.authStore.putRecoveryShare({
        accountId: 'acc',
        sparkPubkey: `02${'a'.repeat(64)}`,
        ciphertext: new Uint8Array(40),
        now: 1,
      }),
    ).toBe('changed');
    expect(statements[0]).toMatch(/FROM account WHERE id = \$1 FOR UPDATE/);
  });

  describe('RECOVERY_SHARE_KEK on the SQL path', () => {
    const quietClient = (executes: string[]): SqlClient => ({
      query: async <T>(text: string): Promise<T[]> =>
        (text.includes('min(paid_at)') ? [{ min: null, max: null }] : []) as T[],
      execute: async (text: string) => {
        executes.push(text);
      },
    });

    it('rejects a boot without it after the auth migration ran', async () => {
      delete process.env['RECOVERY_SHARE_KEK'];
      const executes: string[] = [];
      await expect(
        openBootStores('postgres://gifts21@localhost/gifts21', () => quietClient(executes)),
      ).rejects.toThrow(/RECOVERY_SHARE_KEK is required when DATABASE_URL is set/);
      expect(executes.some((q) => q.includes('CREATE TABLE IF NOT EXISTS recovery_share'))).toBe(
        true,
      );
      expect(executes.some((q) => q.includes('btc_usd_daily'))).toBe(false);
    });

    it('rejects a blank or malformed value', async () => {
      process.env['RECOVERY_SHARE_KEK'] = '   ';
      await expect(
        openBootStores('postgres://gifts21@localhost/gifts21', () => quietClient([])),
      ).rejects.toThrow(/RECOVERY_SHARE_KEK is required/);
      process.env['RECOVERY_SHARE_KEK'] = 'CD'.repeat(32);
      await expect(
        openBootStores('postgres://gifts21@localhost/gifts21', () => quietClient([])),
      ).rejects.toThrow(/RECOVERY_SHARE_KEK must be 64 lowercase hex/);
    });

    it('rejects a value equal to NOSTR_NSEC_KEK', async () => {
      process.env['RECOVERY_SHARE_KEK'] = 'ab'.repeat(32);
      await expect(
        openBootStores('postgres://gifts21@localhost/gifts21', () => quietClient([])),
      ).rejects.toThrow(/RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK/);
    });
  });

  it('links roster rows to accounts after the db_change triggers with the LNURL host', async () => {
    const operations: Array<{
      kind: 'query' | 'execute';
      text: string;
      params: readonly unknown[] | undefined;
    }> = [];
    const client: SqlClient = {
      query: async <T>(text: string, params?: readonly unknown[]): Promise<T[]> => {
        operations.push({ kind: 'query', text, params });
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        if (text === DAILY_ROSTER_ACCOUNT_LINK_SQL) {
          return [{ linked: 21, unlinked: 1 }] as T[];
        }
        return [] as T[];
      },
      execute: async (text: string, params?: readonly unknown[]) => {
        operations.push({ kind: 'execute', text, params });
      },
    };

    await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
      frankfurterUrl: 'https://example.test/frankfurter',
      nostrQuerier: new RecordingQuerier(),
      zapRelayUrls: ['wss://relay.example'],
      lnurlServer: {
        baseUrl: 'http://lnurl.internal',
        publicBaseUrl: 'https://21.gifts',
        host: '21.Gifts',
      },
    });

    const rosterIdx = operations.findIndex((o) =>
      /CREATE TABLE IF NOT EXISTS daily_roster_entry/i.test(o.text),
    );
    const dbChangeIdx = operations.findIndex((o) =>
      /CREATE TABLE IF NOT EXISTS db_change/i.test(o.text),
    );
    const lastTriggerIdx = operations.reduce(
      (last, o, i) => (o.text.includes('trg_db_change') ? i : last),
      -1,
    );
    const moves = operations.filter((o) => o.text === DAILY_ROSTER_ACCOUNT_LINK_SQL);
    const moveIdx = operations.findIndex((o) => o.text === DAILY_ROSTER_ACCOUNT_LINK_SQL);
    expect(rosterIdx).toBeGreaterThanOrEqual(0);
    expect(dbChangeIdx).toBeGreaterThan(rosterIdx);
    expect(lastTriggerIdx).toBeGreaterThan(dbChangeIdx);
    expect(moveIdx).toBeGreaterThan(lastTriggerIdx);
    expect(moves).toEqual([
      { kind: 'query', text: DAILY_ROSTER_ACCOUNT_LINK_SQL, params: ['21.gifts'] },
    ]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'daily_roster.accounts_linked', linked: 21, unlinked: 1 }),
    );
  });

  it('links roster rows by legacy address only when the LNURL server is off', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] | undefined }> = [];
    const client: SqlClient = {
      query: async <T>(text: string, params?: readonly unknown[]): Promise<T[]> => {
        queries.push({ text, params });
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };

    await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
      frankfurterUrl: 'https://example.test/frankfurter',
      nostrQuerier: new RecordingQuerier(),
      zapRelayUrls: ['wss://relay.example'],
      lnurlServer: null,
    });

    expect(queries.filter((q) => q.text === DAILY_ROSTER_ACCOUNT_LINK_SQL)).toEqual([
      { text: DAILY_ROSTER_ACCOUNT_LINK_SQL, params: [null] },
    ]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'daily_roster.accounts_linked', linked: 0, unlinked: 0 }),
    );
  });

  it('uses default fetch and candles URL when fx options are omitted', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        if (text.includes('lightning_invoice')) {
          return [
            {
              id: 1,
              paid_at: new Date('2026-09-01T00:00:00.000Z'),
              direction: 'outbound',
              currency: 'BTC',
              amount_sats: 21,
              fee_sats: 0,
              recipient_wos_user: 'ada',
              kind: 'daily',
              lightning_invoice: 'lnbc',
              wos_transaction_id: null,
              description: 'gift',
              point_of_sale: false,
              wos_status: null,
              source_wallet: 'house',
              imported_at: '2026-09-01T00:00:00.000Z',
            },
          ] as T[];
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };
    const { btcUsdRates, fiatRates, giftStore, giftRecorder } = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client,
    );
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(giftRecorder).toBeInstanceOf(SqlGiftRecorder);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(PostgresFiatStore);
  });
});

describe('process entry store wiring', () => {
  it('passes the SQL habit store into createApp the same way as the contact store', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
    const taken = source.indexOf('memberHabitStore,');
    const passed = source.indexOf(
      '...(memberHabitStore === undefined ? {} : { memberHabitStore })',
    );
    expect(taken).toBeGreaterThanOrEqual(0);
    expect(passed).toBeGreaterThan(taken);
    expect(source).toContain('...(contactStore === undefined ? {} : { contactStore })');
  });
});
