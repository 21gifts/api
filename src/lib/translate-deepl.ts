import { z } from 'zod';
import type { FetchFn } from '@/lib/lnurlp';
import {
  deeplTargetLang,
  type TranslateTarget,
  type TranslateUpstream,
} from '@/lib/translate-config';

const translatedBodySchema = z.object({
  translations: z.tuple([z.object({ text: z.string().min(1) })]),
});

/** Thrown when DeepL is unreachable, non-2xx, or the body is not a translation. */
export class TranslateUpstreamError extends Error {
  /**
   * @param message - Stable error text. Callers do not show it to clients.
   */
  constructor(message = 'translate upstream failed') {
    super(message);
    this.name = 'TranslateUpstreamError';
  }
}

/** Timeout for one DeepL POST. */
export const TRANSLATE_UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * POST DeepL API v2 for one forum body.
 *
 * @param upstream - Resolved URL and Auth Key.
 * @param text - Stored message text (already non-empty).
 * @param target - UI locale.
 * @param fetchImpl - Injected fetch (default `globalThis.fetch`).
 * @returns Translated text.
 * @throws TranslateUpstreamError on timeout, network, non-2xx, or bad JSON.
 */
export async function translateViaDeepl(
  upstream: TranslateUpstream,
  text: string,
  target: TranslateTarget,
  fetchImpl: FetchFn = globalThis.fetch,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TRANSLATE_UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(upstream.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `DeepL-Auth-Key ${upstream.apiKey}`,
      },
      body: JSON.stringify({
        text: [text],
        target_lang: deeplTargetLang(target),
      }),
      signal: controller.signal,
    });
  } catch {
    throw new TranslateUpstreamError();
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new TranslateUpstreamError();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TranslateUpstreamError();
  }
  const parsed = translatedBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new TranslateUpstreamError();
  }
  return parsed.data.translations[0].text;
}
