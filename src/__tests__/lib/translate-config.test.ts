import { describe, expect, it } from 'vitest';
import { deeplTargetLang, resolveTranslateUpstream } from '@/lib/translate-config';

describe('resolveTranslateUpstream', () => {
  it('returns null when URL or key is missing or blank', () => {
    expect(resolveTranslateUpstream({})).toBeNull();
    expect(
      resolveTranslateUpstream({ TRANSLATE_URL: 'https://api.deepl.com/v2/translate' }),
    ).toBeNull();
    expect(
      resolveTranslateUpstream({
        TRANSLATE_URL: 'https://api.deepl.com/v2/translate',
        TRANSLATE_API_KEY: '   ',
      }),
    ).toBeNull();
    expect(
      resolveTranslateUpstream({
        TRANSLATE_URL: 'ftp://api.deepl.com/v2/translate',
        TRANSLATE_API_KEY: 'k',
      }),
    ).toBeNull();
    expect(
      resolveTranslateUpstream({
        TRANSLATE_URL: 'http://[',
        TRANSLATE_API_KEY: 'k',
      }),
    ).toBeNull();
  });

  it('returns a trimmed key and parsed http(s) URL', () => {
    const resolved = resolveTranslateUpstream({
      TRANSLATE_URL: 'https://api-free.deepl.com/v2/translate',
      TRANSLATE_API_KEY: '  uuid:fx  ',
    });
    expect(resolved?.url.toString()).toBe('https://api-free.deepl.com/v2/translate');
    expect(resolved?.apiKey).toBe('uuid:fx');
  });
});

describe('deeplTargetLang', () => {
  it('maps fil to TL and uppercases the rest', () => {
    expect(deeplTargetLang('fil')).toBe('TL');
    expect(deeplTargetLang('en')).toBe('EN');
    expect(deeplTargetLang('de')).toBe('DE');
    expect(deeplTargetLang('es')).toBe('ES');
  });
});
