/**
 * Live loan cycle: one borrower, three givers, a PHP ask, 110 days.
 *
 * Gifts are 550, 220 and 110 sats (5.50, 2.20 and 1.10 PHP at the fixture
 * rate of one cent per sat). That is 330 non-zero shares. Spark moves the
 * sats; Lightning is not used. Spare sats stay on the funding wallet.
 * Afterwards every party sends its remainder back there, and a sweep that
 * Spark refuses is tried again.
 *
 * Not part of `bun run e2e`. The API invoice cap is 20 per hour in memory,
 * so this process restarts the test server between batches. The public note
 * has no event id; `payable` is the signed-note gate. A local relay accepts
 * receipts so they are not sent to a public relay. Wallets, the Breez API
 * key, and the test database password stay in LOAN_E2E_DIR.
 *
 * `LOAN_E2E_UI=1` drives the same cycle through the app screens
 * (`LOAN_E2E_APP`). The screens mint every invoice. This process pays the
 * Spark invoice each click created, because the pay slot only sends from an
 * in-app wallet. `LOAN_E2E_FRESH=1` drops the previous test database and loan
 * state. Wallet files in LOAN_E2E_DIR stay. The screen path reads the peso
 * amount through the spot quote, so this process serves the same cent-per-sat
 * price the gift row uses, and it does not open a gift until the note is
 * payable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { selfCheck } from './bolt11.mjs';
import { createPasskey, registrationResponse } from './webauthn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAP_MS = 11_000;
const REPAY_BATCH = 20;
const GIVERS = [
  { role: 'giver-a', username: 'loangivera', name: 'Giver large', sats: 550, php: '5.50' },
  { role: 'giver-b', username: 'loangiverb', name: 'Giver mid', sats: 220, php: '2.20' },
  { role: 'giver-c', username: 'loangiverc', name: 'Giver small', sats: 110, php: '1.10' },
];
const BORROWER = { role: 'borrower', username: 'loanborrower', name: 'Loan borrower' };
const PARTIES = [BORROWER, ...GIVERS];

const dir = process.env['LOAN_E2E_DIR'] ?? '';
const PUBLIC_BASE_URL = 'https://loan.test';
let apiKey = process.env['LOAN_E2E_BREEZ_API_KEY'] ?? '';
const python = process.env['LOAN_E2E_PYTHON'] ?? 'python3';
const bun = process.env['LOAN_E2E_BUN'] ?? 'bun';

/** @type {import('node:child_process').ChildProcess | null} */
let apiProcess = null;
/** @type {import('node:child_process').ChildProcess | null} */
let lnurlProcess = null;
/** @type {import('node:child_process').ChildProcess | null} */
let relayProcess = null;
/** @type {import('node:child_process').ChildProcess | null} */
let spotProcess = null;

const RELAY_URL = 'ws://127.0.0.1:3998';
const SPOT_URL = 'http://127.0.0.1:3996/v2/exchange-rates?currency=BTC';

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

/**
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return text.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://[redacted]@');
}

/**
 * @returns {Record<string, unknown>}
 */
