import { describe, it, expect } from 'vitest';
import { serializePosCharge, serializeDebugPosCharge, type PosCharge } from '@/lib/pos-charge';

const ROW: PosCharge = {
  id: 'p-1',
  accountId: 'acc-1',
  amountSats: 21,
  status: 'pending',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  expiresAt: new Date('2026-09-01T12:05:00.000Z'),
  paidAt: null,
  sparkInvoice: null,
};

const PAID: PosCharge = {
  ...ROW,
  status: 'paid',
  paidAt: new Date('2026-09-01T12:01:00.000Z'),
  sparkInvoice: 'spark1example',
};

describe('serializePosCharge', () => {
  it('emits ISO timestamps and omits accountId', () => {
    expect(serializePosCharge(ROW)).toEqual({
      id: 'p-1',
      amountSats: 21,
      status: 'pending',
      createdAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:05:00.000Z',
      paidAt: null,
    });
    expect(serializePosCharge(ROW)).not.toHaveProperty('accountId');
  });

  it('emits paidAt for a paid charge and omits the Spark invoice', () => {
    expect(serializePosCharge(PAID)).toEqual({
      id: 'p-1',
      amountSats: 21,
      status: 'paid',
      createdAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:05:00.000Z',
      paidAt: '2026-09-01T12:01:00.000Z',
    });
    expect(serializePosCharge(PAID)).not.toHaveProperty('sparkInvoice');
  });
});

describe('serializeDebugPosCharge', () => {
  it('emits ISO timestamps and includes accountId', () => {
    expect(serializeDebugPosCharge(ROW)).toEqual({
      id: 'p-1',
      accountId: 'acc-1',
      amountSats: 21,
      status: 'pending',
      createdAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:05:00.000Z',
      paidAt: null,
      sparkInvoice: null,
    });
  });

  it('emits paidAt and the Spark invoice for a paid charge', () => {
    expect(serializeDebugPosCharge(PAID)).toEqual({
      id: 'p-1',
      accountId: 'acc-1',
      amountSats: 21,
      status: 'paid',
      createdAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:05:00.000Z',
      paidAt: '2026-09-01T12:01:00.000Z',
      sparkInvoice: 'spark1example',
    });
  });
});
