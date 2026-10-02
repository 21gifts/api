/**
 * Lightning Address (LUD-16) validation.
 *
 * Only the `local@domain.tld` shape is checked here (guest pay lookups and
 * spend-worker address queries).
 */

/** Matches a Lightning Address: `local-part@domain.tld`. */
const LIGHTNING_ADDRESS = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validate and normalise a Lightning Address (LUD-16).
 *
 * @param raw - The address as entered by the user.
 * @returns The trimmed address, or `null` when it is not a valid address.
 */
export function normalizeLightningAddress(raw: string): string | null {
  const trimmed = raw.trim();
  // Bound the input so an over-long address cannot be stored and re-served on
  // every /me response; 255 comfortably exceeds any real LUD-16 address.
  if (trimmed.length > 255) {
    return null;
  }
  return LIGHTNING_ADDRESS.test(trimmed) ? trimmed : null;
}
