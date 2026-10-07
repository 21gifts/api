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

/** Trimmed, case-insensitive prefixes of encoded secret material. */
const SECRET_VALUE_PREFIXES: readonly string[] = [
  'nsec1',
  'xprv',
  'tprv',
  'yprv',
  'zprv',
  'uprv',
  'vprv',
];

/** BIP-39 phrase lengths we treat as secret-shaped. */
const BIP39_WORD_COUNTS: ReadonlySet<number> = new Set([12, 15, 18, 21, 24]);

/** One BIP-39-shaped word: 3–8 ASCII letters. */
const BIP39_WORD_RE = /^[A-Za-z]{3,8}$/;

/**
 * True when a body/prop key names secret material.
 *
 * @param name - Property or field name.
 * @returns Whether `name` contains a secret-material token (case-insensitive substring).
 */
export function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_FIELD_TOKENS.some((token) => lower.includes(token));
}

/**
 * True when a string value has the shape of secret material.
 *
 * @param value - Candidate string (trimmed before matching).
 * @returns Whether `value` looks like an encoded key or a BIP-39 phrase.
 */
export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (SECRET_VALUE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  const words = trimmed.split(/\s+/);
  if (!BIP39_WORD_COUNTS.has(words.length)) {
    return false;
  }
  return words.every((word) => BIP39_WORD_RE.test(word));
}
