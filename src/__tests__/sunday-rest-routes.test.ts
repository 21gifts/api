import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '@/server';

// 22:30Z Saturday is Sunday 00:30 in Europe/Zurich and Saturday 12:30 in Pacific/Honolulu.
const ZURICH_SUNDAY_MS = Date.parse('2026-09-26T22:30:00.000Z');

function app() {
  return createApp({ now: () => ZURICH_SUNDAY_MS });
}

describe('sunday rest routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('refuses POST /messages with Time-Zone Europe/Zurich on Sunday', async () => {
    const res = await app().request('/messages', {
      method: 'POST',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('does not refuse POST /messages when Pacific/Honolulu is still Saturday', async () => {
    const res = await app().request('/messages', {
      method: 'POST',
      headers: { 'Time-Zone': 'Pacific/Honolulu', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });

  it('refuses a zap invoice on a forum note when the device zone is Sunday', async () => {
    const res = await app().request('/messages/note-1/invoice', {
      method: 'POST',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('does not refuse POST /messages without a Time-Zone header', async () => {
    const res = await app().request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });

  it('does not refuse GET /messages with Time-Zone Europe/Zurich on Sunday', async () => {
    const res = await app().request('/messages', {
      headers: { 'Time-Zone': 'Europe/Zurich' },
    });
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });

  it('refuses GET /conversations/moderator-group when the device zone is Sunday', async () => {
    const res = await app().request('/conversations/moderator-group', {
      headers: { 'Time-Zone': 'Europe/Zurich' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('does not refuse POST /conversations with Time-Zone Europe/Zurich on Sunday', async () => {
    const res = await app().request('/conversations', {
      method: 'POST',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ forumMessageId: '00000000-0000-4000-8000-000000000001' }),
    });
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });

  it('does not refuse POST /messages when Time-Zone is invalid', async () => {
    const res = await app().request('/messages', {
      method: 'POST',
      headers: { 'Time-Zone': 'Not/AZone', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });
});
