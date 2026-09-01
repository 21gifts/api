import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import {
  MESSAGE_VIDEO_MAX_BYTES,
  readForumVideoBytes,
  resolveMediaDir,
  videoFilePath,
} from '@/lib/video';
import { debugMessagesRoutes } from '@/routes/debug-messages';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

function movBytes(): Uint8Array {
  const bytes = mp4Bytes();
  bytes.set([0x71, 0x74, 0x20, 0x20], 8);
  return bytes;
}

const VIDEO_ID = '00000000-0000-4000-8000-000000000001';

function videoRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: VIDEO_ID,
    accountId: '00000000-0000-4000-8000-0000000000aa',
    name: 'Ada',
    text: 'clip',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    hasPhoto: false,
    hasVideo: true,
    videoContentType: 'video/mp4',
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

function mount(store: MessageStore, debugToken: string | undefined): Hono {
  return new Hono().route('/debug/messages', debugMessagesRoutes({ store, debugToken }));
}

describe('debugMessagesRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = mount(new InMemoryMessageStore(), undefined);
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, { method: 'PUT' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const app = mount(new InMemoryMessageStore(), '  ');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer   ' },
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, { method: 'PUT' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a wrong bearer even when a body is present', async () => {
    const app = mount(new InMemoryMessageStore([videoRow()]), 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer wrong' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 for a non-UUID id with a valid bearer', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request('/debug/messages/not-a-uuid/video', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for an unknown id with a valid bearer', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 409 when the message has no video', async () => {
    const store = new InMemoryMessageStore([videoRow({ hasVideo: false, videoContentType: null })]);
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message has no video' });
  });

  it('returns 409 when hasVideo is true but videoContentType is null', async () => {
    const store = new InMemoryMessageStore([videoRow({ hasVideo: true, videoContentType: null })]);
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message has no video' });
  });

  it('returns 400 for an empty body', async () => {
    const store = new InMemoryMessageStore([videoRow()]);
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: new Uint8Array(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a video body' });
  });

  it('returns 400 for garbage bytes', async () => {
    const store = new InMemoryMessageStore([videoRow()]);
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a video body' });
  });

  it('returns 400 for an oversize body', async () => {
    const store = new InMemoryMessageStore([videoRow()]);
    const app = mount(store, 'secret');
    const huge = new Uint8Array(MESSAGE_VIDEO_MAX_BYTES + 1);
    huge.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: huge,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a video body' });
  });

  it('returns 409 when the decoded type does not match the stored MIME', async () => {
    const store = new InMemoryMessageStore([
      videoRow({ hasVideo: true, videoContentType: 'video/mp4' }),
    ]);
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: movBytes(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Video type does not match' });
  });

  it('writes the video file and returns 204 on the happy path', async () => {
    const store = new InMemoryMessageStore([videoRow()]);
    const app = mount(store, 'secret');
    const body = mp4Bytes();
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const path = videoFilePath(resolveMediaDir(), VIDEO_ID, 'video/mp4');
    const onDisk = await readForumVideoBytes(path);
    expect(onDisk[4]).toBe(0x66);
    expect(onDisk[5]).toBe(0x74);
    expect(onDisk[6]).toBe(0x79);
    expect(onDisk[7]).toBe(0x70);

    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.messages.video.put' &&
          e['messageId'] === VIDEO_ID &&
          typeof e['bytes'] === 'number' &&
          (e['bytes'] as number) > 0,
      ),
    ).toBe(true);
  });

  it('returns 503 and logs when getById throws', async () => {
    const store = {
      getById: async () => {
        throw new Error('boom');
      },
    } as unknown as MessageStore;
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${VIDEO_ID}/video`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: mp4Bytes(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.messages.video.put_failed')).toBe(
      true,
    );
  });
});
