import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyRosterDocument } from '@/lib/daily-roster';
import {
  DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  InMemoryDailyRosterStore,
} from '@/lib/daily-roster-store';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore } from '@/lib/gift-store';
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

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function writtenStore(partial: Partial<DailyRosterDocument> = {}): InMemoryDailyRosterStore {
  return new InMemoryDailyRosterStore({
    comment: partial.comment ?? '',
    paymentsEnabled: partial.paymentsEnabled ?? true,
    moderatorPaymentsEnabled: partial.moderatorPaymentsEnabled ?? true,
    defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
    recipients: partial.recipients ?? [],
    moderators: partial.moderators ?? [],
  });
}

function pingFetch(
  opts: {
    pingStatus?: number;
    pingError?: Error;
    onCall?: (url: string, init?: RequestInit) => void;
  } = {},
): FetchFn {
  return async (input, init) => {
    if (opts.onCall !== undefined) {
      opts.onCall(String(input), init);
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

  it('throws when both env values are set and the roster store is omitted', () => {
    expect(() => resolveSpendPing({ SPEND_URL, SPEND_API_TOKEN: TOKEN }, fetchImpl)).toThrow(
      'Daily roster store is required',
    );
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
      { rosterStore: writtenStore({ recipients: [{ address: ADDRESS, amountUsd: 2 }] }) },
    );
    expect(ping).toBeInstanceOf(HttpSpendPing);
    await ping?.ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(seen).toBe('https://spend.example/ping');
  });

  it('accepts an options object that omits the gift ledger and the clock', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const ping = resolveSpendPing({ SPEND_URL, SPEND_API_TOKEN: TOKEN }, fetchImpl, {
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
    });
    expect(ping).toBeInstanceOf(HttpSpendPing);
    await ping?.ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/ping`);
  });

  it('uses the current clock when the gift ledger is set and now is omitted', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const ping = resolveSpendPing({ SPEND_URL, SPEND_API_TOKEN: TOKEN }, fetchImpl, {
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([]),
    });
    await ping?.ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/ping`);
  });

  it('forwards the gift ledger and the clock into the daily decision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const welcomeToday: GiftRow = {
      paidAt: new Date('2026-09-20T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    const ping = resolveSpendPing({ SPEND_URL, SPEND_API_TOKEN: TOKEN }, fetchImpl, {
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeToday]),
      now: () => nowMs,
    });
    await ping?.ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'welcome_paid',
      ),
    ).toBe(true);
    warn.mockRestore();
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

  it('does not POST daily when the roster is undecided and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
    }).ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'undecided',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.ok on 202 accepted', async () => {
    const fetchImpl: FetchFn = pingFetch({ pingStatus: 202 });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(true);
  });

  it('uses AbortSignal.timeout of 5000 by default and the injected timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: FetchFn = pingFetch();
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
      timeoutMs: 1_000,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(timeoutSpy).toHaveBeenCalledWith(1_000);
    timeoutSpy.mockRestore();
  });

  it('logs spend.ping.failed on POST non-2xx and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch({ pingStatus: 500 }));
    await expect(
      new HttpSpendPing({
        spendUrl: SPEND_URL,
        token: TOKEN,
        fetchImpl,
        rosterStore: writtenStore(),
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/ping`);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed on POST network error and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch({ pingError: new Error('network down') }));
    await expect(
      new HttpSpendPing({
        spendUrl: SPEND_URL,
        token: TOKEN,
        fetchImpl,
        rosterStore: writtenStore(),
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on POST abort and does not throw', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch({ pingError: abortError() }));
    await expect(
      new HttpSpendPing({
        spendUrl: SPEND_URL,
        token: TOKEN,
        fetchImpl,
        rosterStore: writtenStore(),
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('logs spend.ping.failed on a roster read throw and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const rosterStore = writtenStore();
    vi.spyOn(rosterStore, 'get').mockRejectedValue(new Error('network down'));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl, rosterStore }).ping(
        ADDRESS,
        MESSAGE_ID,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed when hasBeenWritten throws and does not GET or POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const rosterStore = new InMemoryDailyRosterStore();
    vi.spyOn(rosterStore, 'hasBeenWritten').mockRejectedValue(new Error('store down'));
    await expect(
      new HttpSpendPing({ spendUrl: SPEND_URL, token: TOKEN, fetchImpl, rosterStore }).ping(
        ADDRESS,
        MESSAGE_ID,
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('does not POST moderator when the roster has an empty moderators list and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'not_listed',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
  });

  it('POSTs welcome JSON with amountUsd 1 and comment Welcome', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = pingFetch({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
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
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('does not POST daily when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ paymentsEnabled: false }),
    }).ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('does not POST welcome when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ paymentsEnabled: false }),
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        moderators: [{ address: ADDRESS, amountUsd: 3 }],
        moderatorPaymentsEnabled: false,
      }),
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        moderators: [{ address: 'other@example.com', amountUsd: 3 }],
      }),
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const fetchImpl: FetchFn = pingFetch({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: 'Ada@WalletOfSatoshi.com', amountUsd: 2 }],
      }),
    }).ping(ADDRESS, MESSAGE_ID);
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
    const fetchImpl: FetchFn = pingFetch({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        comment: 'thanks',
        moderators: [{ address: ADDRESS, amountUsd: 3 }],
      }),
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
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

  it('does not POST daily when unlisted without grantStatus even if defaultAmountUsd is present', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ comment: 'thanks' }),
    }).ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'undecided',
      ),
    ).toBe(true);
  });

  it('POSTs defaultAmountUsd 1 for an unlisted admitted daily address', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      pingFetch({
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ comment: 'thanks' }),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 1,
        comment: 'thanks',
      }),
    );
    expect(String(seenInit?.body)).not.toContain('"kind"');
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
  });

  it('POSTs 1 USD for an unlisted trial daily address', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      pingFetch({
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ comment: 'thanks' }),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'trial');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 1,
        comment: 'thanks',
      }),
    );
  });

  it('does not POST an unlisted daily address when grantStatus is none, pending, or rejected', async () => {
    for (const grantStatus of ['none', 'pending', 'rejected'] as const) {
      const fetchImpl = vi.fn<FetchFn>(pingFetch());
      await new HttpSpendPing({
        spendUrl: SPEND_URL,
        token: TOKEN,
        fetchImpl,
        rosterStore: writtenStore({ comment: 'thanks' }),
      }).ping(ADDRESS, MESSAGE_ID, 'daily', grantStatus);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(
        parsedEvents(warn).some(
          (e) =>
            e['event'] === 'spend.ping.skipped' &&
            e['address'] === ADDRESS &&
            e['reason'] === 'not_listed',
        ),
      ).toBe(true);
      warn.mockClear();
    }
  });

  it('POSTs the listed daily amount when grantStatus is rejected', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      pingFetch({
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'rejected');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ comment: 'thanks', paymentsEnabled: false }),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not POST daily when a welcome gift was paid today and logs spend.ping.skipped', async () => {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const welcomeToday: GiftRow = {
      paidAt: new Date('2026-09-20T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeToday]),
      now: () => nowMs,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'welcome_paid',
      ),
    ).toBe(true);
  });

  it('POSTs listed daily when the welcome gift was paid on the previous UTC day', async () => {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn<FetchFn>(
      pingFetch({
        onCall: (_url, init) => {
          seenInit = init;
        },
      }),
    );
    const welcomeYesterday: GiftRow = {
      paidAt: new Date('2026-09-19T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeYesterday]),
      now: () => nowMs,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/ping`);
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
  });

  it('logs spend.ping.failed when listOutbound rejects and does not POST', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch());
    const gifts = {
      listOutbound: async () => {
        throw new Error('ledger down');
      },
    };
    await expect(
      new HttpSpendPing({
        spendUrl: SPEND_URL,
        token: TOKEN,
        fetchImpl,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        gifts,
      }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('POSTs welcome JSON when gifts is set and does not list outbound gifts', async () => {
    let listCalls = 0;
    const gifts = {
      listOutbound: async () => {
        listCalls += 1;
        throw new Error('must not list');
      },
    };
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = pingFetch({
      onCall: (_url, init) => {
        seenInit = init;
      },
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore(),
      gifts,
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(listCalls).toBe(0);
    expect(seenInit?.method).toBe('POST');
    expect(seenInit?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        kind: 'welcome',
        amountUsd: 1,
        comment: 'Welcome',
      }),
    );
  });

  it('GETs live daily-roster when unwritten, POSTs decided daily, and does not import', async () => {
    const rosterStore = new InMemoryDailyRosterStore();
    const getSpy = vi.spyOn(rosterStore, 'get');
    const importSpy = vi.spyOn(rosterStore, 'importDocument');
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      if (String(input) === `${SPEND_URL}/daily-roster`) {
        return new Response(
          JSON.stringify({
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 1,
            recipients: [{ address: ADDRESS, amountUsd: 2.5 }],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    const getInit = fetchImpl.mock.calls[0]?.[1];
    expect(getInit?.method).toBe('GET');
    expect(getInit?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(new Headers(getInit?.headers).get('Content-Type')).toBeNull();
    expect(getInit?.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${SPEND_URL}/ping`);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2.5,
        comment: 'thanks',
      }),
    );
    expect(getSpy).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok' && e['address'] === ADDRESS),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('GETs live daily-roster when unwritten and skips moderator as undecided without importing', async () => {
    const rosterStore = new InMemoryDailyRosterStore();
    const importSpy = vi.spyOn(rosterStore, 'importDocument');
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      if (String(input) === `${SPEND_URL}/daily-roster`) {
        return new Response(
          JSON.stringify({
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 1,
            recipients: [{ address: ADDRESS, amountUsd: 2.5 }],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    expect(importSpy).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'undecided',
      ),
    ).toBe(true);
  });

  it('GETs live daily-roster when unwritten and POSTs listed moderator', async () => {
    const rosterStore = new InMemoryDailyRosterStore();
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      if (String(input) === `${SPEND_URL}/daily-roster`) {
        return new Response(
          JSON.stringify({
            paymentsEnabled: true,
            moderatorPaymentsEnabled: true,
            moderators: [{ address: ADDRESS, amountUsd: 5 }],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${SPEND_URL}/ping`);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'moderator',
        groupMessageId: MESSAGE_ID,
        amountUsd: 5,
        comment: '21gifts moderator',
      }),
    );
  });

  it('logs spend.ping.failed when unwritten live GET returns non-2xx', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(null, { status: 500 }));
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: new InMemoryDailyRosterStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/daily-roster$/u);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('logs spend.ping.failed when unwritten live GET body is JSON null', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response('null', { status: 200 }));
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: new InMemoryDailyRosterStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('logs spend.ping.failed when unwritten live GET throws', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => {
      throw new Error('network down');
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: new InMemoryDailyRosterStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('GETs live daily-roster when unwritten and skips welcome when paymentsEnabled is false', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => {
      return new Response(JSON.stringify({ paymentsEnabled: false }), { status: 200 });
    });
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: new InMemoryDailyRosterStore(),
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/daily-roster`);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['address'] === ADDRESS &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not GET when a written store lists the moderator', async () => {
    const fetchImpl = vi.fn<FetchFn>(pingFetch({ pingStatus: 202 }));
    await new HttpSpendPing({
      spendUrl: SPEND_URL,
      token: TOKEN,
      fetchImpl,
      rosterStore: writtenStore({ moderators: [{ address: ADDRESS, amountUsd: 5 }] }),
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${SPEND_URL}/ping`);
  });
});
