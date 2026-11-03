import { describe, it, expect } from 'vitest';
import type { FxSpotQuote } from '@/lib/fx-spot';
import {
  freezePosFiatCrosses,
  parseTypedFiatAmount,
  serializePosCharge,
  serializeDebugPosCharge,
  serializePosFiat,
  type PosCharge,
} from '@/lib/pos-charge';

const NULL_FIAT = {
  amountCurrency: null,
  amount: null,
  amountUsd: null,
  amountChf: null,
  amountEur: null,
  amountPhp: null,
};

const ROW: PosCharge = {
  id: 'p-1',
  accountId: 'acc-1',
  amountSats: 21,
  status: 'pending',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  expiresAt: new Date('2026-09-01T12:05:00.000Z'),
  paidAt: null,
  sparkInvoice: null,
  amountCurrency: null,
  amountText: null,
  fiatUsd: null,
  fiatChf: null,
  fiatEur: null,
  fiatPhp: null,
};

function quote(rates: FxSpotQuote['rates']): FxSpotQuote {
  return { asOf: '2026-10-20T00:00:00.000Z', source: 'coinbase-exchange-rates', rates };
}

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
      ...NULL_FIAT,
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
      ...NULL_FIAT,
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
      ...NULL_FIAT,
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
      ...NULL_FIAT,
    });
  });
});

describe('freezePosFiatCrosses', () => {
  const spot = quote({ USD: '100000', CHF: '90000', EUR: '95000', PHP: '5000000' });

  it('freezes the other three from the spot and leaves the typed numeric null', () => {
    expect(freezePosFiatCrosses('PHP', '12.00', spot)).toEqual({
      fiatUsd: '0.24',
      fiatChf: '0.22',
      fiatEur: '0.23',
      fiatPhp: null,
    });
  });

  it('freezes the other three when USD, CHF, or EUR is typed', () => {
    expect(freezePosFiatCrosses('USD', '1.00', spot)).toEqual({
      fiatUsd: null,
      fiatChf: '0.90',
      fiatEur: '0.95',
      fiatPhp: '50.00',
    });
    expect(freezePosFiatCrosses('CHF', '1.00', spot)).toEqual({
      fiatUsd: '1.11',
      fiatChf: null,
      fiatEur: '1.06',
      fiatPhp: '55.56',
    });
    expect(freezePosFiatCrosses('EUR', '1.00', spot)).toEqual({
      fiatUsd: '1.05',
      fiatChf: '0.95',
      fiatEur: null,
      fiatPhp: '52.63',
    });
  });

  it('leaves a missing spot leg null and still prices the others', () => {
    const partial = quote({ USD: '100000', CHF: '90000', PHP: '5000000' });
    expect(freezePosFiatCrosses('PHP', '12.00', partial)).toEqual({
      fiatUsd: '0.24',
      fiatChf: '0.22',
      fiatEur: null,
      fiatPhp: null,
    });
  });

  it('nulls a rate that cannot be parsed and does not throw', () => {
    const badUsd = quote({ USD: 'nope', CHF: '90000', EUR: '95000', PHP: '5000000' });
    expect(freezePosFiatCrosses('PHP', '12.00', badUsd)).toEqual({
      fiatUsd: null,
      fiatChf: '0.22',
      fiatEur: '0.23',
      fiatPhp: null,
    });
  });

  it('freezes nothing from a null quote or a missing typed rate', () => {
    const empty = { fiatUsd: null, fiatChf: null, fiatEur: null, fiatPhp: null };
    expect(freezePosFiatCrosses('PHP', '12.00', null)).toEqual(empty);
    expect(freezePosFiatCrosses('PHP', '12.00', quote({ USD: '100000' }))).toEqual(empty);
    expect(freezePosFiatCrosses('PHP', '12.00', quote({ PHP: 'nope', USD: '100000' }))).toEqual(
      empty,
    );
  });
});

describe('parseTypedFiatAmount', () => {
  it('rejects an empty string, a trailing dot, a sign, an exponent, and more than 8 fraction digits', () => {
    expect(parseTypedFiatAmount('')).toBeNull();
    expect(parseTypedFiatAmount('1.')).toBeNull();
    expect(parseTypedFiatAmount('-1')).toBeNull();
    expect(parseTypedFiatAmount('+1')).toBeNull();
    expect(parseTypedFiatAmount('1e2')).toBeNull();
    expect(parseTypedFiatAmount('1.123456789')).toBeNull();
  });
});

describe('serializePosFiat typed string', () => {
  it('keeps 12.00 on amount and amountPhp and formats the frozen crosses', () => {
    expect(
      serializePosCharge({
        ...ROW,
        amountCurrency: 'PHP',
        amountText: '12.00',
        fiatUsd: '0.24',
        fiatChf: '0.22',
        fiatEur: '0.23',
        fiatPhp: null,
      }),
    ).toMatchObject({
      amount: '12.00',
      amountPhp: '12.00',
      amountUsd: '0.24',
      amountChf: '0.22',
      amountEur: '0.23',
      amountCurrency: 'PHP',
    });
  });
});

describe('serializePosFiat', () => {
  function phpCharge(fiatUsd: string | null): PosCharge {
    return {
      ...ROW,
      amountCurrency: 'PHP',
      amountText: '12.00',
      fiatUsd,
    };
  }

  it('keeps the typed 12.00 and formats a stored USD numeric', () => {
    const typed = { amount: '12.00', amountPhp: '12.00', amountCurrency: 'PHP' };
    expect(serializePosFiat(phpCharge(null))).toMatchObject({ ...typed, amountUsd: null });
    expect(serializePosFiat(phpCharge('abc'))).toMatchObject({ ...typed, amountUsd: null });
    expect(serializePosFiat(phpCharge(''))).toMatchObject({ ...typed, amountUsd: null });
    expect(serializePosFiat(phpCharge('12'))).toMatchObject({ ...typed, amountUsd: '12.00' });
    expect(serializePosFiat(phpCharge('12.5'))).toMatchObject({ ...typed, amountUsd: '12.50' });
    expect(serializePosFiat(phpCharge('1.005'))).toMatchObject({ ...typed, amountUsd: '1.01' });
    expect(serializePosFiat(phpCharge('1.004'))).toMatchObject({ ...typed, amountUsd: '1.00' });
    expect(serializePosFiat(phpCharge('1000000000000000000'))).toMatchObject({
      ...typed,
      amountUsd: null,
    });
    expect(serializePosFiat(phpCharge('100000000000000.00'))).toMatchObject({
      ...typed,
      amountUsd: '100000000000000.00',
    });
  });
});
