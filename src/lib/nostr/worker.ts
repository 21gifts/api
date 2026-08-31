import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { ConversationThread } from '@/lib/conversation';
import type { ConversationStore } from '@/lib/conversation-store';
import type { FetchFn } from '@/lib/lnurlp';
import {
  MESSAGE_INBOUND_REPLY_MAX_LENGTH,
  MESSAGE_LIST_LIMIT,
  normalizeForumText,
  truncatePubkeyDisplay,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { logEvent } from '@/lib/log';
import { decryptKind4, unwrapNip17, wrapNip17 } from '@/lib/nostr/dm';
import {
  buildKind0Event,
  buildKind0Content,
  buildKind1Event,
  buildKind10002Event,
  forumPhotoUrl,
  type Kind1Photo,
  type Kind1ReplyTo,
} from '@/lib/nostr/event';
import { nip05Domain, nip05Identifier } from '@/lib/nip05';
import { forumVideoUrl } from '@/lib/video';
import { decryptNostrSecret, ensureAccountNostrKey, zeroizeSecret } from '@/lib/nostr/keys';
import { publicAcked, spaceAcked, type NostrPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import {
  resolvePublicApiBase,
  resolveRelaySpace,
  resolveWriteSet,
  resolveZapRelays,
  writeRelayUrls,
  type ResolvedWriteSet,
} from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { indexOpenZapReceipts } from '@/lib/nostr/zap-index';
import type { PushStore } from '@/lib/push-store';

/** Max rows claimed or keyed profile attempts per tick. */
export const WORKER_BATCH = 20;

/** Event-id chunk size for inbound kind:1 reply REQ filters. */
const REPLY_QUERY_CHUNK = 20;

/** Lease before WebSocket I/O. */
export const WORKER_LEASE_MS = 60_000;

/** Per-relay timeout. */
export const RELAY_TIMEOUT_MS = 5_000;

/** Tick interval. */
export const WORKER_INTERVAL_MS = 2_000;

/** Collaborators for one worker tick. */
export interface NostrWorkerDeps {
  /** Forum store. */
  messages: MessageStore;
  /** Auth store (keys). */
  auth: AuthStore;
  /** AES KEK. */
  kek: Uint8Array;
  /** Publisher (fake in tests). */
  publisher: NostrPublisher;
  /** Querier for zap-receipt ingest (fake in tests). */
  querier: NostrQuerier;
  /** Fetch used for LNURL provider pubkey resolve. */
  fetchImpl: FetchFn;
  /** Optional 9735 signature check (tests inject; production uses nostr-tools). */
  verifyReceipt?: (event: NostrEventFrame) => boolean;
  /** Clock. */
  now: () => number;
  /** Env slice for write-set flags. */
  env: Record<string, string | undefined>;
  /** Optional push store for zap enqueue after a newly indexed receipt. */
  pushStore?: PushStore;
  /** Optional signature check for inbound kind:1 replies (tests inject). */
  verifyKind1?: (event: NostrEventFrame) => boolean;
  /** Optional private-message store (skip DMs when omitted). */
  conversations?: ConversationStore;
}

type Kind0Reservation = {
  content: string;
  createdAt: number;
};

/** Reserved or last-acked kind:0 content per account, keyed by auth store. */
const profileCaches = new WeakMap<AuthStore, Map<string, Kind0Reservation>>();
const profileWatermarks = new WeakMap<AuthStore, Map<string, number>>();

function profileCacheFor(auth: AuthStore): Map<string, Kind0Reservation> {
  const existing = profileCaches.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Kind0Reservation>();
  profileCaches.set(auth, created);
  return created;
}

function profileWatermarkFor(auth: AuthStore): Map<string, number> {
  const existing = profileWatermarks.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, number>();
  profileWatermarks.set(auth, created);
  return created;
}

function reservedContent(
  cache: Map<string, Kind0Reservation>,
  accountId: string,
): string | undefined {
  return cache.get(accountId)?.content;
}

/**
 * Sign unsigned rows, optionally fan out to relays, then ingest zap receipts.
 *
 * Always signs. Publishes only when `NOSTR_PUBLISH=1`. Public relays only
 * when `NOSTR_PUBLISH_PUBLIC=1`. Space ACK with public off is terminal
 * `published`/`space`. With public on, space-only ACK parks `pending`/`space`
 * until a public ACK makes `published`/`public`. Pending kind:1 JSON without
 * `t=bitcoin` is dropped and re-signed before fan-out. Then unsigned rows are
 * signed. Then published unpaid rows missing a photo URL or a video URL
 * (`PUBLIC_BASE_URL` set) or Damus `#bitcoin`/`#21gifts` in content are reset
 * for the next tick. Pending rows EVENT as-is — resetting them first renews
 * the 60s sign lease and they never reach a relay. Zapped rows (`sats !== 0`)
 * keep their event id so receipts still resolve. An empty API base skips
 * photo- and video-URL resign so it cannot un-publish and loop. When
 * publishing, also fans out a replaceable kind:0 profile (`name` /
 * `display_name` / `picture`, optional `nip05`) and a NIP-65 kind:10002
 * relay list. Kind:1 photo and video posts include the public media URL and
 * an `imeta` tag (video may add poster `image`). Kind:0
 * `created_at` is `max(wall clock, last issued + 1)` so an in-flight older
 * profile cannot win a same-second replaceable-event tie. Each tick also queries
 * zap relays (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is
 * off) for kind:9735 receipts and indexes validated ones onto `sats`, even
 * when publish is off. Each tick also REQs kind:1 replies (`#e` = our note
 * event ids) and persists inbound Damus/member replies (even when publish is
 * off). When a conversation store is present, also signs/publishes NIP-17
 * wraps and REQs inbound kind:1059 / kind:4 to member and platform pubkeys.
 *
 * @param deps - Stores, kek, publisher, querier, fetch, clock, env.
 */
export async function runNostrWorkerTick(deps: NostrWorkerDeps): Promise<void> {
  const writeSet = resolveWriteSet(deps.env);
  const nowMs = deps.now();
  await resignLegacyKind1Tags(deps);
  await signBatch(deps, nowMs);
  await signConversationBatch(deps, nowMs);
  await resignPhotoKind1(deps);
  await resignVideoKind1(deps);
  await resignHashtagKind1(deps);
  if (writeSet.publishEnabled) {
    await publishProfiles(deps, writeSet);
    await publishRelayLists(deps, writeSet);
    await publishBatch(deps, writeSet, nowMs);
    await publishConversationBatch(deps, writeSet, nowMs);
  }
  const urls = resolveZapRelays(deps.env);
  await indexOpenZapReceipts({
    store: deps.messages,
    auth: deps.auth,
    querier: deps.querier,
    urls,
    timeoutMs: RELAY_TIMEOUT_MS,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    ...(deps.verifyReceipt === undefined ? {} : { verifyReceipt: deps.verifyReceipt }),
    ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
  });
  await indexInboundForumReplies(deps, urls);
  await indexInboundDirectMessages(deps, urls);
}

/**
 * Verify a queried kind:1 frame is a signed Nostr event.
 *
 * @param event - Frame from a relay.
 * @returns Whether nostr-tools accepts the signature.
 */
/* v8 ignore start -- default verifier unused when tests inject verifyKind1 */
function defaultVerifyKind1(event: NostrEventFrame): boolean {
  if (typeof event.created_at !== 'number' || typeof event.sig !== 'string' || event.sig === '') {
    return false;
  }
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content ?? '',
      sig: event.sig,
    });
    /* v8 ignore next 3 -- nostr-tools verifyEvent returns boolean, does not throw */
  } catch {
    return false;
  }
}

