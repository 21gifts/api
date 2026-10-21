import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDiagnosticSink } from '@/lib/log';
import {
  installPostgresConnectionClosedGuard,
  retryWhilePostgresConnectionClosed,
} from '@/lib/postgres-connection-closed';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function closedError(message = 'Connection closed'): Error {
  return Object.assign(new Error(message), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_CONNECTION_CLOSED',
  });
}

describe('postgres connection closed', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;
  let uncaught: NodeJS.UncaughtExceptionListener | undefined;
  let rejection: NodeJS.UnhandledRejectionListener | undefined;

  beforeAll(() => {
    const uncaughtBefore = new Set(process.listeners('uncaughtException'));
    const rejectionBefore = new Set(process.listeners('unhandledRejection'));
    installPostgresConnectionClosedGuard();
    uncaught = process
      .listeners('uncaughtException')
      .find((listener) => !uncaughtBefore.has(listener));
    rejection = process
      .listeners('unhandledRejection')
      .find((listener) => !rejectionBefore.has(listener));
  });

  beforeEach(() => {
    setDiagnosticSink(null);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('exit');
    });
  });

  afterEach(() => {
    warn.mockRestore();
    exit.mockRestore();
    setDiagnosticSink(null);
  });

  afterAll(() => {
    if (uncaught !== undefined) {
      process.removeListener('uncaughtException', uncaught);
    }
    if (rejection !== undefined) {
      process.removeListener('unhandledRejection', rejection);
    }
  });

  function emitUncaught(error: Error): void {
    if (uncaught === undefined) {
      throw new Error('uncaught listener missing');
    }
    uncaught(error);
  }

  function emitRejection(reason: unknown): void {
    if (rejection === undefined) {
      throw new Error('rejection listener missing');
    }
    rejection(reason, Promise.resolve());
  }

  it('installs each listener once', () => {
    const uncaughtBefore = process.listenerCount('uncaughtException');
    const rejectionBefore = process.listenerCount('unhandledRejection');
    installPostgresConnectionClosedGuard();
    expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore);
    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore);
    expect(uncaught).toBeTypeOf('function');
    expect(rejection).toBeTypeOf('function');
  });

  it('logs a closed connection and does not exit', () => {
    emitUncaught(closedError('secret-fragment'));
    expect(exit).not.toHaveBeenCalled();
    const events = parsedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'sql.connection.closed',
      name: 'PostgresError',
      code: 'ERR_POSTGRES_CONNECTION_CLOSED',
    });
    expect(JSON.stringify(events[0])).not.toContain('secret-fragment');
  });

  it('logs a plain closed-connection object without exiting', () => {
    emitUncaught({
      name: 'PostgresError',
      code: 'ERR_POSTGRES_CONNECTION_CLOSED',
    } as unknown as Error);
    expect(exit).not.toHaveBeenCalled();
    expect(parsedEvents(warn)[0]).toMatchObject({
      event: 'sql.connection.closed',
      code: 'ERR_POSTGRES_CONNECTION_CLOSED',
    });
  });

  it('stays up when logging the closed connection throws', () => {
    warn.mockImplementation(() => {
      throw new Error('console down');
    });
    expect(() => {
      emitUncaught(closedError());
    }).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits on any other uncaught exception', () => {
    expect(() => {
      emitUncaught(new Error('schema'));
    }).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(parsedEvents(warn)).toHaveLength(0);
  });

  it('exits when the uncaught value is not a closed connection', () => {
    expect(() => {
      emitUncaught('down' as unknown as Error);
    }).toThrow('exit');
    expect(() => {
      emitUncaught(null as unknown as Error);
    }).toThrow('exit');
    expect(() => {
      emitUncaught(
        Object.assign(new Error('unique'), { name: 'PostgresError', code: '23505' }),
      );
    }).toThrow('exit');
    expect(() => {
      emitUncaught(
        Object.assign(new Error('pipe'), {
          name: 'Error',
          code: 'ERR_POSTGRES_CONNECTION_CLOSED',
        }),
      );
    }).toThrow('exit');
  });

  it('logs an unhandled closed connection and does not exit', () => {
    emitRejection(closedError());
    expect(exit).not.toHaveBeenCalled();
    expect(parsedEvents(warn)[0]?.['event']).toBe('sql.connection.closed');
  });

  it('does not exit on an unrelated unhandled rejection', () => {
    emitRejection(new Error('other'));
    emitRejection('other');
    emitRejection(null);
    expect(exit).not.toHaveBeenCalled();
    expect(parsedEvents(warn)).toHaveLength(0);
  });

  it('returns the first successful open without waiting', async () => {
    const wait = vi.fn(async () => undefined);
    const open = vi.fn(async () => 'up');
    await expect(retryWhilePostgresConnectionClosed(open, wait, 1000)).resolves.toBe('up');
    expect(open).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits and retries only a closed connection', async () => {
    const wait = vi.fn(async () => undefined);
    const open = vi.fn(async (): Promise<string> => 'up');
    open.mockReset();
    open.mockRejectedValueOnce(closedError('secret-fragment'));
    open.mockResolvedValueOnce('up');
    await expect(retryWhilePostgresConnectionClosed(open, wait, 1000)).resolves.toBe('up');
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(1000);
    expect(open).toHaveBeenCalledTimes(2);
    const events = parsedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]?.['event']).toBe('sql.connection.closed');
    expect(JSON.stringify(events[0])).not.toContain('secret-fragment');
  });

  it('retries when logging the closed connection throws', async () => {
    warn.mockImplementation(() => {
      throw new Error('console down');
    });
    const wait = vi.fn(async () => undefined);
    const open = vi.fn(async (): Promise<string> => 'up');
    open.mockReset();
    open.mockRejectedValueOnce(closedError());
    open.mockResolvedValueOnce('up');
    await expect(retryWhilePostgresConnectionClosed(open, wait, 25)).resolves.toBe('up');
    expect(wait).toHaveBeenCalledWith(25);
  });

  it('propagates any other open failure without waiting', async () => {
    const wait = vi.fn(async () => undefined);
    const boom = new Error('schema');
    const open = vi.fn(async () => {
      throw boom;
    });
    await expect(retryWhilePostgresConnectionClosed(open, wait, 1000)).rejects.toBe(boom);
    expect(wait).not.toHaveBeenCalled();
    expect(parsedEvents(warn)).toHaveLength(0);
  });
});
