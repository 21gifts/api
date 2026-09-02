import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { normalizeDisplayName } from '@/lib/name';
import { serializeOwnerAccount } from '@/lib/auth/account-json';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { InvoicePayer } from '@/lib/invoice-payer';
import { logEvent } from '@/lib/log';
import { resolveLnurlp, type FetchFn } from '@/lib/lnurlp';
import type { MessageStore } from '@/lib/message-store';
import { LIGHTNING_ADDRESS_NOT_ZAP, probeNip57Mint } from '@/lib/nip57-probe';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { signEventForAccount } from '@/lib/nostr/sign';
import type { PushStore } from '@/lib/push-store';
import { confirmVerification, startVerification } from '@/lib/verification';

/**
 * `/me` — the authenticated account and its editable profile (display name,
 * welcome-forum laws dismiss, living-room rules agreement, and the receiver's
 * Lightning Address), including proof-of-control verification. Shares the
 * {@link AuthStore} instance with `/auth`.
 */

/** Collaborators the `/me` routes need. */
export interface MeRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Forum persistence (profile notes on first name). */
  messages: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Pays the verification micro-payment invoice. */
  payer: InvoicePayer;
  /** Injected `fetch` for LNURL-pay resolution. */
  fetchImpl: FetchFn;
  /** AES KEK for signing the NIP-57 mint probe; omit when unset. */
  nostrKek?: Uint8Array;
  /** Optional push outbox; profile-note create enqueues when present. */
  pushStore?: PushStore;
}

/**
 * Extract the bearer token from an `Authorization` header value.
 *
 * @param header - The raw header value, or `undefined` when absent.
 * @returns The token, or `null` when the header is missing, uses another
 * scheme, or carries an empty token.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MeRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.store, deps.now(), token);
}

/**
 * Re-read the account after an await so a concurrent profile write is not
 * overwritten by a stale spread of the pre-await snapshot.
 *
 * @param deps - Store and collaborators.
 * @param id - Account id from the authorized snapshot.
 * @returns The latest stored account, or `null` if it disappeared.
 */
async function storedAccount(deps: MeRouteDeps, id: string): Promise<Account | null> {
  const current = await deps.store.getAccount(id);
  /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
  if (current === undefined) {
    return null;
  }
  return current;
}

/** Body schema for setting a display name. */
const nameBody = z.object({ name: z.string() });

/** Body schema for linking a Lightning Address. */
const addressBody = z.object({ address: z.string() });

/** Body schema for confirming address verification. */
const confirmBody = z.object({ nonce: z.string() });

/** Body schema for skipping a wizard step. */
const skipBody = z.object({ step: z.enum(['name', 'lightning-address']) });

/**
 * Build the `/me` route group.
 *
 * @param deps - Shared store, message store, clock, payer, fetch, optional push, and optional `nostrKek` for the NIP-57 mint probe.
 * @returns A Hono app exposing account, display-name, setup skip, forum-laws dismiss,
 * living-room rules agreement, link/unlink, and verification routes.
 */
