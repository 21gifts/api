import { describe, it, expect } from 'vitest';
import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';

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
