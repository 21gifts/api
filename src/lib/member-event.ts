import { parseClientInstant } from '@/lib/client-instant';
import { containsEncodedSecret } from '@/lib/encoded-secret';
import { isSecretFieldName } from '@/lib/secret-shape';

/** Allow-listed first-party interaction event names. */
export const MEMBER_EVENT_NAMES: ReadonlySet<string> = new Set([
  'screen_view',
  'post_created',
  'reply_created',
  'gift_sent',
  'payment_sent',
  'payment_received_seen',
  'pos_charge_created',
  'pos_charge_paid_seen',
  'wallet_unlocked',
  'wallet_locked',
  'search',
  'shop_opened',
  'profile_opened',
  'login',
  'signup_completed',
]);

/** Maximum events in one `POST /me/events` body. */
export const MEMBER_EVENT_BATCH_MAX = 50;

/** Maximum keys on one event's `props` object; more drops the event. */
export const MEMBER_EVENT_PROPS_MAX = 20;

/** Allow-listed scalar stored on an event. */
export type MemberEventPropValue = string | number | boolean | null;

/** One validated member interaction event. */
export interface ParsedMemberEvent {
  /** Allow-listed event name. */
  name: string;
  /** Client instant (`at`). */
  at: Date;
  /** Path with query/fragment stripped, or `null`. */
  path: string | null;
  /** Allow-listed scalar props; secret keys and secret-shaped values omitted. */
  props: Record<string, MemberEventPropValue>;
}

const PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PROP_STRING_MAX = 200;
const PATH_MAX = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasC0OrDel(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function cutQueryAndFragment(path: string): string {
  const queryAt = path.indexOf('?');
  const hashAt = path.indexOf('#');
  let end = path.length;
  if (queryAt !== -1) {
    end = queryAt;
  }
  if (hashAt !== -1 && hashAt < end) {
    end = hashAt;
  }
  return path.slice(0, end);
}

function isValidMemberPath(path: string): boolean {
  if (path.length < 1 || path.length > PATH_MAX || !path.startsWith('/')) {
    return false;
  }
  if (hasC0OrDel(path)) {
    return false;
  }
  // A key or a recovery phrase anywhere in the path, also percent-encoded or inside an encoded token, never reaches storage.
  return !containsEncodedSecret(path);
}

function parseIncomingProps(raw: Record<string, unknown>): Record<string, MemberEventPropValue> {
  const out: Record<string, MemberEventPropValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PROP_KEY_RE.test(key) || isSecretFieldName(key)) {
      continue;
    }
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        out[key] = value;
      }
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > PROP_STRING_MAX || hasC0OrDel(value) || containsEncodedSecret(value)) {
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

function parseOne(entry: unknown, nowMs: number): ParsedMemberEvent | null {
  if (!isPlainObject(entry)) {
    return null;
  }
  const name = entry['name'];
  if (typeof name !== 'string' || !MEMBER_EVENT_NAMES.has(name)) {
    return null;
  }
  const at = parseClientInstant(entry['at'], nowMs);
  if (at === null) {
    return null;
  }
  const pathRaw = entry['path'];
  let path: string | null;
  if (pathRaw === undefined || pathRaw === null) {
    path = null;
  } else if (typeof pathRaw !== 'string') {
    return null;
  } else {
    const cut = cutQueryAndFragment(pathRaw);
    if (!isValidMemberPath(cut)) {
      return null;
    }
    path = cut;
  }
  const propsRaw = entry['props'];
  let props: Record<string, MemberEventPropValue>;
  if (propsRaw === undefined || propsRaw === null) {
    props = {};
  } else if (!isPlainObject(propsRaw)) {
    return null;
  } else {
    if (Object.keys(propsRaw).length > MEMBER_EVENT_PROPS_MAX) {
      return null;
    }
    props = parseIncomingProps(propsRaw);
  }
  return { name, at, path, props };
}

/**
 * Parse `{ events: [...] }` into validated events, dropping invalid entries.
 *
 * Unknown keys of the body and of each event are ignored. The batch is rejected
 * only when the body is not a plain object, `events` is not an array, or the
 * array is longer than {@link MEMBER_EVENT_BATCH_MAX}.
 *
 * @param body - Parsed JSON body.
 * @param nowMs - Current time (epoch ms) for client-instant bounds.
 * @returns Validated events and a drop count, or `{ ok: false }`.
 */
export function parseMemberEventBatch(
  body: unknown,
  nowMs: number,
): { ok: true; events: ParsedMemberEvent[]; dropped: number } | { ok: false } {
  if (!isPlainObject(body)) {
    return { ok: false };
  }
  const rawEvents = body['events'];
  if (!Array.isArray(rawEvents)) {
    return { ok: false };
  }
  const entries = rawEvents as readonly unknown[];
  if (entries.length > MEMBER_EVENT_BATCH_MAX) {
    return { ok: false };
  }
  const events: ParsedMemberEvent[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const parsed = parseOne(entry, nowMs);
    if (parsed === null) {
      dropped += 1;
    } else {
      events.push(parsed);
    }
  }
  return { ok: true, events, dropped };
}
