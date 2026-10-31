/**
 * One live shop stablecoin payment against a running api.
 *
 * Opens `POST /pay/:username/payment`, reads the pay link, and requests one
 * stablecoin detail. It broadcasts an ERC-20 transfer only when
 * `SHOP_E2E_PAY` is `1`. A paid run is one cycle: it reads the shop balance,
 * pays, and then runs `return.py` so those sats are sold back to the same
 * account. It does not exit successfully while the shop still holds them.
 * It does not print the signing key, the RPC URL, the deposit address, or
 * the BOLT11.
 *
 * This file is not part of `bun test` or Playwright. How to run it is in
 * `scripts/shop-staging-e2e/README.md`. Dated results are in `records/`.
 */

import { dlopen } from 'bun:ffi';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const CYCLE_ENV = [
  'SHOP_SPARK_MNEMONIC',
  'SHOP_SPARK_STORAGE',
  'BREEZ_API_KEY',
  'ORCHESTRA_API_KEY',
  'SHOP_E2E_STATE',
  'SHOP_EVM_RPC_URL',
] as const;

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function outsideRepo(path: string): boolean {
  const root = resolve(repoRoot());
  const target = resolve(path);
  return target !== root && !target.startsWith(root + sep);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// flock(2): LOCK_EX|LOCK_NB and LOCK_UN. The same bits on darwin and linux.
const LOCK_EX_NB = 6;
const LOCK_UN = 8;

function openCycleLock() {
  return dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
    flock: {
      args: ['i32', 'i32'] as const,
      returns: 'i32' as const,
    },
  });
}

let cycleLock: ReturnType<typeof openCycleLock> | undefined;

function libcFlock(fd: number, operation: number): number {
  if (process.platform !== 'darwin' && process.platform !== 'linux') fail('state_not_fresh');
  if (cycleLock === undefined) cycleLock = openCycleLock();
  return cycleLock.symbols.flock(fd, operation);
}

