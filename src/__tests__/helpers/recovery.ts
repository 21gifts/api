import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { AuthStore, PendingRecovery } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import { bytesToHex, hexToBytes } from '@/lib/nostr/kek';
import { lnurlTransferFromMessage, lnurlTransferToMessage } from '@/lib/recovery-signature';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

/**
 * Pinned Breez SDK 0.26.0 recovery signature vector.
 *
 * Produced with the SDK's Node.js build (`@breeztech/breez-sdk-spark` 0.26.0,
 * `nodejs/breez_sdk_spark_wasm.js`) by
 * `defaultExternalSigners(mnemonic, null, 'mainnet').sparkSigner`:
 * `getIdentityPublicKey()` for the keys and `signMessage(bytes)` over the
 * UTF-8 bytes of the message for the signature. Why this equals
 * `BreezSdk.signMessage({ message, compact: true })` of a connected wallet:
 * both run the same chain. `signMessage` →
 * `SparkWallet::sign_message` → `SparkSignerAdapter::sign_message` →
 * `DefaultSigner::sign_message_ecdsa` (identity path) over `sha256(message)`,
 * then `serialize_compact` (`crates/breez-sdk/core/src/sdk/api.rs:202-222`;
 * `crates/spark/src/signer/default_signer.rs:203-214`). `defaultExternalSigners`
 * builds the same `SparkSignerAdapter(DefaultSigner::from_master(account_master_key(seed)))`
 * (`crates/breez-sdk/core/src/signer/default_external_spark.rs:47-63, 184-187`;
 * `sdk_builder.rs:756-774`). The compact bytes map 1:1 to the hex the SDK
 * returns (`external_types.rs:40-45`). A connected `BreezSdk` needs the
 * network (Breez API key and operators), so the vector comes from the offline
 * signer of the same SDK build. Regenerating it needs no network: the
 * signature is deterministic (RFC 6979) and repeats byte for byte.
 */
export const PINNED = {
  /** Old wallet: the public BIP-39 test mnemonic. */
  oldWords:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  /** Identity key of the old wallet. */
  oldSparkPubkey: '0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5',
  /** New wallet: another public BIP-39 test mnemonic. */
  newWords: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  /** Identity key of the new wallet. */
  newSparkPubkey: '0319d6c5d64753556063000ab42725bfe774fe722f00fbc692142eade1fd1ea52f',
  /** Account being recovered. */
  accountId: '3f2b8c1e-9d4a-4e7b-8c6f-1a2b3c4d5e6f',
  /** WebAuthn challenge of the ceremony, as issued. */
  challenge: 'Wm9wC1Vd3Q8b3n8ZxJ2qkHc7oYyQkq2vQ3d1uS0aT4E',
  /** New passkey's credential id. */
  credentialId: 'bmV3LXJlY292ZXJ5LXBhc3NrZXktMQ',
  /** The signed recovery message. */
  message:
    '21gifts-account-recovery-v1\n3f2b8c1e-9d4a-4e7b-8c6f-1a2b3c4d5e6f\nWm9wC1Vd3Q8b3n8ZxJ2qkHc7oYyQkq2vQ3d1uS0aT4E\nbmV3LXJlY292ZXJ5LXBhc3NrZXktMQ\n0319d6c5d64753556063000ab42725bfe774fe722f00fbc692142eade1fd1ea52f',
  /** Compact low-S signature by the old wallet (deterministic on repeat). */
  signature:
    'b02626c724efdd78042241a16fb1808118544d09f13d2d745847f5dbfc46f46167acd68bf9f5cf6cf844b000c555a228c811924a44473a516c7cce6a95cdaab4',
  /** The same signature with `s' = n − s` (high S). */
  signatureHighS:
    'b02626c724efdd78042241a16fb1808118544d09f13d2d745847f5dbfc46f46198532974060a309307bb4fff3aaa5dd5f29d4a9c6b0165ea535590223a68968d',
  /** DER encoding of the low-S signature. */
  signatureDer:
    '3045022100b02626c724efdd78042241a16fb1808118544d09f13d2d745847f5dbfc46f461022067acd68bf9f5cf6cf844b000c555a228c811924a44473a516c7cce6a95cdaab4',
} as const;

/**
 * Identity private keys of the two public test mnemonics of {@link PINNED}
 * (BIP-39 seed, empty passphrase, `m/8797555'/1'/0'`, the SDK's mainnet
 * identity path). They sign the LNURL transfer bodies and lookups in tests;
 * the recovery signature itself stays the SDK's pinned output.
 */
export const PINNED_PRIVATE_KEYS = {
  old: '07ede284a8976f380b6922de4b14f3a30d1c09b4e57e12cebad5d37ee2e2e6c1',
  new: '2c9195a365350d37b0093913aead97867e8343bd7b38584e876586573a0b4529',
} as const;

