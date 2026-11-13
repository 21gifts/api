/** Read-only Spark viewer key custody and SDK adapter. */

import { SparkReadonlyClient, deriveViewerIdentityPublicKey } from '@buildonspark/spark-sdk';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import type { SqlClient } from '@/lib/auth/sql';
import { NOSTR_ENVELOPE_VERSION, NOSTR_KEK_ID_V1, zeroizeSecret } from '@/lib/nostr/keys';
import { bytesToHex } from '@/lib/nostr/kek';

/** Spark mainnet configuration shared by derivation and read-only clients. */
const SPARK_MAINNET = { network: 'MAINNET' } as const;

/** AAD that binds the deployment viewer mnemonic to its one-row table. */
const VIEWER_AAD = new TextEncoder().encode('spark_viewer_key');

/** Fixed advisory-lock namespace for the single deployment viewer key. */
const SPARK_VIEWER_KEY_LOCK = 21_499_021;

/** One transfer returned by the SDK adapter. */
export interface SparkViewerTransfer {
  id: string;
  senderIdentityPublicKey: Uint8Array;
  receiverIdentityPublicKey: Uint8Array;
  status: number;
  totalValue: number;
  createdTime: Date | undefined;
  updatedTime: Date | undefined;
  type: number;
  sparkInvoice: string;
  senders: Array<{ id: string; identityPublicKey: Uint8Array }>;
  receivers: Array<{
    id: string;
    identityPublicKey: Uint8Array;
    amountSats: number;
    status: number;
  }>;
  leaves: Array<{ value: number; senderId: string; receiverId: string }>;
}

/** One complete token transaction returned by the SDK adapter. */
export interface SparkViewerTokenTransaction {
  hash: string;
  status: number;
  createdTime: Date | undefined;
  payload: Record<string, unknown>;
}

/** Read-only operator access used by the wallet transfer worker. */
export interface SparkViewer {
  transfers(input: {
    sparkAddress: string;
    limit: number;
    offset: number;
    createdAfter?: Date;
  }): Promise<{ transfers: SparkViewerTransfer[]; offset: number; rawCount: number }>;
  tokenTransactions(input: { sparkAddress: string; pageSize: number; cursor?: string }): Promise<{
    transactions: SparkViewerTokenTransaction[];
    hasNextPage: boolean;
    nextCursor: string | null;
    rawCount: number;
  }>;
  balance(sparkAddress: string): Promise<number>;
}

/** Viewer material retained only in process memory. */
export interface SparkViewerKey {
  publicKey: string;
  viewer: SparkViewer;
}

/** Idempotent DDL for the one encrypted deployment viewer key. */
export const SPARK_VIEWER_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS spark_viewer_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  viewer_identity_public_key text NOT NULL UNIQUE
    CHECK (viewer_identity_public_key ~ '^0[23][0-9a-f]{64}$'),
  viewer_mnemonic_ciphertext bytea NOT NULL,
  viewer_kek_id integer NOT NULL CHECK (viewer_kek_id = 1),
  created_at timestamptz NOT NULL
)`,
  `DO $spark_viewer_columns$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'nostr_nsec_ciphertext'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'viewer_mnemonic_ciphertext'
  ) THEN
    ALTER TABLE spark_viewer_key RENAME COLUMN nostr_nsec_ciphertext TO viewer_mnemonic_ciphertext;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'nostr_kek_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spark_viewer_key'
      AND column_name = 'viewer_kek_id'
  ) THEN
    ALTER TABLE spark_viewer_key RENAME COLUMN nostr_kek_id TO viewer_kek_id;
  END IF;
