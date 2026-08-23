import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchFn } from '@/lib/btc-usd-rate';
import { LndhubClient } from '@/lib/lndhub';
import { LndhubInvoicePayer, invoicePayerFromEnv } from '@/lib/lndhub-invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';

const BASE = 'https://lightning.space/lndhub/ext';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LndhubInvoicePayer', () => {
  it('is configured and maps paid to ok', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_preimage: 'pre', payment_hash: 'h' });
    };
    const payer = new LndhubInvoicePayer(
      new LndhubClient({ baseUrl: BASE, login: 'u', password: 'p', fetchImpl }),
    );
    expect(payer.isConfigured()).toBe(true);
    expect(await payer.payInvoice('lnbc10n1')).toEqual({ ok: true });
  });

  it('maps failed and uncertain to payment_failed', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).endsWith('/auth')) {
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({ payment_error: 'Invalid invoice' });
    };
    const payer = new LndhubInvoicePayer(
      new LndhubClient({ baseUrl: BASE, login: 'u', password: 'p', fetchImpl }),
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

  it('returns LndhubInvoicePayer when env is complete', () => {
    const payer = invoicePayerFromEnv(
      {
        LNDHUB_URL: BASE,
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
      },
      async () => jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(LndhubInvoicePayer);
    expect(payer.isConfigured()).toBe(true);
  });

  it('returns UnconfiguredInvoicePayer on missing env', () => {
    const payer = invoicePayerFromEnv({}, async () => jsonResponse({}));
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
    expect(warn).toHaveBeenCalled();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('lndhub.unconfigured');
    expect(line).toContain('missing_env');
    expect(line).not.toContain('password');
  });

  it('returns UnconfiguredInvoicePayer on invalid URL', () => {
    const payer = invoicePayerFromEnv(
      {
        LNDHUB_URL: 'https://evil.example',
        LNDHUB_LOGIN: 'u',
        LNDHUB_PASSWORD: 'p',
      },
      async () => jsonResponse({}),
    );
    expect(payer).toBeInstanceOf(UnconfiguredInvoicePayer);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('invalid_url');
  });
});
