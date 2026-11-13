import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';

const sdk = vi.hoisted(() => {
  const publicBytes = new Uint8Array([2, ...Array<number>(32).fill(7)]);
  const getTransfers = vi.fn();
  const getTokenTransactions = vi.fn();
  const getOwnedBalance = vi.fn();
  return {
    publicBytes,
    getTransfers,
    getTokenTransactions,
    getOwnedBalance,
    createWithViewerKey: vi.fn(async () => ({
      getTransfers,
      getTokenTransactions,
      getOwnedBalance,
    })),
    deriveViewerIdentityPublicKey: vi.fn<() => Promise<unknown>>(async () => publicBytes),
  };
});
const {
  publicBytes: PUBLIC_BYTES,
  getTransfers,
  getTokenTransactions,
  getOwnedBalance,
  createWithViewerKey,
  deriveViewerIdentityPublicKey,
} = sdk;

vi.mock('@buildonspark/spark-sdk', () => ({
  SparkReadonlyClient: { createWithViewerKey: sdk.createWithViewerKey },
  deriveViewerIdentityPublicKey: sdk.deriveViewerIdentityPublicKey,
}));

import {
  SPARK_VIEWER_SCHEMA_SQL,
  ensureSparkViewer,
  migrateSparkViewerSchema,
} from '@/lib/spark-viewer';

const KEK = new Uint8Array(32).fill(9);
const PUBLIC_KEY = `02${'07'.repeat(32)}`;

beforeEach(() => {
  getTransfers.mockReset();
  getTokenTransactions.mockReset();
  getOwnedBalance.mockReset();
  createWithViewerKey.mockClear();
  deriveViewerIdentityPublicKey.mockClear();
});

describe('migrateSparkViewerSchema', () => {
  it('executes the table DDL', async () => {
    const execute = vi.fn(async (_text: string): Promise<void> => undefined);
    await migrateSparkViewerSchema({ query: async () => [], execute });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(SPARK_VIEWER_SCHEMA_SQL);
    expect(SPARK_VIEWER_SCHEMA_SQL[0]).toContain('viewer_mnemonic_ciphertext bytea NOT NULL');
    expect(SPARK_VIEWER_SCHEMA_SQL[0]).toContain(
      'viewer_kek_id integer NOT NULL CHECK (viewer_kek_id = 1)',
    );
  });
});

