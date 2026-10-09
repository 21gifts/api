import { describe, expect, it, vi } from 'vitest';
import {
  DailyRosterRequestError,
  normalizeDailyRosterComment,
  withRecipientIdentities,
} from '@/lib/daily-roster';

const ROSTER = {
  comment: 'thanks',
  paymentsEnabled: true,
  defaultAmountUsd: 3,
  recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
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
