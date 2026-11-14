import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryWelcomeInvoiceReservationStore,
  PostgresWelcomeInvoiceReservationStore,
  WELCOME_INVOICE_RESERVATION_SCHEMA_SQL,
  migrateWelcomeInvoiceReservationSchema,
} from '@/lib/welcome-reservation';

describe('welcome invoice reservation stores', () => {
  it('keeps one active in-memory lease and permits replacement only after expiry', async () => {
    const store = new InMemoryWelcomeInvoiceReservationStore();
    await expect(store.reserve('account', 'a'.repeat(32), new Date(1), new Date(3))).resolves.toBe(
      true,
    );
    await expect(store.reserve('account', 'b'.repeat(32), new Date(2), new Date(4))).resolves.toBe(
      false,
    );
    await store.release('account', 'b'.repeat(32));
    await expect(store.reserve('account', 'b'.repeat(32), new Date(3), new Date(5))).resolves.toBe(
      true,
    );
    await store.release('account', 'b'.repeat(32));
    await expect(store.reserve('account', 'c'.repeat(32), new Date(4), new Date(6))).resolves.toBe(
      true,
    );
  });

  it('migrates, conditionally reserves, and releases Postgres leases', async () => {
    const query = vi
      .fn<(text: string, params?: readonly unknown[]) => Promise<unknown[]>>(async () => [])
      .mockResolvedValueOnce([{ reservation_id: 'a'.repeat(32) }])
      .mockResolvedValueOnce([]);
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);
    const genericQuery = query as <T>(text: string, params?: readonly unknown[]) => Promise<T[]>;
    await migrateWelcomeInvoiceReservationSchema({ query: genericQuery, execute });
    const store = new PostgresWelcomeInvoiceReservationStore({ query: genericQuery, execute });
    await expect(store.reserve('account', 'a'.repeat(32), new Date(1), new Date(2))).resolves.toBe(
      true,
    );
    await expect(store.reserve('account', 'b'.repeat(32), new Date(1), new Date(2))).resolves.toBe(
      false,
    );
    await store.release('account', 'a'.repeat(32));

    expect(execute.mock.calls[0]?.[0]).toBe(WELCOME_INVOICE_RESERVATION_SCHEMA_SQL);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (account_id) DO UPDATE');
    expect(execute.mock.calls[1]?.[0]).toContain('DELETE FROM welcome_invoice_reservation');
  });
});
