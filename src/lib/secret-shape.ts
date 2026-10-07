/** Substrings that mark a body/prop key as secret material (matched case-insensitively). */
const SECRET_FIELD_TOKENS: readonly string[] = [
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
];

/** An encoded key (`nsec1…`, `xprv…` and the other extended private key prefixes) starting a token. */
const ENCODED_KEY_RE = /(?:^|[^A-Za-z0-9])(?:nsec1|[xtyzuv]prv)[A-Za-z0-9]/i;

/** Shortest run of consecutive phrase-shaped words treated as a recovery phrase (BIP-39 minimum). */
const PHRASE_MIN_WORDS = 12;

/**
 * One BIP-39-shaped word in any of the official wordlists: 3–8 letters of any
 * script (English and the accented Latin lists), or 1–8 Han, Hiragana,
 * Katakana, or Hangul characters (Chinese, Japanese, and Korean lists).
 */
const BIP39_WORD_RE =
  /^(?:\p{L}{3,8}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{1,8})$/u;

/**
 * True when a body/prop key names secret material.
 *
 * @param name - Property or field name.
 * @returns Whether `name`, lower-cased with every non-alphanumeric character removed, contains a
 *   secret-material token.
 */
export function isSecretFieldName(name: string): boolean {
  // `spending_key`, `priv-key`, and `x.prv` name the same material as `spendingkey`, `privkey`, and `xprv`.
  const normalised = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_FIELD_TOKENS.some((token) => normalised.includes(token));
}

/**
 * True when a string value contains secret material anywhere in it.
 *
 * Flags a token that starts with `nsec1` or an extended private key prefix
 * (`xprv`, `tprv`, `yprv`, `zprv`, `uprv`, `vprv`), and any run of at least
 * twelve consecutive recovery-phrase-shaped words in any official BIP-39
 * language (3–8 letters, or 1–8 CJK or Hangul characters), whatever
 * non-alphanumeric characters separate them (spaces, the ideographic space,
 * slashes, commas, dashes). A sentence with a shorter word, a digit, or fewer
 * than twelve such words in a row is kept.
 *
 * @param value - Candidate string.
 * @returns Whether `value` holds an encoded key or a recovery-phrase-shaped word run.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (ENCODED_KEY_RE.test(value)) {
    return true;
  }
  let run = 0;
  // Any non-letter, non-digit separates words, the ideographic space of Japanese phrases included.
  for (const token of value.split(/[^\p{L}\p{N}]+/u)) {
    if (token === '') {
      continue;
    }
    run = BIP39_WORD_RE.test(token) ? run + 1 : 0;
    if (run >= PHRASE_MIN_WORDS) {
      return true;
    }
  }
  return false;
}