function readState() {
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) {
    return { paid: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {Record<string, unknown>} state
 */
function writeState(state) {
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * @param {string[]} args
 * @returns {{ ok: true, stdout: string } | { ok: false, error: string }}
 */
function sparkTry(args) {
  const retryable = args[0] !== 'pay' && args[0] !== 'sweep';
  let last = 'spark failed';
  for (let attempt = 1; attempt <= (retryable ? 3 : 1); attempt += 1) {
    /** @type {import('node:child_process').SpawnSyncReturns<string> | undefined} */
    let result;
    try {
      result = spawnSync(python, [path.join(HERE, 'spark.py'), ...args], {
        env: { ...process.env, LOAN_E2E_DIR: dir, LOAN_E2E_BREEZ_API_KEY: apiKey },
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      last = error instanceof Error ? error.message : 'spark failed';
      if (!retryable || !last.includes('ECONNRESET')) {
        fail(`spark ${args[0]} ${args[1] ?? ''} ${last}`);
      }
      spawnSync('sleep', ['2']);
      continue;
    }
    if (result.status === 0) {
      return { ok: true, stdout: result.stdout ?? '' };
    }
    last = redact(`${result.stderr ?? ''}${result.error?.message ?? ''}`);
    if (!retryable || !last.includes('ECONNRESET')) {
      return { ok: false, error: last };
    }
    spawnSync('sleep', ['2']);
  }
  return { ok: false, error: last };
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function spark(args) {
  const result = sparkTry(args);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    fail(`spark ${args[0]} ${args[1] ?? ''} failed`);
  }
  return result.stdout;
}

/**
 * Pay one Spark invoice from a wallet that is not the recipient.
 * The borrower pays first. A wallet whose coins can no longer be split
 * is skipped, and so is a payment back to that same wallet.
 *
 * @param {Record<string, unknown>} state
 * @param {string} invoice
 * @param {string} recipientAccountId
 */
function payInvoice(state, invoice, recipientAccountId) {
  const accounts = /** @type {Record<string, { id: string }>} */ (state['accounts'] ?? {});
  const recipient = Object.keys(accounts).find((role) => accounts[role]?.id === recipientAccountId);
  const errors = [];
  for (const role of ['borrower', 'giver-c', 'giver-a', 'giver-b', 'funding']) {
    if (role === recipient) {
      continue;
    }
    const result = sparkTry(['pay', role, invoice]);
    if (result.ok) {
      process.stdout.write(`paid by ${role}\n`);
      return;
    }
    errors.push(result.error);
    const text = result.error.toLowerCase();
    const skip =
      text.includes('select leaves') ||
      text.includes('self payment') ||
      text.includes('insufficient funds');
    if (!skip) {
      process.stderr.write(`${result.error}\n`);
      fail(`spark pay ${role} failed`);
    }
  }
  fail(`spark pay failed ${errors.join(' ')}`);
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
function lines(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return out;
}

/**
 * @param {string} sql
 * @returns {string}
 */
function psql(sql) {
  const databaseUrl = fs.readFileSync(path.join(dir, 'database-url'), 'utf8').trim();
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(redact(`${result.stderr ?? ''}\n`));
    fail('database query failed');
  }
  return (result.stdout ?? '').trim();
}

/**
 * A receipt recorded after `goal_funded_at` is not a giver. Moving the funded
 * time back without these gift receipts would drop them from the ledger.
 *
 * @param {string} messageId
 */
function keepGiftsInsideFunding(messageId) {
  const amounts = GIVERS.map((giver) => String(giver.sats)).join(', ');
  psql(
    `UPDATE nostr_zap_receipt AS r
       SET recorded_at = m.goal_funded_at
       FROM message AS m
      WHERE r.message_id = m.id
        AND m.id = '${messageId}'
        AND m.goal_funded_at IS NOT NULL
        AND r.sats IN (${amounts})
        AND (r.recorded_at IS NULL OR r.recorded_at > m.goal_funded_at)`,
  );
}

/**
 * @param {string} method
 * @param {string} requestPath
 * @param {{ token?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
function api(method, requestPath, options = {}) {
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: 3000,
        method,
        path: requestPath,
        agent: false,
        headers: {
          origin: 'http://localhost:3000',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(payload === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(payload.byteLength),
              }),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text !== '') {
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text.slice(0, 200) };
            }
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.setTimeout(60_000, () => {
      request.destroy(new Error('API request timed out'));
    });
    request.on('error', reject);
    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}

/**
 * @param {{ status: number, json: any }} response
 * @param {string} what
 * @returns {any}
 */
function ok(response, what) {
  if (response.status < 200 || response.status >= 300) {
    const error = response.json?.error ?? response.status;
    fail(`${what} -> ${response.status} ${error}`);
  }
  return response.json;
}

async function waitFixtureSpot() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await api('GET', '/fx/spot');
      const php = Number(response.json?.rates?.PHP ?? '0');
      if (response.status === 200 && php === 1_000_000) {
        process.stdout.write('spot fixture\n');
        return;
      }
    } catch {
      /* still booting */
    }
    await sleep(500);
  }
  fail('spot rate is not the fixture');
}

async function waitPayable(messageId, token) {
  for (let i = 0; i < 30; i += 1) {
    const note = ok(await api('GET', `/messages/${messageId}`, { token }), 'read loan');
    if (note.payable === true) {
      process.stdout.write('loan payable\n');
      return;
    }
    await sleep(1000);
  }
  fail('loan is not payable');
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await api('GET', '/healthz');
      if (response.status === 200) {
        return;
      }
    } catch {
      /* still booting */
    }
    await sleep(500);
  }
  fail('API did not become ready');
}

/**
 * @param {Record<string, string>} env
 */
