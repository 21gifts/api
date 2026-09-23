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
});
