import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import { HttpSpendPing, NoopSpendPing, resolveSpendPing } from '@/lib/spend-ping';

const ADDRESS = 'ada@walletofsatoshi.com';
const MESSAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKEN = 'spend-secret-token';
const SPEND_URL = 'https://spend.example';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('NoopSpendPing', () => {
  it('resolves without calling fetch', async () => {
    const fetchImpl = vi.fn<FetchFn>();
    await expect(new NoopSpendPing().ping(ADDRESS, MESSAGE_ID)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveSpendPing', () => {
  const fetchImpl: FetchFn = async () => new Response(null, { status: 200 });

  it('returns undefined when SPEND_URL is missing', () => {
    expect(resolveSpendPing({ SPEND_API_TOKEN: TOKEN }, fetchImpl)).toBeUndefined();
  });

  it('returns undefined when SPEND_URL is blank', () => {
    expect(
      resolveSpendPing({ SPEND_URL: '  ', SPEND_API_TOKEN: TOKEN }, fetchImpl),
    ).toBeUndefined();
  });

  it('returns undefined when SPEND_API_TOKEN is missing', () => {
    expect(resolveSpendPing({ SPEND_URL }, fetchImpl)).toBeUndefined();
  });

  it('returns undefined when SPEND_API_TOKEN is blank', () => {
    expect(resolveSpendPing({ SPEND_URL, SPEND_API_TOKEN: '\t' }, fetchImpl)).toBeUndefined();
  });

  it('returns HttpSpendPing with trimmed URL and stripped trailing slashes', async () => {
    let seen = '';
    const recording: FetchFn = async (input) => {
      seen = String(input);
      return new Response(null, { status: 200 });
    };
    const ping = resolveSpendPing(
      { SPEND_URL: ' https://spend.example/// ', SPEND_API_TOKEN: ` ${TOKEN} ` },
      recording,
    );
    expect(ping).toBeInstanceOf(HttpSpendPing);
    await ping?.ping(ADDRESS, MESSAGE_ID);
    expect(seen).toBe('https://spend.example/ping');
  });
});

describe('HttpSpendPing', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('POSTs JSON { address, messageId } with Bearer token and logs spend.ping.ok on 200', async () => {
    let seenInput = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (input, init) => {
      seenInput = String(input);
      seenInit = init;
      return new Response(null, { status: 200 });
    };
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(seenInput).toBe(`${SPEND_URL}/ping`);
    expect(seenInit?.method).toBe('POST');
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(seenInit?.headers).get('Content-Type')).toBe('application/json');
    expect(seenInit?.body).toBe(JSON.stringify({ address: ADDRESS, messageId: MESSAGE_ID }));
    expect(seenInit?.signal).toBeDefined();
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.ok on 202 accepted', async () => {
    const fetchImpl: FetchFn = async () => new Response(null, { status: 202 });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(true);
  });

  it('uses AbortSignal.timeout of 5000 by default and the injected timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = async () => new Response(null, { status: 200 });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      timeoutMs: 1_000,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(timeoutSpy).toHaveBeenCalledWith(1_000);
    timeoutSpy.mockRestore();
  });

  it('logs spend.ping.failed on non-2xx and does not throw', async () => {
    const fetchImpl: FetchFn = async () => new Response(null, { status: 500 });
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed on network error and does not throw', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('network down');
    };
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on abort and does not throw', async () => {
    const fetchImpl: FetchFn = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });
});
