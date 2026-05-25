import { describe, it, expect } from 'vitest';
import { createApp, resolveBindAddr, parseBindAddr } from '@/server';

describe('createApp', () => {
  it('mounts /healthz', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('mounts /info', async () => {
    const app = createApp();
    const res = await app.request('/info');
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('resolveBindAddr', () => {
  it('prefers the explicit override', () => {
    expect(resolveBindAddr('127.0.0.1:9000', { BIND_ADDR: '0.0.0.0:1234' })).toBe('127.0.0.1:9000');
  });

  it('falls back to the env var when override is undefined', () => {
    expect(resolveBindAddr(undefined, { BIND_ADDR: '0.0.0.0:1234' })).toBe('0.0.0.0:1234');
  });

  it('falls back to the hard default when both are absent', () => {
    expect(resolveBindAddr(undefined, {})).toBe('0.0.0.0:3000');
  });

  it('treats an undefined env BIND_ADDR like an absent one', () => {
    expect(resolveBindAddr(undefined, { BIND_ADDR: undefined })).toBe('0.0.0.0:3000');
  });
});

describe('parseBindAddr', () => {
  it('parses a standard host:port', () => {
    expect(parseBindAddr('0.0.0.0:3000')).toEqual({ host: '0.0.0.0', port: 3000 });
  });

  it('parses localhost', () => {
    expect(parseBindAddr('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('parses port 0 (ephemeral)', () => {
    expect(parseBindAddr('0.0.0.0:0')).toEqual({ host: '0.0.0.0', port: 0 });
  });

  it('parses the maximum legal port', () => {
    expect(parseBindAddr('0.0.0.0:65535')).toEqual({ host: '0.0.0.0', port: 65535 });
  });

  it('rejects missing port', () => {
    expect(() => parseBindAddr('0.0.0.0')).toThrowError(/expected "host:port"/);
  });

  it('rejects empty port after colon', () => {
    expect(() => parseBindAddr('0.0.0.0:')).toThrowError(/expected "host:port"/);
  });

  it('rejects missing host', () => {
    expect(() => parseBindAddr(':3000')).toThrowError(/expected "host:port"/);
  });

  it('rejects non-numeric port', () => {
    expect(() => parseBindAddr('0.0.0.0:abc')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects port > 65535', () => {
    expect(() => parseBindAddr('0.0.0.0:65536')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects negative port', () => {
    expect(() => parseBindAddr('0.0.0.0:-1')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects port with trailing junk', () => {
    expect(() => parseBindAddr('0.0.0.0:3000x')).toThrowError(/must be 0\.\.65535/);
  });
});
