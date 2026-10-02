import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { syncWelcomePing } from '@/lib/welcome-media';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

const JPEG = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
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
  it('does nothing when neither an account nor the auth store is passed', async () => {
    const ping = vi.fn(async () => undefined);
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: new InMemoryMessageStore(),
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('does nothing when the spend ping is omitted', async () => {
    const messages = await photoStore();
    await syncWelcomePing({
      messages,
      account: account({ id: 'acc', role: 'verified', profileMessageId: PHOTO_ID }),
    });
    await syncWelcomePing({
      messages,
      auth: new InMemoryAuthStore(),
    });
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
      account: { ...verified, sparkPubkeyVerifiedAt: null },
    });
    await syncWelcomePing({ spendPing, messages, account: verified });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages,
      account: account({ id: 'acc', role: 'basis', profileMessageId: PHOTO_ID }),
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages,
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
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: reply,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: foreign,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: textOnly,
      account: verified,
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: new InMemoryMessageStore(),
      account: account({ id: 'acc', role: 'verified', profileMessageId: '   ' }),
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing,
      messages: new InMemoryMessageStore(),
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
      account: account({ id: 'acc', role: 'verified' }),
    });
    const ping = vi.fn(async () => {
      throw new Error('ping boom');
    });
    await syncWelcomePing({
      lnurlServer: LNURL_SERVER,
      spendPing: { ping },
      messages: await photoStore(),
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
});
