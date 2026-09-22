import { describe, it, expect } from 'vitest';
import {
  serializePosCharge,
  serializeDebugPosCharge,
  type PosCharge,
} from '@/lib/pos-charge';

const ROW: PosCharge = {
  id: 'p-1',
  accountId: 'acc-1',
  amountSats: 21,
  status: 'pending',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  expiresAt: new Date('2026-09-01T12:05:00.000Z'),
};

describe('serializePosCharge', () => {
  it('emits ISO timestamps and omits accountId', () => {
    expect(serializePosCharge(ROW)).toEqual({
      id: 'p-1',
      amountSats: 21,
      status: 'pending',
      createdAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:05:00.000Z',
    });
    expect(serializePosCharge(ROW)).not.toHaveProperty('accountId');
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
    });
  });
});
