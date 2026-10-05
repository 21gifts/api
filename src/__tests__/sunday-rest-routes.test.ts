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

  it('keeps public writes blocked until exactly 08:00 on local Monday', async () => {
    let instant = Date.parse('2026-10-05T05:59:59.999Z');
    const server = createApp({ now: () => instant });
    for (const path of ['/messages', '/funding/apply', '/me/name']) {
      const response = await server.request(path, { method: 'POST', headers: { 'Time-Zone': 'Europe/Zurich' } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'SUNDAY_REST' });
    }
    expect((await server.request('/healthz')).status).toBe(200);
    instant = Date.parse('2026-10-05T06:00:00.000Z');
    const response = await server.request('/messages', { method: 'POST', headers: { 'Time-Zone': 'Europe/Zurich' } });
    expect(response.status).toBe(401);
    expect(await response.json()).not.toEqual({ error: 'SUNDAY_REST' });
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

  it('refuses the next credit repayment when the device zone is Sunday', async () => {
    const res = await app().request('/messages/note-1/repayment', {
      method: 'POST',
      headers: { 'Time-Zone': 'Europe/Zurich' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
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

  it('refuses PATCH /messages/:id/shop-account when the device zone is Sunday', async () => {
    const res = await app().request('/messages/note-1/shop-account', {
      method: 'PATCH',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('refuses PATCH /messages/:id/photos when the device zone is Sunday', async () => {
    const res = await app().request('/messages/note-1/photos', {
      method: 'PATCH',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ photos: [] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('refuses PATCH /messages/:id/text when the device zone is Sunday', async () => {
    const res = await app().request('/messages/note-1/text', {
      method: 'PATCH',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('does not refuse GET /messages/:id/edits with Time-Zone Europe/Zurich on Sunday', async () => {
    const res = await app().request('/messages/note-1/edits', {
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

  it('refuses PUT /pictures/me and PUT /banners/me when the device zone is Sunday', async () => {
    const picture = await app().request('/pictures/me', {
      method: 'PUT',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: null }),
    });
    const banner = await app().request('/banners/me', {
      method: 'PUT',
      headers: { 'Time-Zone': 'Europe/Zurich', 'content-type': 'application/json' },
      body: JSON.stringify({ photo: null }),
    });
    expect(picture.status).toBe(403);
    expect(await picture.json()).toEqual({ error: 'SUNDAY_REST' });
    expect(banner.status).toBe(403);
    expect(await banner.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('does not refuse reading the profile photo or the wide image on Sunday', async () => {
    const picture = await app().request('/pictures/me', {
      headers: { 'Time-Zone': 'Europe/Zurich' },
    });
    const banner = await app().request('/banners/me', {
      headers: { 'Time-Zone': 'Europe/Zurich' },
    });
    expect(picture.status).not.toBe(403);
    expect(((await picture.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
    expect(banner.status).not.toBe(403);
    expect(((await banner.json()) as { error?: string }).error).not.toBe('SUNDAY_REST');
  });

  it('does not refuse a profile-photo write without a Time-Zone header', async () => {
    const res = await app().request('/pictures/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo: null }),
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