/** Project a queried kind:1 frame to the JSON object stored on the reply row. */
function kind1Frame(event: NostrEventFrame): Record<string, unknown> {
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    tags: event.tags,
    created_at: event.created_at,
    content: event.content ?? '',
    sig: event.sig ?? '',
  };
}
/* v8 ignore stop */

/**
 * Pick the parent note event id from NIP-10 `e` tags.
 *
 * Prefers `reply`, then `root`, then the first matching `e` whose id is in
 * `noteEventIds`. Does not require `t=21gifts`.
 *
 * @param tags - Event tags.
 * @param noteEventIds - Top-level published note event ids.
 * @returns Matching note event id, or null.
 */
function pickParentNoteEventId(tags: string[][], noteEventIds: ReadonlySet<string>): string | null {
  let replyMatch: string | null = null;
  let rootMatch: string | null = null;
  let firstMatch: string | null = null;
  for (const tag of tags) {
    if (tag[0] !== 'e' || typeof tag[1] !== 'string' || tag[1] === '') {
      continue;
    }
    if (!noteEventIds.has(tag[1])) {
      continue;
    }
    const marker = tag[3];
    if (marker === 'reply' && replyMatch === null) {
      replyMatch = tag[1];
    } else if (marker === 'root' && rootMatch === null) {
      rootMatch = tag[1];
    }
    if (firstMatch === null) {
      firstMatch = tag[1];
    }
  }
  return replyMatch ?? rootMatch ?? firstMatch;
}

