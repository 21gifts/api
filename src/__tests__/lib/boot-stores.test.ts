import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openBootStores } from '@/lib/boot-stores';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { InMemoryBtcUsdStore, PostgresBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryFiatStore, PostgresFiatStore } from '@/lib/usd-fiat-store';
import { QueryGiftStore } from '@/lib/gift-store';
import { SqlGiftRecorder } from '@/lib/gift-recorder';
import { PostgresContactStore } from '@/lib/contact-store';
import { InMemoryPosStore, PostgresPosStore } from '@/lib/pos-store';
import { PostgresConversationStore } from '@/lib/conversation-store';
import { PostgresMessageStore } from '@/lib/message-store';
import { PostgresNotificationStore } from '@/lib/notification-store';
import { RecordingQuerier } from '@/lib/nostr/query';
import { PostgresPushStore } from '@/lib/push-store';
import { PostgresTrustStore } from '@/lib/trust-store';
import { PostgresApiLogStore } from '@/lib/api-log';
import { PostgresFundingStore } from '@/lib/funding-store';
import { PostgresDebugDbStore } from '@/lib/debug-db';

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
  });

  afterEach(() => {
    warn.mockRestore();
    delete process.env['NOSTR_NSEC_KEK'];
  });

  it('returns in-memory auth, no gift store, and InMemoryBtcUsdStore when unset', async () => {
    const factory = vi.fn(() => unusedClient());
    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      messageStore,
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      listDbChange,
      debugDbStore,
    } = await openBootStores(undefined, factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(giftRecorder).toBeUndefined();
    expect(messageStore).toBeUndefined();
    expect(contactStore).toBeUndefined();
    expect(posStore).toBeInstanceOf(InMemoryPosStore);
    expect(conversationStore).toBeUndefined();
    expect(notificationStore).toBeUndefined();
    expect(pushStore).toBeUndefined();
    expect(trustStore).toBeUndefined();
    expect(apiLogStore).toBeUndefined();
    expect(fundingStore).toBeUndefined();
    expect(listDbChange).toBeUndefined();
    expect(debugDbStore).toBeUndefined();
    expect(btcUsdRates).toBeInstanceOf(InMemoryBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(InMemoryFiatStore);
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
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      debugDbStore,
    } = await openBootStores('   ', factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(giftRecorder).toBeUndefined();
    expect(messageStore).toBeUndefined();
    expect(contactStore).toBeUndefined();
    expect(posStore).toBeInstanceOf(InMemoryPosStore);
    expect(conversationStore).toBeUndefined();
    expect(notificationStore).toBeUndefined();
    expect(pushStore).toBeUndefined();
    expect(trustStore).toBeUndefined();
    expect(apiLogStore).toBeUndefined();
    expect(fundingStore).toBeUndefined();
    expect(debugDbStore).toBeUndefined();
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
      messageStore,
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      debugDbStore,
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
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(giftRecorder).toBeInstanceOf(SqlGiftRecorder);
    expect(messageStore).toBeInstanceOf(PostgresMessageStore);
    expect(contactStore).toBeInstanceOf(PostgresContactStore);
    expect(posStore).toBeInstanceOf(PostgresPosStore);
    expect(conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(pushStore).toBeInstanceOf(PostgresPushStore);
    expect(trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(apiLogStore).toBeInstanceOf(PostgresApiLogStore);
    expect(fundingStore).toBeInstanceOf(PostgresFundingStore);
    expect(debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(PostgresFiatStore);
    expect(executes.length).toBeGreaterThan(0);
    expect(executes.some((q) => q.includes('message'))).toBe(true);
    expect(executes.some((q) => q.includes('contact'))).toBe(true);
    expect(executes.some((q) => q.includes('pos_charge'))).toBe(true);
    expect(executes.some((q) => q.includes('conversation'))).toBe(true);
    expect(executes.some((q) => q.includes('push_subscription'))).toBe(true);
    expect(executes.some((q) => q.includes('notification'))).toBe(true);
    expect(executes.some((q) => q.includes('trust_edge'))).toBe(true);
    expect(executes.some((q) => q.includes('funding_grant'))).toBe(true);
    expect(executes.some((q) => q.includes('api_log'))).toBe(true);
    expect(executes.some((q) => q.includes('db_change'))).toBe(true);
    const trustIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS trust_edge/i.test(q));
    const fundingIdx = executes.findIndex((q) =>
      /CREATE TABLE IF NOT EXISTS funding_grant/i.test(q),
    );
    const apiLogIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS api_log/i.test(q));
    const dbChangeIdx = executes.findIndex((q) => /CREATE TABLE IF NOT EXISTS db_change/i.test(q));
    expect(trustIdx).toBeGreaterThanOrEqual(0);
    expect(fundingIdx).toBeGreaterThan(trustIdx);
    expect(apiLogIdx).toBeGreaterThan(fundingIdx);
    expect(dbChangeIdx).toBeGreaterThan(apiLogIdx);
    expect(executes.some((q) => /CREATE TABLE/i.test(q))).toBe(true);
    expect(queries.some((q) => q.includes('min(paid_at)'))).toBe(true);
    const btcUsdIdx = executes.findIndex((q) => q.includes('btc_usd_daily'));
    const fiatIdx = executes.findIndex((q) => q.includes('usd_fiat_daily'));
    expect(btcUsdIdx).toBeGreaterThanOrEqual(0);
    expect(fiatIdx).toBeGreaterThan(btcUsdIdx);
    expect(dbChangeIdx).toBeGreaterThan(fiatIdx);
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
        amountUsd: null,
        amountChf: null,
        amountEur: null,
        amountPhp: null,
      },
    ]);
  });

  it('logs gifts.fx.boot_fill.failed and still returns stores when fill throws', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          throw new Error('range query failed');
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
      execute: async () => undefined,
    };
    const {
      authStore,
      giftStore,
      giftRecorder,
      btcUsdRates,
      fiatRates,
      messageStore,
      contactStore,
      posStore,
      conversationStore,
      notificationStore,
      pushStore,
      trustStore,
      apiLogStore,
      fundingStore,
      listDbChange,
      debugDbStore,
    } = await openBootStores('postgres://gifts21@localhost/gifts21', () => client, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
    });
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(giftRecorder).toBeInstanceOf(SqlGiftRecorder);
    expect(messageStore).toBeInstanceOf(PostgresMessageStore);
    expect(contactStore).toBeInstanceOf(PostgresContactStore);
    expect(posStore).toBeInstanceOf(PostgresPosStore);
    expect(conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(pushStore).toBeInstanceOf(PostgresPushStore);
    expect(trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(apiLogStore).toBeInstanceOf(PostgresApiLogStore);
    expect(fundingStore).toBeInstanceOf(PostgresFundingStore);
    expect(debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(fiatRates).toBeInstanceOf(PostgresFiatStore);
    expect(typeof listDbChange).toBe('function');
    expect(await listDbChange?.(10)).toEqual([]);
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
    expect(stores.contactStore).toBeInstanceOf(PostgresContactStore);
    expect(stores.posStore).toBeInstanceOf(PostgresPosStore);
    expect(stores.conversationStore).toBeInstanceOf(PostgresConversationStore);
    expect(stores.notificationStore).toBeInstanceOf(PostgresNotificationStore);
    expect(stores.pushStore).toBeInstanceOf(PostgresPushStore);
    expect(stores.trustStore).toBeInstanceOf(PostgresTrustStore);
    expect(stores.debugDbStore).toBeInstanceOf(PostgresDebugDbStore);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'nostr.zapper.backfill.failed' }),
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
