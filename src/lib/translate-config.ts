/**
 * Optional DeepL API v2 config. Missing or blank values yield `null` so the
 * process still boots; translate HTTP returns 503 until both are set.
 */

/** Resolved DeepL POST URL and Auth Key. */
export interface TranslateUpstream {
  /** Full DeepL v2 translate URL, used as-is. */
  url: URL;
  /** Trimmed Auth Key. Secret — never log. */
  apiKey: string;
}

/** Forum UI locales that DeepL can target. */
export const TRANSLATE_TARGETS = ['en', 'de', 'es', 'fil'] as const;

/** One DeepL target locale. */
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];

/**
 * Map a UI locale onto DeepL `target_lang` (`fil` → `TL`).
 *
 * @param target - UI locale.
 * @returns DeepL target_lang.
 */
export function deeplTargetLang(target: TranslateTarget): string {
  return target === 'fil' ? 'TL' : target.toUpperCase();
}

/**
 * Read DeepL config from an environment slice.
 *
 * @param env - Process environment (injected so tests need not mutate it).
 * @returns URL and key when both are usable; otherwise `null`.
 */
export function resolveTranslateUpstream(
  env: Record<string, string | undefined>,
): TranslateUpstream | null {
  const rawUrl = env['TRANSLATE_URL'];
  if (rawUrl === undefined || rawUrl.trim() === '') {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const rawKey = env['TRANSLATE_API_KEY'];
    if (rawKey === undefined || rawKey.trim() === '') {
      return null;
    }
    return { url, apiKey: rawKey.trim() };
  } catch {
    return null;
  }
}
