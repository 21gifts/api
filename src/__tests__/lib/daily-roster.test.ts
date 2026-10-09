import { describe, expect, it, vi } from 'vitest';
import {
  DailyRosterRequestError,
  normalizeDailyRosterComment,
  withRecipientIdentities,
} from '@/lib/daily-roster';

const ROSTER = {
  comment: 'thanks',
  paymentsEnabled: true,
  moderatorPaymentsEnabled: true,
  defaultAmountUsd: 3,
  recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
  moderators: [],
};

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
  it('fills identities from lookup and preserves order and stored addresses', async () => {
    const seen: string[] = [];
    const roster = {
      comment: 'thanks',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'Ada@example.com', amountUsd: 2 },
        { address: 'bob@example.com', amountUsd: 1 },
      ],
      moderators: [{ address: 'mod@example.com', amountUsd: 5 }],
    };
    await expect(
      withRecipientIdentities(roster, async (address) => {
        seen.push(address);
        if (address === 'Ada@example.com') {
          return { id: 'ada-id', name: '  Ada  ' };
        }
        if (address === 'mod@example.com') {
          return { id: 'mod-id', name: 'Mod' };
        }
        return undefined;
      }),
    ).resolves.toEqual({
      comment: 'thanks',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'Ada@example.com', amountUsd: 2, accountId: 'ada-id', name: 'Ada' },
        { address: 'bob@example.com', amountUsd: 1, accountId: null, name: null },
      ],
      moderators: [{ address: 'mod@example.com', amountUsd: 5, accountId: 'mod-id', name: 'Mod' }],
    });
    expect(seen).toEqual(['Ada@example.com', 'bob@example.com', 'mod@example.com']);
  });

  it('maps null, missing, and blank names to null', async () => {
    const roster = {
      comment: '',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'a@example.com', amountUsd: 1 },
        { address: 'b@example.com', amountUsd: 1 },
        { address: 'c@example.com', amountUsd: 1 },
      ],
      moderators: [{ address: 'm@example.com', amountUsd: 4 }],
    };
    await expect(
      withRecipientIdentities(roster, async (address) => {
        if (address === 'a@example.com') {
          return { id: 'a', name: null };
        }
        if (address === 'b@example.com') {
          return { id: 'b', name: '   ' };
        }
        if (address === 'm@example.com') {
          return { id: 'm', name: null };
        }
        return { id: 'c' } as { id: string; name: string | null };
      }),
    ).resolves.toEqual({
      comment: '',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 3,
      recipients: [
        { address: 'a@example.com', amountUsd: 1, accountId: 'a', name: null },
        { address: 'b@example.com', amountUsd: 1, accountId: 'b', name: null },
        { address: 'c@example.com', amountUsd: 1, accountId: 'c', name: null },
      ],
      moderators: [{ address: 'm@example.com', amountUsd: 4, accountId: 'm', name: null }],
    });
  });

  it('does not call lookup when both lists are empty', async () => {
    const lookup = vi.fn();
    await expect(
      withRecipientIdentities(
        {
          comment: '',
          paymentsEnabled: false,
          moderatorPaymentsEnabled: true,
          defaultAmountUsd: 3,
          recipients: [],
          moderators: [],
        },
        lookup,
      ),
    ).resolves.toEqual({
      comment: '',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 3,
      recipients: [],
      moderators: [],
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
