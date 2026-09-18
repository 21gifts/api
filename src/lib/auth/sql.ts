/**
 * Narrow SQL port so {@link PostgresAuthStore} can be unit-tested with a mock.
 * The Bun adapter lives in the process boot path (`src/index.ts`).
 */

/** Parameter-bound SQL executor. Identifiers are never interpolated. */
export interface SqlClient {
  /**
   * Run a parameterised query and return rows.
   *
   * @param text - SQL with `$1`, `$2`, … placeholders.
   * @param params - Bound values, in order.
   * @returns Result rows.
   */
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Run a parameterised statement, ignoring any rows.
   *
   * @param text - SQL with `$1`, `$2`, … placeholders.
   * @param params - Bound values, in order.
   */
  execute(text: string, params?: readonly unknown[]): Promise<void>;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Read a five-character SQLSTATE from a caught driver error.
 *
 * A numeric `errno` marks a Node system error (`{ errno: -32, code: 'EPIPE' }`),
 * never a Postgres one, and yields `null`.
 *
 * @param error - Caught driver error (Bun SQL `errno`, node-postgres `code`).
 * @returns The SQLSTATE, preferring Bun SQL `errno`, or `null` when absent.
 */
export function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as { code?: unknown; errno?: unknown };
  // Node system errors carry a numeric errno and a word-like code (`EPIPE`) that would fit the pattern.
  if (typeof candidate.errno === 'number') {
    return null;
  }
  if (typeof candidate.errno === 'string' && SQLSTATE_PATTERN.test(candidate.errno)) {
    return candidate.errno;
  }
  if (typeof candidate.code === 'string' && SQLSTATE_PATTERN.test(candidate.code)) {
    return candidate.code;
  }
  return null;
}

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * @param error - Caught driver error (Bun SQL `errno`, node-postgres `code`).
 * @returns Whether the error is SQLSTATE 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === '23505';
}