function startApi(env) {
  const log = fs.openSync(path.join(dir, 'api.log'), 'a');
  apiProcess = spawn(bun, ['src/index.ts'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  apiProcess.unref();
}

function stopChild(child) {
  if (child?.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/**
 * @returns {Record<string, string>}
 */
function apiEnv() {
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  const databaseUrl = fs.readFileSync(path.join(dir, 'database-url'), 'utf8').trim();
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BIND_ADDR: '127.0.0.1:3000',
    WEBAUTHN_RP_ID: 'localhost',
    PUBLIC_BASE_URL,
    LNURL_SERVER_URL: 'http://127.0.0.1:3999',
    LNURL_ZAP_NSEC_HEX: secrets.nsec,
    NOSTR_NSEC_KEK: secrets.kek,
    NOSTR_RELAY_SPACE: RELAY_URL,
    NOSTR_RELAY_PUBLIC: RELAY_URL,
    BTC_FIAT_SPOT_URL: SPOT_URL,
    MEDIA_DIR: path.join(dir, 'media'),
  };
}

async function restartApi() {
  stopChild(apiProcess);
  apiProcess = null;
  await sleep(1000);
  startApi(apiEnv());
  await waitHealth();
}

function ensureDir() {
  if (dir === '') {
    fail('LOAN_E2E_DIR is required');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (apiKey === '') {
    const keyFile = path.join(dir, 'breez.key');
    if (fs.existsSync(keyFile)) {
      apiKey = fs.readFileSync(keyFile, 'utf8').trim();
    }
  }
  if (apiKey === '') {
    fail('LOAN_E2E_BREEZ_API_KEY is required');
  }
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const secretsFile = path.join(dir, 'secrets.json');
  if (!fs.existsSync(secretsFile)) {
    fs.writeFileSync(
      secretsFile,
      `${JSON.stringify({
        nsec: randomBytes(32).toString('hex'),
        kek: randomBytes(32).toString('hex'),
      })}\n`,
      { mode: 0o600 },
    );
  }
}

function ensureDatabase() {
  const file = path.join(dir, 'database-url');
  if (fs.existsSync(file)) {
    return;
  }
  const password = randomBytes(18).toString('hex');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--name',
      'loan-e2e-pg',
      '--rm',
      '-d',
      '-p',
      '127.0.0.1:54329:5432',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_USER=loan',
      '-e',
      'POSTGRES_DB=loan',
      'postgres:16',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(redact(result.stderr ?? ''));
    fail('could not start the test database');
  }
  fs.writeFileSync(file, `postgres://loan:${password}@127.0.0.1:54329/loan\n`, { mode: 0o600 });
}

function ensureGiftTable() {
  const databaseUrl = fs.readFileSync(path.join(dir, 'database-url'), 'utf8').trim();
  const result = spawnSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'docs/schema/gift.sql')],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(redact(`${result.stderr ?? ''}\n`));
    fail('could not create the gift table');
  }
}

async function waitDatabase() {
  const databaseUrl = fs.readFileSync(path.join(dir, 'database-url'), 'utf8').trim();
  for (let i = 0; i < 60; i += 1) {
    const result = spawnSync('psql', [databaseUrl, '-c', 'SELECT 1'], { encoding: 'utf8' });
    if (result.status === 0) {
      return;
    }
    await sleep(500);
  }
  fail('test database did not become ready');
}

function startSpot() {
  const log = fs.openSync(path.join(dir, 'spot.log'), 'a');
  spotProcess = spawn(process.env['LOAN_E2E_NODE'] ?? 'node', [path.join(HERE, 'spot.mjs')], {
    cwd: ROOT,
    env: { ...process.env, LOAN_E2E_SPOT_PORT: '3996' },
    detached: true,
    stdio: ['ignore', log, log],
  });
  spotProcess.unref();
}

function startRelay() {
  const log = fs.openSync(path.join(dir, 'relay.log'), 'a');
  relayProcess = spawn(process.env['LOAN_E2E_NODE'] ?? 'node', [path.join(HERE, 'relay.mjs')], {
    cwd: ROOT,
    env: { ...process.env, LOAN_E2E_RELAY_PORT: '3998' },
    detached: true,
    stdio: ['ignore', log, log],
  });
  relayProcess.unref();
}

/**
 * @param {number} port
 */
async function waitPort(port) {
  for (let i = 0; i < 50; i += 1) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open === true) {
      return;
    }
    await sleep(100);
  }
  fail(`nothing is listening on ${port}`);
}

