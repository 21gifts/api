import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { VERIFICATION_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { parseNostrKek } from '@/lib/nostr/kek';
import { bearerToken, meRoutes } from '@/routes/me';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;
let nip57: { mockRestore: () => void };

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const bolt11 = await import('@/lib/bolt11');
  nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
});

afterEach(() => {
  warn.mockRestore();
  nip57.mockRestore();
});

const now = (): number => 1_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;
const VIEW_KEY = 'a'.repeat(64);
const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc10n1testinvoice';
const NOSTR_KEK = parseNostrKek('cd'.repeat(32));

interface MountOpts {
  payer?: InvoicePayer;
  fetchImpl?: FetchFn;
  clock?: () => number;
}

function mount(store: InMemoryAuthStore, opts: MountOpts = {}): Hono {
  return new Hono().route(
    '/me',
    meRoutes({
      store,
      now: opts.clock ?? now,
      payer: opts.payer ?? new UnconfiguredInvoicePayer(),
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
      nostrKek: NOSTR_KEK,
    }),
  );
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(
  overrides: { lightningAddress?: string | null; verified?: boolean } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: null,
    lightningAddress: overrides.lightningAddress ?? null,
    lightningAddressVerified: overrides.verified ?? false,
    forumLawsDismissed: false,
    viewKey: VIEW_KEY,
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  return store;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake LNURL-pay that always yields zap-capable metadata and a 1-sat invoice. */
function happyFetch(): FetchFn {
  return async (input) => {
    if (String(input).includes('/.well-known/lnurlp/')) {
      return jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: 100_000_000_000,
        commentAllowed: 255,
        allowsNostr: true,
        nostrPubkey: 'aa'.repeat(32),
      });
    }
    return jsonResponse({ pr: PR });
  };
}

function okPayer(paid: string[] = []): InvoicePayer {
  return {
    isConfigured: () => true,
    payInvoice: async (bolt11): Promise<PayInvoiceResult> => {
      paid.push(bolt11);
      return { ok: true };
    },
  };
}

describe('GET /me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the account for a valid session', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      role: string;
      name: string | null;
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
      viewKey: string;
      rulesAgreedAt: number | null;
      setup: 'name' | 'lightning-address' | 'rules' | null;
    };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('basis');
    expect(body.name).toBeNull();
    expect(body.lightningAddress).toBeNull();
    expect(body.lightningAddressVerified).toBe(false);
    expect(body.viewKey).toBe(VIEW_KEY);
    expect(body.rulesAgreedAt).toBeNull();
    expect(body.setup).toBe('name');
  });
});

describe('POST /me/forum-laws-dismissed', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/forum-laws-dismissed', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('sets forumLawsDismissed on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/forum-laws-dismissed', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forumLawsDismissed: boolean };
    expect(body.forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.forum_laws.dismissed' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('is idempotent on a second POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const before = warn.mock.calls.length;
    const res = await app.request('/me/forum-laws-dismissed', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { forumLawsDismissed: boolean }).forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
    const dismissLogs = parsedEvents(warn)
      .slice(before)
      .filter((e) => e['event'] === 'account.forum_laws.dismissed');
    expect(dismissLogs).toHaveLength(0);
  });

  it('includes forumLawsDismissed true on GET /me after dismiss', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const res = await app.request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { forumLawsDismissed: boolean }).forumLawsDismissed).toBe(true);
  });

  it('does not clear forumLawsDismissed when setting a name', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const res = await app.request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; forumLawsDismissed: boolean };
    expect(body.name).toBe('Ada');
    expect(body.forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
  });
});

describe('POST /me/rules-agreement', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/rules-agreement', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('records the first agreement using the injected clock', async () => {
    const store = await seededStore();
    const agreedAt = 2_000_000;
    const res = await mount(store, { clock: () => agreedAt }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rulesAgreedAt: number | null };
    expect(body.rulesAgreedAt).toBe(agreedAt);
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(agreedAt);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.rules_agreement.set')).toBe(true);
  });

  it('keeps the original timestamp on later POSTs', async () => {
    const store = await seededStore();
    const first = 2_000_000;
    await mount(store, { clock: () => first }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    const res = await mount(store, { clock: () => 9_000_000 }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ agreedAt: 9_000_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rulesAgreedAt: number | null };
    expect(body.rulesAgreedAt).toBe(first);
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(first);
    const agreeEvents = parsedEvents(warn).filter(
      (e) => e['event'] === 'account.rules_agreement.set',
    );
    expect(agreeEvents).toHaveLength(1);
  });

  it('keeps the timestamp when the name or address changes', async () => {
    const store = await seededStore();
    const agreedAt = 2_000_000;
    await mount(store, { clock: () => agreedAt }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    const named = await mount(store, { fetchImpl: happyFetch() }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(named.status).toBe(200);
    expect(((await named.json()) as { rulesAgreedAt: number | null }).rulesAgreedAt).toBe(agreedAt);
    const linked = await mount(store, { fetchImpl: happyFetch() }).request(
      '/me/lightning-address',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ address: ADDRESS }),
      },
    );
    expect(linked.status).toBe(200);
    expect(((await linked.json()) as { rulesAgreedAt: number | null }).rulesAgreedAt).toBe(
      agreedAt,
    );
    const unlinked = await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(unlinked.status).toBe(200);
    expect(((await unlinked.json()) as { rulesAgreedAt: number | null }).rulesAgreedAt).toBe(
      agreedAt,
    );
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(agreedAt);
  });
});

