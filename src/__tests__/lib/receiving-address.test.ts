import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { lnurlServerFetch, receivingAddress, type ReceivingAccount } from '@/lib/receiving-address';

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
    lightningAddress: ' alice@walletofsatoshi.com ',
    username: ' Alice ',
    sparkPubkey: KEY,
    sparkPubkeyVerifiedAt: 1,
    ...partial,
  };
}

describe('receivingAddress', () => {
  it('uses the wallet-backed address for a verified wallet', () => {
    expect(receivingAddress(account(), config)).toEqual({
      kind: 'wallet',
      address: 'alice@21.gifts',
      sparkPubkey: KEY,
    });
  });

  it('falls back to the linked address when the wallet cannot be used', () => {
    const external = { kind: 'external', address: 'alice@walletofsatoshi.com' };
    expect(receivingAddress(account(), undefined)).toEqual(external);
    expect(receivingAddress(account({ sparkPubkeyVerifiedAt: null }), config)).toEqual(external);
    expect(receivingAddress(without('sparkPubkeyVerifiedAt'), config)).toEqual(external);
    expect(receivingAddress(account({ sparkPubkey: null }), config)).toEqual(external);
    expect(receivingAddress(without('sparkPubkey'), config)).toEqual(external);
    expect(receivingAddress(account({ username: '  ' }), config)).toEqual(external);
    expect(receivingAddress(account({ username: null }), config)).toEqual(external);
    expect(receivingAddress(without('username'), config)).toEqual(external);
  });

  it('returns null without a wallet and without a linked address', () => {
    expect(receivingAddress(account({ lightningAddress: null }), undefined)).toBeNull();
    expect(
      receivingAddress(account({ lightningAddress: '  ', sparkPubkeyVerifiedAt: null }), config),
    ).toBeNull();
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
    expect(await routed('https://walletofsatoshi.com/.well-known/lnurlp/a', init)).toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://walletofsatoshi.com/.well-known/lnurlp/a',
      init,
    );
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
