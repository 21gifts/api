import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';
import type { ApiLogStore } from '@/lib/api-log';
import type { AuthStore } from '@/lib/auth/store';
import { resolveRequestAuth } from '@/lib/request-auth';
import { presentClientFields, readClientRequestMeta } from '@/lib/request-meta';

/** JSON-serialisable event fields. No nested objects. */
export type LogFields = { readonly [key: string]: string | number | boolean };

/** Optional persistence hook for {@link logEvent}. Must not be the store itself. */
export type DiagnosticSink = (event: string, fields: LogFields | undefined) => void;

let diagnosticSink: DiagnosticSink | null = null;
let diagnosticSinkDepth = 0;
const requestClientFields = new AsyncLocalStorage<ReturnType<typeof presentClientFields>>();

/**
 * Install or clear the diagnostic persistence hook used by {@link logEvent}.
 *
 * @param next - Sink to call after the console line, or `null` to disable.
 * @returns void
 */
export function setDiagnosticSink(next: DiagnosticSink | null): void {
  diagnosticSink = next;
}

/**
 * Write one operator-facing JSON line.
 *
 * Uses `console.warn` (CONTRIBUTING forbids `console.log`).
 * Always includes `ts` (ISO-8601) and `event`. When a sink is set and this
 * call is not already inside a sink, the sink runs after the console line.
 * A throwing sink does not escape. A sink that calls {@link logEvent} still
 * prints, but does not re-enter the sink.
 *
 * @param event - Dotted event name, e.g. `auth.login.ok`.
 * @param fields - Extra fields; omit rather than passing empty strings unless the spec says otherwise.
 * @returns void
 */
export function logEvent(event: string, fields?: LogFields): void {
  const storedFields = requestClientFields.getStore();
  const merged = storedFields === undefined ? fields : { ...storedFields, ...fields };
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event, ...merged }));
  if (diagnosticSink === null || diagnosticSinkDepth !== 0) {
    return;
  }
  diagnosticSinkDepth += 1;
  try {
    diagnosticSink(event, merged);
  } catch {
    // Sink failures must not escape logEvent.
  } finally {
    diagnosticSinkDepth -= 1;
  }
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

/** Collaborators {@link requestLog} needs to persist `api_log` rows. */
export interface RequestLogDeps {
  /** HTTP audit log persistence. */
  apiLogStore: ApiLogStore;
  /** Auth persistence for session classification. */
  authStore: AuthStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Spend-worker shared secret, or `undefined` when spend auth is disabled. */
  spendApiToken: string | undefined;
  /** Clock returning epoch milliseconds (default: `Date.now`). */
  now?: () => number;
}

/**
 * Hono middleware: one `http.request` event after the handler, then one
 * `api_log` row. Skips `/healthz` and `OPTIONS` (stdout and store). Never
 * includes the query string, body, Authorization, or tokens. Redacts
 * `/view/<segment>` via {@link requestLogPath}. A store write failure logs
 * `api_log.write.failed` and does not replace the response.
 *
 * @param deps - Audit store, auth store, tokens, and optional clock.
 * @returns Middleware that emits `http.request` with method, path, status, and ms.
 */
export function requestLog(deps: RequestLogDeps): MiddlewareHandler {
  return async (c, next) => {
    const meta = readClientRequestMeta(c.req.raw.headers);
    return requestClientFields.run(presentClientFields(meta), async () => {
      const started = Date.now();
      await next();
      if (c.req.method === 'OPTIONS' || c.req.path === '/healthz') {
        return;
      }
      const ms = Date.now() - started;
      logEvent('http.request', {
        method: c.req.method,
        path: requestLogPath(c.req.path),
        status: c.res.status,
        ms,
      });
      const clock = deps.now ?? Date.now;
      let accountId: string | null = null;
      let authKind: 'session' | 'debug' | 'spend' | 'none' = 'none';
      try {
        const auth = await resolveRequestAuth({
          authorizationHeader: c.req.header('authorization'),
          debugToken: deps.debugToken,
          spendApiToken: deps.spendApiToken,
          authStore: deps.authStore,
          now: clock(),
        });
        accountId = auth.accountId;
        authKind = auth.authKind;
      } catch {
        accountId = null;
        authKind = 'none';
      }
      try {
        await deps.apiLogStore.append({
          id: crypto.randomUUID(),
          createdAt: new Date(clock()),
          method: c.req.method,
          path: requestLogPath(c.req.path),
          status: c.res.status,
          ms,
          accountId,
          authKind,
          clientIp: meta.clientIp,
          clientCountry: meta.clientCountry,
          cfRay: meta.cfRay,
          userAgent: meta.userAgent,
          acceptLanguage: meta.acceptLanguage,
          origin: meta.origin,
        });
      } catch {
        logEvent('api_log.write.failed');
      }
    });
  };
}
