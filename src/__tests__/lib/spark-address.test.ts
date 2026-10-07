import { bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { concatBytes, protoBytesField } from '@/lib/protobuf';
import { decodeSparkAddress } from '@/lib/spark-address';
import { encodeSparkInvoice } from '@/lib/spark-invoice';

const PUBKEY = '0209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5';
const ID = new Uint8Array(16).fill(7);

function encoded(prefix: string, bytes: Uint8Array): string {
  return bech32m.encode(prefix, bech32m.toWords(bytes), false);
}

describe('decodeSparkAddress', () => {
  it('decodes invoices with and without a memo after trimming and lower-casing', () => {
    const withMemo = encodeSparkInvoice({
      identityPublicKey: PUBKEY,
      id: ID,
      memo: 'zap:test',
      amountSats: 21,
    });
    const withoutMemo = encodeSparkInvoice({ identityPublicKey: PUBKEY, id: ID, amountSats: 21 });
    expect(decodeSparkAddress(`  ${withMemo.toUpperCase()}  `)).toEqual({
      identityPublicKey: PUBKEY,
      memo: 'zap:test',
    });
    expect(decodeSparkAddress(withoutMemo)).toEqual({
      identityPublicKey: PUBKEY,
      memo: null,
    });
  });

  it('decodes an address containing only identity field 1 for every accepted short HRP', () => {
    const bytes = protoBytesField(1, Uint8Array.from(Buffer.from(PUBKEY, 'hex')));
    for (const prefix of ['sp', 'sprt', 'spt', 'sps', 'spl']) {
      expect(decodeSparkAddress(encoded(prefix, bytes))).toEqual({
        identityPublicKey: PUBKEY,
        memo: null,
      });
    }
  });

  it('accepts every long HRP and rejects an unknown HRP', () => {
    const bytes = protoBytesField(1, Uint8Array.from(Buffer.from(PUBKEY, 'hex')));
    for (const prefix of ['spark', 'sparkrt', 'sparkt', 'sparks', 'sparkl']) {
      expect(decodeSparkAddress(encoded(prefix, bytes))?.identityPublicKey).toBe(PUBKEY);
    }
    expect(decodeSparkAddress(encoded('other', bytes))).toBeNull();
  });

  it('returns null for malformed bech32m, protobuf, identity, nested fields, or UTF-8', () => {
    expect(decodeSparkAddress('not-bech32')).toBeNull();
    expect(decodeSparkAddress(encoded('spark', new Uint8Array([0x0a, 0x02, 0x01])))).toBeNull();
    expect(
      decodeSparkAddress(encoded('spark', protoBytesField(3, new Uint8Array([1])))),
    ).toBeNull();
    expect(decodeSparkAddress(encoded('spark', protoBytesField(1, new Uint8Array(32))))).toBeNull();
    expect(
      decodeSparkAddress(
        encoded(
          'spark',
          concatBytes(
            protoBytesField(1, Uint8Array.from(Buffer.from(PUBKEY, 'hex'))),
            protoBytesField(2, new Uint8Array([0x2a, 0x02, 0xc3, 0x28])),
          ),
        ),
      ),
    ).toBeNull();
  });
});
