import { bech32m } from '@scure/base';
import { describe, expect, it } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { MessageInvoiceAttempt, ShopNoteRef, ZapReceiptGiftState } from '@/lib/message-store';
import type { MessageRow } from '@/lib/message';
import type { PosCharge } from '@/lib/pos-charge';
import { protoBytesField } from '@/lib/protobuf';
import { encodeSparkInvoice } from '@/lib/spark-invoice';
import {
  WALLET_PAYMENT_CATEGORIES,
  walletPaymentClassifier,
  type WalletCategoryDeps,
} from '@/lib/wallet-category';
import type { ReportedWalletPayment } from '@/lib/wallet-report';
import {
  BOLT11,
  BOLT11_PAYMENT_HASH,
  LNURL_SERVER,
  WALLET_PUBKEY,
} from '@/__tests__/helpers/wallet-lnurl';

const OWN = '00000000-0000-4000-8000-000000000000';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const SHOP = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '33333333-3333-4333-8333-333333333333';
const PAYER = '44444444-4444-4444-8444-444444444444';
const OTHER_KEY = `03${'b'.repeat(64)}`;

function account(id: string, extra: Partial<Account> = {}): Account {
  return {
    id,
    linkingKey: null,
    role: 'verified',
    name: id,
    location: null,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...extra,
  };
}

function payment(extra: Partial<ReportedWalletPayment> = {}): ReportedWalletPayment {
  return {
    paymentId: 'p',
    direction: 'out',
    status: 'completed',
    amountSats: 21,
    feeSats: 0,
    paidAt: new Date('2026-10-01T00:00:00.000Z'),
    method: 'spark',
    paymentHash: null,
    invoice: null,
    destination: null,
    description: null,
    lnurlComment: null,
    ...extra,
  };
}

function invoice(authorAccountId: string, payerAccountId: string): MessageInvoiceAttempt {
  return {
    id: 'invoice',
    createdAt: new Date(),
    messageId: 'message',
    payerAccountId,
    authorAccountId,
    amountSats: 21,
    lightningAddress: null,
    zapRequest: null,
    result: 'ok',
    httpStatus: 200,
    pr: BOLT11,
    paymentHash: BOLT11_PAYMENT_HASH,
    description: null,
    descriptionHash: null,
    isNip57Invoice: false,
    lnurlResponse: null,
  };
}

function gift(payerAccountId: string | null): ZapReceiptGiftState {
  return {
    receiptEventId: 'receipt',
    messageId: 'message',
    sats: 21,
    payerAccountId,
    payerPubkey: null,
    zapRequestId: null,
    giftReplyId: null,
    comment: '',
  };
}

function charge(accountId: string): PosCharge {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId,
    amountSats: 21,
    status: 'paid',
    createdAt: new Date(),
    expiresAt: new Date(),
    paidAt: new Date(),
    sparkInvoice: null,
  };
}

interface State {
  accounts: Map<string, Account>;
  usernames: Map<string, Account>;
  pubkeys: Map<string, Account>;
  invoice?: MessageInvoiceAttempt;
  receiptId?: string;
  gift?: ZapReceiptGiftState;
  message?: MessageRow;
  shops: ShopNoteRef[];
  shopCalls: number;
  charge?: PosCharge;
  posStore?: (ref: { paymentHash: string } | { chargeId: string }) => PosCharge | undefined;
  refs: Array<{ paymentHash: string } | { chargeId: string }>;
  invoiceHashes: string[];
  invoiceHash?: string;
  throwLookup?: boolean;
}

