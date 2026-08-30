/**
 * VAPID configuration for self-hosted Web Push.
 *
 * Missing or blank keys yield `null` so the process still boots; push HTTP
 * returns 503 until both keys are set.
 */

/** Resolved VAPID credentials used by the Web Push sender. */
export interface VapidConfig {
  /** URL-safe base64 P-256 public key (uncompressed). Not a secret. */
  publicKey: string;
  /** URL-safe base64 P-256 private key. Secret — never log. */
  privateKey: string;
  /** Contact / subject URI for VAPID (default `https://21.gifts`). */
  subject: string;
}

/**
 * Decode URL-safe base64 (padding optional) to bytes.
 *
 * @param value - URL-safe base64 string.
 * @returns Bytes, or `null` when the alphabet is invalid.
 */
function decodeUrlSafeBase64(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  try {
    const buf = Buffer.from(`${padded}${pad}`, 'base64');
    if (buf.length === 0 && value.trim() !== '') {
      return null;
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Resolve VAPID credentials from an environment slice.
 *
 * Missing, blank, or malformed keys/subject yield `null` so the process
 * still boots; push HTTP returns 503. Public key must decode to 65 bytes
 * (uncompressed P-256), private key to 32 bytes. Subject must be `https:`
 * or `mailto:` so `web-push` `setVapidDetails` cannot throw at boot.
 *
 * @param env - Process environment (injected so tests need not mutate it).
 * @returns Config when both keys and the subject are usable; otherwise `null`.
 */
export function resolveVapidConfig(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = env['VAPID_PUBLIC_KEY'];
  const privateKey = env['VAPID_PRIVATE_KEY'];
  if (
    publicKey === undefined ||
    publicKey.trim() === '' ||
    privateKey === undefined ||
    privateKey.trim() === ''
  ) {
    return null;
  }
  const subjectRaw = env['VAPID_SUBJECT'];
  const subject =
    subjectRaw !== undefined && subjectRaw.trim() !== '' ? subjectRaw.trim() : 'https://21.gifts';
  if (!/^https:/i.test(subject) && !/^mailto:/i.test(subject)) {
    return null;
  }
  const pubBytes = decodeUrlSafeBase64(publicKey.trim());
  const privBytes = decodeUrlSafeBase64(privateKey.trim());
  if (pubBytes === null || pubBytes.length !== 65 || pubBytes[0] !== 4) {
    return null;
  }
  if (privBytes === null || privBytes.length !== 32) {
    return null;
  }
  return {
    publicKey: publicKey.trim(),
    privateKey: privateKey.trim(),
    subject,
  };
}
