import { describe, expect, it } from 'vitest';
import { resolveVapidConfig } from '@/lib/push-config';

describe('resolveVapidConfig', () => {
  it('returns null when public key is missing', () => {
    expect(resolveVapidConfig({ VAPID_PRIVATE_KEY: 'priv' })).toBeNull();
  });

  it('returns null when private key is missing', () => {
    expect(resolveVapidConfig({ VAPID_PUBLIC_KEY: 'pub' })).toBeNull();
  });

  it('returns null when either key is blank after trim', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: '  ',
        VAPID_PRIVATE_KEY: 'priv',
      }),
    ).toBeNull();
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: '\t',
      }),
    ).toBeNull();
  });

  it('trims keys and defaults subject to https://21.gifts', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: ' pub ',
        VAPID_PRIVATE_KEY: ' priv ',
      }),
    ).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://21.gifts',
    });
  });

  it('uses trimmed VAPID_SUBJECT when set', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: ' mailto:ops@example.com ',
      }),
    ).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:ops@example.com',
    });
  });

  it('defaults subject when VAPID_SUBJECT is blank', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: '   ',
      })?.subject,
    ).toBe('https://21.gifts');
  });
});
