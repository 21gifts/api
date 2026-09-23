import { translateViaDeepl, TranslateUpstreamError } from '@/lib/translate-deepl';
import {
  resolveTranslateUpstream,
  type TranslateTarget,
  type TranslateUpstream,
} from '@/lib/translate-config';
import {
  translationSourceHash,
  type TranslationStore,
} from '@/lib/translation-store';

/** Result of {@link translateForumNote}. */
export interface TranslateNoteResult {
  /** Translated body. */
  translatedText: string;
  /** True when DeepL was not called. */
  cached: boolean;
}

/** Thrown when DeepL is not configured. */
export class TranslateNotConfiguredError extends Error {
  constructor() {
    super('translate is not configured');
    this.name = 'TranslateNotConfiguredError';
  }
}

const inflight = new Map<string, Promise<TranslateNoteResult>>();

/**
 * Return a cached translation or call DeepL once per (message, locale, source).
 *
 * Concurrent callers for the same key share one DeepL POST. A stored row for
 * the current source hash is returned without contacting DeepL.
 *
 * @param store - Translation cache.
 * @param env - Process env for DeepL config.
 * @param messageId - Forum message UUID.
 * @param text - Current `message.text`.
 * @param target - UI locale.
 * @param fetchImpl - Injected fetch.
 * @returns Cached or freshly stored translation.
 * @throws TranslateNotConfiguredError when URL/key are missing.
 * @throws TranslateUpstreamError when DeepL fails.
 */
export async function translateForumNote(
  store: TranslationStore,
  env: Record<string, string | undefined>,
  messageId: string,
  text: string,
  target: TranslateTarget,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TranslateNoteResult> {
  const sourceSha256 = translationSourceHash(text);
  const existing = await store.get(messageId, target);
  if (existing !== null && existing.sourceSha256 === sourceSha256) {
    return { translatedText: existing.translatedText, cached: true };
  }
  const upstream = resolveTranslateUpstream(env);
  if (upstream === null) {
    throw new TranslateNotConfiguredError();
  }
  const key = `${messageId}\0${target}\0${sourceSha256}`;
  const pending = inflight.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const work = runDeeplAndStore(store, upstream, messageId, text, target, sourceSha256, fetchImpl);
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

async function runDeeplAndStore(
  store: TranslationStore,
  upstream: TranslateUpstream,
  messageId: string,
  text: string,
  target: TranslateTarget,
  sourceSha256: string,
  fetchImpl: typeof fetch,
): Promise<TranslateNoteResult> {
  const again = await store.get(messageId, target);
  if (again !== null && again.sourceSha256 === sourceSha256) {
    return { translatedText: again.translatedText, cached: true };
  }
  const translated = await translateViaDeepl(upstream, text, target, fetchImpl);
  const stored = await store.put(messageId, target, sourceSha256, translated);
  return { translatedText: stored, cached: false };
}

export { TranslateUpstreamError };