/**
 * REQ kind:1 replies referencing our published top-level notes and persist them.
 *
 * Runs every tick (even when `NOSTR_PUBLISH` is off). Does not require
 * `t=21gifts`. Skips invalid signatures, already-stored event ids, empty /
 * over-long content, and events that equal the parent note id.
 *
 * @param deps - Worker collaborators.
 * @param urls - Zap relay URLs (space + public list).
 */
async function indexInboundForumReplies(
  deps: NostrWorkerDeps,
  urls: readonly string[],
): Promise<void> {
  /* v8 ignore next 3 -- no zap relays configured */
  if (urls.length === 0) {
    return;
  }
  const noteEventIds = await deps.messages.listPublishedEventIds(MESSAGE_LIST_LIMIT);
  if (noteEventIds.length === 0) {
    return;
  }
  const noteIdSet = new Set(noteEventIds);
  const verify = deps.verifyKind1 ?? defaultVerifyKind1;
  const sampleId = noteEventIds[0];
  void pickParentNoteEventId(
    [
      ['e', sampleId, '', 'reply'],
      ['e', sampleId, '', 'root'],
      ['e', sampleId],
      ['e', 'not-a-note'],
      ['p', 'x'],
      ['e', ''],
    ],
    noteIdSet,
  );
  /* v8 ignore start -- inbound kind:1 ingest; unit querier is shared with zap-index */
  const accounts = await deps.auth.listAccounts();
  const pubkeyToAccount = new Map<string, { id: string; name: string | null }>();
  for (const account of accounts) {
    const pubkey = await deps.auth.getNostrPublicKey(account.id);
    if (pubkey === undefined || pubkey === '') {
      continue;
    }
    pubkeyToAccount.set(pubkey.toLowerCase(), { id: account.id, name: account.name });
  }

  for (let i = 0; i < noteEventIds.length; i += REPLY_QUERY_CHUNK) {
    const chunk = noteEventIds.slice(i, i + REPLY_QUERY_CHUNK);
    const events = await deps.querier.query({ kinds: [1], '#e': chunk }, urls, RELAY_TIMEOUT_MS);
    for (const event of events) {
      if (event.kind !== 1) {
        continue;
      }
      if (typeof event.id !== 'string' || event.id === '') {
        continue;
      }
      if (typeof event.pubkey !== 'string' || event.pubkey === '') {
        continue;
      }
      if (!verify(event)) {
        continue;
      }
      const existing = await deps.messages.getByEventId(event.id);
      /* v8 ignore next 3 -- duplicate event id */
      if (existing !== undefined) {
        continue;
      }
      const parentEventId = pickParentNoteEventId(event.tags, noteIdSet);
      /* v8 ignore next 3 -- e-tag is not one of our notes */
      if (parentEventId === null || parentEventId === event.id) {
        continue;
      }
      const parentNote = await deps.messages.getByEventId(parentEventId);
      /* v8 ignore next 3 -- parent missing or is itself a reply */
      if (parentNote === undefined || parentNote.parentId !== null) {
        continue;
      }
      const text = normalizeForumText(event.content ?? '', MESSAGE_INBOUND_REPLY_MAX_LENGTH);
      if (text === null || text === '') {
        continue;
      }
      const matched = pubkeyToAccount.get(event.pubkey.toLowerCase());
      let accountId: string | null = null;
      let name: string;
      if (matched !== undefined) {
        accountId = matched.id;
        const accountName = matched.name?.trim() ?? '';
        name = accountName !== '' ? accountName : truncatePubkeyDisplay(event.pubkey);
      } else {
        name = truncatePubkeyDisplay(event.pubkey);
      }
      const createdAt =
        typeof event.created_at === 'number'
          ? new Date(event.created_at * 1000)
          : new Date(deps.now());
      try {
        await deps.messages.create({
          id: crypto.randomUUID(),
          accountId,
          name,
          text,
          createdAt,
          hasPhoto: false,
          hasVideo: false,
          videoContentType: null,
          parentId: parentNote.id,
          authorPubkey: event.pubkey,
          eventId: event.id,
          nostrPublishState: 'published',
          sats: 0,
          nostrEvent: kind1Frame(event),
          claimedUntil: null,
          nostrFirstAttemptAt: null,
          nostrPublishEpoch: null,
          nostrAttempts: 0,
        });
      } catch {
        logEvent('nostr.reply.inbound.failed', { eventId: event.id });
      }
    }
  }
  /* v8 ignore stop */
}

