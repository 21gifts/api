import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  allocateNip05Local,
  buildNostrJson,
  nip05Domain,
  nip05Identifier,
  nip05Slug,
} from '@/lib/nip05';

function account(partial: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    linkingKey: null,
    role: 'basis',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'ab'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    ...partial,
  };
}

describe('nip05', () => {
  it('slugs names and allocates unique locals', () => {
    expect(nip05Slug('Ada Lovelace')).toBe('ada-lovelace');
    expect(nip05Slug('!!!')).toBe('user');
    const taken = new Set<string>(['ada']);
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', taken)).toBe(
      'ada-11111111',
    );
  });

  it('uses the public host and skips loopback', () => {
    expect(nip05Domain({ PUBLIC_BASE_URL: 'https://21.gifts' })).toBe('21.gifts');
    expect(nip05Domain({ PUBLIC_BASE_URL: 'https://dev.21.gifts/' })).toBe('dev.21.gifts');
    expect(nip05Domain({ PUBLIC_BASE_URL: 'http://127.0.0.1:3000' })).toBeNull();
    expect(nip05Domain({ PUBLIC_BASE_URL: 'not-a-url' })).toBeNull();
    expect(nip05Domain({})).toBeNull();
    const taken = new Set<string>(['ada', 'ada-11111111']);
    expect(allocateNip05Local('Ada', '11111111-1111-1111-1111-111111111111', taken)).toContain(
      'ada-',
    );
  });

  it('builds nostr.json names and relays', async () => {
    const auth = new InMemoryAuthStore();
    const ada = account({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ada',
      createdAt: 1,
    });
    await auth.createAccount(ada);
    await auth.createAccount(
      account({
        id: '00000000-0000-4000-8000-000000000003',
        name: 'NoKey',
        createdAt: 2,
        viewKey: 'ee'.repeat(32),
      }),
    );
    await auth.createAccount(
      account({
        id: '00000000-0000-4000-8000-00000000000a',
        name: 'Zed',
        createdAt: 1,
        viewKey: 'ff'.repeat(32),
      }),
    );
    await auth.setNostrKeyIfAbsent('00000000-0000-4000-8000-00000000000a', {
      pubkey: 'bb'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    await auth.setNostrKeyIfAbsent(ada.id, {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const body = await buildNostrJson(auth, { NOSTR_PUBLISH: '1' }, 'ada');
    expect(body.names['ada']).toBe('aa'.repeat(32));
    expect(body.relays['aa'.repeat(32)]?.length).toBeGreaterThan(0);
    const identifier = nip05Identifier(ada, [ada], '21.gifts');
    expect(identifier).toBe('ada@21.gifts');
    const skipped = account({
      id: '00000000-0000-4000-8000-000000000099',
      name: '   ',
      createdAt: 0,
    });
    expect(nip05Identifier(ada, [skipped, ada], '21.gifts')).toBe('ada@21.gifts');
    const unknown = account({ id: '00000000-0000-4000-8000-000000000002', name: 'Bob' });
    expect(nip05Identifier(unknown, [ada], '21.gifts')).toBe('bob@21.gifts');
    const all = await buildNostrJson(auth, {}, '');
    expect(all.names['ada']).toBe('aa'.repeat(32));
  });
});