export function meRoutes(deps: MeRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(serializeOwnerAccount(account), 200);
    })
    .post('/setup/skip', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = skipBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with step "name" or "lightning-address"' },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const skippedAt = deps.now();
      const updated: Account =
        parsed.data.step === 'name'
          ? { ...current, nameSkippedAt: skippedAt }
          : { ...current, lightningAddressSkippedAt: skippedAt };
      await deps.store.updateAccount(updated);
      logEvent('account.setup.skipped', { accountId: current.id, step: parsed.data.step });
      return c.json(serializeOwnerAccount(updated), 200);
    })
    .post('/name', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "name" string' }, 400);
      }
      const name = normalizeDisplayName(parsed.data.name);
      if (name === null) {
        return c.json({ error: 'Name must be 1–80 characters' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const withName: Account = { ...current, name };
      const ensured = await ensureProfileMessage({
        auth: deps.store,
        messages: deps.messages,
        account: withName,
        now: deps.now,
        ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
      });
      const named: Account = { ...ensured, name };
      await deps.store.updateAccount(named);
      logEvent('account.name.set', { accountId: current.id });
      return c.json(serializeOwnerAccount(named), 200);
    })
    .post('/forum-laws-dismissed', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.forumLawsDismissed === true) {
        return c.json(serializeOwnerAccount(current), 200);
      }
      const updated: Account = { ...current, forumLawsDismissed: true };
      await deps.store.updateAccount(updated);
      logEvent('account.forum_laws.dismissed', { accountId: current.id });
      return c.json(serializeOwnerAccount(updated), 200);
    })
    .post('/rules-agreement', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.rulesAgreedAt !== null) {
        return c.json(serializeOwnerAccount(current), 200);
      }
      const updated: Account = { ...current, rulesAgreedAt: deps.now() };
      await deps.store.updateAccount(updated);
      logEvent('account.rules_agreement.set', { accountId: current.id });
      return c.json(serializeOwnerAccount(updated), 200);
    })
    .post('/lightning-address', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = addressBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "address" string' }, 400);
      }
      const address = normalizeLightningAddress(parsed.data.address);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }
      const resolved = await resolveLnurlp({ address, fetchImpl: deps.fetchImpl });
      const zapPubkey =
        resolved.ok && resolved.metadata.allowsNostr === true
          ? resolved.metadata.nostrPubkey
          : undefined;
      if (zapPubkey === undefined || zapPubkey.trim() === '') {
        logEvent('account.lightning_address.resolve_failed', {
          accountId: account.id,
          address,
        });
        return c.json({ error: 'Lightning Address could not be resolved' }, 400);
      }
      const kek = deps.nostrKek;
      if (kek === undefined) {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      try {
        await ensureAccountNostrKey(deps.store, account.id, kek);
      } catch {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      const accountPubkey = await deps.store.getNostrPublicKey(account.id);
      if (accountPubkey === undefined || accountPubkey === '') {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      const probe = await probeNip57Mint({
        address,
        recipientPubkey: accountPubkey,
        sign: async (unsigned) => {
          const signed = await signEventForAccount(deps.store, account.id, kek, unsigned);
          return { ...signed };
        },
        fetchImpl: deps.fetchImpl,
        env: process.env,
      });
      if (probe === 'not_zap') {
        logEvent('account.lightning_address.not_zap', { accountId: account.id });
        return c.json({ error: LIGHTNING_ADDRESS_NOT_ZAP }, 400);
      }
      if (probe === 'unreachable') {
        logEvent('account.lightning_address.resolve_failed', {
          accountId: account.id,
          address,
        });
        return c.json({ error: 'Lightning Address could not be resolved' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      // Linking a (new) address resets any prior verified state; proof of control
      // is a separate step. Any in-flight verification is dropped with the link.
      const owner = await deps.store.getAccountByLightningAddress(address);
      if (owner !== undefined && owner.id !== current.id) {
        return c.json({ error: 'Lightning Address is already in use' }, 409);
      }
      const updated: Account = {
        ...current,
        lightningAddress: address,
        lightningAddressVerified: false,
      };
      await deps.store.updateAccount(updated);
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if ((stored.lightningAddress ?? '').trim().toLowerCase() !== address.trim().toLowerCase()) {
        return c.json({ error: 'Lightning Address is already in use' }, 409);
      }
      await deps.store.deleteVerification(current.id);
      logEvent('account.lightning_address.linked', {
        accountId: account.id,
        address,
      });
      return c.json(serializeOwnerAccount(stored), 200);
    })
    .delete('/lightning-address', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = {
        ...current,
        lightningAddress: null,
        lightningAddressVerified: false,
        lightningAddressSkippedAt: null,
      };
      await deps.store.updateAccount(updated);
      await deps.store.deleteVerification(account.id);
      logEvent('account.lightning_address.unlinked', { accountId: account.id });
      return c.json(serializeOwnerAccount(updated), 200);
    })
    .post('/lightning-address/verification', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const result = await startVerification({
        store: deps.store,
        payer: deps.payer,
        fetchImpl: deps.fetchImpl,
        now: deps.now(),
        account,
      });
      if (!result.ok) {
        switch (result.code) {
          case 'no_address':
            return c.json({ error: 'No Lightning Address linked' }, 409);
          case 'already_verified':
            return c.json({ error: 'Lightning Address already verified' }, 409);
          case 'not_configured':
            return c.json({ error: 'Verification payments are not configured' }, 503);
          case 'unreachable':
            return c.json(
              { error: 'Lightning Address did not accept the verification payment' },
              502,
            );
        }
      }
      // Do not return the nonce — the user must read it from the wallet history.
      logEvent('account.verification.started', { accountId: account.id });
      return c.json(
        {
          status: 'sent',
          expiresInSeconds: result.expiresInSeconds,
          sats: result.sats,
        },
        200,
      );
    })
    .post('/lightning-address/verification/confirm', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = confirmBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "nonce" string' }, 400);
      }
      const result = await confirmVerification(deps.store, deps.now(), account, parsed.data.nonce);
      if (!result.ok) {
        switch (result.code) {
          case 'bad_nonce':
          case 'mismatch':
            return c.json({ error: 'Incorrect verification code' }, 400);
          case 'no_pending':
            return c.json({ error: 'No verification in progress' }, 409);
          case 'expired':
            return c.json({ error: 'Verification expired' }, 409);
        }
      }
      logEvent('account.verification.confirmed', { accountId: account.id });
      return c.json(serializeOwnerAccount(result.account), 200);
    });
}
