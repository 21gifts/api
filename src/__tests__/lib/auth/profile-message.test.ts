import { describe, expect, it, vi } from 'vitest';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryPushStore } from '@/lib/push-store';

const now = (): number => 1_700_000_000_000;

async function seededAccount(
  overrides: Partial<Account> = {},
): Promise<{ auth: InMemoryAuthStore; account: Account }> {
  const auth = new InMemoryAuthStore();
  const account: Account = {
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...overrides,
  };
  await auth.createAccount(account);
  return { auth, account };
}

describe('ensureProfileMessage', () => {
  it('returns the account without inserting when name is blank', async () => {
    const { auth, account } = await seededAccount({ name: null });
    const messages = new InMemoryMessageStore();
    const create = vi.spyOn(messages, 'create');
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('inserts one profile note and is idempotent on rename', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const first = await ensureProfileMessage({ auth, messages, account, now });
    expect(typeof first.profileMessageId).toBe('string');
    const note = await messages.getById(first.profileMessageId!);
    expect(note?.text).toBe('Ada');
    const renamed: Account = { ...first, name: 'Ada Lovelace' };
    const second = await ensureProfileMessage({
      auth,
      messages,
      account: renamed,
      now,
    });
    expect(second.profileMessageId).toBe(first.profileMessageId);
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
    expect((await messages.getById(first.profileMessageId!))?.text).toBe('Ada');
  });

  it('recreates when profileMessageId points at a missing row', async () => {
    const { auth, account } = await seededAccount({
      profileMessageId: '00000000-0000-4000-8000-000000000099',
    });
    const messages = new InMemoryMessageStore();
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).not.toBe('00000000-0000-4000-8000-000000000099');
    expect(await messages.getById(result.profileMessageId!)).toBeDefined();
  });

  it('enqueues forum pushes when pushStore is passed', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      accountId: 'other',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const result = await ensureProfileMessage({
      auth,
      messages,
      account,
      now,
      pushStore,
    });
    expect(result.profileMessageId).toBeTruthy();
    const pending = await pushStore.claimPending(10, now(), 60_000);
    expect(pending.some((row) => row.type === 'forum')).toBe(true);
  });

  it('deletes the insert when the account disappears before update', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    vi.spyOn(auth, 'getAccount').mockResolvedValueOnce(undefined);
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBeUndefined();
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('deletes a raced insert when another profile note already won', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const winnerId = '22222222-2222-4222-8222-222222222222';
    await messages.create({
      id: winnerId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    vi.spyOn(auth, 'getAccount').mockResolvedValueOnce({
      ...account,
      profileMessageId: winnerId,
    });
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBe(winnerId);
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
    expect(await messages.getById(winnerId)).toBeDefined();
  });

  it('keeps the note when forum push enqueue throws', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      accountId: 'other',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    vi.spyOn(pushStore, 'enqueue').mockRejectedValueOnce(new Error('fail'));
    const result = await ensureProfileMessage({
      auth,
      messages,
      account,
      now,
      pushStore,
    });
    expect(typeof result.profileMessageId).toBe('string');
    expect(await messages.getById(result.profileMessageId!)).toBeDefined();
  });

  it('deletes the insert when a later write wins the profile pointer', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const winnerId = '22222222-2222-4222-8222-222222222222';
    await messages.create({
      id: winnerId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const get = vi.spyOn(auth, 'getAccount');
    get.mockResolvedValueOnce({ ...account });
    get.mockResolvedValueOnce({ ...account, profileMessageId: winnerId });
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBe(winnerId);
    expect(await messages.getById(winnerId)).toBeDefined();
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
  });

  it('deletes the insert when the account disappears after update', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    const get = vi.spyOn(auth, 'getAccount');
    get.mockResolvedValueOnce({ ...account });
    get.mockResolvedValueOnce(undefined);
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBeUndefined();
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('deletes the note when updateAccount fails after insert', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    vi.spyOn(auth, 'updateAccount').mockRejectedValueOnce(new Error('fail'));
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBeUndefined();
    expect(await messages.listLatest(10)).toHaveLength(0);
  });

  it('does not set profileMessageId when create throws', async () => {
    const { auth, account } = await seededAccount();
    const messages = new InMemoryMessageStore();
    vi.spyOn(messages, 'create').mockRejectedValueOnce(new Error('fail'));
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBeUndefined();
    expect(result.name).toBe('Ada');
  });

  it('accepts an existing note without rewriting text', async () => {
    const messages = new InMemoryMessageStore();
    const noteId = '11111111-1111-4111-8111-111111111111';
    await messages.create({
      id: noteId,
      accountId: 'acc',
      name: 'Ada',
      text: 'Original note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const { auth, account } = await seededAccount({
      name: 'Renamed',
      profileMessageId: noteId,
    });
    const result = await ensureProfileMessage({ auth, messages, account, now });
    expect(result.profileMessageId).toBe(noteId);
    expect((await messages.getById(noteId))?.text).toBe('Original note');
  });
});
