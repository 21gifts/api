/**
 * Self-signed certificate for the TLS stand-ins, made once per start with
 * the system `openssl`. No key is committed. The shop api trusts it through
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` in its test-only `webServer.env`; the
 * driver through Playwright's `ignoreHTTPSErrors`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PEM certificate and key. */
export interface TlsPair {
  cert: string;
  key: string;
}

/** Generate a fresh self-signed pair for `127.0.0.1` and `localhost`. */
export function selfSignedPair(): TlsPair {
  const dir = mkdtempSync(join(tmpdir(), '21gifts-shop-e2e-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}
