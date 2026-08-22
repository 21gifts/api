import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoute } from '@/routes/health';
import { infoRoute } from '@/routes/info';
import { brandRoutes, readPublicBrandFile } from '@/routes/brand';
import type { BrandReader } from '@/routes/brand';
import { authRoutes } from '@/routes/auth';
import { meRoutes } from '@/routes/me';
import { lightningAddressRoutes } from '@/routes/lightning-address';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { AuthStore } from '@/lib/auth/store';
import { resolveAllowedOrigins } from '@/lib/config';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import type { InvoicePayer } from '@/lib/invoice-payer';
import { InMemoryLnAddressCache } from '@/lib/ln-address-cache';
import type { LnAddressCache } from '@/lib/ln-address-cache';
import { requestLog } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';

/**
 * Optional collaborators for {@link createApp}. All default to production
 * implementations; tests inject a store, a fixed clock, or a base URL to drive
 * the auth flow deterministically.
 */
export interface AppDeps {
  /** Shared auth persistence port (default: a fresh in-memory store). */
  authStore?: AuthStore;
  /** Clock returning epoch milliseconds (default: `Date.now`). */
  now?: () => number;
  /** Pinned public base URL (default: `process.env.PUBLIC_BASE_URL`). */
  publicBaseUrl?: string;
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
}

/**
 * Build a fully wired Hono application.
 *
 * Kept separate from the runtime entry point so tests can drive the handlers
 * via Hono's `app.request()` helper without binding to a TCP port. Every
 * wire-up change — middleware, routes, error handlers — flows through this
 * single factory so the test surface matches production exactly.
 *
 * @param deps - Optional overrides for the auth store, clock, base URL,
 *   invoice payer, LNURL-pay fetch, LN-Address cache, and brand reader.
 * @returns A Hono app with all routes and middleware attached.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const store = deps.authStore ?? new InMemoryAuthStore();
  const now = deps.now ?? Date.now;
  const publicBaseUrl = deps.publicBaseUrl ?? process.env['PUBLIC_BASE_URL'];
  const allowedOrigins = deps.allowedOrigins ?? resolveAllowedOrigins(process.env);
  const invoicePayer = deps.invoicePayer ?? new UnconfiguredInvoicePayer();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const lnAddressCache = deps.lnAddressCache ?? new InMemoryLnAddressCache();
  const readBrand = deps.readBrand ?? readPublicBrandFile;

  const app = new Hono();

  app.use('*', requestLog());
  // Browser origin is the apex (21.gifts); the api still listens on api.21.gifts.
  // CORS covers the apex, transitional app.* aliases, and localhost. The
  // LNURL-auth callback is proxied at the apex so wallets pin linkingKeys there.
  // Bearer sessions + the X-Poll-Token are headers (no cookies), credentials off.
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Poll-Token'],
      maxAge: 86400,
    }),
  );

  app.route('/', brandRoutes({ read: readBrand }));
  app.route('/healthz', healthRoute);
  app.route('/info', infoRoute);
  app.route('/auth', authRoutes({ store, now, publicBaseUrl }));
  app.route('/me', meRoutes({ store, now, payer: invoicePayer, fetchImpl }));
  app.route(
    '/lightning-address',
    lightningAddressRoutes({ cache: lnAddressCache, now, fetchImpl }),
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
