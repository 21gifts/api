import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAILY_ROSTER_INVALID_CHANGE,
  DAILY_ROSTER_UNAVAILABLE,
  DailyRosterRequestError,
  HttpDailyRoster,
  mapDailyRosterResponse,
  resolveDailyRoster,
  withRecipientIdentities,
} from '@/lib/daily-roster';
import type { FetchFn } from '@/lib/lnurlp';

const TOKEN = 'test-token';
const SPEND_URL = 'https://spend.example';
const ROSTER = {
  comment: 'thanks',
  paymentsEnabled: true,
  defaultAmountUsd: 3,
  recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
};

describe('resolveDailyRoster', () => {
  it('returns undefined and does not call fetch when SPEND_URL is missing or blank', () => {
    const fetchImpl = vi.fn<FetchFn>();
    expect(resolveDailyRoster({ SPEND_API_TOKEN: TOKEN }, fetchImpl)).toBeUndefined();
    expect(
      resolveDailyRoster({ SPEND_URL: '  ', SPEND_API_TOKEN: TOKEN }, fetchImpl),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns undefined and does not call fetch when SPEND_API_TOKEN is missing or blank', () => {
    const fetchImpl = vi.fn<FetchFn>();
    expect(resolveDailyRoster({ SPEND_URL }, fetchImpl)).toBeUndefined();
    expect(resolveDailyRoster({ SPEND_URL, SPEND_API_TOKEN: '\t' }, fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns HttpDailyRoster with a trimmed URL and stripped trailing slashes', async () => {
    let seen = '';
    const fetchImpl: FetchFn = async (input) => {
      seen = String(input);
      return new Response(JSON.stringify(ROSTER), { status: 200 });
    };
    const client = resolveDailyRoster(
      { SPEND_URL: ' https://spend.example/// ', SPEND_API_TOKEN: ` ${TOKEN} ` },
      fetchImpl,
    );
    expect(client).toBeInstanceOf(HttpDailyRoster);
    await client?.get();
    expect(seen).toBe('https://spend.example/daily-roster');
  });
});

describe('mapDailyRosterResponse', () => {
  it('forwards the five spend 400 errors unchanged', () => {
    for (const error of [
      'Invalid comment',
      'Invalid payments switch',
      'Invalid address or amount',
      'Address already listed',
      'Unknown address',
    ]) {
      expect(mapDailyRosterResponse(400, { error, extra: true })).toEqual({
        ok: false,
        status: 400,
        error,
      });
    }
  });

  it('maps any other spend 400 to Invalid daily roster change', () => {
    expect(mapDailyRosterResponse(400, { error: 'nope' })).toEqual({
      ok: false,
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    expect(mapDailyRosterResponse(400, { error: 'Address already listed ' })).toEqual({
      ok: false,
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    expect(mapDailyRosterResponse(400, null)).toEqual({
      ok: false,
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    expect(mapDailyRosterResponse(400, 'nope')).toEqual({
      ok: false,
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    expect(mapDailyRosterResponse(400, { error: 1 })).toEqual({
      ok: false,
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
  });

  it('maps 401, 403, 500, and any other status to unavailable', () => {
    for (const status of [401, 403, 500, 404, 201, 204]) {
      expect(mapDailyRosterResponse(status, { error: 'nope', ...ROSTER })).toEqual({
        ok: false,
        status: 502,
        error: DAILY_ROSTER_UNAVAILABLE,
      });
    }
  });

  it('accepts a 200 DailyRoster and rejects a body that is not that shape', () => {
    expect(mapDailyRosterResponse(200, { ...ROSTER, extra: true })).toEqual({
      ok: true,
      roster: ROSTER,
    });
    expect(
      mapDailyRosterResponse(200, {
        ...ROSTER,
        recipients: [{ address: 'ada@example.com', amountUsd: 2, note: 'hide' }],
      }),
    ).toEqual({ ok: true, roster: ROSTER });
    expect(
      mapDailyRosterResponse(200, {
        comment: '',
        paymentsEnabled: false,
        defaultAmountUsd: 3,
        recipients: [],
      }),
    ).toEqual({
      ok: true,
      roster: { comment: '', paymentsEnabled: false, defaultAmountUsd: 3, recipients: [] },
    });
    expect(
      mapDailyRosterResponse(200, { comment: '', paymentsEnabled: false, recipients: [] }),
    ).toEqual({ ok: false, status: 502, error: DAILY_ROSTER_UNAVAILABLE });
    expect(
      mapDailyRosterResponse(200, {
        comment: '',
        paymentsEnabled: false,
        defaultAmountUsd: Number.NaN,
        recipients: [],
      }),
    ).toEqual({ ok: false, status: 502, error: DAILY_ROSTER_UNAVAILABLE });
    expect(mapDailyRosterResponse(200, { comment: 'x', paymentsEnabled: true })).toEqual({
      ok: false,
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    expect(
      mapDailyRosterResponse(200, {
        comment: 'x',
        paymentsEnabled: false,
        defaultAmountUsd: 3,
        recipients: [{ address: 'ada@example.com', amountUsd: Number.NaN }],
      }),
    ).toEqual({ ok: false, status: 502, error: DAILY_ROSTER_UNAVAILABLE });
    for (const body of [
      null,
      'nope',
      [],
      { comment: 1, paymentsEnabled: true, recipients: [] },
      { comment: 'x', paymentsEnabled: 'yes', recipients: [] },
      { comment: 'x', paymentsEnabled: true, defaultAmountUsd: 3, recipients: [null] },
      { comment: 'x', paymentsEnabled: true, defaultAmountUsd: 3, recipients: ['ada'] },
      {
        comment: 'x',
        paymentsEnabled: true,
        defaultAmountUsd: 3,
        recipients: [{ address: 1, amountUsd: 1 }],
      },
      {
        comment: 'x',
        paymentsEnabled: true,
        defaultAmountUsd: 3,
        recipients: [{ address: 'a', amountUsd: '1' }],
      },
    ]) {
      expect(mapDailyRosterResponse(200, body)).toEqual({
        ok: false,
        status: 502,
        error: DAILY_ROSTER_UNAVAILABLE,
      });
    }
  });
});

describe('withRecipientIdentities', () => {
  it('fills identities from lookup and preserves order and stored addresses', async () => {
    const seen: string[] = [];
    const roster = {
      comment: 'thanks',
      paymentsEnabled: true,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'Ada@example.com', amountUsd: 2 },
        { address: 'bob@example.com', amountUsd: 1 },
      ],
    };
    await expect(
      withRecipientIdentities(roster, async (address) => {
        seen.push(address);
        if (address === 'Ada@example.com') {
          return { id: 'ada-id', name: '  Ada  ' };
        }
        return undefined;
      }),
    ).resolves.toEqual({
      comment: 'thanks',
      paymentsEnabled: true,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'Ada@example.com', amountUsd: 2, accountId: 'ada-id', name: 'Ada' },
        { address: 'bob@example.com', amountUsd: 1, accountId: null, name: null },
      ],
    });
    expect(seen).toEqual(['Ada@example.com', 'bob@example.com']);
  });

  it('maps null, missing, and blank names to null', async () => {
    const roster = {
      comment: '',
      paymentsEnabled: false,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'a@example.com', amountUsd: 1 },
        { address: 'b@example.com', amountUsd: 1 },
        { address: 'c@example.com', amountUsd: 1 },
      ],
    };
    await expect(
      withRecipientIdentities(roster, async (address) => {
        if (address === 'a@example.com') {
          return { id: 'a', name: null };
        }
        if (address === 'b@example.com') {
          return { id: 'b', name: '   ' };
        }
        return { id: 'c' } as { id: string; name: string | null };
      }),
    ).resolves.toEqual({
      comment: '',
      paymentsEnabled: false,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'a@example.com', amountUsd: 1, accountId: 'a', name: null },
        { address: 'b@example.com', amountUsd: 1, accountId: 'b', name: null },
        { address: 'c@example.com', amountUsd: 1, accountId: 'c', name: null },
      ],
    });
  });

  it('does not call lookup when there are no recipients', async () => {
    const lookup = vi.fn();
    await expect(
      withRecipientIdentities(
        { comment: '', paymentsEnabled: false, defaultAmountUsd: 3, recipients: [] },
        lookup,
      ),
    ).resolves.toEqual({
      comment: '',
      paymentsEnabled: false,
      defaultAmountUsd: 3,
      recipients: [],
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('propagates a lookup throw', async () => {
    const boom = new Error('lookup failed');
    await expect(
      withRecipientIdentities(ROSTER, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('HttpDailyRoster', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function client(fetchImpl: FetchFn, timeoutMs?: number): HttpDailyRoster {
    return new HttpDailyRoster({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  it('GETs the roster with Bearer test-token and does not log the token or address', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (_input, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ ...ROSTER, extra: true }), { status: 200 });
    };
    await expect(client(fetchImpl).get()).resolves.toEqual(ROSTER);
    expect(seenInit?.method).toBe('GET');
    expect(seenInit?.body).toBeUndefined();
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(seenInit?.headers).get('Content-Type')).toBeNull();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('thanks');
  });

  it('POSTs each edit to the matching path', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      seen.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify(ROSTER), { status: 200 });
    };
    const roster = client(fetchImpl);
    await roster.setComment('hello');
    await roster.setPaymentsEnabled(false);
    await roster.addRecipient('ada@example.com', 3);
    await roster.updateRecipient('ada@example.com', 4);
    await roster.deleteRecipient('ada@example.com');
    expect(seen).toEqual([
      { url: `${SPEND_URL}/daily-roster/comment`, body: JSON.stringify({ comment: 'hello' }) },
      { url: `${SPEND_URL}/daily-roster/payments`, body: JSON.stringify({ enabled: false }) },
      {
        url: `${SPEND_URL}/daily-roster/recipients`,
        body: JSON.stringify({ address: 'ada@example.com', amountUsd: 3 }),
      },
      {
        url: `${SPEND_URL}/daily-roster/recipients/update`,
        body: JSON.stringify({ address: 'ada@example.com', amountUsd: 4 }),
      },
      {
        url: `${SPEND_URL}/daily-roster/recipients/delete`,
        body: JSON.stringify({ address: 'ada@example.com' }),
      },
    ]);
    for (const call of seen) {
      expect(call.body).not.toContain(TOKEN);
    }
  });

  it('uses AbortSignal.timeout of 5000 by default and the injected timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = async () => new Response(JSON.stringify(ROSTER), { status: 200 });
    await client(fetchImpl).get();
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    await client(fetchImpl, 1_000).get();
    expect(timeoutSpy).toHaveBeenCalledWith(1_000);
    timeoutSpy.mockRestore();
  });

  it('forwards spend 400 Address already listed', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'Address already listed' }), { status: 400 });
    await expect(client(fetchImpl).addRecipient('ada@example.com', 1)).rejects.toMatchObject({
      name: 'DailyRosterRequestError',
      status: 400,
      error: 'Address already listed',
    });
    await expect(client(fetchImpl).addRecipient('ada@example.com', 1)).rejects.toBeInstanceOf(
      DailyRosterRequestError,
    );
  });

  it('maps other spend 400 text and does not forward a 401 body', async () => {
    const badChange: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 400 });
    await expect(client(badChange).get()).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    const denied: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    await expect(client(denied).get()).rejects.toMatchObject({
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
  });

  it('maps network, abort, and a 200 body that is not JSON to unavailable', async () => {
    const network: FetchFn = async () => {
      throw new Error('network down');
    };
    await expect(client(network).get()).rejects.toMatchObject({
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    const aborting: FetchFn = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(client(aborting).get()).rejects.toMatchObject({
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    const junk: FetchFn = async () => new Response('not-json', { status: 200 });
    await expect(client(junk).get()).rejects.toMatchObject({
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('network down');
  });

  it('maps a body read failure to unavailable and a readable non-JSON 400 to invalid change', async () => {
    const aborted: FetchFn = async () =>
      ({
        status: 400,
        text: () => Promise.reject(new Error('body aborted')),
      }) as Response;
    await expect(client(aborted).get()).rejects.toMatchObject({
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    const junk: FetchFn = async () => new Response('not-json', { status: 400 });
    await expect(client(junk).get()).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_CHANGE,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('body aborted');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('maps a blank spend body to unavailable', async () => {
    const fetchImpl: FetchFn = async () => new Response('   ', { status: 200 });
    await expect(client(fetchImpl).get()).rejects.toMatchObject({
      status: 502,
      error: DAILY_ROSTER_UNAVAILABLE,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });
});
