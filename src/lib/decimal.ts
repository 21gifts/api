/**
 * The canonical decimal form shared by stored ask amounts
 * (`canonicalGoalAmount`) and the shop payment amounts (`decimalAmount`,
 * `btcAmount`): string editing only, never `parseFloat`.
 */

/**
 * Edit a decimal string into the canonical form, with at most
 * `maxDecimals` fractional digits.
 *
 * Trim, then accept comma or dot. The result is a dot decimal with no
 * exponent, no leading zeros, no trailing fractional zeros, and no point
 * for a whole number (`00010.10` → `10.1`, `0.10` → `0.1`, `10.` → `10`).
 *
 * @param raw - Digits with an optional comma or dot fraction.
 * @param maxDecimals - Most fractional digits accepted (non-negative integer).
 * @returns The canonical string, or `null` when the grammar fails or the
 *   fraction has more than `maxDecimals` digits.
 */
export function canonicalDecimal(raw: string, maxDecimals: number): string | null {
  const trimmed = raw.trim();
  if (!new RegExp(`^\\d+([.,]\\d{0,${maxDecimals}})?$`).test(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(',', '.');
  const dot = normalized.indexOf('.');
  const wholeRaw = dot === -1 ? normalized : normalized.slice(0, dot);
  const fracRaw = dot === -1 ? '' : normalized.slice(dot + 1);
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}
