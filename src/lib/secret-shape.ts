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

/** One BIP-39-shaped word: 3–8 ASCII letters. */
const BIP39_WORD_RE = /^[A-Za-z]{3,8}$/;

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
 * twelve consecutive words of 3–8 ASCII letters, whatever non-alphanumeric
 * characters separate them (spaces, slashes, commas, dashes). A sentence with a
 * shorter word, a digit, or fewer than twelve such words in a row is kept.
 *
 * @param value - Candidate string.
 * @returns Whether `value` holds an encoded key or a recovery-phrase-shaped word run.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (ENCODED_KEY_RE.test(value)) {
    return true;
  }
  let run = 0;
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
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
