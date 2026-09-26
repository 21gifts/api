/**
 * Nostr event templates for the 21.gifts forum.
 *
 * Top-level kind:1 tags are frozen without `e`/`p`/`q` — member-forum posts
 * are top-level notes for discovery-feed virality. NIP-10 replies add `e`/`p`
 * on top of the frozen tags (never on top-level notes). NIP-09 kind:5
 * retraction events are built by {@link buildKind5Event}.
 */

import { locationHashtagName } from '@/lib/location';

/** Frozen kind:1 tags, in this order. Extra `imeta` rows may follow. */
export const KIND1_TAGS: readonly [
  readonly ['t', 'bitcoin'],
  readonly ['t', '21gifts'],
  readonly ['r', 'https://21.gifts'],
] = [
  ['t', 'bitcoin'],
  ['t', '21gifts'],
  ['r', 'https://21.gifts'],
] as const;

/** Damus-visible hashtags appended to kind:1 content (order fixed). */
export const KIND1_CONTENT_HASHTAGS: readonly ['#bitcoin', '#21gifts'] = [
  '#bitcoin',
  '#21gifts',
] as const;

/** Public PNG used as every kind:0 `picture` so Damus shows 21.gifts branding. */
export const KIND0_PICTURE_URL = 'https://21.gifts/apple-touch-icon.png';

/** Wide public image used as every kind:0 `banner` (1200×630). */
export const KIND0_BANNER_URL = 'https://21.gifts/og.png';

const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,}$/;

/** Optional NIP-92 media (image or video) attached to a kind:1. */
export interface Kind1Photo {
  /** Absolute HTTPS URL clients fetch. */
  url: string;
  /** Stored MIME type (image or video). */
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/webm' | 'video/quicktime';
  /** Optional poster image URL (video `imeta` `image` field). */
  posterUrl?: string;
  /** Optional display size for `imeta` (`WIDTHxHEIGHT`). */
  dim?: string;
  /** Optional byte length for `imeta` `size`. */
  size?: number;
  /** Optional sha256 (64 lowercase hex) for `imeta` `x`. */
  hash?: string;
  /** Optional whole seconds for `imeta` `duration` (1–86400). */
  durationSeconds?: number;
  /** Optional BlurHash placeholder for `imeta`. */
  blurhash?: string;
}

/** NIP-10 reply pointers for a forum reply kind:1 (not used on top-level notes). */
export interface Kind1ReplyTo {
  /** Parent note event id (hex). Used for both `root` and `reply` markers. */
  noteEventId: string;
  /**
   * NIP-10 relay hint for the `e` tags (public discovery relay when public
   * publish is on, otherwise the durability relay).
   */
  spaceRelay: string;
  /** Parent note author pubkey (hex) for the `p` tag. */
  noteAuthorPubkey: string;
}

/**
 * Filename extension Damus treats as an inline image.
 *
 * @param mime - Stored JPEG, PNG, or WebP type.
 * @returns `jpg`, `png`, or `webp`.
 */
function forumPhotoExt(mime: Kind1Photo['mime']): 'jpg' | 'png' | 'webp' {
  if (mime === 'image/png') {
    return 'png';
  }
  if (mime === 'image/webp') {
    return 'webp';
  }
  return 'jpg';
}

/**
 * Absolute photo URL for a forum message.
 *
 * Damus only embeds URLs that look like image files, so the path ends in
 * `.jpg` / `.png` / `.webp` rather than a bare `/photo`.
 *
 * @param apiBase - Public API origin (no trailing slash).
 * @param messageId - Message id.
 * @param mime - Stored type (defaults to JPEG).
 * @returns `GET /messages/:id/photo.jpg` (or `.png` / `.webp`) URL.
 */
export function forumPhotoUrl(
  apiBase: string,
  messageId: string,
  mime: Kind1Photo['mime'] = 'image/jpeg',
): string {
  return `${apiBase.replace(/\/$/, '')}/messages/${messageId}/photo.${forumPhotoExt(mime)}`;
}

