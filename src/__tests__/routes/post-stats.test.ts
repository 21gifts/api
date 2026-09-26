import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { createApp } from '@/server';

const NOTE: MessageRow = {
  id: 'note',
  accountId: 'acc',
  name: 'Ada',
  text: 'hello',
  createdAt: new Date('2026-08-01T22:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('GET /messages/stats', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('counts living notes and replies together and skips hidden rows', async () => {
    const store = new InMemoryMessageStore([
      NOTE,
      { ...NOTE, id: 'reply', parentId: 'note', createdAt: new Date('2026-08-01T23:00:00.000Z') },
      { ...NOTE, id: 'hidden', deletedAt: new Date('2026-08-02T00:00:00.000Z') },
    ]);
    const app = createApp({
      messageStore: store,
      now: () => Date.parse('2026-08-02T16:00:00.000Z'),
    });
    const res = await app.request('/messages/stats');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postCount: 2,
      postsOverTime: [
        { day: '2026-08-01', postCount: 2 },
        { day: '2026-08-02', postCount: 0 },
      ],
    });
  });

  it('returns an empty body when the forum has no living notes', async () => {
    const res = await createApp().request('/messages/stats');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ postCount: 0, postsOverTime: [] });
  });

  it('returns 503 when the count query throws', async () => {
    const store = new InMemoryMessageStore();
    store.postCountsByUtcDay = () => Promise.reject(new Error('down'));
    const res = await createApp({ messageStore: store }).request('/messages/stats');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Post stats are unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'posts.stats.failed' }),
    );
  });
});
