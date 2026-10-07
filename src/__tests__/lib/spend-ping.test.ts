import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import { HttpSpendPing, NoopSpendPing, resolveSpendPing } from '@/lib/spend-ping';

const ADDRESS = 'ada@walletofsatoshi.com';
const MESSAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKEN = 'spend-secret-token';
const SPEND_URL = 'https://spend.example';
const UNDECIDED_ROSTER = { comment: '', paymentsEnabled: true, recipients: [] };

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function rosterThenPing(opts: {
  roster?: unknown;
  rosterBody?: string;
  rosterStatus?: number;
  pingStatus?: number;
  rosterError?: Error;
  pingError?: Error;
  onCall?: (url: string, init?: RequestInit) => void;
}): FetchFn {
  return async (input, init) => {
    const url = String(input);
    if (opts.onCall !== undefined) {
      opts.onCall(url, init);
    }
    const rosterStatus = opts.rosterStatus !== undefined ? opts.rosterStatus : 200;
    if (url === `${SPEND_URL}/daily-roster`) {
      if (opts.rosterError !== undefined) {
        throw opts.rosterError;
      }
      if (opts.rosterBody !== undefined) {
        return new Response(opts.rosterBody, { status: rosterStatus });
      }
      return jsonResponse(opts.roster !== undefined ? opts.roster : UNDECIDED_ROSTER, rosterStatus);
    }
    if (opts.pingError !== undefined) {
      throw opts.pingError;
    }
    const pingStatus = opts.pingStatus !== undefined ? opts.pingStatus : 200;
    return new Response(null, { status: pingStatus });
  };
}