/**
 * Public page for one forum message, matching the app's `/l/<8 hex>` link.
 *
 * @param siteOrigin - `PUBLIC_BASE_URL` without caring about a trailing slash.
 * @param messageId - Message id. Only a UUID is shortened.
 * @returns `https://21.gifts/l/…`, or `null` when the origin or id is unusable.
 */
export function notePageUrl(siteOrigin: string, messageId: string): string | null {
  const origin = siteOrigin.trim().replace(/\/$/, '');
  if (origin === '' || !NOTE_ID_RE.test(messageId)) {
    return null;
  }
  return `${origin}/l/${messageId.slice(0, 8).toLowerCase()}`;
}

/**
 * Absolute extra-still URL for a forum message (indices 1–9).
 *
 * Damus only embeds URLs that look like image files, so the path ends in
 * `.jpg` / `.png` / `.webp` rather than a bare `/photo/:index`.
 *
 * @param apiBase - Public API origin (no trailing slash).
 * @param messageId - Message id.
 * @param index - Extra still index (1–9).
 * @param mime - Stored type (defaults to JPEG).
 * @returns `GET /messages/:id/photo/:index.jpg` (or `.png` / `.webp`) URL.
 */
export function forumExtraPhotoUrl(
  apiBase: string,
  messageId: string,
  index: number,
  mime: Kind1Photo['mime'] = 'image/jpeg',
): string {
  return `${apiBase.replace(/\/$/, '')}/messages/${messageId}/photo/${index}.${forumPhotoExt(mime)}`;
}

/**
 * Mutable tag arrays for `finalizeEvent` (copy of {@link KIND1_TAGS}).
 *
 * Extra `t` names (already lowercased) are inserted after `t=21gifts` and
 * before `r`. `bitcoin` / `21gifts` and duplicates among extras are skipped
 * so a no-arg call still returns the original three tags.
 *
 * @param extraT - Optional extra `t` tag values (lowercase, no `#`).
 * @returns A mutable copy of the frozen tags plus any extra `t` rows.
 */
export function kind1Tags(extraT: readonly string[] = []): string[][] {
  const tags: string[][] = KIND1_TAGS.map((tag) => [...tag]);
  const seen = new Set<string>(['bitcoin', '21gifts']);
  let offset = 0;
  for (const name of extraT) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    tags.splice(2 + offset, 0, ['t', name]);
    offset += 1;
  }
  return tags;
}

/**
 * True when `content` already contains `#name` as a hashtag token
 * (case-insensitive). The next character must not be `[A-Za-z0-9_]`, so
 * `#bitcoiners` is not `#bitcoin`. The `#` prefix distinguishes `#21gifts`
 * from `https://21.gifts`.
 *
 * @param content - Kind:1 content body.
 * @param name - Hashtag name without `#` (e.g. `bitcoin`).
 * @returns True when content contains the requested hashtag token; otherwise false.
 */
export function kind1HasHashtag(content: string, name: string): boolean {
  const needle = `#${name.toLowerCase()}`;
  const lower = content.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const index = lower.indexOf(needle, from);
    if (index === -1) {
      return false;
    }
    const after = lower[index + needle.length];
    if (after === undefined || !/[a-z0-9_]/.test(after)) {
      return true;
    }
    from = index + 1;
  }
  return false;
}

/**
 * Append any missing `#bitcoin` / `#21gifts` (and optional extra hashtags)
 * so Damus renders them. Forum text is unchanged by the caller; this only
 * shapes Nostr content.
 *
 * Empty content → wanted tags joined by a space (no leading blank line).
 * Non-empty → trailing newlines stripped, then `\n\n` + missing tags joined by a single space.
 * Already-present tags (any case, e.g. `#21Gifts`) are not duplicated; only missing ones are appended, still in KIND1_CONTENT_HASHTAGS order then extras.
 *
 * @param content - Forum text and optional photo URL already composed.
 * @param extraHashtags - Optional extra hashtag names without `#` (case preserved in content).
 * @returns Content with any missing hashtag tokens appended (unchanged when all are already present).
 */
