import type { Context, MiddlewareHandler, Next } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import type { OperatorLogin } from '@/lib/operator-login';

/** Operator level a debug route declares. A higher level includes the lower ones. */
export type OperatorLevel = 'read' | 'write' | 'admin';

/** Every operator level, lowest first. */
export const OPERATOR_LEVELS: readonly OperatorLevel[] = ['read', 'write', 'admin'];

/**
 * Operator credentials a route accepts.
 *
 * `debugToken` is `DEBUG_TOKEN` and grants `admin`. `operatorLogin` checks
 * the short-lived tokens of the SSH key login; each grants its own level.
 */
export interface OperatorTokens {
  /** Operator token, or `undefined` when unset. */
  debugToken?: string | undefined;
  /** SSH key login, or `undefined` when the route does not accept key tokens. */
  operatorLogin?: OperatorLogin | undefined;
}

/** Outcome of an operator check that did not pass. */
export type OperatorRefusal = 'unconfigured' | 'unauthorized' | 'forbidden';

/** Options for {@link requireOperator}. */
export interface RequireOperatorOptions {
  /**
   * Runs instead of the refusal when the bearer passes no operator check.
   * `refuse` builds the response the middleware would otherwise send.
   */
  onRefused?: (c: Context, next: Next, refuse: () => Response) => Promise<Response | void>;
}

/** Property under which a {@link requireOperator} middleware carries its declared level. */
export const OPERATOR_LEVEL: unique symbol = Symbol('operatorLevel');

/**
 * Whether an `Authorization` header passes the operator check for `level`.
 *
 * `DEBUG_TOKEN` (trimmed) is tried first and grants `admin`. A key token of
 * the SSH key login grants the level it was issued with, while its operator
 * is still listed at that level. Neither `DEBUG_TOKEN` nor a loaded key login
 * → `unconfigured`. A key token below `level` → `forbidden`. Any other bearer
 * → `unauthorized`.
 *
 * @param level - Required operator level.
 * @param tokens - Operator credentials the route accepts.
 * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
 * @returns `true` when the granted level is at least `level`, otherwise the refusal.
 */
export async function checkOperator(
  level: OperatorLevel,
  tokens: OperatorTokens,
  authorizationHeader: string | undefined,
): Promise<true | OperatorRefusal> {
  const write = (tokens.debugToken ?? '').trim();
  const login = tokens.operatorLogin?.configured === true ? tokens.operatorLogin : undefined;
  if (write === '' && login === undefined) {
    return 'unconfigured';
  }
  if (write !== '' && bearerMatchesDebugToken(write, authorizationHeader)) {
    return true;
  }
  const grant = login === undefined ? null : await login.resolveBearer(authorizationHeader);
  if (grant === null) {
    return 'unauthorized';
  }
  return OPERATOR_LEVELS.indexOf(grant.level) >= OPERATOR_LEVELS.indexOf(level)
    ? true
    : 'forbidden';
}

/**
 * Hono middleware that declares and enforces the operator level of a route.
 *
 * Checks `tokens` on every request. A pass calls `next`. Otherwise it answers
 * 503 `{ error: 'Debug is not configured' }` when no credential is
 * configured, 403 `{ error: 'Forbidden' }` for a key token below `level`, and
 * 401 `{ error: 'Unauthorized' }` for any other bearer, or hands that answer
 * to `options.onRefused`.
 *
 * @param level - Operator level the route declares.
 * @param tokens - Operator credentials the route accepts.
 * @param options - Optional `onRefused` path.
 * @returns The middleware, carrying `level` under {@link OPERATOR_LEVEL}.
 */
export function requireOperator(
  level: OperatorLevel,
  tokens: OperatorTokens,
  options: RequireOperatorOptions = {},
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (c, next) => {
    const result = await checkOperator(level, tokens, c.req.header('authorization'));
    if (result === true) {
      await next();
      return;
    }
    const refuse = (): Response => {
      if (result === 'unconfigured') {
        return c.json({ error: 'Debug is not configured' }, 503);
      }
      return result === 'forbidden'
        ? c.json({ error: 'Forbidden' }, 403)
        : c.json({ error: 'Unauthorized' }, 401);
    };
    if (options.onRefused !== undefined) {
      return options.onRefused(c, next, refuse);
    }
    return refuse();
  };
  return Object.assign(middleware, { [OPERATOR_LEVEL]: level });
}
