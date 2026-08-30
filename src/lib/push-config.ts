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
 * Resolve VAPID credentials from an environment slice.
 *
 * @param env - Process environment (injected so tests need not mutate it).
 * @returns Config when both keys are non-blank after trim; otherwise `null`.
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
  return {
    publicKey: publicKey.trim(),
    privateKey: privateKey.trim(),
    subject,
  };
}