export function kind1ContentWithHashtags(
  content: string,
  extraHashtags: readonly string[] = [],
): string {
  const wanted: string[] = [...KIND1_CONTENT_HASHTAGS];
  const seen = new Set(wanted.map((tag) => tag.slice(1).toLowerCase()));
  for (const name of extraHashtags) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    wanted.push(`#${name}`);
  }
  const missing = wanted.filter((tag) => !kind1HasHashtag(content, tag.slice(1)));
  if (missing.length === 0) {
    return content;
  }
  const suffix = missing.join(' ');
  if (content === '') {
    return suffix;
  }
  return `${content.replace(/\n+$/, '')}\n\n${suffix}`;
}

/** 64 lowercase hex sha256 for a NIP-92 `imeta` `x` field. */
const IMETA_HASH_RE = /^[0-9a-f]{64}$/;

/** Append a valid BlurHash after `m`. Invalid text is omitted. */
function appendBlurhash(imeta: string[], photo: Kind1Photo): void {
  if (photo.blurhash !== undefined && BLURHASH_RE.test(photo.blurhash)) {
    imeta.push(`blurhash ${photo.blurhash}`);
  }
}

/**
 * Append optional `x` and `duration` after the other `imeta` fields.
 *
 * @param imeta - Tag row that already has `url` and `m`.
 * @param photo - Media metadata. Invalid hash or duration is omitted.
 */
function appendImetaHashAndDuration(imeta: string[], photo: Kind1Photo): void {
  if (photo.hash !== undefined && IMETA_HASH_RE.test(photo.hash)) {
    imeta.push(`x ${photo.hash}`);
  }
  const duration = photo.durationSeconds;
  if (duration !== undefined && Number.isInteger(duration) && duration >= 1 && duration <= 86400) {
    imeta.push(`duration ${duration}`);
  }
}

/** Unsigned kind:1 fields before `finalizeEvent`. */
export interface UnsignedKind1 {
  /** Kind 1. */
  kind: 1;
  /** Forum text (plus optional photo URL) with Damus-visible `#bitcoin` / `#21gifts`. */
  content: string;
  /** Frozen tags. */
  tags: string[][];
  /** Unix seconds from the forum row's `createdAt` (may be bumped on collision). */
  created_at: number;
}

