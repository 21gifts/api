import { describe, it, expect } from 'vitest';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';

describe('UnconfiguredInvoicePayer', () => {
  it('is not configured', () => {
    const payer = new UnconfiguredInvoicePayer();
    expect(payer.isConfigured()).toBe(false);
  });

  it('always returns not_configured', async () => {
    const payer = new UnconfiguredInvoicePayer();
    const result = await payer.payInvoice('lnbc1…');
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });
});
