import { describe, expect, it } from 'vitest';
import { clientRateLimitKey } from '@/lib/client-address';

// 162.158.0.0/15 is a published Cloudflare egress range.
const CF_PEER = '162.158.1.1';
const DIRECT_PEER = '203.0.113.7';

/** A context whose `env` yields `socket` from requestIP, carrying `headers`. */
function ctx(env: unknown, headers: Record<string, string> = {}) {
  return { env, req: { raw: new Request('https://example.test/', { headers }) } };
}

/** A Bun-server-like object whose requestIP returns `socket`. */
function serverWith(socket: unknown): unknown {
  return { requestIP: () => socket };
}

/** Resolve a key for a peer address + header + TRUSTED_PROXY_CIDRS config. */
function keyFor(
  peerAddress: string | null,
  headerIp: string | null,
  cfg: Record<string, string | undefined> = {},
): string | null {
  const headers = headerIp === null ? {} : { 'cf-connecting-ip': headerIp };
  return clientRateLimitKey(ctx(serverWith({ address: peerAddress }), headers), cfg);
}

describe('clientRateLimitKey — trust policy', () => {
  it('ignores a spoofed header from an untrusted peer and keys on the peer address', () => {
    const key = keyFor(DIRECT_PEER, '1.2.3.4');
    expect(key).toBe(`peer:${DIRECT_PEER}`);
    expect(key).not.toContain('1.2.3.4');
  });

  it('keys a missing header on the peer address rather than granting an unlimited pass', () => {
    expect(keyFor(DIRECT_PEER, null)).toBe(`peer:${DIRECT_PEER}`);
  });

  it('trusts the forwarded header only when the peer is a trusted Cloudflare proxy', () => {
    expect(keyFor(CF_PEER, '9.9.9.9')).toBe('ip:9.9.9.9');
  });

  it('falls back to the peer when a trusted proxy forwards no header', () => {
    expect(keyFor(CF_PEER, null)).toBe(`peer:${CF_PEER}`);
  });

  it('keeps a direct attacker and the forwarded client in distinct buckets', () => {
    // A client reaching the origin directly while spoofing a victim's IP must not
    // share (or poison) the bucket of that IP as forwarded by the real proxy.
    expect(keyFor(DIRECT_PEER, '9.9.9.9')).not.toBe(keyFor(CF_PEER, '9.9.9.9'));
  });
});

describe('clientRateLimitKey — unknown / unreadable transport', () => {
  it('gives an unreadable peer no key (null, not fail-open)', () => {
    expect(keyFor('bogus', '1.2.3.4')).toBeNull();
  });

  it('gives a supported-but-absent peer no key', () => {
    expect(
      clientRateLimitKey(ctx(serverWith(null), { 'cf-connecting-ip': '1.2.3.4' }), {}),
    ).toBeNull();
    expect(
      clientRateLimitKey(ctx(serverWith({}), { 'cf-connecting-ip': '1.2.3.4' }), {}),
    ).toBeNull();
    expect(
      clientRateLimitKey(ctx(serverWith({ address: '' }), { 'cf-connecting-ip': '1.2.3.4' }), {}),
    ).toBeNull();
    expect(
      clientRateLimitKey(ctx(serverWith({ address: 123 }), { 'cf-connecting-ip': '1.2.3.4' }), {}),
    ).toBeNull();
  });

  it('uses the validated header when the runtime exposes no peer lookup (test harness)', () => {
    expect(clientRateLimitKey(ctx(undefined, { 'cf-connecting-ip': '5.6.7.8' }), {})).toBe(
      'ip:5.6.7.8',
    );
    expect(clientRateLimitKey(ctx({}, { 'cf-connecting-ip': '5.6.7.8' }), {})).toBe('ip:5.6.7.8');
    expect(
      clientRateLimitKey(ctx({ requestIP: 'nope' }, { 'cf-connecting-ip': '5.6.7.8' }), {}),
    ).toBe('ip:5.6.7.8');
    expect(clientRateLimitKey(ctx(42, { 'cf-connecting-ip': '5.6.7.8' }), {})).toBe('ip:5.6.7.8');
    // A nested server that is a primitive or null is treated as no peer lookup.
    expect(clientRateLimitKey(ctx({ server: 42 }, { 'cf-connecting-ip': '5.6.7.8' }), {})).toBe(
      'ip:5.6.7.8',
    );
    expect(clientRateLimitKey(ctx({ server: null }, { 'cf-connecting-ip': '5.6.7.8' }), {})).toBe(
      'ip:5.6.7.8',
    );
  });

  it('returns null when neither a peer nor a header is available', () => {
    expect(clientRateLimitKey(ctx(null, {}), {})).toBeNull();
    // Exercises the default process.env argument without depending on its value.
    expect(clientRateLimitKey(ctx(undefined, {}))).toBeNull();
  });

  it('unwraps a nested Hono server object', () => {
    expect(
      clientRateLimitKey(
        ctx({ server: serverWith({ address: CF_PEER }) }, { 'cf-connecting-ip': '9.9.9.9' }),
        {},
      ),
    ).toBe('ip:9.9.9.9');
  });
});

