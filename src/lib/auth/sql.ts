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

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * @param error - Caught driver error (node-postgres `code`, Bun SQL `errno`).
 * @returns Whether the error is SQLSTATE 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && (error as { code: unknown }).code === '23505') {
    return true;
  }
  if ('errno' in error && (error as { errno: unknown }).errno === '23505') {
    return true;
  }
  return false;
}