/**
 * Build an unsigned kind:1 for a forum message (top-level or NIP-10 reply).
 *
 * Content is plaintext (no name prefix). `kind1ContentWithHashtags` ensures
 * Damus-visible `#bitcoin` / `#21gifts` tokens (appends only missing ones)
 * and, when `location` yields a hashtag name, that token after them.
 * Forum row `text` is never modified. Top-level tags are frozen — no `e`/`p`/`q`.
 * Extra location `t` tags sit after `t=21gifts` and before `r`. When `replyTo`
 * is set, adds NIP-10 `e` (root + reply) and `p` tags after those tags (and
 * optional `imeta`). Profile notes are skipped by the worker, not by this
 * function.
 *
 * @param content - Already-normalised forum text (may be empty when `photo` is set).
 * @param createdAtUnix - Unix seconds for the event.
 * @param photo - Optional public media (image or video URL + MIME; optional poster, dim, size, hash, duration).
 * @param replyTo - Optional NIP-10 parent pointers (replies only).
 * @param location - Optional account location; null/omitted/unusable → same as four-arg HEAD.
 * @param extraPhotos - Optional extra stills (indices 1..n). Omit or empty for N=1 bit-identical events.
 * @param pageUrl - Optional `https://…/l/<8 hex>` for this message. Omitted or null keeps the homepage `r` tag and does not add a link line.
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind1Event(
  content: string,
  createdAtUnix: number,
  photo?: Kind1Photo,
  replyTo?: Kind1ReplyTo,
  location?: string | null,
  extraPhotos?: readonly Kind1Photo[],
  pageUrl?: string | null,
): UnsignedKind1 {
  const name = locationHashtagName(location ?? null);
  const extras = name === null ? [] : [name];
  const tags = kind1Tags(extras.map((n) => n.toLowerCase()));
  let body = content;
  if (photo !== undefined) {
    body = content === '' ? photo.url : `${content}\n${photo.url}`;
    const imeta = ['imeta', `url ${photo.url}`, `m ${photo.mime}`];
    appendBlurhash(imeta, photo);
    if (photo.dim !== undefined) {
      imeta.push(`dim ${photo.dim}`);
    }
    if (photo.size !== undefined) {
      imeta.push(`size ${photo.size}`);
    }
    if (photo.posterUrl !== undefined && photo.posterUrl !== '') {
      imeta.push(`image ${photo.posterUrl}`);
    }
    appendImetaHashAndDuration(imeta, photo);
    tags.push(imeta);
  }
  if (extraPhotos !== undefined && extraPhotos.length > 0) {
    for (const extra of extraPhotos) {
      body = body === '' ? extra.url : `${body}\n${extra.url}`;
      const imeta = ['imeta', `url ${extra.url}`, `m ${extra.mime}`];
      appendBlurhash(imeta, extra);
      if (extra.dim !== undefined) {
        imeta.push(`dim ${extra.dim}`);
      }
      if (extra.size !== undefined) {
        imeta.push(`size ${extra.size}`);
      }
      appendImetaHashAndDuration(imeta, extra);
      tags.push(imeta);
    }
  }
  if (replyTo !== undefined) {
    tags.push(['e', replyTo.noteEventId, replyTo.spaceRelay, 'root']);
    tags.push(['e', replyTo.noteEventId, replyTo.spaceRelay, 'reply']);
    tags.push(['p', replyTo.noteAuthorPubkey]);
  }
  if (pageUrl !== undefined && pageUrl !== null && pageUrl !== '') {
    for (const tag of tags) {
      if (tag[0] === 'r' && tag[1] === 'https://21.gifts') {
        tag[1] = pageUrl;
      }
    }
    if (!body.includes(pageUrl)) {
      body = body === '' ? pageUrl : `${body}\n${pageUrl}`;
    }
  }
  body = kind1ContentWithHashtags(body, extras);
  return {
    kind: 1,
    content: body,
    tags,
    created_at: createdAtUnix,
  };
}

/**
 * Build an unsigned NIP-09 kind:5 deletion event for one kind:1 id.
 *
 * `content` is empty (no staff name, no forum text). Tags are exactly one
 * `e` tag for the deleted event id and `k=1` (kind of the deleted event).
 * One event id per kind:5 — different authors cannot share one deletion
 * event.
 *
 * @param eventId - Kind:1 event id to retract.
 * @param createdAtUnix - Unix seconds from the hide clock.
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind5Event(
  eventId: string,
  createdAtUnix: number,
): {
  kind: 5;
  content: string;
  tags: string[][];
  created_at: number;
} {
  return {
    kind: 5,
    content: '',
    tags: [
      ['e', eventId],
      ['k', '1'],
    ],
    created_at: createdAtUnix,
  };
}

/** Kind:0 profile content fields (JSON-stringified with no extra whitespace). */
export interface Kind0ProfileContent {
  /** Display name. */
  name: string;
  /** Same as `name` for Damus/Primal. */
  display_name: string;
  /** Fixed site URL. */
  website: string;
  /** Wide banner so Damus does not show an empty header. */
  banner: string;
  /** 21.gifts icon so Damus shows a branded avatar. */
  picture: string;
  /** LUD-16 when the account has a linked address. */
  lud16?: string;
  /** NIP-05 identifier (`name@21.gifts`) when the public host is set. */
  nip05?: string;
  /** Short bio. */
  about?: string;
}

