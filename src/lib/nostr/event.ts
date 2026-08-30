/**
 * Nostr event templates for the 21.gifts forum.
 *
 * Kind:1 tags are frozen. Do not add `e`/`p`/`q` — member-forum posts are
 * top-level notes for discovery-feed virality.
 */

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

/** Optional NIP-92 image attached to a kind:1. */
export interface Kind1Photo {
  /** Absolute HTTPS URL clients fetch. */
  url: string;
  /** Stored MIME type. */
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
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

/** Mutable tag arrays for `finalizeEvent` (copy of {@link KIND1_TAGS}). */
export function kind1Tags(): string[][] {
  return KIND1_TAGS.map((tag) => [...tag]);
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
 * Append any missing `#bitcoin` / `#21gifts` so Damus renders them.
 * Forum text is unchanged by the caller; this only shapes Nostr content.
 *
 * Empty content → `"#bitcoin #21gifts"` (no leading blank line).
 * Non-empty → trailing newlines stripped, then `\n\n` + missing tags joined by a single space.
 * Already-present tags (any case, e.g. `#21Gifts`) are not duplicated; only missing ones are appended, still in KIND1_CONTENT_HASHTAGS order.
 *
 * @param content - Forum text and optional photo URL already composed.
 * @returns Content with any missing hashtag tokens appended (unchanged when both are already present).
 */
export function kind1ContentWithHashtags(content: string): string {
  const missing = KIND1_CONTENT_HASHTAGS.filter((tag) => !kind1HasHashtag(content, tag.slice(1)));
  if (missing.length === 0) {
    return content;
  }
  const suffix = missing.join(' ');
  if (content === '') {
    return suffix;
  }
  return `${content.replace(/\n+$/, '')}\n\n${suffix}`;
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
 * Build an unsigned top-level kind:1 for a forum message.
 *
 * Content is plaintext (no name prefix). `kind1ContentWithHashtags` ensures
 * Damus-visible `#bitcoin` / `#21gifts` tokens (appends only missing ones).
 * Tags are frozen — no `e`/`p`/`q`.
 *
 * @param content - Already-normalised forum text (may be empty when `photo` is set).
 * @param createdAtUnix - Unix seconds for the event.
 * @param photo - Optional public image (URL in content + NIP-92 `imeta`).
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind1Event(
  content: string,
  createdAtUnix: number,
  photo?: Kind1Photo,
): UnsignedKind1 {
  const tags = kind1Tags();
  let body = content;
  if (photo !== undefined) {
    body = content === '' ? photo.url : `${content}\n${photo.url}`;
    tags.push(['imeta', `url ${photo.url}`, `m ${photo.mime}`]);
  }
  body = kind1ContentWithHashtags(body);
  return {
    kind: 1,
    content: body,
    tags,
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
  /** 21.gifts icon so Damus shows a branded avatar. */
  picture: string;
  /** LUD-16 when the account has a linked address. */
  lud16?: string;
}

/**
 * Build kind:0 `content` JSON (no extra whitespace).
 *
 * Omit `lud16` when the account has no Lightning Address. Always set `picture`
 * to {@link KIND0_PICTURE_URL}. Do not set `nip05` or `bot` in v1.
 *
 * @param name - Non-null display name.
 * @param lightningAddress - Linked LUD-16, or `null`.
 * @returns JSON string for the kind:0 `content` field.
 */
export function buildKind0Content(name: string, lightningAddress: string | null): string {
  const body: Kind0ProfileContent = {
    name,
    display_name: name,
    website: 'https://21.gifts',
    picture: KIND0_PICTURE_URL,
  };
  if (lightningAddress !== null) {
    body.lud16 = lightningAddress;
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
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind0Event(
  name: string,
  lightningAddress: string | null,
  createdAtUnix: number,
): UnsignedKind0 {
  return {
    kind: 0,
    content: buildKind0Content(name, lightningAddress),
    tags: [],
    created_at: createdAtUnix,
  };
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
