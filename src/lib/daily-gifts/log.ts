import { open, readFile, mkdir, unlink } from 'node:fs/promises';

/** Per-attempt payment status persisted in the gift log. */
export type GiftPaymentStatus = 'sending' | 'paid' | 'failed' | 'uncertain';

/** One JSONL row in the daily-gifts idempotency log. */
export interface GiftLogEntry {
  date: string;
  address: string;
  usd: number;
  sats: number;
  rate_usd_per_btc: number;
  status: GiftPaymentStatus;
  timestamp: string;
  payment_hash?: string;
  preimage?: string;
  error?: string;
}

/**
 * Filesystem port for the gift log (tests inject an in-memory implementation).
 */
export interface GiftLogFs {
  readFile(path: string): Promise<string | null>;
  appendFile(path: string, data: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  tryLock(lockPath: string, pid: number): Promise<boolean>;
  unlock(lockPath: string): Promise<void>;
}

/**
 * Calendar date `YYYY-MM-DD` in Europe/Zurich for the given instant.
 *
 * @param nowMs - Epoch milliseconds.
 * @returns Zurich civil date string.
 */
export function zurichDate(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

/**
 * Replay log rows for one recipient on one Zurich date.
 *
 * In file order: `paid` stays paid; `failed` clears a prior `sending` to
 * `clear`; `uncertain` stays; a dangling `sending` at the end becomes
 * `uncertain`.
 *
 * @param entries - Full log (any dates/addresses); filtered inside.
 * @param date - Zurich `YYYY-MM-DD`.
 * @param address - Recipient Lightning Address.
 * @returns Effective status, or `clear` when the recipient may be paid.
 */
export function replayDay(
  entries: GiftLogEntry[],
  date: string,
  address: string,
): GiftPaymentStatus | 'clear' {
  let state: GiftPaymentStatus | 'clear' = 'clear';
  for (const entry of entries) {
    if (entry.date !== date || entry.address !== address) {
      continue;
    }
    switch (entry.status) {
      case 'paid':
        state = 'paid';
        break;
      case 'failed':
        if (state === 'sending') {
          state = 'clear';
        }
        break;
      case 'uncertain':
        if (state !== 'paid') {
          state = 'uncertain';
        }
        break;
      case 'sending':
        if (state !== 'paid') {
          state = 'sending';
        }
        break;
    }
  }
  if (state === 'sending') {
    return 'uncertain';
  }
  return state;
}

/**
 * Append-only JSONL gift log with fsync semantics via {@link GiftLogFs}.
 */
export class FileGiftLog {
  private readonly path: string;
  private readonly fs: GiftLogFs;

  /**
   * @param args - Log file path and filesystem port.
   */
  constructor(args: { path: string; fs: GiftLogFs }) {
    this.path = args.path;
    this.fs = args.fs;
  }

  /**
   * Load and parse every JSONL line.
   *
   * @returns Entries, or `corrupt` when any line is not valid JSON / schema.
   */
  async load(): Promise<{ ok: true; entries: GiftLogEntry[] } | { ok: false; reason: 'corrupt' }> {
    const raw = await this.fs.readFile(this.path);
    if (raw === null || raw === '') {
      return { ok: true, entries: [] };
    }
    const lines = raw.split('\n').filter((line) => line !== '');
    const entries: GiftLogEntry[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
      if (!isGiftLogEntry(parsed)) {
        return { ok: false, reason: 'corrupt' };
      }
      entries.push(parsed);
    }
    return { ok: true, entries };
  }

  /**
   * Append one entry as a JSON line (caller’s fs must fsync).
   *
   * @param entry - Row to persist.
   * @returns void
   */
  async append(entry: GiftLogEntry): Promise<void> {
    await this.fs.appendFile(this.path, `${JSON.stringify(entry)}\n`);
  }
}

/**
 * Node/Bun filesystem adapter: append+sync, recursive mkdir, `wx` lock file.
 *
 * @returns A {@link GiftLogFs} bound to the real filesystem.
 */
export function nodeGiftLogFs(): GiftLogFs {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    async appendFile(path: string, data: string): Promise<void> {
      const fh = await open(path, 'a');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    async mkdirp(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
    },
    async tryLock(lockPath: string, pid: number): Promise<boolean> {
      try {
        const fh = await open(lockPath, 'wx');
        try {
          await fh.writeFile(`${pid}\n`);
          await fh.sync();
        } finally {
          await fh.close();
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          return false;
        }
        throw err;
      }
    },
    async unlock(lockPath: string): Promise<void> {
      await unlink(lockPath);
    },
  };
}

function isGiftLogEntry(value: unknown): value is GiftLogEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v['date'] !== 'string') return false;
  if (typeof v['address'] !== 'string') return false;
  if (typeof v['usd'] !== 'number') return false;
  if (typeof v['sats'] !== 'number') return false;
  if (typeof v['rate_usd_per_btc'] !== 'number') return false;
  if (typeof v['timestamp'] !== 'string') return false;
  const status = v['status'];
  if (status !== 'sending' && status !== 'paid' && status !== 'failed' && status !== 'uncertain') {
    return false;
  }
  if (v['payment_hash'] !== undefined && typeof v['payment_hash'] !== 'string') return false;
  if (v['preimage'] !== undefined && typeof v['preimage'] !== 'string') return false;
  if (v['error'] !== undefined && typeof v['error'] !== 'string') return false;
  return true;
}
