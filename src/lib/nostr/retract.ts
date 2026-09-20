/**
 * Best-effort NIP-09 retraction and Cloudflare media purge after a staff hide.
 *
 * Sign/publish/purge failures log and do not fail the HTTP 204. Never logs
 * nsec, KEK, Cloudflare token, or post text.
 */

import type { AuthStore } from '@/lib/auth/store';
import {
  forumMediaPurgeUrls,
  purgeCloudflareFiles,
  resolveCloudflarePurgeConfig,
} from '@/lib/cloudflare-purge';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { buildKind5Event } from '@/lib/nostr/event';
import type { NostrPublisher } from '@/lib/nostr/publish';
import { resolvePublicApiBase, resolveRelayPublic, resolveRelaySpace } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { RELAY_TIMEOUT_MS } from '@/lib/nostr/worker';

/** Collaborators for {@link retractHiddenForumNotes}. */
export interface RetractHiddenForumNotesDeps {
  /** Forum persistence. */
  store: MessageStore;
  /** Auth persistence (custodial nsec ciphertext). */
  authStore: AuthStore;
  /** EVENT publisher (space + public relays). */
  publisher: NostrPublisher;
  /** AES-256 KEK for the row author's nsec. */
  kek: Uint8Array;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Environment slice (relays, public API base, Cloudflare). */
  env: Record<string, string | undefined>;
  /** Injected `fetch` for Cloudflare purge. */
  fetchImpl: FetchFn;
}

/**
 * Relays for a kind:5: durability space first, then unique public URLs.
 *
 * Always includes the public list. Not gated on `NOSTR_PUBLISH` or
 * `NOSTR_PUBLISH_PUBLIC`.
 *
 * @param env - Environment slice.
 * @returns Space first, then unique public relay URLs.
 */
function retractRelayUrls(env: Record<string, string | undefined>): string[] {
  const spaceUrl = resolveRelaySpace(env);
  const seen = new Set<string>([spaceUrl]);
  const urls = [spaceUrl];
  for (const url of resolveRelayPublic(env)) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Publish NIP-09 kind:5 for hidden rows that have a stored `eventId`, then
 * purge cached media URLs for the target and its direct children.
 *
 * Missing target is a no-op. Rows with null/empty `eventId` or null
 * `accountId` are skipped. Per-row sign/publish failures log
 * `messages.delete.nostr_failed` with `{ messageId }` only. Purge runs when
 * Cloudflare env and `PUBLIC_BASE_URL` resolve; a failed batch logs
 * `messages.delete.purge_failed` with the target `{ messageId }`. Never
 * throws to the caller after those logs.
 *
 * @param deps - Store, auth, publisher, KEK, clock, env, fetch.
 * @param targetId - Hidden forum row id.
 * @returns Resolves when best-effort work has finished (or been skipped).
 */
export async function retractHiddenForumNotes(
  deps: RetractHiddenForumNotesDeps,
  targetId: string,
): Promise<void> {
  const target = await deps.store.getById(targetId);
  if (target === undefined) {
    return;
  }
  const children = await deps.store.listDirectChildren(targetId);
  const rows = [target, ...children];
  const urls = retractRelayUrls(deps.env);
  const createdAtUnix = Math.floor(deps.now() / 1000);
  for (const row of rows) {
    if (row.eventId === null || row.eventId === '' || row.accountId === null) {
      continue;
    }
    try {
      const template = buildKind5Event(row.eventId, createdAtUnix);
      const event = await signEventForAccount(deps.authStore, row.accountId, deps.kek, template);
      await deps.publisher.publish(
        event as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
    } catch {
      logEvent('messages.delete.nostr_failed', { messageId: row.id });
    }
  }
  const config = resolveCloudflarePurgeConfig(deps.env);
  const apiBase = resolvePublicApiBase(deps.env);
  if (config === null || apiBase === '') {
    return;
  }
  const combined: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const url of forumMediaPurgeUrls(apiBase, row)) {
      if (!seen.has(url)) {
        seen.add(url);
        combined.push(url);
      }
    }
  }
  if (combined.length === 0) {
    return;
  }
  try {
    await purgeCloudflareFiles(deps.fetchImpl, config, combined);
  } catch {
    logEvent('messages.delete.purge_failed', { messageId: target.id });
  }
}
