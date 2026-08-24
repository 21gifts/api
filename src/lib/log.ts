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
 * Hono middleware: one `http.request` event after the handler.
 * Skips `/healthz` and `OPTIONS`. Never includes the query string
 * (LNURL-pay callbacks would leak invoice query params).
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
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    });
  };
}
