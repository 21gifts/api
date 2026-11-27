import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import { runWalletTransferTick, type WalletTransferWorkerDeps } from '@/lib/wallet-transfer-worker';

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

import { openAesGcmEnvelope, sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import { bindKekId } from '@/lib/nostr/kek';
import {
  SPARK_VIEWER_SCHEMA_SQL,
  ensureSparkViewer,
  migrateSparkViewerSchema,
  previousWalletSparkViewer,
  rotateSparkViewerKey,
  sparkViewerRetiredKeyAad,
  type SparkViewer,
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
      'viewer_kek_id integer NOT NULL CHECK (viewer_kek_id >= 1)',
    );
    const check = SPARK_VIEWER_SCHEMA_SQL[2] ?? '';
    expect(check).toContain('PERFORM pg_advisory_xact_lock(21499021)');
    expect(check).toContain("c.def NOT LIKE '%viewer_kek_id >= 1%'");
    expect(check).toContain(
      'ADD CONSTRAINT spark_viewer_key_viewer_kek_id_check CHECK (viewer_kek_id >= 1)',
    );
    const retired = SPARK_VIEWER_SCHEMA_SQL[3] ?? '';
    expect(retired).toContain('CREATE TABLE IF NOT EXISTS spark_viewer_retired_key');
    expect(retired).toContain(
      "identity_public_key text PRIMARY KEY CHECK (identity_public_key ~ '^0[23][0-9a-f]{64}$')",
    );
    expect(retired).toContain('mnemonic_ciphertext bytea NOT NULL');
    expect(retired).toContain('kek_id integer NOT NULL CHECK (kek_id >= 1)');
    expect(retired).toContain('retired_at timestamptz NOT NULL DEFAULT now()');
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
    expect(
      flat(readFileSync(join(process.cwd(), 'docs/schema/spark_viewer_retired_key.sql'), 'utf8')),
    ).toContain(flat(retired));
  });
});