describe('NoopSpendPing', () => {
  it('resolves without calling fetch', async () => {
    const fetchImpl = vi.fn<FetchFn>();
    await expect(new NoopSpendPing().ping(ADDRESS, MESSAGE_ID)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveSpendPing', () => {
  const fetchImpl: FetchFn = async () => jsonResponse(UNDECIDED_ROSTER);

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
      return jsonResponse(UNDECIDED_ROSTER);
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
    const fetchImpl = vi.fn<FetchFn>(async (input, init) => {
      seenInput = String(input);
      seenInit = init;
      return jsonResponse(UNDECIDED_ROSTER);
    });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Bearer ${TOKEN}`,
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
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.skipped')).toBe(false);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.ok on 202 accepted', async () => {
    const fetchImpl: FetchFn = rosterThenPing({ pingStatus: 202 });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(true);
  });

  it('uses AbortSignal.timeout of 5000 by default and the injected timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = async () => jsonResponse(UNDECIDED_ROSTER);
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

  it('logs spend.ping.failed on POST non-2xx and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ pingStatus: 500 }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${SPEND_URL}/ping`);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed on POST network error and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ pingError: new Error('network down') }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on POST abort and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ pingError: abortError() }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on roster non-2xx and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ rosterStatus: 500 }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed on roster network error and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ rosterError: new Error('network down') }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on roster abort and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ rosterError: abortError() }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on roster non-JSON and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ rosterBody: 'not-json' }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on roster null JSON and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ roster: null }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on roster array JSON and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(rosterThenPing({ roster: [] }));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('POSTs JSON { address, kind: "moderator", groupMessageId } without messageId', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = rosterThenPing({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'moderator',
    );
    expect(seenInit?.method).toBe('POST');
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(seenInit?.headers).get('Content-Type')).toBe('application/json');
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'moderator',
        groupMessageId: MESSAGE_ID,
      }),
    );
    expect(String(seenInit?.body)).not.toContain('messageId');
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('POSTs welcome JSON with amountUsd 1 and comment Welcome', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = rosterThenPing({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'welcome',
    );
    expect(seenInit?.method).toBe('POST');
    expect(new Headers(seenInit?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(seenInit?.headers).get('Content-Type')).toBe('application/json');
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        kind: 'welcome',
        amountUsd: 1,
        comment: 'Welcome',
      }),
    );
    expect(String(seenInit?.body)).toContain('messageId');
    expect(String(seenInit?.body)).toContain('"kind":"welcome"');
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('does not POST daily when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({ roster: { comment: '', paymentsEnabled: false, recipients: [] } }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('does not POST welcome when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({ roster: { comment: '', paymentsEnabled: false, recipients: [] } }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'welcome',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not POST moderator when the switch is off and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: '',
          paymentsEnabled: true,
          recipients: [],
          moderators: [{ address: ADDRESS, amountUsd: 3 }],
          moderatorPaymentsEnabled: false,
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'moderator',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not POST an unlisted moderator and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: '',
          paymentsEnabled: true,
          recipients: [],
          moderators: [{ address: 'other@example.com', amountUsd: 3 }],
          moderatorPaymentsEnabled: true,
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'moderator',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'not_listed',
      ),
    ).toBe(true);
  });

  it('POSTs listed daily amountUsd and comment including a different address case', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = rosterThenPing({
      roster: {
        comment: 'thanks',
        paymentsEnabled: true,
        recipients: [{ address: 'Ada@WalletOfSatoshi.com', amountUsd: 2 }],
      },
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('POSTs the listed moderator amountUsd and comment 21gifts moderator', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = rosterThenPing({
      roster: {
        comment: 'thanks',
        paymentsEnabled: true,
        recipients: [],
        moderators: [{ address: ADDRESS, amountUsd: 3 }],
        moderatorPaymentsEnabled: true,
      },
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'moderator',
    );
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'moderator',
        groupMessageId: MESSAGE_ID,
        amountUsd: 3,
        comment: '21gifts moderator',
      }),
    );
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('POSTs the old daily body when unlisted even if defaultAmountUsd is present', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: 'thanks',
          paymentsEnabled: true,
          defaultAmountUsd: 9,
          recipients: [],
        },
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenInit?.body).toBe(JSON.stringify({ address: ADDRESS, messageId: MESSAGE_ID }));
    expect(String(seenInit?.body)).not.toContain('amountUsd');
    expect(String(seenInit?.body)).not.toContain('comment');
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.skipped')).toBe(false);
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('POSTs defaultAmountUsd 9 for an unlisted admitted daily address', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: 'thanks',
          paymentsEnabled: true,
          defaultAmountUsd: 9,
          recipients: [],
        },
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'daily',
      'admitted',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 9,
        comment: 'thanks',
      }),
    );
    expect(String(seenInit?.body)).not.toContain('"kind"');
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('POSTs 1 USD for unlisted admitted when defaultAmountUsd is missing, non-positive, or not a number', async () => {
    const rosters: unknown[] = [
      { comment: 'thanks', paymentsEnabled: true, recipients: [] },
      { comment: 'thanks', paymentsEnabled: true, defaultAmountUsd: 0, recipients: [] },
      { comment: 'thanks', paymentsEnabled: true, defaultAmountUsd: '9', recipients: [] },
    ];
    for (const roster of rosters) {
      let seenInit: RequestInit | undefined;
      const fetchImpl = vi.fn<FetchFn>(
        rosterThenPing({
          roster,
          onCall: (_url, init) => {
            seenInit = init;
          },
        }),
      );
      await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
        ADDRESS,
        MESSAGE_ID,
        'daily',
        'admitted',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(seenInit?.body).toBe(
        JSON.stringify({
          address: ADDRESS,
          messageId: MESSAGE_ID,
          amountUsd: 1,
          comment: 'thanks',
        }),
      );
    }
  });

  it('POSTs defaultAmountUsd for an unlisted trial daily address', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: 'thanks',
          paymentsEnabled: true,
          defaultAmountUsd: 9,
          recipients: [],
        },
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'daily',
      'trial',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 9,
        comment: 'thanks',
      }),
    );
  });

  it('does not POST an unlisted daily address when grantStatus is none, pending, or rejected', async () => {
    for (const grantStatus of ['none', 'pending', 'rejected'] as const) {
      const fetchImpl = vi.fn<FetchFn>(
        rosterThenPing({
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      );
      await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
        ADDRESS,
        MESSAGE_ID,
        'daily',
        grantStatus,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(
        parsedEvents(warn).some(
          (e) =>
            e['event'] === 'spend.ping.skipped' &&
            e['address'] === ADDRESS &&
            e['reason'] === 'not_listed',
        ),
      ).toBe(true);
      expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
      warn.mockClear();
    }
  });

  it('POSTs the listed daily amount when grantStatus is rejected', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: 'thanks',
          paymentsEnabled: true,
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        },
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'daily',
      'rejected',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.skipped')).toBe(false);
  });

  it('does not POST an unlisted admitted daily address when paymentsEnabled is false', async () => {
    const fetchImpl = vi.fn<FetchFn>(
      rosterThenPing({
        roster: {
          comment: 'thanks',
          paymentsEnabled: false,
          defaultAmountUsd: 9,
          recipients: [],
        },
      }),
    );
    await new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl }).ping(
      ADDRESS,
      MESSAGE_ID,
      'daily',
      'admitted',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
  });
});
