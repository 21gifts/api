import { bech32, bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { containsEncodedSecret } from '@/lib/encoded-secret';
import { concatBytes, protoBytesField } from '@/lib/protobuf';
import { encodeSparkInvoice } from '@/lib/spark-invoice';

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';
const KEY = `02${'c'.repeat(64)}`;
const IDENTITY = Uint8Array.from(Buffer.from(KEY, 'hex'));
/** Unsigned zero-amount BOLT11 whose single description is the phrase. */
const BOLT11_PHRASE =
  'lnbc1pvjluezpp5qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsdy8v93xzmnydahzqctzd9kxjareypskymr9ypskymm4wssxzcn0wejjqctzwdjkuapqv938xmmjvgsxzcnnw3exzcm5ypskyum4wfjzqctzw4ek2grpvd3k2umnypskxcmfv3jkuaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqt0sdnl';
/** Unsigned BOLT11 with two description tags: "coffee", then the phrase. */
const BOLT11_TWO_DESCRIPTIONS =
  'lnbc1pvjluezpp5qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsdq2vdhkven9v5dy8v93xzmnydahzqctzd9kxjareypskymr9ypskymm4wssxzcn0wejjqctzwdjkuapqv938xmmjvgsxzcnnw3exzcm5ypskyum4wfjzqctzw4ek2grpvd3k2umnypskxcmfv3jkuaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqj7h4xd';
/** Unsigned BOLT11 with the description "1 cup coffee". */
const BOLT11_PLAIN =
  'lnbc1pvjluezpp5qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsdq5xysxxatsyp3k7enxv4jsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqznl48l';

function spark(memo: string): string {
  return encodeSparkInvoice({
    identityPublicKey: KEY,
    id: new Uint8Array(16),
    memo,
    amountSats: 21,
  });
}

function sparkRaw(...fields: Uint8Array[]): string {
  return bech32m.encode('spark', bech32m.toWords(concatBytes(...fields)), false);
}

describe('containsEncodedSecret', () => {
  it('flags visible secret material like looksLikeSecretValue', () => {
    expect(containsEncodedSecret(PHRASE)).toBe(true);
    expect(containsEncodedSecret('nsec1abc')).toBe(true);
  });

  it('flags a Spark invoice whose memo holds a phrase, also as a token inside a longer value', () => {
    expect(containsEncodedSecret(spark(PHRASE))).toBe(true);
    expect(containsEncodedSecret(`/pay/${spark(PHRASE)}?x`)).toBe(true);
    expect(containsEncodedSecret(spark('zap:abc'))).toBe(false);
  });

  it('flags a phrase in a second memo or a second invoice field of a Spark address', () => {
    const twoMemos = sparkRaw(
      protoBytesField(1, IDENTITY),
      protoBytesField(2, concatBytes(protoBytesField(5, 'coffee'), protoBytesField(5, PHRASE))),
    );
    const twoInvoiceFields = sparkRaw(
      protoBytesField(1, IDENTITY),
      protoBytesField(2, protoBytesField(5, 'coffee')),
      protoBytesField(2, protoBytesField(5, PHRASE)),
    );
    expect(containsEncodedSecret(twoMemos)).toBe(true);
    expect(containsEncodedSecret(twoInvoiceFields)).toBe(true);
  });

  it('flags a phrase in any BOLT11 description tag and keeps a plain invoice', () => {
    expect(containsEncodedSecret(BOLT11_PHRASE)).toBe(true);
    expect(containsEncodedSecret(BOLT11_TWO_DESCRIPTIONS)).toBe(true);
    expect(containsEncodedSecret(BOLT11_PLAIN)).toBe(false);
  });

  it('flags a phrase in the payload of a bech32 (not bech32m) token', () => {
    const lnurlLike = bech32.encode(
      'lnurl',
      bech32.toWords(new TextEncoder().encode(PHRASE)),
      false,
    );
    expect(containsEncodedSecret(lnurlLike)).toBe(true);
  });

  it('keeps short tokens, tokens without a separator digit, undecodable tokens, and bad padding', () => {
    expect(containsEncodedSecret('alice@21.gifts')).toBe(false);
    expect(containsEncodedSecret('a'.repeat(40))).toBe(false);
    expect(containsEncodedSecret(`x1${'q'.repeat(30)}`)).toBe(false);
    const badPadding = bech32m.encode(
      'ab',
      Array.from({ length: 13 }, () => 31),
      false,
    );
    expect(badPadding.length).toBeGreaterThanOrEqual(20);
    expect(containsEncodedSecret(badPadding)).toBe(false);
  });
});