describe('clientRateLimitKey — TRUSTED_PROXY_CIDRS configuration', () => {
  it('trusts the published Cloudflare ranges by default (no env override)', () => {
    expect(keyFor(CF_PEER, '9.9.9.9')).toBe('ip:9.9.9.9');
  });

  it('never trusts a header when proxies are disabled', () => {
    for (const raw of ['off', 'NONE', '', '   ']) {
      expect(keyFor(CF_PEER, '9.9.9.9', { TRUSTED_PROXY_CIDRS: raw })).toBe(`peer:${CF_PEER}`);
    }
  });

  it('honors a custom IPv4/IPv6 trusted CIDR list and ignores unlisted peers', () => {
    const cfg = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32' };
    expect(keyFor('10.1.2.3', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
    expect(keyFor('11.1.2.3', '9.9.9.9', cfg)).toBe('peer:11.1.2.3');
    expect(keyFor('2001:db8::5', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
  });

  it('trusts an exact host route (bare address, full-width prefix)', () => {
    const cfg = { TRUSTED_PROXY_CIDRS: '198.51.100.9' };
    expect(keyFor('198.51.100.9', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
    expect(keyFor('198.51.100.10', '9.9.9.9', cfg)).toBe('peer:198.51.100.10');
  });

  it('does not match an IPv4 peer against an IPv6 trust range, or vice versa', () => {
    expect(keyFor('203.0.113.7', '9.9.9.9', { TRUSTED_PROXY_CIDRS: '2001:db8::/32' })).toBe(
      'peer:203.0.113.7',
    );
    expect(keyFor('2001:db8::5', '9.9.9.9', { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe(
      'peer:2001:db8::5',
    );
  });

  it('matches an IPv4-mapped IPv6 peer against an IPv4 trust range', () => {
    expect(keyFor('::ffff:10.1.2.3', '9.9.9.9', { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe(
      'ip:9.9.9.9',
    );
  });

  it('drops malformed CIDR entries while keeping valid ones', () => {
    const cfg = {
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8, not-a-cidr, 300.1.2.3/8, 10.0.0.0/33, 10.0.0.0/x, ,bad/8',
    };
    expect(keyFor('10.9.9.9', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
    expect(keyFor('192.0.2.1', '9.9.9.9', cfg)).toBe('peer:192.0.2.1');
  });

  it('memoizes the allowlist per raw spec across calls', () => {
    const cfg = { TRUSTED_PROXY_CIDRS: '172.16.0.0/12' };
    expect(keyFor('172.16.1.1', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
    // Second call with the same spec hits the cache and must behave identically.
    expect(keyFor('172.16.1.1', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
  });
});

describe('clientRateLimitKey — address parsing edge cases (via the peer)', () => {
  it('rejects malformed IPv4 peers (no key)', () => {
    for (const bad of ['1.2.3', '1.2.3.4.5', '1.2.3.x', '300.1.2.3', '01.2.3.4']) {
      expect(keyFor(bad, '1.2.3.4')).toBeNull();
    }
  });

  it('rejects malformed IPv6 peers (no key)', () => {
    for (const bad of [
      'fe80::1%eth0', // zone id
      'zz::1', // non-hex
      '1::2::3', // two "::"
      '1:2:3:4:5:6:7::8', // "::" compresses nothing
      '1:2:3', // too few groups
      '12345::1', // group too long
      '::ffff:1.2.3.999', // bad embedded IPv4
    ]) {
      expect(keyFor(bad, '1.2.3.4')).toBeNull();
    }
  });

  it('accepts canonical and compressed IPv6 peers', () => {
    const cfg = { TRUSTED_PROXY_CIDRS: '::/0' };
    expect(keyFor('::1', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
    expect(keyFor('2606:4700:0:0:0:0:0:1', '9.9.9.9', cfg)).toBe('ip:9.9.9.9');
  });
});