describe('rotateSparkViewerKey', () => {
  type Row = {
    viewer_identity_public_key: string;
    viewer_mnemonic_ciphertext: Uint8Array;
    viewer_kek_id: number;
  };
  type Retired = {
    identity_public_key: string;
    mnemonic_ciphertext: Uint8Array;
    kek_id: number;
  };

  const OLD_MNEMONIC =
    'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const OLD_KEY = `03${'08'.repeat(32)}`;
  const PREVIOUS = new Uint8Array(32).fill(5);
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

  async function oldEnvelope(): Promise<Uint8Array> {
    return sealAesGcmEnvelope(utf8(OLD_MNEMONIC), PREVIOUS, utf8('spark_viewer_key'), 1);
  }

  function sqlWith(
    row: Row | undefined,
    updates: unknown[][],
    retired: Retired[] = [],
    beforeUpdate: () => void = () => undefined,
  ): SqlClient {
    const tx: SqlClient = {
      query: async <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
        if (text.includes('pg_advisory_xact_lock')) {
          expect(params).toEqual([21_499_021]);
          return [];
        }
        if (text.includes('SELECT viewer_identity_public_key')) {
          return (row === undefined ? [] : [{ ...row }]) as T[];
        }
        expect(text).toContain('WHERE singleton = true AND viewer_kek_id = $4');
        beforeUpdate();
        updates.push([...params]);
        if (row === undefined || row.viewer_kek_id !== params[3]) return [];
        row.viewer_identity_public_key = String(params[0]);
        row.viewer_mnemonic_ciphertext = params[1] as Uint8Array;
        row.viewer_kek_id = Number(params[2]);
        return [{ singleton: true }] as T[];
      },
      execute: async (text: string, params: readonly unknown[] = []) => {
        expect(text).toContain('INSERT INTO spark_viewer_retired_key');
        expect(text).toContain('ON CONFLICT (identity_public_key) DO NOTHING');
        retired.push({
          identity_public_key: String(params[0]),
          mnemonic_ciphertext: params[1] as Uint8Array,
          kek_id: Number(params[2]),
        });
      },
    };
    return {
      // ensureSparkViewer reads the retired viewers outside its transaction.
      query: async <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
        expect(text).toContain('FROM spark_viewer_retired_key');
        expect(text).toContain('ORDER BY retired_at DESC');
        expect(text).toContain('retired_at FROM spark_viewer_retired_key');
        return retired
          .filter((item) => item.kek_id === params[0])
          .map((item) => ({ ...item, retired_at: '2026-11-20T00:00:00.000Z' })) as T[];
      },
      execute: async () => {},
      transaction: async (run) => run(tx),
    };
  }

  it('retires the old mnemonic and replaces the row with a fresh one under the current id', async () => {
    const current = bindKekId(new Uint8Array(32).fill(9), 2);
    const row: Row = {
      viewer_identity_public_key: OLD_KEY,
      viewer_mnemonic_ciphertext: await oldEnvelope(),
      viewer_kek_id: 1,
    };
    const updates: unknown[][] = [];
    const retired: Retired[] = [];
    expect(await rotateSparkViewerKey(sqlWith(row, updates, retired), current, PREVIOUS)).toBe(
      true,
    );
    expect(updates).toHaveLength(1);
    expect(row.viewer_kek_id).toBe(2);
    expect(row.viewer_identity_public_key).toBe(PUBLIC_KEY);
    expect(new DataView(row.viewer_mnemonic_ciphertext.buffer).getUint32(1, false)).toBe(2);
    // The old mnemonic is kept under the current key, bound to its identity key.
    expect(retired).toHaveLength(1);
    expect(retired[0]?.identity_public_key).toBe(OLD_KEY);
    expect(retired[0]?.kek_id).toBe(2);
    const opened = await openAesGcmEnvelope(
      retired[0]!.mnemonic_ciphertext,
      current,
      sparkViewerRetiredKeyAad(OLD_KEY),
    );
    expect(new TextDecoder().decode(opened)).toBe(OLD_MNEMONIC);
    // The rotated row loads with the current key, with the retired viewer behind it.
    deriveViewerIdentityPublicKey
      .mockResolvedValueOnce(PUBLIC_BYTES)
      .mockResolvedValueOnce(OLD_KEY);
    createWithViewerKey.mockClear();
    const loaded = await ensureSparkViewer(sqlWith(row, [], retired), current);
    expect(loaded.publicKey).toBe(PUBLIC_KEY);
    expect(loaded.previousWalletViewer).not.toBe(loaded.viewer);
    expect(loaded.previousWalletViewer).toHaveProperty('hasRetiredViewers', true);
    expect(createWithViewerKey).toHaveBeenCalledTimes(2);
    expect((createWithViewerKey.mock.calls as unknown as Array<[unknown, string]>)[1]?.[1]).toBe(
      OLD_MNEMONIC,
    );
    // A retired mnemonic that derives another key stops the load.
    deriveViewerIdentityPublicKey
      .mockResolvedValueOnce(PUBLIC_BYTES)
      .mockResolvedValueOnce(PUBLIC_BYTES);
    await expect(ensureSparkViewer(sqlWith(row, [], retired), current)).rejects.toThrow(
      'Retired Spark viewer key does not match its public key',
    );
    await expect(ensureSparkViewer(sqlWith(row, []), KEK)).rejects.toThrow(
      'envelope key is invalid',
    );
    // A second run changes nothing.
    expect(await rotateSparkViewerKey(sqlWith(row, updates, retired), current, PREVIOUS)).toBe(
      false,
    );
    expect(updates).toHaveLength(1);
    expect(retired).toHaveLength(1);
  });

  it('changes nothing without a row, and retires nothing for a row another boot replaced first', async () => {
    const updates: unknown[][] = [];
    expect(await rotateSparkViewerKey(sqlWith(undefined, updates), KEK, undefined)).toBe(false);
    expect(updates).toEqual([]);
    const raced: Row = {
      viewer_identity_public_key: OLD_KEY,
      viewer_mnemonic_ciphertext: await oldEnvelope(),
      viewer_kek_id: 1,
    };
    const retired: Retired[] = [];
    const racing = sqlWith(raced, updates, retired, () => {
      raced.viewer_kek_id = 3;
    });
    expect(
      await rotateSparkViewerKey(racing, bindKekId(new Uint8Array(32).fill(9), 2), PREVIOUS),
    ).toBe(false);
    expect(updates).toHaveLength(1);
    expect(raced.viewer_kek_id).toBe(3);
    expect(retired).toEqual([]);
  });

  it('needs NOSTR_NSEC_KEK_PREVIOUS that opens the old mnemonic, and writes nothing otherwise', async () => {
    const current = bindKekId(new Uint8Array(32).fill(9), 2);
    const row: Row = {
      viewer_identity_public_key: OLD_KEY,
      viewer_mnemonic_ciphertext: await oldEnvelope(),
      viewer_kek_id: 1,
    };
    const updates: unknown[][] = [];
    const retired: Retired[] = [];
    await expect(
      rotateSparkViewerKey(sqlWith(row, updates, retired), current, undefined),
    ).rejects.toThrow('NOSTR_NSEC_KEK_PREVIOUS is required to retire the Spark viewer key');
    await expect(
      rotateSparkViewerKey(sqlWith(row, updates, retired), current, new Uint8Array(32).fill(6)),
    ).rejects.toThrow();
    expect(updates).toEqual([]);
    expect(retired).toEqual([]);
    expect(row.viewer_kek_id).toBe(1);
  });

  it('needs a transaction', async () => {
    await expect(
      rotateSparkViewerKey({ query: async () => [], execute: async () => {} }, KEK, undefined),
    ).rejects.toThrow('custody');
  });
});