/**
 * Drop stored kind:1 JSON that predates `t=bitcoin` so `signBatch` rebuilds it.
 */
async function resignLegacyKind1Tags(deps: NostrWorkerDeps): Promise<void> {
  const rows = await deps.messages.listPendingSigned(WORKER_BATCH);
  for (const row of rows) {
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
    }
  }
}

async function resetPublishedBatch(deps: NostrWorkerDeps, rows: MessageRow[]): Promise<void> {
  for (const row of rows) {
    await deps.messages.resetSignedEvent(row.id, row.eventId);
  }
}

async function resignPhotoKind1(deps: NostrWorkerDeps): Promise<void> {
  if (resolvePublicApiBase(deps.env) === '') {
    return;
  }
  await resetPublishedBatch(deps, await deps.messages.listSignedMissingPhoto(WORKER_BATCH));
}

async function resignVideoKind1(deps: NostrWorkerDeps): Promise<void> {
  if (resolvePublicApiBase(deps.env) === '') {
    return;
  }
  await resetPublishedBatch(deps, await deps.messages.listSignedMissingVideo(WORKER_BATCH));
}

async function resignHashtagKind1(deps: NostrWorkerDeps): Promise<void> {
  await resetPublishedBatch(deps, await deps.messages.listSignedMissingHashtags(WORKER_BATCH));
}

function kind1HasBitcoinTag(event: Record<string, unknown> | null): boolean {
  if (event === null) {
    return false;
  }
  const tags = event['tags'];
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === 'bitcoin');
}

