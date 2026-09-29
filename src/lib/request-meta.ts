/**
 * Validated client metadata read from request headers.
 */
export interface ClientRequestMeta {
  clientIp: string | null;
  clientCountry: string | null;
  cfRay: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  origin: string | null;
}

function isValidIpv4(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

function isValidIpv6(value: string): boolean {
  if (!value || value.includes('%') || !/^[0-9a-fA-F:.]+$/.test(value)) {
    return false;
  }

  let hexAddress = value;
  if (hexAddress.includes('.')) {
    const finalColon = hexAddress.lastIndexOf(':');
    const ipv4 = hexAddress.slice(finalColon + 1);
    if (finalColon < 0 || !isValidIpv4(ipv4)) {
      return false;
    }
    hexAddress = `${hexAddress.slice(0, finalColon + 1)}0:0`;
  }

  const sides = hexAddress.split('::');
  if (sides.length > 2) {
    return false;
  }

  const groups = sides.flatMap((side) => (side ? side.split(':') : []));
  if (groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) {
    return false;
  }

  return sides.length === 1 ? groups.length === 8 : groups.length <= 7;
}

function readTextHeader(
  headers: { get(name: string): string | null | undefined },
  name: string,
): string | null {
  const value = headers.get(name);
  if (value === null || value === undefined) {
    return null;
  }
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += char;
    }
  }
  cleaned = cleaned.slice(0, 200);
  return cleaned === '' ? null : cleaned;
}

/**
 * Reads and validates client metadata from request headers.
 */
export function readClientRequestMeta(headers: {
  get(name: string): string | null | undefined;
}): ClientRequestMeta {
  const rawClientIp = headers.get('cf-connecting-ip');
  const clientIp =
    rawClientIp !== null &&
    rawClientIp !== undefined &&
    (isValidIpv4(rawClientIp) || isValidIpv6(rawClientIp))
      ? rawClientIp
      : null;

  const rawClientCountry = headers.get('cf-ipcountry');
  const normalizedClientCountry =
    rawClientCountry === null || rawClientCountry === undefined
      ? null
      : rawClientCountry.trim().toUpperCase();
  const clientCountry =
    normalizedClientCountry !== null && /^[A-Z0-9]{2}$/.test(normalizedClientCountry)
      ? normalizedClientCountry
      : null;

  const rawCfRay = headers.get('cf-ray');
  const cfRay =
    rawCfRay !== null && rawCfRay !== undefined && /^[0-9a-f]{16}-[A-Za-z]{3}$/i.test(rawCfRay)
      ? rawCfRay
      : null;

  const rawOrigin = headers.get('origin');
  const origin =
    rawOrigin !== null &&
    rawOrigin !== undefined &&
    (/^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(rawOrigin) ||
      /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(rawOrigin))
      ? rawOrigin
      : null;

  return {
    clientIp,
    clientCountry,
    cfRay,
    userAgent: readTextHeader(headers, 'user-agent'),
    acceptLanguage: readTextHeader(headers, 'accept-language'),
    origin,
  };
}

/**
 * Returns the non-null client metadata fields.
 */
export function presentClientFields(meta: ClientRequestMeta): {
  [key: string]: string;
} {
  const fields: { [key: string]: string } = {};
  for (const key of [
    'clientIp',
    'clientCountry',
    'cfRay',
    'userAgent',
    'acceptLanguage',
    'origin',
  ] as const) {
    const value = meta[key];
    if (value !== null) {
      fields[key] = value;
    }
  }
  return fields;
}