describe('sparkViewerRetiredKeyAad', () => {
  it('binds the retired mnemonic to its identity public key', () => {
    expect(new TextDecoder().decode(sparkViewerRetiredKeyAad(PUBLIC_KEY))).toBe(
      `spark_viewer_retired_key:${PUBLIC_KEY}`,
    );
  });
});

describe('previousWalletSparkViewer', () => {
  /** What one viewer holds for a wallet it was granted. */
  type Granted = { balance: number; transfers: number; tokens: number };

  /**
   * A viewer that behaves like the Spark SDK: a wallet that never granted it
   * (or replaced it) reads a balance of 0 and empty pages; it does not throw.
   */
  function sdkLikeViewer(
    name: string,
    granted: ReadonlyMap<string, Granted>,
    calls: string[],
  ): SparkViewer {
    const held = (address: string): Granted =>
      granted.get(address) ?? { balance: 0, transfers: 0, tokens: 0 };
    return {
      transfers: async (input) => {
        calls.push(`${name}.transfers:${input.sparkAddress}`);
        const count = Math.min(held(input.sparkAddress).transfers, input.limit);
        return { transfers: [], offset: -1, rawCount: count };
      },
      tokenTransactions: async (input) => {
        calls.push(`${name}.tokens:${input.sparkAddress}`);
        return {
          transactions: [],
          hasNextPage: false,
          nextCursor: null,
          rawCount: Math.min(held(input.sparkAddress).tokens, input.pageSize),
        };
      },
      balance: async (address) => {
        calls.push(`${name}.balance:${address}`);
        return held(address).balance;
      },
    };
  }

  const wallet = (sparkAddress: string, replacedAt?: Date) => ({
    sparkAddress,
    walletPubkey: PUBLIC_KEY,
    replacedAt,
  });

  it('always chooses the current viewer without a retired viewer', async () => {
    const calls: string[] = [];
    const current = sdkLikeViewer('current', new Map(), calls);
    const reader = previousWalletSparkViewer(current, []);
    expect(reader.hasRetiredViewers).toBe(false);
    expect(reader.newestRetiredAt).toBeUndefined();
    await expect(reader.viewerFor(wallet('spark1empty'))).resolves.toBe(current);
    // Nothing is probed: the current viewer is the only one there is.
    expect(calls).toEqual([]);
  });

  it('probes the retired viewers newest first before the current one and remembers the one with data', async () => {
    const calls: string[] = [];
    const current = sdkLikeViewer('current', new Map(), calls);
    const newer = sdkLikeViewer('newer', new Map(), calls);
    const older = sdkLikeViewer(
      'older',
      new Map([['spark1old', { balance: 0, transfers: 0, tokens: 2 }]]),
      calls,
    );
    const reader = previousWalletSparkViewer(current, [
      { viewer: newer, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
      { viewer: older, retiredAt: new Date('2026-10-01T00:00:00.000Z') },
    ]);
    expect(reader.hasRetiredViewers).toBe(true);
    // The retirement time of the newest retired viewer (the list is newest first).
    expect(reader.newestRetiredAt).toEqual(new Date('2026-11-20T00:00:00.000Z'));
    // The newer viewer answers 0 and empty pages without an error: not chosen.
    await expect(reader.viewerFor(wallet('spark1old'))).resolves.toBe(older);
    expect(calls).toEqual([
      'newer.balance:spark1old',
      'newer.transfers:spark1old',
      'newer.tokens:spark1old',
      'older.balance:spark1old',
      'older.transfers:spark1old',
      'older.tokens:spark1old',
    ]);
    calls.length = 0;
    // The chosen viewer is remembered: no probe on the next read.
    await expect(reader.viewerFor(wallet('spark1old'))).resolves.toBe(older);
    expect(calls).toEqual([]);
    // After forget, the chain is probed again.
    reader.forget('spark1old');
    await expect(reader.viewerFor(wallet('spark1old'))).resolves.toBe(older);
    expect(calls[0]).toBe('newer.balance:spark1old');
  });

  it('tries first the viewer that was current when the wallet was replaced', async () => {
    const calls: string[] = [];
    const data = (address: string) => new Map([[address, { balance: 0, transfers: 1, tokens: 0 }]]);
    const current = sdkLikeViewer('current', data('spark1late'), calls);
    const newer = sdkLikeViewer('newer', data('spark1middle'), calls);
    const older = sdkLikeViewer('older', data('spark1early'), calls);
    const reader = previousWalletSparkViewer(current, [
      { viewer: newer, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
      { viewer: older, retiredAt: new Date('2026-10-01T00:00:00.000Z') },
    ]);
    // Replaced before both retirements: the older viewer was current then.
    await expect(
      reader.viewerFor(wallet('spark1early', new Date('2026-09-01T00:00:00.000Z'))),
    ).resolves.toBe(older);
    expect(calls).toEqual(['older.balance:spark1early', 'older.transfers:spark1early']);
    calls.length = 0;
    // Replaced between the retirements: the newer viewer was current then.
    await expect(
      reader.viewerFor(wallet('spark1middle', new Date('2026-10-15T00:00:00.000Z'))),
    ).resolves.toBe(newer);
    expect(calls).toEqual(['newer.balance:spark1middle', 'newer.transfers:spark1middle']);
    calls.length = 0;
    // Replaced after the last retirement: the current viewer was current then.
    await expect(
      reader.viewerFor(wallet('spark1late', new Date('2026-11-25T00:00:00.000Z'))),
    ).resolves.toBe(current);
    expect(calls).toEqual(['current.balance:spark1late', 'current.transfers:spark1late']);
    calls.length = 0;
    // A wrong hint (here: the older viewer) falls back to the rest of the
    // chain in order: the newer retired viewer, then the current one.
    reader.forget('spark1late');
    await expect(
      reader.viewerFor(wallet('spark1late', new Date('2026-09-02T00:00:00.000Z'))),
    ).resolves.toBe(current);
    expect(calls.map((call) => call.split('.')[0])).toEqual([
      'older',
      'older',
      'older',
      'newer',
      'newer',
      'newer',
      'current',
      'current',
    ]);
  });

  it('chooses a viewer by balance alone', async () => {
    const calls: string[] = [];
    const current = sdkLikeViewer('current', new Map(), calls);
    const retired = sdkLikeViewer(
      'retired',
      new Map([['spark1rich', { balance: 21, transfers: 0, tokens: 0 }]]),
      calls,
    );
    const reader = previousWalletSparkViewer(current, [
      { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
    ]);
    await expect(reader.viewerFor(wallet('spark1rich'))).resolves.toBe(retired);
    expect(calls).toEqual(['retired.balance:spark1rich']);
  });

  it('chooses no viewer when every viewer in the chain reads 0 and empty pages', async () => {
    const calls: string[] = [];
    const current = sdkLikeViewer('current', new Map(), calls);
    const retired = sdkLikeViewer('retired', new Map(), calls);
    const reader = previousWalletSparkViewer(current, [
      { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
    ]);
    await expect(reader.viewerFor(wallet('spark1empty'))).resolves.toBeNull();
    expect(calls).toHaveLength(6);
    calls.length = 0;
    // Nothing is remembered: the next read probes again.
    await expect(reader.viewerFor(wallet('spark1empty'))).resolves.toBeNull();
    expect(calls).toHaveLength(6);
  });

  it('after a rotation, the worker reads a previous wallet through its retired viewer and never stores a 0 from the current one', async () => {
    const calls: string[] = [];
    // The current viewer was never granted by the previous wallet: 0, empty.
    const current = sdkLikeViewer('current', new Map(), calls);
    const retired = sdkLikeViewer(
      'retired',
      new Map([['spark1old', { balance: 42, transfers: 1, tokens: 0 }]]),
      calls,
    );
    const balances: Array<[string, number]> = [];
    const fullSyncs: string[] = [];
    const wallets = [
      {
        accountId: 'account',
        sparkPubkey: PUBLIC_KEY,
        sparkAddress: 'spark1old',
        previous: true,
        replacedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
      // A previous wallet no viewer has data for.
      {
        accountId: 'other',
        sparkPubkey: `03${'08'.repeat(32)}`,
        sparkAddress: 'spark1lost',
        previous: true,
      },
    ];
    const transfers: WalletTransferStore = {
      listWallets: async () => wallets,
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: null,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: async () => undefined,
      markFullSync: async (accountId) => {
        fullSyncs.push(accountId);
      },
      shopPaymentSats: async () => 0,
      hasShopPayment: async () => false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failed = await runWalletTransferTick({
        viewer: current,
        previousWalletViewer: previousWalletSparkViewer(current, [
          { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
        ]),
        transfers,
        balances: {
          recordBalance: async (row) => {
            balances.push([row.accountId, row.balanceSats]);
          },
        },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => Date.parse('2026-11-27T12:00:00.000Z'),
      });
      expect(balances).toEqual([['account', 42]]);
      expect(fullSyncs).toEqual(['account']);
      expect([...failed.keys()]).toEqual([`other\u000003${'08'.repeat(32)}`]);
      // The previous wallet's history and balance were read by the retired viewer only.
      expect(
        calls.filter((call) => call.startsWith('current.') && call.endsWith('spark1old')),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('probes the current viewer first for a current wallet and switches to it once the app granted it', async () => {
    const calls: string[] = [];
    const grants = new Map<string, { balance: number; transfers: number; tokens: number }>();
    const current = sdkLikeViewer('current', grants, calls);
    const retired = sdkLikeViewer(
      'retired',
      new Map([
        ['spark1member', { balance: 42, transfers: 0, tokens: 0 }],
        ['spark1granted', { balance: 5, transfers: 0, tokens: 0 }],
      ]),
      calls,
    );
    grants.set('spark1granted', { balance: 5, transfers: 0, tokens: 0 });
    const reader = previousWalletSparkViewer(current, [
      { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
    ]);
    const member = { ...wallet('spark1member'), current: true };
    // Not granted yet: the current viewer reads 0 and empty pages, the retired one has data.
    await expect(reader.viewerFor(member)).resolves.toBe(retired);
    expect(calls).toEqual([
      'current.balance:spark1member',
      'current.transfers:spark1member',
      'current.tokens:spark1member',
      'retired.balance:spark1member',
    ]);
    calls.length = 0;
    // Remembered retired viewer: the current viewer is probed again first.
    await expect(reader.viewerFor(member)).resolves.toBe(retired);
    expect(calls).toEqual([
      'current.balance:spark1member',
      'current.transfers:spark1member',
      'current.tokens:spark1member',
    ]);
    calls.length = 0;
    // The app granted the new viewer: the reader switches and stops probing.
    grants.set('spark1member', { balance: 42, transfers: 0, tokens: 0 });
    await expect(reader.viewerFor(member)).resolves.toBe(current);
    expect(calls).toEqual(['current.balance:spark1member']);
    calls.length = 0;
    await expect(reader.viewerFor(member)).resolves.toBe(current);
    expect(calls).toEqual([]);
    // A current wallet that already granted the new viewer never probes a retired one.
    await expect(reader.viewerFor({ ...wallet('spark1granted'), current: true })).resolves.toBe(
      current,
    );
    expect(calls).toEqual(['current.balance:spark1granted']);
  });

  it('keeps the remembered retired viewer of a current wallet when the current probe fails', async () => {
    const calls: string[] = [];
    let failing = false;
    const empty = sdkLikeViewer('current', new Map(), calls);
    const current: SparkViewer = {
      ...empty,
      balance: async (address) => {
        if (failing) throw new Error('Spark viewer unavailable');
        return empty.balance(address);
      },
    };
    const retired = sdkLikeViewer(
      'retired',
      new Map([['spark1member', { balance: 0, transfers: 1, tokens: 0 }]]),
      calls,
    );
    const reader = previousWalletSparkViewer(current, [
      { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
    ]);
    const member = { ...wallet('spark1member'), current: true };
    await expect(reader.viewerFor(member)).resolves.toBe(retired);
    failing = true;
    await expect(reader.viewerFor(member)).resolves.toBe(retired);
  });

  it('after a rotation, the worker reads a current wallet through its retired viewer until the app grants the new one', async () => {
    const calls: string[] = [];
    const current = sdkLikeViewer('current', new Map(), calls);
    const retired = sdkLikeViewer(
      'retired',
      new Map([['spark1member', { balance: 42, transfers: 1, tokens: 0 }]]),
      calls,
    );
    const balances: Array<[string, number]> = [];
    const fullSyncs: string[] = [];
    const wallets = [
      { accountId: 'account', sparkPubkey: PUBLIC_KEY, sparkAddress: 'spark1member' },
      // A current wallet no viewer has data for: nothing is written.
      { accountId: 'other', sparkPubkey: `03${'08'.repeat(32)}`, sparkAddress: 'spark1empty' },
    ];
    const transfers: WalletTransferStore = {
      listWallets: async () => wallets,
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: null,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: async () => undefined,
      markFullSync: async (accountId) => {
        fullSyncs.push(accountId);
      },
      shopPaymentSats: async () => 0,
      hasShopPayment: async () => false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failed = await runWalletTransferTick({
        viewer: current,
        previousWalletViewer: previousWalletSparkViewer(current, [
          { viewer: retired, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
        ]),
        transfers,
        balances: {
          recordBalance: async (row) => {
            balances.push([row.accountId, row.balanceSats]);
          },
        },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => Date.parse('2026-11-27T12:00:00.000Z'),
      });
      expect(balances).toEqual([['account', 42]]);
      expect(fullSyncs).toEqual(['account']);
      expect([...failed.keys()]).toEqual([`other\u000003${'08'.repeat(32)}`]);
      // The current viewer was probed first for both wallets.
      expect(calls[0]).toBe('current.balance:spark1member');
      expect(calls).toContain('current.balance:spark1empty');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a viewer whose SDK call throws, and rethrows the first error when none had data', async () => {
    const calls: string[] = [];
    const failing: SparkViewer = {
      ...sdkLikeViewer('failing', new Map(), calls),
      balance: async () => {
        throw new Error('Spark viewer unavailable');
      },
    };
    const current = sdkLikeViewer('current', new Map(), calls);
    const granted = sdkLikeViewer(
      'granted',
      new Map([['spark1old', { balance: 0, transfers: 1, tokens: 0 }]]),
      calls,
    );
    const reader = previousWalletSparkViewer(current, [
      { viewer: failing, retiredAt: new Date('2026-11-20T00:00:00.000Z') },
      { viewer: granted, retiredAt: new Date('2026-10-01T00:00:00.000Z') },
    ]);
    await expect(reader.viewerFor(wallet('spark1old'))).resolves.toBe(granted);
    // No viewer has data for this wallet: the failure is reported, not hidden as "empty".
    await expect(reader.viewerFor(wallet('spark1other'))).rejects.toThrow(
      'Spark viewer unavailable',
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
    // Without a retired viewer, previous wallets read through the current viewer.
    expect(loaded.previousWalletViewer).toBe(loaded.viewer);

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
      shopPaymentSats: async () => 0,
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

  it('replaces a waiting lookup when the same cursor returns a different page', async () => {
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
    let waitingPageCalls = 0;
    getTokenTransactions.mockImplementation(async (input) => {
      const request = input as {
        sparkAddresses?: string[];
        outputIds?: string[];
      };
      const address = request.sparkAddresses?.[0];
      if (address === 'spark-waiting') {
        waitingPageCalls += 1;
        return unresolvedPage(waitingPageCalls === 1 ? 201 : 202);
      }
      if (address !== undefined) {
        const suffix = Number(address.slice('spark-active-'.length));
        return unresolvedPage(suffix + 1);
      }
      const outputId = request.outputIds?.[0] ?? '';
      if (outputId === 'output-1') throw new Error('release active resolution');
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
    const firstActive = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-active-0',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
      cursor: 'same',
    });
    for (let index = 1; index < 128; index += 1) {
      await opened.viewer.tokenTransactions({
        sparkAddress: `spark-active-${String(index)}`,
        walletPubkey: PUBLIC_KEY,
        pageSize: 100,
        cursor: 'same',
      });
    }
    const firstWaiting = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-waiting',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
      cursor: 'same',
    });
    expect(firstWaiting.ownerResolution).toBeUndefined();

    await expect(firstActive.ownerResolution!.next()).rejects.toThrow('release active resolution');
    const changedPage = await opened.viewer.tokenTransactions({
      sparkAddress: 'spark-waiting',
      walletPubkey: PUBLIC_KEY,
      pageSize: 100,
      cursor: 'same',
    });

    expect(changedPage.ownerResolution).toBeDefined();
    await expect(changedPage.ownerResolution!.next()).resolves.toMatchObject({ done: true });
    expect(getTokenTransactions.mock.calls.at(-1)?.[0]).toMatchObject({
      outputIds: ['output-202'],
      direction: 'NEXT',
    });
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
