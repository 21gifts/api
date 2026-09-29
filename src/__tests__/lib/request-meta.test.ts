import { describe, expect, it } from 'vitest';
import {
  presentClientFields,
  readClientRequestMeta,
  type ClientRequestMeta,
} from '@/lib/request-meta';

function read(headers: Record<string, string>): ClientRequestMeta {
  return readClientRequestMeta({ get: (name) => headers[name] });
}

describe('readClientRequestMeta', () => {
  it('keeps valid IPv4 addresses unchanged', () => {
    for (const clientIp of ['0.0.0.0', '192.0.2.1', '255.255.255.255']) {
      expect(read({ 'cf-connecting-ip': clientIp }).clientIp).toBe(clientIp);
    }
  });

  it('rejects invalid IPv4 addresses', () => {
    for (const clientIp of [
      '1.2.3',
      '01.2.3.4',
      '256.1.1.1',
      '192.0.2.1:443',
      ' 192.0.2.1',
      '192.0.2.1 ',
    ]) {
      expect(read({ 'cf-connecting-ip': clientIp }).clientIp).toBeNull();
    }
  });

  it('keeps valid IPv6 addresses unchanged', () => {
    for (const clientIp of ['::1', '::ffff:192.0.2.1', '2001:db8::1']) {
      expect(read({ 'cf-connecting-ip': clientIp }).clientIp).toBe(clientIp);
    }
  });

  it('rejects invalid IPv6 addresses', () => {
    for (const clientIp of [
      '',
      'fe80::1%eth0',
      '::ffff:192.0.2.01',
      '::1/128',
      '1::2::3',
      '::12345',
      '1:2:3:4:5:6:7:8::',
      '2001:db8:1',
    ]) {
      expect(read({ 'cf-connecting-ip': clientIp }).clientIp).toBeNull();
    }
  });

  it('keeps an uncompressed IPv6 address', () => {
    expect(read({ 'cf-connecting-ip': '2001:db8:0:0:0:0:0:1' }).clientIp).toBe(
      '2001:db8:0:0:0:0:0:1',
    );
  });

  it('does not use x-forwarded-for as the client IP', () => {
    expect(read({ 'x-forwarded-for': '192.0.2.1' }).clientIp).toBeNull();
  });

  it('normalizes and validates the client country', () => {
    expect(read({ 'cf-ipcountry': 't1' }).clientCountry).toBe('T1');
    expect(read({ 'cf-ipcountry': 'CHE' }).clientCountry).toBeNull();
    expect(read({ 'cf-ipcountry': ' ch ' }).clientCountry).toBe('CH');
  });

  it('validates cf-ray and preserves its original case', () => {
    expect(read({ 'cf-ray': '0123456789aBCDef-ZrH' }).cfRay).toBe('0123456789aBCDef-ZrH');
    expect(read({ 'cf-ray': '0123456789abcdef-ZH' }).cfRay).toBeNull();
  });

  it('strips accept-language controls the same way as user-agent', () => {
    expect(read({ 'accept-language': 'de-CH,de;q=0.9' }).acceptLanguage).toBe('de-CH,de;q=0.9');
    expect(read({ 'accept-language': '\n' }).acceptLanguage).toBeNull();
  });

  it('strips user-agent controls and caps the result at 200 characters', () => {
    expect(read({ 'user-agent': 'Mozilla\nX' }).userAgent).toBe('MozillaX');
    expect(read({ 'user-agent': '\u0000\n\u007f' }).userAgent).toBeNull();
    expect(read({ 'user-agent': 'x'.repeat(201) }).userAgent).toBe('x'.repeat(200));
  });

  it('validates allowed origins', () => {
    expect(read({ origin: 'https://21.gifts/path' }).origin).toBeNull();
    expect(read({ origin: 'http://localhost:3000' }).origin).toBe('http://localhost:3000');
    expect(read({ origin: 'http://example.com' }).origin).toBeNull();
    expect(read({ origin: 'https://21.gifts' }).origin).toBe('https://21.gifts');
  });
});

describe('presentClientFields', () => {
  it('omits null fields and returns present strings in interface order', () => {
    expect(
      presentClientFields({
        clientIp: '192.0.2.1',
        clientCountry: null,
        cfRay: '0123456789abcdef-ZRH',
        userAgent: null,
        acceptLanguage: 'de-CH',
        origin: null,
      }),
    ).toEqual({
      clientIp: '192.0.2.1',
      cfRay: '0123456789abcdef-ZRH',
      acceptLanguage: 'de-CH',
    });
  });
});
