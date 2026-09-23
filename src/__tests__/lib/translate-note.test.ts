import { describe, expect, it, vi } from 'vitest';
import {
  TranslateNotConfiguredError,
  translateForumNote,
} from '@/lib/translate-note';
import { InMemoryTranslationStore, translationSourceHash } from '@/lib/translation-store';

const ENV = {
  TRANSLATE_URL: 'https://api.deepl.com/v2/translate',
  TRANSLATE_API_KEY: 'k',
};

describe('translateForumNote', () => {
  it('returns a matching cache row without calling DeepL', async () => {
    const store = new InMemoryTranslationStore();
    const text = 'Hallo Welt';
    await store.put('mid', 'en', translationSourceHash(text), 'Hello, World');
    const fetchImpl = vi.fn();
    const result = await translateForumNote(store, ENV, 'mid', text, 'en', fetchImpl);
    expect(result).toEqual({ translatedText: 'Hello, World', cached: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls DeepL once when two callers miss the cache together', async () => {
    const store = new InMemoryTranslationStore();
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return new Response(
        JSON.stringify({ translations: [{ text: 'Hello, World' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const [a, b] = await Promise.all([
      translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl),
      translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.translatedText).toBe('Hello, World');
    expect(b.translatedText).toBe('Hello, World');
    const third = await translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl);
    expect(third.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when DeepL is not configured', async () => {
    await expect(
      translateForumNote(new InMemoryTranslationStore(), {}, 'mid', 'Hallo', 'en'),
    ).rejects.toBeInstanceOf(TranslateNotConfiguredError);
  });

  it('retranslates when the source text changes', async () => {
    const store = new InMemoryTranslationStore();
    const fetchImpl = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text: string[] };
        return new Response(
          JSON.stringify({ translations: [{ text: `EN:${body.text[0]}` }] }),
          { status: 200 },
        );
      },
    );
    const first = await translateForumNote(store, ENV, 'mid', 'eins', 'en', fetchImpl);
    const second = await translateForumNote(store, ENV, 'mid', 'zwei', 'en', fetchImpl);
    expect(first.translatedText).toBe('EN:eins');
    expect(second.translatedText).toBe('EN:zwei');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
