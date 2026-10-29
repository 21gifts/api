import { describe, expect, it, vi } from 'vitest';
import {
  DailyRosterRequestError,
  normalizeDailyRosterComment,
  withPayoutAddresses,
  withRecipientIdentities,
  type DailyRosterAccount,
  type DailyRosterDocument,
} from '@/lib/daily-roster';
import { LNURL_SERVER, WALLET_PUBKEY } from '../helpers/wallet-lnurl';

const ADA = '11111111-1111-4111-8111-111111111111';
const BEA = '22222222-2222-4222-8222-222222222222';
const CID = '33333333-3333-4333-8333-333333333333';

const ROSTER: DailyRosterDocument = {
  comment: 'thanks',
  paymentsEnabled: true,
  moderatorPaymentsEnabled: false,
  defaultAmountUsd: 1,
  recipients: [
    { accountId: ADA, amountUsd: 2 },
    { accountId: BEA, amountUsd: 3 },
    { accountId: CID, amountUsd: 4 },
  ],
  moderators: [{ accountId: ADA, amountUsd: 5 }],
};

const ACCOUNTS: Record<string, DailyRosterAccount> = {
  [ADA]: { name: ' Ada ', username: ' Ada ', sparkPubkey: WALLET_PUBKEY, sparkPubkeyVerifiedAt: 1 },
  [BEA]: { name: '  ', username: 'bea', sparkPubkey: null, sparkPubkeyVerifiedAt: null },
  [CID]: { name: null, username: null, sparkPubkey: WALLET_PUBKEY, sparkPubkeyVerifiedAt: 1 },
};

async function lookup(id: string): Promise<DailyRosterAccount | undefined> {
  return ACCOUNTS[id];
}

describe('normalizeDailyRosterComment', () => {
  it('folds newlines, trims, and refuses length over 500', () => {
    expect(normalizeDailyRosterComment('  a\r\nb\nc\rd  ')).toBe('a b c d');
    expect(normalizeDailyRosterComment(' \n\r ')).toBe('');
    expect(normalizeDailyRosterComment('b'.repeat(500))).toBe('b'.repeat(500));
    expect(normalizeDailyRosterComment(` ${'a'.repeat(501)}\n`)).toBeUndefined();
  });
});

describe('DailyRosterRequestError', () => {
  it('exposes status and error without interpolating the message into a token', () => {
    const err = new DailyRosterRequestError(400, 'Invalid comment');
    expect(err.status).toBe(400);
    expect(err.error).toBe('Invalid comment');
    expect(err.name).toBe('DailyRosterRequestError');
  });
});

describe('withRecipientIdentities', () => {
  it('attaches the edit key, username, and name in stored order', async () => {
    expect(await withRecipientIdentities(ROSTER, lookup, LNURL_SERVER)).toEqual({
      comment: 'thanks',
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [
        {
          address: `ada@${LNURL_SERVER.host}`,
          amountUsd: 2,
          accountId: ADA,
          username: 'ada',
          name: 'Ada',
        },
        {
          address: `bea@${LNURL_SERVER.host}`,
          amountUsd: 3,
          accountId: BEA,
          username: 'bea',
          name: null,
        },
        { address: CID, amountUsd: 4, accountId: CID, username: null, name: null },
      ],
      moderatorPaymentsEnabled: false,
      moderators: [
        {
          address: `ada@${LNURL_SERVER.host}`,
          amountUsd: 5,
          accountId: ADA,
          username: 'ada',
          name: 'Ada',
        },
      ],
    });
  });

  it('uses the bare username without the LNURL server and the account id for a missing account', async () => {
    const doc = await withRecipientIdentities(
      {
        ...ROSTER,
        recipients: [{ accountId: BEA, amountUsd: 3 }],
        moderators: [{ accountId: '44444444-4444-4444-8444-444444444444', amountUsd: 1 }],
      },
      lookup,
      undefined,
    );
    expect(doc.recipients[0]?.address).toBe('bea');
    expect(doc.moderators[0]).toEqual({
      address: '44444444-4444-4444-8444-444444444444',
      amountUsd: 1,
      accountId: '44444444-4444-4444-8444-444444444444',
      username: null,
      name: null,
    });
  });

  it('does not call lookup when both lists are empty and propagates a lookup throw', async () => {
    const spy = vi.fn(lookup);
    await withRecipientIdentities({ ...ROSTER, recipients: [], moderators: [] }, spy, LNURL_SERVER);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      withRecipientIdentities(ROSTER, () => Promise.reject(new Error('db')), LNURL_SERVER),
    ).rejects.toThrow('db');
  });
});

describe('withPayoutAddresses', () => {
  it('resolves each payout address now and leaves it null without a verified wallet', async () => {
    expect(await withPayoutAddresses(ROSTER, lookup, LNURL_SERVER)).toEqual({
      comment: 'thanks',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 1,
      recipients: [
        { accountId: ADA, username: 'ada', address: `ada@${LNURL_SERVER.host}`, amountUsd: 2 },
        { accountId: BEA, username: 'bea', address: null, amountUsd: 3 },
        { accountId: CID, username: null, address: null, amountUsd: 4 },
      ],
      moderators: [
        { accountId: ADA, username: 'ada', address: `ada@${LNURL_SERVER.host}`, amountUsd: 5 },
      ],
    });
  });

  it('follows a later wallet verification', async () => {
    const accounts: Record<string, DailyRosterAccount> = {
      [BEA]: { name: 'Bea', username: 'bea', sparkPubkey: null, sparkPubkeyVerifiedAt: null },
    };
    const only = { ...ROSTER, recipients: [{ accountId: BEA, amountUsd: 3 }], moderators: [] };
    const read = (id: string): Promise<DailyRosterAccount | undefined> =>
      Promise.resolve(accounts[id]);
    expect((await withPayoutAddresses(only, read, LNURL_SERVER)).recipients[0]?.address).toBeNull();
    accounts[BEA] = {
      name: 'Bea',
      username: 'bea',
      sparkPubkey: WALLET_PUBKEY,
      sparkPubkeyVerifiedAt: 2,
    };
    expect((await withPayoutAddresses(only, read, LNURL_SERVER)).recipients[0]?.address).toBe(
      `bea@${LNURL_SERVER.host}`,
    );
  });

  it('gives no address for a missing account or with the LNURL server off', async () => {
    const off = await withPayoutAddresses(ROSTER, lookup, undefined);
    expect(off.recipients.map((row) => row.address)).toEqual([null, null, null]);
    const missing = await withPayoutAddresses(ROSTER, async () => undefined, LNURL_SERVER);
    expect(missing.moderators).toEqual([
      { accountId: ADA, username: null, address: null, amountUsd: 5 },
    ]);
  });
});