function setup(withLnurlServer: boolean = true): {
  state: State;
  classify: ReturnType<typeof walletPaymentClassifier>;
} {
  const state: State = {
    accounts: new Map(),
    usernames: new Map(),
    pubkeys: new Map(),
    shops: [],
    shopCalls: 0,
    refs: [],
    invoiceHashes: [],
  };
  const deps: WalletCategoryDeps = {
    authStore: {
      getAccount: async (id) => state.accounts.get(id),
      getAccountByUsername: async (username) => state.usernames.get(username),
      getAccountByVerifiedSparkPubkey: async (pubkey) => state.pubkeys.get(pubkey),
    },
    messages: {
      findOkInvoiceByPaymentHash: async (paymentHash) => {
        if (state.throwLookup === true) throw new Error('lookup failed');
        state.invoiceHashes.push(paymentHash);
        return state.invoiceHash === undefined || state.invoiceHash === paymentHash
          ? state.invoice
          : undefined;
      },
      zapPaymentReceiptId: async () => state.receiptId,
      getZapReceiptGift: async () => state.gift,
      getById: async () => state.message,
      listLiveAssignedShops: async () => {
        state.shopCalls += 1;
        return state.shops;
      },
    },
    posStore: {
      findChargeForPayment: async (ref) => {
        state.refs.push(ref);
        return state.posStore === undefined ? state.charge : state.posStore(ref);
      },
    },
    ...(withLnurlServer ? { lnurlServer: LNURL_SERVER } : {}),
  };
  return { state, classify: walletPaymentClassifier(deps, OWN) };
}

function spark(memo?: string, pubkey: string = OTHER_KEY): string {
  return encodeSparkInvoice({
    identityPublicKey: pubkey,
    id: new Uint8Array(16),
    ...(memo === undefined ? {} : { memo }),
    amountSats: 21,
  });
}