describe('ensureSparkViewer', () => {
  it('creates an ephemeral key and normalizes SDK transfer and balance results', async () => {
    getTransfers.mockResolvedValue({
      transfers: [
        {
          id: 'transfer',
          senderIdentityPublicKey: PUBLIC_BYTES,
          receiverIdentityPublicKey: new Uint8Array([3, ...Array<number>(32).fill(8)]),
          status: 5,
          totalValue: 21,
          createdTime: new Date('2026-11-12T00:00:00.000Z'),
          updatedTime: undefined,
          type: 2,
          sparkInvoice: 'spark1invoice',
          senders: [{ id: 'sender', identityPublicKey: PUBLIC_BYTES }],
          receivers: [
            {
              id: 'receiver',
              identityPublicKey: new Uint8Array([3, ...Array<number>(32).fill(8)]),
              amountSats: 21,
              status: 5,
            },
          ],
          leaves: [
            {
              leaf: { value: 21 },
              transferSenderId: 'sender',
              transferReceiverId: 'receiver',
            },
          ],
        },
        { id: 1 },
      ],
      offset: -1,
    });
    getOwnedBalance.mockResolvedValue({ balance: 34n });
    const opened = await ensureSparkViewer(undefined, undefined);
    expect(opened.publicKey).toBe(PUBLIC_KEY);
    await expect(
      opened.viewer.transfers({ sparkAddress: 'spark1address', limit: 100, offset: 0 }),
    ).resolves.toMatchObject({
      offset: -1,
      rawCount: 2,
      transfers: [
        {
          id: 'transfer',
          totalValue: 21,
          senders: [{ id: 'sender', identityPublicKey: PUBLIC_BYTES }],
          receivers: [expect.objectContaining({ id: 'receiver', amountSats: 21 })],
          leaves: [{ value: 21, senderId: 'sender', receiverId: 'receiver' }],
        },
      ],
    });
    expect(getTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ types: [0, 1, 2, 3, 4, 5, 30, 40] }),
    );
    await expect(opened.viewer.balance('spark1address')).resolves.toBe(34);
  });

  it('filters malformed transfer rows and applies SDK fallbacks', async () => {
    deriveViewerIdentityPublicKey.mockResolvedValueOnce(PUBLIC_KEY.toUpperCase());
    getTransfers
      .mockResolvedValueOnce({
        transfers: [
          null,
          1,
          { id: 1 },
          { id: 'bad-sender' },
          { id: 'bad-receiver', senderIdentityPublicKey: PUBLIC_BYTES },
          {
            id: 'bad-status',
            senderIdentityPublicKey: PUBLIC_BYTES,
            receiverIdentityPublicKey: PUBLIC_BYTES,
          },
          {
            id: 'bad-value',
            senderIdentityPublicKey: PUBLIC_BYTES,
            receiverIdentityPublicKey: PUBLIC_BYTES,
            status: 5,
          },
          {
            id: 'bad-type',
            senderIdentityPublicKey: PUBLIC_BYTES,
            receiverIdentityPublicKey: PUBLIC_BYTES,
            status: 5,
            totalValue: 1,
          },
          {
            id: 'minimal',
            senderIdentityPublicKey: PUBLIC_BYTES,
            receiverIdentityPublicKey: PUBLIC_BYTES,
            status: 0,
            totalValue: 0,
            type: 0,
            createdTime: 'not-a-date',
            updatedTime: new Date('2026-11-12T01:00:00.000Z'),
            senders: [null, { id: 1 }],
            receivers: [null, { id: 'receiver', identityPublicKey: PUBLIC_BYTES }],
            leaves: [null, { leaf: null }, { leaf: { value: 1 } }],
          },
        ],
        offset: 'done',
      })
      .mockResolvedValueOnce({ transfers: null, offset: 0 });
    getOwnedBalance.mockResolvedValueOnce(0);
    const opened = await ensureSparkViewer(undefined, undefined);
    expect(opened.publicKey).toBe(PUBLIC_KEY);
    await expect(
      opened.viewer.transfers({ sparkAddress: 'spark1address', limit: 100, offset: 0 }),
    ).resolves.toEqual({
      transfers: [
        expect.objectContaining({
          id: 'minimal',
          createdTime: undefined,
          updatedTime: new Date('2026-11-12T01:00:00.000Z'),
          sparkInvoice: '',
        }),
      ],
      offset: -1,
      rawCount: 9,
    });
    await expect(
      opened.viewer.transfers({ sparkAddress: 'spark1address', limit: 100, offset: 0 }),
    ).resolves.toEqual({ transfers: [], offset: 0, rawCount: 0 });
    await expect(opened.viewer.balance('spark1address')).resolves.toBe(0);
  });

  it('normalizes allow-listed token facts and cursor pagination', async () => {
    const hash = new Uint8Array(32).fill(5);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: hash,
            status: 2,
            tokenTransaction: {
              tokenInputs: { $case: 'mintInput', mintInput: { tokenIdentifier: hash } },
              clientCreatedTimestamp: new Date('2026-11-12T02:00:00.000Z'),
              expiryTime: new Date('2026-11-12T02:05:00.000Z'),
              tokenOutputs: [
                {
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenIdentifier: hash,
                  tokenAmount: Uint8Array.of(21),
                },
              ],
            },
          },
          { tokenTransactionHash: new Uint8Array(32).fill(6), status: 10 },
          { status: 2 },
        ],
        pageResponse: { hasPreviousPage: true, previousCursor: 'next' },
      })
      .mockResolvedValueOnce({ transactions: null, pageResponse: null });
    const opened = await ensureSparkViewer(undefined, undefined);
    await expect(
      opened.viewer.tokenTransactions({
        sparkAddress: 'spark1address',
        walletPubkey: PUBLIC_KEY,
        pageSize: 100,
      }),
    ).resolves.toEqual({
      transactions: [
        {
          hash: '05'.repeat(32),
          tokenIdentifier: '05'.repeat(32),
          direction: 'in',
          amount: '21',
          counterpartyPubkeys: [],
          type: 'mint',
          status: 2,
          createdTime: new Date('2026-11-12T02:00:00.000Z'),
          expiryTime: new Date('2026-11-12T02:05:00.000Z'),
        },
      ],
      hasNextPage: true,
      nextCursor: 'next',
      rawCount: 3,
    });
    expect(getTokenTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'PREVIOUS' }),
    );
    await expect(
      opened.viewer.tokenTransactions({
        sparkAddress: 'spark1address',
        walletPubkey: PUBLIC_KEY,
        pageSize: 100,
        cursor: 'next',
      }),
    ).resolves.toEqual({
      transactions: [],
      hasNextPage: false,
      nextCursor: null,
      rawCount: 0,
    });
  });

  it('creates the encrypted durable row under an advisory transaction and reloads it', async () => {
    let stored:
      | {
          viewer_identity_public_key: string;
          viewer_mnemonic_ciphertext: Uint8Array;
          viewer_kek_id: number;
        }
      | undefined;
    const tx: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('pg_advisory_xact_lock')) return [];
        return (stored === undefined ? [] : [stored]) as T[];
      },
      execute: async (_text, params = []) => {
        stored = {
          viewer_identity_public_key: String(params[0]),
          viewer_mnemonic_ciphertext: params[1] as Uint8Array,
          viewer_kek_id: Number(params[2]),
        };
      },
    };
    const sql: SqlClient = {
      query: async () => [],
      execute: async () => {},
      transaction: async (run) => run(tx),
    };
    const created = await ensureSparkViewer(sql, KEK);
    expect(created.publicKey).toBe(PUBLIC_KEY);
    expect(stored).toBeDefined();
    if (stored === undefined) throw new Error('viewer key was not stored');
    expect(stored.viewer_mnemonic_ciphertext).toBeInstanceOf(Uint8Array);
    const envelope = stored.viewer_mnemonic_ciphertext;
    const key = await crypto.subtle.importKey('raw', KEK, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: envelope.subarray(5, 17),
          additionalData: new TextEncoder().encode('spark_viewer_key'),
        },
        key,
        envelope.subarray(17),
      ),
    );
    const derivations = deriveViewerIdentityPublicKey.mock.calls as unknown as Array<
      [unknown, string]
    >;
    const generatedMnemonic = derivations[0]?.[1];
    if (generatedMnemonic === undefined) throw new Error('viewer mnemonic was not derived');
    const decryptedMnemonic = new TextDecoder().decode(plaintext);
    expect(decryptedMnemonic).toBe(generatedMnemonic);
    expect(decryptedMnemonic.split(' ')).toHaveLength(12);
    expect(envelope).not.toEqual(new TextEncoder().encode(generatedMnemonic));
    const loaded = await ensureSparkViewer(sql, KEK);
    expect(loaded.publicKey).toBe(PUBLIC_KEY);

    stored.viewer_identity_public_key = `03${'08'.repeat(32)}`;
    await expect(ensureSparkViewer(sql, KEK)).rejects.toThrow('does not match its public key');
    stored.viewer_identity_public_key = PUBLIC_KEY;
    stored.viewer_kek_id = 2;
    await expect(ensureSparkViewer(sql, KEK)).rejects.toThrow('does not match its public key');
  });

  it('fails when durable custody has no key or transaction', async () => {
    const sql: SqlClient = { query: async () => [], execute: async () => {} };
    await expect(ensureSparkViewer(sql, undefined)).rejects.toThrow('custody');
    await expect(ensureSparkViewer(sql, KEK)).rejects.toThrow('custody');
  });

  it('rejects an invalid balance from the SDK', async () => {
    const opened = await ensureSparkViewer(undefined, undefined);
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', {}, null]) {
      getOwnedBalance.mockResolvedValueOnce(invalid);
      await expect(opened.viewer.balance('spark1address')).rejects.toThrow('invalid balance');
    }
  });

  it('rejects invalid derived keys and malformed durable envelopes', async () => {
    deriveViewerIdentityPublicKey.mockResolvedValueOnce(42);
    await expect(ensureSparkViewer(undefined, undefined)).rejects.toThrow(
      'invalid identity public key',
    );

    function sqlFor(envelope: Uint8Array): SqlClient {
      const tx: SqlClient = {
        query: async <T>(text: string): Promise<T[]> =>
          (text.includes('pg_advisory_xact_lock')
            ? []
            : [
                {
                  viewer_identity_public_key: PUBLIC_KEY,
                  viewer_mnemonic_ciphertext: envelope,
                  viewer_kek_id: 1,
                },
              ]) as unknown as T[],
        execute: async () => undefined,
      };
      return {
        query: async () => [],
        execute: async () => undefined,
        transaction: async (run) => run(tx),
      };
    }

    await expect(ensureSparkViewer(sqlFor(new Uint8Array(1)), KEK)).rejects.toThrow(
      'envelope is invalid',
    );
    const wrongVersion = new Uint8Array(33);
    wrongVersion[0] = 0xff;
    await expect(ensureSparkViewer(sqlFor(wrongVersion), KEK)).rejects.toThrow(
      'envelope is invalid',
    );
    const wrongKey = new Uint8Array(33);
    wrongKey[0] = 1;
    new DataView(wrongKey.buffer).setUint32(1, 2, false);
    await expect(ensureSparkViewer(sqlFor(wrongKey), KEK)).rejects.toThrow(
      'envelope key is invalid',
    );
    const shortKekEnvelope = new Uint8Array(33);
    shortKekEnvelope[0] = 1;
    new DataView(shortKekEnvelope.buffer).setUint32(1, 1, false);
    await expect(ensureSparkViewer(sqlFor(shortKekEnvelope), new Uint8Array(31))).rejects.toThrow(
      'envelope key is invalid',
    );
  });
});

