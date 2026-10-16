import { describe, expect, it } from 'vitest';
import { readCappedText } from '@/lib/capped-body';

function streamed(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Request('http://x/', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('readCappedText', () => {
  it('returns the body when it fits the cap', async () => {
    const request = new Request('http://x/', { method: 'POST', body: 'héllo' });
    expect(await readCappedText(request, 6)).toBe('héllo');
  });

  it('returns an empty string when there is no body', async () => {
    expect(await readCappedText(new Request('http://x/'), 10)).toBe('');
  });

  it('refuses a declared length above the cap before reading', async () => {
    const request = new Request('http://x/', {
      method: 'POST',
      body: 'abc',
      headers: { 'content-length': '11' },
    });
    expect(await readCappedText(request, 10)).toBeNull();
  });

  it('joins several chunks and refuses once the streamed total passes the cap', async () => {
    expect(await readCappedText(streamed(['ab', 'cd']), 4)).toBe('abcd');
    expect(await readCappedText(streamed(['ab', 'cd', 'e']), 4)).toBeNull();
  });
});
