import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { LNURL_SERVER_TIMEOUT_MS } from '@/lib/lnurl-server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  accountByReceivingAddress,
  accountForPayableAddress,
  lnurlServerFetch,
  payableAddress,
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

  it('hands the LNURL server call the time left until a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response('{"pr":"lnbc1"}', { status: 200 }));
    let clock = 1_000;
    const routed = lnurlServerFetch(config, fetchImpl, accounts, {
      deadlineMs: 5_000,
      now: () => clock,
    });
    const response = await routed('https://21.gifts/lnurlp/alice/invoice?amount=1000');
    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // 5000 − 1000 ms left, not the default LNURL_SERVER_TIMEOUT_MS.
    expect(timeout.mock.calls).toEqual([[4_000]]);
    clock = 3_500;
    await routed('https://21.gifts/lnurlp/alice/invoice?amount=1000');
    expect(timeout.mock.calls).toEqual([[4_000], [1_500]]);
    clock = 5_000;
    await expect(routed('https://21.gifts/lnurlp/alice/invoice?amount=1000')).rejects.toThrow(
      'LNURL server request failed',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(2);
    // Other hosts ignore the deadline.
    expect((await routed('https://example.com/x')).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(2);
    timeout.mockRestore();
  });

  it('hands the LNURL server call LNURL_SERVER_TIMEOUT_MS without a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response('{"pr":"lnbc1"}', { status: 200 }));
    const routed = lnurlServerFetch(config, fetchImpl, accounts);
    expect((await routed('https://21.gifts/lnurlp/alice/invoice?amount=1000')).status).toBe(200);
    expect(timeout.mock.calls).toEqual([[LNURL_SERVER_TIMEOUT_MS]]);
    timeout.mockRestore();
  });
});

const LEGACY = 'Ada@Wallets.example';

function member(partial: Partial<Account> = {}): Account {
  return {
    id: '00000000-0000-4000-8000-000000000009',
    linkingKey: null,
    role: 'verified',
    name: 'ada',
    username: 'ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'c'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
    sparkPubkey: null,
    sparkPubkeyVerifiedAt: null,
    ...partial,
  };
}

describe('payableAddress', () => {
  it('uses the verified wallet and ignores the stored address', () => {
    expect(payableAddress({ ...account(), legacyLightningAddress: LEGACY }, config)).toBe(
      'alice@21.gifts',
    );
  });

  it('uses the stored address when the wallet is not ready, and null otherwise', () => {
    expect(
      payableAddress(
        { ...account({ sparkPubkeyVerifiedAt: null }), legacyLightningAddress: ` ${LEGACY} ` },
        config,
      ),
    ).toBe(LEGACY);
    expect(payableAddress({ ...account(), legacyLightningAddress: LEGACY }, undefined)).toBe(
      LEGACY,
    );
    expect(payableAddress(account({ sparkPubkeyVerifiedAt: null }), config)).toBeNull();
    expect(
      payableAddress(
        { ...account({ sparkPubkeyVerifiedAt: null }), legacyLightningAddress: 'not an address' },
        config,
      ),
    ).toBeNull();
    expect(
      payableAddress(
        { ...account({ sparkPubkeyVerifiedAt: null }), legacyLightningAddress: '   ' },
        config,
      ),
    ).toBeNull();
  });
});

describe('accountForPayableAddress', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  async function stored(): Promise<InMemoryAuthStore> {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      ...member({ id, viewKey: 'a'.repeat(64), username: 'alice', legacyLightningAddress: LEGACY }),
      walletRequired: true,
    });
    await store.createAccount(
      member({
        id: '00000000-0000-4000-8000-000000000002',
        viewKey: 'b'.repeat(64),
        username: 'blank',
        legacyLightningAddress: '   ',
      }),
    );
    await store.createAccount(
      member({
        id: '00000000-0000-4000-8000-000000000003',
        viewKey: 'd'.repeat(64),
        username: 'plain',
      }),
    );
    return store;
  }

  it('finds the stored address, and not a blank or missing one', async () => {
    const store = await stored();
    expect(await store.getAccountByLegacyLightningAddress('  ')).toBeUndefined();
    expect(
      await new InMemoryAuthStore().getAccountByLegacyLightningAddress(LEGACY),
    ).toBeUndefined();
    const found = await accountForPayableAddress(store, ' ada@wallets.example ', undefined);
    expect(found?.account.id).toBe(id);
    expect(found?.address).toBe(LEGACY);
    expect(
      await accountForPayableAddress(store, 'missing@wallets.example', config),
    ).toBeUndefined();
    expect(await accountForPayableAddress(store, 'not an address', undefined)).toBeUndefined();
  });

  it('keeps the stored address across updateAccount and refuses a later write', async () => {
    const store = await stored();
    const current = await store.getAccount(id);
    await store.updateAccount({
      ...current!,
      name: 'Changed',
      legacyLightningAddress: 'other@wallets.example',
    });
    expect((await store.getAccount(id))?.legacyLightningAddress).toBe(LEGACY);
    const plain = await store.getAccount('00000000-0000-4000-8000-000000000003');
    await store.updateAccount({ ...plain!, legacyLightningAddress: LEGACY });
    expect((await store.getAccount(plain!.id))?.legacyLightningAddress).toBeNull();
  });

  it('pays the wallet once it is verified and ignores the old address', async () => {
    const store = await stored();
    await store.claimSparkPubkey(id, WALLET_PUBKEY);
    expect(await store.markSparkPubkeyVerified(id, WALLET_PUBKEY, 'alice', 1)).toBe(true);
    const wallet = await accountForPayableAddress(store, 'alice@21.gifts', config);
    expect(wallet?.address).toBe('alice@21.gifts');
    expect(await accountForPayableAddress(store, LEGACY, config)).toBeUndefined();
    const off = await accountForPayableAddress(store, 'ada@wallets.example', undefined);
    expect(off?.address).toBe(LEGACY);
  });

  it('refuses a stored address the lookup did not ask for', async () => {
    const wrong = member({ legacyLightningAddress: 'other@wallets.example' });
    const invalid = member({ legacyLightningAddress: 'not an address' });
    const store = {
      getAccountByUsername: async () => undefined,
      getAccountByLegacyLightningAddress: async () => wrong,
    };
    expect(await accountForPayableAddress(store, LEGACY, undefined)).toBeUndefined();
    expect(
      await accountForPayableAddress(
        { ...store, getAccountByLegacyLightningAddress: async () => invalid },
        LEGACY,
        undefined,
      ),
    ).toBeUndefined();
  });
});
