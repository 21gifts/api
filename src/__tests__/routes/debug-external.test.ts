import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { debugExternalRoutes } from '@/routes/debug-external';

function mount(store: MessageStore, debugToken: string | undefined): Hono {
  return new Hono().route('/debug/external-pubkeys', debugExternalRoutes({ store, debugToken }));
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe('debugExternalRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is missing or blank', async () => {
    for (const token of [undefined, '  ']) {
      const res = await mount(new InMemoryMessageStore(), token).request('/debug/external-pubkeys');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    }
  });

  it('returns 401 without the matching bearer', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const missing = await app.request('/debug/external-pubkeys');
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    const wrong = await app.request('/debug/external-pubkeys', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);
  });

  it('lists zappers and blocks newest first with ISO dates', async () => {
    const store = new InMemoryMessageStore();
    const oldPubkey = 'aa'.repeat(32);
    const newPubkey = 'bb'.repeat(32);
    await store.recordZapper(oldPubkey, 'receipt-old', new Date('2026-09-18T09:00:00Z'));
    await store.recordZapper(newPubkey, 'receipt-new', new Date('2026-09-18T10:00:00Z'));
    await store.blockPubkeyAndHideRows(
      oldPubkey,
      new Date('2026-09-18T11:00:00Z'),
      'staff-old',
      'message-old',
    );
    await store.blockPubkeyAndHideRows(
      newPubkey,
      new Date('2026-09-18T12:00:00Z'),
      'staff-new',
      'message-new',
    );
    const res = await mount(store, 'secret').request('/debug/external-pubkeys', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      zappers: [
        {
          pubkey: newPubkey,
          receiptEventId: 'receipt-new',
          createdAt: '2026-09-18T10:00:00.000Z',
        },
        {
          pubkey: oldPubkey,
          receiptEventId: 'receipt-old',
          createdAt: '2026-09-18T09:00:00.000Z',
        },
      ],
      blocked: [
        {
          pubkey: newPubkey,
          blockedAt: '2026-09-18T12:00:00.000Z',
          blockedBy: 'staff-new',
          messageId: 'message-new',
        },
        {
          pubkey: oldPubkey,
          blockedAt: '2026-09-18T11:00:00.000Z',
          blockedBy: 'staff-old',
          messageId: 'message-old',
        },
      ],
    });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.external_pubkeys.listed', zappers: 2, blocked: 2 }),
    );
  });

  it('returns 503 and logs when either list fails', async () => {
    const store = {
      listZappers: async () => {
        throw new Error('boom');
      },
      listBlockedPubkeyRows: async () => [],
    } as unknown as MessageStore;
    const res = await mount(store, 'secret').request('/debug/external-pubkeys', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'External pubkeys are unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.external_pubkeys.list_failed' }),
    );
  });
});