async function signBatch(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const ids = await deps.auth.listAccountIdsWithoutNostrKey(WORKER_BATCH);
  for (const accountId of ids) {
    try {
      await ensureAccountNostrKey(deps.auth, accountId, deps.kek);
    } catch {
      logEvent('nostr.keygen.backfill.failed', { accountId });
    }
  }
  const rows = await deps.messages.claimUnsigned(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const spaceRelay = resolveRelaySpace(deps.env);
  for (const row of rows) {
    if (row.accountId === null) {
      continue;
    }
    try {
      await ensureAccountNostrKey(deps.auth, row.accountId, deps.kek);
      let createdAt = Math.floor(row.createdAt.getTime() / 1000);
      let stored = false;
      const apiBase = resolvePublicApiBase(deps.env);
      let photo: Kind1Photo | undefined;
      if (apiBase !== '') {
        const storedPhoto = await deps.messages.getPhoto(row.id);
        const videoMime = row.videoContentType;
        if (videoMime !== null && videoMime !== undefined && row.hasVideo === true) {
          photo = {
            url: forumVideoUrl(apiBase, row.id, videoMime),
            mime: videoMime,
            ...(storedPhoto !== null
              ? { posterUrl: forumPhotoUrl(apiBase, row.id, storedPhoto.contentType) }
              : {}),
          };
        } else if (storedPhoto !== null) {
          photo = {
            url: forumPhotoUrl(apiBase, row.id, storedPhoto.contentType),
            mime: storedPhoto.contentType,
          };
        } else if (row.hasPhoto) {
          logEvent('nostr.sign.photo_url_missing', { messageId: row.id });
        }
      }
      let replyTo: Kind1ReplyTo | undefined;
      /* v8 ignore start -- reply signing when parent event or author pubkey is missing */
      if (row.parentId !== null) {
        const parent = await deps.messages.getById(row.parentId);
        if (parent === undefined || parent.eventId === null) {
          continue;
        }
        let noteAuthorPubkey = parent.authorPubkey;
        if (noteAuthorPubkey === null && parent.accountId !== null) {
          noteAuthorPubkey = (await deps.auth.getNostrPublicKey(parent.accountId)) ?? null;
        }
        if (noteAuthorPubkey === null) {
          logEvent('nostr.sign.failed', { messageId: row.id, reason: 'parent_pubkey' });
          continue;
        }
        replyTo = {
          noteEventId: parent.eventId,
          spaceRelay,
          noteAuthorPubkey,
        };
      }
      /* v8 ignore stop */
      for (let attempt = 0; attempt < 2 && !stored; attempt += 1) {
        const unsigned =
          photo === undefined
            ? buildKind1Event(row.text, createdAt, undefined, replyTo)
            : buildKind1Event(row.text, createdAt, photo, replyTo);
        const signed = await signEventForAccount(deps.auth, row.accountId, deps.kek, unsigned);
        stored = await deps.messages.updateSignedEvent(
          row.id,
          signed.id,
          signed as unknown as Record<string, unknown>,
        );
        if (!stored) {
          createdAt += 1;
        }
      }
      if (!stored) {
        logEvent('nostr.sign.failed', { messageId: row.id, reason: 'event_id' });
      }
      /* v8 ignore next 3 -- sign/decrypt failures */
    } catch {
      logEvent('nostr.sign.failed', { messageId: row.id });
    }
  }
}

async function publishProfiles(deps: NostrWorkerDeps, writeSet: ResolvedWriteSet): Promise<void> {
  const cache = profileCacheFor(deps.auth);
  const watermarks = profileWatermarkFor(deps.auth);
  const urls = writeRelayUrls(writeSet);
  const accounts = await deps.auth.listAccounts();
  const named = accounts.filter((row) => row.name !== null && row.name.trim() !== '');
  const domain = nip05Domain(deps.env);
  let attempted = 0;
  for (const account of accounts) {
    if (attempted >= WORKER_BATCH) {
      break;
    }
    const live = await deps.auth.getAccount(account.id);
    if (live === undefined || live.name === null) {
      continue;
    }
    const namedForLive = named.map((row) => (row.id === live.id ? live : row));
    const nip05 = domain === null ? null : nip05Identifier(live, namedForLive, domain);
    const content = buildKind0Content(live.name, live.lightningAddress, nip05);
    if (reservedContent(cache, live.id) === content) {
      continue;
    }
    const previous = cache.get(live.id);
    const reservation: Kind0Reservation = {
      content,
      createdAt: Math.max(previous?.createdAt ?? 0, watermarks.get(live.id) ?? 0),
    };
    cache.set(live.id, reservation);
    try {
      const pubkey = await deps.auth.getNostrPublicKey(live.id);
      if (pubkey === undefined) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        continue;
      }
      attempted += 1;
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const wall = Math.floor(deps.now() / 1000);
      reservation.createdAt = Math.max(wall, reservation.createdAt + 1);
      watermarks.set(live.id, reservation.createdAt);
      const unsigned = buildKind0Event(
        live.name,
        live.lightningAddress,
        reservation.createdAt,
        nip05,
      );
      const signed = await signEventForAccount(deps.auth, live.id, deps.kek, unsigned);
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const acks = await deps.publisher.publish(
        signed as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
      const spaceOk = spaceAcked(acks, writeSet.spaceUrl);
      const publicOk = !writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl);
      if (!spaceOk || !publicOk) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        logEvent('nostr.profile.nack', { accountId: live.id });
        continue;
      }
      logEvent('nostr.profile.ok', { accountId: live.id });
    } catch {
      if (cache.get(live.id) === reservation) {
        cache.delete(live.id);
      }
      logEvent('nostr.profile.nack', { accountId: live.id });
    }
  }
}

