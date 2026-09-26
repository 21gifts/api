/**
 * NIP-19 share URIs for published forum notes (`nostr:nevent1…`).
 */

import { neventEncode } from 'nostr-tools/nip19';
import { resolveWriteSet } from '@/lib/nostr/relays';

/** Event id / author pubkey must be exactly 64 lowercase hex (no trim). */
const HEX64 = /^[0-9a-f]{64}$/;

function isHex64(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** Trim, keep `wss://`, first-wins dedupe, cap 3. */
function filterRelayHints(relays: readonly string[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entry of relays) {
    const url = entry.trim();
    if (url === '') {
      continue;
    }
    if (!url.startsWith('wss://')) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
    if (urls.length >= 3) {
      break;
    }
  }
  return urls;
}

/**
 * `nostr:nevent1...` or null when either id is missing or not 64 lowercase hex.
 *
 * @param eventId - Signed kind:1 id, or null/undefined until signed.
 * @param authorPubkey - Author hex pubkey, or null/undefined when unknown.
 * @param relays - Candidate relay hints (trimmed, `wss://` only, first-wins, cap 3).
 * @returns `nostr:` plus the NIP-19 nevent, or `null`. Kind is never set.
 */
export function nostrNoteUri(
  eventId: string | null | undefined,
  authorPubkey: string | null | undefined,
  relays: readonly string[],
): string | null {
  if (!isHex64(eventId) || !isHex64(authorPubkey)) {
    return null;
  }
  const hints = filterRelayHints(relays);
  const encoded =
    hints.length > 0
      ? neventEncode({ id: eventId, author: authorPubkey, relays: hints })
      : neventEncode({ id: eventId, author: authorPubkey });
  return `nostr:${encoded}`;
}

/**
 * Public write relays when public publish is on; otherwise the one durability relay.
 *
 * @param env - Environment slice (defaults to `process.env`).
 * @returns `writeSet.publicUrls` when `NOSTR_PUBLISH_PUBLIC === '1'`, else `[spaceUrl]`.
 */
export function publicNoteRelays(env: NodeJS.ProcessEnv = process.env): string[] {
  const writeSet = resolveWriteSet(env);
  if (writeSet.publicEnabled) {
    return [...writeSet.publicUrls];
  }
  return [writeSet.spaceUrl];
}
