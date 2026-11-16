import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import {
  DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  InMemoryDailyRosterStore,
} from '@/lib/daily-roster-store';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { setAddressRefKey, setDiagnosticSink } from '@/lib/log';
import {
  FondQueueSink,
  HttpSpendPing,
  NoopSpendPing,
  type PayoutDelivery,
  type PayoutSink,
  resolveSpendPing,
} from '@/lib/spend-ping';
import { InMemoryFondPayoutStore } from '@/lib/fond-payout-store';
import { expectedAddressRef } from '@/__tests__/helpers/address-ref';
import { WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';

const ADDRESS = 'ada@example.com';
const MESSAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKEN = 'spend-secret-token';
const ADDRESS_REF = expectedAddressRef(ADDRESS, TOKEN);

const LNURL: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.com',
  host: 'example.com',
};

/** Account id of each verified-wallet username in these tests. */
const ACCOUNT_IDS: Record<string, string> = {
  ada: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
};

/** Accounts that receive on `<username>@example.com`. */
const LOOKUP = {
  accounts: {
    getAccountByUsername: async (username: string): Promise<Account | undefined> => {
      const id = ACCOUNT_IDS[username];
      return id === undefined
        ? undefined
        : ({ id, username, sparkPubkey: WALLET_PUBKEY, sparkPubkeyVerifiedAt: 1 } as Account);
    },
  },
  lnurlServer: LNURL,
};

/** Roster rows named by the address their account receives on. */
type AddressRows = { address: string; amountUsd: number }[];

