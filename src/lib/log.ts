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

const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z]{1,40}$/;
const SAFE_DRIVER_FIELD_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Allowlisted scalar fields for a caught error, without any free text.
 *
 * Keeps `name` (ASCII letters, 1–40 characters) and string `code` / `errno`
 * (ASCII alphanumerics and underscores, 1–40 characters). The message is never
 * included: database and fetch errors can embed offending values or callback
 * URLs, and a length cut is not redaction.
 *
 * @param error - Caught value of any type.
 * @returns Fields safe to pass to {@link logEvent}; empty for values outside the allowlist.
 */
export function errorLogFields(error: unknown): LogFields {
  const fields: { [key: string]: string } = {};
  if (error instanceof Error && SAFE_ERROR_NAME_PATTERN.test(error.name)) {
    fields['name'] = error.name;
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; errno?: unknown };
    if (typeof candidate.code === 'string' && SAFE_DRIVER_FIELD_PATTERN.test(candidate.code)) {
      fields['code'] = candidate.code;
    }
    if (typeof candidate.errno === 'string' && SAFE_DRIVER_FIELD_PATTERN.test(candidate.errno)) {
      fields['errno'] = candidate.errno;
    }
  }
  return fields;
}

/**
 * Redact capability-URL path segments before request logging.
 *
 * A raw `/view/<secret>` would print the durable view key. The first
 * segment after `/view/` is replaced with `:viewKey`, including when a
 * trailing slash or extra segments follow. `/view` alone and unrelated
 * paths are unchanged.
 *
 * @param path - Request path without the query string.
 * @returns Redacted path for `http.request` logs.
 */
export function requestLogPath(path: string): string {
  return path.replace(/^\/view\/[^/]+/, '/view/:viewKey');
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
