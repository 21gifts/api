import { describe, it, expect } from 'vitest';
import { InMemoryTranslationStore } from '@/lib/translation-store';
import { createApp } from '@/server';
import type { HealthResponse } from '@/routes/health';

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('21gifts-api');
    expect(typeof body.version).toBe('string');
  });

  it('answers health when a conversation translation store is passed', async () => {
    const app = createApp({ conversationTranslationStore: new InMemoryTranslationStore() });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('returns JSON content-type', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