/**
 * Build kind:0 `content` JSON (no extra whitespace).
 *
 * Omit `lud16` when the account has no Lightning Address. `picture` and
 * `banner` use the personal profile-note photo when the worker passes those
 * URLs, otherwise {@link KIND0_PICTURE_URL} and {@link KIND0_BANNER_URL}.
 * `about` defaults to `21.gifts` and is the profile-note text when the worker
 * passes it. Set `nip05` when a public host is available. Never set `bot`.
 *
 * @param name - Non-null display name.
 * @param lightningAddress - Linked LUD-16, or `null`.
 * @param nip05 - NIP-05 identifier, or `null`.
 * @param about - Kind:0 about text (profile note, or default `21.gifts`).
 * @param images - Optional personal `picture` and `banner` URLs. Blank values fall back to the shared images.
 * @returns JSON string for the kind:0 `content` field.
 */
export function buildKind0Content(
  name: string,
  lightningAddress: string | null,
  nip05: string | null = null,
  about: string = '21.gifts',
  images: { picture?: string | null; banner?: string | null } | null = null,
): string {
  const body: Kind0ProfileContent = {
    name,
    display_name: name,
    website: 'https://21.gifts',
    banner: profileImageUrl(images?.banner, KIND0_BANNER_URL),
    picture: profileImageUrl(images?.picture, KIND0_PICTURE_URL),
    about,
  };
  if (lightningAddress !== null) {
    body.lud16 = lightningAddress;
  }
  if (nip05 !== null && nip05 !== '') {
    body.nip05 = nip05;
  }
  return JSON.stringify(body);
}

/** Unsigned kind:0 fields before `finalizeEvent`. */
export interface UnsignedKind0 {
  /** Kind 0. */
  kind: 0;
  /** Profile JSON. */
  content: string;
  /** Empty tags. */
  tags: string[][];
  /** Unix seconds at publish. */
  created_at: number;
}

/**
 * Build an unsigned replaceable kind:0 profile event.
 *
 * @param name - Non-null display name.
 * @param lightningAddress - Linked LUD-16, or `null`.
 * @param createdAtUnix - Unix seconds at enqueue/publish.
 * @param nip05 - NIP-05 identifier, or `null`.
 * @param about - Kind:0 about text (profile note, or default `21.gifts`).
 * @param images - Optional personal `picture` and `banner` URLs.
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind0Event(
  name: string,
  lightningAddress: string | null,
  createdAtUnix: number,
  nip05: string | null = null,
  about: string = '21.gifts',
  images: { picture?: string | null; banner?: string | null } | null = null,
): UnsignedKind0 {
  return {
    kind: 0,
    content: buildKind0Content(name, lightningAddress, nip05, about, images),
    tags: [],
    created_at: createdAtUnix,
  };
}

function profileImageUrl(value: string | null | undefined, fallback: string): string {
  if (value === undefined || value === null || value.trim() === '') {
    return fallback;
  }
  return value;
}

/** Unsigned kind:10002 (NIP-65) fields before `finalizeEvent`. */
export interface UnsignedKind10002 {
  /** Kind 10002. */
  kind: 10002;
  /** Empty content. */
  content: string;
  /** `r` tags for each write relay (no read/write marker → both). */
  tags: string[][];
  /** Unix seconds at publish. */
  created_at: number;
}

/**
 * Build an unsigned NIP-65 kind:10002 relay list.
 *
 * @param relayUrls - Write-set URLs (space + public as configured).
 * @param createdAtUnix - Unix seconds at enqueue/publish.
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind10002Event(
  relayUrls: readonly string[],
  createdAtUnix: number,
): UnsignedKind10002 {
  return {
    kind: 10002,
    content: '',
    tags: relayUrls.map((url) => ['r', url]),
    created_at: createdAtUnix,
  };
}
