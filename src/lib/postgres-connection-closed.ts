/**
 * Survive Bun SQL reporting that Postgres closed the connection.
 *
 * {@link sqlState} reads a five-character SQLSTATE and does not match
 * `ERR_POSTGRES_CONNECTION_CLOSED`. That helper classifies constraint
 * violations. This module keeps the process up.
 */
import { errorLogFields, logEvent } from '@/lib/log';

const POSTGRES_CONNECTION_CLOSED = 'ERR_POSTGRES_CONNECTION_CLOSED';

let installed = false;

function isPostgresConnectionClosed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'PostgresError' && candidate.code === POSTGRES_CONNECTION_CLOSED;
}

function noteConnectionClosed(error: unknown): void {
  try {
    logEvent('sql.connection.closed', errorLogFields(error));
  } catch {
    // A dead log sink must not turn a closed connection into a crash.
  }
}

function absorbConnectionClosed(error: unknown): boolean {
  if (!isPostgresConnectionClosed(error)) {
    return false;
  }
  noteConnectionClosed(error);
  return true;
}

function exitWithError(error: unknown): void {
  try {
    console.error(error);
  } catch {
    // A dead stderr must not leave another error running.
  }
  process.exit(1);
}

function onUncaughtException(error: Error): void {
  if (absorbConnectionClosed(error)) {
    return;
  }
  exitWithError(error);
}

function onUnhandledRejection(reason: unknown): void {
  if (absorbConnectionClosed(reason)) {
    return;
  }
  exitWithError(reason);
}

/**
 * Keep the process alive when Bun SQL reports a closed Postgres connection
 * as an uncaught exception or an unhandled rejection.
 *
 * A second call does nothing. Any other uncaught exception or unhandled
 * rejection is written to stderr and exits with status 1. Without that exit,
 * the listener would replace Bun's default and keep the process up. The
 * handler does not throw.
 *
 * @returns void
 */
export function installPostgresConnectionClosedGuard(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
}

/**
 * Call `open` until it resolves. A closed Postgres connection waits and
 * tries again. Any other rejection propagates, so a failed write is not
 * repeated.
 *
 * @param open - Produces the value to keep. Called again only after a closed connection.
 * @param wait - Receives `delayMs` between attempts. Tests pass a fake.
 * @param delayMs - Milliseconds to wait after a closed connection.
 * @returns The resolved value of `open`.
 */
export async function retryWhilePostgresConnectionClosed<T>(
  open: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
  delayMs: number,
): Promise<T> {
  for (;;) {
    try {
      return await open();
    } catch (error) {
      if (!isPostgresConnectionClosed(error)) {
        throw error;
      }
      noteConnectionClosed(error);
      await wait(delayMs);
    }
  }
}
