import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decryptKind4, encryptKind4, unwrapNip17, wrapNip17 } from '@/lib/nostr/dm';

vi.mock('nostr-tools/nip17', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools/nip17')>();
  return {
    ...actual,
    unwrapEvent: (wrap: { content?: string }, secret: Uint8Array) => {
      if (wrap.content === 'force-kind') {
        return { kind: 1, content: 'x', pubkey: 'aa'.repeat(32) };
      }
      if (wrap.content === 'force-empty') {
        return { kind: 14, content: 'x', pubkey: '' };
      }
      if (wrap.content === 'force-content') {
        return { kind: 14, content: 1, pubkey: 'aa'.repeat(32), created_at: 0 };
      }
      if (wrap.content === 'force-no-created') {
        return { kind: 14, content: 'x', pubkey: 'aa'.repeat(32) };
      }
      if (wrap.content === 'force-pubkey-type') {
        return { kind: 14, content: 'x', pubkey: 1 };
      }
      return actual.unwrapEvent(wrap as never, secret);
    },
  };
});

describe('wrapNip17 / unwrapNip17', () => {
  it('round-trips plaintext to the recipient', () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const wrap = wrapNip17(sender, getPublicKey(recipient), 'hello');
    expect(wrap.kind).toBe(1059);
    const unwrapped = unwrapNip17(wrap, recipient);
    expect(unwrapped?.senderPubkey).toBe(getPublicKey(sender));
    expect(unwrapped?.text).toBe('hello');
    expect(typeof unwrapped?.createdAt).toBe('number');
  });

  it('returns null when unwrap fails', () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const other = generateSecretKey();
    const wrap = wrapNip17(sender, getPublicKey(recipient), 'hello');
    expect(unwrapNip17(wrap, other)).toBeNull();
  });

  it('returns null when the rumor is not kind 14', () => {
    const recipient = generateSecretKey();
    expect(
      unwrapNip17(
        {
          kind: 1059,
          content: 'force-kind',
          id: 'ab'.repeat(32),
          pubkey: 'cd'.repeat(32),
          created_at: 1,
          tags: [],
          sig: 'ef'.repeat(32),
        },
        recipient,
      ),
    ).toBeNull();
  });

  it('returns null when the rumor pubkey is empty', () => {
    const recipient = generateSecretKey();
    expect(
      unwrapNip17(
        {
          kind: 1059,
          content: 'force-empty',
          id: 'ab'.repeat(32),
          pubkey: 'cd'.repeat(32),
          created_at: 1,
          tags: [],
          sig: 'ef'.repeat(32),
        },
        recipient,
      ),
    ).toBeNull();
  });

  it('treats a non-string rumor content as empty text', () => {
    const recipient = generateSecretKey();
    expect(
      unwrapNip17(
        {
          kind: 1059,
          content: 'force-content',
          id: 'ab'.repeat(32),
          pubkey: 'cd'.repeat(32),
          created_at: 1,
          tags: [],
          sig: 'ef'.repeat(32),
        },
        recipient,
      ),
    ).toEqual({ senderPubkey: 'aa'.repeat(32), text: '', createdAt: 0 });
  });

  it('returns null when the rumor has no created_at', () => {
    const recipient = generateSecretKey();
    expect(
      unwrapNip17(
        {
          kind: 1059,
          content: 'force-no-created',
          id: 'ab'.repeat(32),
          pubkey: 'cd'.repeat(32),
          created_at: 1,
          tags: [],
          sig: 'ef'.repeat(32),
        },
        recipient,
      ),
    ).toBeNull();
  });

  it('returns null when the rumor pubkey is not a string', () => {
    const recipient = generateSecretKey();
    expect(
      unwrapNip17(
        {
          kind: 1059,
          content: 'force-pubkey-type',
          id: 'ab'.repeat(32),
          pubkey: 'cd'.repeat(32),
          created_at: 1,
          tags: [],
          sig: 'ef'.repeat(32),
        },
        recipient,
      ),
    ).toBeNull();
  });
});

describe('encryptKind4 / decryptKind4', () => {
  it('round-trips plaintext to the recipient', () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const cipher = encryptKind4(sender, getPublicKey(recipient), 'legacy');
    expect(decryptKind4(recipient, getPublicKey(sender), cipher)).toBe('legacy');
  });

  it('returns null when decrypt fails', () => {
    const recipient = generateSecretKey();
    expect(decryptKind4(recipient, 'ab'.repeat(32), 'not-ciphertext')).toBeNull();
  });
});
