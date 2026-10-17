import { describe, expect, it } from 'vitest';
import { keccak256, serializeTransaction, toRlp, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodeSignedEvmTransaction,
  decodeTransferLog,
  ERC20_TRANSFER_TOPIC,
  erc20TransferData,
  hexFeeReaches,
  normalizeEvmAddress,
  parseErc20TransferData,
  recommendedMinFee,
  type DecodedEvmTransaction,
} from '@/lib/evm-transfer';
import type { EvmLog } from '@/lib/evm-rpc';

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const TOKEN = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const DEPOSIT = `0x${'ab'.repeat(20)}`;
const SENDER = `0x${'cd'.repeat(20)}`;
const DATA = erc20TransferData(DEPOSIT, 1_500_000n);
const SIG = { r: `0x${'11'.repeat(32)}` as Hex, s: `0x${'22'.repeat(32)}` as Hex };

function raw(signed: Hex): string {
  return signed.slice(2);
}

/** EIP-155 example transaction from the EIP text (chain 1). */
const EIP155_EXAMPLE =
  'f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';

describe('normalizeEvmAddress', () => {
  it('lowercases a well-formed address', () => {
    expect(normalizeEvmAddress('0xDAC17F958D2ee523a2206206994597C13D831ec7')).toBe(TOKEN);
  });

  it.each([
    [''],
    ['0x12'],
    [`${'ab'.repeat(20)}`],
    [`0X${'ab'.repeat(20)}`],
    [`0x${'g'.repeat(40)}`],
    [` ${DEPOSIT}`],
  ])('rejects %j', (value) => {
    expect(normalizeEvmAddress(value)).toBeNull();
  });
});

describe('erc20TransferData', () => {
  it('builds the 68-byte transfer calldata in lowercase', () => {
    const data = erc20TransferData(DEPOSIT.toUpperCase().replace('0X', '0x'), 255n);
    expect(data).toBe(`0xa9059cbb${'0'.repeat(24)}${'ab'.repeat(20)}${'0'.repeat(62)}ff`);
    expect((data.length - 2) / 2).toBe(68);
  });

  it('accepts the uint256 bounds', () => {
    expect(erc20TransferData(DEPOSIT, 0n).endsWith('0'.repeat(64))).toBe(true);
    expect(erc20TransferData(DEPOSIT, (1n << 256n) - 1n).endsWith('f'.repeat(64))).toBe(true);
  });

  it('throws on a bad recipient or amount', () => {
    expect(() => erc20TransferData('0x12', 1n)).toThrow(RangeError);
    expect(() => erc20TransferData(DEPOSIT, -1n)).toThrow(RangeError);
    expect(() => erc20TransferData(DEPOSIT, 1n << 256n)).toThrow(RangeError);
  });
});

describe('parseErc20TransferData', () => {
  it('round-trips erc20TransferData, any case', () => {
    expect(parseErc20TransferData(DATA)).toEqual({ recipient: DEPOSIT, amount: 1_500_000n });
    expect(parseErc20TransferData(DATA.toUpperCase().replace('0X', '0x'))).toEqual({
      recipient: DEPOSIT,
      amount: 1_500_000n,
    });
  });

  it.each([
    ['too short', DATA.slice(0, -2)],
    ['too long', `${DATA}00`],
    ['another selector', DATA.replace('a9059cbb', '23b872dd')],
    ['dirty padding', `${DATA.slice(0, 10)}01${DATA.slice(12)}`],
    ['no 0x', DATA.slice(2)],
    ['empty', '0x'],
  ])('rejects %s', (_name, data) => {
    expect(parseErc20TransferData(data)).toBeNull();
  });
});

describe('decodeTransferLog', () => {
  const pad = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
  const good: EvmLog = {
    address: TOKEN.toUpperCase().replace('0X', '0x'),
    topics: [ERC20_TRANSFER_TOPIC.toUpperCase().replace('0X', '0x'), pad(SENDER), pad(DEPOSIT)],
    data: `0x${1_500_000n.toString(16).padStart(64, '0')}`,
    logIndex: 7,
  };

  it('decodes a Transfer log', () => {
    expect(decodeTransferLog(good)).toEqual({
      token: TOKEN,
      from: SENDER,
      to: DEPOSIT,
      value: 1_500_000n,
      logIndex: 7,
    });
  });

  it.each([
    ['another topic 0', { topics: [`0x${'00'.repeat(32)}`, pad(SENDER), pad(DEPOSIT)] }],
    ['two topics', { topics: [ERC20_TRANSFER_TOPIC, pad(SENDER)] }],
    [
      'four topics (ERC-721)',
      { topics: [ERC20_TRANSFER_TOPIC, pad(SENDER), pad(DEPOSIT), pad(SENDER)] },
    ],
    ['a bad token address', { address: '0x12' }],
    [
      'a dirty from topic',
      { topics: [ERC20_TRANSFER_TOPIC, `0x01${pad(SENDER).slice(4)}`, pad(DEPOSIT)] },
    ],
    [
      'a dirty to topic',
      { topics: [ERC20_TRANSFER_TOPIC, pad(SENDER), `0x01${pad(DEPOSIT).slice(4)}`] },
    ],
    ['short data', { data: '0x01' }],
    ['empty data', { data: '0x' }],
  ])('rejects %s', (_name, overrides) => {
    expect(decodeTransferLog({ ...good, ...overrides })).toBeNull();
  });
});

