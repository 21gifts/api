import { describe, expect, it, vi } from 'vitest';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';
import {
  SPARK_QUERY_LIMIT,
  encodeQuerySparkInvoicesRequest,
  parseQuerySparkInvoicesResponse,
  querySparkInvoices,
} from '@/lib/spark-operator';

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, payload.byteLength);
  return concatBytes(header, payload);
}

function trailer(text: string): Uint8Array {
  return frame(0x80, new TextEncoder().encode(text));
}

function invoiceResponse(invoice: string, status?: number, transferId?: Uint8Array): Uint8Array {
  return protoBytesField(
    2,
    concatBytes(
      protoBytesField(1, invoice),
      ...(status === undefined ? [] : [protoVarintField(2, status)]),
      ...(transferId === undefined ? [] : [protoBytesField(3, protoBytesField(1, transferId))]),
    ),
  );
}

function data(...entries: Uint8Array[]): Uint8Array {
  return frame(0, concatBytes(...entries));
}

describe('encodeQuerySparkInvoicesRequest', () => {
  it('frames limit 100 and every invoice', () => {
    const body = encodeQuerySparkInvoicesRequest(['spark1a', 'spark1b']);
    expect(body[0]).toBe(0);
    const length = new DataView(body.buffer).getUint32(1);
    expect(length).toBe(body.byteLength - 5);
    const fields = decodeProto(body.subarray(5));
    expect(fields[0]).toEqual({ field: 1, wire: 0, value: BigInt(SPARK_QUERY_LIMIT) });
    expect(
      fields.slice(1).map((f) => [f.field, new TextDecoder().decode(f.value as Uint8Array)]),
    ).toEqual([
      [3, 'spark1a'],
      [3, 'spark1b'],
    ]);
    expect([...body.subarray(5, 7)]).toEqual([0x08, 0x64]);
  });
});

describe('parseQuerySparkInvoicesResponse', () => {
  it('maps every status and the transfer id', () => {
    const body = concatBytes(
      data(
        invoiceResponse('fin', 2, Uint8Array.of(0xab, 0xcd)),
        invoiceResponse('none'),
        invoiceResponse('pend', 1),
        invoiceResponse('ret', 4),
        invoiceResponse('m5', 5),
        invoiceResponse('m6', 6),
        invoiceResponse('m7', 7),
        invoiceResponse('odd', 3),
        protoVarintField(1, 9),
      ),
      trailer('grpc-status: 0\r\ngrpc-message: ok\r\n'),
    );
    expect(parseQuerySparkInvoicesResponse(body, null)).toEqual({
      ok: true,
      invoices: [
        { invoice: 'fin', status: 'finalized', transferId: 'abcd' },
        { invoice: 'none', status: 'not_found', transferId: null },
        { invoice: 'pend', status: 'pending', transferId: null },
        { invoice: 'ret', status: 'returned', transferId: null },
        { invoice: 'm5', status: 'mismatched', transferId: null },
        { invoice: 'm6', status: 'mismatched', transferId: null },
        { invoice: 'm7', status: 'mismatched', transferId: null },
        { invoice: 'odd', status: 'unknown', transferId: null },
      ],
    });
  });

  it('ignores fields with unexpected wire types', () => {
    const odd = protoBytesField(
      2,
      concatBytes(
        protoVarintField(1, 1),
        protoBytesField(2, 'x'),
        protoVarintField(3, 1),
        protoBytesField(3, protoVarintField(1, 5)),
        protoBytesField(4, 'token'),
      ),
    );
    const body = concatBytes(data(odd, protoVarintField(2, 1)), trailer('grpc-status:0'));
    expect(parseQuerySparkInvoicesResponse(body, null)).toEqual({
      ok: true,
      invoices: [{ invoice: '', status: 'not_found', transferId: null }],
    });
  });

  it('takes the header status for a trailers-only response', () => {
    expect(parseQuerySparkInvoicesResponse(new Uint8Array(0), '0')).toEqual({
      ok: true,
      invoices: [],
    });
    expect(parseQuerySparkInvoicesResponse(new Uint8Array(0), '14')).toEqual({
      ok: false,
      reason: 'grpc',
      grpcStatus: 14,
    });
  });

  it('prefers the header status over the trailer frame', () => {
    expect(parseQuerySparkInvoicesResponse(trailer('grpc-status: 13'), '0')).toEqual({
      ok: true,
      invoices: [],
    });
  });

  it('reports a non-zero trailer status, numeric or not', () => {
    expect(parseQuerySparkInvoicesResponse(trailer('Grpc-Status: 3\r\n'), null)).toEqual({
      ok: false,
      reason: 'grpc',
      grpcStatus: 3,
    });
    expect(parseQuerySparkInvoicesResponse(trailer('grpc-status: x'), null)).toEqual({
      ok: false,
      reason: 'grpc',
      grpcStatus: -1,
    });
  });

  it('is malformed without a status', () => {
    expect(parseQuerySparkInvoicesResponse(new Uint8Array(0), null)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      parseQuerySparkInvoicesResponse(trailer('no colon here\r\ngrpc-message: x'), null),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is malformed for compressed, truncated, or undecodable frames', () => {
    expect(parseQuerySparkInvoicesResponse(frame(1, new Uint8Array(0)), '0')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(parseQuerySparkInvoicesResponse(Uint8Array.of(0, 0, 0), '0')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(parseQuerySparkInvoicesResponse(Uint8Array.of(0, 0, 0, 0, 9, 1), '0')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(parseQuerySparkInvoicesResponse(frame(0, Uint8Array.of(0x0b)), '0')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('querySparkInvoices', () => {
  it('posts the gRPC-web request and parses the response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(concatBytes(data(invoiceResponse('a', 1)), trailer('grpc-status: 0')), {
          status: 200,
        }),
    );
    const result = await querySparkInvoices('https://op.example', fetchImpl, ['a']);
    expect(result).toEqual({
      ok: true,
      invoices: [{ invoice: 'a', status: 'pending', transferId: null }],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://op.example/spark.SparkService/query_spark_invoices');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
    });
    expect(init.redirect).toBe('error');
    expect(init.body).toEqual(encodeQuerySparkInvoicesRequest(['a']));
  });

  it('reads grpc-status from the response header', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'grpc-status': '7' } }),
    );
    expect(await querySparkInvoices('https://op.example', fetchImpl, ['a'])).toEqual({
      ok: false,
      reason: 'grpc',
      grpcStatus: 7,
    });
  });

  it('is unreachable when fetch or the body read fails', async () => {
    expect(
      await querySparkInvoices('https://op.example', () => Promise.reject(new Error('x')), []),
    ).toEqual({ ok: false, reason: 'unreachable' });
    const broken = {
      status: 200,
      headers: new Headers(),
      arrayBuffer: () => Promise.reject(new Error('x')),
    } as unknown as Response;
    expect(await querySparkInvoices('https://op.example', async () => broken, [])).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('reports a non-200 HTTP status', async () => {
    expect(
      await querySparkInvoices(
        'https://op.example',
        async () => new Response('', { status: 503 }),
        [],
      ),
    ).toEqual({ ok: false, reason: 'http' });
  });
});
