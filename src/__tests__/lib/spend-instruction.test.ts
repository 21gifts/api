import { describe, expect, it } from 'vitest';
import { decideSpendInstruction } from '@/lib/spend-instruction';

const ADDRESS = 'ada@walletofsatoshi.com';

describe('decideSpendInstruction', () => {
  describe('daily', () => {
    it('returns payments_disabled when paymentsEnabled is false', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: false,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ skip: 'payments_disabled' });
    });

    it('returns the row amountUsd and roster comment when listed', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2.5 }],
          },
        }),
      ).toEqual({ amountUsd: 2.5, comment: 'thanks' });
    });

    it('returns welcome_paid when welcomePaidOnUtcDay is true even if a listed row or grant would pay', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2.5 }],
          },
        }),
      ).toEqual({ skip: 'welcome_paid' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      ).toEqual({ skip: 'welcome_paid' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'trial',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      ).toEqual({ skip: 'welcome_paid' });
    });

    it('returns payments_disabled when paymentsEnabled is false even if welcomePaidOnUtcDay is true', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            paymentsEnabled: false,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ skip: 'payments_disabled' });
    });

    it('returns the listed amountUsd and roster comment when welcomePaidOnUtcDay is omitted', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2.5 }],
          },
        }),
      ).toEqual({ amountUsd: 2.5, comment: 'thanks' });
    });

    it('matches the listed address case-insensitively', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: 'Ada@WalletOfSatoshi.com', amountUsd: 4 }],
          },
        }),
      ).toEqual({ amountUsd: 4, comment: 'thanks' });
    });

    it('uses the first countable match when several rows match', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [
              { address: ADDRESS, amountUsd: 2 },
              { address: ADDRESS, amountUsd: 9 },
            ],
          },
        }),
      ).toEqual({ amountUsd: 2, comment: 'thanks' });
    });

    it('skips uncountable rows and then uses the first countable match', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [
              { address: ADDRESS, amountUsd: 0 },
              { address: ADDRESS, amountUsd: -1 },
              { address: ADDRESS, amountUsd: Number.NaN },
              { address: ADDRESS, amountUsd: Number.POSITIVE_INFINITY },
              { address: ADDRESS, amountUsd: '2' },
              { address: 1, amountUsd: 3 },
              null,
              [{ address: ADDRESS, amountUsd: 8 }],
              { address: ADDRESS, amountUsd: 5 },
              { address: ADDRESS, amountUsd: 9 },
            ],
          },
        }),
      ).toEqual({ amountUsd: 5, comment: 'thanks' });
    });

    it('returns undecided when the address is not listed', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [{ address: 'other@example.com', amountUsd: 2 }],
          },
        }),
      ).toEqual({ skip: 'undecided' });
    });

    it('does not trim the address when matching', () => {
      expect(
        decideSpendInstruction({
          address: ` ${ADDRESS}`,
          kind: 'daily',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ skip: 'undecided' });
    });

    it('treats missing paymentsEnabled as enabled', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: { comment: 'thanks', recipients: [{ address: ADDRESS, amountUsd: 2 }] },
        }),
      ).toEqual({ amountUsd: 2, comment: 'thanks' });
    });

    it('treats missing or non-array recipients as no daily rows', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: { comment: 'thanks', paymentsEnabled: true },
        }),
      ).toEqual({ skip: 'undecided' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: { comment: 'thanks', paymentsEnabled: true, recipients: { address: ADDRESS } },
        }),
      ).toEqual({ skip: 'undecided' });
    });

    it('uses an empty comment when comment is missing or not a string', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: { paymentsEnabled: true, recipients: [{ address: ADDRESS, amountUsd: 2 }] },
        }),
      ).toEqual({ amountUsd: 2, comment: '' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: 12,
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ amountUsd: 2, comment: '' });
    });

    it('allows an empty roster comment', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          roster: {
            comment: '',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ amountUsd: 2, comment: '' });
    });

    it('returns undecided for a non-object roster', () => {
      expect(decideSpendInstruction({ address: ADDRESS, kind: 'daily', roster: null })).toEqual({
        skip: 'undecided',
      });
      expect(decideSpendInstruction({ address: ADDRESS, kind: 'daily', roster: [] })).toEqual({
        skip: 'undecided',
      });
    });

    it('pays 1 USD and an empty comment for an unlisted admitted grant when the roster is not an object', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: null,
        }),
      ).toEqual({ amountUsd: 1, comment: '' });
    });

    it('returns payments_disabled before an unlisted admitted grant', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: {
            comment: 'thanks',
            paymentsEnabled: false,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      ).toEqual({ skip: 'payments_disabled' });
    });

    it('returns the listed amount when grantStatus is rejected', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'rejected',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            recipients: [{ address: ADDRESS, amountUsd: 2 }],
          },
        }),
      ).toEqual({ amountUsd: 2, comment: 'thanks' });
    });

    it('returns defaultAmountUsd and the roster comment when unlisted and admitted', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [{ address: 'other@example.com', amountUsd: 2 }],
          },
        }),
      ).toEqual({ amountUsd: 9, comment: 'thanks' });
    });

    it('returns 1 when unlisted admitted defaultAmountUsd is missing, non-positive, or not a number', () => {
      const base = { comment: 'thanks', paymentsEnabled: true, recipients: [] };
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: base,
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { ...base, defaultAmountUsd: 0 },
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { ...base, defaultAmountUsd: -1 },
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { ...base, defaultAmountUsd: Number.NaN },
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { ...base, defaultAmountUsd: Number.POSITIVE_INFINITY },
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { ...base, defaultAmountUsd: '9' },
        }),
      ).toEqual({ amountUsd: 1, comment: 'thanks' });
    });

    it('returns defaultAmountUsd when unlisted and trial', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'trial',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      ).toEqual({ amountUsd: 9, comment: 'thanks' });
    });

    it('returns not_listed when unlisted and grantStatus is none, pending, or rejected', () => {
      const roster = {
        comment: 'thanks',
        paymentsEnabled: true,
        defaultAmountUsd: 9,
        recipients: [],
      };
      expect(
        decideSpendInstruction({ address: ADDRESS, kind: 'daily', grantStatus: 'none', roster }),
      ).toEqual({ skip: 'not_listed' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'pending',
          roster,
        }),
      ).toEqual({ skip: 'not_listed' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'rejected',
          roster,
        }),
      ).toEqual({ skip: 'not_listed' });
    });

    it('uses an empty comment when unlisted admitted comment is missing or not a string', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: { paymentsEnabled: true, defaultAmountUsd: 9, recipients: [] },
        }),
      ).toEqual({ amountUsd: 9, comment: '' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'daily',
          grantStatus: 'admitted',
          roster: {
            comment: 12,
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [],
          },
        }),
      ).toEqual({ amountUsd: 9, comment: '' });
    });
  });

  describe('welcome', () => {
    it('returns payments_disabled when paymentsEnabled is false', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'welcome',
          roster: {
            comment: 'thanks',
            paymentsEnabled: false,
            defaultAmountUsd: 9,
            recipients: [{ address: ADDRESS, amountUsd: 4 }],
          },
        }),
      ).toEqual({ skip: 'payments_disabled' });
    });

    it('returns amountUsd 1 and comment Welcome when payments are enabled', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'welcome',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [{ address: ADDRESS, amountUsd: 4 }],
          },
        }),
      ).toEqual({ amountUsd: 1, comment: 'Welcome' });
    });

    it('returns amountUsd 1 and comment Welcome when welcomePaidOnUtcDay is true', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'welcome',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [{ address: ADDRESS, amountUsd: 4 }],
          },
        }),
      ).toEqual({ amountUsd: 1, comment: 'Welcome' });
    });

    it('treats missing paymentsEnabled as enabled', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'welcome',
          roster: { comment: 'thanks' },
        }),
      ).toEqual({ amountUsd: 1, comment: 'Welcome' });
    });

    it('ignores grantStatus and still returns Welcome', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'welcome',
          grantStatus: 'rejected',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            defaultAmountUsd: 9,
            recipients: [{ address: ADDRESS, amountUsd: 4 }],
          },
        }),
      ).toEqual({ amountUsd: 1, comment: 'Welcome' });
    });
  });

  describe('moderator', () => {
    it('returns undecided when the moderators field is absent even if the switch is off', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            paymentsEnabled: false,
            moderatorPaymentsEnabled: false,
            recipients: [],
          },
        }),
      ).toEqual({ skip: 'undecided' });
    });

    it('returns undecided when the moderators field is absent even if grantStatus is present', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          grantStatus: 'admitted',
          roster: {
            comment: 'thanks',
            paymentsEnabled: true,
            moderatorPaymentsEnabled: true,
            recipients: [],
          },
        }),
      ).toEqual({ skip: 'undecided' });
    });

    it('returns payments_disabled when moderators is present and the switch is false', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            moderatorPaymentsEnabled: false,
            moderators: [{ address: ADDRESS, amountUsd: 3 }],
          },
        }),
      ).toEqual({ skip: 'payments_disabled' });
    });

    it('returns not_listed when moderators is present and the address is absent', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            moderatorPaymentsEnabled: true,
            moderators: [{ address: 'other@example.com', amountUsd: 3 }],
          },
        }),
      ).toEqual({ skip: 'not_listed' });
    });

    it('returns the row amountUsd and comment 21gifts moderator when listed', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            moderatorPaymentsEnabled: true,
            moderators: [{ address: ADDRESS, amountUsd: 3 }],
          },
        }),
      ).toEqual({ amountUsd: 3, comment: '21gifts moderator' });
    });

    it('returns the listed moderator amount when welcomePaidOnUtcDay is true', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          welcomePaidOnUtcDay: true,
          roster: {
            comment: 'thanks',
            moderatorPaymentsEnabled: true,
            moderators: [{ address: ADDRESS, amountUsd: 3 }],
          },
        }),
      ).toEqual({ amountUsd: 3, comment: '21gifts moderator' });
    });

    it('matches the listed moderator address case-insensitively', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            moderators: [{ address: 'ADA@walletofsatoshi.com', amountUsd: 7 }],
          },
        }),
      ).toEqual({ amountUsd: 7, comment: '21gifts moderator' });
    });

    it('uses the first countable moderator match', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: {
            comment: 'thanks',
            moderators: [
              { address: ADDRESS, amountUsd: 0 },
              { address: ADDRESS, amountUsd: 3 },
              { address: ADDRESS, amountUsd: 8 },
            ],
          },
        }),
      ).toEqual({ amountUsd: 3, comment: '21gifts moderator' });
    });

    it('treats a present non-array moderators value as not listed', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: { comment: 'thanks', moderators: null, moderatorPaymentsEnabled: true },
        }),
      ).toEqual({ skip: 'not_listed' });
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: { comment: 'thanks', moderators: { address: ADDRESS, amountUsd: 3 } },
        }),
      ).toEqual({ skip: 'not_listed' });
    });

    it('returns not_listed for an empty moderators array', () => {
      expect(
        decideSpendInstruction({
          address: ADDRESS,
          kind: 'moderator',
          roster: { comment: 'thanks', moderators: [] },
        }),
      ).toEqual({ skip: 'not_listed' });
    });

    it('returns undecided for a non-object roster', () => {
      expect(decideSpendInstruction({ address: ADDRESS, kind: 'moderator', roster: null })).toEqual(
        { skip: 'undecided' },
      );
    });
  });
});