describe('Spark viewer SDK value mapping', () => {
  const baseTransfer = {
    id: 'transfer-coverage',
    status: 1,
    totalValue: 21,
    type: 2,
  };

  it('copies identity keys and maps valid nested transfer fields', async () => {
    const senderKey = new Uint8Array([1, 2]);
    const receiverKey = new Uint8Array([3, 4]);
    const createdTime = new Date('2025-01-02T03:04:05.000Z');
    const updatedTime = new Date('2025-01-02T04:05:06.000Z');

    getTransfers.mockResolvedValueOnce({
      transfers: [
        {
          ...baseTransfer,
          senderIdentityPublicKey: senderKey,
          receiverIdentityPublicKey: receiverKey,
          createdTime,
          updatedTime,
          sparkInvoice: 'spark:invoice',
          senders: [{ id: 'sender', identityPublicKey: senderKey }],
          receivers: [
            {
              id: 'receiver',
              identityPublicKey: receiverKey,
              amountSats: 21,
              status: 1,
            },
          ],
          leaves: [
            {
              leaf: { id: 'leaf', value: 21 },
              transferSenderId: 'sender',
              transferReceiverId: 'receiver',
            },
          ],
        },
      ],
      offset: -1,
    });
    const opened = await ensureSparkViewer(undefined, undefined);
    const page = await opened.viewer.transfers({
      sparkAddress: 'spark1address',
      limit: 100,
      offset: 0,
    });
    const mapped = page.transfers[0];

    expect(mapped).toMatchObject({
      id: 'transfer-coverage',
      senderIdentityPublicKey: senderKey,
      receiverIdentityPublicKey: receiverKey,
      createdTime,
      updatedTime,
      sparkInvoice: 'spark:invoice',
      senders: [{ id: 'sender', identityPublicKey: senderKey }],
      receivers: [{ id: 'receiver', identityPublicKey: receiverKey, status: 1 }],
      leaves: [{ value: 21, senderId: 'sender', receiverId: 'receiver' }],
    });
    expect(mapped?.senderIdentityPublicKey).not.toBe(senderKey);
    expect(mapped?.receiverIdentityPublicKey).not.toBe(receiverKey);
    expect(mapped?.createdTime).not.toBe(createdTime);
    expect(mapped?.updatedTime).not.toBe(updatedTime);
  });

  it('uses empty identities and nested collections for absent SDK fields', async () => {
    getTransfers.mockResolvedValueOnce({
      transfers: [
        {
          ...baseTransfer,
          senderIdentityPublicKey: null,
          receiverIdentityPublicKey: null,
        },
      ],
      offset: -1,
    });
    const opened = await ensureSparkViewer(undefined, undefined);

    await expect(
      opened.viewer.transfers({ sparkAddress: 'spark1address', limit: 100, offset: 0 }),
    ).resolves.toMatchObject({
      transfers: [
        {
          senderIdentityPublicKey: new Uint8Array(),
          receiverIdentityPublicKey: new Uint8Array(),
          sparkInvoice: '',
          senders: [],
          receivers: [],
          leaves: [],
        },
      ],
    });
  });

  it('filters a primitive token transaction', async () => {
    getTokenTransactions.mockResolvedValueOnce({
      transactions: ['not a transaction'],
      pageResponse: null,
    });
    const opened = await ensureSparkViewer(undefined, undefined);

    await expect(
      opened.viewer.tokenTransactions({
        sparkAddress: 'spark1address',
        walletPubkey: PUBLIC_KEY,
        pageSize: 100,
      }),
    ).resolves.toEqual({
      transactions: [],
      hasNextPage: false,
      nextCursor: null,
      rawCount: 1,
    });
  });

  it('maps every token input kind and discards malformed token outputs', async () => {
    getTokenTransactions.mockResolvedValueOnce({
      transactions: [
        {
          tokenTransactionHash: Uint8Array.of(1),
          status: 1,
          tokenTransaction: {
            tokenInputs: { $case: 'createInput' },
            clientCreatedTimestamp: 'not-a-date',
            tokenOutputs: [
              null,
              { ownerPublicKey: 'not-bytes', tokenAmount: Uint8Array.of(1) },
              { ownerPublicKey: Uint8Array.of(2), tokenAmount: Uint8Array.of(1) },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: 'not-bytes' },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: new Uint8Array(17) },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(2) },
            ],
          },
        },
        {
          tokenTransactionHash: Uint8Array.of(2),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'mintInput',
              mintInput: { tokenIdentifier: Uint8Array.of(9) },
            },
            tokenOutputs: [],
          },
        },
        {
          tokenTransactionHash: Uint8Array.of(3),
          status: 3,
          tokenTransaction: {
            tokenInputs: { $case: 'transferInput' },
            tokenOutputs: null,
          },
        },
        {
          tokenTransactionHash: Uint8Array.of(4),
          status: 4,
          tokenTransaction: { tokenInputs: null, tokenOutputs: [] },
        },
      ],
      pageResponse: null,
    });
    const opened = await ensureSparkViewer(undefined, undefined);

    const page = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    expect(page.transactions).toEqual([
      expect.objectContaining({
        hash: '01',
        type: 'create',
        direction: 'in',
        amount: '2',
        tokenIdentifier: null,
        createdTime: undefined,
      }),
      expect.objectContaining({
        hash: '02',
        type: 'mint',
        direction: 'in',
        amount: '0',
        tokenIdentifier: '09',
      }),
      expect.objectContaining({
        hash: '03',
        type: 'transfer',
        direction: 'in',
        amount: '0',
        tokenIdentifier: null,
      }),
      expect.objectContaining({
        hash: '04',
        type: 'unknown',
        direction: 'in',
        amount: '0',
        tokenIdentifier: null,
      }),
    ]);
    expect(page.rawCount).toBe(4);
  });

  it('stores only allow-listed token facts and excludes revocation secrets', async () => {
    const createdTime = new Date('2025-02-03T04:05:06.000Z');
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    getTokenTransactions.mockResolvedValueOnce({
      transactions: [
        {
          tokenTransactionHash: new Uint8Array([0xab, 0xcd]),
          status: 3,
          tokenTransaction: {
            tokenInputs: { $case: 'transferInput', transferInput: { outputsToSpend: [] } },
            clientCreatedTimestamp: createdTime,
            tokenOutputs: [
              {
                ownerPublicKey: otherKey,
                tokenIdentifier: Uint8Array.of(9),
                tokenAmount: Uint8Array.of(1, 0),
                seWithdrawalSignature: Uint8Array.of(4, 5),
              },
            ],
          },
          confirmationMetadata: {
            spentTokenOutputsMetadata: [
              { outputId: 'secret-output', revocationSecret: Uint8Array.of(1, 2, 3) },
            ],
          },
        },
      ],
      pageResponse: null,
    });
    const opened = await ensureSparkViewer(undefined, undefined);
    const page = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    const mapped = page.transactions[0];

    expect(mapped).toEqual({
      hash: 'abcd',
      tokenIdentifier: '09',
      direction: 'out',
      amount: '256',
      counterpartyPubkeys: [`03${'08'.repeat(32)}`],
      type: 'transfer',
      status: 3,
      createdTime,
      expiryTime: undefined,
    });
    expect(JSON.stringify(mapped)).not.toContain('revocationSecret');
    expect(JSON.stringify(mapped)).not.toContain('010203');
    expect(JSON.stringify(mapped)).not.toContain('seWithdrawalSignature');
    expect(mapped?.createdTime).not.toBe(createdTime);
  });
});