describe('decodeSignedEvmTransaction', () => {
  it('decodes a signed EIP-1559 transaction', async () => {
    const signed = await account.signTransaction({
      type: 'eip1559',
      chainId: 137,
      nonce: 3,
      gas: 65_000n,
      maxFeePerGas: 50_000_000_000n,
      maxPriorityFeePerGas: 30_000_000_000n,
      to: TOKEN,
      value: 0n,
      data: DATA as Hex,
    });
    expect(decodeSignedEvmTransaction(raw(signed))).toEqual({
      hash: keccak256(signed),
      type: 'eip1559',
      chainId: 137,
      to: TOKEN,
      value: 0n,
      data: DATA,
      gasPrice: null,
      maxFeePerGas: 50_000_000_000n,
      maxPriorityFeePerGas: 30_000_000_000n,
    });
    expect(decodeSignedEvmTransaction(raw(signed).toUpperCase())?.hash).toBe(keccak256(signed));
  });

  it('decodes a signed EIP-1559 transaction with zero fees as 0', async () => {
    const signed = await account.signTransaction({
      type: 'eip1559',
      chainId: 1,
      gas: 21_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      to: DEPOSIT as Hex,
    });
    expect(decodeSignedEvmTransaction(raw(signed))).toMatchObject({
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      data: '0x',
      value: 0n,
    });
  });

  it('decodes a signed EIP-2930 transaction', async () => {
    const signed = await account.signTransaction({
      type: 'eip2930',
      chainId: 42161,
      gas: 65_000n,
      gasPrice: 100_000_000n,
      to: TOKEN,
      data: DATA as Hex,
      accessList: [{ address: TOKEN, storageKeys: [`0x${'01'.repeat(32)}`] }],
    });
    expect(decodeSignedEvmTransaction(raw(signed))).toEqual({
      hash: keccak256(signed),
      type: 'eip2930',
      chainId: 42161,
      to: TOKEN,
      value: 0n,
      data: DATA,
      gasPrice: 100_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });
  });

  it('decodes a signed EIP-155 legacy transaction', async () => {
    const signed = await account.signTransaction({
      type: 'legacy',
      chainId: 56,
      gas: 65_000n,
      gasPrice: 3_000_000_000n,
      to: TOKEN,
      data: DATA as Hex,
    });
    expect(decodeSignedEvmTransaction(raw(signed))).toEqual({
      hash: keccak256(signed),
      type: 'legacy',
      chainId: 56,
      to: TOKEN,
      value: 0n,
      data: DATA,
      gasPrice: 3_000_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });
  });

  it('decodes the EIP-155 example transaction', () => {
    expect(decodeSignedEvmTransaction(EIP155_EXAMPLE)).toMatchObject({
      type: 'legacy',
      chainId: 1,
      to: `0x${'35'.repeat(20)}`,
      value: 1_000_000_000_000_000_000n,
      data: '0x',
      gasPrice: 20_000_000_000n,
    });
  });

  it('decodes a pre-EIP-155 legacy transaction with chainId null', async () => {
    const signed = await account.signTransaction({
      type: 'legacy',
      gas: 21_000n,
      gasPrice: 0n,
      value: 5n,
    });
    expect(decodeSignedEvmTransaction(raw(signed))).toEqual({
      hash: keccak256(signed),
      type: 'legacy',
      chainId: null,
      to: null,
      value: 5n,
      data: '0x',
      gasPrice: 0n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });
  });

  it('rejects unsigned transactions', () => {
    const unsigned1559 = serializeTransaction({
      type: 'eip1559',
      chainId: 1,
      maxFeePerGas: 1n,
      to: TOKEN,
      data: DATA as Hex,
    });
    const unsignedLegacy = serializeTransaction({
      type: 'legacy',
      chainId: 1,
      gasPrice: 1n,
      to: TOKEN,
    });
    const unsignedPre155 = serializeTransaction({ type: 'legacy', gasPrice: 1n, to: TOKEN });
    expect(decodeSignedEvmTransaction(raw(unsigned1559))).toBeNull();
    expect(decodeSignedEvmTransaction(raw(unsignedLegacy))).toBeNull();
    expect(decodeSignedEvmTransaction(raw(unsignedPre155))).toBeNull();
  });

  it('rejects a zero signature', () => {
    const zeroR = serializeTransaction(
      { type: 'eip1559', chainId: 1, maxFeePerGas: 1n, to: TOKEN },
      { r: '0x0', s: SIG.s, yParity: 0 },
    );
    const zeroS = serializeTransaction(
      { type: 'eip1559', chainId: 1, maxFeePerGas: 1n, to: TOKEN },
      { r: SIG.r, s: '0x0', yParity: 0 },
    );
    expect(decodeSignedEvmTransaction(raw(zeroR))).toBeNull();
    expect(decodeSignedEvmTransaction(raw(zeroS))).toBeNull();
  });

  it('rejects an EIP-7702 transaction', () => {
    const signed = serializeTransaction(
      {
        type: 'eip7702',
        chainId: 1,
        maxFeePerGas: 1n,
        to: TOKEN,
        authorizationList: [{ address: TOKEN, chainId: 1, nonce: 0, ...SIG, yParity: 0 }],
      },
      { ...SIG, yParity: 0 },
    );
    expect(decodeSignedEvmTransaction(raw(signed))).toBeNull();
  });

  it('rejects an EIP-4844 envelope', () => {
    expect(decodeSignedEvmTransaction(`03${EIP155_EXAMPLE.slice(2)}`)).toBeNull();
  });

  it('rejects a non-canonical encoding', () => {
    const nonCanonical = toRlp([
      '0x00',
      '0x04a817c800',
      '0x5208',
      `0x${'35'.repeat(20)}`,
      '0x0de0b6b3a7640000',
      '0x',
      '0x25',
      '0x28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276',
      '0x67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
    ]);
    expect(decodeSignedEvmTransaction(raw(nonCanonical))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['odd length', EIP155_EXAMPLE.slice(1)],
    ['with 0x', `0x${EIP155_EXAMPLE}`],
    ['not hex', `zz${EIP155_EXAMPLE.slice(2)}`],
    ['truncated', EIP155_EXAMPLE.slice(0, -2)],
    ['trailing bytes', `${EIP155_EXAMPLE}00`],
    ['unknown type byte', `05${EIP155_EXAMPLE.slice(2)}`],
    ['legacy with seven fields', raw(toRlp(['0x', '0x', '0x', '0x', '0x', '0x', '0x']))],
  ])('rejects %s', (_name, input) => {
    expect(decodeSignedEvmTransaction(input)).toBeNull();
  });
});

describe('recommendedMinFee', () => {
  it('adds 20 % and floors', () => {
    expect(recommendedMinFee(1001n, 1)).toBe(1201n);
    expect(recommendedMinFee(0n, 137)).toBe(0n);
  });

  it('scales by 20/12 on BNB Smart Chain', () => {
    expect(recommendedMinFee(1001n, 56)).toBe(2001n);
    expect(recommendedMinFee(1_000_000_000n, 56)).toBe(2_000_000_000n);
  });
});

describe('hexFeeReaches', () => {
  const base: DecodedEvmTransaction = {
    hash: `0x${'00'.repeat(32)}`,
    type: 'legacy',
    chainId: 1,
    to: TOKEN,
    value: 0n,
    data: DATA,
    gasPrice: 100n,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };

  it('uses the gas price of legacy and EIP-2930 transactions', () => {
    expect(hexFeeReaches(base, 100n, 0n)).toBe(true);
    expect(hexFeeReaches(base, 101n, 1000n)).toBe(false);
    expect(hexFeeReaches({ ...base, type: 'eip2930' }, 100n, 0n)).toBe(true);
    expect(hexFeeReaches({ ...base, gasPrice: null }, 1n, 0n)).toBe(false);
    expect(hexFeeReaches({ ...base, gasPrice: null }, 0n, 0n)).toBe(true);
  });

  it('uses min(maxFeePerGas, recommended + priority) for EIP-1559', () => {
    const tx: DecodedEvmTransaction = {
      ...base,
      type: 'eip1559',
      gasPrice: null,
      maxFeePerGas: 150n,
      maxPriorityFeePerGas: 20n,
    };
    // cap binds: min(150, 200 + 20) = 150
    expect(hexFeeReaches(tx, 150n, 200n)).toBe(true);
    expect(hexFeeReaches(tx, 151n, 200n)).toBe(false);
    // recommended + priority binds: min(150, 100 + 20) = 120
    expect(hexFeeReaches(tx, 120n, 100n)).toBe(true);
    expect(hexFeeReaches(tx, 121n, 100n)).toBe(false);
  });

  it('counts missing EIP-1559 fees as 0', () => {
    const tx: DecodedEvmTransaction = {
      ...base,
      type: 'eip1559',
      gasPrice: 1000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    };
    expect(hexFeeReaches(tx, 1n, 100n)).toBe(false);
    expect(hexFeeReaches({ ...tx, maxFeePerGas: 500n }, 100n, 100n)).toBe(true);
    expect(hexFeeReaches({ ...tx, maxFeePerGas: 500n }, 101n, 100n)).toBe(false);
  });
});
