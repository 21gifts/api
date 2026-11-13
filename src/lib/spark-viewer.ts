/** Read-only Spark viewer key custody and SDK adapter. */

import {
  SparkReadonlyClient,
  deriveViewerIdentityPublicKey,
  type QueryTokenTransactionsParams,
} from '@buildonspark/spark-sdk';
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

/** Allow-listed non-secret facts from one token transaction. */
export interface SparkViewerTokenTransaction {
  hash: string;
  tokenIdentifier: string | null;
  direction: 'in' | 'out';
  amount: string;
  counterpartyPubkeys: string[];
  sparkInvoices: string[];
  type: 'create' | 'mint' | 'transfer' | 'unknown';
  status: number;
  createdTime: Date | undefined;
  expiryTime: Date | undefined;
}

/** One best-effort page of token-input owner enrichment. */
export interface SparkViewerTokenOwnerPage {
  transactions: SparkViewerTokenTransaction[];
  done: boolean;
}

/** Stateful, process-local token-input owner lookup for one history page. */
export interface SparkViewerTokenOwnerResolution {
  next(): Promise<SparkViewerTokenOwnerPage>;
}

/** Read-only operator access used by the wallet transfer worker. */
export interface SparkViewer {
  transfers(input: {
    sparkAddress: string;
    limit: number;
    offset: number;
    createdAfter?: Date;
  }): Promise<{ transfers: SparkViewerTransfer[]; offset: number; rawCount: number }>;
  tokenTransactions(input: {
    sparkAddress: string;
    walletPubkey: string;
    pageSize: number;
    cursor?: string;
  }): Promise<{
    transactions: SparkViewerTokenTransaction[];
    hasNextPage: boolean;
    nextCursor: string | null;
    rawCount: number;
    ownerResolution?: SparkViewerTokenOwnerResolution;
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
  getTokenTransactions(input: QueryTokenTransactionsParams): Promise<SdkTokenPage>;
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

function uint128Decimal(value: unknown): bigint | null {
  if (!(value instanceof Uint8Array) || value.length > 16) return null;
  let amount = 0n;
  for (const byte of value) amount = (amount << 8n) | BigInt(byte);
  return amount;
}

function compressedPublicKey(value: unknown): string | null {
  if (!(value instanceof Uint8Array)) return null;
  const key = bytesToHex(value);
  return /^0[23][0-9a-f]{64}$/.test(key) ? key : null;
}

function transactionHashOf(row: Record<string, unknown>): string | null {
  const hash = row['tokenTransactionHash'];
  return hash instanceof Uint8Array ? bytesToHex(hash) : null;
}

function tokenOutputOwners(values: readonly unknown[]): Array<{
  vout: number;
  id: string | null;
  owner: string;
  amount: bigint;
  tokenIdentifier: string | null;
}> {
  return values.flatMap((output, vout) => {
    if (typeof output !== 'object' || output === null) return [];
    const candidate = output as Record<string, unknown>;
    const owner = compressedPublicKey(candidate['ownerPublicKey']);
    const amount = uint128Decimal(candidate['tokenAmount']);
    if (owner === null || amount === null) return [];
    return [
      {
        vout,
        id: typeof candidate['id'] === 'string' && candidate['id'] !== '' ? candidate['id'] : null,
        owner,
        amount,
        tokenIdentifier:
          candidate['tokenIdentifier'] instanceof Uint8Array
            ? bytesToHex(candidate['tokenIdentifier'])
            : null,
      },
    ];
  });
}

function inputReferences(value: unknown): Array<{ outpoint: string; outputId: string | null }> {
  if (typeof value !== 'object' || value === null) return [];
  const row = value as Record<string, unknown>;
  const transaction = row['tokenTransaction'];
  if (typeof transaction !== 'object' || transaction === null) return [];
  const tokenInputs = (transaction as Record<string, unknown>)['tokenInputs'];
  if (typeof tokenInputs !== 'object' || tokenInputs === null) return [];
  const input = tokenInputs as Record<string, unknown>;
  if (input['$case'] !== 'transferInput') return [];
  const transferInput = input['transferInput'];
  const outputsToSpend =
    typeof transferInput === 'object' && transferInput !== null
      ? (transferInput as Record<string, unknown>)['outputsToSpend']
      : null;
  const metadata = row['confirmationMetadata'];
  const spentMetadata =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)['spentTokenOutputsMetadata']
      : null;
  if (!Array.isArray(outputsToSpend)) return [];
  return outputsToSpend.flatMap((reference, index) => {
    if (typeof reference !== 'object' || reference === null) return [];
    const ref = reference as Record<string, unknown>;
    const previousHash = ref['prevTokenTransactionHash'];
    const previousVout = ref['prevTokenTransactionVout'];
    if (
      !(previousHash instanceof Uint8Array) ||
      !Number.isSafeInteger(previousVout) ||
      (previousVout as number) < 0
    ) {
      return [];
    }
    const spent = Array.isArray(spentMetadata) ? spentMetadata[index] : undefined;
    const spentOutputId =
      typeof spent === 'object' && spent !== null
        ? (spent as Record<string, unknown>)['outputId']
        : null;
    const outputId =
      typeof spentOutputId === 'string' && spentOutputId !== '' ? spentOutputId : null;
    return [
      {
        outpoint: `${bytesToHex(previousHash)}:${String(previousVout)}`,
        outputId,
      },
    ];
  });
}

function inputOwnerIndexes(values: readonly unknown[]): {
  byOutpoint: Map<string, string>;
  byOutputId: Map<string, string>;
} {
  const byOutpoint = new Map<string, string>();
  const byOutputId = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    const hash = transactionHashOf(row);
    const transaction = row['tokenTransaction'];
    if (hash === null || typeof transaction !== 'object' || transaction === null) continue;
    const rawOutputs = (transaction as Record<string, unknown>)['tokenOutputs'];
    const outputs = tokenOutputOwners(Array.isArray(rawOutputs) ? rawOutputs : []);
    outputs.forEach((output) => {
      byOutpoint.set(`${hash}:${String(output.vout)}`, output.owner);
      if (output.id !== null) byOutputId.set(output.id, output.owner);
    });
  }
  return { byOutpoint, byOutputId };
}

