import { describe, expect, it } from 'vitest';
import {
  clientRateLimitKey,
  extractPeerAddress,
  ipToBits,
  loadTrustedProxyCidrs,
  parseCidr,
  parseTrustedProxyCidrs,
  resolveRateLimitKey,
} from '@/lib/client-address';

const CLOUDFLARE = loadTrustedProxyCidrs({});
// 162.158.0.0/15 is a published Cloudflare egress range.
const CF_PEER = '162.158.1.1';
const DIRECT_PEER = '203.0.113.7';

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://example.test/', { headers });
}

function serverReturning(address: string | null): { requestIP: () => { address: string } | null } {
  return { requestIP: () => (address === null ? null : { address }) };
}

describe('resolveRateLimitKey', () => {
  it('ignores a spoofed header from an untrusted peer and keys on the peer address', () => {
    const key = resolveRateLimitKey(
      { supported: true, address: DIRECT_PEER },
      '1.2.3.4',
      CLOUDFLARE,
    );
    expect(key).toBe(`peer:${DIRECT_PEER}`);
    expect(key).not.toContain('1.2.3.4');
  });

  it('keys a missing header on the peer address rather than granting an unlimited pass', () => {
    const key = resolveRateLimitKey({ supported: true, address: DIRECT_PEER }, null, CLOUDFLARE);
    expect(key).toBe(`peer:${DIRECT_PEER}`);
    expect(key).not.toBeNull();
  });

  it('trusts the forwarded header only when the peer is a trusted proxy', () => {
    const key = resolveRateLimitKey({ supported: true, address: CF_PEER }, '9.9.9.9', CLOUDFLARE);
    expect(key).toBe('ip:9.9.9.9');
  });

  it('falls back to the peer when a trusted proxy forwards no header', () => {
    const key = resolveRateLimitKey({ supported: true, address: CF_PEER }, null, CLOUDFLARE);
    expect(key).toBe(`peer:${CF_PEER}`);
  });

  it('gives an unreadable peer no key (null, not fail-open) when the lookup is supported', () => {
    expect(
      resolveRateLimitKey({ supported: true, address: null }, '1.2.3.4', CLOUDFLARE),
    ).toBeNull();
    expect(
      resolveRateLimitKey({ supported: true, address: 'bogus' }, '1.2.3.4', CLOUDFLARE),
    ).toBeNull();
  });

  it('uses the validated header when the runtime exposes no peer lookup', () => {
    expect(resolveRateLimitKey({ supported: false, address: null }, '5.6.7.8', CLOUDFLARE)).toBe(
      'ip:5.6.7.8',
    );
    expect(resolveRateLimitKey({ supported: false, address: null }, null, CLOUDFLARE)).toBeNull();
  });

  it('keeps a direct attacker and the forwarded client in distinct buckets', () => {
    // An attacker hitting the origin directly while spoofing a victim's IP must not
    // share (or poison) the bucket of that IP as forwarded by the real proxy.
    const direct = resolveRateLimitKey(
      { supported: true, address: DIRECT_PEER },
      '9.9.9.9',
      CLOUDFLARE,
    );
    const forwarded = resolveRateLimitKey(
      { supported: true, address: CF_PEER },
      '9.9.9.9',
      CLOUDFLARE,
    );
    expect(direct).not.toBe(forwarded);
  });
});

describe('trusted proxy configuration', () => {
  it('trusts the published Cloudflare ranges by default', () => {
    expect(resolveRateLimitKey({ supported: true, address: CF_PEER }, '9.9.9.9', CLOUDFLARE)).toBe(
      'ip:9.9.9.9',
    );
  });

  it('never trusts a header when TRUSTED_PROXY_CIDRS disables proxies', () => {
    for (const raw of ['off', 'none', '', '   ']) {
      const cidrs = parseTrustedProxyCidrs(raw);
      expect(resolveRateLimitKey({ supported: true, address: CF_PEER }, '9.9.9.9', cidrs)).toBe(
        `peer:${CF_PEER}`,
      );
    }
  });

  it('honors a custom trusted CIDR list', () => {
    const cidrs = parseTrustedProxyCidrs('10.0.0.0/8, 2001:db8::/32');
    expect(resolveRateLimitKey({ supported: true, address: '10.1.2.3' }, '9.9.9.9', cidrs)).toBe(
      'ip:9.9.9.9',
    );
    expect(resolveRateLimitKey({ supported: true, address: '11.1.2.3' }, '9.9.9.9', cidrs)).toBe(
      'peer:11.1.2.3',
    );
    expect(resolveRateLimitKey({ supported: true, address: '2001:db8::5' }, '9.9.9.9', cidrs)).toBe(
      'ip:9.9.9.9',
    );
  });

  it('memoizes by raw spec and drops malformed entries', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8, not-a-cidr, 300.1.2.3/8' };
    expect(loadTrustedProxyCidrs(env)).toBe(loadTrustedProxyCidrs(env));
    expect(loadTrustedProxyCidrs(env)).toHaveLength(1);
  });
});

