import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { viewRoutes } from '@/routes/view';
import { LNURL_SERVER, WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';

const VIEW_KEY = 'a'.repeat(64);
const PUBLIC_CARD = {
  id: 'acc',
  role: 'basis' as const,
  postCount: 0,
  replyCount: 0,
  shopCount: 0,
  creditCount: 0,
  fundingReviewedAt: null,
  fundingReviewedByName: null,
};
const NOTE_ID = 'note-ada';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function mount(
  store: InMemoryAuthStore,
  messages: InMemoryMessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/view',
    viewRoutes({
      store,
      messageStore: messages,
      lnurlServer: LNURL_SERVER,
      fundingStore: new InMemoryFundingStore(),
    }),
  );
}

async function adaAccount(
  store: InMemoryAuthStore,
  overrides: {
    /** `false` leaves the wallet unverified. Default: verified wallet `ada@example.test`. */
    wallet?: boolean;
    profileMessageId?: string;
  } = {},
): Promise<void> {
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    walletRequired: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: VIEW_KEY,
    createdAt: 1_000_000,
    rulesAgreedAt: null,
    ...(overrides.profileMessageId === undefined
      ? {}
      : { profileMessageId: overrides.profileMessageId }),
  });
  if (overrides.wallet !== false) {
    await store.claimSparkPubkey('acc', WALLET_PUBKEY);
    await store.markSparkPubkeyVerified('acc', WALLET_PUBKEY, 'ada', 1);
  }
}