function startLnurl() {
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  const log = fs.openSync(path.join(dir, 'lnurl.log'), 'a');
  lnurlProcess = spawn(bun, [path.join(HERE, 'lnurl.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      LNURL_ZAP_NSEC_HEX: secrets.nsec,
      LOAN_E2E_PARTIES: path.join(dir, 'parties.json'),
      LOAN_E2E_LNURL_PORT: '3999',
      PUBLIC_BASE_URL,
    },
    detached: true,
    stdio: ['ignore', log, log],
  });
  lnurlProcess.unref();
}

/**
 * @param {{ role: string, username: string, name: string }} party
 * @param {string} identity
 * @returns {Promise<{ id: string, token: string }>}
 */
async function registerParty(party, identity) {
  const begin = ok(
    await api('POST', '/auth/passkey/register/begin', { body: { name: party.username } }),
    `register ${party.username}`,
  );
  const passkey = createPasskey();
  const credential = registrationResponse(passkey, begin.options.challenge);
  const finish = ok(
    await api('POST', '/auth/passkey/register/finish', {
      body: { challengeId: begin.challengeId, credential },
    }),
    `finish ${party.username}`,
  );
  const token = finish.token;
  const id = finish.account?.id;
  if (typeof token !== 'string' || typeof id !== 'string') {
    fail(`register ${party.username} returned no session`);
  }
  ok(
    await api('POST', '/me/name', { token, body: { name: party.name } }),
    `name ${party.username}`,
  );
  ok(await api('POST', '/me/rules-agreement', { token, body: {} }), `rules ${party.username}`);
  // A new registration already marks the account wallet-required. The seed
  // ceremony is only for an older account that still lacks that mark, and
  // begin returns 409 once the mark is set.
  ok(
    await api('PUT', '/me/wallet', { token, body: { sparkPubkey: identity } }),
    `wallet ${party.username}`,
  );
  ok(
    await api('POST', `/lnurlpay/${identity}`, { token, body: { username: party.username } }),
    `verify ${party.username}`,
  );
  return { id, token };
}

function fixtureGift() {
  psql(
    `INSERT INTO btc_fiat_spot (id, usd, chf, eur, php, source, as_of)
     VALUES (1, 1000000, 1000000, 1000000, 1000000, 'loan-e2e', now())
     ON CONFLICT (id) DO UPDATE SET
       usd = EXCLUDED.usd,
       chf = EXCLUDED.chf,
       eur = EXCLUDED.eur,
       php = EXCLUDED.php,
       source = EXCLUDED.source,
       as_of = EXCLUDED.as_of
     WHERE btc_fiat_spot.as_of <= EXCLUDED.as_of OR btc_fiat_spot.as_of > now()`,
  );
  psql(
    `INSERT INTO gift (
       paid_at, direction, currency, amount_sats, fee_sats, recipient_wos_user,
       lightning_invoice, description, point_of_sale, source_wallet, kind,
       fiat_usd, fiat_chf, fiat_eur, fiat_php
     ) VALUES (
       now(), 'outbound', 'BTC', 100000000, 0, 'rate',
       'loan-e2e-rate-day', 'loan-e2e rate day', false, 'loan-e2e', 'daily',
       1000000.00, 1000000.00, 1000000.00, 1000000.00
     ) ON CONFLICT (lightning_invoice) DO NOTHING`,
  );
}

/**
 * @param {string} messageId
 * @param {string} token
 * @returns {Promise<any>}
 */
async function repayment(messageId, token) {
  return ok(await api('GET', `/messages/${messageId}/repayment`, { token }), 'repayment');
}

/**
 * @param {string} fromRole
 * @param {string} invoice
 */
function paySpark(fromRole, invoice) {
  spark(['pay', fromRole, invoice]);
}

/**
 * @param {Record<string, unknown>} state
 */
