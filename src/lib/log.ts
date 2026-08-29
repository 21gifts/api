import type { MiddlewareHandler } from 'hono';

/** JSON-serialisable event fields. No nested objects. */
export type LogFields = { readonly [key: string]: string | number | boolean };

/**
 * Write one operator-facing JSON line.
 *
 * Uses `console.warn` (CONTRIBUTING forbids `console.log`).
 * Always includes `ts` (ISO-8601) and `event`.
 *
 * @param event - Dotted event name, e.g. `auth.login.ok`.
 * @param fields - Extra fields; omit rather than passing empty strings unless the spec says otherwise.
 * @returns void
 */
export function logEvent(event: string, fields?: LogFields): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/**
 * Redact capability-URL path segments before request logging.
 *
 * A raw `/view/<secret>` would print the durable view key. Any single
 * segment after `/view/` becomes `/view/:viewKey`. Paths without a
 * segment, with extra segments, or unrelated routes are unchanged.
 *
 * @param path - Request path without the query string.
 * @returns Redacted path for `http.request` logs.
 */
export function requestLogPath(path: string): string {
  if (/^\/view\/[^/]+$/.test(path)) {
    return '/view/:viewKey';
  }
  return path;
}

/**
 * Hono middleware: one `http.request` event after the handler.
 * Skips `/healthz` and `OPTIONS`. Never includes the query string
 * (LNURL-pay callbacks would leak invoice query params). Redacts
 * `/view/<segment>` via {@link requestLogPath}.
 *
 * @returns Middleware that emits `http.request` with method, path, status, and ms.
 */
export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.method === 'OPTIONS' || c.req.path === '/healthz') {
      return;
    }
    logEvent('http.request', {
      method: c.req.method,
      path: requestLogPath(c.req.path),
      status: c.res.status,
      ms: Date.now() - started,
    });
  };
}
