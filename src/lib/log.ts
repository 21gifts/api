import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
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

/** Printed in place of an email-shaped value, and of `address` when no key is set. */
const ADDRESS_MARKER = '[address]';
/** `local@domain.tld` anywhere in a value. Bounded repeats keep the scan linear. */
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}/g;
/** Hex characters of the HMAC kept as `addressRef`. */
const ADDRESS_REF_LENGTH = 12;

let addressRefKey: string | null = null;

/**
 * Install or clear the key that turns `address` into `addressRef` on the
 * console line of {@link logEvent}.
 *
 * The key is trimmed. `undefined`, `null`, and a blank value clear it; the
 * console line then prints the fixed marker `[address]` for `address`.
 *
 * @param key - Server secret (`SPEND_API_TOKEN`), or nothing to clear.
 * @returns void
 */
export function setAddressRefKey(key: string | null | undefined): void {
  const trimmed = key?.trim() ?? '';
  addressRefKey = trimmed === '' ? null : trimmed;
}

/**
 * Caller fields as the console line prints them. A string `address` becomes
 * `addressRef` (first 12 hex characters of HMAC-SHA256 over the lower-cased
 * value) or, without a key, the marker. Every other string has each
 * email-shaped part replaced by the marker.
 */
function consoleFields(fields: LogFields): LogFields {
  const out: { [key: string]: string | number | boolean } = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') {
      out[key] = value;
    } else if (key !== 'address') {
      out[key] = value.includes('@') ? value.replace(EMAIL_SHAPED, ADDRESS_MARKER) : value;
    } else if (addressRefKey === null) {
      out[key] = ADDRESS_MARKER;
    } else {
      out['addressRef'] = createHmac('sha256', addressRefKey)
        .update(value.toLowerCase())
        .digest('hex')
        .slice(0, ADDRESS_REF_LENGTH);
    }
  }
  return out;
}

/**
 * Write one operator-facing JSON line.
 *
 * Uses `console.warn` (CONTRIBUTING forbids `console.log`).
 * Always includes `ts` (ISO-8601) and `event`. The console line never carries
 * a Lightning Address: a string `address` field is printed as `addressRef`
 * (see {@link setAddressRefKey}), and an email-shaped part of any other
 * string field is printed as `[address]`. Request client fields are printed
 * unchanged. When a sink is set and this call is not already inside a sink,
 * the sink runs after the console line and receives the fields as passed,
 * including `address`. A throwing sink does not escape. A sink that calls
 * {@link logEvent} still prints, but does not re-enter the sink.
 *
 * @param event - Dotted event name, e.g. `auth.login.ok`.
 * @param fields - Extra fields; omit rather than passing empty strings unless the spec says otherwise.
 * @returns void
 */
export function logEvent(event: string, fields?: LogFields): void {
  const storedFields = requestClientFields.getStore();
  const merged = storedFields === undefined ? fields : { ...storedFields, ...fields };
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...storedFields,
      ...(fields === undefined ? undefined : consoleFields(fields)),
    }),
  );
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
