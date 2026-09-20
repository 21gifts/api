import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  USERNAME_MAX_LENGTH,
  backfillAccountUsernames,
  normalizeUsername,
  usernameFromDisplayName,
} from '@/lib/username';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function account(partial: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    linkingKey: null,
    role: 'basis',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey:
      partial.viewKey ??
      `${partial.id.replace(/-/g, '').slice(0, 32)}${'a'.repeat(32)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

describe('normalizeUsername', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeUsername('  Ada  ')).toBe('ada');
  });

  it('rejects an empty string', () => {
    expect(normalizeUsername('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeUsername('   ')).toBeNull();
  });

  it('rejects a lone underscore', () => {
    expect(normalizeUsername('_')).toBeNull();
  });

  it('rejects unicode, spaces, and plus', () => {
    expect(normalizeUsername('äda')).toBeNull();
    expect(normalizeUsername('ada lovelace')).toBeNull();
    expect(normalizeUsername('ada+foo')).toBeNull();
  });

  it('lowercases uppercase input', () => {
    expect(normalizeUsername('ADA')).toBe('ada');
  });

  it('rejects a leading hyphen or leading dot', () => {
    expect(normalizeUsername('-ada')).toBeNull();
    expect(normalizeUsername('.ada')).toBeNull();
  });

  it('rejects a username longer than 32 characters', () => {
    expect(normalizeUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBeNull();
  });

  it('accepts LUD-16 local-parts with hyphen, underscore, or dot', () => {
    expect(normalizeUsername('ada')).toBe('ada');
    expect(normalizeUsername('ada-lovelace')).toBe('ada-lovelace');
    expect(normalizeUsername('ruben-h')).toBe('ruben-h');
    expect(normalizeUsername('21-gifts')).toBe('21-gifts');
    expect(normalizeUsername('rachel-ann-mabulay')).toBe('rachel-ann-mabulay');
    expect(normalizeUsername('ada.lovelace')).toBe('ada.lovelace');
    expect(normalizeUsername('ada_lovelace')).toBe('ada_lovelace');
    expect(normalizeUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(
      'a'.repeat(USERNAME_MAX_LENGTH),
    );
  });
});

describe('usernameFromDisplayName', () => {
  it('slugs a display name without collision suffixes', () => {
    expect(usernameFromDisplayName('Ada Lovelace')).toBe('ada-lovelace');
    expect(usernameFromDisplayName('Ruben H.')).toBe('ruben-h');
    expect(usernameFromDisplayName('21.gifts')).toBe('21-gifts');
  });

  it('returns null for punctuation-only names and the user slug', () => {
    expect(usernameFromDisplayName('!!!')).toBeNull();
    expect(usernameFromDisplayName('User')).toBeNull();
  });
});

describe('backfillAccountUsernames', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('assigns unique handles oldest-first and preserves existing ones', async () => {
    const store = new InMemoryAuthStore();
    const older = account({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Ada',
      createdAt: 1,
      viewKey: 'a'.repeat(64),
    });
    const younger = account({
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Ada',
      createdAt: 2,
      viewKey: 'b'.repeat(64),
    });
    const nameless = account({
      id: '33333333-3333-3333-3333-333333333333',
      name: null,
      createdAt: 3,
      viewKey: 'c'.repeat(64),
    });
    const kept = account({
      id: '44444444-4444-4444-4444-444444444444',
      name: 'Grace',
      username: 'custom',
      createdAt: 0,
      viewKey: 'd'.repeat(64),
    });
    await store.createAccount(kept);
    await store.createAccount(older);
    await store.createAccount(younger);
    await store.createAccount(nameless);
    const count = await backfillAccountUsernames(store);
    expect(count).toBe(2);
    expect((await store.getAccount(older.id))?.username).toBe('ada');
    expect((await store.getAccount(younger.id))?.username).toBe('ada-22222222');
    expect((await store.getAccount(nameless.id))?.username).toBeUndefined();
    expect((await store.getAccount(kept.id))?.username).toBe('custom');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.username.backfill' && e['count'] === 2,
      ),
    ).toBe(true);
  });

  it('assigns a punctuation-only name when allocateNip05Local passes normalizeUsername', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount(
      account({
        id: '55555555-5555-5555-5555-555555555555',
        name: '!!!',
        createdAt: 1,
        viewKey: 'e'.repeat(64),
      }),
    );
    expect(await backfillAccountUsernames(store)).toBe(1);
    expect((await store.getAccount('55555555-5555-5555-5555-555555555555'))?.username).toBe('user');
  });

  it('skips a blank stored username when seeding taken', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount(
      account({
        id: '66666666-6666-6666-6666-666666666666',
        name: 'Ada',
        username: '  ',
        createdAt: 1,
        viewKey: 'f'.repeat(64),
      }),
    );
    expect(await backfillAccountUsernames(store)).toBe(1);
    expect((await store.getAccount('66666666-6666-6666-6666-666666666666'))?.username).toBe('ada');
  });
});
