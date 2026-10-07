import { createHash } from 'node:crypto';
import { base58, bech32, bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { containsEncodedSecret } from '@/lib/encoded-secret';
import { concatBytes, protoBytesField, protoVarintField } from '@/lib/protobuf';
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

  it('reads each protobuf field on its own, so a length byte cannot glue onto the first word', () => {
    // 49 bytes: the memo length byte is ASCII "1", which would otherwise make "1zoo" and hide one word.
    const phrase = `${Array.from({ length: 11 }, () => 'zoo').join(' ')} wrong`;
    expect(new TextEncoder().encode(phrase).length).toBe(49);
    expect(containsEncodedSecret(spark(phrase))).toBe(true);
    const deep = sparkRaw(
      protoBytesField(1, IDENTITY),
      protoBytesField(2, protoBytesField(7, protoBytesField(5, phrase))),
    );
    expect(containsEncodedSecret(deep)).toBe(true);
  });

  it('walks protobuf nesting at any depth and ignores undecodable fields', () => {
    // 49 bytes: its own length byte (ASCII "1") hides one word unless the field is read on its own.
    const phrase = `${Array.from({ length: 11 }, () => 'zoo').join(' ')} wrong`;
    const nestedTo = (levels: number): Uint8Array => {
      let nested: Uint8Array = protoBytesField(5, phrase);
      for (let i = 0; i < levels; i += 1) {
        nested = protoBytesField(2, nested);
      }
      return nested;
    };
    for (const levels of [4, 5, 12]) {
      expect(containsEncodedSecret(sparkRaw(protoBytesField(1, IDENTITY), nestedTo(levels)))).toBe(
        true,
      );
    }
    const truncated = sparkRaw(protoBytesField(1, IDENTITY), Uint8Array.from([0x12, 0x40, 0x01]));
    expect(containsEncodedSecret(truncated)).toBe(false);
  });

  it('treats pathological nesting beyond the walk budget as secret, and keeps a real invoice', () => {
    let nested: Uint8Array = protoBytesField(5, 'coffee');
    for (let i = 0; i < 200; i += 1) {
      nested = protoBytesField(2, nested);
    }
    const started = performance.now();
    expect(containsEncodedSecret(sparkRaw(protoBytesField(1, IDENTITY), nested))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(containsEncodedSecret(spark('coffee'))).toBe(false);
  });

  it('flags a WIF private key (mainnet or testnet, compressed or not) and keeps near misses', () => {
    const key = new Uint8Array(32).fill(7);
    const wif = (version: number, flag: number | null, corrupt = false): string => {
      const payload = Uint8Array.from([version, ...key, ...(flag === null ? [] : [flag])]);
      const check = createHash('sha256')
        .update(createHash('sha256').update(payload).digest())
        .digest()
        .subarray(0, 4);
      if (corrupt) {
        check[3] = (check[3] ?? 0) ^ 1;
      }
      return base58.encode(Uint8Array.from([...payload, ...check]));
    };
    for (const token of [wif(0x80, null), wif(0x80, 1), wif(0xef, null), wif(0xef, 1)]) {
      expect([51, 52]).toContain(token.length);
      expect(containsEncodedSecret(`key ${token} here`)).toBe(true);
    }
    for (const token of [wif(0x81, 1), wif(0x80, 2), wif(0x80, 1, true)]) {
      expect([51, 52]).toContain(token.length);
      expect(containsEncodedSecret(token)).toBe(false);
    }
    expect(containsEncodedSecret('1'.repeat(51))).toBe(false);
    expect(containsEncodedSecret(`0${'2'.repeat(50)}`)).toBe(false);
  });

  it('flags a WIF private key inside a Spark memo and inside a BOLT11 description', () => {
    const key = new Uint8Array(32).fill(9);
    const payload = Uint8Array.from([0x80, ...key, 1]);
    const check = createHash('sha256')
      .update(createHash('sha256').update(payload).digest())
      .digest()
      .subarray(0, 4);
    const wif = base58.encode(Uint8Array.from([...payload, ...check]));
    expect(containsEncodedSecret(spark(`backup ${wif}`))).toBe(true);
    const words: number[] = [];
    const tag = (code: number, data: number[]): void => {
      words.push(code, data.length >> 5, data.length & 31, ...data);
    };
    for (let i = 6; i >= 0; i -= 1) {
      words.push(Math.floor(1496314658 / 32 ** i) % 32);
    }
    tag(1, bech32.toWords(new Uint8Array(32).fill(1)));
    tag(13, bech32.toWords(new TextEncoder().encode(`key ${wif}`)));
    words.push(...bech32.toWords(new Uint8Array(65)));
    expect(containsEncodedSecret(bech32.encode('lnbc', words, false))).toBe(true);
  });

  it('decodes a mixed-case token the way a case-folding decoder reads it', () => {
    const lower = spark(PHRASE);
    const at = lower.indexOf('1') + 3;
    const mixed = `${lower.slice(0, at)}${lower.charAt(at).toUpperCase()}${lower.slice(at + 1)}`;
    expect(mixed).not.toBe(lower);
    expect(containsEncodedSecret(mixed)).toBe(true);
    expect(containsEncodedSecret(BOLT11_PHRASE.toUpperCase())).toBe(true);
  });

  it('keeps every field read before a malformed one, so a broken suffix cannot hide a secret', () => {
    // 49 bytes: its length byte is ASCII "1", so only the field-by-field read finds it.
    const phrase = `${Array.from({ length: 11 }, () => 'zoo').join(' ')} wrong`;
    const memo = protoBytesField(5, phrase);
    const suffixes: Uint8Array[] = [
      Uint8Array.from([0x00]), // field number 0
      Uint8Array.from([0x0b]), // wire type 3
      Uint8Array.from([0x80]), // truncated tag varint
      Uint8Array.from([0x08]), // varint field without its value
      Uint8Array.from([0x12, 0x7f]), // length past the end
      Uint8Array.from([0x12]), // length varint missing
      Uint8Array.from(Array.from({ length: 11 }, () => 0x80)), // varint longer than ten bytes
    ];
    for (const suffix of suffixes) {
      const token = sparkRaw(
        protoBytesField(1, IDENTITY),
        protoBytesField(2, concatBytes(memo, suffix)),
      );
      expect(containsEncodedSecret(token)).toBe(true);
    }
  });

  it('reads past varint, fixed64, and fixed32 fields to the memo after them', () => {
    const phrase = `${Array.from({ length: 11 }, () => 'zoo').join(' ')} wrong`;
    const invoice = concatBytes(
      protoVarintField(1, 300),
      Uint8Array.from([0x19, 1, 2, 3, 4, 5, 6, 7, 8]), // field 3, fixed64
      Uint8Array.from([0x25, 1, 2, 3, 4]), // field 4, fixed32
      protoBytesField(5, phrase),
    );
    expect(
      containsEncodedSecret(sparkRaw(protoBytesField(1, IDENTITY), protoBytesField(2, invoice))),
    ).toBe(true);
  });

  it('decodes a bech32 token whose prefix holds punctuation', () => {
    const punctuated = bech32m.encode(
      'a-b',
      bech32m.toWords(new TextEncoder().encode(PHRASE)),
      false,
    );
    expect(punctuated.startsWith('a-b1')).toBe(true);
    for (const wrapped of [
      `see ${punctuated} here`,
      `/pay/${punctuated}`,
      `(${punctuated})`,
      `${punctuated},`,
      `"${punctuated}";`,
      `ends with ${punctuated}.`,
      `${punctuated}!`,
    ]) {
      expect(containsEncodedSecret(wrapped)).toBe(true);
    }
  });

  it('skips valid nine- and ten-byte varints to reach the memo after them', () => {
    const phrase = `${Array.from({ length: 11 }, () => 'zoo').join(' ')} wrong`;
    for (const [big, varintBytes] of [
      [2n ** 56n, 9],
      [2n ** 63n, 10],
    ] as const) {
      const varint = protoVarintField(1, big);
      // One tag byte plus the value's varint.
      expect(varint.length - 1).toBe(varintBytes);
      const invoice = concatBytes(varint, protoBytesField(5, phrase));
      expect(
        containsEncodedSecret(sparkRaw(protoBytesField(1, IDENTITY), protoBytesField(2, invoice))),
      ).toBe(true);
    }
  });

  it('reads Spark memos as UTF-8, so a non-English recovery phrase is found', () => {
    const japanese =
      'あいこくしん　あいさつ　あいだ　あおぞら　あかちゃん　あきる　あけがた　あける　あこがれる　あさい　あさひ　あしあと';
    expect(containsEncodedSecret(spark(japanese))).toBe(true);
    expect(containsEncodedSecret(spark('的 一 是 在 不 了 有 和 人 这 中 大'))).toBe(true);
    expect(containsEncodedSecret(spark('ありがとう'))).toBe(false);
    // Control characters and invalid UTF-8 inside a field become spaces.
    const raw = sparkRaw(
      protoBytesField(1, IDENTITY),
      protoBytesField(2, protoBytesField(5, Uint8Array.from([0xff, 0x01, 0x7f, 0x61]))),
    );
    expect(containsEncodedSecret(raw)).toBe(false);
  });

  it('reads percent-encoded LNURL text, including %20, + and UTF-8 escapes', () => {
    const lnurl = (url: string): string =>
      bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false);
    const words = PHRASE.split(' ');
    expect(containsEncodedSecret(lnurl(`https://x.example/p?comment=${words.join('%20')}`))).toBe(
      true,
    );
    expect(containsEncodedSecret(lnurl(`https://x.example/p?comment=${words.join('+')}`))).toBe(
      true,
    );
    const korean = '가격 가끔 가난 가능 가득 가르침 가뭄 가방 가상 가슴 가운데 가을';
    expect(
      containsEncodedSecret(lnurl(`https://x.example/p?c=${encodeURIComponent(korean)}`)),
    ).toBe(true);
    expect(containsEncodedSecret(lnurl('https://x.example/p?comment=thanks%20for%20coffee'))).toBe(
      false,
    );
    expect(containsEncodedSecret('100%ZZ and %E0%A4')).toBe(false);
  });

  it('finds a decomposed (NFKD) phrase inside a Spark memo', () => {
    const spanish =
      'ábaco abdomen abeja abierto abogado abono aborto abrazo abrir abuelo abuso acabar';
    expect(containsEncodedSecret(spark(spanish.normalize('NFKD')))).toBe(true);
    const italian =
      'avvolgere brillante cartolina abaco abbaglio abbinato abete abisso abolire abrasivo abrogato accadere';
    expect(containsEncodedSecret(spark(italian))).toBe(true);
  });
});
