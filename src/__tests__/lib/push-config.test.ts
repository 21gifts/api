import { describe, expect, it } from 'vitest';
import { resolveVapidConfig } from '@/lib/push-config';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

const PUBLIC_BYTES = new Uint8Array(65);
PUBLIC_BYTES[0] = 4;
const PRIVATE_BYTES = new Uint8Array(32).fill(1);
const PUBLIC_KEY = b64url(PUBLIC_BYTES);
const PRIVATE_KEY = b64url(PRIVATE_BYTES);

describe('resolveVapidConfig', () => {
  it('returns null when public key is missing', () => {
    expect(resolveVapidConfig({ VAPID_PRIVATE_KEY: PRIVATE_KEY })).toBeNull();
  });

  it('returns null when private key is missing', () => {
    expect(resolveVapidConfig({ VAPID_PUBLIC_KEY: PUBLIC_KEY })).toBeNull();
  });

  it('returns null when either key is blank after trim', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: '  ',
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toBeNull();
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: '\t',
      }),
    ).toBeNull();
  });

  it('returns null when the public key is 65 bytes but not uncompressed', () => {
    const compressed = new Uint8Array(65);
    compressed[0] = 2;
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: b64url(compressed),
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toBeNull();
  });

  it('returns null when url-safe base64 decodes to empty bytes', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: '!!!!',
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toBeNull();
  });

  it('returns null when keys do not decode to P-256 lengths', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toBeNull();
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: 'priv',
      }),
    ).toBeNull();
  });

  it('returns null when subject is not https or mailto', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
        VAPID_SUBJECT: 'ftp://example.com',
      }),
    ).toBeNull();
  });

  it('trims keys and defaults subject to https://21.gifts', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: ` ${PUBLIC_KEY} `,
        VAPID_PRIVATE_KEY: ` ${PRIVATE_KEY} `,
      }),
    ).toEqual({
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: 'https://21.gifts',
    });
  });

  it('uses trimmed VAPID_SUBJECT when set', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
        VAPID_SUBJECT: ' mailto:ops@example.com ',
      }),
    ).toEqual({
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: 'mailto:ops@example.com',
    });
  });

  it('defaults subject when VAPID_SUBJECT is blank', () => {
    expect(
      resolveVapidConfig({
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
        VAPID_SUBJECT: '   ',
      })?.subject,
    ).toBe('https://21.gifts');
  });
});
