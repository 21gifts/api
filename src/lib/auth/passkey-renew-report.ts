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

/** Public authenticator attachment the browser may report. */
export type PasskeyRenewAttachment = 'platform' | 'cross-platform';

/**
 * Safe authenticator facts stored beside a renew error. No credential id,
 * attestation, challenge, or PRF output.
 *
 * `authenticatorFlags` is the WebAuthn flags byte: UP 0x01, UV 0x04,
 * BE 0x08 (synced / backup-eligible), BS 0x10, AT 0x40, ED 0x80.
 */
export interface PasskeyRenewDebugFields {
  /** `platform` or `cross-platform`, or `null`. */
  authenticatorAttachment: PasskeyRenewAttachment | null;
  /** Sorted allowlisted transports, comma-separated, or `null`. */
  transports: string | null;
  /** 32 lowercase hex authenticator AAGUID, or `null`. */
  aaguid: string | null;
  /** `prf.enabled` when the browser reported a boolean, or `null`. */
  prfEnabled: boolean | null;
  /** Whether PRF output was present. `null` when the browser did not say. */
  prfPresent: boolean | null;
  /** Sorted allowlisted extension names, comma-separated, or `null`. */
  extensions: string | null;
  /** Flags byte 0–255, or `null`. */
  authenticatorFlags: number | null;
  /** COSE public-key algorithm, or `null`. */
  publicKeyAlgorithm: number | null;
  /** `credProps.rk`, or `null`. */
  residentKey: boolean | null;
  /** hmac-secret supported, or `null`. */
  hmacSecret: boolean | null;
  /** Allowlisted credProtect policy, or `null`. */
  credProtect: string | null;
  /** Sorted browser capability names that were true, or `null`. */
  clientCapabilities: string | null;
}

const ATTACHMENTS = new Set<string>(['platform', 'cross-platform']);
const TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
const EXTENSIONS = [
  'credProps',
  'credProtect',
  'credentialProtectionPolicy',
  'hmacCreateSecret',
  'largeBlob',
  'minPinLength',
  'prf',
  'uvm',
] as const;
const CRED_PROTECT = new Set<string>([
  'userVerificationOptional',
  'userVerificationOptionalWithCredentialIDList',
  'userVerificationRequired',
]);
const CRED_PROTECT_BY_CODE = [
  '',
  'userVerificationOptional',
  'userVerificationOptionalWithCredentialIDList',
  'userVerificationRequired',
] as const;
const CAPABILITY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const MAX_CAPABILITIES = 24;

/**
 * Keep only allowlisted authenticator facts. A bad value becomes `null`
 * so it cannot replace the failure row with a 400.
 *
 * @param input - Client debug fields. Wrong types are ignored.
 * @returns Facts safe to store.
 */
export function sanitizePasskeyRenewDebug(input: {
  authenticatorAttachment: unknown;
  transports: unknown;
  aaguid: unknown;
  prfEnabled: unknown;
  prfPresent: unknown;
  extensions: unknown;
  authenticatorFlags: unknown;
  publicKeyAlgorithm: unknown;
  residentKey: unknown;
  hmacSecret: unknown;
  credProtect: unknown;
  clientCapabilities: unknown;
}): PasskeyRenewDebugFields {
  const attachment = input.authenticatorAttachment;
  return {
    authenticatorAttachment:
      typeof attachment === 'string' && ATTACHMENTS.has(attachment)
        ? (attachment as PasskeyRenewAttachment)
        : null,
    transports: allowlistedTokens(input.transports, TRANSPORTS),
    aaguid: normalizeAaguid(input.aaguid),
    prfEnabled: asBoolean(input.prfEnabled),
    prfPresent: asBoolean(input.prfPresent),
    extensions: allowlistedTokens(input.extensions, EXTENSIONS),
    authenticatorFlags: asBoundedInt(input.authenticatorFlags, 0, 255),
    publicKeyAlgorithm: asBoundedInt(input.publicKeyAlgorithm, -65536, 65535),
    residentKey: asBoolean(input.residentKey),
    hmacSecret: asBoolean(input.hmacSecret),
    credProtect: credProtectOf(input.credProtect),
    clientCapabilities: capabilitiesOf(input.clientCapabilities),
  };
}

/**
 * Keep a boolean. Every other JSON value, including `null`, becomes `null`.
 *
 * @param value - Client field.
 * @returns The boolean, or `null`.
 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Keep an integer inside inclusive bounds.
 *
 * @param value - Client field.
 * @param min - Lowest stored integer.
 * @param max - Highest stored integer.
 * @returns The integer, or `null`.
 */
function asBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/**
 * Map a credProtect policy name or its WebAuthn numeric code.
 *
 * @param value - Client field.
 * @returns An allowlisted policy name, or `null`.
 */
function credProtectOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const mapped = CRED_PROTECT_BY_CODE[value];
    return mapped === undefined || mapped === '' ? null : mapped;
  }
  if (typeof value === 'string' && CRED_PROTECT.has(value)) {
    return value;
  }
  return null;
}

/**
 * Keep true capability names. Cap the list so the column check cannot fail.
 *
 * @param value - Comma-separated client string, or anything else.
 * @returns Sorted names, or `null`.
 */
function capabilitiesOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const kept = new Set<string>();
  for (const part of value.split(',')) {
    const token = part.trim();
    if (CAPABILITY.test(token)) {
      kept.add(token);
    }
  }
  if (kept.size === 0) {
    return null;
  }
  return [...kept].sort().slice(0, MAX_CAPABILITIES).join(',');
}

/**
 * Keep allowlisted tokens, drop the rest, and store them sorted and unique.
 *
 * @param value - Comma-separated client string, or `null`.
 * @param allowed - Tokens the column may store.
 * @returns The stored list, or `null` when none remain.
 */
function allowlistedTokens(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const permitted = new Set(allowed);
  const kept = new Set<string>();
  for (const part of value.split(',')) {
    const token = part.trim();
    if (permitted.has(token)) {
      kept.add(token);
    }
  }
  if (kept.size === 0) {
    return null;
  }
  return [...kept].sort().join(',');
}

/**
 * Accept a 32-hex AAGUID, or a hyphenated UUID of those same bytes.
 *
 * @param value - Client string, or `null`.
 * @returns Lowercase hex without hyphens, or `null`.
 */
function normalizeAaguid(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const compact = value.trim().toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(compact) ? compact : null;
}
