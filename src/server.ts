import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoute } from '@/routes/health';
import { infoRoute } from '@/routes/info';
import { brandRoutes, readPublicBrandFile } from '@/routes/brand';
import type { BrandReader } from '@/routes/brand';
import { authRoutes } from '@/routes/auth';
import { SimpleWebAuthnPasskeyCeremony } from '@/lib/auth/webauthn';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import { meRoutes } from '@/routes/me';
import { viewRoutes } from '@/routes/view';
import { lightningAddressRoutes } from '@/routes/lightning-address';
import { debugRoutes } from '@/routes/debug';
import { giftsStatsRoutes } from '@/routes/stats';
import { giftsRoutes } from '@/routes/gifts';
import { invoiceRoutes } from '@/routes/invoices';
import { messagesRoutes } from '@/routes/messages';
import { contactRoutes } from '@/routes/contact';
import { debugContactsRoutes } from '@/routes/debug-contacts';
import { debugPaymentsRoutes } from '@/routes/debug-payments';
import { pushRoutes } from '@/routes/push';
import { debugPushRoutes } from '@/routes/debug-push';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { AuthStore } from '@/lib/auth/store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import type { GiftStore } from '@/lib/gift-store';
import { InMemoryContactStore } from '@/lib/contact-store';
import type { ContactStore } from '@/lib/contact-store';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { MessageStore } from '@/lib/message-store';
import { resolveVapidConfig } from '@/lib/push-config';
import { InMemoryPushStore, type PushStore } from '@/lib/push-store';
import { resolveAllowedOrigins } from '@/lib/config';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import type { InvoicePayer } from '@/lib/invoice-payer';
import { InMemoryInvoiceStore } from '@/lib/invoice-store';
import type { InvoiceStore } from '@/lib/invoice-store';
import type { GiftRecorder } from '@/lib/gift-recorder';
import { InMemoryLnAddressCache } from '@/lib/ln-address-cache';
import type { LnAddressCache } from '@/lib/ln-address-cache';
import { requestLog } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';

/**
 * Optional collaborators for {@link createApp}. All default to production
 * implementations; tests inject a store or a fixed clock to drive the auth
 * flow deterministically.
 */