describe('POST /me/name', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "name" string' });
  });

  it('rejects a body without a name string', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "name" string' });
  });

  it('rejects an empty name', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('rejects an over-long name', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A'.repeat(81) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('rejects a name with a newline', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada\nLovelace' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('trims, stores, and returns the name', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Ada  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; viewKey: string };
    expect(body.name).toBe('Ada');
    expect(body.viewKey).toBe(VIEW_KEY);
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'account.name.set' && e['accountId'] === 'acc'),
    ).toBe(true);
  });

  it('keeps a previously stored lightning address when setting a name', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; lightningAddress: string | null };
    expect(body.name).toBe('Ada');
    expect(body.lightningAddress).toBe(ADDRESS);
  });

  it('replaces an existing name', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return;
    }
    await store.updateAccount({ ...existing, name: 'Ada' });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Bob');
    expect((await store.getAccount('acc'))?.name).toBe('Bob');
  });
});

describe('POST /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(401);
  });

  it('links a valid Lightning Address', async () => {
    const store = await seededStore();
    const res = await mount(store, { fetchImpl: happyFetch() }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBe(ADDRESS);
    expect(body.lightningAddressVerified).toBe(false);
    expect((await store.getAccount('acc'))?.lightningAddress).toBe(ADDRESS);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.lightning_address.linked' &&
          e['accountId'] === 'acc' &&
          e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('returns 409 when the Lightning Address belongs to another account', async () => {
    const store = await seededStore();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      lightningAddress: ADDRESS,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    const res = await mount(store, { fetchImpl: happyFetch() }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Lightning Address is already in use' });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });

  it('returns 409 when updateAccount silently refuses a taken address', async () => {
    class SilentStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress(): Promise<undefined> {
        return undefined;
      }
      override async updateAccount(): Promise<void> {
        return;
      }
    }
    const store = new SilentStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store, { fetchImpl: happyFetch() }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Lightning Address is already in use' });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });

  it('clears a pending verification when linking', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store, { fetchImpl: happyFetch() }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'bob@getalby.com' }),
    });
    expect(res.status).toBe(200);
    expect(await store.getVerification('acc')).toBeUndefined();
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(await seededStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid Lightning Address without calling fetch', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      fetchCalls.push(String(input));
      return jsonResponse({});
    };
    const res = await mount(await seededStore(), { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
    expect(fetchCalls).toEqual([]);
  });

  it('rejects an unreachable well-known without saving', async () => {
    const store = await seededStore({ lightningAddress: 'keep@example.com' });
    const fetchImpl: FetchFn = async () => jsonResponse({}, 502);
    const res = await mount(store, { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBe('keep@example.com');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.lightning_address.resolve_failed' &&
          e['accountId'] === 'acc' &&
          e['address'] === ADDRESS,
      ),
    ).toBe(true);
  });

  it('rejects metadata without allowsNostr without saving', async () => {
    const store = await seededStore();
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: PR });
    };
    const res = await mount(store, { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });

  it('rejects allowsNostr without nostrPubkey without saving', async () => {
    const store = await seededStore();
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          allowsNostr: true,
        });
      }
      return jsonResponse({ pr: PR });
    };
    const res = await mount(store, { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });

  it('rejects allowsNostr with empty nostrPubkey without saving', async () => {
    const store = await seededStore();
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          allowsNostr: true,
          nostrPubkey: '',
        });
      }
      return jsonResponse({ pr: PR });
    };
    const res = await mount(store, { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });

  it('rejects allowsNostr with whitespace-only nostrPubkey without saving', async () => {
    const store = await seededStore();
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          allowsNostr: true,
          nostrPubkey: '   ',
        });
      }
      return jsonResponse({ pr: PR });
    };
    const res = await mount(store, { fetchImpl }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
  });
});

