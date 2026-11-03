import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { FUNDING_REQUIRED_FROM_UTC } from '@/lib/funding';
import { pingTodayMedia, type TodayMediaPingDeps } from '@/lib/funding-ping';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { SpendPing } from '@/lib/spend-ping';
import { storeRecoveryShare } from '@/__tests__/helpers/recovery';
import { LNURL_SERVER, WALLET_PUBKEY, createWalletAccount } from '@/__tests__/helpers/wallet-lnurl';

/** Before the grant gate day: the share is never read. */
const PRE_GATE_MS = 1_700_000_000_000;
/** A gated day. */
const GATE_MS = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
const DAY_MS = 86_400_000;
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';
const PHOTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADDRESS = 'ada@example.test';
const JPEG = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function events(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

async function seedLivePhoto(
  messageStore: InMemoryMessageStore,
  id: string,
  createdAt: Date,
  extra: { parentId?: string; hasPhoto?: boolean } = {},
): Promise<void> {
  const row = {
    id,
    accountId: ACCOUNT_ID,
    name: 'Ada',
    text: `photo ${id}`,
    createdAt,
    hasPhoto: extra.hasPhoto ?? true,
    ...unsignedNostrDefaults(),
    ...(extra.parentId === undefined ? {} : { parentId: extra.parentId }),
  };
  if (row.hasPhoto) {
    await messageStore.create(row, JPEG);
  } else {
    await messageStore.create(row);
  }
}

/** A verified-wallet member `ada` with the given recovery share state. */
async function member(options: { share?: boolean } = {}): Promise<{
  authStore: InMemoryAuthStore;
  account: Account;
}> {
  const authStore = new InMemoryAuthStore();
  await createWalletAccount(authStore, ACCOUNT_ID, 'ada');
  if (options.share === true) {
    await storeRecoveryShare(authStore, ACCOUNT_ID, WALLET_PUBKEY);
  }
  return { authStore, account: (await authStore.getAccount(ACCOUNT_ID))! };
}

function deps(
  authStore: InMemoryAuthStore,
  messageStore: InMemoryMessageStore,
  ping?: SpendPing['ping'],
): TodayMediaPingDeps {
  return {
    lnurlServer: LNURL_SERVER,
    messageStore,
    authStore,
    ...(ping === undefined ? {} : { spendPing: { ping } }),
  };
}

describe('pingTodayMedia', () => {
  it("pings today's newest live top-level photo with the grant status", async () => {
    const { authStore, account } = await member();
    const messageStore = new InMemoryMessageStore();
    await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS - 1));
    await seedLivePhoto(messageStore, PHOTO_B, new Date(PRE_GATE_MS));
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(
      deps(authStore, messageStore, ping),
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith(ADDRESS, PHOTO_B, 'daily', 'admitted');
    expect(ping.mock.calls[0]).toHaveLength(4);
  });

  it('does not ping when the only live media post is from the previous UTC day', async () => {
    const { authStore, account } = await member();
    const messageStore = new InMemoryMessageStore();
    await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS - DAY_MS));
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(deps(authStore, messageStore, ping), account, PRE_GATE_MS, 'trial', true);
    expect(ping).not.toHaveBeenCalled();
  });

  it('does not ping without media or without a receiving address', async () => {
    const { authStore, account } = await member();
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(
      deps(authStore, new InMemoryMessageStore(), ping),
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    const messageStore = new InMemoryMessageStore();
    await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS));
    await pingTodayMedia(
      deps(authStore, messageStore, ping),
      { ...account, sparkPubkeyVerifiedAt: null },
      PRE_GATE_MS,
      'admitted',
      true,
    );
    await pingTodayMedia(
      { spendPing: { ping }, messageStore, authStore },
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    expect(ping).not.toHaveBeenCalled();
  });

  it('does not ping a photo reply when there is no top-level media', async () => {
    const { authStore, account } = await member();
    const messageStore = new InMemoryMessageStore();
    await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS), { hasPhoto: false });
    await seedLivePhoto(messageStore, PHOTO_B, new Date(PRE_GATE_MS), { parentId: PHOTO_A });
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(
      deps(authStore, messageStore, ping),
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    expect(ping).not.toHaveBeenCalled();
  });

  it('does not ping when the media row is missing', async () => {
    const { authStore, account } = await member();
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(
      {
        spendPing: { ping },
        lnurlServer: LNURL_SERVER,
        authStore,
        messageStore: {
          latestLiveTopLevelMediaId: async () => PHOTO_A,
          getById: async () => undefined,
        },
      },
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    expect(ping).not.toHaveBeenCalled();
  });

  it('is a no-op without a spend ping and reads nothing', async () => {
    const { authStore, account } = await member();
    const latest = vi.fn(async () => PHOTO_A);
    const share = vi.spyOn(authStore, 'hasRecoveryShareForVerifiedWallet');
    await pingTodayMedia(
      {
        lnurlServer: LNURL_SERVER,
        authStore,
        messageStore: { latestLiveTopLevelMediaId: latest, getById: async () => undefined },
      },
      account,
      GATE_MS,
      'admitted',
      true,
    );
    expect(latest).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it('logs funding.daily_ping.failed and resolves when the ping throws', async () => {
    const { authStore, account } = await member();
    const messageStore = new InMemoryMessageStore();
    await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS));
    const ping = vi.fn(async () => {
      throw new Error('ping boom');
    });
    await expect(
      pingTodayMedia(deps(authStore, messageStore, ping), account, PRE_GATE_MS, 'admitted', true),
    ).resolves.toBeUndefined();
    expect(events()).toEqual([
      expect.objectContaining({ event: 'funding.daily_ping.failed', accountId: ACCOUNT_ID }),
    ]);
  });

  it('logs funding.daily_ping.failed and resolves when the media lookup throws', async () => {
    const { authStore, account } = await member();
    const ping = vi.fn(async () => undefined);
    await pingTodayMedia(
      {
        spendPing: { ping },
        lnurlServer: LNURL_SERVER,
        authStore,
        messageStore: {
          latestLiveTopLevelMediaId: async () => {
            throw new Error('db down');
          },
          getById: async () => undefined,
        },
      },
      account,
      PRE_GATE_MS,
      'admitted',
      true,
    );
    expect(ping).not.toHaveBeenCalled();
    expect(events().map((e) => e['event'])).toEqual(['funding.daily_ping.failed']);
  });

  describe('recovery share', () => {
    it('skips a member without a share on a gated day when the share is required', async () => {
      const { authStore, account } = await member();
      const messageStore = new InMemoryMessageStore();
      await seedLivePhoto(messageStore, PHOTO_A, new Date(GATE_MS));
      const ping = vi.fn(async () => undefined);
      await pingTodayMedia(deps(authStore, messageStore, ping), account, GATE_MS, 'admitted', true);
      expect(ping).not.toHaveBeenCalled();
      expect(events()).toEqual([
        expect.objectContaining({ event: 'spend.ping.skipped', reason: 'not_eligible' }),
      ]);
      expect(JSON.stringify(events())).not.toContain(ADDRESS);
    });

    it('pings a member with a share on a gated day', async () => {
      const { authStore, account } = await member({ share: true });
      const messageStore = new InMemoryMessageStore();
      await seedLivePhoto(messageStore, PHOTO_A, new Date(GATE_MS));
      const ping = vi.fn(async () => undefined);
      await pingTodayMedia(deps(authStore, messageStore, ping), account, GATE_MS, 'trial', true);
      expect(ping).toHaveBeenCalledWith(ADDRESS, PHOTO_A, 'daily', 'trial');
    });

    it('logs funding.daily_ping.failed and resolves when the share read throws', async () => {
      const { authStore, account } = await member({ share: true });
      vi.spyOn(authStore, 'hasRecoveryShareForVerifiedWallet').mockRejectedValue(
        new Error('share down'),
      );
      const messageStore = new InMemoryMessageStore();
      await seedLivePhoto(messageStore, PHOTO_A, new Date(GATE_MS));
      const ping = vi.fn(async () => undefined);
      await expect(
        pingTodayMedia(deps(authStore, messageStore, ping), account, GATE_MS, 'admitted', true),
      ).resolves.toBeUndefined();
      expect(ping).not.toHaveBeenCalled();
      expect(events()).toEqual([
        expect.objectContaining({ event: 'funding.daily_ping.failed', accountId: ACCOUNT_ID }),
      ]);
    });

    it('never reads the share when it is not required', async () => {
      const { authStore, account } = await member();
      const share = vi.spyOn(authStore, 'hasRecoveryShareForVerifiedWallet');
      const messageStore = new InMemoryMessageStore();
      await seedLivePhoto(messageStore, PHOTO_A, new Date(GATE_MS));
      const ping = vi.fn(async () => undefined);
      await pingTodayMedia(
        deps(authStore, messageStore, ping),
        account,
        GATE_MS,
        'admitted',
        false,
      );
      expect(share).not.toHaveBeenCalled();
      expect(ping).toHaveBeenCalledWith(ADDRESS, PHOTO_A, 'daily', 'admitted');
    });

    it('never reads the share before the gate day', async () => {
      const { authStore, account } = await member();
      const share = vi.spyOn(authStore, 'hasRecoveryShareForVerifiedWallet');
      const messageStore = new InMemoryMessageStore();
      await seedLivePhoto(messageStore, PHOTO_A, new Date(PRE_GATE_MS));
      const ping = vi.fn(async () => undefined);
      await pingTodayMedia(
        deps(authStore, messageStore, ping),
        account,
        PRE_GATE_MS,
        'trial',
        true,
      );
      expect(share).not.toHaveBeenCalled();
      expect(ping).toHaveBeenCalledWith(ADDRESS, PHOTO_A, 'daily', 'trial');
    });
  });
});
