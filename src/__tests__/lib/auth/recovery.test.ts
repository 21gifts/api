import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_SETTLE_AFTER_MS,
  forwardRecoveryLookup,
  settleAfterLookup,
  settleDecision,
} from '@/lib/auth/recovery';
import { InMemoryAuthStore, type PendingRecovery } from '@/lib/auth/store';
import { LNURL_SERVER_TIMEOUT_MS, type LnurlServerResult } from '@/lib/lnurl-server';
import { encodeSparkAddress } from '@/lib/spark-address';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';
import {
  PINNED,
  RECOVERY_USERNAME,
  lookupHolds,
  scriptedLnurlFetch,
  seedPinnedAccount,
  stagePendingRecovery,
} from '@/__tests__/helpers/recovery';

const T0 = 1_000_000;
const FORWARDED_AT = T0 + 1_000;
const AFTER_WINDOW = FORWARDED_AT + RECOVERY_SETTLE_AFTER_MS + 1;

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function pending(forwardedAt: number | null): PendingRecovery {
  return {
    accountId: PINNED.accountId,
    oldSparkPubkey: PINNED.oldSparkPubkey,
    newSparkPubkey: PINNED.newSparkPubkey,
    credentialId: PINNED.credentialId,
    publicKey: Uint8Array.of(4, 5, 6),
    signCount: 0,
    createdAt: T0,
    forwardedAt,
  };
}

function upstream(response: { status: number; body: string }): LnurlServerResult {
  return { ok: true, status: response.status, body: response.body, headers: {} };
}

const HOLDS_ADA = upstream({
  status: 200,
  body: JSON.stringify({ username: RECOVERY_USERNAME }),
});
const USER_NOT_FOUND = upstream({ status: 404, body: '"user not found"' });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('settleDecision', () => {
  const holds = { kind: 'holds', username: 'ada' } as const;
  const holdsOther = { kind: 'holds', username: 'bob' } as const;
  const notFound = { kind: 'not_found' } as const;
  const unverified = { kind: 'unverified' } as const;
  const forwarded = pending(FORWARDED_AT);

  it('waits twice the forward timeout', () => {
    expect(RECOVERY_SETTLE_AFTER_MS).toBe(2 * LNURL_SERVER_TIMEOUT_MS);
    expect(RECOVERY_SETTLE_AFTER_MS).toBe(30_000);
  });

  it('keeps an unforwarded pending recovery whatever the answer', () => {
    for (const answer of [holds, notFound, unverified]) {
      for (const role of ['old', 'new'] as const) {
        expect(settleDecision(pending(null), { role, sentAt: AFTER_WINDOW, answer }, 'ada')).toBe(
          'keep',
        );
      }
    }
  });

  it('keeps until a lookup is sent later than the window after the forward', () => {
    const atBoundary = FORWARDED_AT + RECOVERY_SETTLE_AFTER_MS;
    expect(
      settleDecision(forwarded, { role: 'new', sentAt: atBoundary, answer: holds }, 'ada'),
    ).toBe('keep');
    expect(
      settleDecision(forwarded, { role: 'old', sentAt: atBoundary, answer: notFound }, 'ada'),
    ).toBe('keep');
    expect(
      settleDecision(forwarded, { role: 'new', sentAt: atBoundary + 1, answer: holds }, 'ada'),
    ).toBe('commit');
  });

  it('decides each row after the window', () => {
    const at = AFTER_WINDOW;
    expect(settleDecision(forwarded, { role: 'new', sentAt: at, answer: holds }, ' Ada ')).toBe(
      'commit',
    );
    expect(settleDecision(forwarded, { role: 'new', sentAt: at, answer: holdsOther }, 'ada')).toBe(
      'keep',
    );
    expect(settleDecision(forwarded, { role: 'new', sentAt: at, answer: notFound }, 'ada')).toBe(
      'keep',
    );
    expect(settleDecision(forwarded, { role: 'new', sentAt: at, answer: unverified }, 'ada')).toBe(
      'keep',
    );
    expect(settleDecision(forwarded, { role: 'old', sentAt: at, answer: notFound }, 'ada')).toBe(
      'commit',
    );
    expect(settleDecision(forwarded, { role: 'old', sentAt: at, answer: holds }, 'ada')).toBe(
      'drop',
    );
    expect(settleDecision(forwarded, { role: 'old', sentAt: at, answer: holdsOther }, 'ada')).toBe(
      'keep',
    );
    expect(settleDecision(forwarded, { role: 'old', sentAt: at, answer: unverified }, 'ada')).toBe(
      'keep',
    );
  });

  it('never matches a held name without a valid account username', () => {
    const at = AFTER_WINDOW;
    for (const username of [null, undefined, 'not a name']) {
      expect(settleDecision(forwarded, { role: 'new', sentAt: at, answer: holds }, username)).toBe(
        'keep',
      );
      expect(settleDecision(forwarded, { role: 'old', sentAt: at, answer: holds }, username)).toBe(
        'keep',
      );
    }
  });
});

