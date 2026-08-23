import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { PhoenixdClient } from '@/lib/phoenixd';
import { PhoenixdInvoicePayer, invoicePayerFromEnv } from '@/lib/phoenixd-invoice-payer';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const HASH = 'ab'.repeat(32);
const PREIMAGE = 'cd'.repeat(32);

describe('PhoenixdInvoicePayer', () => {
  it('is configured and maps paid to ok', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({ paymentHash: HASH, paymentPreimage: PREIMAGE });
    const payer = new PhoenixdInvoicePayer(
      new PhoenixdClient({ baseUrl: 'http://127.0.0.1:9740', password: 'pw', fetchImpl }),
    );
    expect(payer.isConfigured()).toBe(true);
    expect(await payer.payInvoice('lnbc10n1')).toEqual({ ok: true });
  });

  it('maps failed and uncertain to payment_failed', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ message: 'Invalid invoice' }, 400);
    const payer = new PhoenixdInvoicePayer(
      new PhoenixdClient({ baseUrl: 'http://127.0.0.1:9740', password: 'pw', fetchImpl }),
    );
    expect(await payer.payInvoice('x')).toEqual({ ok: false, reason: 'payment_failed' });
  });
});

describe('invoicePayerFromEnv', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns PhoenixdInvoicePayer when env is complete', () => {
    const payer = invoicePayerFromEnv(
      { PHOENIXD_URL: 'http://127.0.0.1:9740', PHOENIXD_PASSWORD: 'pw' },
      async () => jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(PhoenixdInvoicePayer);
    expect(payer.isConfigured()).toBe(true);
  });

  it('returns UnconfiguredInvoicePayer on missing env', () => {
    const payer = invoicePayerFromEnv({}, async () => jsonResponse({}));
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('phoenixd.unconfigured');
    expect(line).toContain('missing_env');
    expect(line).not.toContain('pw');
  });

  it('returns UnconfiguredInvoicePayer on invalid URL', () => {
    const payer = invoicePayerFromEnv(
      { PHOENIXD_URL: 'ftp://x', PHOENIXD_PASSWORD: 'pw' },
      async () => jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('invalid_url');
  });

  it('treats blank password as missing', () => {
    const payer = invoicePayerFromEnv(
      { PHOENIXD_URL: 'http://127.0.0.1:9740', PHOENIXD_PASSWORD: '  ' },
      async () => jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
  });
});