function mergeInputOwnerIndexes(
  target: { byOutpoint: Map<string, string>; byOutputId: Map<string, string> },
  source: { byOutpoint: ReadonlyMap<string, string>; byOutputId: ReadonlyMap<string, string> },
): void {
  for (const [outpoint, owner] of source.byOutpoint) target.byOutpoint.set(outpoint, owner);
  for (const [outputId, owner] of source.byOutputId) target.byOutputId.set(outputId, owner);
}

function unresolvedInputReferences(
  transactions: readonly unknown[],
  owners: { byOutpoint: ReadonlyMap<string, string>; byOutputId: ReadonlyMap<string, string> },
): Array<{ outpoint: string; outputId: string | null }> {
  return transactions.flatMap((transaction) =>
    inputReferences(transaction).filter(
      (reference) =>
        !owners.byOutpoint.has(reference.outpoint) &&
        (reference.outputId === null || !owners.byOutputId.has(reference.outputId)),
    ),
  );
}

function tokenTransactionOf(
  value: unknown,
  walletPubkey: string,
  inputOwners: readonly string[],
): SparkViewerTokenTransaction | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!(row['tokenTransactionHash'] instanceof Uint8Array) || typeof row['status'] !== 'number') {
    return null;
  }
  const transaction = row['tokenTransaction'];
  if (typeof transaction !== 'object' || transaction === null) return null;
  const tx = transaction as Record<string, unknown>;
  const tokenInputs =
    typeof tx['tokenInputs'] === 'object' && tx['tokenInputs'] !== null
      ? (tx['tokenInputs'] as Record<string, unknown>)
      : {};
  const inputCase = tokenInputs['$case'];
  const type =
    inputCase === 'createInput'
      ? 'create'
      : inputCase === 'mintInput'
        ? 'mint'
        : inputCase === 'transferInput'
          ? 'transfer'
          : 'unknown';
  const outputs = tokenOutputOwners(Array.isArray(tx['tokenOutputs']) ? tx['tokenOutputs'] : []);
  const externalOutputs = outputs.filter((output) => output.owner !== walletPubkey);
  const ownOutputs = outputs.filter((output) => output.owner === walletPubkey);
  const direction = type === 'transfer' && inputOwners.includes(walletPubkey) ? 'out' : 'in';
  const attributedOutputs = direction === 'out' ? externalOutputs : ownOutputs;
  const amount = attributedOutputs.reduce((sum, output) => sum + output.amount, 0n);
  const mintInput =
    inputCase === 'mintInput' && typeof tokenInputs['mintInput'] === 'object'
      ? (tokenInputs['mintInput'] as Record<string, unknown>)
      : {};
  const createInput =
    inputCase === 'createInput' && typeof tokenInputs['createInput'] === 'object'
      ? (tokenInputs['createInput'] as Record<string, unknown>)
      : {};
  const issuerPublicKey = compressedPublicKey(
    inputCase === 'mintInput' ? mintInput['issuerPublicKey'] : createInput['issuerPublicKey'],
  );
  const tokenIdentifier =
    outputs.find((output) => output.tokenIdentifier !== null)?.tokenIdentifier ??
    (mintInput['tokenIdentifier'] instanceof Uint8Array
      ? bytesToHex(mintInput['tokenIdentifier'])
      : null);
  const createdTime = tx['clientCreatedTimestamp'];
  const expiryTime = tx['expiryTime'];
  const sparkInvoices = Array.isArray(tx['invoiceAttachments'])
    ? tx['invoiceAttachments'].flatMap((attachment) => {
        if (typeof attachment !== 'object' || attachment === null) return [];
        const invoice = (attachment as Record<string, unknown>)['sparkInvoice'];
        return typeof invoice === 'string' && invoice !== '' ? [invoice] : [];
      })
    : [];
  const counterpartyPubkeys =
    type === 'create' || type === 'mint'
      ? issuerPublicKey === null
        ? []
        : [issuerPublicKey]
      : direction === 'out'
        ? externalOutputs.map((output) => output.owner)
        : inputOwners;
  return {
    hash: bytesToHex(row['tokenTransactionHash']),
    tokenIdentifier,
    direction,
    amount: amount.toString(),
    counterpartyPubkeys: [...new Set(counterpartyPubkeys)].sort(),
    sparkInvoices,
    type,
    status: row['status'],
    createdTime: createdTime instanceof Date ? new Date(createdTime.getTime()) : undefined,
    expiryTime: expiryTime instanceof Date ? new Date(expiryTime.getTime()) : undefined,
  };
}

