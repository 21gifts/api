import { describe, it, expect } from 'vitest';
import { SERVICE_NAME, SERVICE_VERSION, SERVICE_DESCRIPTION, SERVICE_REPO_URL } from '@/lib/meta';

describe('lib/meta', () => {
  it('exposes a stable service name', () => {
    expect(SERVICE_NAME).toBe('21gifts-api');
  });

  it('exposes a non-empty version string', () => {
    expect(typeof SERVICE_VERSION).toBe('string');
    expect(SERVICE_VERSION.length).toBeGreaterThan(0);
  });

  it('exposes a non-empty description', () => {
    expect(SERVICE_DESCRIPTION).toMatch(/21\.gifts/);
  });

  it('exposes the canonical repository URL', () => {
    expect(SERVICE_REPO_URL).toBe('https://github.com/21gifts/api');
  });
});
