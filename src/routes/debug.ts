import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { z } from 'zod';
import { serializeDebugAccount } from '@/lib/auth/account-json';
import { randomHex } from '@/lib/auth/hex';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import { issueSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { normalizeDisplayName } from '@/lib/name';
import { LIGHTNING_ADDRESS_NOT_ZAP, probeNip57Mint } from '@/lib/nip57-probe';
import { publicKeyHexFromSecret } from '@/lib/nostr/keys';
import type { ConversationStore } from '@/lib/conversation-store';
import type { PushStore } from '@/lib/push-store';

/**
 * Operator debug surface for registered accounts.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * Exposes `GET /` (list), `POST /` (provision), `PATCH /:id`
 * (set role, unlink Lightning Address, and/or the official platform flag),
 * and `POST /:id/session` (mint a member bearer).
 */

/** Collaborators the debug routes need. */
export interface DebugRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Injected `fetch` for NIP-57 mint probe on new addresses. */
  fetchImpl: FetchFn;
  /**
   * Private-message store. When set, `PATCH platform: true` points every
   * member→platform thread at the new official account.
   */
  conversationStore?: ConversationStore;
  /** Forum store for profile notes after provisioned name writes. */
  messageStore?: MessageStore;
  /** Optional push outbox for profile-note create. */
  pushStore?: PushStore;
  /** Clock for minted debug sessions. Defaults to `Date.now`. */
  now?: () => number;
}