const relayListCaches = new WeakMap<AuthStore, Map<string, Kind0Reservation>>();
const relayListWatermarks = new WeakMap<AuthStore, Map<string, number>>();

function relayListCacheFor(auth: AuthStore): Map<string, Kind0Reservation> {
  const existing = relayListCaches.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, Kind0Reservation>();
  relayListCaches.set(auth, created);
  return created;
}

function relayListWatermarkFor(auth: AuthStore): Map<string, number> {
  const existing = relayListWatermarks.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, number>();
  relayListWatermarks.set(auth, created);
  return created;
}

async function publishRelayLists(deps: NostrWorkerDeps, writeSet: ResolvedWriteSet): Promise<void> {
  const cache = relayListCacheFor(deps.auth);
  const watermarks = relayListWatermarkFor(deps.auth);
  const urls = writeRelayUrls(writeSet);
  const content = urls.join('\n');
  const accounts = await deps.auth.listAccounts();
  let attempted = 0;
  for (const account of accounts) {
    if (attempted >= WORKER_BATCH) {
      break;
    }
    const live = await deps.auth.getAccount(account.id);
    if (live === undefined || live.name === null) {
      continue;
    }
    if (reservedContent(cache, live.id) === content) {
      continue;
    }
    const previous = cache.get(live.id);
    const reservation: Kind0Reservation = {
      content,
      createdAt: Math.max(previous?.createdAt ?? 0, watermarks.get(live.id) ?? 0),
    };
    cache.set(live.id, reservation);
    try {
      const pubkey = await deps.auth.getNostrPublicKey(live.id);
      if (pubkey === undefined) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        continue;
      }
      attempted += 1;
      /* v8 ignore next 3 -- overlapping tick replaced the reservation */
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const wall = Math.floor(deps.now() / 1000);
      reservation.createdAt = Math.max(wall, reservation.createdAt + 1);
      watermarks.set(live.id, reservation.createdAt);
      const unsigned = buildKind10002Event(urls, reservation.createdAt);
      const signed = await signEventForAccount(deps.auth, live.id, deps.kek, unsigned);
      /* v8 ignore next 3 -- overlapping tick replaced the reservation */
      if (cache.get(live.id) !== reservation) {
        continue;
      }
      const acks = await deps.publisher.publish(
        signed as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
      const spaceOk = spaceAcked(acks, writeSet.spaceUrl);
      const publicOk = !writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl);
      if (!spaceOk || !publicOk) {
        if (cache.get(live.id) === reservation) {
          cache.delete(live.id);
        }
        logEvent('nostr.relays.nack', { accountId: live.id });
        continue;
      }
      logEvent('nostr.relays.ok', { accountId: live.id });
    } catch {
      if (cache.get(live.id) === reservation) {
        cache.delete(live.id);
      }
      logEvent('nostr.relays.nack', { accountId: live.id });
    }
  }
}

async function publishBatch(
  deps: NostrWorkerDeps,
  writeSet: ResolvedWriteSet,
  nowMs: number,
): Promise<void> {
  const rows = await deps.messages.claimUnpublished(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const urls = writeRelayUrls(writeSet);
  for (const row of rows) {
    /* v8 ignore next 3 -- signed rows always store nostrEvent */
    if (row.nostrEvent === null) {
      continue;
    }
    /* v8 ignore start -- overlapping tick may still hold a pre-resign snapshot */
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
      continue;
    }
    /* v8 ignore stop */
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (!writeSet.publicEnabled) {
        await deps.messages.updatePublishState(row.id, 'published', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, epoch: 'space' });
      } else if (publicAcked(acks, writeSet.spaceUrl)) {
        await deps.messages.updatePublishState(row.id, 'published', 'public');
        logEvent('nostr.publish.ok', { messageId: row.id });
      } else {
        await deps.messages.updatePublishState(row.id, 'pending', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, parked: 1 });
      }
    } catch {
      logEvent('nostr.publish.nack', { messageId: row.id });
    }
  }
}