async function fundGifts(state) {
  const accounts = /** @type {Record<string, { token: string }>} */ (state['accounts']);
  const messageId = /** @type {string} */ (state['messageId']);
  const paid = new Set(/** @type {string[]} */ (state['paid'] ?? []));
  for (const giver of GIVERS) {
    let ledger = await repayment(messageId, accounts[giver.role].token);
    const row = (ledger.givers ?? []).find((giverRow) => giverRow.username === giver.username);
    if (row !== undefined && Number(row.givenSats) >= giver.sats) {
      continue;
    }
    const started = Date.now();
    const invoice = ok(
      await api('POST', `/messages/${messageId}/invoice`, {
        token: accounts[giver.role].token,
        body: {
          sats: giver.sats,
          text: 'gift',
          amountUsd: '0.10',
          amountChf: '0.09',
          amountEur: '0.09',
          amountPhp: giver.php,
        },
      }),
      `gift ${giver.username}`,
    );
    if (typeof invoice.sparkInvoice !== 'string' || invoice.sparkInvoice === '') {
      fail(`gift ${giver.username} has no spark invoice`);
    }
    if (!paid.has(invoice.sparkInvoice)) {
      paySpark(giver.role, invoice.sparkInvoice);
      paid.add(invoice.sparkInvoice);
      state['paid'] = [...paid];
      writeState(state);
    }
    for (let i = 0; i < 30; i += 1) {
      ledger = await repayment(messageId, accounts[BORROWER.role].token);
      const updated = (ledger.givers ?? []).find(
        (giverRow) => giverRow.username === giver.username,
      );
      if (updated !== undefined && Number(updated.givenSats) >= giver.sats) {
        break;
      }
      if (i === 29) {
        fail(`gift ${giver.username} was not credited`);
      }
      await sleep(2000);
    }
    const wait = GAP_MS - (Date.now() - started);
    if (wait > 0) {
      await sleep(wait);
    }
  }
}

/**
 * @param {Record<string, unknown>} state
 */
async function repayAll(state) {
  const accounts = /** @type {Record<string, { token: string }>} */ (state['accounts']);
  const messageId = /** @type {string} */ (state['messageId']);
  const token = accounts[BORROWER.role].token;
  const paid = new Set(/** @type {string[]} */ (state['paid'] ?? []));
  let posts = 0;
  let stalled = 0;
  for (;;) {
    const ledger = await repayment(messageId, token);
    if (ledger.next === null && ledger.daysPaid === 110) {
      return;
    }
    if (ledger.next === null) {
      stalled += 1;
      if (stalled > 5) {
        fail(`repayment stopped at day ${ledger.daysPaid} of ${ledger.daysDue}`);
      }
      await sleep(2000);
      continue;
    }
    stalled = 0;
    const key = `${ledger.next.dayIndex}:${ledger.next.recipientAccountId}`;
    const started = Date.now();
    const response = await api('POST', `/messages/${messageId}/repayment`, { token, body: {} });
    if (response.status === 429) {
      process.stdout.write('repayment batch restart\n');
      await restartApi();
      posts = 0;
      await sleep(GAP_MS);
      continue;
    }
    const invoice = ok(response, `repay ${key}`);
    if (typeof invoice.sparkInvoice !== 'string' || invoice.sparkInvoice === '') {
      fail(`repay ${key} has no spark invoice`);
    }
    if (!paid.has(invoice.sparkInvoice)) {
      payInvoice(state, invoice.sparkInvoice, ledger.next.recipientAccountId);
      paid.add(invoice.sparkInvoice);
      state['paid'] = [...paid];
      writeState(state);
    }
    for (let i = 0; i < 30; i += 1) {
      const updated = await repayment(messageId, token);
      const still = updated.next;
      const moved = still === null || `${still.dayIndex}:${still.recipientAccountId}` !== key;
      if (moved) {
        break;
      }
      if (i === 29) {
        fail(`repay ${key} was not credited`);
      }
      await sleep(2000);
    }
    posts += 1;
    process.stdout.write(`repaid ${key} amount=${invoice.amountSats}\n`);
    if (posts >= REPAY_BATCH) {
      await restartApi();
      posts = 0;
    }
    const wait = GAP_MS - (Date.now() - started);
    if (wait > 0) {
      await sleep(wait);
    }
  }
}

function assertLedger(messageId, tokenPromise) {
  return tokenPromise.then(async (token) => {
    const ledger = await repayment(messageId, token);
    const paidRows = (ledger.repayments ?? []).filter((row) => row.status === 'paid');
    if (ledger.currency !== 'PHP' || ledger.termDays !== 110) {
      fail(`ledger shape currency=${ledger.currency} term=${ledger.termDays}`);
    }
    if ((ledger.repayments ?? []).length !== 330 || paidRows.length !== 330) {
      fail(`ledger slices ${(ledger.repayments ?? []).length} paid ${paidRows.length}`);
    }
    if (Number(ledger.daysPaid) !== 110) {
      fail(`days paid ${ledger.daysPaid}`);
    }
    const byUser = new Map((ledger.givers ?? []).map((row) => [row.username, row]));
    for (const giver of GIVERS) {
      const row = byUser.get(giver.username);
      if (
        row === undefined ||
        row.givenAmount !== giver.php ||
        Number(row.givenSats) !== giver.sats
      ) {
        fail(`giver ${giver.username} recorded ${row?.givenAmount} / ${row?.givenSats}`);
      }
    }
    const stored = psql(
      `SELECT goal_sats::text || ' ' || sats::text || ' ' ||
              (SELECT count(*)::text FROM message_repayment WHERE message_id = message.id)
       FROM message WHERE id = '${messageId}'`,
    );
    process.stdout.write(`ledger ${stored}\n`);
    const numbers = stored.split(' ');
    if (Number(numbers[1]) !== 880 || !(Number(numbers[0]) < 880) || Number(numbers[2]) !== 330) {
      fail(`stored loan ${stored}`);
    }
  });
}