END;
$spark_viewer_columns$`,
];

/**
 * Apply the Spark viewer-key table DDL before `migrateDbChangeSchema`.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves after every statement succeeds.
 */
export async function migrateSparkViewerSchema(sql: SqlClient): Promise<void> {
  for (const statement of SPARK_VIEWER_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

interface ViewerKeyRow {
  viewer_identity_public_key: string;
  viewer_mnemonic_ciphertext: Uint8Array;
  viewer_kek_id: number;
}

type SdkTransferPage = {
  transfers?: unknown;
  offset?: unknown;
};

type SdkTokenPage = {
  transactions?: unknown;
  pageResponse?: unknown;
};

const ALL_TRANSFER_TYPES = [0, 1, 2, 3, 4, 5, 30, 40] as const;

type SdkViewer = {
  getTransfers(input: {
    sparkAddress: string;
    limit: number;
    offset: number;
    types: readonly number[];
    createdAfter?: Date;
  }): Promise<SdkTransferPage>;
  getTokenTransactions(input: {
    sparkAddresses: string[];
    pageSize: number;
    cursor?: string;
    direction: 'NEXT';
  }): Promise<SdkTokenPage>;
  getOwnedBalance(sparkAddress: string): Promise<unknown>;
};

function participantOf(value: unknown): { id: string; identityPublicKey: Uint8Array } | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string' && row['identityPublicKey'] instanceof Uint8Array
    ? { id: row['id'], identityPublicKey: new Uint8Array(row['identityPublicKey']) }
    : null;
}

function receiverOf(value: unknown): SparkViewerTransfer['receivers'][number] | null {
  const participant = participantOf(value);
  const row = value as Record<string, unknown>;
  return participant !== null &&
    typeof row['amountSats'] === 'number' &&
    typeof row['status'] === 'number'
    ? { ...participant, amountSats: row['amountSats'], status: row['status'] }
    : null;
}

function leafOf(value: unknown): SparkViewerTransfer['leaves'][number] | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const leaf = row['leaf'];
  if (
    typeof leaf !== 'object' ||
    leaf === null ||
    typeof (leaf as Record<string, unknown>)['value'] !== 'number' ||
    typeof row['transferSenderId'] !== 'string' ||
    typeof row['transferReceiverId'] !== 'string'
  ) {
    return null;
  }
  return {
    value: (leaf as Record<string, unknown>)['value'] as number,
    senderId: row['transferSenderId'],
    receiverId: row['transferReceiverId'],
  };
}

function transferOf(value: unknown): SparkViewerTransfer | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['status'] !== 'number' ||
    typeof row['totalValue'] !== 'number' ||
    typeof row['type'] !== 'number'
  ) {
    return null;
  }
  const createdTime = row['createdTime'];
  const updatedTime = row['updatedTime'];
  return {
    id: row['id'],
    senderIdentityPublicKey:
      row['senderIdentityPublicKey'] instanceof Uint8Array
        ? new Uint8Array(row['senderIdentityPublicKey'])
        : new Uint8Array(),
    receiverIdentityPublicKey:
      row['receiverIdentityPublicKey'] instanceof Uint8Array
        ? new Uint8Array(row['receiverIdentityPublicKey'])
        : new Uint8Array(),
    status: row['status'],
    totalValue: row['totalValue'],
    createdTime: createdTime instanceof Date ? new Date(createdTime.getTime()) : undefined,
    updatedTime: updatedTime instanceof Date ? new Date(updatedTime.getTime()) : undefined,
    type: row['type'],
    sparkInvoice: typeof row['sparkInvoice'] === 'string' ? row['sparkInvoice'] : '',
    senders: Array.isArray(row['senders'])
      ? row['senders']
          .map(participantOf)
          .filter(
            (sender): sender is { id: string; identityPublicKey: Uint8Array } => sender !== null,
          )
      : [],
    receivers: Array.isArray(row['receivers'])
      ? row['receivers']
          .map(receiverOf)
          .filter(
            (receiver): receiver is SparkViewerTransfer['receivers'][number] => receiver !== null,
          )
      : [],
    leaves: Array.isArray(row['leaves'])
      ? row['leaves']
          .map(leafOf)
          .filter((leaf): leaf is SparkViewerTransfer['leaves'][number] => leaf !== null)
      : [],
  };
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  }
  return value;
}

function tokenTransactionOf(value: unknown): SparkViewerTokenTransaction | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!(row['tokenTransactionHash'] instanceof Uint8Array) || typeof row['status'] !== 'number') {
    return null;
  }
  const transaction = row['tokenTransaction'];
  const payload = jsonValue(row);
  const createdTime =
    typeof transaction === 'object' && transaction !== null
      ? (transaction as Record<string, unknown>)['clientCreatedTimestamp']
      : undefined;
  return {
    hash: bytesToHex(row['tokenTransactionHash']),
    status: row['status'],
    createdTime: createdTime instanceof Date ? new Date(createdTime.getTime()) : undefined,
    payload: payload as Record<string, unknown>,
  };
}

function balanceSats(value: unknown): number {
  const raw =
    typeof value === 'object' && value !== null && 'balance' in value
      ? (value as { balance: unknown }).balance
      : value;
  const amount = typeof raw === 'bigint' ? Number(raw) : raw;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Spark viewer returned an invalid balance');
  }
  return amount;
}

async function viewerFromMnemonic(mnemonic: string): Promise<SparkViewer> {
  const sdk = (await SparkReadonlyClient.createWithViewerKey(
    SPARK_MAINNET,
    mnemonic,
  )) as unknown as SdkViewer;
  return {
    async transfers(input) {
      const page = await sdk.getTransfers({ ...input, types: ALL_TRANSFER_TYPES });
      const rawCount = Array.isArray(page.transfers) ? page.transfers.length : 0;
      const transfers = Array.isArray(page.transfers)
        ? page.transfers.map(transferOf).filter((row): row is SparkViewerTransfer => row !== null)
        : [];
      return { transfers, offset: typeof page.offset === 'number' ? page.offset : -1, rawCount };
    },
    async tokenTransactions(input) {
      const page = await sdk.getTokenTransactions({
        sparkAddresses: [input.sparkAddress],
        pageSize: input.pageSize,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        direction: 'NEXT',
      });
      const rawCount = Array.isArray(page.transactions) ? page.transactions.length : 0;
      const transactions = Array.isArray(page.transactions)
        ? page.transactions
            .map(tokenTransactionOf)
            .filter((row): row is SparkViewerTokenTransaction => row !== null)
        : [];
      const response =
        typeof page.pageResponse === 'object' && page.pageResponse !== null
          ? (page.pageResponse as Record<string, unknown>)
          : {};
      return {
        transactions,
        hasNextPage: response['hasNextPage'] === true,
        nextCursor:
          typeof response['nextCursor'] === 'string' && response['nextCursor'] !== ''
            ? response['nextCursor']
            : null,
        rawCount,
      };
    },
    async balance(sparkAddress) {
      return balanceSats(await sdk.getOwnedBalance(sparkAddress));
    },
  };
}

async function publicKeyFromMnemonic(mnemonic: string): Promise<string> {
  const derived = (await deriveViewerIdentityPublicKey(SPARK_MAINNET, mnemonic)) as unknown;
  const publicKey =
    typeof derived === 'string'
      ? derived.toLowerCase()
      : derived instanceof Uint8Array
        ? bytesToHex(derived)
        : '';
  if (!/^0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Spark viewer returned an invalid identity public key');
  }
  return publicKey;
}

async function openEnvelope(envelope: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  if (envelope.length < 33 || envelope[0] !== NOSTR_ENVELOPE_VERSION) {
    throw new Error('Spark viewer envelope is invalid');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  if (view.getUint32(1, false) !== NOSTR_KEK_ID_V1 || kek.length !== 32) {
    throw new Error('Spark viewer envelope key is invalid');
  }
  const nonce = envelope.subarray(5, 17);
  const ciphertext = envelope.subarray(17);
  const key = await crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: VIEWER_AAD },
      key,
      ciphertext,
    ),
  );
}

/**
 * Load or create the deployment viewer key, or create an ephemeral memory key.
 *
 * The durable path holds a transaction advisory lock across the absent-row
 * check and insert. The mnemonic is encrypted before insertion and is never
 * returned. The caller receives only its public key and a read-only adapter.
 *
 * @param sql - SQL client for durable custody, or undefined for an ephemeral key.
 * @param kek - `NOSTR_NSEC_KEK` bytes for durable custody.
 * @returns The public identity and read-only viewer adapter.
 * @throws When key generation, encryption, decryption, derivation, or SDK creation fails.
 */
export async function ensureSparkViewer(
  sql: SqlClient | undefined,
  kek: Uint8Array | undefined,
): Promise<SparkViewerKey> {
  if (sql === undefined) {
    const mnemonic = generateMnemonic(wordlist, 128);
    return {
      publicKey: await publicKeyFromMnemonic(mnemonic),
      viewer: await viewerFromMnemonic(mnemonic),
    };
  }
  if (kek === undefined || sql.transaction === undefined) {
    throw new Error('Spark viewer key custody is unavailable');
  }
  const material = await sql.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SPARK_VIEWER_KEY_LOCK]);
    let row = (
      await tx.query<ViewerKeyRow>(
        `SELECT viewer_identity_public_key, viewer_mnemonic_ciphertext, viewer_kek_id
         FROM spark_viewer_key WHERE singleton = true`,
      )
    )[0];
    if (row === undefined) {
      const mnemonic = generateMnemonic(wordlist, 128);
      const plain = new TextEncoder().encode(mnemonic);
      try {
        const publicKey = await publicKeyFromMnemonic(mnemonic);
        const ciphertext = await sealAesGcmEnvelope(plain, kek, VIEWER_AAD, NOSTR_KEK_ID_V1);
        await tx.execute(
          `INSERT INTO spark_viewer_key
             (singleton, viewer_identity_public_key, viewer_mnemonic_ciphertext, viewer_kek_id, created_at)
           VALUES (true, $1, $2, $3, now())`,
          [publicKey, ciphertext, NOSTR_KEK_ID_V1],
        );
        row = {
          viewer_identity_public_key: publicKey,
          viewer_mnemonic_ciphertext: ciphertext,
          viewer_kek_id: NOSTR_KEK_ID_V1,
        };
      } finally {
        zeroizeSecret(plain);
      }
    }
    return row;
  });
  const plain = await openEnvelope(new Uint8Array(material.viewer_mnemonic_ciphertext), kek);
  try {
    const mnemonic = new TextDecoder().decode(plain);
    const publicKey = await publicKeyFromMnemonic(mnemonic);
    if (
      publicKey !== material.viewer_identity_public_key ||
      material.viewer_kek_id !== NOSTR_KEK_ID_V1
    ) {
      throw new Error('Spark viewer key does not match its public key');
    }
    return { publicKey, viewer: await viewerFromMnemonic(mnemonic) };
  } finally {
    zeroizeSecret(plain);
  }
}
