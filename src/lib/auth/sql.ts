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
