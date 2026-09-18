import { describe, it, expect } from 'vitest';
import { isUniqueViolation, sqlState, type SqlClient } from '@/lib/auth/sql';

describe('SqlClient', () => {
  it('is implemented by a parameter-bound mock', async () => {
    const client: SqlClient = {
      query: async <T>(_text: string, _params?: readonly unknown[]): Promise<T[]> =>
        [{ n: 1 }] as T[],
      execute: async () => undefined,
    };
    expect(await client.query<{ n: number }>('SELECT 1')).toEqual([{ n: 1 }]);
    await expect(client.execute('SELECT 1')).resolves.toBeUndefined();
  });
});

describe('isUniqueViolation', () => {
  it('is true for node-postgres code 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is true for Bun SQL errno 23505', () => {
    expect(isUniqueViolation({ errno: '23505' })).toBe(true);
  });

  it('is true for the measured Bun SQL server-error shape', () => {
    expect(isUniqueViolation({ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '23505' })).toBe(true);
  });

  it('is true when both code and errno are 23505', () => {
    expect(isUniqueViolation({ code: '23505', errno: '23505' })).toBe(true);
  });

  it('is false for ERR_POSTGRES_SERVER_ERROR without errno', () => {
    expect(isUniqueViolation({ code: 'ERR_POSTGRES_SERVER_ERROR' })).toBe(false);
  });

  it('is false for other SQLSTATE codes', () => {
    expect(isUniqueViolation({ code: '57014' })).toBe(false);
    expect(isUniqueViolation({ errno: '23503' })).toBe(false);
  });

  it('is false for non-objects', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
  });
});

describe('sqlState', () => {
  it('prefers a valid Bun SQL errno over node-postgres code', () => {
    expect(sqlState({ code: '22P02', errno: '23505' })).toBe('23505');
  });

  it('reads a valid node-postgres code', () => {
    expect(sqlState({ code: '22P02' })).toBe('22P02');
  });

  it('falls back to code when errno is not a valid SQLSTATE', () => {
    expect(sqlState({ code: '22P02', errno: -1 })).toBe('22P02');
    expect(sqlState({ code: '22P02', errno: '22P0' })).toBe('22P02');
  });

  it('returns null for a generic driver code or numeric errno', () => {
    expect(sqlState({ code: 'ERR_POSTGRES_SERVER_ERROR' })).toBeNull();
    expect(sqlState({ errno: -1 })).toBeNull();
  });

  it('returns null for lowercase and short strings', () => {
    expect(sqlState({ errno: '22p02' })).toBeNull();
    expect(sqlState({ code: '2350' })).toBeNull();
  });

  it('returns null for non-objects and null', () => {
    expect(sqlState('23505')).toBeNull();
    expect(sqlState(null)).toBeNull();
  });
});