function accountRows(rows: AddressRows = []): { accountId: string; amountUsd: number }[] {
  return rows.map((row) => ({
    accountId: ACCOUNT_IDS[row.address.toLowerCase().split('@')[0] ?? ''] ?? row.address,
    amountUsd: row.amountUsd,
  }));
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function writtenStore(
  partial: {
    comment?: string;
    paymentsEnabled?: boolean;
    moderatorPaymentsEnabled?: boolean;
    recipients?: AddressRows;
    moderators?: AddressRows;
  } = {},
): InMemoryDailyRosterStore {
  return new InMemoryDailyRosterStore({
    comment: partial.comment ?? '',
    paymentsEnabled: partial.paymentsEnabled ?? true,
    moderatorPaymentsEnabled: partial.moderatorPaymentsEnabled ?? true,
    defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
    recipients: accountRows(partial.recipients),
    moderators: accountRows(partial.moderators),
  });
}

type Deliver = (address: string, body: Record<string, string | number>) => Promise<PayoutDelivery>;

/** A sink that records every delivery and resolves with `delivery`. */
function recordingSink(delivery: PayoutDelivery = { outcome: 'accepted' }): {
  sink: PayoutSink;
  deliver: ReturnType<typeof vi.fn<Deliver>>;
} {
  const deliver = vi.fn<Deliver>(async () => delivery);
  return { sink: { deliver }, deliver };
}

describe('NoopSpendPing', () => {
  it('resolves undefined', async () => {
    await expect(new NoopSpendPing().ping(ADDRESS, MESSAGE_ID)).resolves.toBeUndefined();
  });
});

describe('resolveSpendPing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAddressRefKey(null);
  });

  it('returns undefined when PAYOUT_SIGNER is unset', () => {
    expect(
      resolveSpendPing(
        {},
        {
          rosterStore: writtenStore(),
          fondPayoutStore: new InMemoryFondPayoutStore(),
        },
      ),
    ).toBeUndefined();
  });

  it('returns undefined when PAYOUT_SIGNER is unset and no options are given', () => {
    expect(resolveSpendPing({})).toBeUndefined();
  });

  it('returns undefined when PAYOUT_SIGNER is blank or whitespace', () => {
    for (const value of ['', '  ', '\t']) {
      expect(
        resolveSpendPing(
          { PAYOUT_SIGNER: value },
          {
            rosterStore: writtenStore(),
            fondPayoutStore: new InMemoryFondPayoutStore(),
          },
        ),
      ).toBeUndefined();
    }
  });

  it('queues a decided daily ping into the fond payout store', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryFondPayoutStore();
    const ping = resolveSpendPing(
      { PAYOUT_SIGNER: 'fond' },
      {
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        fondPayoutStore: store,
        now: () => Date.parse('2026-11-09T12:00:00.000Z'),
      },
    );
    expect(ping).toBeInstanceOf(HttpSpendPing);
    await expect(ping?.ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted')).resolves.toEqual({
      status: 'accepted',
    });
    const rows = await store.listOpen('2026-11-09');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'daily',
      address: ADDRESS,
      amountUsd: '2',
      comment: 'thanks',
      messageId: MESSAGE_ID,
      groupMessageId: null,
      status: 'owed',
    });
  });

  it('accepts PAYOUT_SIGNER in any case with surrounding whitespace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryFondPayoutStore();
    const ping = resolveSpendPing(
      { PAYOUT_SIGNER: ' FOND ' },
      {
        ...LOOKUP,
        rosterStore: writtenStore({ moderators: [{ address: ADDRESS, amountUsd: 3 }] }),
        fondPayoutStore: store,
        now: () => Date.parse('2026-11-09T12:00:00.000Z'),
      },
    );
    expect(ping).toBeInstanceOf(HttpSpendPing);
    await ping?.ping(ADDRESS, MESSAGE_ID, 'moderator');
    const rows = await store.listOpen('2026-11-09');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'moderator',
      address: ADDRESS,
      amountUsd: '3',
      comment: '21gifts moderator',
      messageId: null,
      groupMessageId: MESSAGE_ID,
    });
  });

  it('accepts an options object that omits the gift ledger, the clock, and the lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T23:30:00.000Z'));
    try {
      const store = new InMemoryFondPayoutStore();
      const ping = resolveSpendPing(
        { PAYOUT_SIGNER: 'fond' },
        {
          rosterStore: writtenStore({ comment: 'thanks' }),
          fondPayoutStore: store,
        },
      );
      expect(ping).toBeInstanceOf(HttpSpendPing);
      await ping?.ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
      const rows = await store.listOpen('2026-11-09');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ address: ADDRESS, amountUsd: '1', comment: 'thanks' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the current clock when the gift ledger is set and now is omitted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    try {
      const store = new InMemoryFondPayoutStore();
      const welcomeYesterday: GiftRow = {
        paidAt: new Date('2026-09-19T08:00:00.000Z'),
        amountSats: 1000,
        recipientWosUser: 'Ada',
        kind: 'welcome',
      };
      const ping = resolveSpendPing(
        { PAYOUT_SIGNER: 'fond' },
        {
          ...LOOKUP,
          rosterStore: writtenStore({
            comment: 'thanks',
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          }),
          fondPayoutStore: store,
          gifts: new InMemoryGiftStore([welcomeYesterday]),
        },
      );
      await ping?.ping(ADDRESS, MESSAGE_ID);
      const rows = await store.listOpen('2026-09-20');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ address: ADDRESS, amountUsd: '2' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the gift ledger and the clock into the daily decision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const store = new InMemoryFondPayoutStore(() => nowMs);
    const welcomeToday: GiftRow = {
      paidAt: new Date('2026-09-20T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    const ping = resolveSpendPing(
      { PAYOUT_SIGNER: 'fond' },
      {
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        fondPayoutStore: store,
        gifts: new InMemoryGiftStore([welcomeToday]),
        now: () => nowMs,
      },
    );
    await expect(ping?.ping(ADDRESS, MESSAGE_ID)).resolves.toEqual({
      status: 'skipped',
      reason: 'welcome_paid',
    });
    expect(await store.listOpen('2026-09-20')).toEqual([]);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'welcome_paid',
      ),
    ).toBe(true);
  });

  it('throws Invalid PAYOUT_SIGNER for spend', () => {
    expect(() =>
      resolveSpendPing(
        { PAYOUT_SIGNER: 'spend' },
        {
          rosterStore: writtenStore(),
          fondPayoutStore: new InMemoryFondPayoutStore(),
        },
      ),
    ).toThrow('Invalid PAYOUT_SIGNER');
  });

  it('throws Invalid PAYOUT_SIGNER for another value before resolving stores', () => {
    expect(() => resolveSpendPing({ PAYOUT_SIGNER: 'other' })).toThrow('Invalid PAYOUT_SIGNER');
  });

  it('requires the roster and fond payout stores in fond mode', () => {
    expect(() => resolveSpendPing({ PAYOUT_SIGNER: 'fond' })).toThrow(
      'Daily roster store is required',
    );
    expect(() =>
      resolveSpendPing(
        { PAYOUT_SIGNER: 'fond' },
        { fondPayoutStore: new InMemoryFondPayoutStore() },
      ),
    ).toThrow('Daily roster store is required');
    expect(() =>
      resolveSpendPing({ PAYOUT_SIGNER: 'fond' }, { rosterStore: writtenStore() }),
    ).toThrow('Fond payout store is required');
  });
});

