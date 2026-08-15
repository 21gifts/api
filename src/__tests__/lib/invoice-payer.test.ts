import { describe, it, expect } from 'vitest';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';

describe('UnconfiguredInvoicePayer', () => {
  it('always returns not_configured', async () => {
    const payer = new UnconfiguredInvoicePayer();
    const result = await payer.payInvoice('lnbc1…');
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });
});
