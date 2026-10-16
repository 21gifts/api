import { describe, expect, it } from 'vitest';
import {
  appBuildAccepted,
  LoginGate,
  resolveLoginsOpenDefault,
  resolveRequiredAppBuild,
} from '@/lib/login-gate';
import { InMemoryLoginGateStore } from '@/lib/login-gate-store';

describe('resolveLoginsOpenDefault', () => {
  it('is open when unset, blank, or open', () => {
    expect(resolveLoginsOpenDefault({})).toBe(true);
    expect(resolveLoginsOpenDefault({ LOGINS_OPEN_DEFAULT: '  ' })).toBe(true);
    expect(resolveLoginsOpenDefault({ LOGINS_OPEN_DEFAULT: ' Open ' })).toBe(true);
  });

  it('is closed for closed in any case', () => {
    expect(resolveLoginsOpenDefault({ LOGINS_OPEN_DEFAULT: 'closed' })).toBe(false);
    expect(resolveLoginsOpenDefault({ LOGINS_OPEN_DEFAULT: 'CLOSED' })).toBe(false);
  });

  it('throws for any other value', () => {
    expect(() => resolveLoginsOpenDefault({ LOGINS_OPEN_DEFAULT: 'false' })).toThrow(
      'LOGINS_OPEN_DEFAULT must be "open" or "closed"',
    );
  });
});

describe('resolveRequiredAppBuild', () => {
  it('is null when unset or blank', () => {
    expect(resolveRequiredAppBuild({})).toBeNull();
    expect(resolveRequiredAppBuild({ APP_BUILD_REQUIRED: ' ' })).toBeNull();
  });

  it('returns the trimmed build id', () => {
    expect(resolveRequiredAppBuild({ APP_BUILD_REQUIRED: ' abc123 ' })).toBe('abc123');
  });
});

describe('appBuildAccepted', () => {
  it('accepts anything when no build is required', () => {
    expect(appBuildAccepted(null, undefined)).toBe(true);
    expect(appBuildAccepted(null, 'dev')).toBe(true);
  });

  it('accepts only the exact trimmed build when one is required', () => {
    expect(appBuildAccepted('abc', ' abc ')).toBe(true);
    expect(appBuildAccepted('abc', undefined)).toBe(false);
    expect(appBuildAccepted('abc', 'abcd')).toBe(false);
    expect(appBuildAccepted('abc', 'ABC')).toBe(false);
  });
});

describe('LoginGate', () => {
  const ID = '00000000-0000-4000-8000-000000000001';

  it('reports the boot default until a value is stored', async () => {
    const store = new InMemoryLoginGateStore();
    const gate = new LoginGate(store, false);
    await expect(gate.state()).resolves.toEqual({
      open: false,
      source: 'default',
      defaultOpen: false,
    });
    await store.setLoginsOpen(true);
    await expect(gate.state()).resolves.toEqual({
      open: true,
      source: 'stored',
      defaultOpen: false,
    });
  });

  it('admits everyone, including a new registration, while open', async () => {
    const gate = new LoginGate(new InMemoryLoginGateStore(), true);
    await expect(gate.admits(null)).resolves.toBe(true);
    await expect(gate.admits({ id: ID })).resolves.toBe(true);
  });

  it('while closed admits only the platform account and allowlisted accounts', async () => {
    const store = new InMemoryLoginGateStore();
    const gate = new LoginGate(store, false);
    await expect(gate.admits(null)).resolves.toBe(false);
    await expect(gate.admits({ id: ID })).resolves.toBe(false);
    await expect(gate.admits({ id: ID, isPlatform: false })).resolves.toBe(false);
    await expect(gate.admits({ id: ID, isPlatform: true })).resolves.toBe(true);
    await store.addToAllowlist(ID, 1);
    await expect(gate.admits({ id: ID })).resolves.toBe(true);
  });
});
