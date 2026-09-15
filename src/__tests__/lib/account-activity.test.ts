import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAccountActivity,
  matchConfirmedGivenZaps,
  paymentHashFromReceipt,
} from '@/lib/account-activity';
import type { Account } from '@/lib/auth/store';
import * as bolt11 from '@/lib/bolt11';
import { InMemoryBtcUsdStore } from '@/lib/btc-usd-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { unsignedNostrDefaults } from '@/lib/message';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';

const HASH = 'aa'.repeat(32);
const DAY = '2026-06-01';
const PAID_AT = new Date(`${DAY}T12:00:00.000Z`);
const RATES = new InMemoryBtcUsdStore({ [DAY]: '100000' });
const FX = {
  quote: 'BTC-USD',
  dayBasis: 'utc',
  source: 'coinbase-exchange-daily-close',
  quotes: [{ code: 'USD' as const, pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' }],
};
const EMPTY = {
  donatedSats: 0,
  receivedSats: 0,
  donatedOverTime: [],
  receivedOverTime: [],
  fx: FX,
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    location: null,
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...overrides,
  };
}

function invoice(overrides: Partial<MessageInvoiceAttempt> = {}): MessageInvoiceAttempt {
  return {
    id: 'inv-1',
    createdAt: PAID_AT,
    messageId: 'm1',
    payerAccountId: 'acc',
    authorAccountId: 'author',
    amountSats: 21,
    lightningAddress: 'ada@walletofsatoshi.com',
    zapRequest: { kind: 9734 },
    result: 'ok',
    httpStatus: 200,
    pr: 'lnbc-good',
    paymentHash: HASH,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    ...overrides,
  };
}

function ingest(overrides: Partial<ZapIngestRow> = {}): ZapIngestRow {
  return {
    id: 'zi-1',
    createdAt: PAID_AT,
    receiptId: 'r1',
    noteEventId: 'ee'.repeat(32),
    messageId: 'm1',
    outcome: 'indexed',
    reason: null,
    amountSats: 21,
    receiptPubkey: 'aa'.repeat(32),
    receipt: { tags: [['bolt11', 'lnbc-good']] },
    ...overrides,
  };
}

function note(
  overrides: {
    id?: string;
    accountId?: string;
    sats?: number;
    deletedAt?: Date | null;
    createdAt?: Date;
    text?: string;
    parentId?: string | null;
  } = {},
): {
  id: string;
  accountId: string;
  name: string;
  text: string;
  createdAt: Date;
  hasPhoto: boolean;
} & ReturnType<typeof unsignedNostrDefaults> {
  return {
    id: overrides.id ?? 'm1',
    accountId: overrides.accountId ?? 'acc',
    name: 'Ada',
    text: overrides.text ?? 'hi',
    createdAt: overrides.createdAt ?? PAID_AT,
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    parentId: overrides.parentId === undefined ? null : overrides.parentId,
    sats: overrides.sats ?? 0,
    deletedAt: overrides.deletedAt === undefined ? null : overrides.deletedAt,
  };
}

async function activity(args: {
  acc?: Account;
  gifts?: InMemoryGiftStore;
  messages?: InMemoryMessageStore;
  rates?: InMemoryBtcUsdStore;
  fiatRates?: FiatRateBook;
}): Promise<Awaited<ReturnType<typeof buildAccountActivity>>> {
  return buildAccountActivity({
    account: args.acc ?? account(),
    gifts: args.gifts ?? new InMemoryGiftStore(),
    messages: args.messages ?? new InMemoryMessageStore(),
    rates: args.rates ?? RATES,
    now: () => PAID_AT.getTime(),
    ...(args.fiatRates === undefined ? {} : { fiatRates: args.fiatRates }),
  });
}

describe('paymentHashFromReceipt', () => {
  beforeEach(() => {
    vi.spyOn(bolt11, 'decodeBolt11').mockImplementation((pr: string) =>
      pr === 'lnbc-good' ? { paymentHash: HASH, amountMsat: 21_000 } : null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the hash from a bolt11 tag', () => {
    expect(paymentHashFromReceipt({ tags: [['bolt11', 'lnbc-good']] })).toBe(HASH);
  });

  it('returns null when tags are missing or not a string matrix', () => {
    expect(paymentHashFromReceipt({})).toBeNull();
    expect(paymentHashFromReceipt({ tags: 'nope' })).toBeNull();
    expect(paymentHashFromReceipt({ tags: [1] })).toBeNull();
    expect(paymentHashFromReceipt({ tags: [['bolt11', 1]] })).toBeNull();
  });

  it('returns null when bolt11 does not decode', () => {
    expect(paymentHashFromReceipt({ tags: [['bolt11', 'lnbc-bad']] })).toBeNull();
  });
});

describe('matchConfirmedGivenZaps', () => {
  beforeEach(() => {
    vi.spyOn(bolt11, 'decodeBolt11').mockImplementation((pr: string) =>
      pr === 'lnbc-good' ? { paymentHash: HASH, amountMsat: 21_000 } : null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins an ok invoice to an indexed ingest by payment hash', () => {
    const given = matchConfirmedGivenZaps([invoice()], [ingest()]);
    expect(given).toEqual([{ paidAt: PAID_AT, amountSats: 21, recipientWosUser: 'ada' }]);
  });

  it('uses the invoice amount when the ingest amountSats is null', () => {
    const given = matchConfirmedGivenZaps(
      [invoice({ lightningAddress: 'plainhandle' })],
      [ingest({ amountSats: null })],
    );
    expect(given).toEqual([{ paidAt: PAID_AT, amountSats: 21, recipientWosUser: 'plainhandle' }]);
  });

  it('decodes pr when paymentHash is not 64 hex', () => {
    const given = matchConfirmedGivenZaps(
      [invoice({ paymentHash: 'nope', pr: 'lnbc-good' })],
      [ingest()],
    );
    expect(given).toHaveLength(1);
  });

  it('returns no given row when paymentHash and pr both fail to decode', () => {
    expect(
      matchConfirmedGivenZaps(
        [invoice({ paymentHash: 'nope', pr: null, messageId: 'other', amountSats: 9 })],
        [ingest()],
      ),
    ).toEqual([]);
  });

  it('falls back to a unique (messageId, amountSats) pair when the invoice has no hash', () => {
    const given = matchConfirmedGivenZaps(
      [invoice({ paymentHash: null, pr: 'lnbc-bad' })],
      [ingest({ receipt: { tags: [['e', 'note']] } })],
    );
    expect(given).toHaveLength(1);
    expect(given[0]?.amountSats).toBe(21);
  });

  it('does not fall back to messageId+amount when the invoice has a payment hash', () => {
    const otherHash = 'bb'.repeat(32);
    const given = matchConfirmedGivenZaps(
      [invoice({ paymentHash: otherHash, pr: null })],
      [ingest({ receipt: { tags: [] } })],
    );
    expect(given).toEqual([]);
  });

  it('skips an ambiguous (messageId, amountSats) fallback when two ingests match', () => {
    const given = matchConfirmedGivenZaps(
      [invoice({ paymentHash: null, pr: 'lnbc-bad' })],
      [
        ingest({ id: 'zi-1', receiptId: 'r1', receipt: { tags: [] } }),
        ingest({ id: 'zi-2', receiptId: 'r2', receipt: { tags: [] } }),
      ],
    );
    expect(given).toEqual([]);
  });

  it('does not emit the same ingest twice', () => {
    const given = matchConfirmedGivenZaps(
      [invoice(), invoice({ id: 'inv-2', paymentHash: null, pr: 'lnbc-bad' })],
      [ingest()],
    );
    expect(given).toHaveLength(1);
  });

  it('skips invoices whose result is not ok', () => {
    expect(matchConfirmedGivenZaps([invoice({ result: 'noZap' })], [ingest()])).toEqual([]);
  });

  it('skips unmatched ok invoices', () => {
    expect(matchConfirmedGivenZaps([invoice()], [])).toEqual([]);
    expect(
      matchConfirmedGivenZaps(
        [invoice({ messageId: 'other', amountSats: 7, paymentHash: null, pr: 'lnbc-bad' })],
        [ingest({ receipt: { tags: [] } })],
      ),
    ).toEqual([]);
  });
});

describe('buildAccountActivity', () => {
  beforeEach(() => {
    vi.spyOn(bolt11, 'decodeBolt11').mockImplementation((pr: string) =>
      pr === 'lnbc-good' ? { paymentHash: HASH, amountMsat: 21_000 } : null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zeros and fx without rates when there is nothing to aggregate', async () => {
    await expect(activity({ rates: new InMemoryBtcUsdStore() })).resolves.toEqual(EMPTY);
  });

  it('counts house gifts received by the account handle', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada' },
    ]);
    const stats = await activity({ gifts });
    expect(stats.receivedSats).toBe(1000);
    expect(stats.donatedSats).toBe(0);
    expect(stats.receivedOverTime).not.toEqual([]);
    expect(stats.fx).toEqual(FX);
  });

  it('counts confirmed given zaps and does not credit another author as received', async () => {
    const messages = new InMemoryMessageStore([note({ accountId: 'other' })]);
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(21);
    expect(stats.receivedSats).toBe(0);
  });

  it('includes house outbound as donated only for the platform account', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 500, recipientWosUser: 'bob' },
    ]);
    const platform = await activity({ acc: account({ isPlatform: true }), gifts });
    expect(platform.donatedSats).toBe(500);
    const member = await activity({ gifts });
    expect(member.donatedSats).toBe(0);
  });

  it('counts an indexed ingest on a hidden authored note as received', async () => {
    const messages = new InMemoryMessageStore([
      note({ deletedAt: new Date('2026-06-02T00:00:00.000Z') }),
    ]);
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(21);
    expect(stats.receivedOverTime).not.toEqual([]);
  });

  it('credits message.sats remainder 21 when there is no ingest', async () => {
    const messages = new InMemoryMessageStore([note({ sats: 21 })]);
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(21);
    expect(stats.receivedOverTime).not.toEqual([]);
  });

  it('skips duplicate receipt ids and ingests without a messageId', async () => {
    const messages = new InMemoryMessageStore([note()]);
    await messages.recordZapIngest(ingest());
    await messages.recordZapIngest(
      ingest({ id: 'zi-dup', createdAt: new Date('2026-06-02T00:00:00.000Z') }),
    );
    await messages.recordZapIngest(
      ingest({ id: 'zi-none', receiptId: 'r-none', messageId: null, amountSats: 50 }),
    );
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(21);
  });

  it('skips indexed ingests with null or non-positive amountSats', async () => {
    const messages = new InMemoryMessageStore([note()]);
    await messages.recordZapIngest(
      ingest({ id: 'zi-null', receiptId: 'r-null', amountSats: null }),
    );
    await messages.recordZapIngest(ingest({ id: 'zi-zero', receiptId: 'r-zero', amountSats: 0 }));
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(0);
  });

  it('treats a blank Lightning Address as the zap handle', async () => {
    const messages = new InMemoryMessageStore([note({ sats: 21 })]);
    const stats = await activity({ acc: account({ lightningAddress: '   ' }), messages });
    expect(stats.receivedSats).toBe(21);
  });

  it('does not double-count a 21-sats ingest that already equals message.sats', async () => {
    const messages = new InMemoryMessageStore([note({ sats: 21 })]);
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(21);
  });

  it('does not count a gift-as-reply remainder as received for the payer', async () => {
    const messages = new InMemoryMessageStore([
      note({ accountId: 'author', sats: 21 }),
      note({ id: 'gift-reply', accountId: 'acc', parentId: 'm1', sats: 21, text: '⚡ 21' }),
    ]);
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(21);
    expect(stats.receivedSats).toBe(0);
  });

  it('counts a self-zap on both donated and received', async () => {
    const messages = new InMemoryMessageStore([note()]);
    await messages.recordInvoiceAttempt(invoice({ authorAccountId: 'acc' }));
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(21);
    expect(stats.receivedSats).toBe(21);
  });

  it('throws fx.rate.missing when a remainder day has no rate', async () => {
    const messages = new InMemoryMessageStore([note({ sats: 21 })]);
    await expect(activity({ messages, rates: new InMemoryBtcUsdStore() })).rejects.toThrow(
      'fx.rate.missing',
    );
  });

  it('converts CHF/EUR/PHP on received house gifts when a fiat book is seeded', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada' },
    ]);
    const stats = await activity({
      gifts,
      fiatRates: new InMemoryFiatStore({ [DAY]: { CHF: '0.80', EUR: '0.90', PHP: '50' } }),
    });
    expect(stats.receivedSats).toBe(1000);
    expect(stats.receivedOverTime[0]?.cumulativeUsd).toBe('1.00');
    expect(stats.receivedOverTime[0]?.cumulativeChf).toBe('0.80');
    expect(stats.receivedOverTime[0]?.cumulativeEur).toBe('0.90');
    expect(stats.receivedOverTime[0]?.cumulativePhp).toBe('50.00');
    expect(stats.fx.quotes).toEqual([
      { code: 'USD', pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' },
      { code: 'CHF', pair: 'USD-CHF', source: 'frankfurter-ecb' },
      { code: 'EUR', pair: 'USD-EUR', source: 'frankfurter-ecb' },
      { code: 'PHP', pair: 'USD-PHP', source: 'frankfurter-ecb' },
    ]);
  });

  it('omits fiat ensureDays when activity is empty', async () => {
    const ensureDays = vi.fn(async () => new Map());
    await expect(activity({ fiatRates: { ensureDays } })).resolves.toEqual(EMPTY);
    expect(ensureDays).not.toHaveBeenCalled();
  });

  it('logs account.activity.fiat_failed and still returns USD when fiat throws', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const stats = await activity({
        gifts,
        fiatRates: {
          ensureDays: async () => {
            throw new Error('frankfurter down');
          },
        },
      });
      expect(stats.receivedSats).toBe(1000);
      expect(stats.receivedOverTime[0]?.cumulativeUsd).toBe('1.00');
      expect(stats.receivedOverTime[0]?.cumulativeChf).toBeNull();
      expect(stats.receivedOverTime[0]?.cumulativeEur).toBeNull();
      expect(stats.receivedOverTime[0]?.cumulativePhp).toBeNull();
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(events.some((e) => e['event'] === 'account.activity.fiat_failed')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
