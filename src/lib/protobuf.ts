/**
 * Minimal Protocol Buffers wire codec for the few Spark messages this api
 * writes and reads. Supports varint (wire type 0) and length-delimited
 * (wire type 2) fields; fixed 64-bit and 32-bit fields are skipped on read.
 */

/** One decoded field: varint as `bigint`, length-delimited as raw bytes. */
export type ProtoField =
  { field: number; wire: 0; value: bigint } | { field: number; wire: 2; value: Uint8Array };

/** Largest value a protobuf varint can carry. */
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Encode an unsigned integer as a protobuf varint.
 *
 * @param value - Non-negative integer up to 2^64 - 1.
 * @returns Varint bytes.
 * @throws RangeError when `value` is negative, not an integer, or too large.
 */
function varint(value: number | bigint): Uint8Array {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError('varint value must be a safe integer');
  }
  let rest = BigInt(value);
  if (rest < 0n || rest > MAX_UINT64) {
    throw new RangeError('varint value out of range');
  }
  const out: number[] = [];
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return Uint8Array.from(out);
}

/**
 * Join byte arrays in order.
 *
 * @param parts - Byte arrays.
 * @returns One array holding every part.
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Encode one varint field (`uint32`, `uint64`, `int64` with a non-negative value, or an enum).
 *
 * @param field - Field number.
 * @param value - Non-negative integer.
 * @returns Tag and value bytes.
 * @throws RangeError when `value` cannot be a varint.
 */
export function protoVarintField(field: number, value: number | bigint): Uint8Array {
  return concatBytes(varint(field * 8), varint(value));
}

/**
 * Encode one length-delimited field (`bytes`, `string` as UTF-8, or an embedded message).
 *
 * @param field - Field number.
 * @param value - Raw bytes, or a string written as UTF-8.
 * @returns Tag, length, and value bytes.
 */
export function protoBytesField(field: number, value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return concatBytes(varint(field * 8 + 2), varint(bytes.byteLength), bytes);
}

/**
 * Read one varint at `offset`.
 *
 * @returns Value and the offset after it.
 * @throws Error when the input ends inside the varint or it exceeds 64 bits.
 */
function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let at = offset;
  for (;;) {
    const byte = bytes[at];
    if (byte === undefined) {
      throw new Error('protobuf: truncated varint');
    }
    at += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error('protobuf: varint too long');
    }
  }
  if (value > MAX_UINT64) {
    throw new Error('protobuf: varint too long');
  }
  return { value, next: at };
}

/**
 * Decode every top-level field of a protobuf message in wire order.
 *
 * Fixed 64-bit (wire type 1) and 32-bit (wire type 5) fields are skipped.
 *
 * @param bytes - Serialised message.
 * @returns Varint and length-delimited fields, in wire order.
 * @throws Error on truncated input, field number 0, or wire types 3, 4, 6, 7.
 */
export function decodeProto(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) {
      throw new Error('protobuf: field number 0');
    }
    if (wire === 0) {
      const read = readVarint(bytes, offset);
      offset = read.next;
      fields.push({ field, wire: 0, value: read.value });
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      const end = length.next + Number(length.value);
      if (length.value > BigInt(bytes.byteLength) || end > bytes.byteLength) {
        throw new Error('protobuf: truncated field');
      }
      fields.push({ field, wire: 2, value: bytes.slice(length.next, end) });
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.byteLength) {
        throw new Error('protobuf: truncated field');
      }
    } else {
      throw new Error('protobuf: unsupported wire type');
    }
  }
  return fields;
}
