import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { syncWelcomePing } from '@/lib/welcome-media';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

const JPEG = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
/** Auth store without a platform account: no welcome gift can be recorded. */
const NO_PLATFORM = new InMemoryAuthStore();
const PHOTO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function account(partial: Partial<Account> & Pick<Account, 'id' | 'role'>): Account {
  return {
    linkingKey: null,
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'ab'.repeat(40)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    username: partial.id,
    walletRequired: true,
    sparkPubkey: `02${'a'.repeat(64)}`,
    sparkPubkeyVerifiedAt: 1,
    ...partial,
  };
}

async function photoStore(id: string = PHOTO_ID): Promise<InMemoryMessageStore> {
  const messages = new InMemoryMessageStore();
  await messages.create(
    {
      id,
      accountId: 'acc',
      name: 'Ada',
      text: 'about',
      createdAt: new Date(1),
      hasPhoto: true,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    },
    JPEG,
  );
  return messages;
}

describe('syncWelcomePing', () => {
  it('does nothing when the spend ping is omitted', async () => {
    const messages = await photoStore();
    const verified = account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID });
    const auth = new InMemoryAuthStore();
    await auth.createAccount(verified);
    const listAccounts = vi.spyOn(auth, 'listAccounts');
    const gifts = new InMemoryGiftStore();
    const listOutbound = vi.spyOn(gifts, 'listOutbound');
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      messages,
      auth,
      gifts,
      account: verified,
    });
    await syncWelcomePing({ lnurlServer: LNURL_SERVER, messages, auth, gifts });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listOutbound).not.toHaveBeenCalled();
    expect(parsedEvents(warn)).toEqual([]);
  });

  it('does nothing without a receiving wallet or when the role is not verified', async () => {
    const ping = vi.fn(async () => undefined);
    const messages = await photoStore();
    const spendPing = { ping };
    const verified = account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages,
      auth: NO_PLATFORM,
      account: { ...verified, sparkPubkeyVerifiedAt: null },
    });
    await syncWelcomePing({ spendPing, messages, auth: NO_PLATFORM, account: verified });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'basis', profileMessageId: PHOTO_ID }),
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'founder', profileMessageId: PHOTO_ID }),
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('pings the newest live photo, including a video and extra stills', async () => {
    const ping = vi.fn(async () => undefined);
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: PHOTO_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'photo',
        createdAt: new Date(1),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      JPEG,
    );
    await messages.create(
      {
        id: TEXT_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'clip',
        createdAt: new Date(2),
        hasPhoto: false,
        hasVideo: true,
        videoContentType: 'video/mp4',
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 1]) },
    );
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified' }),
    });
    expect(ping).toHaveBeenCalledWith('acc@example.test', TEXT_ID, 'welcome');
  });

  it('pings an About-me photo that is older than the listed page', async () => {
    const ping = vi.fn(async () => undefined);
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: PHOTO_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'about',
        createdAt: new Date(1),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      JPEG,
    );
    for (let i = 0; i < 200; i += 1) {
      const hex = i.toString(16).padStart(12, '0');
      await messages.create({
        id: `cccccccc-cccc-4ccc-8ccc-${hex}`,
        accountId: 'acc',
        name: 'Ada',
        text: `text ${i}`,
        createdAt: new Date(10 + i),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      });
    }
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified' }),
    });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith('acc@example.test', PHOTO_ID, 'welcome');
  });

  it('does not ping a hidden, nested, foreign, or blank profile note', async () => {
    const ping = vi.fn(async () => undefined);
    const hidden = new InMemoryMessageStore([
      {
        id: PHOTO_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'about',
        createdAt: new Date(1),
        ...unsignedNostrDefaults(),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        deletedAt: new Date(2),
      },
    ]);
    const reply = new InMemoryMessageStore([
      {
        id: PHOTO_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'reply',
        createdAt: new Date(1),
        ...unsignedNostrDefaults(),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        parentId: TEXT_ID,
      },
    ]);
    const foreign = new InMemoryMessageStore([
      {
        id: PHOTO_ID,
        accountId: 'other',
        name: 'Ada',
        text: 'about',
        createdAt: new Date(1),
        ...unsignedNostrDefaults(),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
      },
    ]);
    const textOnly = await photoStore();
    const row = await textOnly.getById(PHOTO_ID);
    expect(row).toBeDefined();
    if (row !== undefined) {
      await textOnly.updatePhoto(PHOTO_ID, null);
    }
    const spendPing = { ping };
    const verified = account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: hidden,
      auth: NO_PLATFORM,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: reply,
      auth: NO_PLATFORM,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: foreign,
      auth: NO_PLATFORM,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: textOnly,
      auth: NO_PLATFORM,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: new InMemoryMessageStore(),
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified', profileMessageId: '   ' }),
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: new InMemoryMessageStore(),
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified', profileMessageId: null }),
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('counts a note that only has extra stills and ignores a missing still count', async () => {
    const ping = vi.fn(async () => undefined);
    const stills = {
      async latestLiveTopLevelMediaId() {
        return PHOTO_ID;
      },
    } as unknown as MessageStore;
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: stills,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified' }),
    });
    expect(ping).toHaveBeenCalledWith('acc@example.test', PHOTO_ID, 'welcome');

    const missingCount = {
      async latestLiveTopLevelMediaId() {
        return null;
      },
    } as unknown as MessageStore;
    ping.mockClear();
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: missingCount,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }),
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('logs and resolves when the lookup or the ping throws', async () => {
    const messages = {
      async latestLiveTopLevelMediaId() {
        throw new Error('list boom');
      },
    } as unknown as MessageStore;
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping: vi.fn(async () => undefined) },
      messages,
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified' }),
    });
    const ping = vi.fn(async () => {
      throw new Error('ping boom');
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: await photoStore(),
      auth: NO_PLATFORM,
      account: account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }),
    });
    expect(
      parsedEvents(warn).filter((event) => event['event'] === 'spend.ping.failed'),
    ).toHaveLength(2);
  });

  it('catches up a verified photo post, including About me and a living-room photo', async () => {
    const ping = vi.fn(async () => undefined);
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: 'basis', role: 'basis' }));
    await auth.createAccount(
      account({
        id: 'blank',
        role: 'verified',
        profileMessageId: '   ',
      }),
    );
    await auth.createAccount(
      account({
        id: 'none',
        role: 'verified',
        profileMessageId: null,
      }),
    );
    await auth.createAccount(
      account({
        id: 'acc',
        role: 'verified',
        profileMessageId: PHOTO_ID,
      }),
    );
    await auth.createAccount(
      account({
        id: 'both',
        role: 'verified',
        profileMessageId: TEXT_ID,
      }),
    );
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: PHOTO_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'about',
        createdAt: new Date(1),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      JPEG,
    );
    await messages.create({
      id: TEXT_ID,
      accountId: 'both',
      name: 'Both',
      text: 'about',
      createdAt: new Date(1),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create(
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        accountId: 'both',
        name: 'Both',
        text: 'forum',
        createdAt: new Date(2),
        hasPhoto: true,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      },
      JPEG,
    );
    for (const [index, id] of ['blank', 'none', 'acc', 'both'].entries()) {
      const key = `02${String(index).repeat(64)}`;
      await auth.claimSparkPubkey(id, key);
      await auth.markSparkPubkeyVerified(id, key, id, 2);
    }
    await syncWelcomePing({ spendPing: { ping }, messages, auth });
    expect(ping).not.toHaveBeenCalled();
    await syncWelcomePing({ lnurlServer: LNURL_SERVER, spendPing: { ping }, messages, auth });
    expect(ping).toHaveBeenCalledTimes(2);
    expect(ping).toHaveBeenCalledWith('acc@example.test', PHOTO_ID, 'welcome');
    expect(ping).toHaveBeenCalledWith(
      'both@example.test',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'welcome',
    );
  });

  it('logs when the account list or the media check throws during catch-up', async () => {
    const auth = new InMemoryAuthStore();
    vi.spyOn(auth, 'listAccounts').mockRejectedValue(new Error('list boom'));
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping: vi.fn(async () => undefined) },
      messages: new InMemoryMessageStore(),
      auth,
    });
    const live = new InMemoryAuthStore();
    await live.createAccount(account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }));
    const messages = {
      async latestLiveTopLevelMediaId() {
        throw new Error('media boom');
      },
    } as unknown as MessageStore;
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping: vi.fn(async () => undefined) },
      messages,
      auth: live,
    });
    expect(
      parsedEvents(warn).filter((event) => event['event'] === 'spend.ping.failed'),
    ).toHaveLength(2);
  });
  it('does not ping an account that already received the welcome gift', async () => {
    const ping = vi.fn(async () => undefined);
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }));
    await auth.createAccount(
      account({
        id: 'plat',
        role: 'basis',
        isPlatform: true,
        sparkPubkeyVerifiedAt: null,
        viewKey: 'f'.repeat(64),
      }),
    );
    const walletKey = `02${'7'.repeat(64)}`;
    await auth.claimSparkPubkey('acc', walletKey);
    await auth.markSparkPubkeyVerified('acc', walletKey, 'acc', 2);
    const messages = await photoStore();
    const reply = {
      accountId: 'plat',
      name: '21.gifts',
      createdAt: new Date(3),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: PHOTO_ID,
    };
    await messages.create({ ...reply, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', text: 'daily' });
    const verified = account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      account: verified,
    });
    expect(ping).toHaveBeenCalledTimes(1);

    await messages.create({
      ...reply,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      text: ' Welcome ',
    });
    await messages.markDeleted('ffffffff-ffff-4fff-8fff-ffffffffffff', new Date(4), 'plat');
    ping.mockClear();
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      account: verified,
    });
    await syncWelcomePing({ lnurlServer: LNURL_SERVER, spendPing: { ping }, messages, auth });
    expect(ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).filter(
        (event) => event['event'] === 'spend.ping.skipped' && event['reason'] === 'welcomed',
      ),
    ).toHaveLength(2);
  });

  it('logs and does not ping when the platform lookup throws for one account', async () => {
    const ping = vi.fn(async () => undefined);
    const auth = new InMemoryAuthStore();
    vi.spyOn(auth, 'listAccounts').mockRejectedValue(new Error('list boom'));
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: await photoStore(),
      auth,
      account: account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }),
    });
    expect(ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).filter((event) => event['event'] === 'spend.ping.failed'),
    ).toHaveLength(1);
  });
  it('does not ping an account whose welcome gift is recorded under its username', async () => {
    const ping = vi.fn(async () => undefined);
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }));
    const walletKey = `02${'6'.repeat(64)}`;
    await auth.claimSparkPubkey('acc', walletKey);
    await auth.markSparkPubkeyVerified('acc', walletKey, 'acc', 2);
    const messages = await photoStore();
    const verified = account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID });
    const daily = new InMemoryGiftStore([
      { paidAt: new Date(1), amountSats: 1, recipientWosUser: 'acc', kind: 'daily' },
      {
        paidAt: new Date(1),
        amountSats: 1,
        recipientWosUser: 'other',
        kind: 'welcome',
        description: '21gifts welcome',
      },
      // A legacy welcome to another member's external address with the same local part.
      {
        paidAt: new Date(5),
        amountSats: 1,
        recipientWosUser: 'acc',
        kind: 'welcome',
        description: '21gifts daily',
      },
    ]);
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      gifts: daily,
      account: verified,
    });
    expect(ping).toHaveBeenCalledTimes(1);
    ping.mockClear();
    const before = new InMemoryGiftStore([
      {
        paidAt: new Date(1),
        amountSats: 1,
        recipientWosUser: 'acc',
        kind: 'welcome',
        description: '21gifts welcome',
      },
    ]);
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      gifts: before,
      account: { ...verified, sparkPubkeyVerifiedAt: 2 },
    });
    expect(ping).toHaveBeenCalledTimes(1);
    ping.mockClear();
    const welcomed = new InMemoryGiftStore([
      {
        paidAt: new Date(5),
        amountSats: 1,
        recipientWosUser: ' ACC ',
        kind: 'welcome',
        description: '21gifts welcome',
      },
    ]);
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      gifts: welcomed,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      gifts: welcomed,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages,
      auth,
      gifts: welcomed,
      account: { ...verified, username: null },
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('logs and does not ping when the gift lookup throws', async () => {
    const ping = vi.fn(async () => undefined);
    const gifts = new InMemoryGiftStore();
    vi.spyOn(gifts, 'listOutbound').mockRejectedValue(new Error('gift boom'));
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: await photoStore(),
      auth: NO_PLATFORM,
      gifts,
      account: account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }),
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: await photoStore(),
      auth: NO_PLATFORM,
      gifts,
    });
    expect(ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).filter((event) => event['event'] === 'spend.ping.failed'),
    ).toHaveLength(2);
  });
});
