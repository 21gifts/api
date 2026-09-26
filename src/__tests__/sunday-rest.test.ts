import { describe, it, expect } from 'vitest';
import { createApp } from '../server';
import { runPushWorkerTick } from '../lib/push-worker';
import { runNostrWorkerTick } from '../lib/nostr/worker';

describe('Sunday service gate', () => {
  it('blocks reads, writes, health and unknown paths, then resumes the same instance', async () => {
    let now = Date.parse('2026-09-26T16:00:00Z');
    const app = createApp({ now: () => now });
    for (const [method, path] of [
      ['GET', '/healthz'],
      ['POST', '/messages'],
      ['GET', '/invoices'],
      ['GET', '/unknown'],
    ]) {
      const res = await app.request(path!, { method: method! });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('86400');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ error: 'SUNDAY_REST', timeZone: 'Asia/Manila' });
    }
    now = Date.parse('2026-09-27T16:00:00Z');
    expect((await app.request('/healthz')).status).toBe(200);
  });
  it('does not touch worker dependencies on Sunday', async () => {
    const deps = new Proxy(
      { now: () => Date.parse('2026-09-27T00:00:00Z') },
      {
        get(target, key) {
          if (key === 'now') return target.now;
          throw new Error('worker performed work');
        },
      },
    );
    await runPushWorkerTick(deps as Parameters<typeof runPushWorkerTick>[0]);
    for (const mode of ['all', 'ingest', 'fast'] as const) {
      await runNostrWorkerTick(deps as Parameters<typeof runNostrWorkerTick>[0], mode);
    }
  });
});
