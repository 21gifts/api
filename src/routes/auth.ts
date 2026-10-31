import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { resolveWebAuthnConfig, type LnurlServerConfig } from '@/lib/config';
import {
  finishPasskeyAuthentication,
  finishPasskeyRecovery,
  finishPasskeyRegistration,
  finishPasskeySeed,
  RECOVERY_PENDING_ERROR,
  startPasskeyAuthentication,
  startPasskeyClaim,
  startPasskeyRecovery,
  startPasskeyRegistration,
  startPasskeySeed,
  type RecoveryBeginResult,
  type RecoveryFinishResult,
  type SessionAdmit,
} from '@/lib/auth/passkey';
import { serializeOwnerAccountWithPosts } from '@/lib/auth/account-json';
import { resolveSession } from '@/lib/auth/service';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import type { AuthStore } from '@/lib/auth/store';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import {
  APP_BUILD_HEADER,
  APP_OUTDATED_CODE,
  APP_OUTDATED_ERROR,
  appBuildAccepted,
  LOGINS_CLOSED_CODE,
  LOGINS_CLOSED_ERROR,
  type LoginGate,
} from '@/lib/login-gate';
import { errorLogFields, logEvent, type LogFields } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { LNURL_UNAVAILABLE_ERROR } from '@/lib/lnurl-server';
import type { MessageStore } from '@/lib/message-store';
import type { NostrKeygen } from '@/lib/nostr/keys';
import { readClientRequestMeta } from '@/lib/request-meta';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';
import { normalizeUsername } from '@/lib/username';
import { bearerToken } from '@/routes/me';

/**
 * Passkey (WebAuthn) HTTP surface. Login is passkey-only; LNURL-auth is gone.
 */

/** Collaborators the auth routes need. */
export interface AuthRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Forum persistence (live-post lookup and profile-note About me). */
  messages: Pick<MessageStore, 'accountHasLivePost' | 'getById'>;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Browser origins CORS already allows; passkey finish filters these by RP ID. */
  allowedOrigins: string[];
  /** Raw `WEBAUTHN_RP_ID`; `undefined` if unset (passkey routes 500). */
  webAuthnRpId: string | undefined;
  /** Optional `WEBAUTHN_RP_NAME` override. */
  webAuthnRpName: string | undefined;
  /** WebAuthn generate/verify collaborator. */
  passkeyCeremony: PasskeyCeremony;
  /** Optional KEK for custodial Nostr keys. */
  nostrKek?: Uint8Array;
  /** Optional keygen (tests). */
  nostrKeygen?: NostrKeygen;
  /**
   * Funding grants for owner JSON (default: empty {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
  /**
   * LNURL server config for the receiving address in owner JSON and for the
   * social recovery lookup; omitted → off (recovery begin answers 503).
   */
  lnurlServer?: LnurlServerConfig;
  /** Injected `fetch` for the LNURL server (default `globalThis.fetch`). */
  fetchImpl?: FetchFn;
  /**
   * Operator login switch. Omitted → every session-creating request passes.
   * Checked by register begin (new and claim), register finish, authenticate
   * finish, and recovery begin and finish before anything is written.
   */
  loginGate?: LoginGate;
  /**
   * Required app build (`APP_BUILD_REQUIRED`). `null` or omitted → no build
   * check. Checked first on register, authenticate, and recovery begin and finish.
   */
  requiredAppBuild?: string | null;
}

/** Body schema for passkey finish (registration or authentication). */
const passkeyFinishBody = z.object({
  challengeId: z.string(),
  credential: z.unknown(),
});

