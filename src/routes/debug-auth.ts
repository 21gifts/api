import { Hono } from 'hono';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import { OPERATOR_SIGNATURE_MAX_BYTES, type OperatorLogin } from '@/lib/operator-login';
import { readClientRequestMeta } from '@/lib/request-meta';

/** Largest accepted `POST /debug/auth` body, in bytes. */
export const DEBUG_AUTH_BODY_LIMIT_BYTES = 4096;

/** Challenges per client address and minute. */
export const DEBUG_AUTH_CHALLENGES_PER_MINUTE = 30;

/** Login attempts per client address and minute. */
export const DEBUG_AUTH_LOGINS_PER_MINUTE = 10;

/** Collaborators the operator login routes need. */
export interface DebugAuthRouteDeps {
  /** SSH key login. */
  operatorLogin: OperatorLogin;
  /** Clock (epoch milliseconds) for the rate limiters. */
  now: () => number;
  /** Optional injected challenge limiter. */
  challengeLimiter?: IpRateLimiter;
  /** Optional injected login limiter. */
  loginLimiter?: IpRateLimiter;
}

/** `{ challenge, signature }` from a parsed body, or `null`. */
function loginBody(value: unknown): { challenge: string; signature: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { challenge, signature } = value as Record<string, unknown>;
  if (typeof challenge !== 'string' || typeof signature !== 'string') {
    return null;
  }
  if (Buffer.byteLength(signature, 'utf8') > OPERATOR_SIGNATURE_MAX_BYTES) {
    return null;
  }
  return { challenge, signature };
}

/**
 * Build the operator login routes, mounted at `/debug/auth`.
 *
 * `GET /challenge` returns the challenge and its `expiresAt`. `POST /` takes
 * a JSON body with `challenge` and `signature` and returns `token`,
 * `operator`, `level`, `keyFingerprint`, and `expiresAt`. Both answer 503
 * `Operator login is not configured` when the allowed-signers files or the
 * namespace were not loaded, and 429 `Too many requests` past the
 * per-address limit. Every answer carries `Cache-Control: no-store`. A `POST`
 * refused before the signature check logs `debug.auth.login.refused` with
 * reason `not_configured`, `rate_limited`, `body_too_large`, or
 * `invalid_body`; later refusals are logged by `OperatorLogin.login`.
 *
 * @param deps - Login service, clock, and optional limiters.
 * @returns A Hono app serving `GET /challenge` and `POST /`.
 */
export function debugAuthRoutes(deps: DebugAuthRouteDeps): Hono {
  const challengeLimiter =
    deps.challengeLimiter ?? new IpRateLimiter(DEBUG_AUTH_CHALLENGES_PER_MINUTE);
  const loginLimiter = deps.loginLimiter ?? new IpRateLimiter(DEBUG_AUTH_LOGINS_PER_MINUTE);
  const login = deps.operatorLogin;
  // A login refused before the signature check: logged like the refusals of `OperatorLogin.login`.
  const refused = (reason: string): void => {
    logEvent('debug.auth.login.refused', { reason });
  };
  return new Hono()
    .use('*', async (c, next) => {
      await next();
      // Challenges are single use and tokens are credentials: no cache may keep or share them.
      c.res.headers.set('Cache-Control', 'no-store');
    })
    .get('/challenge', async (c) => {
      if (!login.configured) {
        return c.json({ error: 'Operator login is not configured' }, 503);
      }
      if (!challengeLimiter.allow(readClientRequestMeta(c.req.raw.headers).clientIp, deps.now())) {
        return c.json({ error: 'Too many requests' }, 429);
      }
      const issued = await login.issueChallenge();
      return c.json(
        { challenge: issued.challenge, expiresAt: new Date(issued.expiresAt).toISOString() },
        200,
      );
    })
    .post('/', async (c) => {
      if (!login.configured) {
        refused('not_configured');
        return c.json({ error: 'Operator login is not configured' }, 503);
      }
      if (!loginLimiter.allow(readClientRequestMeta(c.req.raw.headers).clientIp, deps.now())) {
        refused('rate_limited');
        return c.json({ error: 'Too many requests' }, 429);
      }
      const text = await readCappedText(c.req.raw, DEBUG_AUTH_BODY_LIMIT_BYTES);
      if (text === null) {
        refused('body_too_large');
        return c.json({ error: 'Request body is too large' }, 413);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      const body = loginBody(parsed);
      if (body === null) {
        refused('invalid_body');
        return c.json({ error: 'Invalid login' }, 400);
      }
      const result = await login.login(body.challenge, body.signature);
      if (!result.ok) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(
        {
          token: result.token,
          operator: result.grant.operator,
          level: result.grant.level,
          keyFingerprint: result.grant.keyFingerprint,
          expiresAt: new Date(result.expiresAt).toISOString(),
        },
        200,
      );
    });
}