describe('ipToBits and parseCidr', () => {
  it('parses IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect(ipToBits('1.2.3.4')).toEqual({ bits: 32, value: 0x01020304n });
    expect(ipToBits('::ffff:1.2.3.4')).toEqual({ bits: 32, value: 0x01020304n });
    expect(ipToBits('2606:4700::1')?.bits).toBe(128);
    expect(ipToBits('::1')?.bits).toBe(128);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'zz::1', '', '1.2.3.4/8']) {
      expect(ipToBits(bad)).toBeNull();
    }
  });

  it('matches addresses inside and outside a CIDR block', () => {
    const block = parseCidr('192.168.0.0/16');
    expect(block).not.toBeNull();
    // Reuse resolveRateLimitKey as the public membership path.
    const trusted = [block!];
    expect(resolveRateLimitKey({ supported: true, address: '192.168.5.5' }, 'h', trusted)).toBe(
      'ip:h',
    );
    expect(resolveRateLimitKey({ supported: true, address: '192.169.5.5' }, 'h', trusted)).toBe(
      'peer:192.169.5.5',
    );
  });

  it('rejects a malformed CIDR and an over-long prefix', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('nope/8')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
  });
});

describe('extractPeerAddress', () => {
  it('reports no support when the context has no requestIP', () => {
    expect(extractPeerAddress(undefined, reqWith({}))).toEqual({ supported: false, address: null });
    expect(extractPeerAddress({}, reqWith({}))).toEqual({ supported: false, address: null });
    expect(extractPeerAddress(null, reqWith({}))).toEqual({ supported: false, address: null });
  });

  it('reads the socket address when requestIP is present', () => {
    expect(extractPeerAddress(serverReturning('203.0.113.9'), reqWith({}))).toEqual({
      supported: true,
      address: '203.0.113.9',
    });
  });

  it('unwraps a nested server, as Hono exposes it', () => {
    expect(extractPeerAddress({ server: serverReturning('203.0.113.9') }, reqWith({}))).toEqual({
      supported: true,
      address: '203.0.113.9',
    });
  });

  it('reports a supported-but-absent peer as null', () => {
    expect(extractPeerAddress(serverReturning(null), reqWith({}))).toEqual({
      supported: true,
      address: null,
    });
  });
});

describe('clientRateLimitKey', () => {
  it('ignores a spoofed header from an untrusted transport peer', () => {
    const c = {
      env: serverReturning(DIRECT_PEER),
      req: { raw: reqWith({ 'cf-connecting-ip': '9.9.9.9' }) },
    };
    expect(clientRateLimitKey(c, {})).toBe(`peer:${DIRECT_PEER}`);
  });

  it('uses the forwarded header from a trusted Cloudflare peer', () => {
    const c = {
      env: serverReturning(CF_PEER),
      req: { raw: reqWith({ 'cf-connecting-ip': '9.9.9.9' }) },
    };
    expect(clientRateLimitKey(c, {})).toBe('ip:9.9.9.9');
  });

  it('does not grant an unlimited pass when the header is missing', () => {
    const c = { env: serverReturning(DIRECT_PEER), req: { raw: reqWith({}) } };
    expect(clientRateLimitKey(c, {})).toBe(`peer:${DIRECT_PEER}`);
  });

  it('falls back to the header when no transport peer is exposed (test harness)', () => {
    const c = { env: undefined, req: { raw: reqWith({ 'cf-connecting-ip': '9.9.9.9' }) } };
    expect(clientRateLimitKey(c, {})).toBe('ip:9.9.9.9');
  });
});
