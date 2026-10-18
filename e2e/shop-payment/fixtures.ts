/**
 * Fixtures of the `shop-payment` Playwright project: a shop account with a
 * username and a verified in-app wallet, the stand-ins' control endpoint,
 * the sticker of a shop, and the adapters that let {@link TetherWallet}
 * run over Playwright's request context and the chain stand-in.
 *
 * The verified wallet is made the way a member makes one, over HTTP only:
 * the account is provisioned with the debug token, claimed with a passkey
 * (`POST /auth/passkey/register/begin` with its view key, then `/finish`
 * with a `none` attestation), given a Spark key (`PUT /me/wallet`), and
 * registered at the LNURL server (`POST /lnurlpay/:pubkey`), which marks
 * the key verified.
 */

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import type {
  Broadcast,
  ShopBehaviour,
  ShopState,
  TransferRequest,
  TransferResult,
} from './stand-ins/control-types';
import { CONTROL_URL, DEBUG_TOKEN, PUBLIC_BASE_URL, WEBAUTHN_ORIGIN } from './stand-ins/ports';
import {
  OPEN_CRYPTO_PAY_RAILS,
  encodeLnurl,
  getOpenCryptoPayPayment,
  parseOpenCryptoPayLink,
  resolveOpenCryptoPayRail,
  TetherWallet,
  withQuery,
  type PendingProof,
  type Rail,
  type RailResult,
  type WalletBundler,
  type WalletHttp,
} from './tether-client';

export const DEBUG = { authorization: `Bearer ${DEBUG_TOKEN}` };

// ---------------------------------------------------------------------------
// CBOR (only what a `none` attestation needs).

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cborHead(major: number, length: number): number[] {
  if (length < 24) {
    return [(major << 5) | length];
  }
  if (length < 256) {
    return [(major << 5) | 24, length];
  }
  return [(major << 5) | 25, (length >> 8) & 0xff, length & 0xff];
}

function cbor(value: Cbor): number[] {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) {
    return [...cborHead(2, value.length), ...value];
  }
  const out = cborHead(5, value.size);
  for (const [key, entry] of value) {
    out.push(...cbor(key), ...cbor(entry));
  }
  return out;
}

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A `none`-attestation registration response for `challenge` on RP `localhost`. */
function noneAttestation(challenge: string, origin: string): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(String(jwk.x), 'base64url');
  const y = Buffer.from(String(jwk.y), 'base64url');
  const cose = new Map<Cbor, Cbor>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(x)],
    [-3, new Uint8Array(y)],
  ]);
  const credentialId = randomBytes(32);
  const authData = new Uint8Array([
    ...createHash('sha256').update('localhost').digest(),
    0x45, // user present, user verified, attested credential data
    0,
    0,
    0,
    0,
    ...new Uint8Array(16),
    (credentialId.length >> 8) & 0xff,
    credentialId.length & 0xff,
    ...credentialId,
    ...cbor(cose),
  ]);
  const attestationObject = new Uint8Array(
    cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    ),
  );
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
  );
  return {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

// ---------------------------------------------------------------------------
// Shop with a verified wallet.

/** A shop account with a username and a verified in-app wallet. */
export interface Shop {
  username: string;
  name: string;
  token: string;
  sparkPubkey: string;
}

let shopCounter = 0;

/** Fresh username: lowercase, at most 32 characters, never `cb`/`invoice`/final `.`. */
export function freshUsername(prefix: string): string {
  shopCounter += 1;
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}${shopCounter}`;
  return `${prefix}-${stamp}`.slice(0, 32);
}

/**
 * Provision a shop over HTTP with the debug token and give it a verified
 * wallet (passkey claim, `PUT /me/wallet`, `POST /lnurlpay/:pubkey`).
 */
export async function verifiedShop(request: APIRequestContext, prefix = 'shop'): Promise<Shop> {
  const username = freshUsername(prefix);
  const name = `Shop ${username.slice(-10)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, username }] },
  });
  expect(provision.status()).toBe(200);
  const provisioned = (await provision.json()) as {
    accounts: Array<{ username: string; viewKey: string }>;
  };
  const viewKey = provisioned.accounts.find((row) => row.username === username)?.viewKey;
  expect(viewKey).toMatch(/^[0-9a-f]{64}$/);

  const begin = await request.post('/auth/passkey/register/begin', { data: { viewKey } });
  expect(begin.status()).toBe(200);
  const begun = (await begin.json()) as { challengeId: string; options: { challenge: string } };
  const finish = await request.post('/auth/passkey/register/finish', {
    headers: { origin: WEBAUTHN_ORIGIN },
    data: {
      challengeId: begun.challengeId,
      credential: noneAttestation(begun.options.challenge, WEBAUTHN_ORIGIN),
    },
  });
  expect(finish.status(), await finish.text()).toBe(200);
  const token = ((await finish.json()) as { token: string }).token;

  const sparkPubkey = `02${randomBytes(32).toString('hex')}`;
  const wallet = await request.put('/me/wallet', {
    headers: { authorization: `Bearer ${token}` },
    data: { sparkPubkey },
  });
  expect(wallet.status(), await wallet.text()).toBe(200);
  const registered = await request.post(`/lnurlpay/${sparkPubkey}`, {
    data: { username, signature: 'e2e', timestamp: Math.floor(Date.now() / 1000) },
  });
  expect(registered.status(), await registered.text()).toBe(200);
  return { username, name, token, sparkPubkey };
}