describe('DELETE /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('unlinks the address and clears pending verification', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    const existing = await store.getAccount('acc');
    await store.updateAccount({ ...existing!, name: 'Ada' });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string | null;
      setup: 'name' | 'lightning-address' | 'rules' | null;
    };
    expect(body.lightningAddress).toBeNull();
    expect(body.setup).toBe('lightning-address');
    expect((await store.getAccount('acc'))?.lightningAddress).toBeNull();
    expect(await store.getVerification('acc')).toBeUndefined();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.lightning_address.unlinked' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });
});

describe('POST /me/lightning-address/verification', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address/verification', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 409 when no address is linked', async () => {
    const res = await mount(await seededStore(), {
      payer: okPayer(),
      fetchImpl: happyFetch(),
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Lightning Address linked' });
  });

  it('returns 409 when already verified', async () => {
    const res = await mount(await seededStore({ lightningAddress: ADDRESS, verified: true }), {
      payer: okPayer(),
      fetchImpl: happyFetch(),
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Lightning Address already verified' });
  });

  it('returns 503 when the payer is not configured without calling LNURL', async () => {
    const fetchCalls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      fetchCalls.push(String(input));
      return jsonResponse({});
    };
    const res = await mount(await seededStore({ lightningAddress: ADDRESS }), {
      payer: new UnconfiguredInvoicePayer(),
      fetchImpl,
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Verification payments are not configured',
    });
    expect(fetchCalls).toEqual([]);
  });

  it('returns 502 when the address is unreachable', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 502);
    const res = await mount(await seededStore({ lightningAddress: ADDRESS }), {
      payer: okPayer(),
      fetchImpl,
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Lightning Address did not accept the verification payment',
    });
  });

  it('returns 200 sent with expiresInSeconds and sats (no nonce)', async () => {
    const paid: string[] = [];
    const callbackUrls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          commentAllowed: 255,
        });
      }
      callbackUrls.push(url);
      return jsonResponse({ pr: PR });
    };
    const store = await seededStore({ lightningAddress: ADDRESS });
    const res = await mount(store, { payer: okPayer(paid), fetchImpl }).request(
      '/me/lightning-address/verification',
      { method: 'POST', headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'sent',
      expiresInSeconds: Math.floor(VERIFICATION_TTL_MS / 1000),
      sats: 1,
    });
    expect(body).not.toHaveProperty('nonce');
    expect(paid).toEqual([PR]);
    const callbackUrl = callbackUrls[0];
    expect(callbackUrl).toBeDefined();
    expect(new URL(callbackUrl ?? '').searchParams.get('comment')).toMatch(
      /^21gifts [0-9a-f]{32}$/,
    );
    expect(await store.getVerification('acc')).toBeDefined();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.verification.started' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).every((e) => !('nonce' in e))).toBe(true);
  });
});

describe('POST /me/lightning-address/verification/confirm', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: 'a'.repeat(32) }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for a missing nonce string', async () => {
    const res = await mount(await seededStore({ lightningAddress: ADDRESS })).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "nonce" string',
    });
  });

  it('returns 400 for an incorrect nonce', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'b'.repeat(32) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Incorrect verification code' });
  });

  it('returns 400 for an empty nonce after trim', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Incorrect verification code' });
  });

  it('returns 409 when no verification is in progress', async () => {
    const res = await mount(await seededStore({ lightningAddress: ADDRESS })).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: 'a'.repeat(32) }),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No verification in progress' });
  });

  it('returns 409 when the verification has expired', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store, {
      clock: () => 1_000_000 + VERIFICATION_TTL_MS + 1,
    }).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Verification expired' });
  });

  it('returns 200 and flips lightningAddressVerified on success', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'c'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'c'.repeat(32) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBe(ADDRESS);
    expect(body.lightningAddressVerified).toBe(true);
    expect((await store.getAccount('acc'))?.lightningAddressVerified).toBe(true);
    expect(await store.getVerification('acc')).toBeUndefined();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.verification.confirmed' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
    expect(parsedEvents(warn).every((e) => !('nonce' in e))).toBe(true);
  });

  it('returns 409 after link clears a pending verification', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    await mount(store, { fetchImpl: happyFetch() }).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No verification in progress' });
  });

  it('returns 409 after unlink clears a pending verification', async () => {
    const store = await seededStore({ lightningAddress: ADDRESS });
    await store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    // Re-link so the account has an address again, but no pending record.
    await store.updateAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      lightningAddress: ADDRESS,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
  });
});

describe('bearerToken', () => {
  it('returns null for a missing header', async () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', async () => {
    expect(bearerToken('Basic abc')).toBeNull();
  });

  it('returns null for an empty token', async () => {
    expect(bearerToken('Bearer ')).toBeNull();
  });

  it('returns null for a whitespace-only token', async () => {
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('extracts a present token', async () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });
});