/** Body schema for social recovery begin. */
const recoveryBeginBody = z
  .object({
    sparkPubkey: z.string(),
    lookup: z
      .object({
        signature: z.string().regex(/^[0-9a-f]{16,144}$/),
        timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

/** Body schema for social recovery finish; `credential` must be present (checked separately). */
const recoveryFinishBody = z
  .object({
    challengeId: z.string(),
    credential: z.unknown(),
    newSparkPubkey: z.string(),
    signature: z.object({ pubkey: z.string(), signature: z.string() }).strict(),
  })
  .strict();

/** Real ceremony ids are 64 lowercase hex characters. Anything else is not logged. */
const LOGGED_CHALLENGE_ID = /^[0-9a-f]{64}$/;

function passkeyFailFields(
  challengeId: string,
  error: string,
): { error: string; challengeId?: string } {
  if (LOGGED_CHALLENGE_ID.test(challengeId)) {
    return { challengeId, error };
  }
  return { error };
}

const PASSKEY_FINISH_BODY_ERROR = 'Expected a JSON body with challengeId and credential';
const PASSKEY_FINISH_JSON_ERROR = 'Finish body is not valid JSON';
const PASSKEY_BEGIN_JSON_ERROR = 'Begin body is not valid JSON';
const SERVER_AUTH_UNCONFIGURED = 'Server auth is not configured';
const RECOVERY_BEGIN_BODY_ERROR = 'Expected a JSON body with sparkPubkey and lookup';
const RECOVERY_FINISH_BODY_ERROR =
  'Expected a JSON body with challengeId, credential, newSparkPubkey and signature';
const TOO_MANY_REQUESTS = 'Too many requests';

/** HTTP answer of each refused recovery begin. */
const RECOVERY_BEGIN_REFUSALS: Record<
  Extract<RecoveryBeginResult, { ok: false }>['reason'],
  { status: 403 | 404 | 409 | 503; body: { error: string; code?: string } }
> = {
  not_found: { status: 404, body: { error: 'Not found' } },
  done: {
    status: 409,
    body: {
      error: 'This account was already recovered. Sign in with the new passkey.',
      code: 'recovery_done',
    },
  },
  operator: {
    status: 409,
    body: { error: 'This account needs an operator to recover it', code: 'recovery_operator' },
  },
  wrong_account: { status: 403, body: { error: WRONG_ACCOUNT_ERROR } },
  logins_closed: { status: 503, body: { error: LOGINS_CLOSED_ERROR, code: LOGINS_CLOSED_CODE } },
  unavailable: { status: 503, body: { error: LNURL_UNAVAILABLE_ERROR } },
};

/** Recovery finish errors that answer 409; every other refusal is 400 unless mapped first. */
const RECOVERY_FINISH_CONFLICTS: readonly string[] = [
  'A recovery is already pending',
  'Wallet key is already in use',
];

/**
 * Challenge id from an untrusted finish body. Missing, non-object, and
 * non-string values are empty. The credential is never read.
 */
function challengeIdFromUnknown(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return '';
  }
  const challengeId = (body as { challengeId?: unknown }).challengeId;
  return typeof challengeId === 'string' ? challengeId : '';
}

/** `null`, `array`, or the JavaScript `typeof` name. No value is copied. */
function valueKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Shape of a parsed finish body. Kinds and booleans only. Never the
 * credential, the raw text, or a challenge id that is not 64 lowercase hex.
 */
function parsedBodyFields(body: unknown, bodyBytes: number): LogFields {
  const fields: { [key: string]: string | number | boolean } = {
    bodyBytes,
    json: 'parsed',
    bodyKind: valueKind(body),
  };
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as { credential?: unknown; challengeId?: unknown };
    fields['hasCredential'] = 'credential' in record;
    fields['challengeIdKind'] = 'challengeId' in record ? valueKind(record.challengeId) : 'absent';
  }
  return fields;
}

/** Empty text is absent. Invalid JSON is not parsed. The text is not returned. */
async function readJsonBody(req: {
  text: () => Promise<string>;
}): Promise<
  | { json: 'absent'; bodyBytes: number }
  | { json: 'invalid'; bodyBytes: number }
  | { json: 'parsed'; bodyBytes: number; value: unknown }
> {
  const text = await req.text();
  if (text.trim() === '') {
    return { json: 'absent', bodyBytes: text.length };
  }
  try {
    return { json: 'parsed', bodyBytes: text.length, value: JSON.parse(text) as unknown };
  } catch {
    return { json: 'invalid', bodyBytes: text.length };
  }
}

/**
 * Finish body, or a 400 reason. Invalid JSON stays distinct from a parsed
 * body that is not `{ challengeId, credential }`.
 */
async function readPasskeyFinish(req: {
  text: () => Promise<string>;
}): Promise<
  | { ok: true; challengeId: string; credential: unknown }
  | { ok: false; error: string; body?: unknown; extra: LogFields }
> {
  const read = await readJsonBody(req);
  if (read.json === 'absent') {
    return {
      ok: false,
      error: PASSKEY_FINISH_BODY_ERROR,
      body: null,
      extra: { bodyBytes: read.bodyBytes, json: 'absent' },
    };
  }
  if (read.json === 'invalid') {
    return {
      ok: false,
      error: PASSKEY_FINISH_JSON_ERROR,
      extra: { bodyBytes: read.bodyBytes, json: 'invalid' },
    };
  }
  const parsed = passkeyFinishBody.safeParse(read.value);
  // z.unknown() accepts a missing key, so a body with only challengeId still parses.
  const shape = parsedBodyFields(read.value, read.bodyBytes);
  if (!parsed.success || shape['hasCredential'] !== true) {
    return {
      ok: false,
      error: PASSKEY_FINISH_BODY_ERROR,
      body: read.value,
      extra: shape,
    };
  }
  return { ok: true, challengeId: parsed.data.challengeId, credential: parsed.data.credential };
}

/**
 * Recovery finish body with both wallet keys normalized, or a 400 reason.
 * Invalid JSON stays distinct from a parsed body of the wrong shape.
 */
async function readRecoveryFinish(req: { text: () => Promise<string> }): Promise<
  | {
      ok: true;
      challengeId: string;
      credential: unknown;
      newSparkPubkey: string;
      signature: { pubkey: string; signature: string };
    }
  | { ok: false; error: string; body?: unknown; extra: LogFields }
> {
  const read = await readJsonBody(req);
  if (read.json === 'absent') {
    return {
      ok: false,
      error: RECOVERY_FINISH_BODY_ERROR,
      body: null,
      extra: { bodyBytes: read.bodyBytes, json: 'absent' },
    };
  }
  if (read.json === 'invalid') {
    return {
      ok: false,
      error: PASSKEY_FINISH_JSON_ERROR,
      extra: { bodyBytes: read.bodyBytes, json: 'invalid' },
    };
  }
  const parsed = recoveryFinishBody.safeParse(read.value);
  // z.unknown() accepts a missing key, so `credential` is checked through the shape.
  const shape = parsedBodyFields(read.value, read.bodyBytes);
  const newSparkPubkey = parsed.success ? normalizeSparkPubkey(parsed.data.newSparkPubkey) : null;
  const pubkey = parsed.success ? normalizeSparkPubkey(parsed.data.signature.pubkey) : null;
  if (
    !parsed.success ||
    shape['hasCredential'] !== true ||
    newSparkPubkey === null ||
    pubkey === null
  ) {
    return { ok: false, error: RECOVERY_FINISH_BODY_ERROR, body: read.value, extra: shape };
  }
  return {
    ok: true,
    challengeId: parsed.data.challengeId,
    credential: parsed.data.credential,
    newSparkPubkey,
    signature: { pubkey, signature: parsed.data.signature.signature },
  };
}

/**
 * One diagnostic row for a passkey stop. A challenge id is kept only when
 * it is 64 lowercase hex. No credential, token, or raw body.
 */
function logPasskeyStop(
  event:
    | 'auth.passkey.login.fail'
    | 'auth.passkey.register.fail'
    | 'auth.passkey.seed.fail'
    | 'auth.passkey.recovery.fail'
    | 'auth.passkey.replace.refused',
  error: string,
  body?: unknown,
  accountId?: string,
  extra?: LogFields,
): void {
  logEvent(event, {
    ...passkeyFailFields(body === undefined ? '' : challengeIdFromUnknown(body), error),
    ...extra,
    ...(accountId !== undefined ? { accountId } : {}),
  });
}

/**
 * Record a seed-path passkey renew row. Unexported so it does not need a
 * handbook heading. Does not change the account row.
 */
async function recordPasskeySeedAttempt(
  deps: AuthRouteDeps,
  accountId: string,
  userAgent: string | undefined,
  stage: 'begin' | 'finish',
  outcome: 'failed' | 'succeeded',
  httpStatus: number | null,
  message: string | null,
): Promise<void> {
  await deps.store.insertPasskeyRenewAttempt({
    id: randomUUID(),
    accountId,
    createdAt: deps.now(),
    stage,
    outcome,
    errorName: null,
    errorCode: null,
    httpStatus,
    message,
    userAgent: userAgent ?? null,
  });
}

/**
 * Build check for one session-creating route: a missing or different
 * `X-App-Build` is 403 `app_outdated` before any other check.
 */
function requireAppBuild(deps: AuthRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!appBuildAccepted(deps.requiredAppBuild ?? null, c.req.header(APP_BUILD_HEADER))) {
      logEvent('auth.app.outdated', { path: c.req.path });
      return c.json({ error: APP_OUTDATED_ERROR, code: APP_OUTDATED_CODE }, 403);
    }
    await next();
  };
}

