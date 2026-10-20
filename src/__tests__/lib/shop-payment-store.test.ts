import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeDb, MergeTx } from '@/lib/account-merge';
import type { SqlClient } from '@/lib/auth/sql';
import { POS_CHARGE_TTL_MS, type PosCharge } from '@/lib/pos-charge';
import {
  PAYMENT_HASH_CLAIM_SQL,
  PAYMENT_HASH_LOCK_NAMESPACE,
  PaymentHashClaims,
} from '@/lib/payment-hash-claim';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import {
  InMemoryShopPaymentStore,
  migrateShopPaymentSchema,
  PostgresShopPaymentStore,
  SHOP_PAYMENT_SCHEMA_SQL,
  type ShopOffer,
  type ShopPayment,
  type ShopPaymentPatch,
  type ShopProof,
  type ShopProofLookup,
  type ShopProofPatch,
  type ShopQuote,
  type ShopTx,
} from '@/lib/shop-payment-store';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');

/** Deterministic lowercase UUID ending in `n`. */
function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const ACC = uid(0xa1);
const ACC2 = uid(0xa2);

function payment(partial: Partial<ShopPayment> = {}): ShopPayment {
  return {
    id: uid(1),
    accountId: ACC,
    amountSats: 2100,
    posChargeId: null,
    bolt11: 'lnbc1',
    paymentHash: 'a'.repeat(64),
    bolt11ExpiresAt: new Date(T0 + 600_000),
    status: 'open',
    endReason: null,
    windowEndsAt: new Date(T0 + 300_000),
    replacements: 0,
    nextSettleAt: new Date(T0 + 5_000),
    nextHistoryAt: null,
    historyOffset: 0,
    successorWaitUntil: null,
    createdAt: new Date(T0),
    acceptedAt: null,
    paidAt: null,
    endedAt: null,
    closedAt: null,
    ...partial,
  };
}

function quote(partial: Partial<ShopQuote> = {}): ShopQuote {
  return {
    id: uid(0x101),
    paymentId: uid(1),
    expiresAt: new Date(T0 + 60_000),
    transferAmounts: [
      {
        method: 'Ethereum',
        minFee: 1,
        assets: [{ asset: 'USDT', amount: '1.50' }],
        available: true,
      },
    ],
    createdAt: new Date(T0),
    ...partial,
  };
}

function offer(partial: Partial<ShopOffer> = {}): ShopOffer {
  return {
    id: uid(0x201),
    quoteId: uid(0x101),
    method: 'Ethereum',
    chainId: 1,
    asset: 'USDT',
    tokenAddress: `0x${'d'.repeat(40)}`,
    depositAddress: `0x${'1'.repeat(40)}`,
    amountIn: '1500000',
    requiredAmountIn: null,
    maxAcceptedAmountIn: null,
    decimals: 6,
    minFee: '1000',
    providerRef: 'q-1',
    idempotencyKey: 'k-1',
    expiresAt: new Date(T0 + 60_000),
    detailIssuedAt: null,
    createdAt: new Date(T0),
    ...partial,
  };
}

function proof(partial: Partial<ShopProof> = {}): ShopProof {
  return {
    id: uid(0x301),
    offerId: uid(0x201),
    paymentId: uid(1),
    source: 'tx',
    chainId: 1,
    txHash: `0x${'e'.repeat(64)}`,
    logIndex: 0,
    userOpHash: null,
    rawHex: null,
    transferAmount: '1500000',
    idempotencyKey: 'pk-1',
    result: null,
    providerOrder: null,
    supersededByOrder: null,
    orderStatus: null,
    orderFoundAt: null,
    refusal: null,
    submitStopped: false,
    sentAt: null,
    lastSubmitAt: null,
    giveUpAt: new Date(T0 + 86_400_000),
    nextSubmitAt: null,
    nextReceiptAt: null,
    nextStatusAt: null,
    tries: 0,
    resolvedAt: null,
    createdAt: new Date(T0),
    ...partial,
  };
}

function lookup(partial: Partial<ShopProofLookup> = {}): ShopProofLookup {
  return {
    id: uid(0x401),
    quoteId: uid(0x101),
    method: 'Ethereum',
    asset: 'USDT',
    chainId: 1,
    hash: `0x${'f'.repeat(64)}`,
    nextTryAt: new Date(T0 + 10_000),
    tries: 0,
    doneAt: null,
    createdAt: new Date(T0),
    ...partial,
  };
}

function charge(partial: Partial<PosCharge> = {}): PosCharge {
  return {
    id: uid(0x501),
    accountId: ACC,
    amountSats: 2100,
    status: 'pending',
    createdAt: new Date(T0),
    expiresAt: new Date(T0 + POS_CHARGE_TTL_MS),
    paidAt: null,
    sparkInvoice: null,
    ...partial,
  };
}

/** Collapse whitespace and drop SQL line comments. */
function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('SHOP_PAYMENT_SCHEMA_SQL', () => {
  it('is exactly the DDL of docs/schema/shop_payment.sql', () => {
    const file = readFileSync(join(process.cwd(), 'docs/schema/shop_payment.sql'), 'utf8');
    expect(normalise(SHOP_PAYMENT_SCHEMA_SQL.map((statement) => `${statement};`).join('\n'))).toBe(
      normalise(file),
    );
  });

  it('is idempotent DDL only', () => {
    for (const statement of SHOP_PAYMENT_SCHEMA_SQL) {
      expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
    }
  });
});

describe('migrateShopPaymentSchema', () => {
  it('executes every statement in order', async () => {
    const executed: string[] = [];
    const sql: SqlClient = {
      query: () => Promise.resolve([]),
      execute: (text) => {
        executed.push(text);
        return Promise.resolve();
      },
    };
    await migrateShopPaymentSchema(sql);
    expect(executed).toEqual([...SHOP_PAYMENT_SCHEMA_SQL]);
  });
});