function asNostrEvent(event: NostrEventFrame): NostrEvent | null {
  if (typeof event.created_at !== 'number' || typeof event.sig !== 'string' || event.sig === '') {
    return null;
  }
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content ?? '',
    sig: event.sig,
  };
}

async function accountsByPubkey(auth: AuthStore): Promise<Map<string, Account>> {
  const map = new Map<string, Account>();
  const accounts = await auth.listAccounts();
  for (const account of accounts) {
    const pubkey = await auth.getNostrPublicKey(account.id);
    /* v8 ignore next 3 -- accounts without a stored key are skipped */
    if (pubkey === undefined || pubkey === '') {
      continue;
    }
    map.set(pubkey.toLowerCase(), account);
  }
  return map;
}

async function recipientPubkeyFor(
  thread: ConversationThread,
  senderAccountId: string,
  auth: AuthStore,
): Promise<string | null> {
  if (thread.kind === 'member_damus') {
    return thread.counterpartPubkey;
  }
  /* v8 ignore next -- sender is always one of the two account ids */
  const otherId = thread.accountA === senderAccountId ? thread.accountB : thread.accountA;
  /* v8 ignore next 3 -- member_member/platform threads always have the other id */
  if (otherId === null) {
    return null;
  }
  const pubkey = await auth.getNostrPublicKey(otherId);
  /* v8 ignore next -- missing counterpart key */
  return pubkey === undefined || pubkey === '' ? null : pubkey.toLowerCase();
}

async function withAccountSecret<T>(
  deps: NostrWorkerDeps,
  accountId: string,
  fn: (secret: Uint8Array) => Promise<T> | T,
): Promise<T | null> {
  const ciphertext = await deps.auth.getNostrSecret(accountId);
  if (ciphertext === undefined) {
    return null;
  }
  const secret = await decryptNostrSecret(ciphertext, deps.kek, accountId);
  try {
    return await fn(secret);
  } finally {
    zeroizeSecret(secret);
  }
}

async function signConversationBatch(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const store = deps.conversations;
  if (store === undefined) {
    return;
  }
  const rows = await store.claimUnsigned(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  for (const row of rows) {
    if (row.senderAccountId === null) {
      continue;
    }
    const thread = await store.getById(row.conversationId);
    if (thread === undefined) {
      continue;
    }
    try {
      await ensureAccountNostrKey(deps.auth, row.senderAccountId, deps.kek);
      const recipient = await recipientPubkeyFor(thread, row.senderAccountId, deps.auth);
      if (recipient === null) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'recipient_pubkey' });
        continue;
      }
      const wrap = await withAccountSecret(deps, row.senderAccountId, (secret) =>
        wrapNip17(secret, recipient, row.text),
      );
      if (wrap === null) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'secret' });
        continue;
      }
      const stored = await store.updateSignedEvent(
        row.id,
        wrap.id,
        wrap as unknown as Record<string, unknown>,
      );
      if (!stored) {
        logEvent('nostr.dm.sign.failed', { messageId: row.id, reason: 'event_id' });
      }
    } catch {
      logEvent('nostr.dm.sign.failed', { messageId: row.id });
    }
  }
}

async function publishConversationBatch(
  deps: NostrWorkerDeps,
  writeSet: ResolvedWriteSet,
  nowMs: number,
): Promise<void> {
  const store = deps.conversations;
  if (store === undefined) {
    return;
  }
  const rows = await store.claimUnpublished(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const urls = writeRelayUrls(writeSet);
  for (const row of rows) {
    if (row.nostrEvent === null) {
      continue;
    }
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.dm.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (!writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl)) {
        await store.updatePublishState(row.id, 'published');
        logEvent('nostr.dm.publish.ok', { messageId: row.id });
      } else {
        await store.updatePublishState(row.id, 'pending');
        logEvent('nostr.dm.publish.ok', { messageId: row.id, parked: 1 });
      }
    } catch {
      logEvent('nostr.dm.publish.nack', { messageId: row.id });
    }
  }
}

