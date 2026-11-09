/**
 * Identity public key of a member's self-custodial in-app wallet.
 *
 * Compressed secp256k1: 66 lower-case hex characters starting with `02` or
 * `03`. Used when binding a wallet to an account and when forwarding LNURL
 * routes for that key.
 */

/** Compressed secp256k1 pubkey: `02`/`03` + 64 hex digits. */
const SPARK_PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * Trim, lower-case, and validate a wallet identity public key.
 *
 * @param raw - Hex pubkey as entered or received on a path.
 * @returns The normalised 66-character hex string, or `null` when invalid.
 */
export function normalizeSparkPubkey(raw: string): string | null {
  const normalised = raw.trim().toLowerCase();
  if (!SPARK_PUBKEY.test(normalised)) {
    return null;
  }
  return normalised;
}