describe('HttpSpendPing', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setAddressRefKey(TOKEN);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    setDiagnosticSink(null);
    setAddressRefKey(null);
  });

  it.each<[string, PayoutDelivery, boolean]>([
    ['spend.ping.ok', { outcome: 'accepted' }, true],
    ['spend.ping.failed', { outcome: 'failed' }, true],
    ['spend.ping.skipped', { outcome: 'accepted' }, false],
  ])(
    'prints %s with addressRef and no address, and the sink keeps the address',
    async (event, delivery, listed) => {
      const sink = vi.fn();
      setDiagnosticSink(sink);
      await new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore(
          listed ? { recipients: [{ address: ADDRESS, amountUsd: 2 }] } : {},
        ),
        sink: recordingSink(delivery).sink,
      }).ping(ADDRESS, MESSAGE_ID);
      const lines = parsedEvents(warn).filter((e) => e['event'] === event);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.['addressRef']).toBe(ADDRESS_REF);
      expect('address' in (lines[0] ?? {})).toBe(false);
      expect(warn.mock.calls.flat().join('\n')).not.toContain(ADDRESS);
      expect(sink).toHaveBeenCalledWith(event, expect.objectContaining({ address: ADDRESS }));
    },
  );

  it('does not deliver daily when the roster is undecided and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore(),
        sink,
      }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toEqual({ status: 'skipped', reason: 'undecided' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'undecided',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.ok when the sink accepts', async () => {
    const { sink } = recordingSink({ outcome: 'accepted' });
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore(),
        sink,
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toEqual({ status: 'accepted' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(true);
  });

  it('logs spend.ping.failed when the sink fails and does not throw', async () => {
    const { sink, deliver } = recordingSink({ outcome: 'failed' });
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore(),
        sink,
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toEqual({ status: 'failed' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('logs spend.ping.failed on a roster read throw and does not deliver', async () => {
    const { sink, deliver } = recordingSink();
    const rosterStore = writtenStore();
    vi.spyOn(rosterStore, 'get').mockRejectedValue(new Error('network down'));
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore,
        sink,
      }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toEqual({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('reads the roster through the store once and never asks whether it was written', async () => {
    const { sink, deliver } = recordingSink();
    const rosterStore = writtenStore({ recipients: [{ address: ADDRESS, amountUsd: 2 }] });
    const get = vi.spyOn(rosterStore, 'get');
    const hasBeenWritten = vi.spyOn(rosterStore, 'hasBeenWritten');
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore,
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(get).toHaveBeenCalledTimes(1);
    expect(hasBeenWritten).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('decides from the stored defaults when the roster store was never written', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: new InMemoryDailyRosterStore(),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[1]).toEqual({
      address: ADDRESS,
      messageId: MESSAGE_ID,
      amountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
      comment: '',
    });
  });

  it('does not deliver moderator when the roster has an empty moderators list and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore(),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'not_listed',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.ok')).toBe(false);
  });

  it('delivers welcome with amountUsd 1 and comment Welcome', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore(),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'welcome',
        amountUsd: 1,
        comment: 'Welcome',
      }),
    );
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('does not deliver daily when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ paymentsEnabled: false }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('does not deliver welcome when paymentsEnabled is false and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ paymentsEnabled: false }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not deliver moderator when the switch is off and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        moderators: [{ address: ADDRESS, amountUsd: 3 }],
        moderatorPaymentsEnabled: false,
      }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not deliver an unlisted moderator and logs spend.ping.skipped', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        moderators: [{ address: 'other@example.com', amountUsd: 3 }],
      }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'not_listed',
      ),
    ).toBe(true);
  });

  it('delivers listed daily amountUsd and comment including a different address case', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: 'Ada@Example.com', amountUsd: 2 }],
      }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('delivers the listed moderator amountUsd and comment 21gifts moderator', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        moderators: [{ address: ADDRESS, amountUsd: 3 }],
      }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'moderator');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'moderator',
        groupMessageId: MESSAGE_ID,
        amountUsd: 3,
        comment: '21gifts moderator',
      }),
    );
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('does not deliver daily when unlisted without grantStatus even if defaultAmountUsd is present', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ comment: 'thanks' }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'undecided',
      ),
    ).toBe(true);
  });

  it('delivers defaultAmountUsd 1 for an unlisted admitted daily address', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ comment: 'thanks' }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 1,
        comment: 'thanks',
      }),
    );
    expect('kind' in (deliver.mock.calls[0]?.[1] ?? {})).toBe(false);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('delivers 1 USD for an unlisted trial daily address', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ comment: 'thanks' }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'trial');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 1,
        comment: 'thanks',
      }),
    );
  });

  it('does not deliver to an unlisted daily address when grantStatus is none, pending, or rejected', async () => {
    for (const grantStatus of ['none', 'pending', 'rejected'] as const) {
      const { sink, deliver } = recordingSink();
      await new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore({ comment: 'thanks' }),
        sink,
      }).ping(ADDRESS, MESSAGE_ID, 'daily', grantStatus);
      expect(deliver).not.toHaveBeenCalled();
      expect(
        parsedEvents(warn).some(
          (e) =>
            e['event'] === 'spend.ping.skipped' &&
            e['addressRef'] === ADDRESS_REF &&
            e['reason'] === 'not_listed',
        ),
      ).toBe(true);
      warn.mockClear();
    }
  });

  it('delivers the listed daily amount when grantStatus is rejected', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'rejected');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'spend.ping.skipped')).toBe(false);
  });

  it('does not deliver to an unlisted admitted daily address when paymentsEnabled is false', async () => {
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ comment: 'thanks', paymentsEnabled: false }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'payments_disabled',
      ),
    ).toBe(true);
  });

  it('does not deliver daily when a welcome gift was paid today and logs spend.ping.skipped', async () => {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const { sink, deliver } = recordingSink();
    const welcomeToday: GiftRow = {
      paidAt: new Date('2026-09-20T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeToday]),
      now: () => nowMs,
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'welcome_paid',
      ),
    ).toBe(true);
  });

  it('delivers listed daily when the welcome gift was paid on the previous UTC day', async () => {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const { sink, deliver } = recordingSink();
    const welcomeYesterday: GiftRow = {
      paidAt: new Date('2026-09-19T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeYesterday]),
      now: () => nowMs,
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
      }),
    );
  });

  it('logs spend.ping.failed when listOutbound rejects and does not deliver', async () => {
    const { sink, deliver } = recordingSink();
    const gifts = {
      listOutbound: async () => {
        throw new Error('ledger down');
      },
    };
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        gifts,
        sink,
      }).ping(ADDRESS, MESSAGE_ID),
    ).resolves.toEqual({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('delivers welcome when gifts is set and does not list outbound gifts', async () => {
    let listCalls = 0;
    const gifts = {
      listOutbound: async () => {
        listCalls += 1;
        throw new Error('must not list');
      },
    };
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore(),
      gifts,
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'welcome');
    expect(listCalls).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'welcome',
        amountUsd: 1,
        comment: 'Welcome',
      }),
    );
  });

  it('pingOnDay delivers the argument day when welcome was paid on the clock day', async () => {
    const nowMs = Date.parse('2026-09-20T12:00:00.000Z');
    const { sink, deliver } = recordingSink();
    const welcomeToday: GiftRow = {
      paidAt: new Date('2026-09-20T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeToday]),
      now: () => nowMs,
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19');
    expect(outcome).toEqual({ status: 'accepted' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe(ADDRESS);
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
        day: '2026-09-19',
      }),
    );
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).not.toContain('2026-09-20');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(TOKEN);
  });

  it('pingOnDay books a moderator stipend on the argument day without the welcome check', async () => {
    const { sink, deliver } = recordingSink();
    const listOutbound = vi.fn(async () => []);
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ moderators: [{ address: ADDRESS, amountUsd: 5 }] }),
      gifts: { listOutbound },
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19', undefined, 'moderator');
    expect(outcome).toEqual({ status: 'accepted' });
    expect(listOutbound).not.toHaveBeenCalled();
    expect(JSON.stringify(deliver.mock.calls[0]?.[1])).toBe(
      JSON.stringify({
        address: ADDRESS,
        kind: 'moderator',
        groupMessageId: MESSAGE_ID,
        amountUsd: 5,
        comment: '21gifts moderator',
        day: '2026-09-19',
      }),
    );
  });

  it('pingOnDay skips when the welcome gift was paid on the argument day', async () => {
    const { sink, deliver } = recordingSink();
    const welcomeOnDay: GiftRow = {
      paidAt: new Date('2026-09-19T08:00:00.000Z'),
      amountSats: 1000,
      recipientWosUser: 'Ada',
      kind: 'welcome',
    };
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      gifts: new InMemoryGiftStore([welcomeOnDay]),
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19');
    expect(outcome).toEqual({ status: 'skipped', reason: 'welcome_paid' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'welcome_paid',
      ),
    ).toBe(true);
  });

  it('pingOnDay returns skipped with the reason the sink reports', async () => {
    const { sink } = recordingSink({ outcome: 'skipped', reason: 'paid' });
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19');
    expect(outcome).toEqual({ status: 'skipped', reason: 'paid' });
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'spend.ping.skipped' &&
          e['addressRef'] === ADDRESS_REF &&
          e['reason'] === 'paid',
      ),
    ).toBe(true);
  });

  it('pingOnDay returns accepted when the sink accepts', async () => {
    const { sink } = recordingSink({ outcome: 'accepted' });
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19');
    expect(outcome).toEqual({ status: 'accepted' });
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.ok' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('pingOnDay returns failed when the sink fails and does not throw', async () => {
    const { sink } = recordingSink({ outcome: 'failed' });
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        sink,
      }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19'),
    ).resolves.toEqual({ status: 'failed' });
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('pingOnDay returns failed on a roster read throw and does not deliver', async () => {
    const { sink, deliver } = recordingSink();
    const rosterStore = writtenStore({ recipients: [{ address: ADDRESS, amountUsd: 2 }] });
    vi.spyOn(rosterStore, 'get').mockRejectedValue(new Error('store down'));
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore,
        sink,
      }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19'),
    ).resolves.toEqual({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('pingOnDay returns failed when listOutbound rejects and does not deliver', async () => {
    const { sink, deliver } = recordingSink();
    const gifts = {
      listOutbound: async () => {
        throw new Error('ledger down');
      },
    };
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        gifts,
        sink,
      }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-09-19'),
    ).resolves.toEqual({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.failed' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });
});

describe('HttpSpendPing stored rows by account', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches no stored row without an account lookup and pays the default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      rosterStore: writtenStore({ recipients: [{ address: ADDRESS, amountUsd: 2 }] }),
      sink,
    }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ amountUsd: 1 });
  });

  it('matches no stored row for an address on another host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({ moderators: [{ address: ADDRESS, amountUsd: 3 }] }),
      sink,
    }).ping('ada@elsewhere.example', MESSAGE_ID, 'moderator');
    expect(deliver).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['reason'] === 'not_listed')).toBe(true);
  });

  it('logs spend.ping.failed and does not deliver when the account lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sink, deliver } = recordingSink();
    const ping = new HttpSpendPing({
      accounts: { getAccountByUsername: () => Promise.reject(new Error('db down')) },
      lnurlServer: LNURL,
      rosterStore: writtenStore(),
      sink,
    });
    expect(await ping.ping(ADDRESS, MESSAGE_ID)).toEqual({ status: 'failed' });
    expect(await ping.pingOnDay(ADDRESS, MESSAGE_ID, '2026-10-01')).toEqual({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
    expect(parsedEvents(warn).filter((e) => e['event'] === 'spend.ping.failed')).toHaveLength(2);
  });
});

