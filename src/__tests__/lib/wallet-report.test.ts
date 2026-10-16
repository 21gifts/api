import { bech32, bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { parseClientInstant } from '@/lib/client-instant';
import { encodeSparkInvoice } from '@/lib/spark-invoice';
import { isSecretFieldName, looksLikeSecretValue } from '@/lib/secret-shape';
import { MAX_SATS, parseWalletReport, WALLET_REPORT_PAYMENTS_MAX } from '@/lib/wallet-report';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
/** Zero-amount BOLT11 whose description is a 12-word recovery-phrase shape (unsigned test vector). */
const BOLT11_PHRASE_DESCRIPTION =
  'lnbc1pvjluezpp5qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsdy8v93xzmnydahzqctzd9kxjareypskymr9ypskymm4wssxzcn0wejjqctzwdjkuapqv938xmmjvgsxzcnnw3exzcm5ypskyum4wfjzqctzw4ek2grpvd3k2umnypskxcmfv3jkuaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqt0sdnl';
/** The same invoice shape with the description "1 cup coffee". */
const BOLT11_PLAIN_DESCRIPTION =
  'lnbc1pvjluezpp5qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsdq5xysxxatsyp3k7enxv4jsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqznl48l';
const WHEN = '2026-10-01T11:00:00.000Z';
const HASH = 'AB'.repeat(32);

function payment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ' p1 ',
    direction: 'out',
    status: 'completed',
    amountSats: 21,
    timestamp: WHEN,
    method: 'BOLT11',
    ...extra,
  };
}

