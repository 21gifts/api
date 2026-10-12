import { createHmac } from 'node:crypto';

/**
 * Expected `addressRef` on a console line: first 12 hex characters of
 * HMAC-SHA256 over the lower-cased address.
 *
 * @param address - Lightning Address as passed to `logEvent`.
 * @param key - Key installed with `setAddressRefKey`.
 * @returns Twelve lower-case hex characters.
 */
export function expectedAddressRef(address: string, key: string): string {
  return createHmac('sha256', key).update(address.toLowerCase()).digest('hex').slice(0, 12);
}
