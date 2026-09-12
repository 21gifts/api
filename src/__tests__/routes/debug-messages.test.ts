import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
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
const HIDDEN_ID = '00000000-0000-4000-8000-000000000002';
const REPLY_ID = '00000000-0000-4000-8000-000000000003';
const HIDDEN_PHOTO_ID = '00000000-0000-4000-8000-000000000004';
const HIDDEN_PNG_ID = '00000000-0000-4000-8000-000000000005';
const HIDDEN_WEBP_ID = '00000000-0000-4000-8000-000000000006';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000099';
const HIDDEN_AT = new Date('2026-09-01T12:00:00.000Z');
const JPEG: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
const PNG: ForumPhoto = {
  contentType: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
const WEBP: ForumPhoto = {
  contentType: 'image/webp',
  bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
};

function forumRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: HIDDEN_ID,
    accountId: '00000000-0000-4000-8000-0000000000aa',
    name: 'Ada',
    text: 'hidden note',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

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

  it('returns 401 on GET list, get, and photo without a matching bearer', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    for (const path of [
      '/debug/messages',
      `/debug/messages/${HIDDEN_ID}`,
      `/debug/messages/${HIDDEN_ID}/photo`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('lists hidden rows and replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
      }),
    );
    await store.create(
      forumRow({
        id: REPLY_ID,
        parentId: HIDDEN_ID,
        text: 'a reply',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      }),
    );
    const app = mount(store, 'secret');
    const res = await app.request('/debug/messages', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.map((row) => row['id'])).toEqual([REPLY_ID, HIDDEN_ID]);
    const hidden = body.messages.find((row) => row['id'] === HIDDEN_ID);
    const reply = body.messages.find((row) => row['id'] === REPLY_ID);
    expect(hidden?.['deletedAt']).toBe(HIDDEN_AT.toISOString());
    expect(hidden?.['text']).toBe('hidden note');
    expect(reply?.['parentId']).toBe(HIDDEN_ID);
    expect(reply?.['deletedAt']).toBeNull();
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'debug.messages.listed' && e['count'] === 2),
    ).toBe(true);
  });

  it('returns 200 for a hidden row including deletedAt and text', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
        accountId: null,
      }),
    );
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${HIDDEN_ID}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(HIDDEN_ID);
    expect(body['text']).toBe('hidden note');
    expect(body['deletedAt']).toBe(HIDDEN_AT.toISOString());
    expect(body['deletedBy']).toBe('staff');
    expect(body['accountId']).toBeNull();
    expect(body).not.toHaveProperty('nostrEvent');
    expect(body).not.toHaveProperty('contentFp');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'debug.messages.get' && e['messageId'] === HIDDEN_ID,
      ),
    ).toBe(true);
  });

  it('returns 404 for an unknown UUID on GET by id', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request(`/debug/messages/${UNKNOWN_ID}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for a non-UUID id on GET by id', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request('/debug/messages/not-a-uuid', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 200 photo bytes for a hidden note that has a photo', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        id: HIDDEN_PHOTO_ID,
        text: 'pic',
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
      }),
      JPEG,
    );
    await store.create(
      forumRow({
        id: HIDDEN_PNG_ID,
        text: 'png',
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
      }),
      PNG,
    );
    await store.create(
      forumRow({
        id: HIDDEN_WEBP_ID,
        text: 'webp',
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
      }),
      WEBP,
    );
    const app = mount(store, 'secret');
    const jpegRes = await app.request(`/debug/messages/${HIDDEN_PHOTO_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(jpegRes.status).toBe(200);
    expect(jpegRes.headers.get('Content-Type')).toBe('image/jpeg');
    expect(jpegRes.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(jpegRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(jpegRes.headers.get('Content-Disposition')).toBe('inline; filename="photo.jpg"');
    expect(new Uint8Array(await jpegRes.arrayBuffer())).toEqual(JPEG.bytes);

    const pngRes = await app.request(`/debug/messages/${HIDDEN_PNG_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('Content-Disposition')).toBe('inline; filename="photo.png"');

    const webpRes = await app.request(`/debug/messages/${HIDDEN_WEBP_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(webpRes.status).toBe(200);
    expect(webpRes.headers.get('Content-Disposition')).toBe('inline; filename="photo.webp"');

    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'debug.messages.photo.get' && e['messageId'] === HIDDEN_PHOTO_ID,
      ),
    ).toBe(true);
  });

  it('returns 404 photo when a hidden note has no photo', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      forumRow({
        deletedAt: HIDDEN_AT,
        deletedBy: 'staff',
        hasPhoto: false,
      }),
    );
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${HIDDEN_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 photo for a missing row or non-UUID id', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const missing = await app.request(`/debug/messages/${UNKNOWN_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Photo not found' });
    const bad = await app.request('/debug/messages/not-a-uuid/photo', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 503 and logs when listDebug throws', async () => {
    const store = {
      listDebug: async () => {
        throw new Error('boom');
      },
    } as unknown as MessageStore;
    const app = mount(store, 'secret');
    const res = await app.request('/debug/messages', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.messages.list_failed')).toBe(true);
  });

  it('returns 503 and logs when GET by id throws', async () => {
    const store = {
      getById: async () => {
        throw new Error('boom');
      },
    } as unknown as MessageStore;
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${HIDDEN_ID}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.messages.get_failed')).toBe(true);
  });

  it('returns 503 and logs when GET photo throws', async () => {
    const store = {
      getById: async () => {
        throw new Error('boom');
      },
    } as unknown as MessageStore;
    const app = mount(store, 'secret');
    const res = await app.request(`/debug/messages/${HIDDEN_ID}/photo`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.messages.photo.get_failed')).toBe(
      true,
    );
  });
});
