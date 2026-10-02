/**
 * gRPC-web client for the Spark coordinator's `query_spark_invoices` call.
 *
 * The request and response are hand-encoded protobuf (see `protobuf.ts`).
 * No authentication is sent; the call only reads invoice status.
 */

import { hex } from '@scure/base';
import type { FetchFn } from '@/lib/lnurlp';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';

/** Most invoices asked about in one request. */
export const SPARK_QUERY_LIMIT = 100;

/** Abort one operator request after this many milliseconds. */
export const SPARK_OPERATOR_TIMEOUT_MS = 10_000;

/** Status of one Spark invoice as reported by the operators. */
export type SparkInvoiceStatus =
  'not_found' | 'pending' | 'finalized' | 'returned' | 'mismatched' | 'unknown';

/** One invoice in a query response. */
export interface SparkInvoiceState {
  /** The `spark1…` string as sent. */
  invoice: string;
  /** Reported status; only `finalized` means paid. */
  status: SparkInvoiceStatus;
  /** Transfer id (lower-case hex) of the paying transfer, or `null`. */
  transferId: string | null;
}

/** Outcome of {@link querySparkInvoices}. */
export type QuerySparkInvoicesResult =
  | { ok: true; invoices: SparkInvoiceState[] }
  | { ok: false; reason: 'unreachable' | 'http' | 'malformed' }
  | { ok: false; reason: 'grpc'; grpcStatus: number };

/** gRPC-web frame flag of a trailer frame. */
const TRAILER_FLAG = 0x80;
/** gRPC-web frame flag of a compressed message. */
const COMPRESSED_FLAG = 0x01;

/**
 * Wrap one protobuf message in a gRPC-web data frame.
 *
 * @param message - Serialised message.
 * @returns Flags byte 0, 4-byte big-endian length, then the message.
 */
function grpcWebFrame(message: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(1, message.byteLength);
  return concatBytes(header, message);
}

/**
 * Build the gRPC-web body of `QuerySparkInvoicesRequest { 1: limit, 3: repeated invoice }`.
 *
 * @param invoices - Up to {@link SPARK_QUERY_LIMIT} invoice strings.
 * @returns Framed request body.
 */
export function encodeQuerySparkInvoicesRequest(invoices: readonly string[]): Uint8Array {
  return grpcWebFrame(
    concatBytes(
      protoVarintField(1, SPARK_QUERY_LIMIT),
      ...invoices.map((invoice) => protoBytesField(3, invoice)),
    ),
  );
}

/**
 * Map the wire enum to {@link SparkInvoiceStatus}.
 *
 * @param value - Enum number (0 when omitted on the wire).
 */
function statusOf(value: bigint): SparkInvoiceStatus {
  switch (value) {
    case 0n:
      return 'not_found';
    case 1n:
      return 'pending';
    case 2n:
      return 'finalized';
    case 4n:
      return 'returned';
    case 5n:
    case 6n:
    case 7n:
      return 'mismatched';
    default:
      return 'unknown';
  }
}

/**
 * Decode one `InvoiceResponse { 1: invoice, 2: status, 3: SatsTransfer { 1: transfer_id } }`.
 *
 * @param bytes - Embedded message bytes.
 */
function decodeInvoiceResponse(bytes: Uint8Array): SparkInvoiceState {
  let invoice = '';
  let status = 0n;
  let transferId: string | null = null;
  for (const field of decodeProto(bytes)) {
    if (field.field === 1 && field.wire === 2) {
      invoice = new TextDecoder().decode(field.value);
    } else if (field.field === 2 && field.wire === 0) {
      status = field.value;
    } else if (field.field === 3 && field.wire === 2) {
      for (const inner of decodeProto(field.value)) {
        if (inner.field === 1 && inner.wire === 2) {
          transferId = hex.encode(inner.value);
        }
      }
    }
  }
  return { invoice, status: statusOf(status), transferId };
}

/**
 * Read `grpc-status` from a trailer frame (`name: value` lines, CRLF separated).
 *
 * @param payload - Trailer frame payload.
 * @returns The status text, or `null` when absent.
 */
function trailerStatus(payload: Uint8Array): string | null {
  for (const line of new TextDecoder().decode(payload).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === 'grpc-status') {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

/**
 * Parse a gRPC-web `QuerySparkInvoicesResponse { 2: repeated InvoiceResponse }` body.
 *
 * `grpc-status` is taken from the response header when present (a
 * trailers-only response), otherwise from the trailer frame. A missing
 * status, a compressed or truncated frame, or undecodable protobuf is
 * `malformed`; a status other than `0` is `grpc`.
 *
 * @param body - Raw response body.
 * @param headerStatus - `grpc-status` response header, or `null`.
 * @returns Invoice states, or a failure reason.
 */
export function parseQuerySparkInvoicesResponse(
  body: Uint8Array,
  headerStatus: string | null,
): QuerySparkInvoicesResult {
  const invoices: SparkInvoiceState[] = [];
  let status = headerStatus;
  let offset = 0;
  try {
    while (offset < body.byteLength) {
      if (offset + 5 > body.byteLength) {
        return { ok: false, reason: 'malformed' };
      }
      const flags = body[offset] as number;
      const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0);
      const start = offset + 5;
      const end = start + length;
      if (end > body.byteLength) {
        return { ok: false, reason: 'malformed' };
      }
      const payload = body.subarray(start, end);
      offset = end;
      if ((flags & TRAILER_FLAG) !== 0) {
        status ??= trailerStatus(payload);
        continue;
      }
      if ((flags & COMPRESSED_FLAG) !== 0) {
        return { ok: false, reason: 'malformed' };
      }
      for (const field of decodeProto(payload)) {
        if (field.field === 2 && field.wire === 2) {
          invoices.push(decodeInvoiceResponse(field.value));
        }
      }
    }
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (status === null) {
    return { ok: false, reason: 'malformed' };
  }
  if (status !== '0') {
    const code = Number(status);
    return { ok: false, reason: 'grpc', grpcStatus: Number.isInteger(code) ? code : -1 };
  }
  return { ok: true, invoices };
}

/**
 * Ask the Spark coordinator for the status of up to {@link SPARK_QUERY_LIMIT} invoices.
 *
 * `POST <operatorUrl>/spark.SparkService/query_spark_invoices` with
 * `content-type: application/grpc-web+proto` and `x-grpc-web: 1`. The RPC path
 * is appended to the URL path, so a query on `operatorUrl` is kept and a
 * fragment dropped. Never logs an invoice.
 *
 * @param operatorUrl - Coordinator base URL.
 * @param fetchImpl - Injected `fetch`.
 * @param invoices - Invoice strings (at most {@link SPARK_QUERY_LIMIT}).
 * @returns Invoice states, or `unreachable` (fetch or body read failed),
 *   `http` (status other than 200), `grpc`, or `malformed`.
 */
export async function querySparkInvoices(
  operatorUrl: string,
  fetchImpl: FetchFn,
  invoices: readonly string[],
): Promise<QuerySparkInvoicesResult> {
  let response: Response;
  let body: Uint8Array;
  try {
    const endpoint = new URL(operatorUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/spark.SparkService/query_spark_invoices`;
    endpoint.hash = '';
    response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: encodeQuerySparkInvoicesRequest(invoices),
      redirect: 'error',
      signal: AbortSignal.timeout(SPARK_OPERATOR_TIMEOUT_MS),
    });
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status !== 200) {
    return { ok: false, reason: 'http' };
  }
  return parseQuerySparkInvoicesResponse(body, response.headers.get('grpc-status'));
}
