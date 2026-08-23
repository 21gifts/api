import { describe, it, expect } from 'vitest';
import { decodeBolt11AmountSats } from '@/lib/bolt11-amount';

describe('decodeBolt11AmountSats', () => {
  it('decodes nano amounts to sats', () => {
    expect(decodeBolt11AmountSats('lnbc1230n1qqqq')).toEqual({ ok: true, sats: 123 });
    expect(decodeBolt11AmountSats('lnbc10n1qqqq')).toEqual({ ok: true, sats: 1 });
  });

  it('decodes micro amounts to sats', () => {
    expect(decodeBolt11AmountSats('lnbc1u1qqqq')).toEqual({ ok: true, sats: 100 });
  });

  it('decodes milli amounts to sats', () => {
    expect(decodeBolt11AmountSats('lnbc1m1qqqq')).toEqual({ ok: true, sats: 100_000 });
  });

  it('decodes pico amounts that divide evenly', () => {
    expect(decodeBolt11AmountSats('lnbc10000p1qqqq')).toEqual({ ok: true, sats: 1 });
  });

  it('decodes bare BTC digits', () => {
    expect(decodeBolt11AmountSats('lnbc11qqqq')).toEqual({ ok: true, sats: 100_000_000 });
  });

  it('lowercases before parse', () => {
    expect(decodeBolt11AmountSats('LNBC10N1QQQQ')).toEqual({ ok: true, sats: 1 });
  });

  it('returns no_amount when HRP has no amount', () => {
    expect(decodeBolt11AmountSats('lnbc1qqqq')).toEqual({ ok: false, reason: 'no_amount' });
  });

  it('rejects testnet and regtest prefixes', () => {
    expect(decodeBolt11AmountSats('lntb10n1qqqq')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBolt11AmountSats('lnbcrt10n1qqqq')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects empty and garbage', () => {
    expect(decodeBolt11AmountSats('')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBolt11AmountSats('not-an-invoice')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBolt11AmountSats('lnbc')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects non-integer pico/nano sats', () => {
    expect(decodeBolt11AmountSats('lnbc1n1qqqq')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBolt11AmountSats('lnbc10p1qqqq')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects amount with no digits before multiplier', () => {
    expect(decodeBolt11AmountSats('lnbcn1qqqq')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects non-digit amount characters', () => {
    expect(decodeBolt11AmountSats('lnbc12x1qqqq')).toEqual({ ok: false, reason: 'invalid' });
  });
});
