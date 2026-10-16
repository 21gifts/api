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
  owedSats: 0,
  creditSats: 0,
  owedOverTime: [],
  creditOverTime: [],
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
    amountUsd?: string | null;
    amountChf?: string | null;
    amountEur?: string | null;
    amountPhp?: string | null;
    goalRepayable?: true;
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
    ...(overrides.goalRepayable === true ? { goalRepayable: true } : {}),
    parentId: overrides.parentId === undefined ? null : overrides.parentId,
    sats: overrides.sats ?? 0,
    ...(overrides.amountUsd !== undefined ? { amountUsd: overrides.amountUsd } : {}),
    ...(overrides.amountChf !== undefined ? { amountChf: overrides.amountChf } : {}),
    ...(overrides.amountEur !== undefined ? { amountEur: overrides.amountEur } : {}),
    ...(overrides.amountPhp !== undefined ? { amountPhp: overrides.amountPhp } : {}),
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
    expect(given).toEqual([
      {
        paidAt: PAID_AT,
        amountSats: 21,
        recipientWosUser: 'ada',
        kind: 'other',
        amountUsd: null,
        amountChf: null,
        amountEur: null,
        amountPhp: null,
      },
    ]);
  });

  it('uses the invoice amount when the ingest amountSats is null', () => {
    const given = matchConfirmedGivenZaps(
      [invoice({ lightningAddress: 'plainhandle' })],
      [ingest({ amountSats: null })],
    );
    expect(given).toEqual([
      {
        paidAt: PAID_AT,
        amountSats: 21,
        recipientWosUser: 'plainhandle',
        kind: 'other',
        amountUsd: null,
        amountChf: null,
        amountEur: null,
        amountPhp: null,
      },
    ]);
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
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada', kind: 'daily' },
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
      { paidAt: PAID_AT, amountSats: 500, recipientWosUser: 'bob', kind: 'daily' },
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

  it('keeps a remainder with no stored amount null when the day has no close', async () => {
    const messages = new InMemoryMessageStore([note({ sats: 21 })]);
    const stats = await activity({ messages, rates: new InMemoryBtcUsdStore() });
    expect(stats.receivedSats).toBe(21);
    expect(stats.receivedOverTime[0]?.usd).toBeNull();
  });

  it('uses the ingest snapshot and subtracts it from a larger note snapshot', async () => {
    const messages = new InMemoryMessageStore([
      note({
        sats: 42,
        amountUsd: '1.00',
        amountChf: '0.80',
        amountEur: '0.90',
        amountPhp: '50.00',
      }),
    ]);
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(
      ingest({ amountUsd: '0.40', amountChf: '0.30', amountEur: '0.40', amountPhp: '20.00' }),
    );
    const stats = await activity({ messages, rates: new InMemoryBtcUsdStore() });
    expect(stats.receivedSats).toBe(42);
    expect(stats.receivedOverTime[0]?.usd).toBe('1.00');
    expect(stats.receivedOverTime[0]?.chf).toBe('0.80');
    expect(stats.donatedOverTime[0]?.usd).toBe('0.40');
  });

  it('nulls a remainder currency that either side did not store', async () => {
    const messages = new InMemoryMessageStore([
      note({
        sats: 42,
        amountUsd: null,
        amountChf: '0.80',
        amountEur: null,
        amountPhp: '50.00',
      }),
    ]);
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(
      ingest({ amountUsd: '0.40', amountChf: null, amountEur: '0.40', amountPhp: null }),
    );
    const stats = await activity({ messages, rates: new InMemoryBtcUsdStore() });
    expect(stats.receivedOverTime[0]?.usd).toBeNull();
    expect(stats.receivedOverTime[0]?.chf).toBeNull();
    expect(stats.receivedOverTime[0]?.eur).toBeNull();
    expect(stats.receivedOverTime[0]?.php).toBeNull();
  });

  it('nulls a remainder when the note stores less than the ingest', async () => {
    const messages = new InMemoryMessageStore([
      note({
        sats: 42,
        amountUsd: '0.10',
        amountChf: '0.80',
        amountEur: '0.90',
        amountPhp: '50.00',
      }),
    ]);
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(
      ingest({ amountUsd: '0.40', amountChf: '0.30', amountEur: '0.40', amountPhp: '20.00' }),
    );
    const stats = await activity({ messages, rates: new InMemoryBtcUsdStore() });
    expect(stats.receivedOverTime[0]?.usd).toBeNull();
    expect(stats.receivedOverTime[0]?.chf).toBe('0.80');
  });

  it('converts CHF/EUR/PHP on received house gifts when a fiat book is seeded', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada', kind: 'daily' },
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
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada', kind: 'daily' },
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

  it('does not count a moderator stipend as received', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 1000, recipientWosUser: 'ada', kind: 'daily' },
      { paidAt: PAID_AT, amountSats: 2000, recipientWosUser: 'ada', kind: 'welcome' },
      { paidAt: PAID_AT, amountSats: 5000, recipientWosUser: 'ada', kind: 'moderator' },
    ]);
    const stats = await activity({ gifts });
    expect(stats.receivedSats).toBe(3000);
    expect(stats.donatedSats).toBe(0);
  });

  it('returns empty activity when the only gift is a moderator stipend', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 5000, recipientWosUser: 'ada', kind: 'moderator' },
    ]);
    await expect(activity({ gifts, rates: new InMemoryBtcUsdStore() })).resolves.toEqual(EMPTY);
  });

  it('counts only daily/welcome as donated for the platform account', async () => {
    const gifts = new InMemoryGiftStore([
      { paidAt: PAID_AT, amountSats: 500, recipientWosUser: 'bob', kind: 'daily' },
      { paidAt: PAID_AT, amountSats: 9000, recipientWosUser: 'bob', kind: 'moderator' },
    ]);
    const stats = await activity({ acc: account({ isPlatform: true }), gifts });
    expect(stats.donatedSats).toBe(500);
    expect(stats.receivedSats).toBe(0);
  });

  it('omits loan note ingests and remainder from received', async () => {
    const messages = new InMemoryMessageStore([
      note({ id: 'loan', goalRepayable: true, sats: 100 }),
      note({ id: 'normal', sats: 21 }),
    ]);
    await messages.recordZapIngest(
      ingest({
        id: 'zi-loan',
        receiptId: 'r-loan',
        messageId: 'loan',
        amountSats: 80,
      }),
    );
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(21);
  });

  it('omits a hidden loan remainder from received', async () => {
    const messages = new InMemoryMessageStore([
      note({
        goalRepayable: true,
        deletedAt: new Date('2026-06-02T00:00:00.000Z'),
        sats: 30,
      }),
    ]);
    const stats = await activity({ messages });
    expect(stats.receivedSats).toBe(0);
  });

  it('does not count a loan invoice as donated', async () => {
    const loanHash = 'bb'.repeat(32);
    vi.spyOn(bolt11, 'decodeBolt11').mockImplementation((pr: string) => {
      if (pr === 'lnbc-good') {
        return { paymentHash: HASH, amountMsat: 21_000 };
      }
      if (pr === 'lnbc-loan') {
        return { paymentHash: loanHash, amountMsat: 50_000 };
      }
      return null;
    });
    const messages = new InMemoryMessageStore([
      note({ id: 'loan', accountId: 'author', goalRepayable: true }),
      note({ id: 'm1', accountId: 'author' }),
    ]);
    await messages.recordInvoiceAttempt(
      invoice({
        id: 'inv-loan',
        messageId: 'loan',
        amountSats: 50,
        paymentHash: loanHash,
        pr: 'lnbc-loan',
      }),
    );
    await messages.recordInvoiceAttempt(invoice());
    await messages.recordZapIngest(
      ingest({
        id: 'zi-loan',
        receiptId: 'r-loan',
        messageId: 'loan',
        amountSats: 50,
        receipt: { tags: [['bolt11', 'lnbc-loan']] },
      }),
    );
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(21);
    expect(stats.receivedSats).toBe(0);
  });

  it('does not count a repayment invoice as donated', async () => {
    const messages = new InMemoryMessageStore([note({ id: 'm1', accountId: 'author' })]);
    await messages.recordInvoiceAttempt(
      invoice({
        description: 'repay:0:11111111-1111-1111-1111-111111111111',
      }),
    );
    await messages.recordZapIngest(ingest());
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(0);
  });

  it('keeps an invoice whose note is missing as a donation', async () => {
    const messages = new InMemoryMessageStore();
    await messages.recordInvoiceAttempt(invoice({ messageId: 'missing' }));
    await messages.recordZapIngest(ingest({ messageId: 'missing' }));
    const stats = await activity({ messages });
    expect(stats.donatedSats).toBe(21);
  });

  it('credits an identified grant to the payer without counting it as a donation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      const stats = await activity({ messages });
      expect(stats.creditSats).toBe(100);
      expect(stats.owedSats).toBe(0);
      expect(stats.donatedSats).toBe(0);
      expect(stats.receivedSats).toBe(0);
      expect(stats.owedOverTime).toEqual([]);
      expect(stats.creditOverTime).toHaveLength(1);
      expect(stats.creditOverTime[0]).toMatchObject({
        day: DAY,
        giftCount: 1,
        officialCount: 0,
        sats: 100,
        cumulativeSats: 100,
        btc: '0.00000100',
        cumulativeBtc: '0.00000100',
        usd: '0.10',
        cumulativeUsd: '0.10',
        chf: null,
        cumulativeChf: null,
        eur: null,
        cumulativeEur: null,
        php: null,
        cumulativePhp: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prices loan-only fiat crosses and keeps donation totals at zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      const stats = await activity({
        messages,
        fiatRates: new InMemoryFiatStore({
          [DAY]: { CHF: '0.80', EUR: '0.90', PHP: '50' },
        }),
      });
      expect(stats.donatedSats).toBe(0);
      expect(stats.receivedSats).toBe(0);
      expect(stats.creditSats).toBe(100);
      expect(stats.creditOverTime[0]).toMatchObject({
        cumulativeChf: '0.08',
        cumulativeEur: '0.09',
        cumulativePhp: '5.00',
        chf: '0.08',
        eur: '0.09',
        php: '5.00',
      });
      expect(stats.fx.quotes).toEqual([
        { code: 'USD', pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' },
        { code: 'CHF', pair: 'USD-CHF', source: 'frankfurter-ecb' },
        { code: 'EUR', pair: 'USD-EUR', source: 'frankfurter-ecb' },
        { code: 'PHP', pair: 'USD-PHP', source: 'frankfurter-ecb' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('owes the author the same grant the payer is credited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'acc',
        name: 'Ada',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'payer' });
      const stats = await activity({ messages });
      expect(stats.owedSats).toBe(100);
      expect(stats.creditSats).toBe(0);
      expect(stats.creditOverTime).toEqual([]);
      expect(stats.owedOverTime).toHaveLength(1);
      expect(stats.owedOverTime[0]?.cumulativeSats).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lowers both balances after a repayment and prices the outstanding balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      await messages.markRepaymentPaid({
        messageId: 'loan',
        dayIndex: 0,
        recipientAccountId: 'acc',
        dueSats: 40,
        paidAt: new Date('2026-06-02T15:00:00.000Z'),
      });
      const rates = new InMemoryBtcUsdStore({
        [DAY]: '100000',
        '2026-06-02': '100000',
      });
      const payer = await activity({ messages, rates });
      expect(payer.creditSats).toBe(60);
      expect(payer.owedSats).toBe(0);
      expect(payer.donatedSats).toBe(0);
      expect(payer.receivedSats).toBe(0);
      expect(payer.creditOverTime).toHaveLength(2);
      expect(payer.creditOverTime[0]?.cumulativeSats).toBe(100);
      expect(payer.creditOverTime[1]).toMatchObject({
        day: '2026-06-02',
        sats: -40,
        cumulativeSats: 60,
        btc: '-0.00000040',
        cumulativeBtc: '0.00000060',
        usd: '0.06',
        cumulativeUsd: '0.06',
      });
      const author = await activity({
        acc: account({ id: 'author', lightningAddress: 'bob@walletofsatoshi.com' }),
        messages,
        rates,
      });
      expect(author.owedSats).toBe(60);
      expect(author.creditSats).toBe(0);
      expect(author.owedOverTime[1]).toMatchObject({
        sats: -40,
        cumulativeSats: 60,
        btc: '-0.00000040',
        cumulativeBtc: '0.00000060',
        usd: '0.06',
        cumulativeUsd: '0.06',
      });
      expect(author.donatedSats).toBe(0);
      expect(author.receivedSats).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a grant receipt that arrives after the credit freeze', async () => {
    vi.useFakeTimers();
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
        goalFundedAt: null,
      });
      vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
      await messages.recordZapReceipt('r1', 'loan', 100, null);
      await messages.updateZapReceiptGift('r1', { payerAccountId: 'acc' });
      vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'));
      await messages.recordZapReceipt('r2', 'loan', 50, null);
      await messages.updateZapReceiptGift('r2', { payerAccountId: 'acc' });
      const stats = await activity({
        messages,
        rates: new InMemoryBtcUsdStore({ [DAY]: '100000' }),
      });
      expect(stats.creditSats).toBe(100);
      expect(stats.owedSats).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an anonymous grant receipt for payer and author', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'acc',
        name: 'Ada',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-anon', 'loan', 100, null);
      const author = await activity({ messages });
      expect(author.owedSats).toBe(0);
      expect(author.creditSats).toBe(0);
      expect(author.owedOverTime).toEqual([]);
      expect(author.creditOverTime).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves both owed and credit when payer and author are the same account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'acc',
        name: 'Ada',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-self', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-self', { payerAccountId: 'acc' });
      const stats = await activity({ messages });
      expect(stats.owedSats).toBe(100);
      expect(stats.creditSats).toBe(100);
      expect(stats.owedOverTime).toHaveLength(1);
      expect(stats.creditOverTime).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges two same-timestamp grants into one credit day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 1000,
      });
      await messages.recordZapReceipt('r-grant-a', 'loan', 50, null);
      await messages.updateZapReceiptGift('r-grant-a', { payerAccountId: 'acc' });
      await messages.recordZapReceipt('r-grant-b', 'loan', 50, null);
      await messages.updateZapReceiptGift('r-grant-b', { payerAccountId: 'acc' });
      const stats = await activity({ messages });
      expect(stats.donatedSats).toBe(0);
      expect(stats.creditSats).toBe(100);
      expect(stats.creditOverTime).toHaveLength(1);
      expect(stats.creditOverTime[0]).toMatchObject({
        day: DAY,
        giftCount: 2,
        sats: 100,
        cumulativeSats: 100,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('nets a same-timestamp grant and repayment into one credit day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      await messages.markRepaymentPaid({
        messageId: 'loan',
        dayIndex: 0,
        recipientAccountId: 'acc',
        dueSats: 40,
        paidAt: new Date('2026-06-01T12:00:00.000Z'),
      });
      const stats = await activity({ messages });
      expect(stats.creditSats).toBe(60);
      expect(stats.creditOverTime).toHaveLength(1);
      expect(stats.creditOverTime[0]).toMatchObject({
        day: DAY,
        giftCount: 2,
        sats: 60,
        cumulativeSats: 60,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws fx.rate.missing from buildLoanSide when a loan day has no BTC-USD', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      await expect(activity({ messages, rates: new InMemoryBtcUsdStore({}) })).rejects.toThrow(
        'fx.rate.missing',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a negative outstanding balance after an over-repayment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    try {
      const messages = new InMemoryMessageStore();
      await messages.create({
        id: 'loan',
        accountId: 'author',
        name: 'Bob',
        text: 'loan',
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalRepayable: true,
        goalSats: 100,
      });
      await messages.recordZapReceipt('r-grant', 'loan', 100, null);
      await messages.updateZapReceiptGift('r-grant', { payerAccountId: 'acc' });
      await messages.markRepaymentPaid({
        messageId: 'loan',
        dayIndex: 0,
        recipientAccountId: 'acc',
        dueSats: 160,
        paidAt: new Date('2026-06-02T15:00:00.000Z'),
      });
      const rates = new InMemoryBtcUsdStore({
        [DAY]: '100000',
        '2026-06-02': '100000',
      });
      const fiatRates = new InMemoryFiatStore({
        [DAY]: { CHF: '0.80', EUR: '0.90', PHP: '50' },
        '2026-06-02': { CHF: '0.80', EUR: '0.90', PHP: '50' },
      });
      const payer = await activity({ messages, rates, fiatRates });
      expect(payer.creditSats).toBe(-60);
      expect(payer.donatedSats).toBe(0);
      expect(payer.receivedSats).toBe(0);
      expect(payer.creditOverTime).toHaveLength(2);
      expect(payer.creditOverTime[1]).toMatchObject({
        day: '2026-06-02',
        sats: -160,
        cumulativeSats: -60,
        btc: '-0.00000160',
        cumulativeBtc: '-0.00000060',
        usd: '-0.06',
        cumulativeUsd: '-0.06',
        chf: '-0.05',
        cumulativeChf: '-0.05',
        eur: '-0.05',
        cumulativeEur: '-0.05',
        php: '-3.00',
        cumulativePhp: '-3.00',
      });
      const author = await activity({
        acc: account({ id: 'author', lightningAddress: 'bob@walletofsatoshi.com' }),
        messages,
        rates,
        fiatRates,
      });
      expect(author.owedSats).toBe(-60);
      expect(author.donatedSats).toBe(0);
      expect(author.receivedSats).toBe(0);
      expect(author.owedOverTime[1]).toMatchObject({
        day: '2026-06-02',
        sats: -160,
        cumulativeSats: -60,
        btc: '-0.00000160',
        cumulativeBtc: '-0.00000060',
        usd: '-0.06',
        cumulativeUsd: '-0.06',
        chf: '-0.05',
        cumulativeChf: '-0.05',
        eur: '-0.05',
        cumulativeEur: '-0.05',
        php: '-3.00',
        cumulativePhp: '-3.00',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
