import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileGiftLog,
  nodeGiftLogFs,
  replayDay,
  zurichDate,
  type GiftLogEntry,
  type GiftLogFs,
} from '@/lib/daily-gifts/log';

function entry(over: Partial<GiftLogEntry> & Pick<GiftLogEntry, 'status'>): GiftLogEntry {
  return {
    date: '2026-08-23',
    address: 'alice@walletofsatoshi.com',
    usd: 2,
    sats: 2000,
    rate_usd_per_btc: 100_000,
    timestamp: '2026-08-23T18:00:00.000Z',
    ...over,
  };
}

function memoryFs(): GiftLogFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path) {
      return files.has(path) ? (files.get(path) ?? '') : null;
    },
    async appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data);
    },
    async mkdirp() {
      return;
    },
    async tryLock(lockPath) {
      if (files.has(lockPath)) return false;
      files.set(lockPath, '1');
      return true;
    },
    async unlock(lockPath) {
      files.delete(lockPath);
    },
  };
}

describe('zurichDate', () => {
  it('formats YYYY-MM-DD in Europe/Zurich', () => {
    expect(zurichDate(Date.UTC(2026, 7, 23, 10, 0, 0))).toBe('2026-08-23');
    expect(zurichDate(Date.UTC(2026, 7, 23, 22, 30, 0))).toBe('2026-08-24');
  });
});

describe('replayDay', () => {
  it('returns clear when empty', () => {
    expect(replayDay([], '2026-08-23', 'alice@walletofsatoshi.com')).toBe('clear');
  });

  it('keeps paid', () => {
    expect(
      replayDay(
        [entry({ status: 'sending' }), entry({ status: 'paid' })],
        '2026-08-23',
        'alice@walletofsatoshi.com',
      ),
    ).toBe('paid');
  });

  it('clears sending after failed', () => {
    expect(
      replayDay(
        [entry({ status: 'sending' }), entry({ status: 'failed' })],
        '2026-08-23',
        'alice@walletofsatoshi.com',
      ),
    ).toBe('clear');
  });

  it('treats dangling sending as uncertain', () => {
    expect(
      replayDay([entry({ status: 'sending' })], '2026-08-23', 'alice@walletofsatoshi.com'),
    ).toBe('uncertain');
  });

  it('keeps uncertain unless paid', () => {
    expect(
      replayDay([entry({ status: 'uncertain' })], '2026-08-23', 'alice@walletofsatoshi.com'),
    ).toBe('uncertain');
  });

  it('ignores other dates and addresses', () => {
    expect(
      replayDay(
        [
          entry({ status: 'paid', date: '2026-08-22' }),
          entry({ status: 'paid', address: 'x@y.z' }),
        ],
        '2026-08-23',
        'alice@walletofsatoshi.com',
      ),
    ).toBe('clear');
  });
});

describe('FileGiftLog', () => {
  it('loads empty and appends', async () => {
    const fs = memoryFs();
    const log = new FileGiftLog({ path: '/tmp/p.jsonl', fs });
    const empty = await log.load();
    expect(empty).toEqual({ ok: true, entries: [] });
    await log.append(entry({ status: 'paid' }));
    const loaded = await log.load();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.entries).toHaveLength(1);
    }
  });

  it('returns corrupt on bad JSON or schema', async () => {
    const fs = memoryFs();
    fs.files.set('/tmp/p.jsonl', '{not json\n');
    const log = new FileGiftLog({ path: '/tmp/p.jsonl', fs });
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    fs.files.set('/tmp/p.jsonl', '{"date":1}\n');
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    const base = {
      date: '2026-08-23',
      address: 'a@b.co',
      usd: 1,
      sats: 1,
      rate_usd_per_btc: 1,
      timestamp: 't',
      status: 'paid',
    };
    fs.files.set('/tmp/p.jsonl', `${JSON.stringify({ ...base, status: 'nope' })}\n`);
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    fs.files.set('/tmp/p.jsonl', `${JSON.stringify({ ...base, payment_hash: 1 })}\n`);
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    fs.files.set('/tmp/p.jsonl', `${JSON.stringify({ ...base, preimage: 1 })}\n`);
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    fs.files.set('/tmp/p.jsonl', `${JSON.stringify({ ...base, error: 1 })}\n`);
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    fs.files.set('/tmp/p.jsonl', 'null\n');
    expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    const good = {
      date: '2026-08-23',
      address: 'a@b.co',
      usd: 1,
      sats: 1,
      rate_usd_per_btc: 1,
      timestamp: 't',
      status: 'paid',
    };
    for (const key of [
      'date',
      'address',
      'usd',
      'sats',
      'rate_usd_per_btc',
      'timestamp',
    ] as const) {
      const bad = {
        ...good,
        [key]: key === 'usd' || key === 'sats' || key === 'rate_usd_per_btc' ? 'x' : 1,
      };
      fs.files.set('/tmp/p.jsonl', `${JSON.stringify(bad)}\n`);
      expect(await log.load()).toEqual({ ok: false, reason: 'corrupt' });
    }
  });
});

describe('nodeGiftLogFs', () => {
  it('reads, appends, locks, and treats missing as null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gifts-'));
    try {
      const fs = nodeGiftLogFs();
      const path = join(dir, 'payments.jsonl');
      expect(await fs.readFile(path)).toBeNull();
      await fs.mkdirp(dir);
      await fs.appendFile(path, 'hello\n');
      expect(await fs.readFile(path)).toBe('hello\n');
      const lock = join(dir, 'payments.jsonl.lock');
      expect(await fs.tryLock(lock, 99)).toBe(true);
      expect(await readFile(lock, 'utf8')).toBe('99\n');
      expect(await fs.tryLock(lock, 100)).toBe(false);
      await fs.unlock(lock);
      expect(await fs.tryLock(lock, 100)).toBe(true);
      await fs.unlock(lock);
      await expect(fs.readFile(dir)).rejects.toBeDefined();
      await expect(fs.tryLock(join(dir, 'no-such', 'lock'), 1)).rejects.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
