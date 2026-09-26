import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import { HttpBtcMapPush, btcMapSubmissionBody, resolveBtcMapPush } from '@/lib/btcmap-push';
import type { OcpPlace } from '@/lib/ocp-place-store';

const TOKEN = 'btcmap-secret-token';
const SUBMIT_URL = 'https://api.btcmap.org/v4/place-submissions';

const PLACE: OcpPlace = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  origin: '21gifts',
  externalId: 'msg-1',
  name: 'Stall',
  lat: 47.3,
  lon: 8.5,
  category: 'shopping',
  paymentMethods: 'lightning',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
};

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('btcMapSubmissionBody', () => {
  it('includes payment_methods only when set', () => {
    expect(btcMapSubmissionBody(PLACE)).toEqual({
      lat: 47.3,
      lon: 8.5,
      category: 'shopping',
      name: 'Stall',
      extra_fields: { source: '21gifts', payment_methods: 'lightning' },
    });
    expect(btcMapSubmissionBody({ ...PLACE, paymentMethods: null })).toEqual({
      lat: 47.3,
      lon: 8.5,
      category: 'shopping',
      name: 'Stall',
      extra_fields: { source: '21gifts' },
    });
  });
});

describe('resolveBtcMapPush', () => {
  const fetchImpl: FetchFn = async () => new Response(null, { status: 200 });

  it('returns undefined when BTCMAP_ACCESS_TOKEN is missing or blank', () => {
    expect(resolveBtcMapPush({}, fetchImpl)).toBeUndefined();
    expect(resolveBtcMapPush({ BTCMAP_ACCESS_TOKEN: '  ' }, fetchImpl)).toBeUndefined();
  });

  it('uses the default URL and strips trailing slashes from BTCMAP_SUBMIT_URL', async () => {
    let seen = '';
    const recording: FetchFn = async (input) => {
      seen = String(input);
      return new Response(null, { status: 200 });
    };
    const defaultPush = resolveBtcMapPush({ BTCMAP_ACCESS_TOKEN: TOKEN }, recording);
    expect(defaultPush).toBeInstanceOf(HttpBtcMapPush);
    await defaultPush?.submit(PLACE);
    expect(seen).toBe(SUBMIT_URL);

    const custom = resolveBtcMapPush(
      {
        BTCMAP_ACCESS_TOKEN: ` ${TOKEN} `,
        BTCMAP_SUBMIT_URL: ' https://map.example/v4/place-submissions/// ',
      },
      recording,
    );
    await custom?.submit(PLACE);
    expect(seen).toBe('https://map.example/v4/place-submissions');
  });
});

describe('HttpBtcMapPush', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('POSTs JSON with Bearer token and logs btcmap.push.ok on 2xx', async () => {
    let seenInput = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (input, init) => {
      seenInput = String(input);
      seenInit = init;
      return new Response(null, { status: 201 });
    };
    const result = await new HttpBtcMapPush({
      submitUrl: SUBMIT_URL,
      token: TOKEN,
      fetchImpl,
    }).submit(PLACE);
    expect(result).toBe('sent');
    expect(seenInput).toBe(SUBMIT_URL);
    expect(seenInit?.method).toBe('POST');
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(seenInit?.headers).get('Content-Type')).toBe('application/json');
    expect(seenInit?.body).toBe(JSON.stringify(btcMapSubmissionBody(PLACE)));
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'btcmap.push.ok' && e['origin'] === '21gifts'),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('uses AbortSignal.timeout of 5000 by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = async () => new Response(null, { status: 200 });
    await new HttpBtcMapPush({ submitUrl: SUBMIT_URL, token: TOKEN, fetchImpl }).submit(PLACE);
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    timeoutSpy.mockRestore();
  });

  it('logs btcmap.push.failed on non-2xx and does not throw', async () => {
    const fetchImpl: FetchFn = async () => new Response(null, { status: 500 });
    await expect(
      new HttpBtcMapPush({ submitUrl: SUBMIT_URL, token: TOKEN, fetchImpl }).submit(PLACE),
    ).resolves.toBe('failed');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'btcmap.push.failed' && e['origin'] === '21gifts',
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs btcmap.push.failed on network error and does not throw', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('network down');
    };
    await expect(
      new HttpBtcMapPush({ submitUrl: SUBMIT_URL, token: TOKEN, fetchImpl }).submit(PLACE),
    ).resolves.toBe('failed');
    expect(parsedEvents(warn).some((e) => e['event'] === 'btcmap.push.failed')).toBe(true);
  });
});
