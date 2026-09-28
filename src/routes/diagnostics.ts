import { Hono } from 'hono';
import type { DiagnosticStore } from '@/lib/diagnostic-log';
import { requestLogPath } from '@/lib/log';

const EVENT_RE = /^client\.[a-z0-9.]{1,60}$/;
const NAME_RE = /^[A-Za-z]{1,40}$/;
const MESSAGE_RE = /^[A-Za-z0-9._: -]{1,120}$/;
const CHALLENGE_ID_RE = /^[0-9a-f]{64}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CF_IP_RE = /^[0-9a-fA-F:.]{1,64}$/;
const HEX_RUN_RE = /[0-9a-f]{32,}/;
const STAGES = new Set(['register', 'authenticate', 'seed', 'login', 'unhandled']);
const ALLOWED_KEYS = new Set([
  'event',
  'name',
  'message',
  'prfPresent',
  'challengeId',
  'accountId',
  'stage',
  'status',
  'path',
]);
const WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 600;
const PER_IP_LIMIT = 60;

type DiagnosticFieldValue = string | number | boolean;
type ClientFields = Record<string, DiagnosticFieldValue>;

interface ClientDiagnosticBody {
  event?: unknown;
  name?: unknown;
  message?: unknown;
  prfPresent?: unknown;
  challengeId?: unknown;
  accountId?: unknown;
  stage?: unknown;
  status?: unknown;
  path?: unknown;
}

let globalAccepted: number[] = [];
const ipAccepted = new Map<string, number[]>();
let lastRateLimitedAt: number | null = null;

/**
 * Clears the in-process diagnostics rate-limit window. Used by tests.
 */
export function resetDiagnosticRateLimit(): void {
  globalAccepted = [];
  ipAccepted.clear();
  lastRateLimitedAt = null;
}

function pruneWindow(timestamps: number[], now: number): void {
  let write = 0;
  for (const timestamp of timestamps) {
    if (now - timestamp < WINDOW_MS) {
      timestamps[write] = timestamp;
      write += 1;
    }
  }
  timestamps.length = write;
}

function releaseReserved(timestamps: number[], reserved: number): void {
  const index = timestamps.lastIndexOf(reserved);
  if (index !== -1) {
    timestamps.splice(index, 1);
  }
}

function sanitizeUserAgent(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let cleaned = '';
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += char;
    }
  }
  cleaned = cleaned.slice(0, 200);
  return cleaned === '' ? undefined : cleaned;
}

function parseClientBody(
  body: unknown,
): { ok: true; event: string; fields: ClientFields } | { ok: false } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false };
  }
  const record = body as ClientDiagnosticBody;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false };
    }
  }
  const event = record.event;
  if (typeof event !== 'string' || !EVENT_RE.test(event)) {
    return { ok: false };
  }
  const fields: ClientFields = {};
  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || !NAME_RE.test(record.name)) {
      return { ok: false };
    }
    fields['name'] = record.name;
  }
  if (record.message !== undefined) {
    if (typeof record.message !== 'string' || !MESSAGE_RE.test(record.message)) {
      return { ok: false };
    }
    fields['message'] = record.message;
  }
  if (record.prfPresent !== undefined) {
    if (typeof record.prfPresent !== 'boolean') {
      return { ok: false };
    }
    fields['prfPresent'] = record.prfPresent;
  }
  if (record.challengeId !== undefined) {
    if (typeof record.challengeId !== 'string' || !CHALLENGE_ID_RE.test(record.challengeId)) {
      return { ok: false };
    }
    fields['challengeId'] = record.challengeId;
  }
  if (record.accountId !== undefined) {
    if (typeof record.accountId !== 'string' || !ACCOUNT_ID_RE.test(record.accountId)) {
      return { ok: false };
    }
    fields['accountId'] = record.accountId;
  }
  if (record.stage !== undefined) {
    if (typeof record.stage !== 'string' || !STAGES.has(record.stage)) {
      return { ok: false };
    }
    fields['stage'] = record.stage;
  }
  if (record.status !== undefined) {
    if (
      typeof record.status !== 'number' ||
      !Number.isInteger(record.status) ||
      record.status < 100 ||
      record.status > 599
    ) {
      return { ok: false };
    }
    fields['status'] = record.status;
  }
  if (record.path !== undefined) {
    if (typeof record.path !== 'string') {
      return { ok: false };
    }
    const redacted = requestLogPath(record.path);
    if (HEX_RUN_RE.test(redacted) || redacted.includes('?')) {
      return { ok: false };
    }
    fields['path'] = redacted;
  }
  return { ok: true, event, fields };
}

/**
 * Public client diagnostic ingest. Allowlisted scalars only; no auth.
 *
 * @param deps - Persistence port and optional injectable clock (epoch ms).
 * @returns A Hono app exposing `POST /`.
 */
export function diagnosticsRoutes(deps: { store: DiagnosticStore; now?: () => number }): Hono {
  const clock = deps.now ?? Date.now;
  return new Hono().post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid diagnostics' }, 400);
    }
    const parsed = parseClientBody(body);
    if (!parsed.ok) {
      return c.json({ error: 'Invalid diagnostics' }, 400);
    }

    const now = clock();
    const ipHeader = c.req.header('cf-connecting-ip');
    const ip = ipHeader !== undefined && CF_IP_RE.test(ipHeader) ? ipHeader : undefined;
    pruneWindow(globalAccepted, now);
    let ipBucket: number[] | undefined;
    if (ip !== undefined) {
      const existing = ipAccepted.get(ip);
      if (existing !== undefined) {
        pruneWindow(existing, now);
        if (existing.length === 0) {
          ipAccepted.delete(ip);
        } else {
          ipBucket = existing;
        }
      }
    }
    if (
      globalAccepted.length >= GLOBAL_LIMIT ||
      (ipBucket !== undefined && ipBucket.length >= PER_IP_LIMIT)
    ) {
      if (lastRateLimitedAt === null || now - lastRateLimitedAt >= WINDOW_MS) {
        const previousRateLimitedAt = lastRateLimitedAt;
        lastRateLimitedAt = now;
        try {
          await deps.store.append({
            id: crypto.randomUUID(),
            createdAt: new Date(now),
            source: 'server',
            event: 'diagnostics.rate_limited',
            fields: {},
          });
        } catch {
          lastRateLimitedAt = previousRateLimitedAt;
        }
      }
      return c.json({ error: 'Too many diagnostics' }, 429);
    }

    // Reserve before the insert await so a second in-flight request cannot take the same slot.
    globalAccepted.push(now);
    if (ip !== undefined) {
      if (ipBucket === undefined) {
        ipBucket = [];
        ipAccepted.set(ip, ipBucket);
      }
      ipBucket.push(now);
    }
    const fields: ClientFields = { ...parsed.fields };
    const userAgent = sanitizeUserAgent(c.req.header('user-agent'));
    if (userAgent !== undefined) {
      fields['userAgent'] = userAgent;
    }
    try {
      await deps.store.append({
        id: crypto.randomUUID(),
        createdAt: new Date(now),
        source: 'client',
        event: parsed.event,
        fields,
      });
    } catch {
      releaseReserved(globalAccepted, now);
      if (ip !== undefined && ipBucket !== undefined) {
        releaseReserved(ipBucket, now);
        if (ipBucket.length === 0) {
          ipAccepted.delete(ip);
        }
      }
      return c.json({ error: 'Log is unavailable' }, 500);
    }
    return c.body(null, 204);
  });
}