describe('HttpSpendPing with an injected sink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAddressRefKey(null);
  });

  it('logs accepted, skipped, and failed from the sink outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    const deliver = vi
      .fn<Deliver>()
      .mockResolvedValueOnce({ outcome: 'accepted' })
      .mockResolvedValueOnce({ outcome: 'skipped', reason: 'paid' })
      .mockResolvedValueOnce({ outcome: 'failed' });
    const ping = new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        comment: 'thanks',
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      sink: { deliver },
    });
    await ping.ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted');
    expect(parsedEvents(warn).some((event) => event['event'] === 'spend.ping.ok')).toBe(true);
    expect(await ping.pingOnDay(ADDRESS, MESSAGE_ID, '2026-11-09')).toEqual({
      status: 'skipped',
      reason: 'paid',
    });
    expect(await ping.pingOnDay(ADDRESS, MESSAGE_ID, '2026-11-09')).toEqual({ status: 'failed' });
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[0]?.[1]).toEqual({
      address: ADDRESS,
      messageId: MESSAGE_ID,
      amountUsd: 2,
      comment: 'thanks',
    });
  });

  it('passes through the skip reason from an injected sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    const { sink } = recordingSink({ outcome: 'skipped', reason: 'closed' });
    const outcome = await new HttpSpendPing({
      ...LOOKUP,
      rosterStore: writtenStore({
        recipients: [{ address: ADDRESS, amountUsd: 2 }],
      }),
      sink,
    }).pingOnDay(ADDRESS, MESSAGE_ID, '2026-11-09');
    expect(outcome).toEqual({ status: 'skipped', reason: 'closed' });
    expect(
      parsedEvents(warn).some(
        (event) => event['event'] === 'spend.ping.skipped' && event['reason'] === 'closed',
      ),
    ).toBe(true);
  });

  it('logs spend.ping.skipped when the injected sink skips during ping', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    const { sink, deliver } = recordingSink({ outcome: 'skipped', reason: 'paid' });
    await expect(
      new HttpSpendPing({
        ...LOOKUP,
        rosterStore: writtenStore({
          comment: 'thanks',
          recipients: [{ address: ADDRESS, amountUsd: 2 }],
        }),
        sink,
      }).ping(ADDRESS, MESSAGE_ID, 'daily', 'admitted'),
    ).resolves.toEqual({ status: 'skipped', reason: 'paid' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      parsedEvents(warn).some(
        (event) => event['event'] === 'spend.ping.skipped' && event['reason'] === 'paid',
      ),
    ).toBe(true);
  });

  it('logs spend.ping.failed when the injected store read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    const rosterStore = writtenStore();
    vi.spyOn(rosterStore, 'get').mockRejectedValue(new Error('down'));
    const { sink, deliver } = recordingSink();
    await new HttpSpendPing({
      rosterStore,
      sink,
    }).ping(ADDRESS, MESSAGE_ID);
    expect(deliver).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((event) => event['event'] === 'spend.ping.failed')).toBe(true);
  });

  it('returns each concurrent delivery its own skip reason when deliveries finish in reverse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = new Map<string, (delivery: PayoutDelivery) => void>();
    const sink: PayoutSink = {
      deliver: (_address, body) =>
        new Promise<PayoutDelivery>((resolve) => {
          pending.set(String(body['day']), resolve);
        }),
    };
    const ping = new HttpSpendPing({
      ...LOOKUP,
      rosterStore: new InMemoryDailyRosterStore(),
      sink,
    });
    const first = ping.pingOnDay(ADDRESS, MESSAGE_ID, '2026-11-09', 'admitted');
    const second = ping.pingOnDay(ADDRESS, MESSAGE_ID, '2026-11-10', 'admitted');
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get('2026-11-10')?.({ outcome: 'skipped', reason: 'second' });
    pending.get('2026-11-09')?.({ outcome: 'skipped', reason: 'first' });
    await expect(second).resolves.toEqual({ status: 'skipped', reason: 'second' });
    await expect(first).resolves.toEqual({ status: 'skipped', reason: 'first' });
  });
});

