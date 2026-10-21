import type { InMemoryMessageStore } from '@/lib/message-store';

/** Methods of `MessageStore` that return photo bytes. */
const BYTE_READS = new Set<PropertyKey>([
  'getPhoto',
  'getExtraPhoto',
  'listExtraPhotos',
  'getPhotoSet',
]);

/**
 * Wrap a message store so every photo byte read is recorded.
 *
 * @param store - The in-memory message store to wrap.
 * @param reads - Receives one `method:id` entry per photo byte read.
 * @returns The same store behind a proxy that records each read.
 */
export function countingBytes(store: InMemoryMessageStore, reads: string[]): InMemoryMessageStore {
  return new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (!BYTE_READS.has(key)) return bound;
      return (id: string, ...rest: unknown[]) => {
        reads.push(`${String(key)}:${id}`);
        return bound(id, ...rest);
      };
    },
  });
}
