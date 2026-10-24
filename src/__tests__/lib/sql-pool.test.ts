import { describe, expect, it } from 'vitest';
import {
  LOG_LOCK_TIMEOUT_MS,
  LOG_POOL_MAX,
  LOG_STATEMENT_TIMEOUT_MS,
  logPoolOptions,
} from '@/lib/sql-pool';

describe('logPoolOptions', () => {
  it('caps the log pool and sets statement and lock timeouts', () => {
    expect(logPoolOptions()).toEqual({
      max: LOG_POOL_MAX,
      connection: {
        statement_timeout: LOG_STATEMENT_TIMEOUT_MS,
        lock_timeout: LOG_LOCK_TIMEOUT_MS,
        application_name: '21gifts-api-log',
      },
    });
    expect(LOG_POOL_MAX).toBeLessThan(10);
    expect(Number(LOG_STATEMENT_TIMEOUT_MS)).toBeGreaterThan(0);
    expect(Number(LOG_LOCK_TIMEOUT_MS)).toBeGreaterThan(0);
    expect(Number(LOG_LOCK_TIMEOUT_MS)).toBeLessThanOrEqual(Number(LOG_STATEMENT_TIMEOUT_MS));
  });
});