/**
 * @param {string} fundingAddress
 */
function sweep(fundingAddress) {
  /** @type {string[]} */
  const stuck = [];
  for (const party of PARTIES) {
    let balance = partyBalance(party.role);
    for (let attempt = 1; balance > 0 && attempt <= 4; attempt += 1) {
      sparkTry(['sweep', party.role, fundingAddress]);
      balance = partyBalance(party.role);
      if (balance > 0 && attempt < 4) {
        spawnSync('sleep', ['8']);
      }
    }
    process.stdout.write(`sweep ${party.role} left ${balance}\n`);
    if (balance > 0) {
      stuck.push(`${party.role} ${balance}`);
    }
  }
  if (stuck.length > 0) {
    fail(`sweep left ${stuck.join(', ')}`);
  }
}

function resetLoanDatabase() {
  spawnSync('docker', ['rm', '-f', 'loan-e2e-pg'], { encoding: 'utf8' });
  const file = path.join(dir, 'database-url');
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  writeState({ paid: [] });
}

/**
 * @param {string} role
 * @returns {number}
 */
function partyBalance(role) {
  return Number(lines(spark(['balance', role]))['balance_sats'] ?? '0');
}

/**
 * Pay one chunk from the funding wallet. The whole amount is tried first.
 * Spark often cannot select leaves for that exact size, so the next try is
 * the next smaller power of two. Zero means nothing moved.
 *
 * @param {string} role
 * @param {number} left
 * @returns {number}
 */
function payFundingChunk(role, left) {
  /** @type {number[]} */
  const sizes = [left];
  let chunk = 2 ** Math.floor(Math.log2(left));
  if (chunk === left) {
    chunk /= 2;
  }
  while (chunk >= 1) {
    sizes.push(chunk);
    chunk /= 2;
  }
  for (const size of sizes) {
    const invoiced = sparkTry(['invoice', role, String(size)]);
    if (!invoiced.ok) {
      continue;
    }
    const request = invoiced.stdout.trim();
    if (request === '') {
      continue;
    }
    const paid = sparkTry(['pay', 'funding', request]);
    if (paid.ok) {
      return size;
    }
  }
  return 0;
}

/**
 * Send each giver exactly its gift. Spare sats stay on the funding wallet.
 * Paying it whatever is left in one payment is the size Spark refuses.
 */
function fundGiverWallets() {
  for (const giver of GIVERS) {
    let left = giver.sats - partyBalance(giver.role);
    while (left > 0) {
      const size = payFundingChunk(giver.role, left);
      if (size === 0) {
        fail(`could not fund ${giver.role}, ${left} still to send`);
      }
      left -= size;
      process.stdout.write(`split ${giver.role} ${size}\n`);
    }
  }
}

/**
 * @param {Record<string, { id: string, token: string }>} accounts
 */
async function prepareMembers(accounts) {
  for (const party of PARTIES) {
    const account = accounts[party.role];
    if (account === undefined || !/^[0-9a-f-]{36}$/i.test(account.id)) {
      fail(`account ${party.role} is missing`);
    }
    const token = account.token;
    const me = ok(await api('GET', '/me', { token }), `me ${party.username}`);
    if (typeof me.username !== 'string' || me.username === '') {
      ok(
        await api('POST', '/me/username', { token, body: { username: party.username } }),
        `username ${party.username}`,
      );
    }
    ok(await api('POST', '/me/fiat', { token, body: { fiat: 'PHP' } }), `fiat ${party.username}`);
    ok(
      await api('POST', '/me/amount-unit', { token, body: { unit: 'fiat' } }),
      `unit ${party.username}`,
    );
    psql(`UPDATE account SET role = 'verified' WHERE id = '${account.id}'`);
    process.stdout.write(`prepared ${party.username}\n`);
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16_000) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Playwright has to be a child. This process also answers the control
 * server. A blocking spawn never reads that request, so the health check
 * waits until it gives up.
 *
 * @param {string} appDir
 * @returns {Promise<number>}
 */
function waitForScreens(appDir) {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', '-c', 'playwright.loan.config.ts', '--reporter=line'],
      {
        cwd: appDir,
        env: { ...process.env, LOAN_E2E_DIR: dir },
        stdio: 'inherit',
      },
    );
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM');
      },
      6 * 60 * 60 * 1000,
    );
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}

