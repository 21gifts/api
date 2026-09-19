import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import { MESSAGE_MAX_LENGTH, normalizeForumText, truncatePubkeyDisplay } from '@/lib/message';
import { NAME_MAX_LENGTH } from '@/lib/name';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import { utcDayKey } from '@/lib/nostr/rate-limit';

/** Minimum indexed zap (sats) that makes an external pubkey visible. */
export const EXTERNAL_ZAPPER_MIN_SATS = 1;

/** Inbound external replies older than this at ingest time never notify. */
export const EXTERNAL_REPLY_NOTIFY_MAX_AGE_MS = 60 * 60 * 1000;

/** Maximum future clock skew for an inbound external-reply notification. */
export const EXTERNAL_REPLY_FUTURE_SKEW_MS = 10 * 60 * 1000;

/** Strictly verified payer details from an embedded NIP-57 zap request. */
export interface VerifiedExternalZapRequest {
  /** Lowercase signing pubkey. */
  pubkey: string;
  /** Signed kind:9734 event id. */
  requestId: string;
  /** Normalised forum comment, possibly empty. */
  content: string;
}

interface ZapRequestShape {
  kind?: unknown;
  pubkey?: unknown;
  content?: unknown;
  id?: unknown;
  sig?: unknown;
  created_at?: unknown;
  tags?: unknown;
}

function taggedValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name && typeof tag[1] === 'string')?.[1];
}

/**
 * Strictly attribute a kind:9735 receipt to its embedded signed kind:9734.
 *
 * @param args - Receipt tags, decoded invoice commitment and target note id.
 * @returns Verified payer request details, or `null` when any NIP-57 binding fails.
 */
export function verifiedExternalZapRequest(args: {
  tags: string[][];
  descriptionHash: string | null;
  amountMsat: bigint | number | null;
  noteEventId: string;
}): VerifiedExternalZapRequest | null {
  const description = taggedValue(args.tags, 'description');
  if (description === undefined || description === '') {
    return null;
  }
  const expectedHash = args.descriptionHash?.toLowerCase() ?? null;
  if (expectedHash === null || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return null;
  }
  const actualHash = createHash('sha256').update(description, 'utf8').digest('hex');
  if (actualHash !== expectedHash) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(description) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const event = parsed as ZapRequestShape;
  if (
    event.kind !== 9734 ||
    typeof event.id !== 'string' ||
    event.id === '' ||
    typeof event.sig !== 'string' ||
    event.sig === '' ||
    typeof event.pubkey !== 'string' ||
    event.pubkey === '' ||
    typeof event.created_at !== 'number' ||
    !Array.isArray(event.tags) ||
    typeof event.content !== 'string'
  ) {
    return null;
  }
  try {
    if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
      return null;
    }
    /* v8 ignore next 3 -- nostr-tools verifyEvent returns boolean, does not throw */
  } catch {
    return null;
  }
  const requestTags = event.tags as unknown[];
  const targetsNote = requestTags.some(
    (tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1] === args.noteEventId,
  );
  if (!targetsNote) {
    return null;
  }
  const amountTag = requestTags.find(
    (tag) => Array.isArray(tag) && tag[0] === 'amount' && typeof tag[1] === 'string',
  ) as unknown[] | undefined;
  if (amountTag !== undefined) {
    const rawAmount = amountTag[1];
    if (typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount) || args.amountMsat === null) {
      return null;
    }
    let invoiceAmount: bigint;
    try {
      invoiceAmount = BigInt(args.amountMsat);
    } catch {
      return null;
    }
    if (BigInt(rawAmount) !== invoiceAmount) {
      return null;
    }
  }
  return {
    pubkey: event.pubkey.toLowerCase(),
    requestId: event.id,
    content: normalizeForumText(event.content, MESSAGE_MAX_LENGTH) ?? '',
  };
}

const RESERVED_NAME_PARTS = [
  '21gifts',
  'team',
  'support',
  'admin',
  'moderator',
  'founder',
  'staff',
  'official',
] as const;

