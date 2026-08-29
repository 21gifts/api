import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { indexZapReceipt, resetZapReceiptIndex } from '@/lib/nostr/zap-index';

describe('indexZapReceipt', () => {
  beforeEach(() => {
    resetZapReceiptIndex();
  });

  it('adds sats when the provider pubkey matches', async () => {
    const store = new InMemoryMessageStore();
    const row = await store.create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      ...unsignedNostrDefaults(),
    });
    const ok = await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r1', pubkey: 'aa'.repeat(32), tags: [] },
      providerPubkey: 'aa'.repeat(32),
      amountSats: 21,
    });
    expect(ok).toBe(true);
    expect((await store.getById(row.id))?.sats).toBe(21);
    const dup = await indexZapReceipt({
      store,
      messageId: row.id,
      receipt: { id: 'r1', pubkey: 'aa'.repeat(32), tags: [] },
      providerPubkey: 'aa'.repeat(32),
      amountSats: 21,
    });
    expect(dup).toBe(false);
  });

  it('rejects a mismatched provider pubkey', async () => {
    const store = new InMemoryMessageStore();
    const ok = await indexZapReceipt({
      store,
      messageId: 'm1',
      receipt: { id: 'r2', pubkey: 'aa'.repeat(32), tags: [] },
      providerPubkey: 'bb'.repeat(32),
      amountSats: 21,
    });
    expect(ok).toBe(false);
  });

  it('rejects a non-positive amount', async () => {
    const store = new InMemoryMessageStore();
    const ok = await indexZapReceipt({
      store,
      messageId: 'm1',
      receipt: { id: 'r3', pubkey: 'aa'.repeat(32), tags: [] },
      providerPubkey: 'aa'.repeat(32),
      amountSats: 0,
    });
    expect(ok).toBe(false);
  });
});
