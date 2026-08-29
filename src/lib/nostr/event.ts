/**
 * Nostr event templates for the 21.gifts forum.
 *
 * Kind:1 tags are frozen. Do not add `e`/`p`/`q` — member-forum posts are
 * top-level notes for discovery-feed virality.
 */

/** Frozen kind:1 tags, in this order. */
export const KIND1_TAGS: readonly [readonly ['t', '21gifts'], readonly ['r', 'https://21.gifts']] =
  [
    ['t', '21gifts'],
    ['r', 'https://21.gifts'],
  ] as const;

/** Mutable tag arrays for `finalizeEvent` (copy of {@link KIND1_TAGS}). */
export function kind1Tags(): string[][] {
  return KIND1_TAGS.map((tag) => [...tag]);
}

/** Unsigned kind:1 fields before `finalizeEvent`. */
export interface UnsignedKind1 {
  /** Kind 1. */
  kind: 1;
  /** Exact `normalizeForumText` output. */
  content: string;
  /** Frozen tags. */
  tags: string[][];
  /** Unix seconds from the forum row's `createdAt` (may be bumped on collision). */
  created_at: number;
}

/**
 * Build an unsigned top-level kind:1 for a forum message.
 *
 * Content is plaintext (no name prefix). Tags are frozen — no `e`/`p`/`q`.
 *
 * @param content - Already-normalised forum text.
 * @param createdAtUnix - Unix seconds for the event.
 * @returns Unsigned event fields for `finalizeEvent`.
 */
export function buildKind1Event(content: string, createdAtUnix: number): UnsignedKind1 {
  return {
    kind: 1,
    content,
    tags: kind1Tags(),
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
  /** LUD-16 when the account has a linked address. */
  lud16?: string;
}

/**
 * Build kind:0 `content` JSON (no extra whitespace).
 *
 * Omit `lud16` when the account has no Lightning Address. Do not set `nip05`
 * or `bot` in v1.
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