describe('FondQueueSink', () => {
  it('writes one owed row and stores String(number) without rounding', async () => {
    const store = new InMemoryFondPayoutStore(() => Date.parse('2026-11-09T12:00:00.000Z'));
    const sink = new FondQueueSink({ store });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        messageId: MESSAGE_ID,
        amountUsd: 2,
        comment: 'thanks',
        day: '2026-11-09',
      }),
    ).toEqual({ outcome: 'accepted' });
    const rows = await store.listOpen('2026-11-09');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'daily',
      address: ADDRESS,
      amountUsd: '2',
      comment: 'thanks',
      messageId: MESSAGE_ID,
      groupMessageId: null,
      status: 'owed',
    });
  });

  it('uses the clock UTC day when the body has no day and maps kinds', async () => {
    const now = (): number => Date.parse('2026-11-09T23:30:00.000Z');
    const store = new InMemoryFondPayoutStore(now);
    const sink = new FondQueueSink({ store, now });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      kind: 'moderator',
      groupMessageId: MESSAGE_ID,
      amountUsd: 3,
      comment: '21gifts moderator',
    });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      kind: 'welcome',
      messageId: MESSAGE_ID,
      amountUsd: 1,
      comment: 'Welcome',
    });
    const rows = await store.listOpen('2026-11-09');
    expect(rows.map((row) => row.kind).sort()).toEqual(['moderator', 'welcome']);
    expect(rows.find((row) => row.kind === 'moderator')).toMatchObject({
      messageId: null,
      groupMessageId: MESSAGE_ID,
      amountUsd: '3',
    });
    expect(rows.find((row) => row.kind === 'welcome')).toMatchObject({
      messageId: null,
      groupMessageId: null,
      amountUsd: '1',
    });
  });

  it('uses the default clock UTC day when the body has no day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T23:30:00.000Z'));
    try {
      const store = new InMemoryFondPayoutStore();
      const sink = new FondQueueSink({ store });
      expect(
        await sink.deliver(ADDRESS, {
          address: ADDRESS,
          messageId: MESSAGE_ID,
          amountUsd: 2,
          comment: 'thanks',
        }),
      ).toEqual({ outcome: 'accepted' });
      const rows = await store.listOpen('2026-11-09');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'daily',
        address: ADDRESS,
        amountUsd: '2',
        comment: 'thanks',
        messageId: MESSAGE_ID,
        groupMessageId: null,
        status: 'owed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without inserting when amount or comment is invalid', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    for (const body of [
      { address: ADDRESS, day: '2026-11-09', comment: 'thanks' },
      { address: ADDRESS, day: '2026-11-09', amountUsd: 0, comment: 'thanks' },
      { address: ADDRESS, day: '2026-11-09', amountUsd: Number.NaN, comment: 'thanks' },
      { address: ADDRESS, day: '2026-11-09', amountUsd: '0.00', comment: 'thanks' },
      { address: ADDRESS, day: '2026-11-09', amountUsd: 'abc', comment: 'thanks' },
      { address: ADDRESS, day: '2026-11-09', amountUsd: 1 },
      { address: ADDRESS, day: '2026-11-09', amountUsd: 1, comment: 7 },
    ]) {
      expect(await sink.deliver(ADDRESS, body)).toEqual({ outcome: 'failed' });
    }
    expect(await store.listOpen('2026-11-09')).toEqual([]);
  });

  it('stores exact cents and refuses finer values', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        amountUsd: '1.23',
        comment: 'thanks',
        day: '2026-11-09',
      }),
    ).toEqual({ outcome: 'accepted' });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        amountUsd: 1,
        comment: 'thanks',
        day: '2026-11-10',
      }),
    ).toEqual({ outcome: 'accepted' });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        amountUsd: 0.004,
        comment: 'thanks',
        day: '2026-11-11',
      }),
    ).toEqual({ outcome: 'failed' });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        amountUsd: '1.235',
        comment: 'thanks',
        day: '2026-11-12',
      }),
    ).toEqual({ outcome: 'failed' });
    expect((await store.listOpen('2026-11-09'))[0]).toMatchObject({ amountUsd: '1.23' });
    expect((await store.listOpen('2026-11-10'))[0]).toMatchObject({ amountUsd: '1' });
    expect(await store.listOpen('2026-11-11')).toEqual([]);
    expect(await store.listOpen('2026-11-12')).toEqual([]);
  });

  it('refuses numeric and string values below one cent or above two fraction digits', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    for (const amountUsd of [0.004, '0.004', '0.01x', '1.235', '1.230']) {
      expect(
        await sink.deliver(ADDRESS, {
          address: ADDRESS,
          amountUsd,
          comment: 'thanks',
          day: '2026-11-09',
        }),
      ).toEqual({ outcome: 'failed' });
    }
    expect(await store.listOpen('2026-11-09')).toEqual([]);
  });

  it('still refuses a zero value and a negative number', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    for (const amountUsd of [0, -1, '0', '-1', '0.00']) {
      expect(
        await sink.deliver(ADDRESS, {
          address: ADDRESS,
          amountUsd,
          comment: 'thanks',
          day: '2026-11-09',
        }),
      ).toEqual({ outcome: 'failed' });
    }
  });

  it('accepts the largest exact two-fraction-digit number without rounding it', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    expect(
      await sink.deliver(ADDRESS, {
        address: ADDRESS,
        amountUsd: 999999.99,
        comment: 'thanks',
        day: '2026-11-09',
      }),
    ).toEqual({ outcome: 'accepted' });
    expect((await store.listOpen('2026-11-09'))[0]).toMatchObject({ amountUsd: '999999.99' });
  });

  it('stores a whole number string and a one-decimal string exactly', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      amountUsd: '1',
      comment: 'thanks',
      day: '2026-11-09',
    });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      amountUsd: '1.2',
      comment: 'thanks',
      day: '2026-11-10',
    });
    expect((await store.listOpen('2026-11-09'))[0]).toMatchObject({ amountUsd: '1' });
    expect((await store.listOpen('2026-11-10'))[0]).toMatchObject({ amountUsd: '1.2' });
  });

  it('returns failed when the store reports an unconfirmed conflict', async () => {
    const sink = new FondQueueSink({
      store: {
        enqueue: async () => 'failed',
        listOpen: async () => [],
        depositAddress: async () => null,
        setDepositAddress: async () => false,
        get: async () => undefined,
        claimForInvoice: async () => null,
        setInvoiced: async () => undefined,
        claimStaleIssuing: async () => undefined,
        markStaleSettlingPaid: async () => undefined,
        restoreStaleSettling: async () => undefined,
        markFailed: async () => undefined,
        releaseClaim: async () => undefined,
        claimSettlement: async () => undefined,
        markPaid: async () => undefined,
        releaseSettlement: () => Promise.resolve(undefined),
        paidTotals: async () => ({ payoutsPaid: 0, payoutsPaidUsd: '0.00' }),
      },
    });
    expect(await sink.deliver(ADDRESS, { day: '2026-11-09', amountUsd: 1, comment: 'x' })).toEqual({
      outcome: 'failed',
    });
  });

  it('returns skipped with reason paid when the existing row is paid', async () => {
    const store = new InMemoryFondPayoutStore();
    await store.enqueue({
      id: 'existing',
      utcDay: '2026-11-09',
      kind: 'daily',
      address: ADDRESS,
      amountUsd: '2.00',
      comment: 'thanks',
      messageId: MESSAGE_ID,
      groupMessageId: null,
    });
    await store.claimForInvoice('existing', '2026-11-09');
    await store.setInvoiced('existing', {
      invoiceId: 'i',
      paymentHash: 'h',
      bolt11: 'b',
      amountMsat: 2_000_000,
    });
    await store.claimSettlement('existing');
    await store.markPaid('existing');
    const sink = new FondQueueSink({ store });
    expect(
      await sink.deliver(ADDRESS, { day: '2026-11-09', amountUsd: 2, comment: 'thanks' }),
    ).toEqual({ outcome: 'skipped', reason: 'paid' });
  });

  it('stores a numeric one-decimal amount and a string whole number exactly', async () => {
    const store = new InMemoryFondPayoutStore();
    const sink = new FondQueueSink({ store });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      amountUsd: 1.5,
      comment: 'thanks',
      day: '2026-11-09',
    });
    await sink.deliver(ADDRESS, {
      address: ADDRESS,
      amountUsd: '10',
      comment: 'thanks',
      day: '2026-11-10',
    });
    expect((await store.listOpen('2026-11-09'))[0]).toMatchObject({ amountUsd: '1.5' });
    expect((await store.listOpen('2026-11-10'))[0]).toMatchObject({ amountUsd: '10' });
  });

  it('returns failed when the store throws', async () => {
    const sink = new FondQueueSink({
      store: {
        enqueue: async () => {
          throw new Error('down');
        },
        listOpen: async () => [],
        depositAddress: async () => null,
        setDepositAddress: async () => false,
        get: async () => undefined,
        claimForInvoice: async () => null,
        setInvoiced: async () => undefined,
        claimStaleIssuing: async () => undefined,
        markStaleSettlingPaid: async () => undefined,
        restoreStaleSettling: async () => undefined,
        markFailed: async () => undefined,
        releaseClaim: async () => undefined,
        claimSettlement: async () => undefined,
        markPaid: async () => undefined,
        releaseSettlement: () => Promise.resolve(undefined),
        paidTotals: async () => ({ payoutsPaid: 0, payoutsPaidUsd: '0.00' }),
      },
    });
    expect(
      await sink.deliver(ADDRESS, { day: '2026-11-09', amountUsd: 1, comment: 'thanks' }),
    ).toEqual({ outcome: 'failed' });
  });
});
