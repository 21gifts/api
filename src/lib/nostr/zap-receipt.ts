/**
 * NIP-57 zap receipts (kind 9735) for zap invoices settled by a Spark transfer.
 *
 * The receipt is signed with the per-member receipt key that the self-hosted
 * LNURL server advertises as `nostrPubkey` for that member, so the existing
 * receipt ingest accepts it exactly like one the LNURL server published.
 */

import { createHmac } from 'node:crypto';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';

/** Order of the secp256k1 group; a secret key must lie in `[1, n - 1]`. */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Domain prefix of the receipt key derivation. */
const RECEIPT_KEY_DOMAIN = 'lnurl-zap-receipt-key:';

/**
 * Derive the receipt signing key of one member.
 *
 * HMAC-SHA256 keyed with the server nsec over the ASCII prefix
 * `lnurl-zap-receipt-key:`, the lower-case hex of the member's wallet key, and
 * one counter byte. The counter starts at 0 and the first digest that is a
 * valid secp256k1 secret key is taken.
 *
 * @param serverNsec - 32-byte server secret (`LNURL_ZAP_NSEC_HEX`).
 * @param sparkPubkey - Member's wallet identity key (66 hex).
 * @returns 32-byte secret key.
 * @throws Error when no counter value yields a valid key (practically unreachable).
 */
export function zapReceiptSecretKey(serverNsec: Uint8Array, sparkPubkey: string): Uint8Array {
  const prefix = new TextEncoder().encode(`${RECEIPT_KEY_DOMAIN}${sparkPubkey.toLowerCase()}`);
  for (let counter = 0; counter < 256; counter += 1) {
    const digest = createHmac('sha256', serverNsec)
      .update(prefix)
      .update(Uint8Array.of(counter))
      .digest();
    const value = BigInt(`0x${digest.toString('hex')}`);
    if (value > 0n && value < SECP256K1_ORDER) {
      return new Uint8Array(digest);
    }
  }
  throw new Error('No valid zap receipt key');
}

/** Arguments for {@link buildZapReceipt}. */
export interface BuildZapReceiptArgs {
  /** Receipt signing key from {@link zapReceiptSecretKey}. */
  secretKey: Uint8Array;
  /** The paid zap BOLT11. */
  bolt11: string;
  /** Exact zap request string the BOLT11 commits to. */
  zapRequestJson: string;
}

/**
 * Build and sign a kind 9735 receipt for a paid zap invoice.
 *
 * Tags: `p` (recipient from the zap request), `P` (zap request pubkey), `e`
 * (zapped event) when the zap request has one, `bolt11`, and `description`
 * (the exact zap request string). No `preimage` tag; content is empty.
 * `created_at` is the zap request's `created_at`, so the same zap invoice and
 * key always give the same receipt id.
 *
 * @param args - Key, invoice, and zap request string.
 * @returns The signed receipt and the relays named in the zap request, or
 *   `null` when the zap request is not a kind 9734 object with a pubkey, a
 *   non-negative integer `created_at`, and a `p` tag.
 * @throws Error when `secretKey` is not a valid secp256k1 secret key.
 */
export function buildZapReceipt(
  args: BuildZapReceiptArgs,
): { event: VerifiedEvent; relays: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.zapRequestJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const request = parsed as Record<string, unknown>;
  const tags = Array.isArray(request['tags']) ? (request['tags'] as unknown[]) : [];
  const tagValue = (name: string): string | undefined => {
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === 'string' && tag[1] !== '') {
        return tag[1];
      }
    }
    return undefined;
  };
  const pubkey = request['pubkey'];
  const createdAt = request['created_at'];
  const recipient = tagValue('p');
  if (
    request['kind'] !== 9734 ||
    typeof pubkey !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    recipient === undefined
  ) {
    return null;
  }
  const relays: string[] = [];
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'relays') {
      for (const url of tag.slice(1)) {
        if (typeof url === 'string' && url !== '' && !relays.includes(url)) {
          relays.push(url);
        }
      }
    }
  }
  const eventId = tagValue('e');
  const event = finalizeEvent(
    {
      kind: 9735,
      created_at: createdAt,
      content: '',
      tags: [
        ['p', recipient],
        ['P', pubkey],
        ...(eventId === undefined ? [] : [['e', eventId]]),
        ['bolt11', args.bolt11],
        ['description', args.zapRequestJson],
      ],
    },
    args.secretKey,
  );
  return { event, relays };
}