export interface AppDeps {
  /** Shared auth persistence port (default: a fresh in-memory store). */
  authStore?: AuthStore;
  /** Clock returning epoch milliseconds (default: `Date.now`). */
  now?: () => number;
  /** Browser origins allowed by CORS (default: from `CORS_ALLOWED_ORIGINS` / app surfaces). */
  allowedOrigins?: string[];
  /**
   * Pays verification micro-payment invoices (default:
   * {@link UnconfiguredInvoicePayer} — process boots; start verification returns 503).
   */
  invoicePayer?: InvoicePayer;
  /** Injected `fetch` for LNURL-pay (default: `globalThis.fetch`). */
  fetchImpl?: FetchFn;
  /**
   * Successful LUD-16 metadata cache (default: a fresh
   * {@link InMemoryLnAddressCache} with a 5-minute TTL).
   */
  lnAddressCache?: LnAddressCache;
  /**
   * Reads brand mark bytes for `/favicon.ico`, `/favicon.svg`, and
   * `/apple-touch-icon.png` (default: {@link readPublicBrandFile}).
   */
  readBrand?: BrandReader;
  /**
   * Operator debug token (default: `process.env.DEBUG_TOKEN`). Unset or
   * blank → `GET /debug/accounts`, `POST /debug/accounts`,
   * `PATCH /debug/accounts/:id`, `GET /debug/contacts`, `GET /debug/invoices`,
   * and `GET /debug/zap-ingests` return 503.
   */
  debugToken?: string;
  /**
   * Outbound gifts for public statistics (default: empty
   * {@link InMemoryGiftStore}).
   */
  giftStore?: GiftStore;
  /** Raw `WEBAUTHN_RP_ID` (default: `process.env.WEBAUTHN_RP_ID`). */
  webAuthnRpId?: string;
  /** Raw `WEBAUTHN_RP_NAME` (default: `process.env.WEBAUTHN_RP_NAME`). */
  webAuthnRpName?: string;
  /**
   * WebAuthn generate/verify collaborator (default:
   * {@link SimpleWebAuthnPasskeyCeremony}).
   */
  passkeyCeremony?: PasskeyCeremony;
  /**
   * Spend-worker shared secret (default: `process.env.SPEND_API_TOKEN`).
   * Unset → `POST /invoices` returns 503.
   */
  spendApiToken?: string;
  /** Gift invoices issued for the spend worker (default: in-memory). */
  invoiceStore?: InvoiceStore;
  /**
   * Persist proven spend gifts into `gift` (default: no-op). Boot injects
   * {@link SqlGiftRecorder} when `DATABASE_URL` is set.
   */
  giftRecorder?: GiftRecorder;
  /**
   * Historical BTC-USD rates for gift stats (default: empty
   * {@link InMemoryBtcUsdStore} — empty boots stay empty 200).
   */
  btcUsdRates?: BtcUsdRateBook;
  /**
   * Member forum messages (default: empty {@link InMemoryMessageStore}).
   * Boot injects {@link PostgresMessageStore} when `DATABASE_URL` is set.
   */
  messageStore?: MessageStore;
  /** Optional AES-256 KEK for custodial nsec (memory boots may omit). */
  nostrKek?: Uint8Array;
  /**
   * Private in-app contact mailbox (default: empty
   * {@link InMemoryContactStore}). Boot injects
   * {@link PostgresContactStore} when `DATABASE_URL` is set.
   */
  contactStore?: ContactStore;
  /**
   * Web Push subscriptions and outbox (default: empty
   * {@link InMemoryPushStore}). Boot injects
   * {@link PostgresPushStore} when `DATABASE_URL` is set.
   */
  pushStore?: PushStore;
  /**
   * Public VAPID key when both keys resolve (default:
   * `resolveVapidConfig(process.env)?.publicKey`). Missing → push HTTP 503.
   */
  vapidPublicKey?: string;
}

