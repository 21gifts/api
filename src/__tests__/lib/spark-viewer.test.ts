import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import {
  runWalletTransferTick,
  type WalletTransferWorkerDeps,
} from '@/lib/wallet-transfer-worker';

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

  it('maps mint amount, issuer counterparty, invoice, and cursor pagination', async () => {
    const hash = new Uint8Array(32).fill(5);
    const issuer = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: hash,
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'mintInput',
                mintInput: { tokenIdentifier: hash, issuerPublicKey: issuer },
              },
              clientCreatedTimestamp: new Date('2026-11-12T02:00:00.000Z'),
              expiryTime: new Date('2026-11-12T02:05:00.000Z'),
              tokenOutputs: [
                {
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenIdentifier: hash,
                  tokenAmount: Uint8Array.of(21),
                },
              ],
              invoiceAttachments: [{ sparkInvoice: 'spark1mint' }],
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
          counterpartyPubkeys: [`03${'08'.repeat(32)}`],
          inputCount: 0,
          resolvedInputCount: 0,
          sparkInvoices: ['spark1mint'],
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
      transactions: ['not a transaction', {}],
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
      rawCount: 2,
    });
  });

  it('maps every token input kind and discards malformed token outputs', async () => {
    getTokenTransactions.mockResolvedValueOnce({
      transactions: [
        {
          tokenTransactionHash: Uint8Array.of(1),
          status: 1,
          tokenTransaction: {
            tokenInputs: { $case: 'createInput', createInput: { issuerPublicKey: PUBLIC_BYTES } },
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
        counterpartyPubkeys: [PUBLIC_KEY],
        sparkInvoices: [],
        createdTime: undefined,
      }),
      expect.objectContaining({
        hash: '02',
        type: 'mint',
        direction: 'in',
        amount: '0',
        tokenIdentifier: '09',
        counterpartyPubkeys: [],
        sparkInvoices: [],
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

  it('maps receive-with-change as incoming and send-with-change as outgoing from spent owners', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const receiveInputHash = new Uint8Array(32).fill(0x11);
    const sendInputHash = new Uint8Array(32).fill(0x22);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x33),
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: receiveInputHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              tokenOutputs: [
                { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(21) },
                { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(79) },
              ],
              invoiceAttachments: [{ sparkInvoice: 'spark1receive' }],
            },
            confirmationMetadata: {
              spentTokenOutputsMetadata: [{ outputId: 'receive-spent' }],
            },
          },
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x44),
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: sendInputHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              tokenOutputs: [
                { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(30) },
                { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(70) },
              ],
              invoiceAttachments: [{ sparkInvoice: 'spark1send' }],
            },
            confirmationMetadata: {
              spentTokenOutputsMetadata: [{ outputId: 'send-spent' }],
            },
          },
        ],
        pageResponse: null,
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x99),
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                { id: 'receive-spent', ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(100) },
              ],
            },
          },
        ],
        pageResponse: { hasNextPage: true, nextCursor: 'lookup-next' },
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: sendInputHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                { id: 'send-spent', ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(100) },
              ],
            },
          },
        ],
        pageResponse: { hasNextPage: false },
      });
    const opened = await ensureSparkViewer(undefined, undefined);

    const page = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    expect(page.transactions).toEqual([
      expect.objectContaining({
        direction: 'in',
        amount: '21',
        counterpartyPubkeys: [],
        inputCount: 1,
        resolvedInputCount: 0,
      }),
      expect.objectContaining({
        direction: 'in',
        amount: '70',
        counterpartyPubkeys: [],
        inputCount: 1,
        resolvedInputCount: 0,
      }),
    ]);
    const firstOwnerPage = await page.ownerResolution?.next();
    expect(firstOwnerPage).toMatchObject({ done: false });
    const resolved = await page.ownerResolution?.next();

    expect(resolved?.transactions).toEqual([
      expect.objectContaining({
        direction: 'in',
        amount: '21',
        counterpartyPubkeys: [`03${'08'.repeat(32)}`],
        resolvedInputCount: 1,
        sparkInvoices: ['spark1receive'],
      }),
      expect.objectContaining({
        direction: 'out',
        amount: '30',
        counterpartyPubkeys: [`03${'08'.repeat(32)}`],
        resolvedInputCount: 1,
        sparkInvoices: ['spark1send'],
      }),
    ]);
    expect(getTokenTransactions.mock.calls[1]?.[0]).toMatchObject({
      outputIds: ['receive-spent', 'send-spent'],
      direction: 'NEXT',
    });
    expect(getTokenTransactions.mock.calls[2]?.[0]).toMatchObject({ cursor: 'lookup-next' });
  });

  it('returns a late finished owner lookup on the next token page before dropping it', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x51);
    const primaryPage = {
      transactions: [
        {
          tokenTransactionHash: new Uint8Array(32).fill(0x52),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                ],
              },
            },
            tokenOutputs: [
              { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(25) },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) },
            ],
          },
          confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId: 'cached-spent' }] },
        },
      ],
      pageResponse: null,
    };
    let release = (): void => undefined;
    getTokenTransactions
      .mockResolvedValueOnce(primaryPage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                transactions: [
                  {
                    tokenTransactionHash: previousHash,
                    status: 2,
                    tokenTransaction: {
                      tokenOutputs: [
                        {
                          id: 'cached-spent',
                          ownerPublicKey: PUBLIC_BYTES,
                          tokenAmount: Uint8Array.of(100),
                        },
                      ],
                    },
                  },
                ],
                pageResponse: null,
              });
          }),
      )
      .mockResolvedValueOnce(primaryPage)
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                {
                  id: 'cached-spent',
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenAmount: Uint8Array.of(100),
                },
              ],
            },
          },
        ],
        pageResponse: null,
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const first = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    const lookup = first.ownerResolution!.next();
    expect(first.ownerResolution!.next()).toBe(lookup);
    release();
    await lookup;
    const repeated = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    expect(repeated.transactions[0]).toMatchObject({
      direction: 'out',
      amount: '25',
      counterpartyPubkeys: [`03${'08'.repeat(32)}`],
    });
    expect(repeated.ownerResolution).toBeUndefined();
    expect(getTokenTransactions).toHaveBeenCalledTimes(3);
  });

  it('retains a never-settling owner lookup for reuse after a caller timeout', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x61);
    const primaryPage = {
      transactions: [
        {
          tokenTransactionHash: new Uint8Array(32).fill(0x62),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                ],
              },
            },
            tokenOutputs: [
              { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(25) },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) },
            ],
          },
          confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId: 'stuck-spent' }] },
        },
      ],
      pageResponse: null,
    };
    getTokenTransactions
      .mockResolvedValueOnce(primaryPage)
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(primaryPage)
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                {
                  id: 'stuck-spent',
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenAmount: Uint8Array.of(100),
                },
              ],
            },
          },
        ],
        pageResponse: null,
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const first = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    const pending = first.ownerResolution!.next();

    const later = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    expect(later.ownerResolution).toBe(first.ownerResolution);
    expect(later.ownerResolution!.next()).toBe(pending);
    expect(getTokenTransactions).toHaveBeenCalledTimes(3);
  });

  it('reopens an unfinished lookup when the same SDK page gains an output id', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x53);
    const transaction = (outputId?: string) => ({
      tokenTransactionHash: new Uint8Array(32).fill(0x54),
      status: 2,
      tokenTransaction: {
        tokenInputs: {
          $case: 'transferInput',
          transferInput: {
            outputsToSpend: [
              { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
            ],
          },
        },
        tokenOutputs: [
          { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(25) },
          { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) },
        ],
      },
      ...(outputId === undefined
        ? {}
        : { confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId }] } }),
    });
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [transaction()],
        pageResponse: { hasPreviousPage: true, previousCursor: 'older' },
      })
      .mockResolvedValueOnce({
        transactions: [transaction('confirmed-output')],
        pageResponse: { hasPreviousPage: true, previousCursor: 'older' },
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                {
                  id: 'confirmed-output',
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenAmount: Uint8Array.of(100),
                },
              ],
            },
          },
        ],
        pageResponse: null,
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const first = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    const updated = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    expect(updated.ownerResolution).toBe(first.ownerResolution);
    const resolved = await updated.ownerResolution!.next();
    expect(getTokenTransactions.mock.calls[2]?.[0]).toMatchObject({
      outputIds: ['confirmed-output'],
      direction: 'NEXT',
    });
    expect(resolved.transactions[0]).toMatchObject({ direction: 'out', amount: '25' });
  });

  it('updates an unresolved input when the same SDK page loses its output id', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x55);
    const transaction = (withOutputId: boolean) => ({
      tokenTransactionHash: new Uint8Array(32).fill(0x56),
      status: 2,
      tokenTransaction: {
        tokenInputs: {
          $case: 'transferInput',
          transferInput: {
            outputsToSpend: [
              { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
            ],
          },
        },
        tokenOutputs: [
          { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(25) },
          { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) },
        ],
      },
      ...(withOutputId
        ? { confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId: 'spent-output' }] } }
        : {}),
    });
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [transaction(true)],
        pageResponse: { hasPreviousPage: true, previousCursor: 'older' },
      })
      .mockResolvedValueOnce({
        transactions: [transaction(false)],
        pageResponse: { hasPreviousPage: true, previousCursor: 'older' },
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [{ ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(100) }],
            },
          },
        ],
        pageResponse: null,
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const first = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    const updated = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    expect(updated.ownerResolution).toBe(first.ownerResolution);
    const resolved = await updated.ownerResolution!.next();
    expect(getTokenTransactions.mock.calls[2]?.[0]).toMatchObject({
      sparkAddresses: ['spark1address'],
      cursor: 'older',
      direction: 'PREVIOUS',
    });
    expect(resolved.transactions[0]).toMatchObject({ direction: 'out', amount: '25' });
  });

  it('queues lookups beyond 128 without evicting unfinished resolutions', async () => {
    const previousHash = new Uint8Array(32).fill(0x55);
    const unresolvedPage = (hashByte: number) => ({
      transactions: [
        {
          tokenTransactionHash: new Uint8Array(32).fill(hashByte),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                ],
              },
            },
            tokenOutputs: [],
          },
          confirmationMetadata: {
            spentTokenOutputsMetadata: [{ outputId: `output-${String(hashByte)}` }],
          },
        },
      ],
      pageResponse: null,
    });
    getTokenTransactions.mockImplementation(async (input) => {
      const request = input as {
        sparkAddresses?: string[];
        outputIds?: string[];
        cursor?: string;
      };
      const address = request.sparkAddresses?.[0];
      if (address !== undefined) {
        const suffix = Number(address.slice('spark'.length));
        return unresolvedPage(Number.isSafeInteger(suffix) ? suffix + 1 : 1);
      }
      const outputId = request.outputIds?.[0] ?? '';
      if (request.cursor === undefined) {
        return {
          transactions: [],
          pageResponse: { hasNextPage: true, nextCursor: `next-${outputId}` },
        };
      }
      return {
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                {
                  id: outputId,
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenAmount: Uint8Array.of(100),
                },
              ],
            },
          },
        ],
        pageResponse: null,
      };
    });
    const opened = await ensureSparkViewer(undefined, undefined);
    getTransfers.mockResolvedValue({ transfers: [], offset: -1 });
    getOwnedBalance.mockResolvedValue(0);
    const wallets = Array.from({ length: 129 }, (_, index) => ({
      accountId: `account-${String(index)}`,
      sparkPubkey: PUBLIC_KEY,
      sparkAddress: `spark${String(index)}`,
    }));
    const fullSync = new Set<string>();
    const transfers: WalletTransferStore = {
      listWallets: async () => wallets,
      syncState: async (accountId, walletPubkey) => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: fullSync.has(`${accountId}\u0000${walletPubkey}`)
          ? new Date('2026-11-13T12:00:00.000Z')
          : null,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: async () => undefined,
      markFullSync: async (accountId, walletPubkey) => {
        fullSync.add(`${accountId}\u0000${walletPubkey}`);
      },
      hasShopPayment: async () => false,
    };
    const deps: WalletTransferWorkerDeps = {
      viewer: opened.viewer,
      transfers,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      gifts: { listOutbound: async () => [] },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        walletTransfers: transfers,
      },
      now: () => Date.parse('2026-11-13T12:00:00.000Z'),
    };
    for (let tick = 0; tick < 4; tick += 1) {
      expect((await runWalletTransferTick(deps)).size).toBe(0);
    }

    expect(fullSync.size).toBe(129);
    expect(
      getTokenTransactions.mock.calls.filter(
        (call) => (call[0] as { outputIds?: string[] }).outputIds !== undefined,
      ).length,
    ).toBeLessThanOrEqual(2 * 129 + 127);
  });

  it('reuses an unfinished resolution when the primary page hash changes', async () => {
    const previousHash = new Uint8Array(32).fill(0x55);
    const unresolvedPage = (hashByte: number) => ({
      transactions: [
        {
          tokenTransactionHash: new Uint8Array(32).fill(hashByte),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                ],
              },
            },
            tokenOutputs: [],
          },
          confirmationMetadata: {
            spentTokenOutputsMetadata: [{ outputId: `output-${String(hashByte)}` }],
          },
        },
      ],
      pageResponse: null,
    });
    getTokenTransactions
      .mockResolvedValueOnce(unresolvedPage(201))
      .mockResolvedValueOnce(unresolvedPage(202))
      .mockResolvedValueOnce(unresolvedPage(201));
    const opened = await ensureSparkViewer(undefined, undefined);
    const staleFirst = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-stale',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-stale',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    const staleAgain = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-stale',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    expect(staleAgain.ownerResolution).toBe(staleFirst.ownerResolution);
  });

  it('uses a local outpoint owner and never guesses ownership for an unresolved input', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x61);
    getTokenTransactions.mockResolvedValueOnce({
      transactions: [
        {
          tokenTransactionHash: previousHash,
          status: 2,
          tokenTransaction: {
            tokenOutputs: [null, { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(100) }],
          },
        },
        {
          tokenTransactionHash: new Uint8Array(32).fill(0x62),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  null,
                  { prevTokenTransactionHash: 'bad', prevTokenTransactionVout: 0 },
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 1.5 },
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: -1 },
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 1 },
                ],
              },
            },
            tokenOutputs: [
              { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(25) },
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) },
            ],
          },
        },
        {
          tokenTransactionHash: new Uint8Array(32).fill(0x63),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  {
                    prevTokenTransactionHash: new Uint8Array(32).fill(0x64),
                    prevTokenTransactionVout: 0,
                  },
                ],
              },
            },
            tokenOutputs: [
              { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(5) },
              { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(95) },
            ],
          },
          confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId: '' }] },
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

    expect(page.transactions[1]).toMatchObject({
      direction: 'out',
      amount: '25',
      counterpartyPubkeys: [`03${'08'.repeat(32)}`],
    });
    expect(page.transactions[2]).toMatchObject({
      direction: 'in',
      amount: '5',
      counterpartyPubkeys: [],
    });
    await expect(page.ownerResolution!.next()).resolves.toMatchObject({ done: true });
    expect(getTokenTransactions).toHaveBeenCalledTimes(1);
  });

  it('resolves an output owner by outpoint from an older wallet-history page', async () => {
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x68);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x69),
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              tokenOutputs: [
                { ownerPublicKey: otherKey, tokenAmount: Uint8Array.of(40) },
                { ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(60) },
              ],
            },
          },
        ],
        pageResponse: { hasPreviousPage: true, previousCursor: 'older-history' },
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [{ ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(100) }],
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
    const resolved = await page.ownerResolution?.next();

    expect(page.transactions[0]).toMatchObject({
      direction: 'in',
      amount: '60',
      counterpartyPubkeys: [],
    });
    expect(resolved?.transactions[0]).toMatchObject({
      direction: 'out',
      amount: '40',
      counterpartyPubkeys: [`03${'08'.repeat(32)}`],
    });
    expect(getTokenTransactions.mock.calls[1]?.[0]).toMatchObject({
      sparkAddresses: ['spark1address'],
      cursor: 'older-history',
      direction: 'PREVIOUS',
    });
  });

  it('rejects a non-advancing token-input lookup cursor', async () => {
    const previousHash = new Uint8Array(32).fill(0x71);
    for (const nextCursor of [undefined, '', 'same'] as const) {
      getTokenTransactions
        .mockResolvedValueOnce({
          transactions: [
            {
              tokenTransactionHash: new Uint8Array(32).fill(0x72),
              status: 2,
              tokenTransaction: {
                tokenInputs: {
                  $case: 'transferInput',
                  transferInput: {
                    outputsToSpend: [
                      { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                    ],
                  },
                },
                tokenOutputs: [],
              },
              confirmationMetadata: { spentTokenOutputsMetadata: [{ outputId: 'spent' }] },
            },
          ],
          pageResponse: null,
        })
        .mockResolvedValueOnce({
          transactions: null,
          pageResponse: { hasNextPage: true, nextCursor },
        });
      if (nextCursor === 'same') {
        getTokenTransactions.mockResolvedValueOnce({
          transactions: [],
          pageResponse: { hasNextPage: true, nextCursor },
        });
      }
      const opened = await ensureSparkViewer(undefined, undefined);
      const page = await opened.viewer.tokenTransactions({
        sparkAddress: 'spark1address',
        walletPubkey: PUBLIC_KEY,
        pageSize: 100,
      });

      if (nextCursor === 'same') await page.ownerResolution?.next();
      await expect(page.ownerResolution?.next()).rejects.toThrow(
        'token input cursor did not advance',
      );
    }
  });

  it('rejects a repeated token-input history cursor', async () => {
    const previousHash = new Uint8Array(32).fill(0x73);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x74),
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              tokenOutputs: [],
            },
          },
        ],
        pageResponse: { hasPreviousPage: true, previousCursor: 'same' },
      })
      .mockResolvedValueOnce({
        transactions: null,
        pageResponse: { hasPreviousPage: true, previousCursor: 'same' },
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const page = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    await expect(page.ownerResolution?.next()).rejects.toThrow(
      'token input history cursor did not advance',
    );
    expect(getTokenTransactions).toHaveBeenCalledTimes(2);
  });

  it('rejects a token-input history cursor cycle', async () => {
    const previousHash = new Uint8Array(32).fill(0x74);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array(32).fill(0x75),
            status: 2,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              tokenOutputs: [],
            },
          },
        ],
        pageResponse: { hasPreviousPage: true, previousCursor: 'first' },
      })
      .mockResolvedValueOnce({
        transactions: [],
        pageResponse: { hasPreviousPage: true, previousCursor: 'second' },
      })
      .mockResolvedValueOnce({
        transactions: [],
        pageResponse: { hasPreviousPage: true, previousCursor: 'first' },
      })
      .mockResolvedValueOnce({
        transactions: [],
        pageResponse: { hasPreviousPage: true, previousCursor: 'second' },
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const page = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });

    await expect(page.ownerResolution!.next()).resolves.toMatchObject({ done: false });
    await expect(page.ownerResolution!.next()).resolves.toMatchObject({ done: false });
    await expect(page.ownerResolution!.next()).rejects.toThrow(
      'token input history cursor did not advance',
    );
  });

  it('retries a failed token-input history cursor on the next page read', async () => {
    const previousHash = new Uint8Array(32).fill(0x75);
    const primaryPage = {
      transactions: [
        {
          tokenTransactionHash: new Uint8Array(32).fill(0x76),
          status: 2,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [
                  { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                ],
              },
            },
            tokenOutputs: [{ ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(75) }],
          },
        },
      ],
      pageResponse: { hasPreviousPage: true, previousCursor: 'retry-history' },
    };
    getTokenTransactions
      .mockResolvedValueOnce(primaryPage)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(primaryPage)
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [{ ownerPublicKey: PUBLIC_BYTES, tokenAmount: Uint8Array.of(100) }],
            },
          },
        ],
        pageResponse: null,
      });
    const opened = await ensureSparkViewer(undefined, undefined);
    const first = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    await expect(first.ownerResolution!.next()).rejects.toThrow('temporary');
    const retry = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark1address',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
    });
    await expect(retry.ownerResolution!.next()).resolves.toMatchObject({
      done: true,
      transactions: [expect.objectContaining({ direction: 'out' })],
    });
    expect(getTokenTransactions.mock.calls[1]?.[0]).toMatchObject({ cursor: 'retry-history' });
    expect(getTokenTransactions.mock.calls[3]?.[0]).toMatchObject({ cursor: 'retry-history' });
  });

  it('stores only allow-listed token facts and excludes revocation secrets', async () => {
    const createdTime = new Date('2025-02-03T04:05:06.000Z');
    const otherKey = new Uint8Array([3, ...Array<number>(32).fill(8)]);
    const previousHash = new Uint8Array(32).fill(0x55);
    getTokenTransactions
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: new Uint8Array([0xab, 0xcd]),
            status: 3,
            tokenTransaction: {
              tokenInputs: {
                $case: 'transferInput',
                transferInput: {
                  outputsToSpend: [
                    { prevTokenTransactionHash: previousHash, prevTokenTransactionVout: 0 },
                  ],
                },
              },
              clientCreatedTimestamp: createdTime,
              tokenOutputs: [
                {
                  ownerPublicKey: otherKey,
                  tokenIdentifier: Uint8Array.of(9),
                  tokenAmount: Uint8Array.of(1, 0),
                  seWithdrawalSignature: Uint8Array.of(4, 5),
                },
              ],
              invoiceAttachments: [null, { sparkInvoice: '' }, { sparkInvoice: 'spark1safe' }],
            },
            confirmationMetadata: {
              spentTokenOutputsMetadata: [
                { outputId: 'secret-output', revocationSecret: Uint8Array.of(1, 2, 3) },
              ],
            },
          },
        ],
        pageResponse: null,
      })
      .mockResolvedValueOnce({
        transactions: [
          {
            tokenTransactionHash: previousHash,
            status: 2,
            tokenTransaction: {
              tokenOutputs: [
                {
                  id: 'secret-output',
                  ownerPublicKey: PUBLIC_BYTES,
                  tokenAmount: Uint8Array.of(1, 0),
                },
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
    const resolved = await page.ownerResolution?.next();
    const mapped = resolved?.transactions[0];

    expect(mapped).toEqual({
      hash: 'abcd',
      tokenIdentifier: '09',
      direction: 'out',
      amount: '256',
      counterpartyPubkeys: [`03${'08'.repeat(32)}`],
      inputCount: 1,
      resolvedInputCount: 1,
      sparkInvoices: ['spark1safe'],
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