/**
 * Explicit bidi controls can render logical-order text reversed, making a name such as RLO plus
 * `nimda` appear to a moderator as the reserved word `admin` without matching the lossy folds.
 */
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Common single-codepoint Cyrillic and Greek look-alikes used in Latin names. */
const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = {
  '\u0410': 'A',
  '\u0430': 'a',
  '\u0415': 'E',
  '\u0435': 'e',
  '\u041e': 'O',
  '\u043e': 'o',
  '\u0420': 'P',
  '\u0440': 'p',
  '\u0421': 'C',
  '\u0441': 'c',
  '\u0425': 'X',
  '\u0445': 'x',
  '\u0423': 'Y',
  '\u0443': 'y',
  '\u0406': 'I',
  '\u0456': 'i',
  '\u0408': 'J',
  '\u0458': 'j',
  '\u0405': 'S',
  '\u0455': 's',
  '\u04ba': 'H',
  '\u04bb': 'h',
  '\u0500': 'D',
  '\u0501': 'd',
  '\u051a': 'Q',
  '\u051b': 'q',
  '\u051c': 'W',
  '\u051d': 'w',
  '\u041a': 'K',
  '\u043a': 'k',
  '\u041c': 'M',
  '\u043c': 'm',
  '\u0422': 'T',
  '\u0442': 't',
  '\u0412': 'B',
  '\u0432': 'b',
  // н/Н map to h/H for their Latin-glyph resemblance, rather than transliterating to n/N.
  '\u041d': 'H',
  '\u043d': 'h',
  '\u0391': 'A',
  '\u03b1': 'a',
  '\u039f': 'O',
  '\u03bf': 'o',
  '\u03a1': 'P',
  '\u03c1': 'p',
  // Capital nu looks like N, small nu like v.
  '\u039d': 'N',
  '\u03bd': 'v',
  '\u03a4': 'T',
  '\u03c4': 't',
  '\u039a': 'K',
  '\u03ba': 'k',
  '\u0399': 'I',
  '\u03b9': 'i',
  // Each case maps to its own glyph look-alike (the fold lower-cases afterwards):
  // capital upsilon looks like Y, small upsilon like u.
  '\u03a5': 'Y',
  '\u03c5': 'u',
  '\u03a7': 'X',
  '\u03c7': 'x',
  '\u0395': 'E',
  '\u03b5': 'e',
  '\u0392': 'B',
  '\u03b2': 'b',
  // Capital eta looks like H, small eta like n.
  '\u0397': 'H',
  '\u03b7': 'n',
  // Capital mu looks like M, small mu (the micro sign shape) like u.
  '\u039c': 'M',
  '\u03bc': 'u',
};

/**
 * Cyrillic letters by sound, for words that READ like a reserved word or a member name without
 * looking like Latin glyphs (for example the Russian word for admin). Used in addition to the
 * glyph table above, never instead of it.
 */
const CYRILLIC_TRANSLITERATION: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0431': 'b',
  '\u0432': 'v',
  '\u0433': 'g',
  '\u0434': 'd',
  '\u0435': 'e',
  '\u0437': 'z',
  '\u0438': 'i',
  '\u0439': 'i',
  '\u0456': 'i',
  '\u043a': 'k',
  '\u043b': 'l',
  '\u043c': 'm',
  '\u043d': 'n',
  '\u043e': 'o',
  '\u043f': 'p',
  '\u0440': 'r',
  '\u0441': 's',
  '\u0442': 't',
  '\u0443': 'u',
  '\u0444': 'f',
  '\u0445': 'h',
  '\u0446': 'c',
};

