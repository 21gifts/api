/**
 * One live shop stablecoin payment against a running api.
 *
 * Opens `POST /pay/:username/payment`, reads the pay link, and requests one
 * stablecoin detail. It broadcasts an ERC-20 transfer only when
 * `SHOP_E2E_PAY` is `1`. It does not print the signing key, the RPC URL, the
 * deposit address, or the BOLT11.
 *
 * This file is not part of `bun test` or Playwright. The run of 2026-10-22
 * and the environment variables are in `docs/shop-stablecoin-staging-e2e.md`.
 */

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';

const KNOWN_CHAINS: readonly Chain[] = [mainnet, polygon, arbitrum, optimism, base, bsc];

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function required(name: string): string {
  const value = env(name);
  if (value === undefined) fail(`missing_${name}`);
  return value;
}

function fail(code: string): never {
  console.error(code);
  process.exit(1);
}

function chainById(id: number, rpcUrl: string): Chain {
  const known = KNOWN_CHAINS.find((chain) => chain.id === id);
  if (known !== undefined) return known;
  return {
    id,
    name: `evm-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

function privateKey(): Hex {
  const raw = required('EVM_PRIVATE_KEY');
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) fail('key_invalid');
  return hex as Hex;
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  url: string,
  userAgent: string,
  method: 'GET' | 'POST' = 'GET',
  jsonBody?: unknown,
): Promise<HttpResult> {
  const headers = new Headers({ accept: 'application/json', 'user-agent': userAgent });
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(90_000) };
  if (jsonBody !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(jsonBody);
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    fail('http_failed');
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === 'string' ? field : undefined;
}

interface Offer {
  method: string;
  assets: string[];
}

function offers(document: unknown): Offer[] {
  const rows = objectField(document, 'transferAmounts');
  if (!Array.isArray(rows)) return [];
  const found: Offer[] = [];
  for (const row of rows) {
    const method = stringField(row, 'method');
    const assets = objectField(row, 'assets');
    if (method === undefined || !Array.isArray(assets)) continue;
    const names: string[] = [];
    for (const asset of assets) {
      const name = stringField(asset, 'asset');
      if (name !== undefined) names.push(name);
    }
    found.push({ method, assets: names });
  }
  return found;
}

function parseUri(uri: string): { token: Address; chainId: number; units: bigint } {
  if (!uri.startsWith('ethereum:')) fail('uri_scheme');
  const withoutScheme = uri.slice('ethereum:'.length);
  const queryAt = withoutScheme.indexOf('?');
  if (queryAt < 0) fail('uri_query');
  const main = withoutScheme.slice(0, queryAt);
  const query = withoutScheme.slice(queryAt + 1);
  const at = main.indexOf('@');
  const slash = main.indexOf('/');
  if (at < 0 || slash < at) fail('uri_shape');
  const token = main.slice(0, at);
  const chainText = main.slice(at + 1, slash);
  if (!isAddress(token)) fail('uri_token');
  if (!/^[0-9]+$/.test(chainText)) fail('uri_chain');
  const params = new URLSearchParams(query);
  const unitsText = params.get('uint256');
  if (unitsText === null || !/^[0-9]+$/.test(unitsText) || unitsText === '0') fail('uri_amount');
  return { token, chainId: Number(chainText), units: BigInt(unitsText) };
}

async function openPayment(
  apiBase: string,
  username: string,
  amountSats: number,
  userAgent: string,
): Promise<HttpResult> {
  const url = `${apiBase}/pay/${encodeURIComponent(username)}/payment`;
  let result = await request(url, userAgent, 'POST', { amountSats });
  console.log(`quote_status=${result.status}`);
  const code = stringField(result.body, 'code');
  if (code !== undefined) console.log(`quote_code=${code}`);
  if (result.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await request(url, userAgent, 'POST', { amountSats });
    console.log(`quote_status=${result.status}`);
    const retryCode = stringField(result.body, 'code');
    if (retryCode !== undefined) console.log(`quote_code=${retryCode}`);
  }
  return result;
}

async function payTransfer(uri: string, rpcUrl: string): Promise<Hex> {
  const parsed = parseUri(uri);
  const chain = chainById(parsed.chainId, rpcUrl);
  const account = privateKeyToAccount(privateKey());
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  console.log(`payer=${account.address}`);
  console.log(`chain_id=${parsed.chainId}`);
  console.log(`units=${parsed.units.toString()}`);
  let balance: bigint;
  try {
    balance = await publicClient.readContract({
      address: parsed.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
  } catch {
    fail('balance_read_failed');
  }
  console.log(`balance_units=${balance.toString()}`);
  if (parsed.units > balance) fail('balance_short');
  const deposit = new URLSearchParams(uri.slice(uri.indexOf('?') + 1)).get('address');
  if (deposit === null || !isAddress(deposit)) fail('uri_deposit');
  let hash: Hex;
  try {
    hash = await walletClient.writeContract({
      address: parsed.token,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deposit, parsed.units],
      account,
      chain,
    });
  } catch {
    fail('send_failed');
  }
  console.log(`tx=${hash}`);
  let receipt: { status: string };
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch {
    fail('receipt_pending');
  }
  console.log(`receipt_status=${receipt.status}`);
  if (receipt.status !== 'success') fail('receipt_failed');
  return hash;
}

async function main(): Promise<void> {
  const appBase = env('SHOP_APP_BASE') ?? 'https://staging.21.gifts';
  const apiBase = env('SHOP_API_BASE') ?? 'https://staging-api.21.gifts';
  const username = required('SHOP_USERNAME');
  const amountText = required('SHOP_AMOUNT_SATS');
  if (!/^[0-9]+$/.test(amountText)) fail('amount_invalid');
  const amountSats = Number(amountText);
  const method = env('SHOP_METHOD') ?? 'Polygon';
  const asset = env('SHOP_ASSET') ?? 'USDT';
  const userAgent = env('SHOP_E2E_USER_AGENT') ?? '21gifts-shop-staging-e2e';
  const pay = env('SHOP_E2E_PAY') === '1';

  const opened = await openPayment(apiBase, username, amountSats, userAgent);
  if (opened.status !== 200) fail('quote_failed');
  const paymentFromOpen = stringField(opened.body, 'payment');
  if (paymentFromOpen !== undefined) console.log(`payment=${paymentFromOpen}`);
  const expiresAt = stringField(opened.body, 'expiresAt');
  if (expiresAt !== undefined) console.log(`quote_expires=${expiresAt}`);

  const lnurl = await request(
    `${appBase}/.well-known/lnurlp/${encodeURIComponent(username)}`,
    userAgent,
  );
  console.log(`lnurl_status=${lnurl.status}`);
  const listed = offers(lnurl.body);
  console.log(
    `offered=${listed.map((row) => `${row.method}:${row.assets.join('+')}`).join(',') || 'none'}`,
  );
  const quote = objectField(lnurl.body, 'quote');
  const quoteId = stringField(quote, 'id');
  const paymentId = stringField(quote, 'payment') ?? paymentFromOpen;
  const chosen = listed.find(
    (row) => row.method.toLowerCase() === method.toLowerCase() && row.assets.includes(asset),
  );
  if (quoteId === undefined || chosen === undefined) fail('offer_missing');

  const detailUrl =
    `${appBase}/lnurlp/cb/${encodeURIComponent(username)}` +
    `?quote=${encodeURIComponent(quoteId)}&method=${encodeURIComponent(method)}&asset=${encodeURIComponent(asset)}`;
  const detail = await request(detailUrl, userAgent);
  console.log(`detail_status=${detail.status}`);
  const uri = stringField(detail.body, 'uri');
  if (detail.status !== 200 || uri === undefined) fail('detail_missing');
  if (!pay) {
    console.log('pay=skipped');
    return;
  }

  const rpcUrl = required('SHOP_EVM_RPC_URL');
  const tx = await payTransfer(uri, rpcUrl);
  const proofUrl =
    `${appBase}/lnurlp/tx/${encodeURIComponent(username)}` +
    `?quote=${encodeURIComponent(quoteId)}&method=${encodeURIComponent(method)}` +
    `&asset=${encodeURIComponent(asset)}&tx=${encodeURIComponent(tx)}`;
  const proof = await request(proofUrl, userAgent);
  console.log(`proof_status=${proof.status}`);
  const proofCode = stringField(proof.body, 'code');
  if (proofCode !== undefined) console.log(`proof_code=${proofCode}`);
  if (paymentId === undefined) fail('payment_missing');

  const deadline = Date.now() + 15 * 60 * 1000;
  let settled = false;
  while (Date.now() < deadline) {
    const wait = await request(
      `${appBase}/lnurlp/wait/${encodeURIComponent(paymentId)}`,
      userAgent,
    );
    const state = stringField(wait.body, 'status');
    const inner = stringField(wait.body, 'paymentStatus');
    console.log(`wait=${wait.status}:${state ?? ''}:${inner ?? ''}`);
    if (state === 'Completed' || inner === 'paid') {
      settled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (!settled) fail('not_paid');
}

main().catch(() => fail('unexpected'));
