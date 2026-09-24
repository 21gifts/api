import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import { TranslateNotConfiguredError, translateForumNote } from '@/lib/translate-note';
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
    const fetchMock = vi.fn();
    const result = await translateForumNote(
      store,
      ENV,
      'mid',
      text,
      'en',
      fetchMock as unknown as FetchFn,
    );
    expect(result).toEqual({ translatedText: 'Hello, World', cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls DeepL once when two callers miss the cache together', async () => {
    const store = new InMemoryTranslationStore();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return new Response(JSON.stringify({ translations: [{ text: 'Hello, World' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const fetchImpl = fetchMock as unknown as FetchFn;
    const [a, b] = await Promise.all([
      translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl),
      translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.translatedText).toBe('Hello, World');
    expect(b.translatedText).toBe('Hello, World');
    const third = await translateForumNote(store, ENV, 'mid', 'Hallo Welt', 'en', fetchImpl);
    expect(third.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns cached true when a writer fills the row during DeepL', async () => {
    const text = 'Hallo Welt';
    const hash = translationSourceHash(text);
    let gets = 0;
    const store = {
      async get(): Promise<{ sourceSha256: string; translatedText: string } | null> {
        gets += 1;
        if (gets === 1) {
          return null;
        }
        return { sourceSha256: hash, translatedText: 'Hello, World' };
      },
      async put(): Promise<string> {
        throw new Error('put must not run');
      },
    };
    const fetchMock = vi.fn(async () => {
      throw new Error('DeepL must not run after the second get');
    });
    const result = await translateForumNote(
      store,
      ENV,
      'mid',
      text,
      'en',
      fetchMock as unknown as FetchFn,
    );
    expect(result).toEqual({ translatedText: 'Hello, World', cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when DeepL is not configured', async () => {
    await expect(
      translateForumNote(new InMemoryTranslationStore(), {}, 'mid', 'Hallo', 'en'),
    ).rejects.toBeInstanceOf(TranslateNotConfiguredError);
  });

  it('retranslates when the source text changes', async () => {
    const store = new InMemoryTranslationStore();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string[] };
      return new Response(JSON.stringify({ translations: [{ text: `EN:${body.text[0]}` }] }), {
        status: 200,
      });
    });
    const fetchImpl = fetchMock as unknown as FetchFn;
    const first = await translateForumNote(store, ENV, 'mid', 'eins', 'en', fetchImpl);
    const second = await translateForumNote(store, ENV, 'mid', 'zwei', 'en', fetchImpl);
    expect(first.translatedText).toBe('EN:eins');
    expect(second.translatedText).toBe('EN:zwei');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
