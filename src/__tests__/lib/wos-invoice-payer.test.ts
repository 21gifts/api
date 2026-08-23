import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { WosClient } from '@/lib/wos';
import { WosInvoicePayer, invoicePayerFromEnv } from '@/lib/wos-invoice-payer';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('WosInvoicePayer', () => {
  it('is configured and maps paid to ok', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ status: 'PAID', transactionId: 'h' });
    const payer = new WosInvoicePayer(new WosClient({ apiToken: 't', apiSecret: 's', fetchImpl }));
    expect(payer.isConfigured()).toBe(true);
    expect(await payer.payInvoice('lnbc10n1')).toEqual({ ok: true });
  });

  it('maps failed and uncertain to payment_failed', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({ message: 'Invalid invoice' }, 400);
    const payer = new WosInvoicePayer(new WosClient({ apiToken: 't', apiSecret: 's', fetchImpl }));
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

  it('returns WosInvoicePayer when env is complete', () => {
    const payer = invoicePayerFromEnv({ WOS_API_TOKEN: 't', WOS_API_SECRET: 's' }, async () =>
      jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(WosInvoicePayer);
    expect(payer.isConfigured()).toBe(true);
  });

  it('returns UnconfiguredInvoicePayer on missing env', () => {
    const payer = invoicePayerFromEnv({}, async () => jsonResponse({}));
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('wos.unconfigured');
    expect(line).toContain('missing_env');
    expect(line).not.toContain('secret');
  });
});
