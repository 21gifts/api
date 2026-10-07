import { describe, expect, it } from 'vitest';
import { isSecretFieldName, looksLikeSecretValue } from '@/lib/secret-shape';

describe('isSecretFieldName', () => {
  it.each([
    'seed',
    'mnemonic',
    'phrase',
    'preimage',
    'private',
    'privkey',
    'secret',
    'prf',
    'nsec',
    'xprv',
    'password',
    'passphrase',
    'spendingkey',
  ])('matches the token %s as a case-insensitive substring', (token) => {
    expect(isSecretFieldName(token)).toBe(true);
    expect(isSecretFieldName(token.toUpperCase())).toBe(true);
    expect(isSecretFieldName(`my_${token}_value`)).toBe(true);
  });

  it('matches compound names used in client bodies', () => {
    expect(isSecretFieldName('privateKey')).toBe(true);
    expect(isSecretFieldName('spendingKey')).toBe(true);
    expect(isSecretFieldName('recoveryPhrase')).toBe(true);
  });

  it('rejects names that do not contain a secret token', () => {
    expect(isSecretFieldName('screen')).toBe(false);
    expect(isSecretFieldName('query')).toBe(false);
    expect(isSecretFieldName('')).toBe(false);
    expect(isSecretFieldName('proof')).toBe(false);
  });
});

describe('looksLikeSecretValue', () => {
  it.each(['nsec1', 'xprv', 'tprv', 'yprv', 'zprv', 'uprv', 'vprv'])(
    'detects a value starting with %s',
    (prefix) => {
      expect(looksLikeSecretValue(`${prefix}abc`)).toBe(true);
      expect(looksLikeSecretValue(`  ${prefix.toUpperCase()}abc  `)).toBe(true);
    },
  );

  it.each([12, 15, 18, 21, 24])('detects a %s-word BIP-39-shaped phrase', (count) => {
    const words = Array.from({ length: count }, () => 'abandon');
    expect(looksLikeSecretValue(words.join(' '))).toBe(true);
    expect(looksLikeSecretValue(`  ${words.join('\t')}  `)).toBe(true);
  });

  it('detects a key or a phrase anywhere in a longer value, whatever separates the words', () => {
    const phrase = Array.from({ length: 12 }, () => 'abandon');
    expect(looksLikeSecretValue(`my words are ${phrase.join(' ')} ok`)).toBe(true);
    expect(looksLikeSecretValue(`/wallet/${phrase.join('/')}/done`)).toBe(true);
    expect(looksLikeSecretValue(phrase.join(',  '))).toBe(true);
    expect(looksLikeSecretValue([...phrase, 'about'].join(' '))).toBe(true);
    expect(looksLikeSecretValue('key: nsec1abc and more')).toBe(true);
    expect(looksLikeSecretValue('/u/XPRVabc')).toBe(true);
  });

  it('keeps ordinary sentences and single tokens that only contain a prefix', () => {
    expect(
      looksLikeSecretValue('Thanks for the coffee this morning, see you at the market next week'),
    ).toBe(false);
    expect(looksLikeSecretValue('lnbc1xprvabc')).toBe(false);
    expect(looksLikeSecretValue('alice@21.gifts')).toBe(false);
  });

  it('rejects values that are neither encoded keys nor BIP-39-shaped', () => {
    expect(looksLikeSecretValue('home')).toBe(false);
    expect(looksLikeSecretValue('nxprvabc')).toBe(false);
    expect(looksLikeSecretValue('nsec')).toBe(false);
    expect(looksLikeSecretValue('')).toBe(false);
    expect(looksLikeSecretValue('   ')).toBe(false);
    const eleven = Array.from({ length: 11 }, () => 'abandon');
    expect(looksLikeSecretValue(eleven.join(' '))).toBe(false);
    const shortWord = Array.from({ length: 12 }, () => 'abandon');
    shortWord[0] = 'ab';
    expect(looksLikeSecretValue(shortWord.join(' '))).toBe(false);
    const longWord = Array.from({ length: 12 }, () => 'abandon');
    longWord[0] = 'abcdefghi';
    expect(looksLikeSecretValue(longWord.join(' '))).toBe(false);
    const numbered = Array.from({ length: 12 }, () => 'abandon');
    numbered[0] = 'aban1on';
    expect(looksLikeSecretValue(numbered.join(' '))).toBe(false);
  });
});
