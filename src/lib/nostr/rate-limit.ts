/**
 * In-process per-account rate limits for forum posts, note invoices, and hearts.
 *
 * Mixed windows: sliding 10s / 1h; calendar UTC day for posts. Idle keys
 * (no hits for 48h) are evicted so the map stays bounded. Single-process
 * only — two containers during deploy can double the cap.
 */

/** Sliding 10-second window for posts (cap 1). */
export const POST_BURST_WINDOW_MS = 10_000;

/** Sliding 1-hour window for posts (cap 6). */
export const POST_HOUR_WINDOW_MS = 60 * 60 * 1000;

/** Max posts per sliding 10s. */
export const POST_BURST_CAP = 1;

/** Max posts per sliding hour. */
export const POST_HOUR_CAP = 6;

/** Max posts per UTC calendar day. */
export const POST_DAY_CAP = 20;

/** Sliding 10-second window for invoices (cap 1). */
export const INVOICE_BURST_WINDOW_MS = 10_000;

/** Sliding 1-hour window for invoices (cap 20). */
export const INVOICE_HOUR_WINDOW_MS = 60 * 60 * 1000;

/** Max invoices per sliding 10s. */
export const INVOICE_BURST_CAP = 1;

/** Max invoices per sliding hour. */
export const INVOICE_HOUR_CAP = 20;

/** Per-account invoice caps. */
export interface InvoiceRateCaps {
  /** Max invoices per sliding 10s. */
  burstCap: number;
  /** Max invoices per sliding hour. */
  hourCap: number;
}

/** Highest value `resolveTestInvoiceRateCaps` accepts for either cap. */
const TEST_INVOICE_CAP_MAX = 100_000;

/** Bind hosts that may honour `TEST_INVOICE_*_CAP`. */
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Per-note cooldown for hearts: one heart per account and note per 10 s. */
export const HEART_NOTE_COOLDOWN_MS = 10_000;

/** Sliding 1-hour window for hearts (cap 60). */
export const HEART_HOUR_WINDOW_MS = 60 * 60 * 1000;

/** Max hearts per account per sliding hour, across all notes. */
export const HEART_HOUR_CAP = 60;

/** Evict account keys with no hit for this long. */
const IDLE_EVICT_MS = 48 * 60 * 60 * 1000;

/** Per-account hit timestamps for one limiter. */
interface AccountHits {
  /** Sliding-window timestamps (ms). */
  bursts: number[];
  /** Sliding-hour timestamps (ms). */
  hours: number[];
  /** UTC day key `YYYY-MM-DD` → count (posts only). */
  days: Map<string, number>;
  /** Last successful check time (for idle eviction). */
  lastHitAt: number;
}

/**
 * UTC calendar day key for a timestamp.
 *
 * @param nowMs - Epoch milliseconds.
 * @returns `YYYY-MM-DD` in UTC.
 */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * In-process rate limiter for forum posts (1/10s, 6/h, 20/UTC-day).
 */
export class PostRateLimiter {
  readonly #byAccount = new Map<string, AccountHits>();

  /**
   * Check and record a post attempt.
   *
   * @param accountId - Account id.
   * @param nowMs - Current time (epoch ms).
   * @returns `true` when allowed; `false` when over limit (not recorded).
   */
  allow(accountId: string, nowMs: number): boolean {
    this.#evictIdle(nowMs);
    const hits = this.#hits(accountId);
    const day = utcDayKey(nowMs);
    const bursts = hits.bursts.filter((t) => nowMs - t < POST_BURST_WINDOW_MS);
    const hours = hits.hours.filter((t) => nowMs - t < POST_HOUR_WINDOW_MS);
    const dayCount = hits.days.get(day) ?? 0;
    if (
      bursts.length >= POST_BURST_CAP ||
      hours.length >= POST_HOUR_CAP ||
      dayCount >= POST_DAY_CAP
    ) {
      return false;
    }
    bursts.push(nowMs);
    hours.push(nowMs);
    hits.bursts = bursts;
    hits.hours = hours;
    hits.days.set(day, dayCount + 1);
    hits.lastHitAt = nowMs;
    return true;
  }

  #hits(accountId: string): AccountHits {
    const existing = this.#byAccount.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const created: AccountHits = {
      bursts: [],
      hours: [],
      days: new Map(),
      lastHitAt: 0,
    };
    this.#byAccount.set(accountId, created);
    return created;
  }

  #evictIdle(nowMs: number): void {
    for (const [id, hits] of this.#byAccount) {
      if (nowMs - hits.lastHitAt > IDLE_EVICT_MS) {
        this.#byAccount.delete(id);
      }
    }
  }
}

/**
 * In-process rate limiter for note invoices (1/10s, 20/h by default).
 */
export class InvoiceRateLimiter {
  readonly #byAccount = new Map<string, AccountHits>();
  readonly #caps: InvoiceRateCaps;

  /**
   * @param caps - Per-account caps (default {@link INVOICE_BURST_CAP} /
   *   {@link INVOICE_HOUR_CAP}).
   */
  constructor(caps: InvoiceRateCaps = { burstCap: INVOICE_BURST_CAP, hourCap: INVOICE_HOUR_CAP }) {
    this.#caps = caps;
  }

  /**
   * Check and record an invoice attempt.
   *
   * @param accountId - Account id.
   * @param nowMs - Current time (epoch ms).
   * @returns `true` when allowed; `false` when over limit (not recorded).
   */
  allow(accountId: string, nowMs: number): boolean {
    this.#evictIdle(nowMs);
    const hits = this.#hits(accountId);
    const bursts = hits.bursts.filter((t) => nowMs - t < INVOICE_BURST_WINDOW_MS);
    const hours = hits.hours.filter((t) => nowMs - t < INVOICE_HOUR_WINDOW_MS);
    if (bursts.length >= this.#caps.burstCap || hours.length >= this.#caps.hourCap) {
      return false;
    }
    bursts.push(nowMs);
    hours.push(nowMs);
    hits.bursts = bursts;
    hits.hours = hours;
    hits.lastHitAt = nowMs;
    return true;
  }

