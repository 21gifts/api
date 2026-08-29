/**
 * Forum message domain: validation and public JSON projection.
 *
 * Text is free-form encouragement (not unique). Empty, over-long, or
 * disallowed control-character input is rejected so a bad value cannot be
 * stored and re-served on every list response. Newlines (`\n`, `\r`) are
 * allowed; other C0 controls and DEL are not.
 */

/** Maximum stored length after trim. */
export const MESSAGE_MAX_LENGTH = 500;

/** Cap for `listLatest` / GET `/messages`. */
export const MESSAGE_LIST_LIMIT = 200;

/** Worker publish state for a forum row. */
export type NostrPublishState = 'pending' | 'published' | 'failed';

/** Persisted forum row (store-internal; includes `accountId`). */
export interface MessageRow {
  /** Opaque unique message id. */
  id: string;
  /** Author account id. */
  accountId: string;
  /** Display name snapshotted at post time. */
  name: string;
  /** Message body (already normalised). */
  text: string;
  /** Creation instant. */
  createdAt: Date;
  /** Signed kind:1 id, or `null` until the worker signs. */
  eventId: string | null;
  /** Fan-out state. */
  nostrPublishState: NostrPublishState;
  /** Validated zap total in whole sats. */
  sats: number;
  /** Stored signed event JSON, or `null` until signed. */
  nostrEvent: Record<string, unknown> | null;
  /** Lease expiry (epoch ms), or `null`. */
  claimedUntil: number | null;
  /** First sign-or-publish attempt (epoch ms), or `null`. */
  nostrFirstAttemptAt: number | null;
  /** Publish epoch (`space` vs `space+public`). */
  nostrPublishEpoch: string | null;
  /** Sign/publish attempts in the current epoch. */
  nostrAttempts: number;
}

/** Public JSON shape of a forum message (no `accountId`, no event id). */
export interface PublicMessage {
  /** Opaque unique message id. */
  id: string;
  /** Author display name at post time. */
  name: string;
  /** Message body. */
  text: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Validated zap total in whole sats (always present). */
  sats: number;
  /** Whether `POST /messages/:id/invoice` can run. */
  payable: boolean;
}

/**
 * Trim and validate forum message text.
 *
 * @param raw - User input.
 * @returns The trimmed text, or `null` when it is empty, longer than
 * {@link MESSAGE_MAX_LENGTH}, or contains a C0 control other than LF/CR
 * (`charCode < 32` except 10 and 13) or DEL (`=== 127`). Internal spaces
 * and newlines are kept.
 */
export function normalizeForumText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > MESSAGE_MAX_LENGTH) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code === 10 || code === 13) {
      continue;
    }
    if (code < 32 || code === 127) {
      return null;
    }
  }
  return trimmed;
}

/**
 * Project a store row to its public JSON shape.
 *
 * @param row - Persisted message.
 * @param payable - Whether the note can accept a NIP-57 zap payment.
 * @returns Public fields (`sats`, `payable`; no `accountId`); `createdAt` ISO-8601.
 */
export function serializeMessage(row: MessageRow, payable: boolean): PublicMessage {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    sats: row.sats,
    payable,
  };
}

/**
 * Default Nostr columns for a freshly posted row (unsigned, pending).
 *
 * @returns The unsigned/pending defaults.
 */
export function unsignedNostrDefaults(): Pick<
  MessageRow,
  | 'eventId'
  | 'nostrPublishState'
  | 'sats'
  | 'nostrEvent'
  | 'claimedUntil'
  | 'nostrFirstAttemptAt'
  | 'nostrPublishEpoch'
  | 'nostrAttempts'
> {
  return {
    eventId: null,
    nostrPublishState: 'pending',
    sats: 0,
    nostrEvent: null,
    claimedUntil: null,
    nostrFirstAttemptAt: null,
    nostrPublishEpoch: null,
    nostrAttempts: 0,
  };
}
