import { describe, it, expect } from 'vitest';
import { createApp } from '@/server';
import type { InfoResponse } from '@/routes/info';

describe('GET /info', () => {
  it('returns service identity', async () => {
    const app = createApp();
    const res = await app.request('/info');

    expect(res.status).toBe(200);
    const body = (await res.json()) as InfoResponse;
    expect(body.service).toBe('21gifts-api');
    expect(body.repository).toBe('https://github.com/21gifts/api');
    expect(body.description).toMatch(/21\.gifts/);
    expect(typeof body.version).toBe('string');
  });

  it('returns JSON content-type', async () => {
    const app = createApp();
    const res = await app.request('/info');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