  #hits(accountId: string): AccountHits {
    const existing = this.#byAccount.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const created: AccountHits = {
      bursts: [],
      hours: [],
      days: new Map(),
      lastHitAt: 0,
    };
    this.#byAccount.set(accountId, created);
    return created;
  }

  #evictIdle(nowMs: number): void {
    for (const [id, hits] of this.#byAccount) {
      if (nowMs - hits.lastHitAt > IDLE_EVICT_MS) {
        this.#byAccount.delete(id);
      }
    }
  }
}

/**
 * Host of `BIND_ADDR` (`host:port`); unset or blank is `0.0.0.0`.
 *
 * @param bindAddr - Raw `BIND_ADDR`.
 * @returns Text before the last `:`, or `0.0.0.0`.
 */
function bindAddrHost(bindAddr: string | undefined): string {
  if (bindAddr === undefined || bindAddr === '') {
    return '0.0.0.0';
  }
  const sep = bindAddr.lastIndexOf(':');
  return sep === -1 ? bindAddr : bindAddr.slice(0, sep);
}

/**
 * Parse one test invoice cap.
 *
 * @param raw - Trimmed env value; blank uses `min`.
 * @param name - Env var name for the error.
 * @param min - Default and lower bound.
 * @returns The parsed cap.
 * @throws If the value is not an integer from `min` to 100000.
 */
function parseTestInvoiceCap(raw: string, name: string, min: number): number {
  if (raw === '') {
    return min;
  }
  const n = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || n < min || n > TEST_INVOICE_CAP_MAX) {
    throw new Error(`${name} must be an integer from ${min} to ${TEST_INVOICE_CAP_MAX}`);
  }
  return n;
}

/**
 * Resolve test-only invoice caps from the environment.
 *
 * Honoured only on a local test boot: the host of `BIND_ADDR` is a loopback
 * address and `WEBAUTHN_RP_ID` is `localhost`. Both variables unset or blank
 * yields `null` (default caps). The gate is checked before any parse, so a
 * production boot ignores malformed values.
 *
 * @param env - Environment slice (injected so tests need not mutate process env).
 * @returns Caps for {@link InvoiceRateLimiter}, or `null` to keep defaults.
 * @throws If a gated boot has a value that is not an integer from the default
 *   through 100000.
 */
export function resolveTestInvoiceRateCaps(
  env: Record<string, string | undefined>,
): InvoiceRateCaps | null {
  const burstRaw = (env['TEST_INVOICE_BURST_CAP'] ?? '').trim();
  const hourRaw = (env['TEST_INVOICE_HOUR_CAP'] ?? '').trim();
  if (burstRaw === '' && hourRaw === '') {
    return null;
  }
  const host = bindAddrHost(env['BIND_ADDR']);
  if (!LOOPBACK_BIND_HOSTS.has(host) || env['WEBAUTHN_RP_ID']?.trim() !== 'localhost') {
    return null;
  }
  return {
    burstCap: parseTestInvoiceCap(burstRaw, 'TEST_INVOICE_BURST_CAP', INVOICE_BURST_CAP),
    hourCap: parseTestInvoiceCap(hourRaw, 'TEST_INVOICE_HOUR_CAP', INVOICE_HOUR_CAP),
  };
}

/** Per-account heart timestamps: last heart per note plus the sliding hour. */
interface HeartHits {
  /** Note id → time of the last allowed heart on it (ms). */
  lastByNote: Map<string, number>;
  /** Sliding-hour timestamps (ms). */
  hours: number[];
  /** Last successful check time (for idle eviction). */
  lastHitAt: number;
}

/**
 * In-process rate limiter for 1-sat hearts (one per note per 10 s, 60/h per
 * account). Separate from {@link InvoiceRateLimiter}: a heart neither checks
 * nor consumes the gift budget.
 */
export class HeartRateLimiter {
  readonly #byAccount = new Map<string, HeartHits>();

  /**
   * Check and record a heart attempt.
   *
   * @param accountId - Payer account id.
   * @param noteId - Note the heart is for.
   * @param nowMs - Current time (epoch ms).
   * @returns `true` when allowed; `false` when over limit (not recorded).
   */
  allow(accountId: string, noteId: string, nowMs: number): boolean {
    this.#evictIdle(nowMs);
    const hits = this.#hits(accountId);
    for (const [id, at] of hits.lastByNote) {
      if (nowMs - at >= HEART_NOTE_COOLDOWN_MS) {
        hits.lastByNote.delete(id);
      }
    }
    const hours = hits.hours.filter((t) => nowMs - t < HEART_HOUR_WINDOW_MS);
    hits.hours = hours;
    if (hits.lastByNote.has(noteId) || hours.length >= HEART_HOUR_CAP) {
      return false;
    }
    hits.lastByNote.set(noteId, nowMs);
    hours.push(nowMs);
    hits.lastHitAt = nowMs;
    return true;
  }

  #hits(accountId: string): HeartHits {
    const existing = this.#byAccount.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const created: HeartHits = { lastByNote: new Map(), hours: [], lastHitAt: 0 };
    this.#byAccount.set(accountId, created);
    return created;
  }

  #evictIdle(nowMs: number): void {
    for (const [id, hits] of this.#byAccount) {
      if (nowMs - hits.lastHitAt > IDLE_EVICT_MS) {
        this.#byAccount.delete(id);
      }
    }
  }
}