/**
 * Build a fully wired Hono application.
 *
 * Kept separate from the runtime entry point so tests can drive the handlers
 * via Hono's `app.request()` helper without binding to a TCP port. Every
 * wire-up change — middleware, routes, error handlers — flows through this
 * single factory so the test surface matches production exactly. Mounts
 * public `GET /view/:viewKey` alongside `/me`, Web Push subscription routes,
 * and the rest of the surface.
 *
 * @param deps - Optional overrides for the auth store, clock, invoice payer,
 *   LNURL-pay fetch, LN-Address cache, brand reader, debugToken, gift store,
 *   gift recorder, BTC-USD rates, message store, contact store, push store,
 *   vapidPublicKey, nostrKek, WebAuthn RP, spend token, and gift invoice store.
 * @returns A Hono app with all routes and middleware attached.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const store = deps.authStore ?? new InMemoryAuthStore();
  const now = deps.now ?? Date.now;
  const allowedOrigins = deps.allowedOrigins ?? resolveAllowedOrigins(process.env);
  const invoicePayer = deps.invoicePayer ?? new UnconfiguredInvoicePayer();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const lnAddressCache = deps.lnAddressCache ?? new InMemoryLnAddressCache();
  const readBrand = deps.readBrand ?? readPublicBrandFile;
  const debugToken = deps.debugToken ?? process.env['DEBUG_TOKEN'];
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const btcUsdRates = deps.btcUsdRates ?? new InMemoryBtcUsdStore();
  const messageStore = deps.messageStore ?? new InMemoryMessageStore();
  const nostrKek = deps.nostrKek;
  const contactStore = deps.contactStore ?? new InMemoryContactStore();
  const pushStore = deps.pushStore ?? new InMemoryPushStore();
  const vapidPublicKey = deps.vapidPublicKey ?? resolveVapidConfig(process.env)?.publicKey;
  const webAuthnRpId = deps.webAuthnRpId ?? process.env['WEBAUTHN_RP_ID'];
  const webAuthnRpName = deps.webAuthnRpName ?? process.env['WEBAUTHN_RP_NAME'];
  const passkeyCeremony = deps.passkeyCeremony ?? new SimpleWebAuthnPasskeyCeremony();
  const spendApiToken = deps.spendApiToken ?? process.env['SPEND_API_TOKEN'];
  const invoiceStore = deps.invoiceStore ?? new InMemoryInvoiceStore();
  const giftRecorder = deps.giftRecorder;

  const app = new Hono();

  app.use('*', requestLog());
  // Browser origin is the apex (21.gifts); the api still listens on api.21.gifts.
  // CORS covers the apex, transitional app.* aliases, and localhost.
  // Bearer sessions are headers (no cookies), credentials off.
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400,
    }),
  );

  app.route('/', brandRoutes({ read: readBrand }));
  app.route('/', pushRoutes({ authStore: store, pushStore, now, vapidPublicKey }));
  app.route('/healthz', healthRoute);
  app.route('/info', infoRoute);
  app.route(
    '/auth',
    authRoutes({
      store,
      now,
      allowedOrigins,
      webAuthnRpId,
      webAuthnRpName,
      passkeyCeremony,
      ...(nostrKek === undefined ? {} : { nostrKek }),
    }),
  );
  app.route('/me', meRoutes({ store, now, payer: invoicePayer, fetchImpl }));
  app.route('/view', viewRoutes({ store }));
  app.route(
    '/lightning-address',
    lightningAddressRoutes({ cache: lnAddressCache, now, fetchImpl }),
  );
  app.route('/debug/accounts', debugRoutes({ store, debugToken }));
  app.route('/debug/contacts', debugContactsRoutes({ store: contactStore, debugToken }));
  app.route('/debug', debugPaymentsRoutes({ store: messageStore, debugToken }));
  app.route(
    '/debug/push-ping',
    debugPushRoutes({
      authStore: store,
      pushStore,
      now,
      debugToken,
      vapidPublicKey,
    }),
  );
  app.route('/gifts', giftsRoutes({ store: giftStore, rates: btcUsdRates, now }));
  app.route('/gifts/stats', giftsStatsRoutes({ store: giftStore, rates: btcUsdRates, now }));
  app.route(
    '/messages',
    messagesRoutes({
      store: messageStore,
      authStore: store,
      now,
      fetchImpl,
      pushStore,
      ...(nostrKek === undefined ? {} : { nostrKek }),
    }),
  );
  app.route('/contact', contactRoutes({ store: contactStore, authStore: store, now }));
  app.route(
    '/invoices',
    invoiceRoutes({
      spendApiToken,
      store: invoiceStore,
      now,
      fetchImpl,
      ...(giftRecorder === undefined ? {} : { giftRecorder }),
    }),
  );

  return app;
}

/** Resolved bind address in `{ host, port }` form. */
export interface BindAddress {
  host: string;
  port: number;
}

/**
 * Resolve the effective bind address from an explicit override, an
 * environment variable, and a hard default — in that order.
 *
 * @param override - Caller-supplied override (highest precedence).
 * @param env - Process environment slice; passed in so tests can inject.
 * @returns The first non-empty candidate, falling back to `0.0.0.0:3000`.
 */
export function resolveBindAddr(
  override: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return override ?? env['BIND_ADDR'] ?? '0.0.0.0:3000';
}

/**
 * Parse a `host:port` bind address.
 *
 * Validates that both parts are present and that the port is an integer in
 * the legal range `0..65535`. Throws a descriptive `Error` otherwise — the
 * runtime entry point catches and logs it; tests assert on the message.
 *
 * @param addr - Bind address in `host:port` form.
 * @returns Parsed `{ host, port }`.
 * @throws If `addr` is malformed or `port` is outside `0..65535`.
 */
export function parseBindAddr(addr: string): BindAddress {
  const sep = addr.lastIndexOf(':');
  if (sep <= 0 || sep === addr.length - 1) {
    throw new Error(`Invalid BIND_ADDR "${addr}" — expected "host:port"`);
  }
  const host = addr.slice(0, sep);
  const portStr = addr.slice(sep + 1);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new Error(`Invalid port "${portStr}" in BIND_ADDR — must be 0..65535`);
  }
  return { host, port };
}
