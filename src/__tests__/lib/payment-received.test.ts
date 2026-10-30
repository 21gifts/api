import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Account, NotificationLevel } from '@/lib/auth/store';
import type { MessageRow } from '@/lib/message';
import {
  breezSignatureValid,
  notifyPaymentReceived,
  parsePaymentReceived,
  resolvePaymentWebhookSecret,
  type PaymentReceived,
  type PaymentReceivedDeps,
} from '@/lib/payment-received';
import { InMemoryPushStore } from '@/lib/push-store';

const HASH = 'ab'.repeat(32);
const WALLET = `02${'1'.repeat(64)}`;
const NOTE_EVENT = 'cd'.repeat(32);
const receiverKey = generateSecretKey();
const RECEIVER_PUBKEY = getPublicKey(receiverKey);
const senderKey = generateSecretKey();
const SENDER_PUBKEY = getPublicKey(senderKey);

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, name: null, ...extra } as Account;
}

function zapRequest(
  key: Uint8Array,
  tags: string[][] = [['p', RECEIVER_PUBKEY]],
  content = '',
): string {
  return JSON.stringify(
    finalizeEvent({ kind: 9734, created_at: 1_700_000_000, tags, content }, key),
  );
}

function payment(extra: Partial<PaymentReceived> = {}): PaymentReceived {
  return { paymentHash: HASH, userPubkey: WALLET, amountSats: 21, zapRequest: null, ...extra };
}

async function setup(
  args: {
    level?: NotificationLevel;
    receiverName?: string | null;
    senderName?: string | null;
    receiverNostr?: string | undefined;
    subscribed?: boolean;
    note?: boolean;
  } = {},
): Promise<{ deps: PaymentReceivedDeps; push: InMemoryPushStore }> {
  const push = new InMemoryPushStore();
  if (args.subscribed !== false) {
    await push.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'receiver',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(0),
      sessionToken: 'session',
    });
  }
  const receiver = account('receiver', {
    name: args.receiverName ?? 'Bea',
    ...(args.level === undefined ? {} : { notificationLevel: args.level }),
  });
  const sender = account('sender', { name: args.senderName ?? 'Ada' });
  const deps: PaymentReceivedDeps = {
    auth: {
      getAccountByVerifiedSparkPubkey: async (pubkey) => (pubkey === WALLET ? receiver : undefined),
      getAccountByPubkey: async (pubkey) =>
        pubkey === SENDER_PUBKEY ? sender : pubkey === RECEIVER_PUBKEY ? receiver : undefined,
      getNostrPublicKey: async (id) =>
        id === 'receiver'
          ? 'receiverNostr' in args
            ? args.receiverNostr
            : RECEIVER_PUBKEY.toUpperCase()
          : undefined,
    },
    messages: {
      getByEventId: async (eventId) =>
        args.note === true && eventId === NOTE_EVENT ? ({ id: 'note' } as MessageRow) : undefined,
    },
    pushStore: push,
    notifications: { unreadCount: async () => 2 },
    inboxUnreadCount: async () => 1,
    now: () => 1_700_000_000_000,
  };
  return { deps, push };
}

async function payloads(push: InMemoryPushStore): Promise<unknown[]> {
  return (await push.listAllOutbox(10)).map((row) => JSON.parse(row.payload) as unknown);
}

describe('resolvePaymentWebhookSecret', () => {
  it('returns the trimmed secret, or null when unset or blank', () => {
    expect(resolvePaymentWebhookSecret({ LNURL_WEBHOOK_SECRET: ' s3cret ' })).toBe('s3cret');
    expect(resolvePaymentWebhookSecret({ LNURL_WEBHOOK_SECRET: '  ' })).toBeNull();
    expect(resolvePaymentWebhookSecret({})).toBeNull();
  });
});

describe('breezSignatureValid', () => {
  const body = '{"template":"spark_payment_received"}';
  const signature = createHmac('sha256', 'secret').update(body).digest('hex');

  it('accepts the HMAC-SHA256 hex of the body in either case', () => {
    expect(breezSignatureValid('secret', body, signature)).toBe(true);
    expect(breezSignatureValid('secret', body, signature.toUpperCase())).toBe(true);
  });

  it('refuses a missing, malformed, or wrong signature', () => {
    expect(breezSignatureValid('secret', body, null)).toBe(false);
    expect(breezSignatureValid('secret', body, 'zz')).toBe(false);
    expect(breezSignatureValid('other', body, signature)).toBe(false);
    expect(breezSignatureValid('secret', `${body} `, signature)).toBe(false);
  });
});

