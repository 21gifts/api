/**
 * Cap and redact client-supplied passkey-renew fields before insert.
 * Applied on every passkey renew attempt write.
 */

const MESSAGE_MAX = 500;
const LONG_SECRET_RUN = /[A-Za-z0-9_-]{64,}/;

/**
 * Trim a passkey-renew text field, treat blank as null, and cap length.
 *
 * @param value - Client or header string, or `null`.
 * @param max - Maximum stored length after trim.
 * @returns The trimmed, capped string, or `null` when blank.
 */
export function capPasskeyRenewText(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Redact a passkey-renew message, inspecting the trimmed full string first.
 *
 * A run of 12 or more whitespace-separated tokens, or a base64url/hex run
 * of 64 or more characters, becomes `"[redacted]"` before any length cap.
 * Otherwise the trimmed string is capped at 500 characters. Empty becomes
 * `null`. Does not call {@link capPasskeyRenewText}.
 *
 * @param value - Client or server error string, or `null`.
 * @returns The capped message, `"[redacted]"`, or `null`.
 */
export function redactPasskeyRenewMessage(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.split(/\s+/).length >= 12 || LONG_SECRET_RUN.test(trimmed)) {
    return '[redacted]';
  }
  return trimmed.length > MESSAGE_MAX ? trimmed.slice(0, MESSAGE_MAX) : trimmed;
}

/**
 * Redact a renew field, then cap it. Used for name, code, message, and agent.
 *
 * @param value - Client or header string, or `null`.
 * @param max - Maximum stored length after redaction.
 * @returns The stored string, `[redacted]`, or `null`.
 */
export function redactPasskeyRenewField(value: string | null, max: number): string | null {
  const redacted = redactPasskeyRenewMessage(value);
  if (redacted === null || redacted === '[redacted]') {
    return redacted;
  }
  return capPasskeyRenewText(redacted, max);
}