function withCycleLock(statePath: string, body: () => void): void {
  const lockPath = `${statePath}.lock`;
  const fd = openSync(lockPath, 'a+', 0o600);
  let held = false;
  try {
    chmodSync(lockPath, 0o600);
    if ((statSync(lockPath).mode & 0o077) !== 0) fail('state_not_private');
    if (libcFlock(fd, LOCK_EX_NB) !== 0) fail('state_not_fresh');
    held = true;
    body();
  } finally {
    if (held) libcFlock(fd, LOCK_UN);
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const dir = openSync(directory, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function replaceStateFile(statePath: string, body: string): void {
  const temporary = join(dirname(statePath), `.${basename(statePath)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  let durable = false;
  try {
    writeSync(fd, body);
    fsyncSync(fd);
    durable = true;
  } finally {
    closeSync(fd);
    if (!durable) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file is already gone.
      }
    }
  }
  try {
    renameSync(temporary, statePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone.
    }
    throw error;
  }
  fsyncDirectory(dirname(statePath));
  chmodSync(statePath, 0o600);
}

function readStateObject(statePath: string): Record<string, unknown> {
  if ((statSync(statePath).mode & 0o077) !== 0) fail('state_not_private');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
  } catch {
    fail('state_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('state_invalid');
  return parsed as Record<string, unknown>;
}

function claimState(statePath: string): string {
  let token = '';
  withCycleLock(statePath, () => {
    token = writeClaim(statePath);
  });
  return token;
}

function writeClaim(statePath: string): string {
  const token = randomUUID();
  const body = `${JSON.stringify({ cycleClaim: token }, null, 2)}\n`;
  if (!existsSync(statePath)) {
    try {
      const fd = openSync(statePath, 'wx', 0o600);
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(dirname(statePath));
      chmodSync(statePath, 0o600);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  const current = readStateObject(statePath);
  if (current['cycleClaim'] === token) return token;
  if (Object.keys(current).length > 0) fail('state_not_fresh');
  const lock = `${statePath}.claim`;
  try {
    const lockFd = openSync(lock, 'wx', 0o600);
    closeSync(lockFd);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') fail('state_not_fresh');
    throw error;
  }
  chmodSync(lock, 0o600);
  fsyncDirectory(dirname(statePath));
  const again = readStateObject(statePath);
  if (Object.keys(again).length > 0) fail('state_not_fresh');
  replaceStateFile(statePath, body);
  const claimed = readStateObject(statePath);
  if (claimed['cycleClaim'] !== token) fail('state_not_fresh');
  return token;
}

function markCycleOpen(startSats: number, amountSats: string, token: string): void {
  const statePath = required('SHOP_E2E_STATE');
  withCycleLock(statePath, () => {
    const current = readStateObject(statePath);
    if (current['cycleClaim'] !== token) fail('state_not_fresh');
    const amount = Number(amountSats);
    const body = `${JSON.stringify({ startSats, amount }, null, 2)}\n`;
    replaceStateFile(statePath, body);
    const written = readStateObject(statePath);
    if (written['startSats'] !== startSats || written['amount'] !== amount) fail('state_not_fresh');
  });
}

function payerAddress(): Address {
  return privateKeyToAccount(privateKey()).address;
}

function assertCycleReady(payer: Address, method: string): string {
  for (const name of CYCLE_ENV) required(name);
  const storage = required('SHOP_SPARK_STORAGE');
  if (!isAbsolute(storage) || !outsideRepo(storage)) fail('storage_inside_repo');
  const statePath = required('SHOP_E2E_STATE');
  if (!isAbsolute(statePath) || !outsideRepo(statePath)) fail('state_inside_repo');
  const chain = env('SHOP_CHAIN');
  if (chain !== undefined && chain.toLowerCase() !== method.toLowerCase()) fail('chain_mismatch');
  const configured = env('SHOP_PAYER_ADDRESS');
  if (configured !== undefined && configured.toLowerCase() !== payer.toLowerCase()) {
    fail('payer_mismatch');
  }
  return claimState(statePath);
}

interface ReturnResult {
  code: number;
  lines: string[];
}

function runReturn(extra: Record<string, string>): Promise<ReturnResult> {
  const bin = env('SHOP_E2E_PYTHON') ?? 'python3';
  const script = join(dirname(fileURLToPath(import.meta.url)), 'return.py');
  return new Promise((resolve) => {
    const child = spawn(bin, [script], {
      env: { ...process.env, ...extra },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const lines: string[] = [];
    let pending = '';
    const take = (chunk: Buffer | string): void => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) {
        console.warn(line);
        lines.push(line);
      }
    };
    if (child.stderr === null) {
      child.kill();
      resolve({ code: 1, lines: ['return_spawn'] });
      return;
    }
    child.stderr.on('data', take);
    child.on('error', () => {
      console.warn('return_spawn');
      resolve({ code: 1, lines });
    });
    child.on('close', (code) => {
      if (pending !== '') {
        console.warn(pending);
        lines.push(pending);
      }
      resolve({ code: code ?? 1, lines });
    });
  });
}

async function shopStartSats(payer: Address, method: string, asset: string): Promise<number> {
  const result = await runReturn({
    SHOP_E2E_RETURN: 'probe',
    SHOP_PAYER_ADDRESS: payer,
    SHOP_CHAIN: method.toLowerCase(),
    SHOP_ASSET: asset,
  });
  const line = result.lines.find((row) => row.startsWith('shop_balance_sats='));
  const text = line?.slice('shop_balance_sats='.length);
  if (result.code !== 0 || text === undefined || !/^[0-9]+$/.test(text))
    fail('shop_balance_unread');
  return Number(text);
}

async function returnHome(
  payer: Address,
  method: string,
  asset: string,
  startSats: number,
  amountSats: string,
): Promise<void> {
  console.warn('cycle=return');
  const extra = {
    SHOP_E2E_RETURN: '1',
    SHOP_PAYER_ADDRESS: payer,
    SHOP_CHAIN: method.toLowerCase(),
    SHOP_ASSET: asset,
    SHOP_START_SATS: String(startSats),
    SHOP_AMOUNT_SATS: amountSats,
  };
  const deadline = Date.now() + 3 * 60 * 1000;
  let last = await runReturn(extra);
  while (
    last.code !== 0 &&
    last.lines.some((row) => row.trim() === 'shop_not_credited') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    last = await runReturn(extra);
  }
  const home = last.code === 0 && last.lines.some((row) => row.trim() === 'return=home');
  if (!home) fail('return_failed');
  console.warn('cycle=home');
}

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
  console.warn(`quote_status=${result.status}`);
  const code = stringField(result.body, 'code');
  if (code !== undefined) console.warn(`quote_code=${code}`);
  if (result.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await request(url, userAgent, 'POST', { amountSats });
    console.warn(`quote_status=${result.status}`);
    const retryCode = stringField(result.body, 'code');
    if (retryCode !== undefined) console.warn(`quote_code=${retryCode}`);
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
  console.warn(`payer=${account.address}`);
  console.warn(`chain_id=${parsed.chainId}`);
  console.warn(`units=${parsed.units.toString()}`);
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
  console.warn(`balance_units=${balance.toString()}`);
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
  console.warn(`tx=${hash}`);
  let receipt: { status: string };
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch {
    fail('receipt_pending');
  }
  console.warn(`receipt_status=${receipt.status}`);
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
  let payer: Address | undefined;
  let startSats = 0;
  let cycleClaim = '';
  if (pay) {
    payer = payerAddress();
    cycleClaim = assertCycleReady(payer, method);
    startSats = await shopStartSats(payer, method, asset);
    console.warn(`shop_start_sats=${startSats}`);
  }

  const opened = await openPayment(apiBase, username, amountSats, userAgent);
  if (opened.status !== 200) fail('quote_failed');
  const paymentFromOpen = stringField(opened.body, 'payment');
  if (paymentFromOpen !== undefined) console.warn(`payment=${paymentFromOpen}`);
  const expiresAt = stringField(opened.body, 'expiresAt');
  if (expiresAt !== undefined) console.warn(`quote_expires=${expiresAt}`);

  const lnurl = await request(
    `${appBase}/.well-known/lnurlp/${encodeURIComponent(username)}`,
    userAgent,
  );
  console.warn(`lnurl_status=${lnurl.status}`);
  const listed = offers(lnurl.body);
  console.warn(
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
  console.warn(`detail_status=${detail.status}`);
  const uri = stringField(detail.body, 'uri');
  if (detail.status !== 200 || uri === undefined) fail('detail_missing');
  if (!pay) {
    console.warn('pay=skipped');
    return;
  }

  const rpcUrl = required('SHOP_EVM_RPC_URL');
  markCycleOpen(startSats, amountText, cycleClaim);
  const tx = await payTransfer(uri, rpcUrl);
  const proofUrl =
    `${appBase}/lnurlp/tx/${encodeURIComponent(username)}` +
    `?quote=${encodeURIComponent(quoteId)}&method=${encodeURIComponent(method)}` +
    `&asset=${encodeURIComponent(asset)}&tx=${encodeURIComponent(tx)}`;
  const proof = await request(proofUrl, userAgent);
  console.warn(`proof_status=${proof.status}`);
  const proofCode = stringField(proof.body, 'code');
  if (proofCode !== undefined) console.warn(`proof_code=${proofCode}`);
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
    console.warn(`wait=${wait.status}:${state ?? ''}:${inner ?? ''}`);
    if (state === 'Completed' || inner === 'paid') {
      settled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (!settled) fail('not_paid');
  if (payer === undefined) fail('payer_missing');
  await returnHome(payer, method, asset, startSats, amountText);
}

main().catch(() => fail('unexpected'));