/** Login switch check handed to the passkey steps; `undefined` without a gate. */
function sessionAdmit(deps: AuthRouteDeps): SessionAdmit | undefined {
  const gate = deps.loginGate;
  return gate === undefined ? undefined : (account) => gate.admits(account);
}

/** 503 `logins_closed` response. */
function loginsClosed(c: Context): Response {
  return c.json({ error: LOGINS_CLOSED_ERROR, code: LOGINS_CLOSED_CODE }, 503);
}

/**
 * Build the `/auth` route group.
 *
 * @param deps - Shared store, message store, clock, passkey collaborators, and
 *   the LNURL server config and `fetch` of the social recovery lookup.
 * @returns A Hono app exposing passkey register, authenticate, replace, seed,
 *   and social recovery routes.
 */
export function authRoutes(deps: AuthRouteDeps): Hono {
  const buildCheck = requireAppBuild(deps);
  const recoveryBeginLimiter = new IpRateLimiter(30);
  const recoveryFinishLimiter = new IpRateLimiter(30);
  return new Hono()
    .use('/passkey/register/begin', buildCheck)
    .use('/passkey/register/finish', buildCheck)
    .use('/passkey/authenticate/begin', buildCheck)
    .use('/passkey/authenticate/finish', buildCheck)
    .use('/passkey/recovery/begin', buildCheck)
    .use('/passkey/recovery/finish', buildCheck)
    .post('/passkey/register/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.register.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const read = await readJsonBody(c.req);
      if (read.json === 'invalid') {
        logPasskeyStop(
          'auth.passkey.register.fail',
          PASSKEY_BEGIN_JSON_ERROR,
          undefined,
          undefined,
          { bodyBytes: read.bodyBytes, json: 'invalid' },
        );
        return c.json({ error: PASSKEY_BEGIN_JSON_ERROR }, 400);
      }
      const body = read.json === 'parsed' ? read.value : null;
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'viewKey' in body) {
        const viewKey = (body as { viewKey: unknown }).viewKey;
        if (typeof viewKey !== 'string') {
          const badViewKey = 'Expected a JSON body with an optional "viewKey" string';
          logPasskeyStop('auth.passkey.register.fail', badViewKey);
          return c.json({ error: badViewKey }, 400);
        }
        const claimed = await startPasskeyClaim(
          deps.store,
          deps.passkeyCeremony,
          config,
          deps.now(),
          viewKey,
          sessionAdmit(deps),
        );
        if (!claimed.ok) {
          logPasskeyStop('auth.passkey.register.fail', claimed.error);
          if (claimed.error === LOGINS_CLOSED_ERROR) {
            return loginsClosed(c);
          }
          const status = claimed.error === 'This profile already has a passkey' ? 409 : 404;
          return c.json({ error: claimed.error }, status);
        }
        return c.json(claimed.value, 200);
      }
      if (deps.loginGate !== undefined && !(await deps.loginGate.admits(null))) {
        logPasskeyStop('auth.passkey.register.fail', LOGINS_CLOSED_ERROR);
        return loginsClosed(c);
      }
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'name' in body) {
        const name = (body as { name: unknown }).name;
        if (typeof name !== 'string') {
          return c.json({ error: 'Expected a JSON body with an optional "name" string' }, 400);
        }
        const requestedName = normalizeUsername(name);
        if (requestedName === null) {
          return c.json(
            {
              error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
            },
            400,
          );
        }
        if ((await deps.store.getAccountByUsername(requestedName)) !== undefined) {
          return c.json({ error: 'Username is already in use' }, 409);
        }
        const started = await startPasskeyRegistration(
          deps.store,
          deps.passkeyCeremony,
          config,
          deps.now(),
          requestedName,
        );
        return c.json(started, 200);
      }
      const started = await startPasskeyRegistration(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
      );
      return c.json(started, 200);
    })
    .post('/passkey/register/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.register.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const read = await readPasskeyFinish(c.req);
      if (!read.ok) {
        logPasskeyStop('auth.passkey.register.fail', read.error, read.body, undefined, read.extra);
        return c.json({ error: read.error }, 400);
      }
      const result = await finishPasskeyRegistration(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        read.challengeId,
        read.credential,
        nostrOpts(deps),
        sessionAdmit(deps),
      );
      if (!result.ok) {
        logPasskeyStop('auth.passkey.register.fail', result.error, {
          challengeId: read.challengeId,
        });
        if (result.error === LOGINS_CLOSED_ERROR) {
          return loginsClosed(c);
        }
        const status =
          result.error === WRONG_ACCOUNT_ERROR
            ? 403
            : result.error === 'Username is already in use'
              ? 409
              : 400;
        return c.json({ error: result.error }, status);
      }
      logEvent('auth.passkey.register.ok', { accountId: result.value.account.id });
      return c.json(
        {
          token: result.value.token,
          account: await serializeOwnerAccountWithPosts(
            result.value.account,
            deps.messages,
            {
              store: deps.fundingStore ?? new InMemoryFundingStore(),
              nowMs: deps.now(),
              authStore: deps.store,
            },
            deps.lnurlServer,
          ),
        },
        200,
      );
    })
    .post('/passkey/authenticate/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.login.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const started = await startPasskeyAuthentication(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
      );
      return c.json(started, 200);
    })
    .post('/passkey/authenticate/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.login.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const read = await readPasskeyFinish(c.req);
      if (!read.ok) {
        logPasskeyStop('auth.passkey.login.fail', read.error, read.body, undefined, read.extra);
        return c.json({ error: read.error }, 400);
      }
      const result = await finishPasskeyAuthentication(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        read.challengeId,
        read.credential,
        nostrOpts(deps),
        sessionAdmit(deps),
      );
      if (!result.ok) {
        logPasskeyStop('auth.passkey.login.fail', result.error, {
          challengeId: read.challengeId,
        });
        if (result.error === LOGINS_CLOSED_ERROR) {
          return loginsClosed(c);
        }
        if (result.error === RECOVERY_PENDING_ERROR) {
          return c.json({ error: RECOVERY_PENDING_ERROR, code: 'recovery_pending' }, 409);
        }
        const status = result.error === WRONG_ACCOUNT_ERROR ? 403 : 400;
        return c.json({ error: result.error }, status);
      }
      logEvent('auth.passkey.login.ok', { accountId: result.value.account.id });
      return c.json(
        {
          token: result.value.token,
          account: await serializeOwnerAccountWithPosts(
            result.value.account,
            deps.messages,
            {
              store: deps.fundingStore ?? new InMemoryFundingStore(),
              nowMs: deps.now(),
              authStore: deps.store,
            },
            deps.lnurlServer,
          ),
        },
        200,
      );
    })
    .post('/passkey/recovery/begin', async (c) => {
      const stage = { stage: 'begin' };
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          SERVER_AUTH_UNCONFIGURED,
          undefined,
          undefined,
          stage,
        );
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const lnurlServer = deps.lnurlServer;
      if (lnurlServer === undefined) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          LNURL_UNAVAILABLE_ERROR,
          undefined,
          undefined,
          stage,
        );
        return c.json({ error: LNURL_UNAVAILABLE_ERROR }, 503);
      }
      const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
      if (!recoveryBeginLimiter.allow(clientIp, deps.now())) {
        return c.json({ error: TOO_MANY_REQUESTS }, 429);
      }
      const read = await readJsonBody(c.req);
      if (read.json === 'invalid') {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          PASSKEY_BEGIN_JSON_ERROR,
          undefined,
          undefined,
          {
            ...stage,
            bodyBytes: read.bodyBytes,
            json: 'invalid',
          },
        );
        return c.json({ error: PASSKEY_BEGIN_JSON_ERROR }, 400);
      }
      const parsed = read.json === 'parsed' ? recoveryBeginBody.safeParse(read.value) : null;
      const sparkPubkey =
        parsed?.success === true ? normalizeSparkPubkey(parsed.data.sparkPubkey) : null;
      if (parsed?.success !== true || sparkPubkey === null) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          RECOVERY_BEGIN_BODY_ERROR,
          undefined,
          undefined,
          {
            ...stage,
            bodyBytes: read.bodyBytes,
            json: read.json,
          },
        );
        return c.json({ error: RECOVERY_BEGIN_BODY_ERROR }, 400);
      }
      const admit = sessionAdmit(deps);
      let result: RecoveryBeginResult;
      try {
        result = await startPasskeyRecovery(
          {
            store: deps.store,
            ceremony: deps.passkeyCeremony,
            config,
            lnurlServer,
            fetchImpl: deps.fetchImpl ?? globalThis.fetch,
            now: deps.now,
            ...(admit === undefined ? {} : { admit }),
          },
          { sparkPubkey, lookup: parsed.data.lookup },
        );
      } catch (error) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          LNURL_UNAVAILABLE_ERROR,
          undefined,
          undefined,
          {
            ...stage,
            ...errorLogFields(error),
          },
        );
        return c.json({ error: LNURL_UNAVAILABLE_ERROR }, 503);
      }
      if (!result.ok) {
        // startPasskeyRecovery logs `operator` itself, with the account id.
        if (result.reason !== 'operator') {
          logPasskeyStop('auth.passkey.recovery.fail', result.reason, undefined, undefined, stage);
        }
        const refusal = RECOVERY_BEGIN_REFUSALS[result.reason];
        return c.json(refusal.body, refusal.status);
      }
      return c.json(
        {
          challengeId: result.challengeId,
          options: result.options,
          accountId: result.accountId,
          username: result.username,
        },
        200,
      );
    })
    .post('/passkey/recovery/finish', async (c) => {
      const stage = { stage: 'finish' };
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          SERVER_AUTH_UNCONFIGURED,
          undefined,
          undefined,
          stage,
        );
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const clientIp = readClientRequestMeta(c.req.raw.headers).clientIp;
      if (!recoveryFinishLimiter.allow(clientIp, deps.now())) {
        return c.json({ error: TOO_MANY_REQUESTS }, 429);
      }
      const read = await readRecoveryFinish(c.req);
      if (!read.ok) {
        logPasskeyStop('auth.passkey.recovery.fail', read.error, read.body, undefined, {
          ...stage,
          ...read.extra,
        });
        return c.json({ error: read.error }, 400);
      }
      const challengeBody = { challengeId: read.challengeId };
      const admit = sessionAdmit(deps);
      let result: RecoveryFinishResult;
      try {
        result = await finishPasskeyRecovery(
          {
            store: deps.store,
            ceremony: deps.passkeyCeremony,
            config,
            now: deps.now,
            ...(admit === undefined ? {} : { admit }),
          },
          {
            origin: c.req.header('origin'),
            challengeId: read.challengeId,
            credential: read.credential,
            newSparkPubkey: read.newSparkPubkey,
            signature: read.signature,
          },
        );
      } catch (error) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          LNURL_UNAVAILABLE_ERROR,
          challengeBody,
          undefined,
          {
            ...stage,
            ...errorLogFields(error),
          },
        );
        return c.json({ error: LNURL_UNAVAILABLE_ERROR }, 503);
      }
      if (!result.ok) {
        logPasskeyStop(
          'auth.passkey.recovery.fail',
          result.error,
          challengeBody,
          result.accountId,
          stage,
        );
        if (result.error === LOGINS_CLOSED_ERROR) {
          return loginsClosed(c);
        }
        const status =
          result.error === WRONG_ACCOUNT_ERROR
            ? 403
            : RECOVERY_FINISH_CONFLICTS.includes(result.error)
              ? 409
              : 400;
        return c.json({ error: result.error }, status);
      }
      return c.json({ status: 'pending' }, 200);
    })
    .post('/passkey/replace/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.replace.refused', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('auth.passkey.replace.refused', { accountId: account.id });
      return c.json({ error: 'A recovery phrase cannot be replaced' }, 409);
    })
    .post('/passkey/replace/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.replace.refused', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('auth.passkey.replace.refused', { accountId: account.id });
      return c.json({ error: 'A recovery phrase cannot be replaced' }, 409);
    })
    .post('/passkey/seed/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.seed.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const started = await startPasskeySeed(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        account,
      );
      if (!('challengeId' in started)) {
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          c.req.header('user-agent'),
          'begin',
          'failed',
          409,
          started.error,
        );
        return c.json({ error: started.error }, 409);
      }
      return c.json(started, 200);
    })
    .post('/passkey/seed/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        logPasskeyStop('auth.passkey.seed.fail', SERVER_AUTH_UNCONFIGURED);
        return c.json({ error: SERVER_AUTH_UNCONFIGURED }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const userAgent = c.req.header('user-agent');
      if (account.walletRequired === true) {
        const alreadyHasPhrase = 'This account already has a recovery phrase';
        logEvent('auth.passkey.seed.fail', {
          accountId: account.id,
          error: alreadyHasPhrase,
        });
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          409,
          alreadyHasPhrase,
        );
        return c.json({ error: alreadyHasPhrase }, 409);
      }
      const read = await readPasskeyFinish(c.req);
      if (!read.ok) {
        logPasskeyStop('auth.passkey.seed.fail', read.error, read.body, account.id, read.extra);
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          400,
          read.error,
        );
        return c.json({ error: read.error }, 400);
      }
      const result = await finishPasskeySeed(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        read.challengeId,
        read.credential,
        account,
      );
      if (!result.ok) {
        logPasskeyStop(
          'auth.passkey.seed.fail',
          result.error,
          { challengeId: read.challengeId },
          account.id,
        );
        const status = result.error === 'This account already has a recovery phrase' ? 409 : 400;
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          status,
          result.error,
        );
        return c.json({ error: result.error }, status);
      }
      await recordPasskeySeedAttempt(
        deps,
        result.account.id,
        userAgent,
        'finish',
        'succeeded',
        null,
        null,
      );
      await deps.store.acknowledgePasskeyRenewFailures(result.account.id, deps.now());
      logEvent('auth.passkey.seed.ok', { accountId: result.account.id });
      return c.json(
        await serializeOwnerAccountWithPosts(
          result.account,
          deps.messages,
          {
            store: deps.fundingStore ?? new InMemoryFundingStore(),
            nowMs: deps.now(),
            authStore: deps.store,
          },
          deps.lnurlServer,
        ),
        200,
      );
    });
}

/**
 * Optional Nostr keygen collaborators for passkey finish.
 *
 * @param deps - Auth route deps.
 * @returns KEK payload, or `undefined` when no KEK is configured.
 */
function nostrOpts(deps: AuthRouteDeps): { kek: Uint8Array; keygen?: NostrKeygen } | undefined {
  if (deps.nostrKek === undefined) {
    return undefined;
  }
  /* v8 ignore start -- optional test-only nostrKeygen injection */
  return deps.nostrKeygen === undefined
    ? { kek: deps.nostrKek }
    : { kek: deps.nostrKek, keygen: deps.nostrKeygen };
  /* v8 ignore stop */
}

/**
 * Resolve WebAuthn config for this request, or `null` when the RP ID is missing
 * or no CORS origin matches it.
 *
 * @param deps - Auth route collaborators.
 * @returns Runtime config, or `null`.
 */
function webAuthnConfig(deps: AuthRouteDeps): ReturnType<typeof resolveWebAuthnConfig> {
  return resolveWebAuthnConfig(
    {
      WEBAUTHN_RP_ID: deps.webAuthnRpId,
      WEBAUTHN_RP_NAME: deps.webAuthnRpName,
    },
    deps.allowedOrigins,
  );
}