describe('walletPaymentClassifier', () => {
  it('exports categories in stable order', () => {
    expect(WALLET_PAYMENT_CATEGORIES).toEqual([
      'member',
      'shop',
      'platform',
      'gift',
      'outside_lightning',
      'onchain',
      'unknown',
    ]);
  });

  it('classifies forum invoices out/in and promotes a known platform author', async () => {
    const { state, classify } = setup();
    state.invoice = invoice(MEMBER, PAYER);
    state.accounts.set(MEMBER, account(MEMBER));
    state.accounts.set(PAYER, account(PAYER));
    await expect(classify(payment({ invoice: BOLT11 }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: MEMBER,
    });
    await expect(classify(payment({ invoice: BOLT11, direction: 'in' }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: PAYER,
    });
    state.invoice = invoice(PLATFORM, PAYER);
    state.accounts.set(PLATFORM, account(PLATFORM, { isPlatform: true }));
    await expect(classify(payment({ paymentHash: BOLT11_PAYMENT_HASH }))).resolves.toEqual({
      category: 'platform',
      counterpartyAccountId: PLATFORM,
    });
  });

  it('keeps gift fallback for missing/self counterparties', async () => {
    const { state, classify } = setup();
    state.invoice = invoice(OWN, PAYER);
    await expect(classify(payment({ paymentHash: BOLT11_PAYMENT_HASH }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: null,
    });
    state.invoice = invoice(MEMBER, PAYER);
    await expect(classify(payment({ paymentHash: BOLT11_PAYMENT_HASH }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: MEMBER,
    });
  });

  it('classifies zap receipts out/in and continues when receipt state is absent', async () => {
    const { state, classify } = setup();
    state.receiptId = 'receipt';
    state.gift = gift(PAYER);
    state.message = { id: 'message', accountId: MEMBER } as MessageRow;
    state.accounts.set(MEMBER, account(MEMBER));
    state.accounts.set(PAYER, account(PAYER));
    await expect(classify(payment({ paymentHash: 'a'.repeat(64) }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: MEMBER,
    });
    await expect(
      classify(payment({ paymentHash: 'a'.repeat(64), direction: 'in' })),
    ).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: PAYER,
    });
    state.gift = gift(null);
    await expect(
      classify(payment({ paymentHash: 'a'.repeat(64), direction: 'in' })),
    ).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: null,
    });
    state.gift = gift(PAYER);
    delete state.message;
    await expect(classify(payment({ paymentHash: 'a'.repeat(64) }))).resolves.toEqual({
      category: 'gift',
      counterpartyAccountId: null,
    });
    delete state.gift;
    await expect(classify(payment({ paymentHash: 'a'.repeat(64) }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
  });

  it('classifies POS by hash and pos memo, with self counterparty removed', async () => {
    const first = setup();
    first.state.charge = charge(SHOP);
    await expect(first.classify(payment({ paymentHash: 'a'.repeat(64) }))).resolves.toEqual({
      category: 'shop',
      counterpartyAccountId: SHOP,
    });
    expect(first.state.refs).toEqual([{ paymentHash: 'a'.repeat(64) }]);

    const second = setup();
    second.state.charge = charge(OWN);
    await expect(second.classify(payment({ invoice: spark('pos:not-a-uuid') }))).resolves.toEqual({
      category: 'shop',
      counterpartyAccountId: null,
    });
    expect(second.state.refs).toEqual([{ chargeId: 'not-a-uuid' }]);
  });

  it('falls back to the pos memo when the payment hash matches no recorded charge invoice', async () => {
    const { state, classify } = setup();
    state.posStore = (ref) => ('chargeId' in ref ? charge(SHOP) : undefined);
    await expect(
      classify(payment({ paymentHash: 'b'.repeat(64), invoice: spark('pos:charge-1') })),
    ).resolves.toEqual({ category: 'shop', counterpartyAccountId: SHOP });
    expect(state.refs).toEqual([{ paymentHash: 'b'.repeat(64) }, { chargeId: 'charge-1' }]);
  });

  it('resolves own-host member, shop, and platform addresses and loads shops once', async () => {
    const { state, classify } = setup();
    const member = account(MEMBER, {
      username: 'alice',
      sparkPubkey: OTHER_KEY,
      sparkPubkeyVerifiedAt: 1,
    });
    const shop = account(SHOP, {
      username: 'shop',
      sparkPubkey: OTHER_KEY,
      sparkPubkeyVerifiedAt: 1,
    });
    const platform = account(PLATFORM, {
      username: 'platform',
      sparkPubkey: OTHER_KEY,
      sparkPubkeyVerifiedAt: 1,
      isPlatform: true,
    });
    state.usernames.set('alice', member);
    state.usernames.set('shop', shop);
    state.usernames.set('platform', platform);
    state.shops = [
      { id: 'n1', accountId: '', text: '#21GiftsShop' },
      { id: 'n2', accountId: SHOP, text: '#21giftsshopper' },
      { id: 'n3', accountId: SHOP, text: 'Open #21GIFTSshop!' },
    ];
    await expect(classify(payment({ destination: 'Alice@EXAMPLE.TEST' }))).resolves.toEqual({
      category: 'member',
      counterpartyAccountId: MEMBER,
    });
    await expect(classify(payment({ destination: 'shop@example.test' }))).resolves.toEqual({
      category: 'shop',
      counterpartyAccountId: SHOP,
    });
    await expect(classify(payment({ destination: 'platform@example.test' }))).resolves.toEqual({
      category: 'platform',
      counterpartyAccountId: PLATFORM,
    });
    expect(state.shopCalls).toBe(1);
  });

  it('lets an unresolved own-host address and a self resolution fall through', async () => {
    const { state, classify } = setup();
    state.usernames.set(
      'self',
      account(OWN, {
        username: 'self',
        sparkPubkey: WALLET_PUBKEY,
        sparkPubkeyVerifiedAt: 1,
      }),
    );
    await expect(classify(payment({ destination: 'missing@example.test' }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
    await expect(classify(payment({ destination: 'self@example.test' }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
  });

  it('resolves Spark invoices, bare Spark addresses, and raw pubkeys', async () => {
    const first = setup();
    first.state.pubkeys.set(OTHER_KEY, account(MEMBER));
    await expect(first.classify(payment({ invoice: spark() }))).resolves.toEqual({
      category: 'member',
      counterpartyAccountId: MEMBER,
    });

    const bytes = protoBytesField(1, Uint8Array.from(Buffer.from(OTHER_KEY, 'hex')));
    const address = bech32m.encode('sp', bech32m.toWords(bytes), false);
    await expect(first.classify(payment({ destination: address }))).resolves.toEqual({
      category: 'member',
      counterpartyAccountId: MEMBER,
    });
    await expect(
      first.classify(payment({ destination: ` ${OTHER_KEY.toUpperCase()} ` })),
    ).resolves.toEqual({
      category: 'member',
      counterpartyAccountId: MEMBER,
    });

    const unresolved = setup();
    await expect(unresolved.classify(payment({ invoice: spark() }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
    await expect(unresolved.classify(payment({ destination: OTHER_KEY }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
    unresolved.state.pubkeys.set(OTHER_KEY, account(OWN));
    await expect(unresolved.classify(payment({ invoice: spark() }))).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
  });

  it('tries the reported hash first and then the zap hash of a Spark memo', async () => {
    const { state, classify } = setup();
    state.invoice = invoice(MEMBER, PAYER);
    state.accounts.set(MEMBER, account(MEMBER));
    await expect(
      classify(payment({ invoice: spark(`zap:${BOLT11_PAYMENT_HASH.toUpperCase()}`) })),
    ).resolves.toEqual({ category: 'gift', counterpartyAccountId: MEMBER });
    expect(state.invoiceHashes).toEqual([BOLT11_PAYMENT_HASH]);

    state.invoiceHashes.length = 0;
    state.invoiceHash = BOLT11_PAYMENT_HASH;
    await expect(
      classify(
        payment({ paymentHash: 'f'.repeat(64), invoice: spark(`zap:${BOLT11_PAYMENT_HASH}`) }),
      ),
    ).resolves.toEqual({ category: 'gift', counterpartyAccountId: MEMBER });
    expect(state.invoiceHashes).toEqual(['f'.repeat(64), BOLT11_PAYMENT_HASH]);

    state.invoiceHashes.length = 0;
    await classify(
      payment({ paymentHash: BOLT11_PAYMENT_HASH, invoice: spark(`zap:${BOLT11_PAYMENT_HASH}`) }),
    );
    expect(state.invoiceHashes).toEqual([BOLT11_PAYMENT_HASH]);

    delete state.invoice;
    delete state.invoiceHash;
    state.charge = charge(SHOP);
    await classify(
      payment({ paymentHash: 'f'.repeat(64), invoice: spark(`zap:${BOLT11_PAYMENT_HASH}`) }),
    );
    expect(state.refs.at(-1)).toEqual({ paymentHash: 'f'.repeat(64) });
  });

  it('uses onchain, Lightning, foreign-address, ln-invoice, and unknown fallbacks', async () => {
    const { classify } = setup();
    for (const method of ['onchain', 'bitcoin']) {
      await expect(classify(payment({ method }))).resolves.toEqual({
        category: 'onchain',
        counterpartyAccountId: null,
      });
    }
    for (const method of ['lightning', 'bolt11', 'lnurl']) {
      await expect(classify(payment({ method }))).resolves.toEqual({
        category: 'outside_lightning',
        counterpartyAccountId: null,
      });
    }
    await expect(classify(payment({ destination: 'a@foreign.test' }))).resolves.toEqual({
      category: 'outside_lightning',
      counterpartyAccountId: null,
    });
    const withoutLnurl = setup(false).classify;
    await expect(withoutLnurl(payment({ destination: 'a@foreign.test' }))).resolves.toEqual({
      category: 'outside_lightning',
      counterpartyAccountId: null,
    });
    await expect(classify(payment({ invoice: 'LNbc-invalid' }))).resolves.toEqual({
      category: 'outside_lightning',
      counterpartyAccountId: null,
    });
    await expect(classify(payment())).resolves.toEqual({
      category: 'unknown',
      counterpartyAccountId: null,
    });
  });

  it('propagates lookup failures', async () => {
    const { state, classify } = setup();
    state.throwLookup = true;
    await expect(classify(payment({ paymentHash: 'a'.repeat(64) }))).rejects.toThrow(
      'lookup failed',
    );
  });
});