describe('parsePaymentReceived', () => {
  const data = {
    payment_hash: HASH.toUpperCase(),
    user_pubkey: WALLET,
    invoice: 'lnbc1',
    preimage: 'ef'.repeat(32),
    amount_sat: 21,
    lightning_address: 'bea@21.gifts',
    sender_comment: 'hi',
    timestamp: 1,
    nostr_zap_request: '{"kind":9734}',
  };
  const body = (value: unknown): string =>
    JSON.stringify({ template: 'spark_payment_received', data: value });

  it('reads the payment hash, receiver, amount, and zap request', () => {
    expect(parsePaymentReceived(body(data))).toEqual({
      paymentHash: HASH,
      userPubkey: WALLET,
      amountSats: 21,
      zapRequest: '{"kind":9734}',
    });
    expect(parsePaymentReceived(body({ ...data, nostr_zap_request: null }))?.zapRequest).toBeNull();
  });

  it('returns null for anything else', () => {
    expect(parsePaymentReceived('not json')).toBeNull();
    expect(parsePaymentReceived('null')).toBeNull();
    expect(parsePaymentReceived(JSON.stringify({ template: 'other', data }))).toBeNull();
    expect(parsePaymentReceived(body(null))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, payment_hash: 1 }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, payment_hash: 'ab' }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, user_pubkey: '' }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, user_pubkey: 1 }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, amount_sat: null }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, amount_sat: 1.5 }))).toBeNull();
    expect(parsePaymentReceived(body({ ...data, amount_sat: 0 }))).toBeNull();
  });
});

describe('notifyPaymentReceived', () => {
  it('queues one push per payment hash with the badge count and no sender', async () => {
    const { deps, push } = await setup();
    expect(await notifyPaymentReceived(deps, payment())).toBe('queued');
    expect(await notifyPaymentReceived(deps, payment())).toBe('duplicate');
    const rows = await push.listAllOutbox(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: 'receiver',
      type: 'zap',
      messageId: null,
      status: 'pending',
      createdAt: new Date(1_700_000_000_000),
    });
    expect(await payloads(push)).toEqual([
      {
        type: 'zap',
        title: '21.gifts',
        body: 'You received 21 sats.',
        url: '/wallet',
        tag: `payment:${HASH}`,
        unreadCount: 3,
      },
    ]);
  });

  it('names a member who signed a zap request for the receiver', async () => {
    const { deps, push } = await setup();
    const request = zapRequest(senderKey, [
      ['p', RECEIVER_PUBKEY],
      ['amount', '21000'],
      ['e', 'ef'.repeat(32)],
    ]);
    expect(await notifyPaymentReceived(deps, payment({ zapRequest: request }))).toBe('queued');
    expect(await payloads(push)).toMatchObject([{ title: 'Ada' }]);
  });

  it('names nobody for an external or nameless signer', async () => {
    const external = await setup();
    const stranger = zapRequest(generateSecretKey());
    expect(await notifyPaymentReceived(external.deps, payment({ zapRequest: stranger }))).toBe(
      'queued',
    );
    expect(await payloads(external.push)).toMatchObject([{ title: '21.gifts' }]);
    const nameless = await setup({ senderName: ' ' });
    const request = zapRequest(senderKey);
    expect(await notifyPaymentReceived(nameless.deps, payment({ zapRequest: request }))).toBe(
      'queued',
    );
    expect(await payloads(nameless.push)).toMatchObject([{ title: '21.gifts' }]);
  });

  it('ignores a zap request that is not signed for this receiver and amount', async () => {
    const tampered = JSON.parse(zapRequest(senderKey)) as Record<string, unknown>;
    const requests = [
      'not json',
      'null',
      JSON.stringify({ kind: 1, tags: [], pubkey: SENDER_PUBKEY }),
      JSON.stringify({ kind: 9734, tags: [], pubkey: SENDER_PUBKEY }),
      JSON.stringify({ ...tampered, content: 'changed' }),
      zapRequest(senderKey, [['p', 'ef'.repeat(32)]]),
      zapRequest(senderKey, [
        ['p', RECEIVER_PUBKEY],
        ['amount', '1000'],
      ]),
    ];
    for (const request of requests) {
      const { deps, push } = await setup();
      expect(await notifyPaymentReceived(deps, payment({ zapRequest: request }))).toBe('queued');
      expect(await payloads(push)).toMatchObject([{ title: '21.gifts' }]);
    }
    const noKey = await setup({ receiverNostr: undefined });
    expect(
      await notifyPaymentReceived(noKey.deps, payment({ zapRequest: zapRequest(senderKey) })),
    ).toBe('queued');
    expect(await payloads(noKey.push)).toMatchObject([{ title: '21.gifts' }]);
  });

  it('skips an unknown receiver, a self payment, a note zap, level none, and no device', async () => {
    const unknown = await setup();
    expect(await notifyPaymentReceived(unknown.deps, payment({ userPubkey: 'other' }))).toBe(
      'unknown',
    );
    const self = await setup();
    expect(
      await notifyPaymentReceived(self.deps, payment({ zapRequest: zapRequest(receiverKey) })),
    ).toBe('self');
    const note = await setup({ note: true });
    const noteZap = zapRequest(senderKey, [
      ['p', RECEIVER_PUBKEY],
      ['e', NOTE_EVENT],
    ]);
    expect(await notifyPaymentReceived(note.deps, payment({ zapRequest: noteZap }))).toBe('zap');
    const off = await setup({ level: 'none' });
    expect(await notifyPaymentReceived(off.deps, payment())).toBe('off');
    const mentions = await setup({ level: 'mentions' });
    expect(await notifyPaymentReceived(mentions.deps, payment())).toBe('queued');
    const noDevice = await setup({ subscribed: false });
    expect(await notifyPaymentReceived(noDevice.deps, payment())).toBe('no_device');
    for (const done of [unknown, self, note, off, noDevice]) {
      expect(await done.push.listAllOutbox(10)).toEqual([]);
    }
  });
});
