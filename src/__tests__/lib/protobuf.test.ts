import { describe, expect, it } from 'vitest';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';

describe('protoVarintField', () => {
  it('encodes small and multi-byte varints with the field tag', () => {
    expect([...protoVarintField(1, 1)]).toEqual([0x08, 0x01]);
    expect([...protoVarintField(1, 300)]).toEqual([0x08, 0xac, 0x02]);
    expect([...protoVarintField(2, 0n)]).toEqual([0x10, 0x00]);
  });

  it('encodes the largest uint64', () => {
    const bytes = protoVarintField(1, (1n << 64n) - 1n);
    expect(bytes.byteLength).toBe(11);
    expect(decodeProto(bytes)).toEqual([{ field: 1, wire: 0, value: (1n << 64n) - 1n }]);
  });

  it('rejects unsafe, negative, and too large values', () => {
    expect(() => protoVarintField(1, 2 ** 60)).toThrow(RangeError);
    expect(() => protoVarintField(1, 1.5)).toThrow(RangeError);
    expect(() => protoVarintField(1, -1)).toThrow(RangeError);
    expect(() => protoVarintField(1, 1n << 64n)).toThrow(RangeError);
  });
});

describe('protoBytesField', () => {
  it('encodes strings as UTF-8 and raw bytes unchanged', () => {
    expect([...protoBytesField(5, 'zap')]).toEqual([0x2a, 0x03, 0x7a, 0x61, 0x70]);
    expect([...protoBytesField(2, Uint8Array.of(7, 7))]).toEqual([0x12, 0x02, 7, 7]);
  });
});

describe('concatBytes', () => {
  it('joins parts in order', () => {
    expect([...concatBytes(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3))]).toEqual([
      1, 2, 3,
    ]);
    expect(concatBytes().byteLength).toBe(0);
  });
});

describe('decodeProto', () => {
  it('round-trips varint and length-delimited fields in wire order', () => {
    const bytes = concatBytes(
      protoVarintField(1, 100),
      protoBytesField(3, 'a'),
      protoBytesField(3, 'b'),
    );
    const fields = decodeProto(bytes);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({ field: 1, wire: 0, value: 100n });
    expect(fields[1]?.field).toBe(3);
    expect(new TextDecoder().decode(fields[2]?.value as Uint8Array)).toBe('b');
  });

  it('skips fixed 64-bit and 32-bit fields', () => {
    const bytes = concatBytes(
      Uint8Array.of(0x09, 1, 2, 3, 4, 5, 6, 7, 8),
      Uint8Array.of(0x15, 1, 2, 3, 4),
      protoVarintField(4, 9),
    );
    expect(decodeProto(bytes)).toEqual([{ field: 4, wire: 0, value: 9n }]);
  });

  it('returns no fields for empty input', () => {
    expect(decodeProto(new Uint8Array(0))).toEqual([]);
  });

  it('rejects malformed input', () => {
    expect(() => decodeProto(Uint8Array.of(0x08))).toThrow('truncated varint');
    expect(() => decodeProto(Uint8Array.of(0x08, 0x80))).toThrow('truncated varint');
    expect(() =>
      decodeProto(Uint8Array.of(0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80)),
    ).toThrow('varint too long');
    expect(() =>
      decodeProto(Uint8Array.of(0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f)),
    ).toThrow('varint too long');
    expect(() => decodeProto(Uint8Array.of(0x00, 0x01))).toThrow('field number 0');
    expect(() => decodeProto(Uint8Array.of(0x12, 0x05, 0x01))).toThrow('truncated field');
    expect(() => decodeProto(Uint8Array.of(0x12, 0x80, 0x80, 0x80, 0x80, 0x10))).toThrow(
      'truncated field',
    );
    expect(() => decodeProto(Uint8Array.of(0x09, 1, 2))).toThrow('truncated field');
    expect(() => decodeProto(Uint8Array.of(0x15, 1))).toThrow('truncated field');
    expect(() => decodeProto(Uint8Array.of(0x0b))).toThrow('unsupported wire type');
  });
});
