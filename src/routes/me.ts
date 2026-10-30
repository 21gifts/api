import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { buildAccountActivity } from '@/lib/account-activity';
import { serializeOwnerAccountWithPosts, type OwnerAccountResponse } from '@/lib/auth/account-json';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import { encryptRecoveryShare, RECOVERY_SHARE_TEXT } from '@/lib/auth/recovery-share';
import { MISSING_REQUIREMENTS_ERROR } from '@/lib/auth/requirements';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore, HeldShareBoxPutResult, PreviousWallet } from '@/lib/auth/store';
import { isWrongAccount, WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { SESSION_TTL_MS, type LnurlServerConfig } from '@/lib/config';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { effectiveStatus, eligibleToday } from '@/lib/funding';
import { pingTodayMedia } from '@/lib/funding-ping';
import { normalizeLocation } from '@/lib/location';
import type { FetchFn } from '@/lib/lnurlp';
import { errorLogFields, logEvent } from '@/lib/log';
import {
  MESSAGE_MAX_LENGTH,
  decodeForumPhoto,
  forumPhotoResponse,
  normalizeForumText,
  normalizePhotoTakenAt,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { SpendPing } from '@/lib/spend-ping';
import type { ShopIdentityStore } from '@/lib/shop-identity';
import { syncWelcomePing } from '@/lib/welcome-media';
import { normalizeDisplayName } from '@/lib/name';
import { fetchSparkAddressBalance } from '@/lib/spark-explorer';
import { normalizeSparkPubkey } from '@/lib/spark-pubkey';
import { normalizeUsername, usernameFromDisplayName } from '@/lib/username';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { notifyForumPost } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';

/**
 * `/me` — the authenticated account and its editable profile (display name,
 * unique username, optional location, About me, welcome-forum laws dismiss,
 * living-room rules agreement, notification level, `POST /heart-notifications`, amount-entry unit, wallet backup seen,
 * and, when the LNURL server is configured, the wallet public-key bind
 * (`PUT /wallet`), the 21.gifts recovery share (`PUT /recovery-share`), and the
 * previous wallets of a social recovery (`GET /previous-wallets`,
 * `DELETE /previous-wallets/:sparkPubkey`), and the holder's own encrypted
 * held-share boxes (`GET /held-shares`, `PUT /held-shares/:id`,
 * `DELETE /held-shares/:id`). The verified wallet is the
 * member's only receiving address. Shares the {@link AuthStore} instance with
 * `/auth`.
 */

/** Collaborators the `/me` routes need. */
export interface MeRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Forum persistence (About me with or without a verified wallet, activity zaps/invoices, profile notes). */
  messages: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Optional push outbox; also the bell-subscriber list. */
  pushStore?: PushStore;
  /** Optional in-app notification store for profile-note create. */
  notificationStore?: NotificationStore;
  /** Optional inbox store; profile-note push payloads include listed unread when set. */
  conversationStore?: ConversationStore;
  /**
   * Outbound house gifts (default: empty {@link InMemoryGiftStore}).
   * Used by `GET /activity` and by the About-me welcome ping, where a
   * `welcome` gift with description `21gifts welcome` recorded under the username at or after the wallet
   * verification stops a second ping.
   */
  giftStore?: GiftStore;
  /**
   * Historical BTC-USD rates (default: empty {@link InMemoryBtcUsdStore}).
   * Empty activity stays 200 without calling Coinbase.
   */
  rates?: BtcUsdRateBook;
  /**
   * Historical USD→CHF/EUR/PHP crosses (default: empty {@link InMemoryFiatStore}).
   * Missing fiat never 503s the page.
   */
  fiatRates?: FiatRateBook;
  /**
   * Funding grants for owner JSON and for the daily ping after the first
   * recovery share (default: empty {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
  /**
   * Optional spend ping. After About me is saved, a verified account with a
   * live top-level photo or video (including this note) is welcome-pinged.
   * After the first recovery share of the current wallet is stored, an
   * account eligible today gets the daily ping of today's newest media post.
   * Omitted → skip. Failures do not fail the 200.
   */
  spendPing?: SpendPing;
  /**
   * LNURL server config. When set, mounts `PUT /wallet`, `PUT /recovery-share`,
   * `GET /previous-wallets`, and `DELETE /previous-wallets/:sparkPubkey`, and
   * resolves the receiving address in owner JSON and the welcome ping.
   * Omitted → off.
   */
  lnurlServer?: LnurlServerConfig;
  /**
   * `RECOVERY_SHARE_KEK` that encrypts the 21.gifts recovery share. Omitted
   * (memory boot) → `PUT /recovery-share` answers 503.
   */
  recoveryShareKek?: Uint8Array;
  /**
   * Fetch for the anonymous explorer balance of previous wallets (default
   * `globalThis.fetch`).
   */
  fetchImpl?: FetchFn;
  /**
   * Shop identities. With `shopKek` (or `nostrKek`), `PUT /me/about` creates
   * the key when the profile note becomes a public shop. Omitted → no shop keys.
   */
  shopIdentities?: ShopIdentityStore;
  /** KEK for new shop keys. Default `nostrKek`. */
  shopKek?: Uint8Array;
  /** Custodial nsec KEK; the default for `shopKek`. Omitted with `shopKek` → no shop keys. */
  nostrKek?: Uint8Array;
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

/** Body schema for setting a unique username. */
const usernameBody = z.object({ username: z.string() });

/** Body schema for setting a free-text profile location. */
const locationBody = z.object({ location: z.string() });

/** Body schema for binding the member's wallet public key. */
const walletBody = z.object({ sparkPubkey: z.string() });

/** Body schema for storing the 21.gifts recovery share. Unknown keys are 400. */
const recoveryShareBody = z.object({ sparkPubkey: z.string(), share: z.string() }).strict();

/** Single 400 copy for a missing or invalid recovery share body. */
const RECOVERY_SHARE_BODY_ERROR = 'Expected a JSON body with sparkPubkey and a recovery share';

/** 503 copy when the share cannot be stored (no `RECOVERY_SHARE_KEK`, or a store or crypto failure). */
const RECOVERY_SHARE_UNAVAILABLE = 'Social recovery is unavailable';

/** A held-share box id: 16 random bytes as 32 lowercase hex, chosen by the app. */
const HELD_SHARE_BOX_ID = /^[0-9a-f]{32}$/;

/** 400 copy for a box id that is not 32 lowercase hex characters. */
const HELD_SHARE_BOX_ID_ERROR = 'Expected a box id of 32 lowercase hex characters';

/** Most held-share boxes one account may have (checked on create only). */
const HELD_SHARE_BOX_LIMIT = 50;

/** Smallest box: version byte, 12-byte IV, and the 16-byte AES-GCM tag. */
const HELD_SHARE_MIN_BYTES = 29;

/** Largest box in bytes. */
const HELD_SHARE_MAX_BYTES = 1024;

/** Box format version, the first ciphertext byte. */
const HELD_SHARE_VERSION = 0x01;

/** Unpadded base64url of at most {@link HELD_SHARE_MAX_BYTES} bytes. */
const HELD_SHARE_BASE64URL = /^[A-Za-z0-9_-]{1,1366}$/;

/** Body schema for storing a held-share box. Unknown keys are 400. */
const heldShareBody = z.object({ ciphertext: z.string() }).strict();

/** Single 400 copy for a missing or invalid held-share box body. */
const HELD_SHARE_BODY_ERROR = 'Expected a JSON body with a held share ciphertext';

/** 503 copy when the held-share store fails. */
const HELD_SHARES_UNAVAILABLE = 'Held shares are unavailable';

/**
 * Decode a held-share ciphertext from canonical unpadded base64url and check
 * its size and version byte. The content stays opaque.
 *
 * @param text - Ciphertext as sent by the app.
 * @returns The bytes, or `null` when the text is not canonical base64url, the
 *   size is outside 29–1024 bytes, or the first byte is not `0x01`.
 */
function decodeHeldShareCiphertext(text: string): Uint8Array | null {
  if (!HELD_SHARE_BASE64URL.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64url');
  if (
    bytes.toString('base64url') !== text ||
    bytes.length < HELD_SHARE_MIN_BYTES ||
    bytes.length > HELD_SHARE_MAX_BYTES ||
    bytes[0] !== HELD_SHARE_VERSION
  ) {
    return null;
  }
  return new Uint8Array(bytes);
}

/** 503 copy of the previous-wallet routes, shared with `POST /me/wallet/report` (src/routes/wallet-report.ts). */
const WALLET_DATA_UNAVAILABLE = 'Wallet data is unavailable';

/** Body schema for skipping a wizard step (`lightning-address` is the receiving-wallet step). */
const skipBody = z.object({ step: z.enum(['name', 'lightning-address']) });

/** Body schema for writing About me (required text; optional photo tri-state). */
const aboutBody = z.object({
  text: z.string(),
  photo: z
    .union([
      z.object({
        contentType: z.string(),
        data: z.string(),
        takenAt: z.unknown().nullish(),
      }),
      z.null(),
    ])
    .optional(),
});

/** Same decode-failure string as `POST /messages`. */
const ABOUT_PHOTO_ERROR = 'Photo must be a JPEG, PNG, or WebP under 1 MiB';

/** Empty About me with no photo or video and no live note to clear. */
const ABOUT_EMPTY_ERROR = 'Write something about yourself';

/** Body schema for setting the owner notification level. */
const notificationLevelBody = z.object({
  level: z.enum(['all', 'active', 'mentions', 'none']),
});

/** Body schema for setting heart-tip notifications. */
const heartNotificationsBody = z.object({
  enabled: z.boolean(),
});

/** Body schema for setting the owner amount-entry unit. */
const amountUnitBody = z.object({
  unit: z.enum(['btc', 'fiat']),
});

/** Body schema for setting the owner UI language. */
const localeBody = z.object({
  locale: z.enum(['en', 'de', 'es', 'fil']),
  onlyIfUnset: z.boolean().optional(),
});

/** Body schema for setting the owner fiat display currency. */
const fiatBody = z.object({
  fiat: z.enum(['CHF', 'EUR', 'USD', 'PHP']),
  onlyIfUnset: z.boolean().optional(),
});

/** Body schema for a client passkey-renew report. Unknown keys are 400. */
const passkeyRenewReportBody = z
  .object({
    stage: z.enum(['begin', 'ceremony', 'finish']),
    outcome: z.enum(['failed', 'cancelled']),
    errorName: z.string(),
    errorCode: z.string().nullable(),
    httpStatus: z.number().int().min(0).max(599).nullable(),
    message: z.string(),
    authenticatorAttachment: z.unknown().optional(),
    transports: z.unknown().optional(),
    aaguid: z.unknown().optional(),
    prfEnabled: z.unknown().optional(),
    prfPresent: z.unknown().optional(),
    extensions: z.unknown().optional(),
    authenticatorFlags: z.unknown().optional(),
    publicKeyAlgorithm: z.unknown().optional(),
    residentKey: z.unknown().optional(),
    hmacSecret: z.unknown().optional(),
    credProtect: z.unknown().optional(),
    clientCapabilities: z.unknown().optional(),
  })
  .strict();

/** Single 400 copy for a missing or invalid passkey-renew report body. */
const PASSKEY_RENEW_REPORT_ERROR =
  'Expected a JSON body with stage, outcome, errorName, errorCode, httpStatus, and message';

/** Owner JSON including the live funding grant. */
function ownerJson(deps: MeRouteDeps, account: Account): Promise<OwnerAccountResponse> {
  return serializeOwnerAccountWithPosts(
    account,
    deps.messages,
    {
      store: deps.fundingStore ?? new InMemoryFundingStore(),
      nowMs: deps.now(),
      authStore: deps.store,
    },
    deps.lnurlServer,
  );
}

/**
 * Daily ping after the first recovery share of the current wallet is stored:
 * reads the grant and, when the account is eligible today with that share,
 * pings today's newest media post through {@link pingTodayMedia} (no second
 * share read). No-op without a spend ping. A grant read failure logs
 * `funding.daily_ping.failed`; the route's answer never depends on this.
 *
 * @param deps - `/me` collaborators.
 * @param lnurlServer - LNURL server config (the share routes exist only with it).
 * @param account - The account, read before the share write.
 * @param nowMs - Clock of the share write.
 */
async function pingAfterShareStored(
  deps: MeRouteDeps,
  lnurlServer: LnurlServerConfig,
  account: Account,
  nowMs: number,
): Promise<void> {
  const spendPing = deps.spendPing;
  if (spendPing === undefined) {
    return;
  }
  try {
    const grant = await (deps.fundingStore ?? new InMemoryFundingStore()).getByAccountId(
      account.id,
    );
    if (!eligibleToday(account.role, grant, nowMs, true)) {
      return;
    }
    await pingTodayMedia(
      { spendPing, lnurlServer, messageStore: deps.messages, authStore: deps.store },
      account,
      nowMs,
      effectiveStatus(grant, nowMs),
      false,
    );
  } catch {
    logEvent('funding.daily_ping.failed', { accountId: account.id });
  }
}

/**
 * Build the `/me` route group.
 *
 * @param deps - Shared store, message store, clock, optional push, optional notification and conversation stores, optional gift/rate/fiat stores for activity, optional funding store, optional `lnurlServer` for `PUT /wallet`, the recovery share and previous-wallet routes, and the receiving address, optional `recoveryShareKek` for the share, and optional `fetchImpl` for the explorer balance.
 * @returns A Hono app exposing account, activity, display-name, username, location, About me, wallet-backup-seen, optional wallet bind, optional recovery share and previous wallets, passkey-renew/report, passkey-renew/ack, setup skip, forum-laws dismiss, wallet-intro seen,
 * living-room rules agreement, notification level, `POST /heart-notifications`, amount-entry unit, locale, and fiat routes.
 */
export function meRoutes(deps: MeRouteDeps): Hono {
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();

  const app = new Hono()
    .get('/', async (c) => {
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const now = deps.now();
      const session = await deps.store.getSession(token);
      if (session === undefined || now - session.createdAt > SESSION_TTL_MS) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await deps.store.getAccount(session.accountId);
      /* v8 ignore next 3 -- a session always references an existing account in-memory */
      if (account === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (isWrongAccount(account)) {
        return c.json({ error: WRONG_ACCOUNT_ERROR }, 403);
      }
      return c.json(await ownerJson(deps, account), 200);
    })
    .get('/activity', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const activity = await buildAccountActivity({
          account,
          gifts: giftStore,
          messages: deps.messages,
          rates,
          now: deps.now,
          fiatRates,
        });
        return c.json(activity, 200);
      } catch (err) {
        const missingFx = err instanceof Error && err.message === 'fx.rate.missing';
        logEvent(missingFx ? 'account.activity.fx_incomplete' : 'account.activity.failed');
        return c.json({ error: 'Gift stats are unavailable' }, 503);
      }
    })
    .post('/wallet-backup-seen', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const marked = await deps.store.markWalletBackupSeen(current.id, deps.now());
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (marked === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (marked.wrote) {
        logEvent('account.wallet.backup_seen', { accountId: current.id });
      }
      return c.json(await ownerJson(deps, marked.account), 200);
    })
    .post('/passkey-renew/report', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = passkeyRenewReportBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: PASSKEY_RENEW_REPORT_ERROR }, 400);
      }
      await deps.store.insertPasskeyRenewAttempt({
        id: randomUUID(),
        accountId: account.id,
        createdAt: deps.now(),
        stage: parsed.data.stage,
        outcome: parsed.data.outcome,
        errorName: parsed.data.errorName,
        errorCode: parsed.data.errorCode,
        httpStatus: parsed.data.httpStatus,
        message: parsed.data.message,
        userAgent: c.req.header('user-agent') ?? null,
        authenticatorAttachment: parsed.data.authenticatorAttachment ?? null,
        transports: parsed.data.transports ?? null,
        aaguid: parsed.data.aaguid ?? null,
        prfEnabled: parsed.data.prfEnabled ?? null,
        prfPresent: parsed.data.prfPresent ?? null,
        extensions: parsed.data.extensions ?? null,
        authenticatorFlags: parsed.data.authenticatorFlags ?? null,
        publicKeyAlgorithm: parsed.data.publicKeyAlgorithm ?? null,
        residentKey: parsed.data.residentKey ?? null,
        hmacSecret: parsed.data.hmacSecret ?? null,
        credProtect: parsed.data.credProtect ?? null,
        clientCapabilities: parsed.data.clientCapabilities ?? null,
      });
      const reported = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (reported === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(await ownerJson(deps, reported), 200);
    })
    .post('/passkey-renew/ack', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await deps.store.acknowledgePasskeyRenewFailures(account.id, deps.now());
      const acknowledged = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (acknowledged === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(await ownerJson(deps, acknowledged), 200);
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
      return c.json(await ownerJson(deps, updated), 200);
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
      await ensureProfileMessage({
        auth: deps.store,
        messages: deps.messages,
        account: withName,
        now: deps.now,
        ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
        ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
        /* v8 ignore next -- createApp always injects conversationStore */
        ...(deps.conversationStore === undefined ? {} : { conversations: deps.conversationStore }),
      });
      const live = await deps.store.getAccount(current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (live === null || live === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await deps.store.updateAccount({ ...live, name });
      const named = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (named === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const usernameBlank =
        named.username === null || named.username === undefined || named.username.trim() === '';
      if (usernameBlank) {
        const derived = usernameFromDisplayName(name);
        if (derived !== null) {
          const owner = await deps.store.getAccountByUsername(derived);
          if (owner === undefined || owner.id === named.id) {
            const latest = await storedAccount(deps, named.id);
            /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
            if (latest === null) {
              return c.json({ error: 'Unauthorized' }, 401);
            }
            const latestBlank =
              latest.username === null ||
              latest.username === undefined ||
              latest.username.trim() === '';
            if (latestBlank) {
              await deps.store.updateAccount({ ...latest, username: derived });
            }
          }
        }
      }
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.name.set', { accountId: current.id });
      return c.json(await ownerJson(deps, stored), 200);
    })
    .post('/username', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = usernameBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "username" string' }, 400);
      }
      const username = normalizeUsername(parsed.data.username);
      if (username === null) {
        return c.json(
          {
            error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
          },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (typeof current.sparkPubkeyVerifiedAt === 'number') {
        return c.json({ error: 'Username is fixed once the wallet is connected' }, 409);
      }
      const owner = await deps.store.getAccountByUsername(username);
      if (owner !== undefined && owner.id !== current.id) {
        return c.json({ error: 'Username is already in use' }, 409);
      }
      const result = await deps.store.setUsername(current.id, username);
      if (!result.ok) {
        if (result.reason === 'taken') {
          return c.json({ error: 'Username is already in use' }, 409);
        }
        if (result.reason === 'frozen') {
          return c.json({ error: 'Username is fixed once the wallet is connected' }, 409);
        }
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.username.set', { accountId: current.id });
      return c.json(await ownerJson(deps, stored), 200);
    })
    .post('/location', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = locationBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "location" string' }, 400);
      }
      const normalized = normalizeLocation(parsed.data.location);
      if (!normalized.ok) {
        return c.json({ error: 'Location must be at most 80 characters' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, location: normalized.value };
      await deps.store.updateAccount(updated);
      logEvent('account.location.set', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .get('/about/photo', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const profileId = account.profileMessageId;
        if (typeof profileId !== 'string' || profileId.trim() === '') {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const row = await deps.messages.getById(profileId);
        if (row === undefined || row.deletedAt !== null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const photo = await deps.messages.getPhoto(profileId);
        if (photo === null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        return forumPhotoResponse(photo);
      } catch {
        logEvent('account.about.photo.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .put('/about', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = aboutBody.safeParse(raw);
      if (!parsed.success) {
        const textOk =
          raw !== null &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          typeof (raw as { text?: unknown }).text === 'string';
        if (!textOk) {
          return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
        }
        return c.json({ error: ABOUT_PHOTO_ERROR }, 400);
      }
      const photoKeyPresent =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'photo' in raw;
      let decodedPhoto: ForumPhoto | null | undefined = undefined;
      if (photoKeyPresent) {
        // Zod types optional `photo` as T | null | undefined. A present JSON
        // key is T | null (`undefined` cannot appear in JSON).
        const incoming = parsed.data.photo as {
          contentType: string;
          data: string;
          takenAt?: unknown;
        } | null;
        if (incoming === null) {
          decodedPhoto = null;
        } else {
          const decoded = decodeForumPhoto(incoming.contentType, incoming.data);
          if (decoded === null) {
            return c.json({ error: ABOUT_PHOTO_ERROR }, 400);
          }
          decoded.takenAt = normalizePhotoTakenAt(incoming.takenAt);
          decodedPhoto = decoded;
        }
      }
      const normalized = normalizeForumText(parsed.data.text);
      if (normalized === null) {
        return c.json({ error: `About me must be at most ${MESSAGE_MAX_LENGTH} characters` }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const displayName = current.name === null ? '' : current.name.trim();
      if (displayName === '') {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: ['name'] }, 409);
      }
      try {
        let owner = current;
        let noteId: string | undefined;
        let createdThisRequest = false;
        let textToWrite = normalized;
        const existingId = owner.profileMessageId;
        if (typeof existingId === 'string' && existingId.trim() !== '') {
          const existing = await deps.messages.getById(existingId);
          if (existing !== undefined && existing.deletedAt === null) {
            noteId = existingId;
            const keepsMedia =
              existing.hasVideo === true ||
              Number(existing.photoCount) > Number(existing.hasPhoto) ||
              (decodedPhoto === undefined ? existing.hasPhoto : decodedPhoto !== null);
            if (normalized === '' && !keepsMedia) {
              // Removal: back to the auto name-copy, never an empty note.
              textToWrite = existing.name.trim() === '' ? displayName : existing.name;
            }
          }
        }
        if (
          noteId === undefined &&
          normalized === '' &&
          (decodedPhoto === undefined || decodedPhoto === null)
        ) {
          return c.json({ error: ABOUT_EMPTY_ERROR }, 400);
        }
        if (noteId === undefined) {
          const messageId = crypto.randomUUID();
          const createPhoto = decodedPhoto ?? undefined;
          const row: MessageRow = {
            id: messageId,
            accountId: owner.id,
            name: displayName,
            text: normalized,
            createdAt: new Date(deps.now()),
            hasPhoto: createPhoto !== undefined,
            hasVideo: false,
            videoContentType: null,
            ...unsignedNostrDefaults(),
          };
          const created = await deps.messages.create(row, createPhoto);
          const insertedThisRequest = created.id === messageId;
          const discardInsert = async (winnerId?: string | null): Promise<void> => {
            if (insertedThisRequest && created.id !== winnerId) {
              await deps.messages.deleteById(created.id);
            }
          };
          const live = await deps.store.getAccount(owner.id);
          if (live === undefined) {
            await discardInsert();
            return c.json({ error: 'Unauthorized' }, 401);
          }
          const liveId = live.profileMessageId;
          if (typeof liveId === 'string' && liveId.trim() !== '') {
            const winner = await deps.messages.getById(liveId);
            if (winner !== undefined && winner.deletedAt === null) {
              await discardInsert(liveId);
              owner = live;
              noteId = liveId;
            }
          }
          if (noteId === undefined) {
            const expectedId =
              typeof live.profileMessageId === 'string' && live.profileMessageId.trim() !== ''
                ? live.profileMessageId
                : null;
            try {
              const claimed = await deps.store.claimProfileMessageId(
                live.id,
                expectedId,
                created.id,
              );
              if (!claimed) {
                const after = await deps.store.getAccount(owner.id);
                await discardInsert(after?.profileMessageId);
                if (after === undefined) {
                  return c.json({ error: 'Unauthorized' }, 401);
                }
                const afterId = after.profileMessageId;
                if (typeof afterId === 'string' && afterId.trim() !== '') {
                  const afterRow = await deps.messages.getById(afterId);
                  if (afterRow !== undefined && afterRow.deletedAt === null) {
                    owner = after;
                    noteId = afterId;
                  }
                }
                if (noteId === undefined) {
                  return c.json({ error: 'Messages are unavailable' }, 503);
                }
              }
            } catch (err) {
              await discardInsert();
              throw err;
            }
            if (noteId === undefined) {
              const confirmed = await deps.store.getAccount(owner.id);
              if (confirmed === undefined || confirmed.profileMessageId !== created.id) {
                await discardInsert(confirmed?.profileMessageId);
                if (confirmed === undefined) {
                  return c.json({ error: 'Unauthorized' }, 401);
                }
                const confirmedId = confirmed.profileMessageId;
                if (typeof confirmedId === 'string' && confirmedId.trim() !== '') {
                  const confirmedRow = await deps.messages.getById(confirmedId);
                  if (confirmedRow !== undefined && confirmedRow.deletedAt === null) {
                    owner = confirmed;
                    noteId = confirmedId;
                  }
                }
                if (noteId === undefined) {
                  return c.json({ error: 'Messages are unavailable' }, 503);
                }
              } else {
                owner = { ...live, profileMessageId: created.id };
                noteId = created.id;
                createdThisRequest = insertedThisRequest;
              }
            }
          }
        }
        const written = await deps.messages.updateText(noteId, textToWrite);
        if (typeof written === 'string') {
          return c.json({ error: written }, 400);
        }
        if (written === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (photoKeyPresent && !createdThisRequest) {
          await deps.messages.updatePhoto(noteId, decodedPhoto ?? null);
        }
        const liveRow = await deps.messages.getById(noteId);
        const shopKek = deps.shopKek ?? deps.nostrKek;
        if (deps.shopIdentities !== undefined && shopKek !== undefined) {
          try {
            await deps.shopIdentities.ensureListed(noteId, shopKek);
          } catch {
            logEvent('shop.nostr_key.failed', { messageId: noteId });
          }
        }
        if (liveRow !== undefined && liveRow.sats === 0 && liveRow.eventId !== null) {
          await deps.messages.resetSignedEvent(noteId, liveRow.eventId);
        }
        if (createdThisRequest && liveRow !== undefined) {
          try {
            await notifyForumPost({
              account: owner,
              created: liveRow,
              auth: deps.store,
              ...(deps.notificationStore === undefined
                ? {}
                : { notifications: deps.notificationStore }),
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
              /* v8 ignore next 5 -- createApp always injects conversationStore */
              ...(deps.conversationStore === undefined
                ? {}
                : {
                    inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.store),
                  }),
            });
          } catch {
            logEvent('push.enqueue.failed');
          }
        }
        const latest = await storedAccount(deps, owner.id);
        /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
        if (latest === null) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        logEvent('account.about.set', { accountId: latest.id });
        await syncWelcomePing({
          ...(deps.spendPing === undefined ? {} : { spendPing: deps.spendPing }),
          messages: deps.messages,
          auth: deps.store,
          gifts: giftStore,
          account: latest,
          ...(deps.lnurlServer === undefined ? {} : { lnurlServer: deps.lnurlServer }),
        });
        return c.json(await ownerJson(deps, latest), 200);
      } catch {
        logEvent('account.about.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
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
        return c.json(await ownerJson(deps, current), 200);
      }
      const updated: Account = { ...current, forumLawsDismissed: true };
      await deps.store.updateAccount(updated);
      logEvent('account.forum_laws.dismissed', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/wallet-intro-seen', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.walletIntroSeen === true) {
        return c.json(await ownerJson(deps, current), 200);
      }
      const updated: Account = { ...current, walletIntroSeen: true };
      await deps.store.updateAccount(updated);
      logEvent('account.wallet_intro.seen', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/notification-level', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = notificationLevelBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with a level of all, active, mentions, or none' },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, notificationLevel: parsed.data.level };
      await deps.store.updateAccount(updated);
      logEvent('account.notification_level.set', {
        accountId: current.id,
        level: parsed.data.level,
      });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/heart-notifications', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = heartNotificationsBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an enabled boolean' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, notifyHearts: parsed.data.enabled };
      await deps.store.updateAccount(updated);
      logEvent('account.heart_notifications.set', {
        accountId: current.id,
        enabled: parsed.data.enabled,
      });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/amount-unit', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = amountUnitBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a unit of btc or fiat' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, amountUnit: parsed.data.unit };
      await deps.store.updateAccount(updated);
      logEvent('account.amount_unit.set', {
        accountId: current.id,
        unit: parsed.data.unit,
      });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/locale', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = localeBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a locale of en, de, es, or fil' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const onlyIfUnset = parsed.data.onlyIfUnset ?? false;
      const result = await deps.store.setAccountLocale(current.id, parsed.data.locale, onlyIfUnset);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (result === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.locale.set', {
        accountId: current.id,
        locale: parsed.data.locale,
        onlyIfUnset,
        wrote: result.wrote,
      });
      return c.json(await ownerJson(deps, result.account), 200);
    })
    .post('/fiat', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = fiatBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a fiat of CHF, EUR, USD, or PHP' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const onlyIfUnset = parsed.data.onlyIfUnset ?? false;
      const result = await deps.store.setAccountFiat(current.id, parsed.data.fiat, onlyIfUnset);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (result === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.fiat.set', {
        accountId: current.id,
        fiat: parsed.data.fiat,
        onlyIfUnset,
        wrote: result.wrote,
      });
      return c.json(await ownerJson(deps, result.account), 200);
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
        return c.json(await ownerJson(deps, current), 200);
      }
      const updated: Account = { ...current, rulesAgreedAt: deps.now() };
      await deps.store.updateAccount(updated);
      logEvent('account.rules_agreement.set', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    });

  if (deps.lnurlServer !== undefined) {
    app.put('/wallet', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = walletBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with a "sparkPubkey" of 66 hex characters' },
          400,
        );
      }
      const pubkey = normalizeSparkPubkey(parsed.data.sparkPubkey);
      if (pubkey === null) {
        return c.json(
          { error: 'Expected a JSON body with a "sparkPubkey" of 66 hex characters' },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const usernameBlank =
        current.username === null ||
        current.username === undefined ||
        current.username.trim() === '';
      if (usernameBlank) {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: ['username'] }, 409);
      }
      if (current.walletRequired !== true) {
        return c.json({ error: 'Wallet is not set up' }, 409);
      }
      if (typeof current.sparkPubkeyVerifiedAt === 'number') {
        return c.json({ error: 'Wallet is already connected' }, 409);
      }
      const result = await deps.store.claimSparkPubkey(current.id, pubkey);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (result === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      /* v8 ignore next 3 -- concurrent verification: claim refuses once sparkPubkeyVerifiedAt is set */
      if (result.wrote === false) {
        return c.json({ error: 'Wallet is already connected' }, 409);
      }
      logEvent('account.wallet.claimed', { accountId: current.id });
      return c.json(await ownerJson(deps, result.account), 200);
    });

    const lnurlServer = deps.lnurlServer;
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

    app.put('/recovery-share', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const kek = deps.recoveryShareKek;
      if (kek === undefined) {
        return c.json({ error: RECOVERY_SHARE_UNAVAILABLE }, 503);
      }
      const parsed = recoveryShareBody.safeParse(await c.req.json().catch(() => null));
      const sparkPubkey = parsed.success ? normalizeSparkPubkey(parsed.data.sparkPubkey) : null;
      if (!parsed.success || sparkPubkey === null || !RECOVERY_SHARE_TEXT.test(parsed.data.share)) {
        return c.json({ error: RECOVERY_SHARE_BODY_ERROR }, 400);
      }
      try {
        const current = await storedAccount(deps, account.id);
        /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
        if (current === null) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        if (typeof current.sparkPubkeyVerifiedAt !== 'number') {
          return c.json({ error: 'Wallet is not connected' }, 409);
        }
        if (sparkPubkey !== current.sparkPubkey) {
          return c.json({ error: 'Wallet changed' }, 409);
        }
        const ciphertext = await encryptRecoveryShare(parsed.data.share, kek, current.id);
        const nowMs = deps.now();
        const result = await deps.store.putRecoveryShare({
          accountId: current.id,
          sparkPubkey,
          ciphertext,
          now: nowMs,
        });
        if (result === 'changed') {
          return c.json({ error: 'Wallet changed' }, 409);
        }
        logEvent('account.recovery_share.stored', {
          accountId: current.id,
          replaced: result === 'replaced',
        });
        if (result === 'stored') {
          await pingAfterShareStored(deps, lnurlServer, current, nowMs);
        }
        return c.json(await ownerJson(deps, current), 200);
      } catch (error) {
        logEvent('account.recovery_share.failed', {
          accountId: account.id,
          ...errorLogFields(error),
        });
        return c.json({ error: RECOVERY_SHARE_UNAVAILABLE }, 503);
      }
    });

    app.get('/previous-wallets', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      let wallets: PreviousWallet[];
      try {
        wallets = await deps.store.listPreviousWallets(account.id);
      } catch (error) {
        logEvent('account.previous_wallets.failed', {
          accountId: account.id,
          ...errorLogFields(error),
        });
        return c.json({ error: WALLET_DATA_UNAVAILABLE }, 503);
      }
      // The explorer balance is information only; an unknown one is null.
      const listed = await Promise.all(
        wallets.map(async (wallet) => ({
          sparkPubkey: wallet.sparkPubkey,
          sparkAddress: wallet.sparkAddress,
          replacedAt: wallet.replacedAt,
          balanceSats: await fetchSparkAddressBalance(fetchImpl, wallet.sparkAddress),
        })),
      );
      return c.json({ wallets: listed }, 200);
    });

    app.delete('/previous-wallets/:sparkPubkey', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const sparkPubkey = normalizeSparkPubkey(c.req.param('sparkPubkey'));
      if (sparkPubkey === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        if (!(await deps.store.dropPreviousWallet(account.id, sparkPubkey))) {
          return c.json({ error: 'Not found' }, 404);
        }
      } catch (error) {
        logEvent('account.previous_wallets.failed', {
          accountId: account.id,
          ...errorLogFields(error),
        });
        return c.json({ error: WALLET_DATA_UNAVAILABLE }, 503);
      }
      logEvent('account.previous_wallet.dropped', { accountId: account.id });
      return c.body(null, 204);
    });
  }

  // Held-share boxes need no LNURL server: the api keeps opaque bytes for the
  // holder and never learns whose share a box holds. Logs carry neither a box
  // id nor a ciphertext.
  app.get('/held-shares', async (c) => {
    const account = await authedAccount(deps, c.req.header('authorization'));
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const boxes = await deps.store.listHeldShareBoxes(account.id);
      return c.json(
        {
          boxes: boxes.map((box) => ({
            id: box.id,
            ciphertext: Buffer.from(box.ciphertext).toString('base64url'),
            updatedAt: new Date(box.updatedAt).toISOString(),
          })),
        },
        200,
      );
    } catch (error) {
      logEvent('account.held_shares.failed', { accountId: account.id, ...errorLogFields(error) });
      return c.json({ error: HELD_SHARES_UNAVAILABLE }, 503);
    }
  });

  app.put('/held-shares/:id', async (c) => {
    const account = await authedAccount(deps, c.req.header('authorization'));
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const id = c.req.param('id');
    if (!HELD_SHARE_BOX_ID.test(id)) {
      return c.json({ error: HELD_SHARE_BOX_ID_ERROR }, 400);
    }
    const parsed = heldShareBody.safeParse(await c.req.json().catch(() => null));
    const ciphertext = parsed.success ? decodeHeldShareCiphertext(parsed.data.ciphertext) : null;
    if (ciphertext === null) {
      return c.json({ error: HELD_SHARE_BODY_ERROR }, 400);
    }
    const nowMs = deps.now();
    let result: HeldShareBoxPutResult;
    try {
      result = await deps.store.putHeldShareBox({
        accountId: account.id,
        id,
        ciphertext,
        now: nowMs,
        limit: HELD_SHARE_BOX_LIMIT,
      });
    } catch (error) {
      logEvent('account.held_shares.failed', { accountId: account.id, ...errorLogFields(error) });
      return c.json({ error: HELD_SHARES_UNAVAILABLE }, 503);
    }
    if (result === 'taken') {
      return c.json({ error: 'Box id in use' }, 409);
    }
    if (result === 'full') {
      return c.json({ error: 'Too many held shares' }, 409);
    }
    logEvent('account.held_share.stored', {
      accountId: account.id,
      replaced: result === 'replaced',
    });
    return c.json(
      { id, updatedAt: new Date(nowMs).toISOString() },
      result === 'created' ? 201 : 200,
    );
  });

  app.delete('/held-shares/:id', async (c) => {
    const account = await authedAccount(deps, c.req.header('authorization'));
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const id = c.req.param('id');
    if (!HELD_SHARE_BOX_ID.test(id)) {
      return c.json({ error: HELD_SHARE_BOX_ID_ERROR }, 400);
    }
    try {
      await deps.store.deleteHeldShareBox(account.id, id);
    } catch (error) {
      logEvent('account.held_shares.failed', { accountId: account.id, ...errorLogFields(error) });
      return c.json({ error: HELD_SHARES_UNAVAILABLE }, 503);
    }
    logEvent('account.held_share.deleted', { accountId: account.id });
    return c.body(null, 204);
  });

  return app;
}
