/**
 * LNURL stand-in for the loan cycle.
 *
 * Serves the wallet-backed pay request and the verify call the API proxies.
 * Receipt pubkeys are the same keys the API derives from `LNURL_ZAP_NSEC_HEX`.
 */
import http from 'node:http';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { getPublicKey } from 'nostr-tools/pure';
import { zapReceiptSecretKey } from '../../src/lib/nostr/zap-receipt.ts';
import { invoiceForZap } from './bolt11.mjs';

const port = Number(process.env['LOAN_E2E_LNURL_PORT'] ?? '3999');
const nsecHex = (process.env['LNURL_ZAP_NSEC_HEX'] ?? '').trim().toLowerCase();
const partiesPath = process.env['LOAN_E2E_PARTIES'] ?? '';
const publicBase = (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/$/, '');

/** @type {URL | null} */
let publicUrl = null;
try {
  publicUrl = new URL(publicBase);
} catch {
  publicUrl = null;
}

if (
  !/^[0-9a-f]{64}$/.test(nsecHex) ||
  partiesPath === '' ||
  publicUrl === null ||
  publicUrl.protocol !== 'https:' ||
  publicUrl.pathname !== '/'
) {
  process.stderr.write(
    'lnurl stand-in needs LNURL_ZAP_NSEC_HEX, LOAN_E2E_PARTIES, and an https PUBLIC_BASE_URL\n',
  );
  process.exit(2);
}

const nsec = Buffer.from(nsecHex, 'hex');

/**
 * @returns {Record<string, string>}
 */
function parties() {
  const parsed = JSON.parse(fs.readFileSync(partiesPath, 'utf8'));
  return parsed;
}

/**
 * @param {string} sparkPubkey
 * @returns {string}
 */
function receiptPubkey(sparkPubkey) {
  return getPublicKey(zapReceiptSecretKey(nsec, sparkPubkey));
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function serve(request, response) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  try {
    if (
      request.method === 'GET' &&
      segments[0] === '.well-known' &&
      segments[1] === 'lnurlp' &&
      segments[2] !== undefined
    ) {
      const username = segments[2];
      const sparkPubkey = parties()[username];
      if (sparkPubkey === undefined) {
        send(response, 404, { status: 'ERROR', reason: 'unknown' });
        return;
      }
      send(response, 200, {
        tag: 'payRequest',
        callback: `${publicBase}/lnurlp/${username}/invoice`,
        minSendable: 1000,
        maxSendable: 100_000_000_000,
        metadata: '[["text/plain","21.gifts loan"]]',
        allowsNostr: true,
        nostrPubkey: receiptPubkey(sparkPubkey),
      });
      return;
    }
    if (
      request.method === 'GET' &&
      segments[0] === 'lnurlp' &&
      segments[2] === 'invoice' &&
      segments[1] !== undefined
    ) {
      const amount = Number(url.searchParams.get('amount'));
      const zap = url.searchParams.get('nostr');
      if (!Number.isInteger(amount) || amount < 1000 || amount % 1000 !== 0 || zap === null) {
        send(response, 400, { status: 'ERROR', reason: 'bad request' });
        return;
      }
      send(response, 200, { pr: invoiceForZap(zap, amount), routes: [] });
      return;
    }
    if (request.method === 'POST' && segments[0] === 'lnurlpay' && segments[1] !== undefined) {
      send(response, 200, { status: 'OK' });
      return;
    }
    send(response, 404, { status: 'ERROR', reason: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.name : 'error';
    process.stderr.write(`lnurl ${message}\n`);
    send(response, 500, { status: 'ERROR', reason: 'failed' });
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function send(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(encoded.byteLength),
  });
  response.end(encoded);
}

const server = http.createServer((request, response) => {
  request.on('data', () => {});
  request.on('error', () => {
    response.destroy();
  });
  request.on('end', () => serve(request, response));
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`lnurl listening ${port}\n`);
});
