import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';

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
