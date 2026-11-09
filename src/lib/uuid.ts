/**
 * Shape check for ids from `crypto.randomUUID()` (lowercase
 * eight-four-four-four-twelve), shared by stores and routes that must not
 * hand a malformed id to a Postgres `uuid` cast.
 */

/** A UUID in any letter case: eight-four-four-four-twelve hexadecimal characters. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lowercase a value that has the UUID shape.
 *
 * @param value - Candidate id, for example a path or query parameter.
 * @returns The lowercase id, or `null` when the value is not a UUID.
 */
export function normalizeUuid(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}
