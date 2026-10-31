/**
 * Read a request body as UTF-8 text without buffering past a byte cap.
 *
 * A declared `Content-Length` above the cap is refused before reading. Without
 * one, the stream is read chunk by chunk and cancelled as soon as the total
 * passes the cap.
 *
 * @param request - Incoming request.
 * @param limitBytes - Largest accepted body, in bytes.
 * @returns The decoded body (`''` when there is none), or `null` when it is
 *   larger than `limitBytes`.
 */
export async function readCappedText(request: Request, limitBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limitBytes) {
    return null;
  }
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
