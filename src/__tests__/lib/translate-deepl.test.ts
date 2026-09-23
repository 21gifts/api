import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import { deeplTargetLang } from '@/lib/translate-config';
import {
  TRANSLATE_UPSTREAM_TIMEOUT_MS,
  TranslateUpstreamError,
  translateViaDeepl,
} from '@/lib/translate-deepl';

const UPSTREAM = {
  url: new URL('https://api.deepl.com/v2/translate'),
  apiKey: 'k',
};
const SOURCE = 'Hallo Welt';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TranslateUpstreamError', () => {
  it('defaults the message and names the error', () => {
    const err = new TranslateUpstreamError();
    expect(err.message).toBe('translate upstream failed');
    expect(err.name).toBe('TranslateUpstreamError');
  });
});

describe('translateViaDeepl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the first translation on 2xx JSON', async () => {
    let seenInput: string | URL | Request | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (input, init) => {
      seenInput = input;
      seenInit = init;
      return jsonResponse({ translations: [{ text: 'Hello, World' }] });
    };

    await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl)).resolves.toBe(
      'Hello, World',
    );

    expect(seenInput).toBe(UPSTREAM.url);
    expect(seenInit?.method).toBe('POST');
    const headers = new Headers(seenInit?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`DeepL-Auth-Key ${UPSTREAM.apiKey}`);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        text: [SOURCE],
        target_lang: deeplTargetLang('en'),
      }),
    );
  });

  it('throws TranslateUpstreamError on non-2xx', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ translations: [{ text: 'x' }] }, 500);
    await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl)).rejects.toBeInstanceOf(
      TranslateUpstreamError,
    );
  });

  it('throws TranslateUpstreamError when the body is not JSON', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl)).rejects.toBeInstanceOf(
      TranslateUpstreamError,
    );
  });

  it('throws TranslateUpstreamError when JSON misses the translation schema', async () => {
    const bodies: unknown[] = [{ translations: [] }, { foo: 1 }, { translations: [{ text: '' }] }];
    for (const body of bodies) {
      const fetchImpl: FetchFn = async () => jsonResponse(body);
      await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl)).rejects.toBeInstanceOf(
        TranslateUpstreamError,
      );
    }
  });

  it('uses globalThis.fetch when fetchImpl is omitted', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ translations: [{ text: 'Hello, World' }] }));
    try {
      await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en')).resolves.toBe('Hello, World');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('throws TranslateUpstreamError when fetch throws', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('network down');
    };
    await expect(translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl)).rejects.toBeInstanceOf(
      TranslateUpstreamError,
    );
  });

  it('aborts after TRANSLATE_UPSTREAM_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const fetchImpl: FetchFn = async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('missing abort signal');
      }
      return await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      });
    };

    const pending = translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl);
    const rejected = expect(pending).rejects.toBeInstanceOf(TranslateUpstreamError);
    await vi.advanceTimersByTimeAsync(TRANSLATE_UPSTREAM_TIMEOUT_MS);
    await rejected;
  });

  it('aborts hanging response.json after TRANSLATE_UPSTREAM_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const fetchImpl: FetchFn = async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('missing abort signal');
      }
      return {
        ok: true,
        json: async () =>
          await new Promise<never>((_resolve, reject) => {
            const fail = (): void => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          }),
      } as unknown as Response;
    };

    const pending = translateViaDeepl(UPSTREAM, SOURCE, 'en', fetchImpl);
    const rejected = expect(pending).rejects.toBeInstanceOf(TranslateUpstreamError);
    await vi.advanceTimersByTimeAsync(TRANSLATE_UPSTREAM_TIMEOUT_MS);
    await rejected;
  });
});