describe('InMemoryShopPaymentStore', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let pos: InMemoryPosStore;
  let store: InMemoryShopPaymentStore;
  const run = <T>(work: (tx: ShopTx) => Promise<T>): Promise<T> => store.transaction(work);

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    pos = new InMemoryPosStore();
    store = new InMemoryShopPaymentStore(pos);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('runs transactions one at a time in call order', async () => {
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = run(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      return 1;
    });
    const second = run(async () => {
      order.push('second');
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('a rejected transaction restores every shop table and frees the next one', async () => {
    await run(async (tx) => {
      await tx.insertPayment(payment());
      await tx.insertQuote(quote());
      await tx.insertOffers([offer()]);
      await tx.insertProof(proof());
      await tx.insertLookup(lookup());
    });
    await expect(
      run(async (tx) => {
        await tx.updatePayment(
          uid(1),
          {},
          { status: 'ended', endReason: 'window', endedAt: new Date(T0) },
        );
        await tx.insertPayment(
          payment({ id: uid(2), paymentHash: 'b'.repeat(64), status: 'paid' }),
        );
        await tx.updateQuote(uid(0x101), { expiresAt: new Date(0), transferAmounts: [] });
        await tx.markDetailIssued(uid(0x201), T0);
        await tx.deleteProof(uid(0x301));
        await tx.updateLookup(uid(0x401), { tries: 5 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await run(async (tx) => {
      expect((await tx.getPayment(uid(1)))?.status).toBe('open');
      expect(await tx.getPayment(uid(2))).toBeNull();
      expect(await tx.getQuote(uid(0x101))).toEqual(quote());
      expect((await tx.getOffer(uid(0x201)))?.detailIssuedAt).toBeNull();
      expect(await tx.getProof(uid(0x301))).toEqual(proof());
      expect((await tx.findLookup(1, lookup().hash, uid(0x101)))?.tries).toBe(0);
    });
  });

  it('delegates charge calls to the PosStore', async () => {
    await run(async (tx) => {
      await tx.claimPaymentHash('h1');
      await tx.lockAccount(ACC);
      expect(await tx.lockCharge(uid(0x501))).toBeNull();
      expect(await tx.insertCharge(charge())).toBe(true);
      expect(await tx.insertCharge(charge({ id: uid(0x502) }))).toBe(false);
      expect((await tx.lockCharge(uid(0x501)))?.id).toBe(uid(0x501));
      expect(await tx.getCharge(uid(0x501))).toMatchObject({ id: uid(0x501), accountId: ACC });
      expect(await tx.getCharge(uid(0x509))).toBeNull();
      expect((await tx.pendingCharge(ACC, T0 + 1))?.id).toBe(uid(0x501));
      expect(await pos.recordInvoice(uid(0x501), 'h1', T0 + 1)).toEqual({ outcome: 'recorded' });
      expect(await tx.chargeIdForInvoice('h1')).toBe(uid(0x501));
      expect(await tx.chargeIdForInvoice('h2')).toBeNull();
      await tx.deleteChargeInvoice('h1');
      expect(await tx.chargeIdForInvoice('h1')).toBeNull();
      expect((await tx.cancelPendingCharge(ACC, T0 + 2))?.status).toBe('cancelled');
      expect(await tx.markChargePaid(uid(0x501), T0 + 3)).toBeNull();
      expect(await tx.insertCharge(charge({ id: uid(0x503), createdAt: new Date(T0 + 4) }))).toBe(
        true,
      );
      expect((await tx.markChargePaid(uid(0x503), T0 + 5))?.status).toBe('paid');
    });
  });

  it('shares the payment hash claim with the InMemoryPosStore', async () => {
    await pos.create(charge());
    await pos.create(charge({ id: uid(0x502), accountId: ACC2 }));
    // A charge's invoice row refuses a payer's payment and another charge's
    // payment, and admits the payment of its own charge.
    expect(await pos.recordInvoice(uid(0x501), 'h1', T0)).toEqual({ outcome: 'recorded' });
    await run(async (tx) => {
      expect(await tx.insertPayment(payment({ paymentHash: 'h1' }))).toBe(false);
      expect(
        await tx.insertPayment(
          payment({ paymentHash: 'h1', accountId: ACC2, posChargeId: uid(0x502) }),
        ),
      ).toBe(false);
      expect(await tx.insertPayment(payment({ paymentHash: 'h1', posChargeId: uid(0x501) }))).toBe(
        true,
      );
    });
    expect(pos.paymentHashClaims.holder('h1')).toEqual({
      chargeId: uid(0x501),
      paymentId: uid(1),
      paymentChargeId: uid(0x501),
    });
    // A payer's payment holds h2: no charge records it, and no second payment takes it.
    await run(async (tx) => {
      expect(
        await tx.insertPayment(payment({ id: uid(2), accountId: ACC2, paymentHash: 'h2' })),
      ).toBe(true);
      expect(
        await tx.insertPayment(
          payment({ id: uid(3), accountId: ACC2, paymentHash: 'h2', status: 'ended' }),
        ),
      ).toBe(false);
    });
    expect(await pos.recordInvoice(uid(0x501), 'h2', T0)).toEqual({
      outcome: 'other_payment',
      holderChargeId: null,
      holderPaymentId: uid(2),
    });
    // The charge's own shop payment holding the hash is this charge.
    expect(await pos.recordInvoice(uid(0x501), 'h1', T0)).toEqual({ outcome: 'this_charge' });
    expect(await pos.recordInvoice(uid(0x502), 'h1', T0)).toEqual({
      outcome: 'other_payment',
      holderChargeId: uid(0x501),
      holderPaymentId: uid(1),
    });
  });

  it('a rolled-back insert releases the payment hash it claimed', async () => {
    await pos.create(charge());
    await expect(
      run(async (tx) => {
        expect(await tx.insertPayment(payment({ paymentHash: 'h1' }))).toBe(true);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pos.paymentHashClaims.holder('h1')).toBeNull();
    expect(await pos.recordInvoice(uid(0x501), 'h1', T0)).toEqual({ outcome: 'recorded' });
    // A rollback releases only the shop side: the charge's row keeps its claim.
    await expect(
      run(async (tx) => {
        expect(
          await tx.insertPayment(payment({ paymentHash: 'h1', posChargeId: uid(0x501) })),
        ).toBe(true);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pos.paymentHashClaims.holder('h1')).toEqual({
      chargeId: uid(0x501),
      paymentId: null,
      paymentChargeId: null,
    });
  });

  it('takes the claim map from the constructor, else a new one for another PosStore', async () => {
    const claims = new PaymentHashClaims();
    claims.claimCharge('h1', uid(0x501));
    const explicit = new InMemoryShopPaymentStore(pos, claims);
    expect(
      await explicit.transaction((tx) => tx.insertPayment(payment({ paymentHash: 'h1' }))),
    ).toBe(false);
    expect(pos.paymentHashClaims.holder('h1')).toBeNull();
    const other = new InMemoryShopPaymentStore({} as PosStore);
    expect(await other.transaction((tx) => tx.insertPayment(payment({ paymentHash: 'h1' })))).toBe(
      true,
    );
    expect(pos.paymentHashClaims.holder('h1')).toBeNull();
  });

  it('lockProofs returns copies of the payment proofs ordered by id', async () => {
    await run(async (tx) => {
      await tx.insertProof(proof({ id: uid(0x303), createdAt: new Date(T0) }));
      await tx.insertProof(proof({ id: uid(0x301), logIndex: 1, createdAt: new Date(T0 + 1) }));
      await tx.insertProof(proof({ id: uid(0x302), logIndex: 2, paymentId: uid(2) }));
      const locked = await tx.lockProofs(uid(1));
      expect(locked.map((row) => row.id)).toEqual([uid(0x301), uid(0x303)]);
      locked[0]!.tries = 9;
      expect((await tx.getProof(uid(0x301)))?.tries).toBe(0);
    });
  });

  it('round-trips successorWaitUntil and supersededByOrder through inserts and patches', async () => {
    await run(async (tx) => {
      await tx.insertPayment(payment({ successorWaitUntil: new Date(T0 + 1) }));
      expect((await tx.getPayment(uid(1)))?.successorWaitUntil).toEqual(new Date(T0 + 1));
      expect(
        (await tx.updatePayment(uid(1), {}, { successorWaitUntil: new Date(T0 + 2) }))
          ?.successorWaitUntil,
      ).toEqual(new Date(T0 + 2));
      await tx.insertProof(proof({ supersededByOrder: 'o-b' }));
      expect((await tx.getProof(uid(0x301)))?.supersededByOrder).toBe('o-b');
      const patched = await tx.updateProof(uid(0x301), {}, { supersededByOrder: 'o-c' });
      expect(patched === 'conflict' ? null : patched?.supersededByOrder).toBe('o-c');
    });
  });

  it('insertCharge rethrows a failure that is not the open-payment refusal', async () => {
    const create = vi.spyOn(pos, 'create');
    create.mockRejectedValueOnce(new Error('disk'));
    await expect(run((tx) => tx.insertCharge(charge()))).rejects.toThrow('disk');
    create.mockRejectedValueOnce('text');
    await expect(run((tx) => tx.insertCharge(charge()))).rejects.toBe('text');
  });

  it('insertPayment refuses every unique conflict and stores a copy', async () => {
    await run(async (tx) => {
      const row = payment({ posChargeId: uid(0x501) });
      expect(await tx.insertPayment(row)).toBe(true);
      row.createdAt.setTime(0);
      expect(await tx.insertPayment(payment({ paymentHash: 'b'.repeat(64) }))).toBe(false);
      expect(await tx.insertPayment(payment({ id: uid(2) }))).toBe(false);
      expect(
        await tx.insertPayment(
          payment({
            id: uid(2),
            paymentHash: 'b'.repeat(64),
            posChargeId: uid(0x501),
            status: 'paid',
          }),
        ),
      ).toBe(false);
      expect(await tx.insertPayment(payment({ id: uid(2), paymentHash: 'b'.repeat(64) }))).toBe(
        false,
      );
      expect(
        await tx.insertPayment(
          payment({ id: uid(3), paymentHash: 'c'.repeat(64), accountId: ACC2 }),
        ),
      ).toBe(true);
      expect(
        await tx.insertPayment(
          payment({
            id: uid(4),
            paymentHash: 'd'.repeat(64),
            status: 'ended',
            endReason: 'window',
          }),
        ),
      ).toBe(true);
      const stored = await tx.getPayment(uid(1));
      expect(stored).toEqual(payment({ posChargeId: uid(0x501) }));
      stored?.windowEndsAt.setTime(0);
      expect((await tx.lockPayment(uid(1)))?.windowEndsAt.getTime()).toBe(T0 + 300_000);
      expect(await tx.getPayment(uid(9))).toBeNull();
      expect((await tx.openPayment(ACC))?.id).toBe(uid(1));
      expect(await tx.openPayment(uid(9))).toBeNull();
      expect((await tx.paymentForCharge(uid(0x501)))?.id).toBe(uid(1));
      expect(await tx.paymentForCharge(uid(0x502))).toBeNull();
      expect((await tx.paymentForHash('c'.repeat(64)))?.id).toBe(uid(3));
      // The hash alone refuses: new id, other account, no charge, not open.
      expect(
        await tx.insertPayment(
          payment({ id: uid(5), accountId: ACC2, status: 'ended', endReason: 'window' }),
        ),
      ).toBe(false);
      expect(await tx.getPayment(uid(5))).toBeNull();
      // The same row with a fresh hash is stored, so only the hash refused it.
      expect(
        await tx.insertPayment(
          payment({
            id: uid(5),
            accountId: ACC2,
            status: 'ended',
            endReason: 'window',
            paymentHash: 'e'.repeat(64),
          }),
        ),
      ).toBe(true);
    });
  });

  it('updatePayment applies only defined keys when every condition holds', async () => {
    await run(async (tx) => {
      await tx.insertPayment(payment());
      await tx.insertPayment(
        payment({
          id: uid(2),
          paymentHash: 'b'.repeat(64),
          status: 'ended',
          endReason: 'window',
          endedAt: new Date(T0),
        }),
      );
      expect(await tx.updatePayment(uid(9), {}, { replacements: 1 })).toBeNull();
      expect(
        await tx.updatePayment(uid(1), { statuses: ['accepted'] }, { replacements: 1 }),
      ).toBeNull();
      expect(await tx.updatePayment(uid(1), { replacements: 2 }, { replacements: 1 })).toBeNull();
      expect(
        await tx.updatePayment(
          uid(1),
          { windowEndsAfter: new Date(T0 + 300_000) },
          { replacements: 1 },
        ),
      ).toBeNull();
      await tx.updatePayment(uid(2), {}, { closedAt: new Date(T0) });
      expect(await tx.updatePayment(uid(2), { notClosed: true }, { replacements: 1 })).toBeNull();
      expect(
        (await tx.updatePayment(uid(2), { notClosed: false }, { replacements: 1 }))?.replacements,
      ).toBe(1);
      const patch = {
        replacements: 3,
        nextSettleAt: null,
        status: undefined,
      } as unknown as ShopPaymentPatch;
      const updated = await tx.updatePayment(
        uid(1),
        {
          statuses: ['open'],
          replacements: 0,
          windowEndsAfter: new Date(T0),
          notClosed: true,
        },
        patch,
      );
      expect(updated).toEqual(payment({ replacements: 3, nextSettleAt: null }));
      updated?.createdAt.setTime(0);
      expect((await tx.getPayment(uid(1)))?.createdAt.getTime()).toBe(T0);
      // The stored row carries the patch, and `status: undefined` left `open`.
      expect(await tx.getPayment(uid(1))).toEqual(payment({ replacements: 3, nextSettleAt: null }));
    });
  });

  it('updatePayment throws a unique violation when it would open a second payment', async () => {
    await run(async (tx) => {
      await tx.insertPayment(payment());
      await tx.insertPayment(
        payment({
          id: uid(2),
          paymentHash: 'b'.repeat(64),
          status: 'ended',
          endReason: 'window',
          endedAt: new Date(T0),
        }),
      );
    });
    await expect(
      run((tx) => tx.updatePayment(uid(2), {}, { status: 'open', endReason: null, endedAt: null })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('endLapsedWindows ends open payments whose window passed', async () => {
    await run(async (tx) => {
      await tx.insertPayment(payment());
      await tx.insertPayment(
        payment({
          id: uid(2),
          paymentHash: 'b'.repeat(64),
          accountId: ACC2,
          windowEndsAt: new Date(T0 + 400_000),
        }),
      );
      await tx.insertPayment(
        payment({
          id: uid(3),
          paymentHash: 'c'.repeat(64),
          status: 'accepted',
          acceptedAt: new Date(T0),
        }),
      );
      const ended = await tx.endLapsedWindows(T0 + 300_000);
      expect(ended).toEqual([
        payment({ status: 'ended', endReason: 'window', endedAt: new Date(T0 + 300_000) }),
      ]);
      expect(await tx.getPayment(uid(1))).toEqual(
        payment({ status: 'ended', endReason: 'window', endedAt: new Date(T0 + 300_000) }),
      );
      expect((await tx.getPayment(uid(2)))?.status).toBe('open');
      expect((await tx.getPayment(uid(3)))?.status).toBe('accepted');
    });
  });

  it('duePayments orders settle by accepted, charge-backed, time, id and history by time, id', async () => {
    await run(async (tx) => {
      const at = (ms: number): Date => new Date(T0 + ms);
      const rows = [
        payment({ id: uid(1), paymentHash: '1', accountId: uid(0xb1), nextSettleAt: at(1) }),
        payment({
          id: uid(2),
          paymentHash: '2',
          accountId: uid(0xb2),
          nextSettleAt: at(2),
          posChargeId: uid(0x501),
        }),
        payment({
          id: uid(3),
          paymentHash: '3',
          status: 'accepted',
          acceptedAt: at(0),
          nextSettleAt: at(3),
        }),
        payment({
          id: uid(4),
          paymentHash: '4',
          status: 'accepted',
          acceptedAt: at(0),
          nextSettleAt: at(3),
          posChargeId: uid(0x502),
        }),
        payment({
          id: uid(5),
          paymentHash: '5',
          accountId: uid(0xb5),
          nextSettleAt: at(1),
          nextHistoryAt: at(7),
        }),
        payment({
          id: uid(6),
          paymentHash: '6',
          status: 'paid',
          paidAt: at(0),
          nextSettleAt: at(0),
          nextHistoryAt: at(5),
        }),
        payment({
          id: uid(7),
          paymentHash: '7',
          status: 'ended',
          endReason: 'window',
          endedAt: at(0),
          closedAt: at(0),
          nextSettleAt: at(0),
          nextHistoryAt: at(5),
        }),
        payment({ id: uid(8), paymentHash: '8', accountId: uid(0xb8), nextSettleAt: null }),
        payment({
          id: uid(9),
          paymentHash: '9',
          accountId: uid(0xb9),
          nextSettleAt: at(50),
          nextHistoryAt: at(50),
        }),
      ];
      for (const row of rows) {
        expect(await tx.insertPayment(row)).toBe(true);
      }
      expect((await tx.duePayments('settle', T0 + 10, 10)).map((row) => row.id)).toEqual([
        uid(4),
        uid(3),
        uid(2),
        uid(1),
        uid(5),
      ]);
      expect((await tx.duePayments('settle', T0 + 10, 2)).map((row) => row.id)).toEqual([
        uid(4),
        uid(3),
      ]);
      expect((await tx.duePayments('history', T0 + 10, 10)).map((row) => row.id)).toEqual([
        uid(6),
        uid(7),
        uid(5),
      ]);
      expect((await tx.unsettledPayments(ACC)).map((row) => row.id)).toEqual([uid(3), uid(4)]);
    });
  });

  it('stores quotes, replaces their array, and lists them oldest first', async () => {
    await run(async (tx) => {
      const first = quote();
      await tx.insertQuote(first);
      first.transferAmounts[0]?.assets.push({ asset: 'USDC', amount: '2' });
      await tx.insertQuote(quote({ id: uid(0x103), createdAt: new Date(T0 + 1) }));
      await tx.insertQuote(quote({ id: uid(0x102), createdAt: new Date(T0 + 1) }));
      await tx.insertQuote(quote({ id: uid(0x104), paymentId: uid(2) }));
      await expect(tx.insertQuote(quote())).rejects.toMatchObject({ code: '23505' });
      expect((await tx.quotesOf(uid(1))).map((row) => row.id)).toEqual([
        uid(0x101),
        uid(0x102),
        uid(0x103),
      ]);
      const got = await tx.lockQuote(uid(0x101));
      expect(got).toEqual(quote());
      got?.transferAmounts.pop();
      expect(await tx.getQuote(uid(0x101))).toEqual(quote());
      expect(await tx.getQuote(uid(0x109))).toBeNull();
      const amounts = [{ method: 'Polygon', minFee: 2, assets: [], available: true }];
      const updated = await tx.updateQuote(uid(0x101), {
        expiresAt: new Date(T0 + 1),
        transferAmounts: amounts,
      });
      amounts.pop();
      expect(updated).toEqual(
        quote({
          expiresAt: new Date(T0 + 1),
          transferAmounts: [{ method: 'Polygon', minFee: 2, assets: [], available: true }],
        }),
      );
      expect((await tx.getQuote(uid(0x101)))?.transferAmounts).toHaveLength(1);
      expect(
        await tx.updateQuote(uid(0x109), { expiresAt: new Date(T0), transferAmounts: [] }),
      ).toBeNull();
    });
  });

  it('insertOffers drops a taken deposit address and refuses other duplicates', async () => {
    await run(async (tx) => {
      const inserted = await tx.insertOffers([
        offer(),
        offer({
          id: uid(0x202),
          asset: 'USDC',
          depositAddress: `0x${'2'.repeat(40)}`,
          createdAt: new Date(T0),
        }),
        offer({ id: uid(0x203), method: 'Polygon', depositAddress: `0x${'1'.repeat(40)}` }),
      ]);
      expect(inserted.map((row) => row.id)).toEqual([uid(0x201), uid(0x202)]);
      inserted[0]?.expiresAt.setTime(0);
      expect(await tx.getOffer(uid(0x201))).toEqual(offer());
      expect(await tx.getOffer(uid(0x209))).toBeNull();
      expect(await tx.insertOffers([])).toEqual([]);
      await expect(
        tx.insertOffers([offer({ id: uid(0x204), depositAddress: `0x${'4'.repeat(40)}` })]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        tx.insertOffers([offer({ method: 'Arbitrum', depositAddress: `0x${'5'.repeat(40)}` })]),
      ).rejects.toMatchObject({ code: '23505' });
      expect((await tx.offersOf(uid(0x101))).map((row) => row.id)).toEqual([
        uid(0x201),
        uid(0x202),
      ]);
      expect(await tx.offersOf(uid(0x109))).toEqual([]);
      expect(await tx.markDetailIssued(uid(0x201), T0 + 9)).toBe(true);
      expect(await tx.markDetailIssued(uid(0x201), T0 + 10)).toBe(false);
      expect(await tx.markDetailIssued(uid(0x209), T0)).toBe(false);
      expect((await tx.getOffer(uid(0x201)))?.detailIssuedAt).toEqual(new Date(T0 + 9));
    });
  });

  it('insertProof enforces every unique index of shop_proof', async () => {
    await run(async (tx) => {
      expect(await tx.insertProof(proof({ result: 'accepted', providerOrder: 'o1' }))).toBe(true);
      // id
      expect(await tx.insertProof(proof({ txHash: '0x2', logIndex: 9 }))).toBe(false);
      // (chain, tx, log)
      expect(await tx.insertProof(proof({ id: uid(0x302) }))).toBe(false);
      // same tx on another chain and another log index are fine
      expect(await tx.insertProof(proof({ id: uid(0x303), chainId: 137 }))).toBe(true);
      expect(await tx.insertProof(proof({ id: uid(0x304), logIndex: 1 }))).toBe(true);
      // (chain, tx, offer) while unlogged
      expect(
        await tx.insertProof(proof({ id: uid(0x305), logIndex: null, source: 'detected' })),
      ).toBe(true);
      expect(
        await tx.insertProof(proof({ id: uid(0x306), logIndex: null, source: 'detected' })),
      ).toBe(false);
      expect(
        await tx.insertProof(
          proof({ id: uid(0x307), logIndex: null, source: 'detected', offerId: uid(0x202) }),
        ),
      ).toBe(true);
      // provider order
      expect(
        await tx.insertProof(proof({ id: uid(0x308), txHash: '0x3', providerOrder: 'o1' })),
      ).toBe(false);
      // accepted per payment
      expect(
        await tx.insertProof(
          proof({ id: uid(0x309), txHash: '0x4', providerOrder: 'o2', result: 'accepted' }),
        ),
      ).toBe(false);
      expect(
        await tx.insertProof(
          proof({
            id: uid(0x30a),
            txHash: '0x4',
            providerOrder: 'o2',
            result: 'accepted',
            paymentId: uid(2),
          }),
        ),
      ).toBe(true);
      const got = await tx.getProof(uid(0x301));
      expect(got).toEqual(proof({ result: 'accepted', providerOrder: 'o1' }));
      got?.giveUpAt.setTime(0);
      expect((await tx.getProof(uid(0x301)))?.giveUpAt.getTime()).toBe(T0 + 86_400_000);
      expect(await tx.getProof(uid(0x3ff))).toBeNull();
    });
  });

  it('lists and finds proofs oldest first and deletes one', async () => {
    await run(async (tx) => {
      await tx.insertProof(
        proof({ id: uid(0x303), createdAt: new Date(T0 + 1), userOpHash: '0xu' }),
      );
      await tx.insertProof(proof({ id: uid(0x302), logIndex: 1, createdAt: new Date(T0 + 1) }));
      await tx.insertProof(proof({ logIndex: 2, providerOrder: 'o1', userOpHash: '0xu' }));
      await tx.insertProof(proof({ id: uid(0x304), logIndex: 3, paymentId: uid(2), chainId: 137 }));
      expect((await tx.proofsOf(uid(1))).map((row) => row.id)).toEqual([
        uid(0x301),
        uid(0x302),
        uid(0x303),
      ]);
      expect(
        (await tx.findProofs({ chainId: 1, txHash: proof().txHash })).map((row) => row.id),
      ).toEqual([uid(0x301), uid(0x302), uid(0x303)]);
      expect((await tx.findProofs({ chainId: 1, userOpHash: '0xu' })).map((row) => row.id)).toEqual(
        [uid(0x301), uid(0x303)],
      );
      expect(await tx.findProofs({ chainId: 137, userOpHash: '0xu' })).toEqual([]);
      expect((await tx.findProofs({ providerOrder: 'o1' })).map((row) => row.id)).toEqual([
        uid(0x301),
      ]);
      await tx.deleteProof(uid(0x302));
      await tx.deleteProof(uid(0x3ff));
      expect((await tx.proofsOf(uid(1))).map((row) => row.id)).toEqual([uid(0x301), uid(0x303)]);
    });
  });

  it('updateProof checks conditions, reports conflicts, and applies only defined keys', async () => {
    await run(async (tx) => {
      await tx.insertProof(proof({ result: 'accepted', providerOrder: 'o1' }));
      await tx.insertProof(proof({ id: uid(0x302), logIndex: 1, lastSubmitAt: new Date(T0 + 10) }));
      expect(await tx.updateProof(uid(0x3ff), {}, { tries: 1 })).toBeNull();
      expect(await tx.updateProof(uid(0x302), { results: ['late'] }, { tries: 1 })).toBeNull();
      expect(
        await tx.updateProof(uid(0x302), { lastSubmitAtOrBefore: new Date(T0 + 9) }, { tries: 1 }),
      ).toBeNull();
      expect(await tx.updateProof(uid(0x302), {}, { providerOrder: 'o1' })).toBe('conflict');
      expect(await tx.updateProof(uid(0x302), {}, { logIndex: 0 })).toBe('conflict');
      expect(
        await tx.updateProof(uid(0x302), {}, { providerOrder: 'o2', result: 'accepted' }),
      ).toBe('conflict');
      expect((await tx.getProof(uid(0x302)))?.providerOrder).toBeNull();
      // Seed `late`, so skipping an undefined `result` differs from writing null.
      expect(await tx.updateProof(uid(0x302), {}, { result: 'late' })).toMatchObject({
        result: 'late',
      });
      const patch = {
        tries: 2,
        lastSubmitAt: new Date(T0 + 20),
        result: undefined,
      } as unknown as ShopProofPatch;
      const updated = await tx.updateProof(
        uid(0x302),
        { results: [null, 'late'], lastSubmitAtOrBefore: new Date(T0 + 10) },
        patch,
      );
      expect(updated).toEqual(
        proof({
          id: uid(0x302),
          logIndex: 1,
          tries: 2,
          lastSubmitAt: new Date(T0 + 20),
          result: 'late',
        }),
      );
      expect((await tx.getProof(uid(0x302)))?.result).toBe('late');
      expect(
        await tx.updateProof(
          uid(0x301),
          { lastSubmitAtOrBefore: new Date(T0) },
          { orderStatus: 'completed' },
        ),
      ).toEqual(proof({ result: 'accepted', providerOrder: 'o1', orderStatus: 'completed' }));
    });
  });

  it('dueProofs selects and orders each duty', async () => {
    await run(async (tx) => {
      const at = (ms: number): Date => new Date(T0 + ms);
      const rows = [
        proof({
          id: uid(1),
          logIndex: 1,
          nextReceiptAt: at(2),
          nextSubmitAt: at(2),
          giveUpAt: at(2),
        }),
        proof({
          id: uid(2),
          logIndex: 2,
          nextReceiptAt: at(1),
          nextSubmitAt: at(3),
          giveUpAt: at(1),
        }),
        proof({
          id: uid(3),
          logIndex: 3,
          nextSubmitAt: at(1),
          submitStopped: true,
          giveUpAt: at(50),
        }),
        proof({
          id: uid(4),
          logIndex: 4,
          nextSubmitAt: at(1),
          result: 'late',
          nextStatusAt: at(1),
        }),
        proof({
          id: uid(5),
          logIndex: 5,
          nextSubmitAt: at(1),
          providerOrder: 'o5',
          nextStatusAt: at(4),
          giveUpAt: at(0),
        }),
        proof({
          id: uid(6),
          logIndex: 6,
          providerOrder: 'o6',
          nextStatusAt: at(3),
          nextReceiptAt: at(50),
        }),
        proof({ id: uid(7), logIndex: 7, providerOrder: 'o7', nextStatusAt: at(3) }),
        // An unlogged hex proof is never submitted.
        proof({
          id: uid(8),
          source: 'hex',
          rawHex: 'ab',
          logIndex: null,
          nextSubmitAt: at(0),
        }),
        // A proof refused as tx_used is no longer followed; another refusal is.
        proof({
          id: uid(9),
          logIndex: 9,
          providerOrder: 'o9',
          result: 'refused',
          refusal: 'tx_used',
          nextStatusAt: at(0),
        }),
        proof({
          id: uid(10),
          logIndex: 10,
          providerOrder: 'o10',
          result: 'refused',
          refusal: 'mismatch',
          nextStatusAt: at(5),
        }),
      ];
      for (const row of rows) {
        expect(await tx.insertProof(row)).toBe(true);
      }
      const ids = async (
        duty: 'receipt' | 'submit' | 'status' | 'stuck',
        limit = 10,
      ): Promise<string[]> => (await tx.dueProofs(duty, T0 + 10, limit)).map((row) => row.id);
      expect(await ids('receipt')).toEqual([uid(2), uid(1)]);
      expect(await ids('submit')).toEqual([uid(1), uid(2)]);
      expect(await ids('status')).toEqual([uid(6), uid(7), uid(5), uid(10)]);
      expect(await ids('status', 1)).toEqual([uid(6)]);
      expect(await ids('stuck')).toEqual([uid(2), uid(1)]);
    });
  });

  it('stores lookups once per (chain, hash, quote) and lists due ones', async () => {
    await run(async (tx) => {
      expect(await tx.insertLookup(lookup())).toBe(true);
      expect(await tx.insertLookup(lookup({ id: uid(0x402) }))).toBe(false);
      expect(await tx.insertLookup(lookup({ hash: '0x2' }))).toBe(false);
      expect(
        await tx.insertLookup(
          lookup({ id: uid(0x403), chainId: 137, nextTryAt: new Date(T0 + 10_000) }),
        ),
      ).toBe(true);
      expect(
        await tx.insertLookup(
          lookup({ id: uid(0x402), hash: '0x2', nextTryAt: new Date(T0 + 5_000) }),
        ),
      ).toBe(true);
      expect(
        await tx.insertLookup(
          lookup({ id: uid(0x404), quoteId: uid(0x102), nextTryAt: new Date(T0) }),
        ),
      ).toBe(true);
      expect(await tx.updateLookup(uid(0x404), { doneAt: new Date(T0) })).toEqual(
        lookup({
          id: uid(0x404),
          quoteId: uid(0x102),
          nextTryAt: new Date(T0),
          doneAt: new Date(T0),
        }),
      );
      expect(await tx.updateLookup(uid(0x4ff), { tries: 1 })).toBeNull();
      // The cap counts done rows too.
      expect(await tx.countLookups(uid(0x102))).toBe(1);
      expect(await tx.countLookups(uid(0x101))).toBe(3);
      expect(await tx.countLookups(uid(0x1ff))).toBe(0);
      const found = await tx.findLookup(1, lookup().hash, uid(0x101));
      expect(found).toEqual(lookup());
      found?.nextTryAt.setTime(0);
      expect((await tx.findLookup(1, lookup().hash, uid(0x101)))?.nextTryAt.getTime()).toBe(
        T0 + 10_000,
      );
      expect(await tx.findLookup(1, lookup().hash, uid(0x109))).toBeNull();
      expect((await tx.dueLookups(T0 + 10_000, 10)).map((row) => row.id)).toEqual([
        uid(0x402),
        uid(0x401),
        uid(0x403),
      ]);
      expect((await tx.dueLookups(T0 + 10_000, 1)).map((row) => row.id)).toEqual([uid(0x402)]);
    });
  });
});

/** Recorded statements and a configurable answer per statement. */
class MockTx implements MergeTx {
  readonly calls: { text: string; params: readonly unknown[] }[] = [];
  respond: (text: string, params: readonly unknown[]) => unknown[] = () => [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ text, params });
    return this.respond(text, params) as T[];
  }

  texts(): string[] {
    return this.calls.map((call) => call.text);
  }
}

function postgresStore(): { tx: MockTx; store: PostgresShopPaymentStore; sql: SqlClient } {
  const tx = new MockTx();
  const db: MergeDb = { begin: (run) => run(tx) };
  const sql: SqlClient = {
    query: () => Promise.reject(new Error('outside the transaction')),
    execute: () => Promise.reject(new Error('outside the transaction')),
  };
  return { tx, store: new PostgresShopPaymentStore(sql, db), sql };
}

function uniqueError(): Error {
  return Object.assign(new Error('duplicate key'), { errno: '23505' });
}

const ISO = (ms: number): string => new Date(T0 + ms).toISOString();

function paymentSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(1),
    account_id: ACC,
    amount_sats: '2100',
    pos_charge_id: null,
    bolt11: 'lnbc1',
    payment_hash: 'a'.repeat(64),
    bolt11_expires_at: ISO(600_000),
    status: 'open',
    end_reason: null,
    window_ends_at: new Date(T0 + 300_000),
    replacements: 0,
    next_settle_at: ISO(5_000),
    next_history_at: null,
    history_offset: 0,
    successor_wait_until: null,
    created_at: ISO(0),
    accepted_at: null,
    paid_at: null,
    ended_at: null,
    closed_at: null,
    ...overrides,
  };
}

function quoteSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(0x101),
    payment_id: uid(1),
    expires_at: ISO(60_000),
    transfer_amounts: quote().transferAmounts,
    created_at: ISO(0),
    ...overrides,
  };
}

function offerSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(0x201),
    quote_id: uid(0x101),
    method: 'Ethereum',
    chain_id: 1,
    asset: 'USDT',
    token_address: `0x${'d'.repeat(40)}`,
    deposit_address: `0x${'1'.repeat(40)}`,
    amount_in: '1500000',
    required_amount_in: null,
    max_accepted_amount_in: null,
    decimals: 6,
    min_fee: '1000',
    provider_ref: 'q-1',
    idempotency_key: 'k-1',
    expires_at: ISO(60_000),
    detail_issued_at: null,
    created_at: ISO(0),
    ...overrides,
  };
}

function proofSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(0x301),
    offer_id: uid(0x201),
    payment_id: uid(1),
    source: 'tx',
    chain_id: 1,
    tx_hash: `0x${'e'.repeat(64)}`,
    log_index: 0,
    user_op_hash: null,
    raw_hex: null,
    transfer_amount: '1500000',
    idempotency_key: 'pk-1',
    result: null,
    provider_order: null,
    superseded_by_order: null,
    order_status: null,
    order_found_at: null,
    refusal: null,
    submit_stopped: false,
    sent_at: null,
    last_submit_at: null,
    give_up_at: ISO(86_400_000),
    next_submit_at: null,
    next_receipt_at: null,
    next_status_at: null,
    tries: 0,
    resolved_at: null,
    created_at: ISO(0),
    ...overrides,
  };
}

function lookupSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(0x401),
    quote_id: uid(0x101),
    method: 'Ethereum',
    asset: 'USDT',
    chain_id: 1,
    hash: `0x${'f'.repeat(64)}`,
    next_try_at: ISO(10_000),
    tries: 0,
    done_at: null,
    created_at: ISO(0),
    ...overrides,
  };
}

describe('PostgresShopPaymentStore', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('runs the callback on one db transaction and returns its result', async () => {
    const tx = new MockTx();
    const begin = vi.fn((run: (t: MergeTx) => Promise<unknown>) => run(tx));
    const store = new PostgresShopPaymentStore(
      { query: () => Promise.resolve([]), execute: () => Promise.resolve() },
      { begin: begin as MergeDb['begin'] },
    );
    expect(await store.transaction(async () => 7)).toBe(7);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('returns null, [], 0, or false for malformed ids without a query', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      await t.lockAccount('nope');
      expect(await t.lockCharge('nope')).toBeNull();
      expect(await t.lockPayment('nope')).toBeNull();
      expect(await t.lockQuote('nope')).toBeNull();
      expect(await t.getPayment('nope')).toBeNull();
      expect(await t.openPayment('nope')).toBeNull();
      expect(await t.paymentForCharge('nope')).toBeNull();
      expect(await t.updatePayment('nope', {}, { replacements: 1 })).toBeNull();
      expect(await t.unsettledPayments('nope')).toEqual([]);
      expect(
        await t.updateQuote('nope', { expiresAt: new Date(T0), transferAmounts: [] }),
      ).toBeNull();
      expect(await t.getQuote('nope')).toBeNull();
      expect(await t.quotesOf('nope')).toEqual([]);
      expect(await t.getOffer('nope')).toBeNull();
      expect(await t.offersOf('nope')).toEqual([]);
      expect(await t.markDetailIssued('nope', T0)).toBe(false);
      expect(await t.getProof('nope')).toBeNull();
      expect(await t.proofsOf('nope')).toEqual([]);
      expect(await t.lockProofs('nope')).toEqual([]);
      expect(await t.updateProof('nope', {}, { tries: 1 })).toBeNull();
      await t.deleteProof('nope');
      expect(await t.countLookups('nope')).toBe(0);
      expect(await t.findLookup(1, '0x', 'nope')).toBeNull();
      expect(await t.updateLookup('nope', { tries: 1 })).toBeNull();
    });
    expect(tx.calls).toEqual([]);
  });

  it('locks rows with FOR UPDATE', async () => {
    const { tx, store } = postgresStore();
    tx.respond = (text) => {
      if (text.includes('FROM pos_charge WHERE id = $1 FOR UPDATE')) return [{ id: uid(0x501) }];
      if (text.includes('FROM shop_payment')) return [paymentSqlRow()];
      if (text.includes('FROM shop_quote')) return [quoteSqlRow()];
      if (text.includes('FROM pos_charge')) {
        return [
          {
            id: uid(0x501),
            account_id: ACC,
            amount_sats: 2100,
            status: 'pending',
            created_at: ISO(0),
            expires_at: ISO(POS_CHARGE_TTL_MS),
            paid_at: null,
            spark_invoice: null,
          },
        ];
      }
      return [];
    };
    await store.transaction(async (t) => {
      await t.lockAccount(ACC);
      expect(await t.lockCharge(uid(0x501))).toEqual(charge());
      expect(await t.lockPayment(uid(1))).toEqual(payment());
      expect(await t.lockQuote(uid(0x101))).toEqual(quote());
    });
    expect(tx.calls[0]).toEqual({
      text: 'SELECT id FROM account WHERE id = $1 FOR UPDATE',
      params: [ACC],
    });
    expect(tx.calls[1]).toEqual({
      text: 'SELECT id FROM pos_charge WHERE id = $1 FOR UPDATE',
      params: [uid(0x501)],
    });
    expect(tx.calls[3]?.text).toMatch(/FROM shop_payment WHERE id = \$1 FOR UPDATE$/);
    expect(tx.calls[4]?.text).toMatch(/FROM shop_quote WHERE id = \$1 FOR UPDATE$/);
  });

  it('claimPaymentHash takes the two-key advisory lock of the hash', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      await t.claimPaymentHash(`ffffffff${'0'.repeat(56)}`);
    });
    expect(tx.calls).toEqual([
      { text: PAYMENT_HASH_CLAIM_SQL, params: [PAYMENT_HASH_LOCK_NAMESPACE, -1] },
    ]);
  });

  it('lockProofs locks the payment proofs in one statement ordered by id', async () => {
    const { tx, store } = postgresStore();
    tx.respond = () => [proofSqlRow()];
    await store.transaction(async (t) => {
      expect(await t.lockProofs(uid(1))).toEqual([proof()]);
    });
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]?.params).toEqual([uid(1)]);
    expect(tx.calls[0]?.text).toMatch(
      /FROM shop_proof WHERE payment_id = \$1 ORDER BY id FOR UPDATE$/,
    );
  });

  it('getCharge reads the charge without a lock, and null for a missing row or a malformed id', async () => {
    const { tx, store } = postgresStore();
    tx.respond = (text) =>
      text.includes('FROM pos_charge')
        ? [
            {
              id: uid(0x501),
              account_id: ACC,
              amount_sats: 2100,
              status: 'pending',
              created_at: ISO(0),
              expires_at: ISO(POS_CHARGE_TTL_MS),
              paid_at: null,
              spark_invoice: null,
            },
          ]
        : [];
    await store.transaction(async (t) => {
      expect(await t.getCharge(uid(0x501))).toEqual(charge());
      expect(await t.getCharge('nope')).toBeNull();
      tx.respond = () => [];
      expect(await t.getCharge(uid(0x502))).toBeNull();
    });
    expect(tx.calls).toHaveLength(2);
    expect(tx.calls.every((call) => !call.text.includes('FOR UPDATE'))).toBe(true);
    expect(tx.calls[0]?.params).toEqual([uid(0x501)]);
  });

  it('lockCharge answers null when the row is missing or vanished', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      expect(await t.lockCharge(uid(0x501))).toBeNull();
      tx.respond = (text) => (text.includes('FOR UPDATE') ? [{ id: uid(0x501) }] : []);
      expect(await t.lockCharge(uid(0x501))).toBeNull();
    });
  });

  it('runs charge calls as PostgresPosStore SQL on the transaction', async () => {
    const { tx, store } = postgresStore();
    const chargeRow = {
      id: uid(0x501),
      account_id: ACC,
      amount_sats: 2100,
      status: 'pending',
      created_at: ISO(0),
      expires_at: ISO(POS_CHARGE_TTL_MS),
      paid_at: null,
      spark_invoice: null,
    };
    tx.respond = (text) => {
      if (text.includes('INSERT INTO pos_charge_invoice')) return [{ payment_hash: 'h1' }];
      if (text.includes('pos_charge_invoice i')) return [chargeRow];
      if (text.includes("SET status = 'expired'")) return [];
      if (text.startsWith('SELECT') || text.includes('RETURNING')) return [chargeRow];
      return [];
    };
    await store.transaction(async (t) => {
      expect(await t.pendingCharge(ACC, T0)).toEqual(charge());
      expect(await t.cancelPendingCharge(ACC, T0)).toEqual(charge());
      expect(await t.markChargePaid(uid(0x501), T0)).toEqual(charge());
      expect(await t.chargeIdForInvoice('h1')).toBe(uid(0x501));
      await t.deleteChargeInvoice('h1');
      tx.respond = () => [];
      expect(await t.chargeIdForInvoice('h2')).toBeNull();
    });
    expect(tx.texts()).toContain('DELETE FROM pos_charge_invoice WHERE payment_hash = $1');
  });

  it('insertCharge wraps PostgresPosStore.create in a savepoint', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      expect(await t.insertCharge(charge())).toBe(true);
    });
    expect(tx.texts().filter((text) => text.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT shop_store_guard',
      'RELEASE SAVEPOINT shop_store_guard',
    ]);
    expect(tx.texts().some((text) => text.startsWith('INSERT INTO pos_charge'))).toBe(true);

    tx.calls.length = 0;
    tx.respond = (text) => {
      if (text.startsWith('INSERT INTO pos_charge')) throw uniqueError();
      return [];
    };
    await store.transaction(async (t) => {
      expect(await t.insertCharge(charge())).toBe(false);
    });
    expect(tx.texts().filter((text) => text.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT shop_store_guard',
      'ROLLBACK TO SAVEPOINT shop_store_guard',
      'RELEASE SAVEPOINT shop_store_guard',
    ]);

    tx.respond = (text) => {
      if (text.startsWith('INSERT INTO pos_charge')) throw new Error('down');
      return [];
    };
    await expect(store.transaction((t) => t.insertCharge(charge()))).rejects.toThrow('down');
  });

  it('reads payments and maps every column', async () => {
    const { tx, store } = postgresStore();
    const full = paymentSqlRow({
      amount_sats: 2100n,
      pos_charge_id: uid(0x501),
      status: 'ended',
      end_reason: 'window',
      next_settle_at: new Date(T0 + 1),
      next_history_at: ISO(2),
      history_offset: '20',
      successor_wait_until: ISO(6),
      replacements: '4',
      accepted_at: ISO(3),
      paid_at: null,
      ended_at: ISO(4),
      closed_at: ISO(5),
    });
    tx.respond = () => [full];
    await store.transaction(async (t) => {
      expect(await t.getPayment(uid(1))).toEqual(
        payment({
          posChargeId: uid(0x501),
          status: 'ended',
          endReason: 'window',
          nextSettleAt: new Date(T0 + 1),
          nextHistoryAt: new Date(T0 + 2),
          historyOffset: 20,
          successorWaitUntil: new Date(T0 + 6),
          replacements: 4,
          acceptedAt: new Date(T0 + 3),
          endedAt: new Date(T0 + 4),
          closedAt: new Date(T0 + 5),
        }),
      );
      await t.openPayment(ACC);
      await t.paymentForCharge(uid(0x501));
      await t.paymentForHash('a'.repeat(64));
      expect(await t.unsettledPayments(ACC)).toHaveLength(1);
      tx.respond = () => [];
      expect(await t.getPayment(uid(1))).toBeNull();
    });
    expect(tx.calls[1]).toMatchObject({ params: [ACC] });
    expect(tx.calls[1]?.text).toMatch(/WHERE account_id = \$1 AND status = 'open'$/);
    expect(tx.calls[2]?.text).toMatch(/WHERE pos_charge_id = \$1$/);
    expect(tx.calls[3]?.text).toMatch(/WHERE payment_hash = \$1$/);
    expect(tx.calls[4]?.text).toMatch(
      /account_id = \$1 AND status <> 'paid' AND closed_at IS NULL\s+ORDER BY created_at, id/,
    );
  });

  it('insertPayment uses ON CONFLICT DO NOTHING and binds ISO instants', async () => {
    const { tx, store } = postgresStore();
    tx.respond = () => [{ id: uid(1) }];
    await store.transaction(async (t) => {
      expect(await t.insertPayment(payment())).toBe(true);
      tx.respond = () => [];
      expect(await t.insertPayment(payment())).toBe(false);
    });
    expect(tx.calls[0]?.text).toMatch(
      /INSERT INTO shop_payment \(id, account_id,[\s\S]*VALUES \(\$1, [\s\S]*\$20\)\s+ON CONFLICT DO NOTHING\s+RETURNING id/,
    );
    expect(tx.calls[0]?.params).toEqual([
      uid(1),
      ACC,
      2100,
      null,
      'lnbc1',
      'a'.repeat(64),
      ISO(600_000),
      'open',
      null,
      ISO(300_000),
      0,
      ISO(5_000),
      null,
      0,
      null,
      ISO(0),
      null,
      null,
      null,
      null,
    ]);
  });

  it('updatePayment builds one conditional UPDATE from the set keys only', async () => {
    const { tx, store } = postgresStore();
    tx.respond = () => [paymentSqlRow({ replacements: 1 })];
    await store.transaction(async (t) => {
      const patch = {
        replacements: 1,
        nextSettleAt: null,
        closedAt: new Date(T0),
        status: undefined,
        bogus: 'x',
      } as unknown as ShopPaymentPatch;
      expect(
        (
          await t.updatePayment(
            uid(1),
            {
              statuses: ['open', 'accepted'],
              replacements: 0,
              windowEndsAfter: new Date(T0),
              notClosed: true,
            },
            patch,
          )
        )?.replacements,
      ).toBe(1);
      await t.updatePayment(uid(1), { notClosed: false }, {});
      tx.respond = () => [];
      expect(await t.updatePayment(uid(1), {}, { replacements: 2 })).toBeNull();
    });
    expect(tx.calls[0]?.text).toMatch(
      /UPDATE shop_payment\nSET replacements = \$2, next_settle_at = \$3, closed_at = \$4\nWHERE id = \$1 AND status = ANY\(\$5::text\[\]\) AND replacements = \$6 AND window_ends_at > \$7 AND closed_at IS NULL\nRETURNING id, /,
    );
    expect(tx.calls[0]?.params).toEqual([
      uid(1),
      1,
      null,
      ISO(0),
      '{"open","accepted"}',
      0,
      ISO(0),
    ]);
    expect(tx.calls[1]?.text).toMatch(/SET id = id\nWHERE id = \$1\n/);
  });

  it('endLapsedWindows and duePayments run their statements', async () => {
    const { tx, store } = postgresStore();
    tx.respond = () => [paymentSqlRow()];
    await store.transaction(async (t) => {
      expect(await t.endLapsedWindows(T0)).toEqual([payment()]);
      await t.duePayments('settle', T0, 8);
      await t.duePayments('history', T0, 1);
    });
    expect(tx.calls[0]).toMatchObject({ params: [ISO(0)] });
    expect(tx.calls[0]?.text).toMatch(
      /SET status = 'ended', end_reason = 'window', ended_at = \$1\nWHERE status = 'open' AND window_ends_at <= \$1/,
    );
    expect(tx.calls[1]).toMatchObject({ params: [ISO(0), 8] });
    expect(tx.calls[1]?.text).toMatch(
      /status <> 'paid' AND closed_at IS NULL AND next_settle_at <= \$1\nORDER BY \(status = 'accepted'\) DESC, \(pos_charge_id IS NOT NULL\) DESC, next_settle_at, id\nLIMIT \$2/,
    );
    expect(tx.calls[2]?.text).toMatch(
      /next_history_at <= \$1\nORDER BY next_history_at, id\nLIMIT \$2/,
    );
  });

  it('quotes: insert as jsonb, update, read parsed or text jsonb, list oldest first', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      await t.insertQuote(quote());
      tx.respond = () => [
        quoteSqlRow({ transfer_amounts: JSON.stringify([]), expires_at: new Date(T0) }),
      ];
      expect(
        await t.updateQuote(uid(0x101), { expiresAt: new Date(T0), transferAmounts: [] }),
      ).toEqual(quote({ expiresAt: new Date(T0), transferAmounts: [] }));
      tx.respond = () => [quoteSqlRow()];
      expect(await t.getQuote(uid(0x101))).toEqual(quote());
      expect(await t.quotesOf(uid(1))).toEqual([quote()]);
      tx.respond = () => [];
      expect(
        await t.updateQuote(uid(0x101), { expiresAt: new Date(T0), transferAmounts: [] }),
      ).toBeNull();
      expect(await t.getQuote(uid(0x101))).toBeNull();
    });
    expect(tx.calls[0]).toEqual({
      text: 'INSERT INTO shop_quote (id, payment_id, expires_at, transfer_amounts, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)',
      params: [uid(0x101), uid(1), ISO(60_000), JSON.stringify(quote().transferAmounts), ISO(0)],
    });
    expect(tx.calls[1]?.text).toMatch(
      /SET expires_at = \$2, transfer_amounts = \$3::jsonb\nWHERE id = \$1/,
    );
    expect(tx.calls[1]?.params).toEqual([uid(0x101), ISO(0), '[]']);
    expect(tx.calls[3]?.text).toMatch(/WHERE payment_id = \$1 ORDER BY created_at, id$/);
  });

  it('offers: one ON CONFLICT (deposit_address) insert per row, reads, and detail mark', async () => {
    const { tx, store } = postgresStore();
    let inserts = 0;
    tx.respond = (text) => {
      if (text.startsWith('INSERT')) {
        inserts += 1;
        return inserts === 2 ? [] : [{ id: 'x' }];
      }
      if (text.startsWith('UPDATE')) return [{ id: uid(0x201) }];
      return [
        offerSqlRow({
          required_amount_in: '1',
          max_accepted_amount_in: 2n,
          detail_issued_at: ISO(9),
        }),
      ];
    };
    await store.transaction(async (t) => {
      const rows = [offer(), offer({ id: uid(0x202) }), offer({ id: uid(0x203) })];
      const inserted = await t.insertOffers(rows);
      expect(inserted.map((row) => row.id)).toEqual([uid(0x201), uid(0x203)]);
      inserted[0]?.expiresAt.setTime(0);
      expect(rows[0]?.expiresAt.getTime()).toBe(T0 + 60_000);
      const expected = offer({
        requiredAmountIn: '1',
        maxAcceptedAmountIn: '2',
        detailIssuedAt: new Date(T0 + 9),
      });
      expect(await t.getOffer(uid(0x201))).toEqual(expected);
      expect(await t.offersOf(uid(0x101))).toEqual([expected]);
      expect(await t.markDetailIssued(uid(0x201), T0)).toBe(true);
      tx.respond = () => [];
      expect(await t.markDetailIssued(uid(0x201), T0)).toBe(false);
      expect(await t.getOffer(uid(0x201))).toBeNull();
    });
    expect(tx.calls[0]?.text).toMatch(
      /VALUES \(\$1, [\s\S]*\$17\)\nON CONFLICT \(deposit_address\) DO NOTHING\nRETURNING id/,
    );
    expect(tx.calls[0]?.params).toEqual([
      uid(0x201),
      uid(0x101),
      'Ethereum',
      1,
      'USDT',
      `0x${'d'.repeat(40)}`,
      `0x${'1'.repeat(40)}`,
      '1500000',
      null,
      null,
      6,
      '1000',
      'q-1',
      'k-1',
      ISO(60_000),
      null,
      ISO(0),
    ]);
    expect(tx.calls[4]?.text).toMatch(/WHERE quote_id = \$1 ORDER BY created_at, id$/);
    expect(tx.calls[5]?.text).toMatch(
      /SET detail_issued_at = \$2\nWHERE id = \$1 AND detail_issued_at IS NULL/,
    );
  });

  it('proofs: insert, read, find by each selector, delete, and map every column', async () => {
    const { tx, store } = postgresStore();
    const full = proofSqlRow({
      log_index: '3',
      user_op_hash: '0xu',
      raw_hex: 'ab',
      source: 'hex',
      transfer_amount: 7n,
      result: 'accepted',
      provider_order: 'o1',
      superseded_by_order: 'o2',
      order_status: 'completed',
      order_found_at: ISO(1),
      refusal: null,
      submit_stopped: true,
      sent_at: ISO(2),
      last_submit_at: ISO(3),
      next_submit_at: ISO(4),
      next_receipt_at: ISO(5),
      next_status_at: ISO(6),
      tries: '2',
      resolved_at: ISO(7),
    });
    const mapped = proof({
      logIndex: 3,
      userOpHash: '0xu',
      rawHex: 'ab',
      source: 'hex',
      transferAmount: '7',
      result: 'accepted',
      providerOrder: 'o1',
      supersededByOrder: 'o2',
      orderStatus: 'completed',
      orderFoundAt: new Date(T0 + 1),
      submitStopped: true,
      sentAt: new Date(T0 + 2),
      lastSubmitAt: new Date(T0 + 3),
      nextSubmitAt: new Date(T0 + 4),
      nextReceiptAt: new Date(T0 + 5),
      nextStatusAt: new Date(T0 + 6),
      tries: 2,
      resolvedAt: new Date(T0 + 7),
    });
    tx.respond = (text) => (text.startsWith('INSERT') ? [{ id: uid(0x301) }] : [full]);
    await store.transaction(async (t) => {
      expect(await t.insertProof(proof())).toBe(true);
      expect(await t.getProof(uid(0x301))).toEqual(mapped);
      expect(await t.proofsOf(uid(1))).toEqual([mapped]);
      await t.findProofs({ chainId: 1, txHash: '0xa' });
      await t.findProofs({ chainId: 1, userOpHash: '0xu' });
      await t.findProofs({ providerOrder: 'o1' });
      await t.deleteProof(uid(0x301));
      tx.respond = () => [
        proofSqlRow({ source: 'detected', log_index: null, transfer_amount: null }),
      ];
      expect(await t.getProof(uid(0x301))).toEqual(
        proof({ source: 'detected', logIndex: null, transferAmount: null }),
      );
      tx.respond = () => [];
      expect(await t.insertProof(proof())).toBe(false);
      expect(await t.getProof(uid(0x301))).toBeNull();
    });
    expect(tx.calls[0]?.text).toMatch(/\$27\)\nON CONFLICT DO NOTHING\nRETURNING id/);
    expect(tx.calls[0]?.params).toHaveLength(27);
    expect(tx.calls[0]?.params[20]).toBe(ISO(86_400_000));
    expect(tx.calls[3]).toMatchObject({ params: [1, '0xa'] });
    expect(tx.calls[3]?.text).toMatch(
      /WHERE chain_id = \$1 AND tx_hash = \$2 ORDER BY created_at, id$/,
    );
    expect(tx.calls[4]?.text).toMatch(/WHERE chain_id = \$1 AND user_op_hash = \$2 ORDER BY/);
    expect(tx.calls[5]).toMatchObject({ params: ['o1'] });
    expect(tx.calls[5]?.text).toMatch(/WHERE provider_order = \$1 ORDER BY/);
    expect(tx.calls[6]).toEqual({
      text: 'DELETE FROM shop_proof WHERE id = $1',
      params: [uid(0x301)],
    });
  });

  it('updateProof runs under a savepoint and maps a unique violation to conflict', async () => {
    const { tx, store } = postgresStore();
    tx.respond = (text) => (text.startsWith('UPDATE') ? [proofSqlRow({ tries: 1 })] : []);
    await store.transaction(async (t) => {
      expect(
        await t.updateProof(
          uid(0x301),
          { results: [null, 'late'], lastSubmitAtOrBefore: new Date(T0) },
          { tries: 1, lastSubmitAt: new Date(T0 + 1) },
        ),
      ).toEqual(proof({ tries: 1 }));
      await t.updateProof(uid(0x301), { results: ['late'] }, { tries: 1 });
      tx.respond = () => [];
      expect(await t.updateProof(uid(0x301), {}, {})).toBeNull();
      tx.respond = (text) => {
        if (text.startsWith('UPDATE')) throw uniqueError();
        return [];
      };
      expect(await t.updateProof(uid(0x301), {}, { providerOrder: 'o1' })).toBe('conflict');
    });
    expect(tx.calls[0]?.text).toBe('SAVEPOINT shop_store_guard');
    expect(tx.calls[1]?.text).toMatch(
      /UPDATE shop_proof\nSET tries = \$2, last_submit_at = \$3\nWHERE id = \$1 AND \(result IS NULL OR result = ANY\(\$4::text\[\]\)\) AND \(last_submit_at IS NULL OR last_submit_at <= \$5\)\nRETURNING id, /,
    );
    expect(tx.calls[1]?.params).toEqual([uid(0x301), 1, ISO(1), '{"late"}', ISO(0)]);
    expect(tx.calls[2]?.text).toBe('RELEASE SAVEPOINT shop_store_guard');
    expect(tx.calls[4]?.text).toMatch(/WHERE id = \$1 AND result = ANY\(\$3::text\[\]\)\n/);
    expect(tx.calls[7]?.text).toMatch(/SET id = id\n/);
    expect(tx.texts().slice(-3)).toEqual([
      expect.stringMatching(/^UPDATE shop_proof/),
      'ROLLBACK TO SAVEPOINT shop_store_guard',
      'RELEASE SAVEPOINT shop_store_guard',
    ]);
  });

  it('updateProof lets any other failure through', async () => {
    const { tx, store } = postgresStore();
    tx.respond = (text) => {
      if (text.startsWith('UPDATE')) throw new Error('down');
      return [];
    };
    await expect(
      store.transaction((t) => t.updateProof(uid(0x301), {}, { tries: 1 })),
    ).rejects.toThrow('down');
    expect(tx.texts().some((text) => text.startsWith('ROLLBACK'))).toBe(false);
  });

  it('dueProofs uses the selection and order of each duty', async () => {
    const { tx, store } = postgresStore();
    await store.transaction(async (t) => {
      await t.dueProofs('receipt', T0, 4);
      await t.dueProofs('submit', T0, 1);
      await t.dueProofs('status', T0, 1);
      await t.dueProofs('stuck', T0, 9);
    });
    expect(tx.calls.map((call) => call.params)).toEqual([
      [ISO(0), 4],
      [ISO(0), 1],
      [ISO(0), 1],
      [ISO(0), 9],
    ]);
    expect(tx.calls[0]?.text).toMatch(
      /WHERE next_receipt_at <= \$1\nORDER BY next_receipt_at, id\nLIMIT \$2/,
    );
    expect(tx.calls[1]?.text).toMatch(
      /WHERE next_submit_at <= \$1 AND result IS NULL AND provider_order IS NULL AND NOT submit_stopped\n {2}AND log_index IS NOT NULL\nORDER BY next_submit_at, id/,
    );
    expect(tx.calls[2]?.text).toMatch(
      /WHERE next_status_at <= \$1 AND provider_order IS NOT NULL\n {2}AND NOT \(result IS NOT DISTINCT FROM 'refused' AND refusal IS NOT DISTINCT FROM 'tx_used'\)\nORDER BY next_status_at, id/,
    );
    expect(tx.calls[3]?.text).toMatch(
      /WHERE result IS NULL AND provider_order IS NULL AND give_up_at <= \$1\nORDER BY give_up_at, id/,
    );
  });

  it('lookups: count, insert, find, update, and due', async () => {
    const { tx, store } = postgresStore();
    tx.respond = (text) => {
      if (text.includes('count(*)')) return [{ total: '2' }];
      if (text.startsWith('INSERT')) return [{ id: uid(0x401) }];
      return [lookupSqlRow({ tries: '1', done_at: ISO(1) })];
    };
    const mapped = lookup({ tries: 1, doneAt: new Date(T0 + 1) });
    await store.transaction(async (t) => {
      expect(await t.countLookups(uid(0x101))).toBe(2);
      expect(await t.insertLookup(lookup())).toBe(true);
      expect(await t.findLookup(1, '0xf', uid(0x101))).toEqual(mapped);
      expect(await t.updateLookup(uid(0x401), { tries: 1, doneAt: new Date(T0 + 1) })).toEqual(
        mapped,
      );
      expect(await t.dueLookups(T0, 4)).toEqual([mapped]);
      tx.respond = () => [];
      expect(await t.countLookups(uid(0x101))).toBe(0);
      expect(await t.insertLookup(lookup())).toBe(false);
      expect(await t.findLookup(1, '0xf', uid(0x101))).toBeNull();
      expect(await t.updateLookup(uid(0x401), {})).toBeNull();
    });
    expect(tx.calls[0]).toEqual({
      text: 'SELECT count(*) AS total FROM shop_proof_lookup WHERE quote_id = $1',
      params: [uid(0x101)],
    });
    expect(tx.calls[1]?.text).toMatch(/\$10\)\nON CONFLICT DO NOTHING\nRETURNING id/);
    expect(tx.calls[1]?.params).toEqual([
      uid(0x401),
      uid(0x101),
      'Ethereum',
      'USDT',
      1,
      `0x${'f'.repeat(64)}`,
      ISO(10_000),
      0,
      null,
      ISO(0),
    ]);
    expect(tx.calls[2]).toMatchObject({ params: [1, '0xf', uid(0x101)] });
    expect(tx.calls[3]?.text).toMatch(
      /UPDATE shop_proof_lookup SET tries = \$2, done_at = \$3 WHERE id = \$1 RETURNING/,
    );
    expect(tx.calls[4]?.text).toMatch(
      /WHERE done_at IS NULL AND next_try_at <= \$1\nORDER BY next_try_at, id\nLIMIT \$2/,
    );
    expect(tx.calls[8]?.text).toMatch(/SET id = id WHERE id = \$1/);
  });

  it('countLookups counts every lookup row of the quote, done or not', async () => {
    const { tx, store } = postgresStore();
    tx.respond = () => [{ total: '5' }];
    await store.transaction(async (t) => {
      expect(await t.countLookups(uid(0x101))).toBe(5);
    });
    expect(tx.calls).toEqual([
      {
        text: 'SELECT count(*) AS total FROM shop_proof_lookup WHERE quote_id = $1',
        params: [uid(0x101)],
      },
    ]);
  });
});