const LATIN_LETTER_RE = /(?=\p{L})[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/u;
const GREEK_LETTER_RE = /(?=\p{L})[\u0370-\u03ff]/u;
const CYRILLIC_LETTER_RE = /(?=\p{L})[\u0400-\u052f]/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const LETTER_RE = /\p{L}/u;
const ASCII_LETTER_RE = /[A-Za-z]/u;

/** Fold a name by sound: lower-case, transliterate Cyrillic, keep only `[a-z0-9]`. */
function transliteratedName(value: string): string {
  let mapped = '';
  const normalized = value.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase();
  for (const character of normalized) {
    mapped += CYRILLIC_TRANSLITERATION[character] ?? character;
  }
  return mapped.replaceAll(/[^a-z0-9]/g, '');
}

function foldedName(value: string): string {
  let mapped = '';
  const normalized = value.normalize('NFKD').replaceAll(/\p{M}/gu, '');
  for (const character of normalized) {
    mapped += CONFUSABLE_TO_LATIN[character] ?? character;
  }
  return mapped.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/** True when every letter survives the glyph look-alike fold. */
function hasCompleteConfusableFold(value: string): boolean {
  const normalized = value.normalize('NFKD').replaceAll(/\p{M}/gu, '');
  for (const character of normalized) {
    if (
      LETTER_RE.test(character) &&
      !ASCII_LETTER_RE.test(character) &&
      CONFUSABLE_TO_LATIN[character] === undefined
    ) {
      return false;
    }
  }
  return true;
}

/** True when every letter survives the Cyrillic transliteration fold. */
function hasCompleteTransliteration(value: string): boolean {
  const normalized = value.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase();
  for (const character of normalized) {
    if (
      LETTER_RE.test(character) &&
      !ASCII_LETTER_RE.test(character) &&
      CYRILLIC_TRANSLITERATION[character] === undefined
    ) {
      return false;
    }
  }
  return true;
}

/** True when a name mixes more than one of the Latin, Cyrillic and Greek scripts. */
function mixesConfusableScripts(value: string): boolean {
  const scripts = new Set<string>();
  for (const character of value.normalize('NFKD')) {
    if (LATIN_LETTER_RE.test(character)) {
      scripts.add('latin');
    } else if (CYRILLIC_LETTER_RE.test(character)) {
      scripts.add('cyrillic');
    } else if (GREEK_LETTER_RE.test(character)) {
      scripts.add('greek');
    }
  }
  return scripts.size > 1;
}

/** Case-insensitive comparison of two names after compatibility normalisation. */
function sameRawName(a: string, b: string): boolean {
  return a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
}

/**
 * Choose a safe display-name snapshot for an external Nostr author.
 *
 * @param args - Profile name, author pubkey, and current member names.
 * @returns A trimmed, capped non-reserved profile name or a truncated pubkey.
 */
export function externalDisplayName(args: {
  profileName: string | null;
  pubkey: string;
  accountNames: readonly string[];
}): string {
  const fallback = truncatePubkeyDisplay(args.pubkey);
  if (args.profileName === null) {
    return fallback;
  }
  const trimmed = args.profileName.trim();
  if (trimmed === '') {
    return fallback;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) {
      return fallback;
    }
  }
  if (BIDI_CONTROL_RE.test(trimmed)) {
    return fallback;
  }
  const capped = trimmed.slice(0, NAME_MAX_LENGTH);
  const folded = foldedName(capped);
  const transliterated = transliteratedName(capped);
  const completeConfusableFold = hasCompleteConfusableFold(capped);
  const completeTransliteration = hasCompleteTransliteration(capped);
  if (
    !LETTER_OR_DIGIT_RE.test(capped) ||
    args.accountNames.some(
      (name) =>
        sameRawName(name, capped) ||
        (folded !== '' && completeConfusableFold && foldedName(name) === folded) ||
        (transliterated !== '' &&
          completeTransliteration &&
          transliteratedName(name) === transliterated),
    ) ||
    RESERVED_NAME_PARTS.some((part) => folded.includes(part) || transliterated.includes(part)) ||
    mixesConfusableScripts(capped)
  ) {
    return fallback;
  }
  return capped;
}

interface ProfileCacheRow {
  name: string | null;
  expiresAt: number;
}

const profileCache = new Map<string, ProfileCacheRow>();
const PROFILE_HIT_TTL_MS = 60 * 60 * 1000;
const PROFILE_MISS_TTL_MS = 5 * 60 * 1000;
const PROFILE_CONTENT_MAX_LENGTH = 64 * 1024;
const PROFILE_CACHE_MAX_ENTRIES = 5000;

/** Verify a queried kind:0 frame is a signed Nostr event. */
function defaultVerifyProfile(event: NostrEventFrame): boolean {
  if (
    typeof event.created_at !== 'number' ||
    typeof event.id !== 'string' ||
    event.id === '' ||
    typeof event.sig !== 'string' ||
    event.sig === ''
  ) {
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

function profileNameFromEvent(event: NostrEventFrame): string | null {
  if (typeof event.content !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const profile = parsed as Record<string, unknown>;
    const displayName = profile['display_name'];
    if (typeof displayName === 'string' && displayName.trim() !== '') {
      return displayName;
    }
    const name = profile['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the newest verified kind:0 profile name for an external pubkey.
 *
 * Successful names are cached for one hour; misses and failures for five
 * minutes. Relay and parsing failures are collapsed to `null`.
 *
 * @param args - Relay querier, URLs, pubkey, clock, timeout, and optional verifier.
 * @returns `display_name`, then `name`, from the newest profile, or `null`.
 */
export async function resolveExternalProfileName(args: {
  querier: NostrQuerier;
  urls: readonly string[];
  pubkey: string;
  nowMs: number;
  timeoutMs: number;
  /** Signature check; production uses nostr-tools `verifyEvent`. */
  verifyProfile?: (event: NostrEventFrame) => boolean;
}): Promise<string | null> {
  const pubkey = args.pubkey.toLowerCase();
  const cached = profileCache.get(pubkey);
  if (cached !== undefined && cached.expiresAt > args.nowMs) {
    return cached.name;
  }
  if (cached !== undefined) {
    profileCache.delete(pubkey);
  }
  let name: string | null = null;
  try {
    const verifyProfile = args.verifyProfile ?? defaultVerifyProfile;
    const events = await args.querier.query(
      { kinds: [0], authors: [pubkey], limit: 20 },
      args.urls,
      args.timeoutMs,
    );
    const newest = events
      .filter(
        (event) =>
          event.kind === 0 &&
          event.pubkey.toLowerCase() === pubkey &&
          (typeof event.content !== 'string' ||
            event.content.length <= PROFILE_CONTENT_MAX_LENGTH) &&
          verifyProfile(event),
      )
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    const rawName = newest === undefined ? null : profileNameFromEvent(newest);
    name = rawName === null ? null : rawName.trim().slice(0, NAME_MAX_LENGTH);
  } catch {
    name = null;
  }
  if (profileCache.size >= PROFILE_CACHE_MAX_ENTRIES) {
    profileCache.delete(profileCache.keys().next().value!);
  }
  profileCache.set(pubkey, {
    name,
    expiresAt: args.nowMs + (name === null ? PROFILE_MISS_TTL_MS : PROFILE_HIT_TTL_MS),
  });
  return name;
}

interface IngestHits {
  hours: number[];
  days: Map<string, number>;
  lastHitAt: number;
}

const EXTERNAL_HOUR_MS = 60 * 60 * 1000;
const EXTERNAL_IDLE_MS = 48 * EXTERNAL_HOUR_MS;

/**
 * In-process per-pubkey and global sliding limits for external Nostr replies.
 * Successful acquisitions can be released when persistence fails.
 */
export class ExternalIngestLimiter {
  readonly #byPubkey = new Map<string, IngestHits>();
  readonly #global: IngestHits = { hours: [], days: new Map(), lastHitAt: 0 };

  /**
   * Check and record an external reply against per-pubkey and global limits.
   *
   * @param pubkey - External author pubkey.
   * @param nowMs - Current epoch milliseconds.
   * @returns `true` when accepted; `false` when either window is exhausted.
   */
  tryAcquire(pubkey: string, nowMs: number): boolean {
    this.#evictIdle(nowMs);
    const key = pubkey.toLowerCase();
    const local = this.#hits(key);
    const day = utcDayKey(nowMs);
    const localHours = local.hours.filter((at) => nowMs - at < EXTERNAL_HOUR_MS);
    const globalHours = this.#global.hours.filter((at) => nowMs - at < EXTERNAL_HOUR_MS);
    const localDay = local.days.get(day) ?? 0;
    const globalDay = this.#global.days.get(day) ?? 0;
    if (localHours.length >= 6 || localDay >= 20 || globalHours.length >= 30 || globalDay >= 100) {
      return false;
    }
    localHours.push(nowMs);
    globalHours.push(nowMs);
    local.hours = localHours;
    this.#global.hours = globalHours;
    local.days.set(day, localDay + 1);
    this.#global.days.set(day, globalDay + 1);
    local.lastHitAt = nowMs;
    this.#global.lastHitAt = nowMs;
    return true;
  }

  /**
   * Undo the retained acquisition matching an external pubkey and timestamp.
   *
   * Removes the matching per-pubkey and global hourly hit and decrements both
   * UTC-day counters without letting either become negative. This is a no-op
   * when the exact acquisition is not retained, including after idle eviction.
   *
   * @param pubkey - External author pubkey from the successful acquisition.
   * @param nowMs - Exact epoch milliseconds passed to the successful acquisition.
   * @returns Nothing.
   */
  release(pubkey: string, nowMs: number): void {
    this.#evictIdle(nowMs);
    const local = this.#byPubkey.get(pubkey.toLowerCase());
    if (local === undefined) {
      return;
    }
    const localIndex = local.hours.indexOf(nowMs);
    if (localIndex === -1) {
      return;
    }
    local.hours.splice(localIndex, 1);
    const globalIndex = this.#global.hours.indexOf(nowMs);
    if (globalIndex !== -1) {
      this.#global.hours.splice(globalIndex, 1);
    }
    const day = utcDayKey(nowMs);
    local.days.set(day, Math.max(0, local.days.get(day)! - 1));
    this.#global.days.set(day, Math.max(0, this.#global.days.get(day)! - 1));
  }

  #hits(pubkey: string): IngestHits {
    const existing = this.#byPubkey.get(pubkey);
    if (existing !== undefined) {
      return existing;
    }
    const created: IngestHits = { hours: [], days: new Map(), lastHitAt: 0 };
    this.#byPubkey.set(pubkey, created);
    return created;
  }

  #evictIdle(nowMs: number): void {
    for (const [pubkey, hits] of this.#byPubkey) {
      if (nowMs - hits.lastHitAt > EXTERNAL_IDLE_MS) {
        this.#byPubkey.delete(pubkey);
      }
    }
  }
}
