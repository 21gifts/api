import { normalizeLightningAddress } from '@/lib/lightning-address';
import { parseLndhubBaseUrl } from '@/lib/lndhub';

/** One static recipient from `DAILY_GIFTS_RECIPIENTS`. */
export interface DailyGiftRecipient {
  address: string;
  usd: number;
}

/** Parsed, validated daily-gifts operator configuration. */
export interface DailyGiftsConfig {
  lndhubUrl: string;
  login: string;
  password: string;
  recipients: DailyGiftRecipient[];
  dailyCapUsd: number;
  rateMinUsd: number;
  rateMaxUsd: number;
  logPath: string;
  hour: number;
  timeZone: 'Europe/Zurich';
}

const DEFAULT_HOUR = 20;
const DEFAULT_TZ = 'Europe/Zurich' as const;
const MAX_RECIPIENT_USD = 10_000;

/**
 * Parse daily-gifts configuration from the environment.
 *
 * Required: `LNDHUB_URL`, `LNDHUB_LOGIN`, `LNDHUB_PASSWORD`,
 * `DAILY_GIFTS_RECIPIENTS` (JSON array), `DAILY_CAP_USD`, `RATE_MIN_USD`,
 * `RATE_MAX_USD`, `DAILY_GIFTS_LOG_PATH`. Optional: `DAILY_GIFTS_HOUR`
 * (default 20), `DAILY_GIFTS_TZ` (must be Europe/Zurich when set).
 * Recipients are env-only JSON — not a file.
 *
 * @param env - Environment slice (injected for tests).
 * @returns Validated config, or a short failure reason.
 */
export function parseDailyGiftsConfig(
  env: Record<string, string | undefined>,
): { ok: true; config: DailyGiftsConfig } | { ok: false; reason: string } {
  const lndhubUrl = requireNonEmpty(env, 'LNDHUB_URL');
  if (lndhubUrl === null) {
    return { ok: false, reason: 'missing_LNDHUB_URL' };
  }
  if (parseLndhubBaseUrl(lndhubUrl) === null) {
    return { ok: false, reason: 'invalid_LNDHUB_URL' };
  }
  const login = requireNonEmpty(env, 'LNDHUB_LOGIN');
  if (login === null) {
    return { ok: false, reason: 'missing_LNDHUB_LOGIN' };
  }
  const password = requireNonEmpty(env, 'LNDHUB_PASSWORD');
  if (password === null) {
    return { ok: false, reason: 'missing_LNDHUB_PASSWORD' };
  }
  const logPath = requireNonEmpty(env, 'DAILY_GIFTS_LOG_PATH');
  if (logPath === null) {
    return { ok: false, reason: 'missing_DAILY_GIFTS_LOG_PATH' };
  }

  const dailyCapUsd = parsePositiveFinite(env['DAILY_CAP_USD']);
  if (dailyCapUsd === null) {
    return { ok: false, reason: 'invalid_DAILY_CAP_USD' };
  }
  const rateMinUsd = parsePositiveFinite(env['RATE_MIN_USD']);
  if (rateMinUsd === null) {
    return { ok: false, reason: 'invalid_RATE_MIN_USD' };
  }
  const rateMaxUsd = parsePositiveFinite(env['RATE_MAX_USD']);
  if (rateMaxUsd === null) {
    return { ok: false, reason: 'invalid_RATE_MAX_USD' };
  }
  if (rateMinUsd > rateMaxUsd) {
    return { ok: false, reason: 'invalid_rate_corridor' };
  }

  const recipientsResult = parseRecipients(env['DAILY_GIFTS_RECIPIENTS']);
  if (!recipientsResult.ok) {
    return recipientsResult;
  }

  const hourResult = parseHour(env['DAILY_GIFTS_HOUR']);
  if (!hourResult.ok) {
    return hourResult;
  }

  const tzRaw = env['DAILY_GIFTS_TZ'];
  if (tzRaw !== undefined && tzRaw.trim() !== '' && tzRaw.trim() !== DEFAULT_TZ) {
    return { ok: false, reason: 'invalid_DAILY_GIFTS_TZ' };
  }

  return {
    ok: true,
    config: {
      lndhubUrl,
      login,
      password,
      recipients: recipientsResult.recipients,
      dailyCapUsd,
      rateMinUsd,
      rateMaxUsd,
      logPath,
      hour: hourResult.hour,
      timeZone: DEFAULT_TZ,
    },
  };
}

function requireNonEmpty(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.trim();
}

function parsePositiveFinite(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function parseHour(
  raw: string | undefined,
): { ok: true; hour: number } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, hour: DEFAULT_HOUR };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, reason: 'invalid_DAILY_GIFTS_HOUR' };
  }
  const hour = Number(raw.trim());
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, reason: 'invalid_DAILY_GIFTS_HOUR' };
  }
  return { ok: true, hour };
}

function parseRecipients(
  raw: string | undefined,
): { ok: true; recipients: DailyGiftRecipient[] } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'missing_DAILY_GIFTS_RECIPIENTS' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_json' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_empty' };
  }

  const recipients: DailyGiftRecipient[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_entry' };
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec['address'] !== 'string' || typeof rec['usd'] !== 'number') {
      return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_entry' };
    }
    const address = normalizeLightningAddress(rec['address']);
    if (address === null) {
      return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_address' };
    }
    const usd = rec['usd'];
    if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_RECIPIENT_USD) {
      return { ok: false, reason: 'invalid_DAILY_GIFTS_RECIPIENTS_usd' };
    }
    if (seen.has(address)) {
      return { ok: false, reason: 'duplicate_DAILY_GIFTS_RECIPIENTS' };
    }
    seen.add(address);
    recipients.push({ address, usd });
  }
  return { ok: true, recipients };
}