/** Body schema for operator role, Lightning Address unlink, and platform flag. */
const patchBody = z
  .object({
    role: z.enum(['basis', 'verified', 'moderator', 'founder']).optional(),
    lightningAddress: z.null().optional(),
    platform: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.role !== undefined || body.lightningAddress === null || body.platform !== undefined,
  );

/** One row in the operator provision body. */
const provisionAccountRow = z.object({
  name: z.string().trim().min(1).max(80),
  lightningAddress: z
    .string()
    .trim()
    .refine((value) => {
      const at = value.indexOf('@');
      return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
    }),
});

/** Body schema for operator account provisioning. */
const provisionBody = z.object({
  accounts: z.array(provisionAccountRow).min(1).max(100),
});

/** Shared 503/401 gate for every `/debug/accounts` method. */
function requireDebugToken(deps: DebugRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

/**
 * Build the `/debug/accounts` route group.
 *
 * @param deps - Store, optional debug token, required `fetchImpl` for the NIP-57 mint probe, optional `conversationStore`, optional `now`.
 * @returns A Hono app exposing `GET /`, `POST /`, `PATCH /:id`, and `POST /:id/session`.
 */
export function debugRoutes(deps: DebugRouteDeps): Hono {
  return new Hono()
    .use('*', requireDebugToken(deps))
    .get('/', async (c) => {
      const accounts = await deps.store.listAccounts();
      logEvent('debug.accounts.listed', { count: accounts.length });
      return c.json({ accounts: accounts.map(serializeDebugAccount) }, 200);
    })
    .post('/', async (c) => {
      const parsed = provisionBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accounts" array' }, 400);
      }
      const accounts: Array<{ name: string; lightningAddress: string }> = [];
      for (const raw of parsed.data.accounts) {
        const name = normalizeDisplayName(raw.name);
        const lightningAddress = normalizeLightningAddress(raw.lightningAddress);
        if (name === null || lightningAddress === null) {
          return c.json({ error: 'Expected a JSON body with an "accounts" array' }, 400);
        }
        accounts.push({ name, lightningAddress });
      }
      const classified: Array<{
        name: string;
        lightningAddress: string;
        existing: Account | undefined;
      }> = [];
      for (const row of accounts) {
        classified.push({
          name: row.name,
          lightningAddress: row.lightningAddress,
          existing: await deps.store.getAccountByLightningAddress(row.lightningAddress),
        });
      }
      const skipNip57Probe = process.env['NIP57_PROBE'] === '0';
      for (const row of classified) {
        if (row.existing !== undefined) {
          continue;
        }
        if (skipNip57Probe) {
          continue;
        }
        const ephemeral = generateSecretKey();
        const recipientPubkey = publicKeyHexFromSecret(ephemeral);
        const probe = await probeNip57Mint({
          address: row.lightningAddress,
          recipientPubkey,
          sign: async (unsigned) =>
            finalizeEvent(unsigned, ephemeral) as unknown as Record<string, unknown>,
          fetchImpl: deps.fetchImpl,
          env: process.env,
        });
        ephemeral.fill(0);
        if (probe === 'not_zap') {
          return c.json({ error: LIGHTNING_ADDRESS_NOT_ZAP }, 400);
        }
        if (probe === 'unreachable') {
          return c.json({ error: 'Lightning Address could not be resolved' }, 400);
        }
      }
      let created = 0;
      let updated = 0;
      const results: Array<{
        name: string;
        lightningAddress: string;
        viewKey: string;
        created: boolean;
      }> = [];
      const clock = deps.now ?? Date.now;
      for (const row of classified) {
        if (row.existing !== undefined) {
          const named = await deps.store.updateAccountNameByLightningAddress(
            row.lightningAddress,
            row.name,
          );
          if (named === undefined || named.name !== row.name) {
            return c.json({ error: 'Could not save the account' }, 500);
          }
          if (deps.messageStore !== undefined) {
            const ensured = await ensureProfileMessage({
              auth: deps.store,
              messages: deps.messageStore,
              account: named,
              now: clock,
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
            });
            if (ensured.profileMessageId !== named.profileMessageId) {
              await deps.store.updateAccount(ensured);
            }
          }
          updated += 1;
          results.push({
            name: named.name,
            lightningAddress: named.lightningAddress ?? row.lightningAddress,
            viewKey: named.viewKey,
            created: false,
          });
          continue;
        }
        const viewKey = randomHex(32);
        await deps.store.createAccount({
          id: crypto.randomUUID(),
          linkingKey: null,
          role: 'basis',
          name: row.name,
          lightningAddress: row.lightningAddress,
          lightningAddressVerified: false,
          forumLawsDismissed: false,
          viewKey,
          createdAt: clock(),
          rulesAgreedAt: null,
          nameSkippedAt: null,
          lightningAddressSkippedAt: null,
          profileMessageId: null,
        });
        const stored = await deps.store.getAccountByLightningAddress(row.lightningAddress);
        if (stored === undefined) {
          return c.json({ error: 'Could not save the account' }, 500);
        }
        const didCreate = stored.viewKey === viewKey;
        if (didCreate) {
          if (deps.messageStore !== undefined) {
            const ensured = await ensureProfileMessage({
              auth: deps.store,
              messages: deps.messageStore,
              account: stored,
              now: clock,
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
            });
            if (ensured.profileMessageId !== stored.profileMessageId) {
              await deps.store.updateAccount(ensured);
            }
          }
          created += 1;
          results.push({
            name: stored.name ?? row.name,
            lightningAddress: stored.lightningAddress ?? row.lightningAddress,
            viewKey: stored.viewKey,
            created: true,
          });
        } else {
          const named = await deps.store.updateAccountNameByLightningAddress(
            row.lightningAddress,
            row.name,
          );
          if (named === undefined || named.name !== row.name) {
            return c.json({ error: 'Could not save the account' }, 500);
          }
          if (deps.messageStore !== undefined) {
            const ensured = await ensureProfileMessage({
              auth: deps.store,
              messages: deps.messageStore,
              account: named,
              now: clock,
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
            });
            if (ensured.profileMessageId !== named.profileMessageId) {
              await deps.store.updateAccount(ensured);
            }
          }
          updated += 1;
          results.push({
            name: named.name,
            lightningAddress: named.lightningAddress ?? row.lightningAddress,
            viewKey: named.viewKey,
            created: false,
          });
        }
      }
      logEvent('debug.accounts.provisioned', { created, updated });
      return c.json({ accounts: results }, 200);
    })
    .patch('/:id', async (c) => {
      const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          {
            error:
              'Expected a JSON body with a "role" string, lightningAddress null, and/or platform boolean',
          },
          400,
        );
      }
      const existing = await deps.store.getAccount(c.req.param('id'));
      if (existing === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const updated = { ...existing };
      if (parsed.data.role !== undefined) {
        updated.role = parsed.data.role;
      }
      if (parsed.data.lightningAddress === null) {
        updated.lightningAddress = null;
        updated.lightningAddressVerified = false;
        updated.lightningAddressSkippedAt = null;
      }
      if (parsed.data.platform !== undefined) {
        updated.isPlatform = parsed.data.platform;
      }
      await deps.store.updateAccount(updated);
      if (parsed.data.lightningAddress === null) {
        await deps.store.deleteVerification(updated.id);
        logEvent('debug.accounts.lightning_address.cleared', { accountId: updated.id });
      }
      if (parsed.data.role !== undefined) {
        logEvent('debug.accounts.role_set', { accountId: updated.id, role: updated.role });
      }
      if (parsed.data.platform !== undefined) {
        logEvent('debug.accounts.platform_set', {
          accountId: updated.id,
          platform: updated.isPlatform === true,
        });
      }
      if (parsed.data.platform === true && deps.conversationStore !== undefined) {
        await deps.conversationStore.retargetMemberPlatform(updated.id);
      }
      return c.json(serializeDebugAccount(updated), 200);
    })
    .post('/:id/session', async (c) => {
      const existing = await deps.store.getAccount(c.req.param('id'));
      if (existing === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const now = deps.now ?? Date.now;
      const minted = await issueSession(deps.store, now(), existing);
      logEvent('debug.accounts.session_minted', { accountId: existing.id });
      return c.json({ token: minted.token }, 200);
    });
}