/** Domain the LNURL server sees for {@link LNURL_SERVER} (`Host`, lowercase). */
export const LNURL_DOMAIN = LNURL_SERVER.host;

/**
 * Create an account whose wallet key is verified, the precondition of a
 * social recovery.
 *
 * @param store - Auth store.
 * @param input - Account id, lowercase username, and wallet key.
 * @returns Resolves when the account is created, claimed, and verified.
 * @throws Error when the wallet key cannot be marked verified.
 */
export async function seedRecoverableAccount(
  store: AuthStore,
  input: { id: string; username: string; sparkPubkey: string },
): Promise<void> {
  await store.createAccount({
    id: input.id,
    linkingKey: null,
    role: 'verified',
    name: input.username,
    username: input.username,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${input.id.replaceAll('-', '')}${'0'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    walletRequired: true,
  });
  await store.claimSparkPubkey(input.id, input.sparkPubkey);
  if (!(await store.markSparkPubkeyVerified(input.id, input.sparkPubkey, input.username, 2))) {
    throw new Error('wallet not verified');
  }
}

/** Username of the pinned account in recovery tests. */
export const RECOVERY_USERNAME = 'ada';

/** Challenge id of the recovery ceremony that {@link stagePendingRecovery} stores. */
export const STAGED_CHALLENGE_ID = 'c'.repeat(64);

/**
 * Store the pinned account's pending recovery (old key → new key, the pinned
 * credential) through the store's own begin and finish steps, and mark it
 * forwarded when `forwardedAt` is given. The pinned account must exist with
 * {@link RECOVERY_USERNAME} and the old key verified.
 *
 * @param store - Auth store.
 * @param input - Time of begin and finish, and the optional forward time (epoch ms).
 * @returns The stored pending recovery as the store holds it now.
 * @throws Error when a store step refuses.
 */
export async function stagePendingRecovery(
  store: AuthStore,
  input: { createdAt: number; forwardedAt?: number },
): Promise<PendingRecovery> {
  const started = await store.startRecoveryChallenge({
    accountId: PINNED.accountId,
    oldSparkPubkey: PINNED.oldSparkPubkey,
    challenge: {
      id: STAGED_CHALLENGE_ID,
      type: 'recovery',
      challenge: PINNED.challenge,
      accountId: PINNED.accountId,
      consumed: false,
      createdAt: input.createdAt,
    },
    now: input.createdAt,
  });
  const stored = await store.storePendingRecovery({
    challengeId: STAGED_CHALLENGE_ID,
    pending: {
      accountId: PINNED.accountId,
      oldSparkPubkey: PINNED.oldSparkPubkey,
      newSparkPubkey: PINNED.newSparkPubkey,
      credentialId: PINNED.credentialId,
      publicKey: Uint8Array.of(4, 5, 6),
      signCount: 0,
      createdAt: input.createdAt,
      forwardedAt: null,
    },
    now: input.createdAt,
  });
  if (started !== 'started' || stored !== 'stored') {
    throw new Error(`pending recovery not staged: ${started}, ${stored}`);
  }
  if (input.forwardedAt === undefined) {
    return (await store.getPendingRecovery(PINNED.accountId, input.createdAt)) as PendingRecovery;
  }
  const forwarded = await store.markRecoveryForwarded({
    newSparkPubkey: PINNED.newSparkPubkey,
    oldSparkPubkey: PINNED.oldSparkPubkey,
    username: RECOVERY_USERNAME,
    now: input.forwardedAt,
  });
  if (forwarded === undefined) {
    throw new Error('pending recovery not forwarded');
  }
  return forwarded;
}

/**
 * Create the pinned account (username {@link RECOVERY_USERNAME}) with the
 * pinned old key verified.
 *
 * @param store - Auth store.
 * @returns Resolves when seeded.
 */
export async function seedPinnedAccount(store: AuthStore): Promise<void> {
  await seedRecoverableAccount(store, {
    id: PINNED.accountId,
    username: RECOVERY_USERNAME,
    sparkPubkey: PINNED.oldSparkPubkey,
  });
}

/**
 * DER low-S ECDSA over one SHA-256 of the UTF-8 message, as the Breez SDK
 * signs LNURL server messages.
 *
 * @param message - Message to sign.
 * @param privKeyHex - 32-byte private key as lowercase hex.
 * @returns The DER signature as lowercase hex.
 */
export function signDer(message: string, privKeyHex: string): string {
  return bytesToHex(
    secp256k1.sign(new TextEncoder().encode(message), hexToBytes(privKeyHex), {
      prehash: true,
      lowS: true,
      format: 'der',
    }),
  );
}

/**
 * Compact low-S ECDSA over one SHA-256 of the UTF-8 message, as Breez SDK
 * `signMessage({ compact: true })` signs it (reproduces {@link PINNED}`.signature`).
 *
 * @param message - Message to sign.
 * @param privKeyHex - 32-byte private key as lowercase hex.
 * @returns `r || s` as 128 lowercase hex characters.
 */
export function signCompact(message: string, privKeyHex: string): string {
  return bytesToHex(
    secp256k1.sign(new TextEncoder().encode(message), hexToBytes(privKeyHex), {
      prehash: true,
      lowS: true,
      format: 'compact',
    }),
  );
}

/**
 * A wallet's signed lookup body (`breez-lnurl:v2` `recover`) for the begin.
 *
 * @param sparkPubkey - Wallet key that looks itself up.
 * @param privKeyHex - That wallet's private key.
 * @param timestamp - Unix seconds.
 * @returns `{ signature, timestamp }`.
 */
export function signedLookup(
  sparkPubkey: string,
  privKeyHex: string,
  timestamp: number,
): { signature: string; timestamp: number } {
  return {
    signature: signDer(
      `breez-lnurl:v2\nrecover\n${LNURL_DOMAIN}\n${sparkPubkey}\n${timestamp}`,
      privKeyHex,
    ),
    timestamp,
  };
}

/**
 * The body the Breez SDK sends for `POST /lnurlpay/<new key>/transfer`, with
 * both signatures made for {@link LNURL_DOMAIN}.
 *
 * @param input - Username, description, both key pairs, and the timestamp.
 * @returns The JSON body object.
 */
export function transferBody(input: {
  username: string;
  description?: string;
  fromPubkey: string;
  fromPrivKey: string;
  toPubkey: string;
  toPrivKey: string;
  timestamp: number;
}): Record<string, string | number> {
  const description = input.description ?? `Pay to ${input.username}@${LNURL_DOMAIN}`;
  return {
    username: input.username,
    description,
    from_pubkey: input.fromPubkey,
    from_signature: signDer(
      lnurlTransferFromMessage(
        LNURL_DOMAIN,
        input.username,
        input.fromPubkey,
        input.toPubkey,
        input.timestamp,
      ),
      input.fromPrivKey,
    ),
    to_signature: signDer(
      lnurlTransferToMessage(
        LNURL_DOMAIN,
        input.username,
        input.fromPubkey,
        input.toPubkey,
        description,
        input.timestamp,
      ),
      input.toPrivKey,
    ),
    timestamp: input.timestamp,
  };
}

/**
 * The LNURL server's 200 answer to a lookup of a key that holds `username`.
 *
 * @param username - Held name.
 * @returns The response.
 */
export function lookupHolds(username: string): Response {
  return Response.json({
    lnurl: `lnurlp://${LNURL_DOMAIN}/lnurlp/${username}`,
    lightning_address: `${username}@${LNURL_DOMAIN}`,
    username,
    description: `Pay to ${username}@${LNURL_DOMAIN}`,
  });
}

/**
 * The LNURL server's verified "no name" answer: 404 with the JSON string `"user not found"`.
 *
 * @returns The response.
 */
export function lookupUserNotFound(): Response {
  return new Response(JSON.stringify('user not found'), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The LNURL server's 200 answer to an accepted address transfer.
 *
 * @param username - Moved name.
 * @returns The response.
 */
export function transferAccepted(username: string): Response {
  return Response.json({
    lnurl: `lnurlp://${LNURL_DOMAIN}/lnurlp/${username}`,
    lightning_address: `${username}@${LNURL_DOMAIN}`,
  });
}

/** One request the scripted LNURL server saw. */
export interface ScriptedCall {
  /** Route the request hit. */
  route: 'recover' | 'transfer';
  /** Path key. */
  pubkey: string;
  /** Request body text. */
  body: string;
  /** `Host` header sent. */
  host: string | null;
  /** `content-type` header sent. */
  contentType: string | null;
}

/**
 * Fake LNURL server that answers lookups and transfers by script. Any other
 * URL answers 500.
 *
 * @param script - Answer per route; omitted → 500.
 * @returns The fake fetch and the requests it saw.
 */
export function scriptedLnurlFetch(script: {
  recover?: (pubkey: string, body: string) => Response | Promise<Response>;
  transfer?: (pubkey: string, body: string) => Response | Promise<Response>;
}): { fetchImpl: FetchFn; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const pattern = new RegExp(
    `^${LNURL_SERVER.baseUrl}/lnurlpay/([0-9a-f]{66})/(recover|transfer)$`,
  );
  const fetchImpl: FetchFn = async (input, init) => {
    const match = pattern.exec(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : '';
    if (match === null) {
      return new Response('unexpected', { status: 500 });
    }
    const pubkey = match[1] as string;
    const route = match[2] as 'recover' | 'transfer';
    calls.push({
      route,
      pubkey,
      body,
      host: headers['host'] ?? null,
      contentType: headers['content-type'] ?? null,
    });
    const answer = script[route];
    return answer === undefined ? new Response('no script', { status: 500 }) : answer(pubkey, body);
  };
  return { fetchImpl, calls };
}
