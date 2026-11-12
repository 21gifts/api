import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';

const sdk = vi.hoisted(() => {
  const publicBytes = new Uint8Array([2, ...Array<number>(32).fill(7)]);
  const getTransfers = vi.fn();
  const getOwnedBalance = vi.fn();
  return {
    publicBytes,
    getTransfers,
    getOwnedBalance,
    createWithViewerKey: vi.fn(async () => ({ getTransfers, getOwnedBalance })),
    deriveViewerIdentityPublicKey: vi.fn<() => Promise<unknown>>(async () => publicBytes),
  };
});
const {
  publicBytes: PUBLIC_BYTES,
  getTransfers,
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
    ).resolves.toMatchObject({ offset: -1, transfers: [{ id: 'transfer', totalValue: 21 }] });
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
    });
    await expect(
      opened.viewer.transfers({ sparkAddress: 'spark1address', limit: 100, offset: 0 }),
    ).resolves.toEqual({ transfers: [], offset: 0 });
    await expect(opened.viewer.balance('spark1address')).resolves.toBe(0);
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