describe('parseWalletReport', () => {
  it('parses a full report, defaults fee, normalises fields, and imports shared validators', () => {
    expect(parseClientInstant(WHEN, NOW)).toEqual(new Date(WHEN));
    expect(isSecretFieldName('preimage')).toBe(true);
    expect(looksLikeSecretValue('word '.repeat(11) + 'word')).toBe(true);
    expect(
      parseWalletReport(
        {
          balanceSats: MAX_SATS,
          syncedAt: NOW / 1000,
          ignored: 'x',
          payments: [
            payment({
              feeSats: null,
              paymentHash: HASH,
              invoice: ' invoice ',
              destination: ' alice@example.test ',
              description: ' coffee ',
              lnurlComment: ' thanks ',
              preimage: 'never-read',
              seed: 'never-read',
            }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      report: {
        balanceSats: MAX_SATS,
        syncedAt: new Date(NOW),
        skipped: 0,
        payments: [
          {
            paymentId: 'p1',
            direction: 'out',
            status: 'completed',
            amountSats: 21,
            feeSats: 0,
            paidAt: new Date(WHEN),
            method: 'bolt11',
            paymentHash: HASH.toLowerCase(),
            invoice: 'invoice',
            destination: 'alice@example.test',
            description: 'coffee',
            lnurlComment: 'thanks',
          },
        ],
      },
    });
  });

  it('accepts missing payments and a null-prototype report', () => {
    const body = Object.assign(Object.create(null) as Record<string, unknown>, {
      balanceSats: 0,
      syncedAt: WHEN,
    });
    expect(parseWalletReport(body, NOW)).toEqual({
      ok: true,
      report: { balanceSats: 0, syncedAt: new Date(WHEN), payments: [], skipped: 0 },
    });
  });

  it('never reads secret-named or unknown payment properties', () => {
    const row = payment();
    for (const name of ['preimage', 'seed', 'mnemonic', 'prf', 'privateKey', 'nsec', 'unknown']) {
      Object.defineProperty(row, name, {
        enumerable: true,
        get(): never {
          throw new Error(`read ${name}`);
        },
      });
    }
    const parsed = parseWalletReport({ balanceSats: 1, syncedAt: WHEN, payments: [row] }, NOW);
    expect(parsed.ok && parsed.report.payments[0]?.paymentId).toBe('p1');
  });

  it('rejects invalid report envelopes', () => {
    for (const body of [
      null,
      [],
      new Date(),
      { syncedAt: WHEN },
      { balanceSats: -1, syncedAt: WHEN },
      { balanceSats: MAX_SATS + 1, syncedAt: WHEN },
      { balanceSats: 1.5, syncedAt: WHEN },
      { balanceSats: 1, syncedAt: 'bad' },
      { balanceSats: 1, syncedAt: WHEN, payments: null },
      { balanceSats: 1, syncedAt: WHEN, payments: Array(WALLET_REPORT_PAYMENTS_MAX + 1) },
    ]) {
      expect(parseWalletReport(body, NOW)).toEqual({ ok: false });
    }
  });

  it('skips every kind of invalid required payment field', () => {
    const bad = [
      null,
      [],
      payment({ id: 1 }),
      payment({ id: ' ' }),
      payment({ id: 'x'.repeat(257) }),
      payment({ id: 'x\u007f' }),
      payment({ id: 'nsec1abcdefghijklmnopqrstuvwxyz123456' }),
      payment({
        id: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
      }),
      payment({ direction: 'sideways' }),
      payment({ status: 'ok' }),
      payment({ amountSats: -1 }),
      payment({ amountSats: 1.5 }),
      payment({ feeSats: -1 }),
      payment({ timestamp: 'bad' }),
      payment({ method: 1 }),
      payment({ method: ' bolt11 ' }),
      payment({ method: '1bad' }),
      payment({ method: `a${'x'.repeat(32)}` }),
    ];
    const parsed = parseWalletReport({ balanceSats: 1, syncedAt: WHEN, payments: bad }, NOW);
    expect(parsed).toEqual({
      ok: true,
      report: { balanceSats: 1, syncedAt: new Date(WHEN), payments: [], skipped: bad.length },
    });
  });

  it('nulls malformed, unsafe, secret-shaped, empty, controlled, and overlong details', () => {
    const phrase = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omega';
    const secret = `nsec1${'q'.repeat(58)}`;
    const parsed = parseWalletReport(
      {
        balanceSats: 1,
        syncedAt: WHEN,
        payments: [
          payment({
            paymentHash: 'g'.repeat(64),
            invoice: 1,
            destination: '',
            description: phrase,
            lnurlComment: secret,
          }),
          payment({
            id: 'p2',
            paymentHash: 'a'.repeat(63),
            invoice: `x${'y'.repeat(4096)}`,
            destination: 'x\u0000',
            description: 'd'.repeat(641),
            lnurlComment: ' ',
          }),
        ],
      },
      NOW,
    );
    expect(
      parsed.ok &&
        parsed.report.payments.map((row) => ({
          paymentHash: row.paymentHash,
          invoice: row.invoice,
          destination: row.destination,
          description: row.description,
          lnurlComment: row.lnurlComment,
        })),
    ).toEqual([
      {
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: null,
      },
      {
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: null,
      },
    ]);
  });

  it('nulls an invoice or destination whose embedded memo or description holds secret material', () => {
    const phrase =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const key = `02${'c'.repeat(64)}`;
    const sparkWith = (memo: string): string =>
      encodeSparkInvoice({ identityPublicKey: key, id: new Uint8Array(16), memo, amountSats: 21 });
    const parsed = parseWalletReport(
      {
        balanceSats: 1,
        syncedAt: WHEN,
        payments: [
          payment({
            id: 'spark-secret',
            invoice: sparkWith(phrase),
            destination: sparkWith(phrase),
          }),
          payment({
            id: 'spark-clean',
            invoice: sparkWith('zap:abc'),
            destination: sparkWith('pos:x'),
          }),
          payment({ id: 'bolt11-secret', invoice: BOLT11_PHRASE_DESCRIPTION }),
          payment({ id: 'bolt11-clean', invoice: BOLT11_PLAIN_DESCRIPTION }),
        ],
      },
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      parsed.report.payments.map((row) => [row.paymentId, row.invoice, row.destination]),
    ).toEqual([
      ['spark-secret', null, null],
      ['spark-clean', sparkWith('zap:abc'), sparkWith('pos:x')],
      ['bolt11-secret', null, null],
      ['bolt11-clean', BOLT11_PLAIN_DESCRIPTION, null],
    ]);
    expect(JSON.stringify(parsed.report)).not.toContain(BOLT11_PHRASE_DESCRIPTION);
  });

  it('nulls a detail whose bech32 or bech32m payload is a CJK phrase as plain UTF-8', () => {
    const words = (codec: typeof bech32): number[] =>
      codec.toWords(new TextEncoder().encode('的 一 是 在 不 了 有 和 人 这 中 大'));
    const parsed = parseWalletReport(
      {
        balanceSats: 1,
        syncedAt: WHEN,
        payments: [
          payment({
            id: 'cjk-payload',
            invoice: bech32m.encode('spark', words(bech32m), false),
            destination: bech32.encode('lnurl', words(bech32), false),
          }),
        ],
      },
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.report.payments.map((row) => [row.invoice, row.destination])).toEqual([
      [null, null],
    ]);
  });

  it('accepts every direction/status and explicit zero fee', () => {
    const parsed = parseWalletReport(
      {
        balanceSats: 1,
        syncedAt: WHEN,
        payments: [
          payment({ id: 'a', direction: 'in', status: 'pending', feeSats: 0 }),
          payment({ id: 'b', direction: 'out', status: 'failed', feeSats: 2 }),
        ],
      },
      NOW,
    );
    expect(
      parsed.ok && parsed.report.payments.map((row) => [row.direction, row.status, row.feeSats]),
    ).toEqual([
      ['in', 'pending', 0],
      ['out', 'failed', 2],
    ]);
  });
});
