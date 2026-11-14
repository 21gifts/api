import type { Context, MiddlewareHandler, Next } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';

/** Operator level a debug route declares. A higher level includes the lower ones. */
export type OperatorLevel = 'read' | 'write' | 'admin';

/**
 * Operator tokens a route accepts.
 *
 * `debugToken` is `DEBUG_TOKEN`. `debugReadToken` is `DEBUG_READ_TOKEN`; a
 * route accepts it only when its route group is given that token.
 */
export interface OperatorTokens {
  /** Operator write token, or `undefined` when unset. */
  debugToken?: string | undefined;
  /** Operator read token, or `undefined` when the route does not accept it. */
  debugReadToken?: string | undefined;
}

/** Outcome of an operator check that did not pass. */
export type OperatorRefusal = 'unconfigured' | 'unauthorized';

/** Options for {@link requireOperator}. */
export interface RequireOperatorOptions {
  /**
   * Runs instead of the refusal when the bearer passes no operator check.
   * `refuse` builds the response the middleware would otherwise send.
   */
  onRefused?: (c: Context, next: Next, refuse: () => Response) => Promise<Response | void>;
}

const LEVEL_RANK: Record<OperatorLevel, number> = { read: 0, write: 1, admin: 2 };

/** Property under which a {@link requireOperator} middleware carries its declared level. */
export const OPERATOR_LEVEL: unique symbol = Symbol('operatorLevel');

/**
 * Level the operator tokens grant to an `Authorization` header.
 *
 * Trim both tokens. Both empty → `unconfigured`. The write token is tried
 * first and grants `admin`; the read token grants `read`. A configured token
 * that does not match is `unauthorized`.
 *
 * @param tokens - Operator tokens the route accepts.
 * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
 * @returns The granted level, or why none is granted.
 */
function operatorGrant(
  tokens: OperatorTokens,
  authorizationHeader: string | undefined,
): OperatorLevel | OperatorRefusal {
  const write = (tokens.debugToken ?? '').trim();
  const read = (tokens.debugReadToken ?? '').trim();
  if (write === '' && read === '') {
    return 'unconfigured';
  }
  if (write !== '' && bearerMatchesDebugToken(write, authorizationHeader)) {
    return 'admin';
  }
  if (read !== '' && bearerMatchesDebugToken(read, authorizationHeader)) {
    return 'read';
  }
  return 'unauthorized';
}

/**
 * Whether an `Authorization` header passes the operator check for `level`.
 *
 * @param level - Required operator level.
 * @param tokens - Operator tokens the route accepts.
 * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
 * @returns `true` when the granted level is at least `level`, otherwise the refusal.
 */
export function checkOperator(
  level: OperatorLevel,
  tokens: OperatorTokens,
  authorizationHeader: string | undefined,
): true | OperatorRefusal {
  const granted = operatorGrant(tokens, authorizationHeader);
  if (granted === 'unconfigured' || granted === 'unauthorized') {
    return granted;
  }
  return LEVEL_RANK[granted] >= LEVEL_RANK[level] ? true : 'unauthorized';
}

/**
 * Hono middleware that declares and enforces the operator level of a route.
 *
 * Reads `tokens` on every request. A pass calls `next`. Otherwise it answers
 * 503 `{ error: 'Debug is not configured' }` when no token is configured and
 * 401 `{ error: 'Unauthorized' }` for any other bearer, or hands that answer
 * to `options.onRefused`.
 *
 * @param level - Operator level the route declares.
 * @param tokens - Operator tokens the route accepts.
 * @param options - Optional `onRefused` path.
 * @returns The middleware, carrying `level` under {@link OPERATOR_LEVEL}.
 */
export function requireOperator(
  level: OperatorLevel,
  tokens: OperatorTokens,
  options: RequireOperatorOptions = {},
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (c, next) => {
    const result = checkOperator(level, tokens, c.req.header('authorization'));
    if (result === true) {
      await next();
      return;
    }
    const refuse = (): Response =>
      result === 'unconfigured'
        ? c.json({ error: 'Debug is not configured' }, 503)
        : c.json({ error: 'Unauthorized' }, 401);
    if (options.onRefused !== undefined) {
      return options.onRefused(c, next, refuse);
    }
    return refuse();
  };
  return Object.assign(middleware, { [OPERATOR_LEVEL]: level });
}
