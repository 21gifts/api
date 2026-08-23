/**
 * Decode the amount embedded in a mainnet BOLT11 invoice HRP.
 *
 * Amount-prefix only: no signature verification. Used by the daily-gifts
 * payout worker to independently confirm an LNURL-pay invoice matches the
 * intended satoshi amount before paying.
 */

/** Result of decoding a BOLT11 amount prefix into integer satoshis. */
export type Bolt11AmountResult =
  { ok: true; sats: number } | { ok: false; reason: 'no_amount' | 'invalid' };

/**
 * Decode integer satoshis from a mainnet BOLT11 invoice string.
 *
 * Only `lnbc` (mainnet) is accepted. The amount is the HRP prefix before the
 * bech32 `1` separator. Multipliers: m/u/n/p; bare digits mean full BTC.
 * Pico/nano amounts that do not divide evenly into integer sats are invalid.
 *
 * @param bolt11 - Raw BOLT11 string (case-insensitive).
 * @returns Integer sats, `no_amount` when the invoice has no amount, or `invalid`.
 */
export function decodeBolt11AmountSats(bolt11: string): Bolt11AmountResult {
  if (bolt11 === '') {
    return { ok: false, reason: 'invalid' };
  }
  const s = bolt11.toLowerCase();
  if (!s.startsWith('lnbc')) {
    return { ok: false, reason: 'invalid' };
  }

  const rest = s.slice(4);
  // Bech32 separator is `1` after the optional amount. Amount digits may
  // themselves be `1` (`lnbc11…` = 1 BTC), so do not take the first `1`.
  const withAmount = /^(\d+)([munp])?1/.exec(rest);
  if (withAmount === null) {
    // Empty amount: `lnbc1` + bech32 data. Two or more leading digits that
    // failed the amount parse (e.g. `lnbc12x1…`) are invalid, not no_amount.
    if (/^1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]/.test(rest) && !/^\d{2}/.test(rest)) {
      return { ok: false, reason: 'no_amount' };
    }
    return { ok: false, reason: 'invalid' };
  }

  const digits = withAmount[1] ?? /* v8 ignore next */ '';
  const multiplier = withAmount[2] ?? null;
  /* v8 ignore next 3 — capture group 1 is `\d+`, so digits is never empty */
  if (digits === '') {
    return { ok: false, reason: 'invalid' };
  }

  const amount = BigInt(digits);
  let sats: bigint;
  switch (multiplier) {
    case 'm':
      sats = amount * 100_000n;
      break;
    case 'u':
      sats = amount * 100n;
      break;
    case 'n':
      if (amount % 10n !== 0n) {
        return { ok: false, reason: 'invalid' };
      }
      sats = amount / 10n;
      break;
    case 'p':
      if (amount % 10_000n !== 0n) {
        return { ok: false, reason: 'invalid' };
      }
      sats = amount / 10_000n;
      break;
    case null:
      sats = amount * 100_000_000n;
      break;
    /* v8 ignore next 2 — multiplier is only m/u/n/p or null */
    default:
      return { ok: false, reason: 'invalid' };
  }

  /* v8 ignore next 3 — amount digits are non-negative and below MAX_SAFE_INTEGER for real invoices */
  if (sats < 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, sats: Number(sats) };
}