describe('GET /view/:viewKey', () => {
  it('defaults forum and gift collaborators when omitted', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const res = await new Hono().route('/view', viewRoutes({ store })).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Ada', aboutMe: null });
  });

  it('returns 404 Not found for a short param', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/view/abcd');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for uppercase hex', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${'A'.repeat(64)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for extra characters', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${VIEW_KEY}zz`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for an unknown 64-hex key', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns the reviewer name when the member is admitted', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    await store.createAccount({
      id: 'staff',
      linkingKey: null,
      role: 'moderator',
      name: 'Bea',
      forumLawsDismissed: true,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: 3,
    });
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: 'acc',
        status: 'admitted',
        appliedAt: 1,
        decidedAt: 2,
        decidedBy: 'staff',
        trialUtcDate: null,
        admittedAt: 2,
        note: null,
      },
    ]);
    const res = await new Hono()
      .route('/view', viewRoutes({ store, fundingStore, lnurlServer: LNURL_SERVER }))
      .request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      fundingReviewedAt: 2,
      fundingReviewedByName: 'Bea',
    });
  });

  it('returns the public profile card without Authorization', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ...PUBLIC_CARD,
      name: 'Ada',
      username: 'ada',
      location: null,
      lightningAddress: 'ada@example.test',
      lightningAddressVerified: true,
      createdAt: 1_000_000,
      hasPasskey: false,
      aboutMe: null,
      aboutMeHasPhoto: false,
      aboutMessageId: null,
      profileMessage: null,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('linkingKey');
    expect(raw).not.toContain('viewKey');
    expect(raw).not.toContain('profileMessageId');
    expect(Object.keys(body).sort()).toEqual([
      'aboutMe',
      'aboutMeHasPhoto',
      'aboutMessageId',
      'createdAt',
      'creditCount',
      'fundingReviewedAt',
      'fundingReviewedByName',
      'hasPasskey',
      'id',
      'lightningAddress',
      'lightningAddressVerified',
      'location',
      'name',
      'postCount',
      'profileMessage',
      'replyCount',
      'role',
      'shopCount',
      'username',
    ]);
  });

  it('sets hasPasskey true when this account has a credential', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { wallet: false });
    await store.createPasskeyCredential({
      credentialId: 'cred-acc',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...PUBLIC_CARD,
      name: 'Ada',
      username: 'ada',
      location: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1_000_000,
      hasPasskey: true,
      aboutMe: null,
      aboutMeHasPhoto: false,
      aboutMessageId: null,
      profileMessage: null,
    });
  });

  it('does not flip hasPasskey from another account credential', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { wallet: false });
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
    });
    await store.createPasskeyCredential({
      credentialId: 'cred-other',
      publicKey: new Uint8Array([2]),
      signCount: 0,
      accountId: 'other',
      createdAt: 2,
    });
    const res = await mount(store).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPasskey: false, aboutMe: null });
  });

  it('sets aboutMe from a real bio and null when the note is only the display name', async () => {
    const bioStore = new InMemoryAuthStore();
    await adaAccount(bioStore, { profileMessageId: NOTE_ID });
    const bioMessages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'I build on Bitcoin',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const bioRes = await mount(bioStore, bioMessages).request(`/view/${VIEW_KEY}`);
    expect(bioRes.status).toBe(200);
    const bioBody = (await bioRes.json()) as {
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
      aboutMessageId: string | null;
      profileMessage: { id: string; hearted: boolean; heartCount: number } | null;
    };
    expect(bioBody.aboutMe).toBe('I build on Bitcoin');
    expect(bioBody.aboutMeHasPhoto).toBe(false);
    expect(bioBody.aboutMessageId).toBe(NOTE_ID);
    expect(bioBody.profileMessage?.id).toBe(NOTE_ID);
    expect(bioBody.profileMessage?.hearted).toBe(false);
    expect(bioBody.profileMessage?.heartCount).toBe(0);

    const nameStore = new InMemoryAuthStore();
    await adaAccount(nameStore, { profileMessageId: NOTE_ID });
    const nameMessages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const nameRes = await mount(nameStore, nameMessages).request(`/view/${VIEW_KEY}`);
    expect(nameRes.status).toBe(200);
    const nameBody = (await nameRes.json()) as {
      aboutMe: string | null;
      aboutMessageId: string | null;
    };
    expect(nameBody.aboutMe).toBeNull();
    expect(nameBody.aboutMessageId).toBeNull();
  });

  it('returns aboutMe null when the note is the stored name after a rename', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    await store.updateAccount({ ...existing!, name: 'Grace' });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; aboutMe: string | null };
    expect(body.name).toBe('Grace');
    expect(body.aboutMe).toBeNull();
  });

  it('returns aboutMe null when the profile note is soft-hidden', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'I build on Bitcoin',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    expect(await messages.markDeleted(NOTE_ID, new Date(2_000_000), 'staff')).toBe(true);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aboutMe: string | null }).aboutMe).toBeNull();
  });

  it('returns aboutMe null when profileMessageId has no row', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: 'missing-note' });
    const res = await mount(store, new InMemoryMessageStore()).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { aboutMe: string | null }).aboutMe).toBeNull();
  });

  it('returns 503 when getById throws', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(messages, 'getById').mockRejectedValue(new Error('store down'));
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(
      warn.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('view.get.failed'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});

describe('GET /view/:viewKey/about/photo', () => {
  it('returns 404 Not found for an invalid key', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/view/abcd/about/photo');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Not found for an unknown view key', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/view/${'b'.repeat(64)}/about/photo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 Photo not found when the account has no profile note', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const res = await mount(store).request(`/view/${VIEW_KEY}/about/photo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 Photo not found when the profile note is missing', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const res = await mount(store, new InMemoryMessageStore()).request(
      `/view/${VIEW_KEY}/about/photo`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 Photo not found when the profile note is hidden', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    expect(await messages.markDeleted(NOTE_ID, new Date(1_000_000), 'staff')).toBe(true);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}/about/photo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 Photo not found when the live note has no photo', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore([
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}/about/photo`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('sets aboutMeHasPhoto true when the live note has a photo', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'I build on Bitcoin',
        createdAt: new Date(1_000_000),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aboutMe: string | null;
      aboutMeHasPhoto: boolean;
      aboutMessageId: string | null;
    };
    expect(body.aboutMe).toBe('I build on Bitcoin');
    expect(body.aboutMeHasPhoto).toBe(true);
    expect(body.aboutMessageId).toBe(NOTE_ID);
    expect(body).not.toHaveProperty('profileMessageId');
  });

  it('returns jpeg bytes when the live note has a photo', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore();
    await messages.create(
      {
        id: NOTE_ID,
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date(1_000_000),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}/about/photo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('returns 503 when getById throws', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store, { profileMessageId: NOTE_ID });
    const messages = new InMemoryMessageStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(messages, 'getById').mockRejectedValue(new Error('store down'));
    const res = await mount(store, messages).request(`/view/${VIEW_KEY}/about/photo`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(
      warn.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('view.photo.failed'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});

const FEEDS = ['posts', 'shops', 'credits', 'replies'] as const;

describe('GET /view/:viewKey feeds', () => {
  it('returns 404 for a short key on every list', async () => {
    const app = mount(new InMemoryAuthStore());
    for (const feed of FEEDS) {
      const res = await app.request(`/view/abcd/${feed}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns 404 for an unknown key on every list', async () => {
    const app = mount(new InMemoryAuthStore());
    for (const feed of FEEDS) {
      const res = await app.request(`/view/${VIEW_KEY}/${feed}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns the same lists as the member card without Authorization', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const messages = new InMemoryMessageStore();
    const createdAt = new Date(1_000_000);
    await messages.create({
      id: 'post-1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: 'shop-1',
      accountId: 'acc',
      name: 'Ada',
      text: '#21GiftsShop open',
      createdAt,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: 'credit-1',
      accountId: 'acc',
      name: 'Ada',
      text: 'lend me',
      createdAt,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalRepayable: true,
    });
    await messages.create({
      ...unsignedNostrDefaults(),
      id: 'reply-1',
      accountId: 'acc',
      parentId: 'post-1',
      name: 'Ada',
      text: 'reply',
      createdAt,
      hasPhoto: false,
    });
    const app = mount(store, messages);
    const posts = (await (await app.request(`/view/${VIEW_KEY}/posts`)).json()) as {
      messages: Array<{ id: string; hearted: boolean }>;
    };
    const shops = (await (await app.request(`/view/${VIEW_KEY}/shops`)).json()) as {
      messages: Array<{ id: string }>;
    };
    const credits = (await (await app.request(`/view/${VIEW_KEY}/credits`)).json()) as {
      messages: Array<{ id: string }>;
    };
    const replies = (await (await app.request(`/view/${VIEW_KEY}/replies`)).json()) as {
      messages: Array<{ id: string; hearted: boolean }>;
    };
    expect(posts.messages.map((row) => row.id).sort()).toEqual(['credit-1', 'post-1', 'shop-1']);
    expect(posts.messages.every((row) => row.hearted === false)).toBe(true);
    expect(shops.messages.map((row) => row.id)).toEqual(['shop-1']);
    expect(credits.messages.map((row) => row.id)).toEqual(['credit-1']);
    expect(replies.messages.map((row) => row.id)).toEqual(['reply-1']);
    expect(replies.messages[0]?.hearted).toBe(false);
  });

  it('returns 503 when a list throws', async () => {
    const store = new InMemoryAuthStore();
    await adaAccount(store);
    const messages = new InMemoryMessageStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(messages, 'listPostsByAccount').mockRejectedValue(new Error('down'));
    vi.spyOn(messages, 'listShopsByAccount').mockRejectedValue(new Error('down'));
    vi.spyOn(messages, 'listCreditsByAccount').mockRejectedValue(new Error('down'));
    vi.spyOn(messages, 'listRepliesByAccount').mockRejectedValue(new Error('down'));
    const app = mount(store, messages);
    for (const feed of FEEDS) {
      const res = await app.request(`/view/${VIEW_KEY}/${feed}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    }
    const logged = warn.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('view.posts.failed'))).toBe(true);
    expect(logged.some((line) => line.includes('view.shops.failed'))).toBe(true);
    expect(logged.some((line) => line.includes('view.credits.failed'))).toBe(true);
    expect(logged.some((line) => line.includes('view.replies.failed'))).toBe(true);
    warn.mockRestore();
  });
});