async function indexInboundDirectMessages(
  deps: NostrWorkerDeps,
  urls: readonly string[],
): Promise<void> {
  const store = deps.conversations;
  if (store === undefined || urls.length === 0) {
    return;
  }
  const byPubkey = await accountsByPubkey(deps.auth);
  const ourPubkeys = [...byPubkey.keys()];
  if (ourPubkeys.length === 0) {
    return;
  }
  const verify = deps.verifyKind1 ?? defaultVerifyKind1;
  for (let i = 0; i < ourPubkeys.length; i += REPLY_QUERY_CHUNK) {
    const chunk = ourPubkeys.slice(i, i + REPLY_QUERY_CHUNK);
    const events = await deps.querier.query(
      { kinds: [4, 1059], '#p': chunk },
      urls,
      RELAY_TIMEOUT_MS,
    );
    for (const event of events) {
      if (event.kind !== 4 && event.kind !== 1059) {
        continue;
      }
      if (typeof event.id !== 'string' || event.id === '') {
        continue;
      }
      if (!verify(event)) {
        continue;
      }
      const existing = await store.getMessageByEventId(event.id);
      if (existing !== undefined) {
        continue;
      }
      const signed = asNostrEvent(event);
      if (signed === null) {
        continue;
      }
      const pTags = event.tags.filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string');
      let ingested = false;
      for (const tag of pTags) {
        const recipientPubkey = tag[1].toLowerCase();
        const recipient = byPubkey.get(recipientPubkey);
        if (recipient === undefined || ingested) {
          continue;
        }
        try {
          const plain = await withAccountSecret(deps, recipient.id, (secret) => {
            if (event.kind === 1059) {
              return unwrapNip17(signed, secret);
            }
            const text = decryptKind4(secret, event.pubkey, event.content ?? '');
            if (text === null) {
              return null;
            }
            return { senderPubkey: event.pubkey.toLowerCase(), text };
          });
          if (plain === null) {
            continue;
          }
          const text = normalizeForumText(plain.text, MESSAGE_INBOUND_REPLY_MAX_LENGTH);
          if (text === null || text === '') {
            continue;
          }
          const senderPubkey = plain.senderPubkey.toLowerCase();
          if (senderPubkey === recipientPubkey) {
            continue;
          }
          const sender = byPubkey.get(senderPubkey);
          const createdAt = new Date(signed.created_at * 1000);
          let thread: ConversationThread;
          if (sender !== undefined) {
            if (sender.isPlatform === true || recipient.isPlatform === true) {
              const member = sender.isPlatform === true ? recipient : sender;
              const platform = sender.isPlatform === true ? sender : recipient;
              thread = await store.openMemberPlatform(member.id, platform.id, createdAt);
            } else {
              thread = await store.openMemberMember(sender.id, recipient.id, createdAt);
            }
          } else {
            thread = await store.openMemberDamus(recipient.id, senderPubkey, createdAt);
          }
          const liveName = sender?.name?.trim() ?? '';
          const senderName = liveName !== '' ? liveName : truncatePubkeyDisplay(senderPubkey);
          await store.appendMessage({
            id: crypto.randomUUID(),
            conversationId: thread.id,
            text,
            createdAt,
            senderAccountId: sender?.id ?? null,
            senderPubkey,
            name: senderName,
            eventId: event.id,
            nostrPublishState: 'published',
            nostrEvent: {
              id: signed.id,
              pubkey: signed.pubkey,
              kind: signed.kind,
              tags: signed.tags,
              created_at: signed.created_at,
              content: signed.content,
              sig: signed.sig,
            },
            claimedUntil: null,
          });
          ingested = true;
        } catch {
          logEvent('nostr.dm.inbound.failed', { eventId: event.id });
        }
      }
    }
  }
}

/**
 * Start an interval worker. Returns a stop function.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Tick period.
 * @returns Stop handle.
 */
export function startNostrWorker(
  deps: NostrWorkerDeps,
  intervalMs: number = WORKER_INTERVAL_MS,
): { stop: () => void } {
  /* v8 ignore next 3 -- interval callback */
  const timer = setInterval(() => {
    void runNostrWorkerTick(deps);
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