/** The shop's sticker, as 21gifts/app prints it: `https://<domain>/pl/?lightning=<LNURL>`. */
export function sticker(username: string): string {
  return `${PUBLIC_BASE_URL}/pl/?lightning=${encodeLnurl(`${PUBLIC_BASE_URL}/.well-known/lnurlp/${username}`)}`;
}

/** `POST /pay/:username/payment`; returns the payment id. */
export async function openPayerPayment(
  request: APIRequestContext,
  username: string,
  amountSats: number,
): Promise<{ payment: string; expiresAt: string }> {
  const res = await request.post(`/pay/${username}/payment`, { data: { amountSats } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { payment: string; expiresAt: string };
}

/** `GET /lnurlp/wait/:payment` without `since`. */
export async function paymentStatus(
  request: APIRequestContext,
  payment: string,
): Promise<{ status: string; paymentStatus: string; invoiceExpiresAt: string }> {
  const res = await request.get(`/lnurlp/wait/${payment}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { status: string; paymentStatus: string; invoiceExpiresAt: string };
}

// ---------------------------------------------------------------------------
// Control of the stand-ins.

/** Client of `/__control`. */
export class Control {
  constructor(private readonly request: APIRequestContext) {}

  async behave(username: string, behaviour: Partial<ShopBehaviour>): Promise<void> {
    const res = await this.request.post(`${CONTROL_URL}/__control/shops/${username}`, {
      data: behaviour,
    });
    expect(res.status()).toBe(200);
  }

  async state(username: string): Promise<ShopState> {
    const res = await this.request.get(`${CONTROL_URL}/__control/shops/${username}`);
    expect(res.status()).toBe(200);
    return (await res.json()) as ShopState;
  }

  async transfer(input: TransferRequest): Promise<TransferResult> {
    const res = await this.request.post(`${CONTROL_URL}/__control/transfer`, { data: input });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as TransferResult;
  }

  async settleInvoice(paymentHash: string): Promise<void> {
    const res = await this.request.post(`${CONTROL_URL}/__control/invoices/${paymentHash}/settle`);
    expect(res.status()).toBe(200);
  }

  /**
   * Every `eth_sendRawTransaction` the RPC stand-ins received.
   *
   * @returns The broadcasts in arrival order.
   */
  async broadcasts(): Promise<Broadcast[]> {
    const res = await this.request.get(`${CONTROL_URL}/__control/broadcasts`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { broadcasts: Broadcast[] }).broadcasts;
  }

  async violations(): Promise<string[]> {
    const res = await this.request.get(`${CONTROL_URL}/__control/violations`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { violations: string[] }).violations;
  }
}

// ---------------------------------------------------------------------------
// Wallet adapters.

let clientCounter = 0;

/**
 * Playwright-backed {@link WalletHttp}. Each wallet gets its own
 * `cf-connecting-ip`, as phones behind Cloudflare do, so the per-address
 * limits of parallel scenarios do not share one bucket. A transport error
 * or timeout throws, as axios does.
 */
export function walletHttp(request: APIRequestContext): WalletHttp {
  clientCounter += 1;
  const n = (process.pid % 200) * 1000 + clientCounter;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  return {
    async get(url, timeoutMs) {
      const res = await request.get(url, {
        timeout: timeoutMs,
        headers: { 'cf-connecting-ip': ip },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
      return { status: res.status(), body };
    },
  };
}

/** {@link WalletBundler} over the chain stand-in. */
export function standInBundler(
  control: Control,
  options: Pick<TransferRequest, 'detect' | 'userOpOnly' | 'from'> = {},
  seen: TransferResult[] = [],
): WalletBundler {
  return {
    async transfer(input) {
      const result = await control.transfer({
        chainId: input.chainId,
        token: input.token,
        to: input.recipient,
        amount: input.amount.toString(),
        ...options,
      });
      seen.push(result);
      return { userOpHash: result.userOpHash, receipt: result.receipt };
    },
  };
}

/** A Tether wallet over Playwright and the stand-ins. */
export function tetherWallet(
  request: APIRequestContext,
  control: Control,
  options: Pick<TransferRequest, 'detect' | 'userOpOnly' | 'from'> = {},
  seen: TransferResult[] = [],
): TetherWallet {
  return new TetherWallet(walletHttp(request), standInBundler(control, options, seen));
}

// ---------------------------------------------------------------------------
// Lower-level wallet steps for scenarios that do not run the whole flow.

function railById(id: string): Rail {
  const rail = OPEN_CRYPTO_PAY_RAILS.find((candidate) => candidate.id === id);
  if (rail === undefined) {
    throw new Error(id);
  }
  return rail;
}

/** Scan the sticker and fetch one rail's detail, as a second phone would. */
export async function fetchDetail(
  request: APIRequestContext,
  username: string,
  railId: string,
): Promise<Extract<RailResult, { kind: 'transfer' }>> {
  const http = walletHttp(request);
  const link = parseOpenCryptoPayLink(sticker(username));
  if (link === null) {
    throw new Error('sticker');
  }
  const fetched = await getOpenCryptoPayPayment(http, link.url);
  if (fetched.kind !== 'payment') {
    throw new Error(`pay request: ${fetched.kind}`);
  }
  const detail = await resolveOpenCryptoPayRail(http, link.url, fetched.payment, railById(railId));
  if (detail.kind !== 'transfer') {
    throw new Error(`detail: ${JSON.stringify(detail)}`);
  }
  return detail;
}

/**
 * One proof request with `quote`, `method`, `asset`, and the given `tx` or
 * `hex`; a 5xx is returned, not thrown. `message` is the error text, or the
 * `txId` of a 2xx.
 */
export async function proofAnswer(
  request: APIRequestContext,
  proof: PendingProof,
  form: string | { hex: string },
): Promise<{ status: number; message: string }> {
  const answer = await walletHttp(request).get(
    withQuery(proof.submitUrl, {
      quote: proof.quoteId,
      method: proof.method,
      asset: proof.asset,
      ...(typeof form === 'string' ? { tx: form } : form),
    }),
    20_000,
  );
  const body = (answer.body ?? {}) as { message?: unknown; txId?: unknown };
  return {
    status: answer.status,
    message: typeof body.message === 'string' ? body.message : String(body.txId ?? ''),
  };
}

/** A wallet run as readable JSON for failure messages (amounts are bigint). */
export function describeRun(run: unknown): string {
  return JSON.stringify(
    run,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    1,
  );
}
