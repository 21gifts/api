import { createHash } from 'node:crypto';

/** UTF-8 label hashed for WebAuthn `extensions.prf.eval.first`. */
export const PRF_EVAL_FIRST_LABEL = '21gifts-nostr-v1';

/**
 * SHA-256 of {@link PRF_EVAL_FIRST_LABEL} as the PRF `eval.first` salt.
 *
 * @returns 32 bytes. The api never sees PRF output.
 */
export function prfEvalFirstSalt(): Uint8Array {
  return new Uint8Array(createHash('sha256').update(PRF_EVAL_FIRST_LABEL, 'utf8').digest());
}