/**
 * @param {Record<string, unknown>} state
 * @returns {Promise<void>}
 */
async function driveApp(state) {
  const appDir = process.env['LOAN_E2E_APP'] ?? '';
  if (appDir === '') {
    fail('LOAN_E2E_APP is required');
  }
  const accounts = /** @type {Record<string, { id: string, token: string }>} */ (state['accounts']);
  const controlToken = randomBytes(16).toString('hex');
  const ui = {
    controlToken,
    goalAmount: '8.68',
    termDays: 110,
    text: 'Loan of 8.68 PHP over 110 days',
    borrower: {
      role: BORROWER.role,
      username: BORROWER.username,
      token: accounts[BORROWER.role]?.token,
    },
    givers: GIVERS.map((giver) => ({
      role: giver.role,
      username: giver.username,
      php: giver.php,
      sats: giver.sats,
      token: accounts[giver.role]?.token,
    })),
  };
  fs.writeFileSync(path.join(dir, 'ui.json'), `${JSON.stringify(ui)}\n`, { mode: 0o600 });
  for (const giver of GIVERS) {
    spark(['optimize', giver.role]);
  }
  spark(['optimize', BORROWER.role]);
  /** @type {import('node:http').Server} */
  const server = http.createServer((request, response) => {
    void (async () => {
      if ((request.headers.authorization ?? '') !== `Bearer ${controlToken}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200);
        response.end('ok');
        return;
      }
      let json = {};
      try {
        const text = await readBody(request);
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      try {
        if (request.method === 'POST' && request.url === '/message') {
          const id = json.id;
          if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
            response.writeHead(400);
            response.end();
            return;
          }
          state['messageId'] = id;
          writeState(state);
          await waitPayable(id, accounts[BORROWER.role].token);
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'POST' && request.url === '/pay') {
          const invoice = json.invoice;
          const role = json.role;
          if (typeof invoice !== 'string' || invoice === '' || typeof role !== 'string') {
            response.writeHead(400);
            response.end();
            return;
          }
          if (json.mode === 'repay') {
            payInvoice(state, invoice, String(json.recipientAccountId ?? ''));
          } else {
            spark(['pay', role, invoice]);
          }
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'POST' && request.url === '/backdate') {
          const messageId = state['messageId'];
          if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(messageId)) {
            response.writeHead(400);
            response.end();
            return;
          }
          psql(
            `UPDATE message SET goal_funded_at = now() - interval '400 days' WHERE id = '${messageId}'`,
          );
          keepGiftsInsideFunding(messageId);
          state['backdated'] = true;
          writeState(state);
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'POST' && request.url === '/restart') {
          await restartApi();
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(404);
        response.end();
      } catch {
        if (!response.headersSent) {
          response.writeHead(500);
          response.end();
        }
      }
    })();
  });
  await new Promise((resolve) => {
    server.listen(3997, '127.0.0.1', () => resolve(undefined));
  });
  process.stdout.write('app screens\n');
  const status = await waitForScreens(appDir);
  server.close();
  if (status !== 0) {
    fail('app screens failed');
  }
  if (typeof state['messageId'] !== 'string') {
    const latest = readState();
    if (typeof latest['messageId'] === 'string') {
      state['messageId'] = latest['messageId'];
    }
  }
}

async function main() {
  ensureDir();
  if (process.env['LOAN_E2E_UI'] === '1' && process.env['LOAN_E2E_FRESH'] === '1') {
    resetLoanDatabase();
  }
  await selfCheck();
  ensureDatabase();
  await waitDatabase();
  ensureGiftTable();
  /** @type {Record<string, { address: string, identity: string, balance: number }>} */
  const wallets = {};
  for (const role of ['funding', ...PARTIES.map((party) => party.role)]) {
    const info = lines(spark(['ensure', role]));
    wallets[role] = {
      address: info['address'] ?? '',
      identity: info['identity'] ?? '',
      balance: Number(info['balance_sats'] ?? '0'),
    };
    process.stdout.write(`wallet ${role} balance=${wallets[role].balance}\n`);
  }
  if (wallets['funding'].balance < 1000 && readState()['messageId'] === undefined) {
    const held = PARTIES.reduce(
      (sum, party) => sum + wallets[party.role].balance,
      wallets['funding'].balance,
    );
    if (held < 1000) {
      fail(`funding balance is ${wallets['funding'].balance}, need 1000`);
    }
  }
  const parties = {};
  for (const party of PARTIES) {
    parties[party.username] = wallets[party.role].identity;
  }
  fs.writeFileSync(path.join(dir, 'parties.json'), `${JSON.stringify(parties)}\n`, { mode: 0o600 });
  startSpot();
  await waitPort(3996);
  startRelay();
  await waitPort(3998);
  startLnurl();
  await waitPort(3999);
  startApi(apiEnv());
  await waitHealth();
  fixtureGift();
  await waitFixtureSpot();
  const state = readState();
  if (state['accounts'] === undefined) {
    state['accounts'] = {};
  }
  const accounts = /** @type {Record<string, { id: string, token: string }>} */ (state['accounts']);
  for (const party of PARTIES) {
    if (accounts[party.role] === undefined) {
      accounts[party.role] = await registerParty(party, wallets[party.role].identity);
      state['accounts'] = accounts;
      writeState(state);
      process.stdout.write(`registered ${party.username}\n`);
    }
  }
  const returnAddress = wallets['funding'].address;
  let finished = false;
  try {
    const throughApp = process.env['LOAN_E2E_UI'] === '1';
    if (typeof state['messageId'] !== 'string') {
      fundGiverWallets();
    }
    if (throughApp) {
      await prepareMembers(accounts);
      await driveApp(state);
    } else if (typeof state['messageId'] !== 'string') {
      process.stdout.write('posting loan\n');
      const created = ok(
        await api('POST', '/messages', {
          token: accounts[BORROWER.role].token,
          body: {
            text: 'Loan of 8.682 PHP over 110 days',
            goalCurrency: 'PHP',
            goalAmount: '8.682',
            goalRepayable: true,
            goalTermDays: 110,
          },
        }),
        'post loan',
      );
      state['messageId'] = created.id;
      writeState(state);
    }
    const messageId = /** @type {string} */ (state['messageId']);
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
      fail('loan id is not a uuid');
    }
    if (!throughApp) {
      await waitPayable(messageId, accounts[BORROWER.role].token);
      for (const giver of GIVERS) {
        spark(['optimize', giver.role]);
      }
      keepGiftsInsideFunding(messageId);
      await fundGifts(state);
      const funded = await repayment(messageId, accounts[BORROWER.role].token);
      if (funded.fundedAt === null) {
        fail('loan did not fund');
      }
      if (state['backdated'] !== true) {
        psql(
          `UPDATE message SET goal_funded_at = now() - interval '400 days' WHERE id = '${messageId}'`,
        );
        state['backdated'] = true;
        writeState(state);
      }
      keepGiftsInsideFunding(messageId);
      spark(['optimize', BORROWER.role]);
      await repayAll(state);
    }
    await assertLedger(messageId, Promise.resolve(accounts[BORROWER.role].token));
    const fundingBefore = Number(lines(spark(['balance', 'funding']))['balance_sats'] ?? '0');
    sweep(wallets['funding'].address);
    const fundingAfter = Number(lines(spark(['balance', 'funding']))['balance_sats'] ?? '0');
    process.stdout.write(`funding ${fundingBefore} -> ${fundingAfter}\n`);
    if (fundingAfter < 1000) {
      fail(`funding address holds ${fundingAfter}, started from 1000`);
    }
    spawnSync('docker', ['rm', '-f', 'loan-e2e-pg'], { encoding: 'utf8' });
    finished = true;
    process.stdout.write('loan cycle complete\n');
  } finally {
    if (!finished && returnAddress !== '') {
      try {
        sweep(returnAddress);
        process.stdout.write('returned sats after a failed cycle\n');
      } catch {
        process.stderr.write('could not return sats after a failed cycle\n');
      }
    }
  }
}

process.on('exit', () => {
  stopChild(apiProcess);
  stopChild(lnurlProcess);
  stopChild(relayProcess);
  stopChild(spotProcess);
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'loan cycle failed';
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
});
