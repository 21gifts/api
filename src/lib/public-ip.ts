/**
 * Public unicast checks for resolved IP addresses.
 *
 * Shared by lookups that may only contact hosts on the public internet.
 */

/**
 * Whether a resolved address is a public unicast IP.
 *
 * IPv4 (dotted, IPv4-mapped, IPv4-compatible, IPv4-translated, 6to4, and
 * NAT64 forms) is checked against the non-public IPv4 ranges. Other IPv6 must
 * not fall in a listed non-global range.
 *
 * @param address - DNS answer.
 * @returns `true` when the address is a public unicast IP.
 */
export function isPublicIp(address: string): boolean {
  const value = address.trim().toLowerCase();
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) {
    return !isNonPublicIpv4(ipv4);
  }
  const mapped = mappedIpv4(value);
  if (mapped !== null) {
    return !isNonPublicIpv4(mapped);
  }
  const embedded = ipv4EmbeddedInIpv6(value);
  if (embedded !== null) {
    return !isNonPublicIpv4(embedded);
  }
  if (!value.includes(':')) {
    return false;
  }
  return isPublicIpv6(value);
}

/**
 * @param address - Candidate IPv4.
 * @returns Four octets, or `null` when it is not a canonical dotted quad.
 */
function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * IPv4 ranges that are not public unicast.
 *
 * @param octets - Parsed IPv4.
 * @returns `true` for the blocked ranges.
 */
function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  if (a === 198 && b === 51 && c === 100) {
    return true;
  }
  return a === 203 && b === 0 && c === 113;
}

/**
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d` and the hex form).
 *
 * @param address - Lowercase address.
 * @returns The embedded IPv4, or `null`.
 */
function mappedIpv4(address: string): [number, number, number, number] | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted !== null) {
    return parseIpv4(dotted[1]!);
  }
  const short = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (short !== null) {
    return ipv4FromHalves(parseInt(short[1]!, 16), parseInt(short[2]!, 16));
  }
  const groups = expandIpv6(address);
  if (
    groups === null ||
    groups[0] !== 0 ||
    groups[1] !== 0 ||
    groups[2] !== 0 ||
    groups[3] !== 0 ||
    groups[4] !== 0 ||
    groups[5] !== 0xffff
  ) {
    return null;
  }
  return ipv4FromHalves(groups[6]!, groups[7]!);
}

/**
 * @param hi - High 16 bits.
 * @param lo - Low 16 bits.
 * @returns Four octets.
 */
function ipv4FromHalves(hi: number, lo: number): [number, number, number, number] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/**
 * @param address - IPv6 text without a zone id.
 * @returns Eight groups, or `null`.
 */
function expandIpv6(address: string): number[] | null {
  if (address.includes('.')) {
    return null;
  }
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (side: string): number[] | null => {
    if (side === '') {
      return [];
    }
    const groups: number[] = [];
    for (const part of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      groups.push(parseInt(part, 16));
    }
    return groups;
  };
  const left = parseSide(halves[0]!);
  if (left === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1]!);
  if (right === null) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * IPv4 carried inside an IPv6 answer that is not the mapped form `::ffff:`.
 *
 * IPv4-compatible (`::x:x`), IPv4-translated (`::ffff:0:x:x`), 6to4
 * (`2002::/16`), and NAT64 (`64:ff9b::/96`).
 * Mapped addresses are handled by {@link mappedIpv4}.
 *
 * @param address - Lowercase address.
 * @returns The embedded IPv4, or `null` when this is not one of those forms.
 */
function ipv4EmbeddedInIpv6(address: string): [number, number, number, number] | null {
  const groups = expandIpv6(address);
  if (groups === null) {
    return null;
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return ipv4FromHalves(groups[6]!, groups[7]!);
  }
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return ipv4FromHalves(groups[6]!, groups[7]!);
  }
  if (groups[0] === 0x2002) {
    return ipv4FromHalves(groups[1]!, groups[2]!);
  }
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return ipv4FromHalves(groups[6]!, groups[7]!);
  }
  return null;
}

/**
 * @param groups - Eight expanded IPv6 groups.
 * @returns `true` for ranges that are not globally reachable unicast.
 */
function isNonGlobalIpv6(groups: readonly number[]): boolean {
  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g2 = groups[2]!;
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && groups[3]! === 0) {
    return true;
  }
  if (g0 === 0x5f00) {
    return true;
  }
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) {
    return true;
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }
  if (g0 !== 0x2001) {
    return false;
  }
  if (g1 === 0x0000 || g1 === 0x0001 || g1 === 0x0db8) {
    return true;
  }
  if (g1 === 0x0002 && g2 === 0x0000) {
    return true;
  }
  const orchid = g1 & 0xfff0;
  return orchid === 0x0010 || orchid === 0x0020;
}

/**
 * @param address - IPv6 text that is not an embedded IPv4 form.
 * @returns `false` for unique-local, link-local, site-local, multicast,
 * and ranges that are not globally reachable unicast.
 * Unspecified and loopback are embedded IPv4 (`::` is 0.0.0.0, `::1` is 0.0.0.1).
 */
function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (groups === null) {
    return false;
  }
  if (isNonGlobalIpv6(groups)) {
    return false;
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) {
    return false;
  }
  if ((first & 0xffc0) === 0xfe80) {
    return false;
  }
  if ((first & 0xffc0) === 0xfec0) {
    return false;
  }
  return (first & 0xff00) !== 0xff00;
}
