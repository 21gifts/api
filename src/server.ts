import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { healthRoute } from '@/routes/health';
import { infoRoute } from '@/routes/info';
import { authRoutes } from '@/routes/auth';
import { meRoutes } from '@/routes/me';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { AuthStore } from '@/lib/auth/store';
import { resolveAllowedOrigins } from '@/lib/config';

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
}

/**
 * Build a fully wired Hono application.
 *
 * Kept separate from the runtime entry point so tests can drive the handlers
 * via Hono's `app.request()` helper without binding to a TCP port. Every
 * wire-up change — middleware, routes, error handlers — flows through this
 * single factory so the test surface matches production exactly.
 *
 * @param deps - Optional overrides for the auth store, clock, and base URL.
 * @returns A Hono app with all routes and middleware attached.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const store = deps.authStore ?? new InMemoryAuthStore();
  const now = deps.now ?? Date.now;
  const publicBaseUrl = deps.publicBaseUrl ?? process.env['PUBLIC_BASE_URL'];
  const allowedOrigins = deps.allowedOrigins ?? resolveAllowedOrigins(process.env);

  const app = new Hono();

  app.use('*', logger());
  // The app is a separate-origin browser client (app.21.gifts -> api.21.gifts),
  // so cross-origin requests need CORS. Bearer sessions + the X-Poll-Token are
  // sent as headers (no cookies), so credentials are not enabled.
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Poll-Token'],
      maxAge: 86400,
    }),
  );

  app.route('/healthz', healthRoute);
  app.route('/info', infoRoute);
  app.route('/auth', authRoutes({ store, now, publicBaseUrl }));
  app.route('/me', meRoutes({ store, now }));

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