describe('forwardRecoveryLookup', () => {
  it('forwards the signed lookup as JSON and takes sentAt before the call', async () => {
    let clock = 5_000;
    const { fetchImpl, calls } = scriptedLnurlFetch({
      recover: () => {
        clock += 700;
        return lookupHolds('ada');
      },
    });
    const result = await forwardRecoveryLookup(
      LNURL_SERVER,
      fetchImpl,
      () => clock,
      PINNED.oldSparkPubkey,
      { signature: 'ab'.repeat(36), timestamp: 1_700_000_000 },
    );
    expect(result).toEqual({ sentAt: 5_000, answer: { kind: 'holds', username: 'ada' } });
    expect(calls).toEqual([
      {
        route: 'recover',
        pubkey: PINNED.oldSparkPubkey,
        body: JSON.stringify({ signature: 'ab'.repeat(36), timestamp: 1_700_000_000 }),
        host: LNURL_SERVER.host,
        contentType: 'application/json',
      },
    ]);
  });

  it('logs an unreachable server and reads it as unverified', async () => {
    const result = await forwardRecoveryLookup(
      LNURL_SERVER,
      async () => {
        throw new Error('down');
      },
      () => T0,
      PINNED.oldSparkPubkey,
      { signature: 'ab'.repeat(36), timestamp: 1 },
    );
    expect(result).toEqual({ sentAt: T0, answer: { kind: 'unverified' } });
    expect(
      parsedEvents(warn).filter(
        (e) => e['event'] === 'lnurl_server.unreachable' && e['route'] === 'recovery',
      ),
    ).toHaveLength(1);
  });

  it('does not log a refused path segment as unreachable', async () => {
    const fetchImpl = vi.fn();
    const result = await forwardRecoveryLookup(LNURL_SERVER, fetchImpl, () => T0, '..', {
      signature: 'ab'.repeat(36),
      timestamp: 1,
    });
    expect(result.answer).toEqual({ kind: 'unverified' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parsedEvents(warn)).toEqual([]);
  });
});

describe('settleAfterLookup', () => {
  async function staged(forwardedAt?: number): Promise<{
    store: InMemoryAuthStore;
    pending: PendingRecovery;
  }> {
    const store = new InMemoryAuthStore();
    await seedPinnedAccount(store);
    const stagedPending = await stagePendingRecovery(store, {
      createdAt: T0,
      ...(forwardedAt === undefined ? {} : { forwardedAt }),
    });
    return { store, pending: stagedPending };
  }

  function events(name: string): Array<Record<string, unknown>> {
    return parsedEvents(warn).filter((e) => e['event'] === name);
  }

  it("commits after the new key's lookup returns the username", async () => {
    const { store, pending: forwarded } = await staged(FORWARDED_AT);
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW + 5 },
      {
        pubkey: PINNED.newSparkPubkey,
        pendingNew: forwarded,
        sentAt: AFTER_WINDOW,
        result: HOLDS_ADA,
      },
    );
    const account = await store.getAccount(PINNED.accountId);
    expect(account?.sparkPubkey).toBe(PINNED.newSparkPubkey);
    expect(await store.getPendingRecovery(PINNED.accountId, AFTER_WINDOW)).toBeUndefined();
    expect(await store.listPreviousWallets(PINNED.accountId)).toEqual([
      {
        accountId: PINNED.accountId,
        sparkPubkey: PINNED.oldSparkPubkey,
        sparkAddress: encodeSparkAddress(PINNED.oldSparkPubkey),
        replacedAt: AFTER_WINDOW + 5,
      },
    ]);
    expect(events('account.recovery.committed')).toEqual([
      expect.objectContaining({ accountId: PINNED.accountId, via: 'lookup' }),
    ]);
  });

  it("commits after the old key's verified lookup finds no name", async () => {
    const { store } = await staged(FORWARDED_AT);
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: USER_NOT_FOUND,
      },
    );
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.newSparkPubkey);
    expect(events('account.recovery.committed')).toHaveLength(1);
  });

  it("drops after the old key's lookup still returns the username", async () => {
    const { store } = await staged(FORWARDED_AT);
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: HOLDS_ADA,
      },
    );
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
    expect(await store.getPendingRecovery(PINNED.accountId, AFTER_WINDOW)).toBeUndefined();
    expect(events('account.recovery.dropped')).toEqual([
      expect.objectContaining({ accountId: PINNED.accountId, via: 'lookup' }),
    ]);
  });

  it('keeps inside the window and for an unverified answer', async () => {
    const { store, pending: forwarded } = await staged(FORWARDED_AT);
    await settleAfterLookup(
      { auth: store, now: () => FORWARDED_AT + 10 },
      {
        pubkey: PINNED.newSparkPubkey,
        pendingNew: forwarded,
        sentAt: FORWARDED_AT + 10,
        result: HOLDS_ADA,
      },
    );
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: { ok: false, reason: 'unreachable' },
      },
    );
    expect((await store.getPendingRecovery(PINNED.accountId, AFTER_WINDOW))?.forwardedAt).toBe(
      FORWARDED_AT,
    );
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
    expect(events('account.recovery.committed')).toEqual([]);
    expect(events('account.recovery.dropped')).toEqual([]);
  });

  it('does nothing for a key no account holds verified or without a pending recovery of it', async () => {
    const store = new InMemoryAuthStore();
    await seedPinnedAccount(store);
    const getPending = vi.spyOn(store, 'getPendingRecovery');
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.newSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: USER_NOT_FOUND,
      },
    );
    expect(getPending).not.toHaveBeenCalled();
    const commit = vi.spyOn(store, 'commitRecovery');
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: USER_NOT_FOUND,
      },
    );
    expect(getPending).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
  });

  it('logs nothing when the store refuses the commit or the drop', async () => {
    const { store } = await staged(FORWARDED_AT);
    vi.spyOn(store, 'commitRecovery').mockResolvedValue('gone');
    vi.spyOn(store, 'dropPendingRecovery').mockResolvedValue(false);
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: USER_NOT_FOUND,
      },
    );
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.oldSparkPubkey,
        pendingNew: undefined,
        sentAt: AFTER_WINDOW,
        result: HOLDS_ADA,
      },
    );
    expect(events('account.recovery.committed')).toEqual([]);
    expect(events('account.recovery.dropped')).toEqual([]);
  });

  it('logs a store failure and resolves', async () => {
    const { store } = await staged(FORWARDED_AT);
    const failure = Object.assign(new Error('db down: secret detail'), { code: 'ECONNRESET' });
    vi.spyOn(store, 'getAccountByVerifiedSparkPubkey').mockRejectedValue(failure);
    await expect(
      settleAfterLookup(
        { auth: store, now: () => AFTER_WINDOW },
        {
          pubkey: PINNED.oldSparkPubkey,
          pendingNew: undefined,
          sentAt: AFTER_WINDOW,
          result: USER_NOT_FOUND,
        },
      ),
    ).resolves.toBeUndefined();
    const failed = events('account.recovery.settle_failed');
    expect(failed).toEqual([expect.objectContaining({ name: 'Error', code: 'ECONNRESET' })]);
    expect(JSON.stringify(failed)).not.toContain('secret detail');
  });

  it('never logs a key or a body', async () => {
    const { store, pending: forwarded } = await staged(FORWARDED_AT);
    await settleAfterLookup(
      { auth: store, now: () => AFTER_WINDOW },
      {
        pubkey: PINNED.newSparkPubkey,
        pendingNew: forwarded,
        sentAt: AFTER_WINDOW,
        result: HOLDS_ADA,
      },
    );
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain(PINNED.oldSparkPubkey);
    expect(logged).not.toContain(PINNED.newSparkPubkey);
  });
});
