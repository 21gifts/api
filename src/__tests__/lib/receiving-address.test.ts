import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  accountByReceivingAddress,
  lnurlServerFetch,
  receivingAddress,
  type ReceivingAccount,
} from '@/lib/receiving-address';
import { createWalletAccount, LNURL_SERVER, WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';

const config: LnurlServerConfig = {
  baseUrl: 'http://lnurl.internal:8080',
  publicBaseUrl: 'https://21.gifts',
  host: '21.gifts',
};
const KEY = `02${'a'.repeat(64)}`;

function without(key: keyof ReceivingAccount): ReceivingAccount {
  const copy: Partial<ReceivingAccount> = { ...account() };
  delete copy[key];
  return copy as ReceivingAccount;
}

function account(partial: Partial<ReceivingAccount> = {}): ReceivingAccount {
  return {
    username: ' Alice ',
    sparkPubkey: KEY,
    sparkPubkeyVerifiedAt: 1,
    ...partial,
  };
}

describe('receivingAddress', () => {
  it('uses the wallet-backed address for a verified wallet', () => {
    expect(receivingAddress(account(), config)).toEqual({
      address: 'alice@21.gifts',
      sparkPubkey: KEY,
    });
  });

  it('returns null without a verified wallet, a username, or the LNURL server', () => {
    expect(receivingAddress(account(), undefined)).toBeNull();
    expect(receivingAddress(account({ sparkPubkeyVerifiedAt: null }), config)).toBeNull();
    expect(receivingAddress(without('sparkPubkeyVerifiedAt'), config)).toBeNull();
    expect(receivingAddress(account({ sparkPubkey: null }), config)).toBeNull();
    expect(receivingAddress(without('sparkPubkey'), config)).toBeNull();
    expect(receivingAddress(account({ username: '  ' }), config)).toBeNull();
    expect(receivingAddress(account({ username: null }), config)).toBeNull();
    expect(receivingAddress(without('username'), config)).toBeNull();
  });
});

describe('accountByReceivingAddress', () => {
  const walletConfig = { ...LNURL_SERVER, host: 'Example.Test' };

  async function seeded(): Promise<InMemoryAuthStore> {
    const store = new InMemoryAuthStore();
    await createWalletAccount(store, '00000000-0000-4000-8000-000000000001', 'alice');
    await store.createAccount({
      id: '00000000-0000-4000-8000-000000000002',
      linkingKey: null,
      role: 'verified',
      name: 'bob',
      username: 'bob',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
    });
    return store;
  }

  it('finds the member by the wallet address, case-insensitively', async () => {
    const store = await seeded();
    const found = await accountByReceivingAddress(store, ' ALICE@Example.Test ', walletConfig);
    expect(found?.account.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(found?.receiving).toEqual({ address: 'alice@Example.Test', sparkPubkey: WALLET_PUBKEY });
  });

  it('finds nobody for other addresses or with the LNURL server off', async () => {
    const store = await seeded();
    for (const address of [
      'alice@example.com',
      'carol@example.test',
      'bob@example.test',
      '@example.test',
      'example.test',
      'alice @example.test',
    ]) {
      expect(await accountByReceivingAddress(store, address, walletConfig)).toBeUndefined();
    }
    expect(await accountByReceivingAddress(store, 'alice@example.test', undefined)).toBeUndefined();
  });
});

describe('lnurlServerFetch', () => {
  // `alice` has a verified wallet; `bob` has an account without one.
  const accounts = {
    getAccountByUsername: async (username: string): Promise<Account | undefined> => {
      if (username === 'alice') {
        return { sparkPubkeyVerifiedAt: 1 } as Account;
      }
      return username === 'bob' ? ({ sparkPubkeyVerifiedAt: null } as Account) : undefined;
    },
  };

  it('returns the given fetch when the LNURL server is off', () => {
    const fetchImpl: FetchFn = vi.fn();
    expect(lnurlServerFetch(undefined, fetchImpl, accounts)).toBe(fetchImpl);
  });

  it('sends the LUD-16 document of a username without a verified wallet over the public URL', async () => {
    const response = new Response('ok');
    const fetchImpl = vi.fn(async () => response);
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    for (const url of [
      'https://21.gifts/.well-known/lnurlp/bob',
      'https://21.gifts/.well-known/lnurlp/nobody',
      'https://21.gifts/.well-known/lnurlp/a%20b',
      'https://21.gifts/.well-known/lnurlp',
    ]) {
      expect(await routed(url)).toBe(response);
      expect(fetchImpl).toHaveBeenLastCalledWith(url, undefined);
    }
  });

  it('passes other hosts through unchanged', async () => {
    const response = new Response('ok');
    const fetchImpl = vi.fn(async () => response);
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    const init = { redirect: 'error' as const };
    expect(await routed('https://example.com/.well-known/lnurlp/a', init)).toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/.well-known/lnurlp/a', init);
  });

  it('sends the wallet-backed host to the LNURL server', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"pr":"lnbc1"}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-other': '1' },
        }),
    );
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    const response = await routed('https://21.gifts/lnurlp/alice/invoice?amount=1000&nostr=%7B%7D');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pr: 'lnbc1' });
    expect(response.headers.get('x-other')).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://lnurl.internal:8080/lnurlp/alice/invoice?amount=1000&nostr=%7B%7D');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ host: '21.gifts' });
  });

  it('accepts a Request and an empty upstream body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    const response = await routed(new Request('https://21.gifts/.well-known/lnurlp/alice'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://lnurl.internal:8080/.well-known/lnurlp/alice',
    );
  });

  it('rejects a refused segment and an unreachable LNURL server', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    await expect(routed('https://21.gifts/lnurlp/a%20b')).rejects.toThrow(
      'LNURL server request failed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(routed(new URL('https://21.gifts/lnurlp/alice'))).rejects.toThrow(TypeError);
  });
});
