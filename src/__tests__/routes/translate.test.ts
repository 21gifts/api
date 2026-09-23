import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { messagesRoutes } from '@/routes/messages';
import { translateRoutes } from '@/routes/translate';
import { InMemoryTranslationStore } from '@/lib/translation-store';

const NOTE_ID = '3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a';
const ENV = {
  TRANSLATE_URL: 'https://api.deepl.com/v2/translate',
  TRANSLATE_API_KEY: 'k',
};

describe('GET /translate', () => {
  it('is available only when URL and key are set', async () => {
    const off = new Hono().route('/translate', translateRoutes({ env: {} }));
    expect(await (await off.request('/translate')).json()).toEqual({ available: false });
    const on = new Hono().route('/translate', translateRoutes({ env: ENV }));
    expect(await (await on.request('/translate')).json()).toEqual({ available: true });
  });
});

describe('POST /messages/:id/translate', () => {
  it('returns a cached translation without DeepL', async () => {
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'Hallo Welt',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const translations = new InMemoryTranslationStore();
    const { translationSourceHash } = await import('@/lib/translation-store');
    await translations.put(NOTE_ID, 'en', translationSourceHash('Hallo Welt'), 'Hello, World');
    const fetchImpl = async () => {
      throw new Error('DeepL must not be called');
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messages,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
        translationStore: translations,
        fetchImpl,
      }),
    );
    const res = await app.request(`/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translatedText: 'Hello, World', cached: true });
  });

  it('returns 404 for an unknown id and 400 for a bad body', async () => {
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
      }),
    );
    expect(
      (
        await app.request('/messages/not-a-uuid/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'en' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/messages/${NOTE_ID}/translate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'en' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/messages/${NOTE_ID}/translate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'fr' }),
        })
      ).status,
    ).toBe(400);
  });

  it('returns 503 when DeepL is not configured and the cache misses', async () => {
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'Hallo Welt',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messages,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: {},
      }),
    );
    const res = await app.request(`/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Translate is not configured' });
  });

  it('returns 400 when the note text is empty', async () => {
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: '   ',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messages,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
      }),
    );
    const res = await app.request(`/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
  });

  it('returns 502 when DeepL fails and 503 on an unexpected store error', async () => {
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'Hallo Welt',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const fetchImpl = async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messages,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
        fetchImpl,
      }),
    );
    const res = await app.request(`/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Translate upstream failed' });

    const brokenStore = new InMemoryMessageStore();
    brokenStore.getById = async (): Promise<never> => {
      throw new Error('db down');
    };
    const broken = new Hono().route(
      '/messages',
      messagesRoutes({
        store: brokenStore,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
      }),
    );
    const unexpected = await broken.request(`/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(unexpected.status).toBe(503);
    expect(await unexpected.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 404 for a hidden note and for a withheld inbound reply', async () => {
    const hiddenId = '4a4a4a4a-4a4a-44a4-84a4-4a4a4a4a4a4a';
    const parentId = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
    const replyId = '6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: hiddenId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Hallo Welt',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    expect(await messages.markDeleted(hiddenId, new Date('2026-09-02T00:00:00.000Z'), 'acc')).toBe(
      true,
    );
    await messages.create({
      id: parentId,
      accountId: 'acc',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    await messages.create({
      id: replyId,
      accountId: null,
      name: 'npub',
      text: 'Hallo Welt',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
      parentId,
      authorPubkey: null,
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messages,
        authStore: new InMemoryAuthStore(),
        now: () => 1,
        env: ENV,
      }),
    );
    const hidden = await app.request(`/messages/${hiddenId}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(hidden.status).toBe(404);
    const withheld = await app.request(`/messages/${replyId}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(withheld.status).toBe(404);
  });
});