function tokenTransactionsOf(
  transactions: readonly unknown[],
  walletPubkey: string,
  owners: { byOutpoint: ReadonlyMap<string, string>; byOutputId: ReadonlyMap<string, string> },
): SparkViewerTokenTransaction[] {
  return transactions
    .map((transaction) => {
      const inputOwners = inputReferences(transaction).flatMap((reference) => {
        const owner =
          owners.byOutpoint.get(reference.outpoint) ??
          (reference.outputId === null ? undefined : owners.byOutputId.get(reference.outputId));
        return owner === undefined ? [] : [owner];
      });
      return tokenTransactionOf(transaction, walletPubkey, inputOwners);
    })
    .filter((row): row is SparkViewerTokenTransaction => row !== null);
}

interface CachedTokenOwnerResolution extends SparkViewerTokenOwnerResolution {
  current(): SparkViewerTokenTransaction[];
  update(transactions: readonly unknown[]): void;
}

function tokenOwnerResolution(
  sdk: SdkViewer,
  input: { sparkAddress: string; walletPubkey: string; pageSize: number },
  transactions: readonly unknown[],
  owners: ReturnType<typeof inputOwnerIndexes>,
  historyCursor: string | null,
): CachedTokenOwnerResolution {
  let currentTransactions = transactions;
  const unresolvedOutputIds = [
    ...new Set(
      unresolvedInputReferences(currentTransactions, owners).flatMap((reference) =>
        reference.outputId === null ? [] : [reference.outputId],
      ),
    ),
  ];
  let lookupCursor: string | undefined;
  let outputLookupDone = unresolvedOutputIds.length === 0;
  const seenLookupCursors = new Set<string>();
  const seenHistoryCursors = new Set<string>();
  let inFlight: Promise<SparkViewerTokenOwnerPage> | undefined;

  const current = (): SparkViewerTokenTransaction[] =>
    tokenTransactionsOf(currentTransactions, input.walletPubkey, owners);
  const done = (): boolean =>
    unresolvedInputReferences(currentTransactions, owners).length === 0 ||
    (outputLookupDone && historyCursor === null);

  const advance = async (): Promise<SparkViewerTokenOwnerPage> => {
    if (done()) return { transactions: current(), done: true };
    if (!outputLookupDone) {
      const lookup = await sdk.getTokenTransactions({
        outputIds: unresolvedOutputIds,
        pageSize: input.pageSize,
        ...(lookupCursor === undefined ? {} : { cursor: lookupCursor }),
        direction: 'NEXT',
      });
      mergeInputOwnerIndexes(
        owners,
        inputOwnerIndexes(Array.isArray(lookup.transactions) ? lookup.transactions : []),
      );
      const lookupResponse =
        typeof lookup.pageResponse === 'object' && lookup.pageResponse !== null
          ? (lookup.pageResponse as Record<string, unknown>)
          : {};
      if (lookupResponse['hasNextPage'] === true) {
        const nextCursor = lookupResponse['nextCursor'];
        if (
          typeof nextCursor !== 'string' ||
          nextCursor === '' ||
          seenLookupCursors.has(nextCursor)
        ) {
          throw new Error('Spark viewer token input cursor did not advance');
        }
        seenLookupCursors.add(nextCursor);
        lookupCursor = nextCursor;
      } else {
        outputLookupDone = true;
      }
      return { transactions: current(), done: done() };
    }
    const cursor = historyCursor as string;
    if (seenHistoryCursors.has(cursor)) {
      throw new Error('Spark viewer token input history cursor did not advance');
    }
    seenHistoryCursors.add(cursor);
    const history = await sdk.getTokenTransactions({
      sparkAddresses: [input.sparkAddress],
      pageSize: input.pageSize,
      cursor,
      direction: 'PREVIOUS',
    });
    mergeInputOwnerIndexes(
      owners,
      inputOwnerIndexes(Array.isArray(history.transactions) ? history.transactions : []),
    );
    const historyResponse =
      typeof history.pageResponse === 'object' && history.pageResponse !== null
        ? (history.pageResponse as Record<string, unknown>)
        : {};
    historyCursor =
      historyResponse['hasPreviousPage'] === true &&
      typeof historyResponse['previousCursor'] === 'string' &&
      historyResponse['previousCursor'] !== ''
        ? historyResponse['previousCursor']
        : null;
    return { transactions: current(), done: done() };
  };

  return {
    current,
    update(nextTransactions) {
      currentTransactions = nextTransactions;
      mergeInputOwnerIndexes(owners, inputOwnerIndexes(nextTransactions));
    },
    next() {
      inFlight ??= advance().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
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
  const ownerResolutions = new Map<string, CachedTokenOwnerResolution>();
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
        direction: 'PREVIOUS',
      });
      const rawCount = Array.isArray(page.transactions) ? page.transactions.length : 0;
      const rawTransactions = Array.isArray(page.transactions) ? page.transactions : [];
      const localOwners = inputOwnerIndexes(rawTransactions);
      const pageResponse =
        typeof page.pageResponse === 'object' && page.pageResponse !== null
          ? (page.pageResponse as Record<string, unknown>)
          : {};
      const historyCursor =
        pageResponse['hasPreviousPage'] === true &&
        typeof pageResponse['previousCursor'] === 'string' &&
        pageResponse['previousCursor'] !== ''
          ? pageResponse['previousCursor']
          : null;
      const pageKey = `${input.sparkAddress}\u0000${input.walletPubkey}\u0000${input.cursor ?? ''}\u0000${rawTransactions
        .map((transaction) =>
          typeof transaction === 'object' && transaction !== null
            ? (transactionHashOf(transaction as Record<string, unknown>) ?? '')
            : '',
        )
        .join(',')}`;
      const needsOwnerResolution =
        unresolvedInputReferences(rawTransactions, localOwners).length > 0;
      let ownerResolution: CachedTokenOwnerResolution | undefined;
      let transactions: SparkViewerTokenTransaction[];
      if (needsOwnerResolution) {
        ownerResolution = ownerResolutions.get(pageKey);
        if (ownerResolution === undefined) {
          ownerResolution = tokenOwnerResolution(
            sdk,
            input,
            rawTransactions,
            localOwners,
            historyCursor,
          );
          ownerResolutions.set(pageKey, ownerResolution);
        } else {
          ownerResolution.update(rawTransactions);
        }
        transactions = ownerResolution.current();
      } else {
        transactions = tokenTransactionsOf(rawTransactions, input.walletPubkey, localOwners);
      }
      return {
        transactions,
        hasNextPage: pageResponse['hasPreviousPage'] === true,
        nextCursor:
          typeof pageResponse['previousCursor'] === 'string' &&
          pageResponse['previousCursor'] !== ''
            ? pageResponse['previousCursor']
            : null,
        rawCount,
        ...(ownerResolution === undefined ? {} : { ownerResolution }),
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
