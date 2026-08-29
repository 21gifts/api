import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContactRow } from '@/lib/contact';
import { InMemoryContactStore, type ContactStore } from '@/lib/contact-store';
import { debugContactsRoutes } from '@/routes/debug-contacts';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('debugContactsRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store: new InMemoryContactStore(), debugToken: undefined }),
    );
    const res = await app.request('/debug/contacts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store: new InMemoryContactStore(), debugToken: '  ' }),
    );
    const res = await app.request('/debug/contacts', {
      headers: { authorization: 'Bearer   ' },
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store: new InMemoryContactStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/contacts');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a wrong bearer', async () => {
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store: new InMemoryContactStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/contacts', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('lists contacts newest-first for a valid bearer', async () => {
    const early: ContactRow = {
      id: 'a',
      accountId: 'acc-1',
      name: 'Ada',
      text: 'older',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const late: ContactRow = {
      id: 'b',
      accountId: 'acc-2',
      name: 'Bob',
      text: 'newer',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    };
    const store = new InMemoryContactStore([early, late]);
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store, debugToken: 'secret' }),
    );
    const res = await app.request('/debug/contacts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contacts: Array<{ id: string; accountId: string; text: string; createdAt: string }>;
    };
    expect(body.contacts).toHaveLength(2);
    expect(body.contacts.map((c) => c.id)).toEqual(['b', 'a']);
    expect(body.contacts[0]?.accountId).toBe('acc-2');
    expect(body.contacts[0]?.text).toBe('newer');
    expect(body.contacts[0]?.createdAt).toBe('2026-08-02T00:00:00.000Z');
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.contacts.listed')).toBe(true);
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'debug.contacts.listed' && e['count'] === 2),
    ).toBe(true);
  });

  it('returns 503 and logs when listLatest throws', async () => {
    const throwing: ContactStore = {
      listLatest: async () => {
        throw new Error('boom');
      },
      create: async () => {
        throw new Error('boom');
      },
    };
    const app = new Hono().route(
      '/debug/contacts',
      debugContactsRoutes({ store: throwing, debugToken: 'secret' }),
    );
    const res = await app.request('/debug/contacts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Contact is unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'contact.list.failed')).toBe(true);
  });
});
