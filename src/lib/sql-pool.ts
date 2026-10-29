/** Milliseconds. Postgres reads a unitless startup value as milliseconds. */
export const LOG_STATEMENT_TIMEOUT_MS = '5000';

/** Milliseconds. Postgres reads a unitless startup value as milliseconds. */
export const LOG_LOCK_TIMEOUT_MS = '2000';

/** Connections reserved for `api_log` and `diagnostic_event`, apart from request queries. */
export const LOG_POOL_MAX = 4;

/** Options for the log pool passed to Bun `SQL`. */
export interface LogPoolOptions {
  /** Maximum connections in the log pool. */
  readonly max: number;
  /** Postgres startup parameters applied to every connection in this pool. */
  readonly connection: {
    /** Aborts a log statement that runs longer than this. */
    readonly statement_timeout: string;
    /** Aborts a log statement that waits on a lock longer than this. */
    readonly lock_timeout: string;
    /** Session name visible on the database side. */
    readonly application_name: string;
  };
}

/**
 * Pool options for the `api_log` and `diagnostic_event` client.
 *
 * `connection` values are Postgres startup parameters, so they bind every
 * connection of this pool. Request queries and boot migrations use a different
 * client and are not limited by these timeouts. A stuck log insert then ends
 * and returns its connection, and it cannot occupy a request connection.
 *
 * @returns Options for `new SQL(databaseUrl, options)`.
 */
export function logPoolOptions(): LogPoolOptions {
  return {
    max: LOG_POOL_MAX,
    connection: {
      statement_timeout: LOG_STATEMENT_TIMEOUT_MS,
      lock_timeout: LOG_LOCK_TIMEOUT_MS,
      application_name: '21gifts-api-log',
    },
  };
}
