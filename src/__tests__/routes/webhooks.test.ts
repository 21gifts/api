import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Account } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { webhookRoutes } from '@/routes/webhooks';

const SECRET = 'webhook-secret';
const WALLET = `02${'1'.repeat(64)}`;

function mount(
  push: InMemoryPushStore,
  unreadCount = async (): Promise<number> => 0,
  readWallet?: (walletPubkey: string) => void,
): Hono {
  return new Hono().route(
    '/webhooks',
    webhookRoutes({
      secret: SECRET,
      auth: {
        getAccountByVerifiedSparkPubkey: async (pubkey) =>
          pubkey === WALLET ? ({ id: 'receiver', name: 'Bea' } as Account) : undefined,
        getAccountByPubkey: async () => undefined,
        getNostrPublicKey: async () => undefined,
      },
      pushStore: push,
      hasLiveDevice: async (id) => (await push.listByAccount(id)).length > 0,
      notifications: { unreadCount },
      inboxUnreadCount: async () => 0,
      now: () => 1_700_000_000_000,
      ...(readWallet === undefined ? {} : { readWallet }),
    }),
  );
}

function post(app: Hono, body: string, signature?: string): Promise<Response> {
  return Promise.resolve(
    app.request('/webhooks/lnurl', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-breez-signature': signature }),
      },
      body,
    }),
  );
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

const PAYMENT = JSON.stringify({
  template: 'spark_payment_received',
  data: { payment_hash: 'ab'.repeat(32), user_pubkey: WALLET, amount_sat: 21 },
});

async function subscribedStore(): Promise<InMemoryPushStore> {
  const push = new InMemoryPushStore();
  await push.upsertSubscription({
    endpoint: 'https://push.example/a',
    accountId: 'receiver',
    p256dh: 'p',
    auth: 'a',
    createdAt: new Date(0),
    sessionToken: 'session',
  });
  return push;
}

describe('POST /webhooks/lnurl', () => {
  it('refuses a missing or wrong signature and ignores a body above 64 KiB', async () => {
    const app = mount(new InMemoryPushStore());
    expect((await post(app, PAYMENT)).status).toBe(401);
    const wrong = await post(app, PAYMENT, sign(`${PAYMENT} `));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
    const large = await post(app, 'x'.repeat(64 * 1024 + 1), sign('x'));
    expect(large.status).toBe(200);
    expect(await large.json()).toEqual({ outcome: 'ignored' });
  });

  it('answers 200 ignored for a signed body it cannot use', async () => {
    const body = JSON.stringify({ template: 'other', data: {} });
    const res = await post(mount(new InMemoryPushStore()), body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'ignored' });
  });

  it('queues one push per payment and answers duplicate on a retry', async () => {
    const push = await subscribedStore();
    const app = mount(push);
    const first = await post(app, PAYMENT, sign(PAYMENT));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ outcome: 'queued' });
    expect(await (await post(app, PAYMENT, sign(PAYMENT))).json()).toEqual({
      outcome: 'duplicate',
    });
    expect(await push.listAllOutbox(10)).toHaveLength(1);
  });

  it('answers 503 when a store call fails, so the LNURL server retries', async () => {
    const push = await subscribedStore();
    const res = await post(
      mount(push, async () => {
        throw new Error('down');
      }),
      PAYMENT,
      sign(PAYMENT),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Notifications are unavailable' });
    expect(await push.listAllOutbox(10)).toEqual([]);
  });
});

describe('POST /webhooks/lnurl wallet read', () => {
  it('asks for a read of the receiving wallet only for a signed, usable notice', async () => {
    const readWallet = vi.fn();
    const app = mount(new InMemoryPushStore(), undefined, readWallet);
    expect((await post(app, PAYMENT)).status).toBe(401);
    expect((await post(app, PAYMENT, sign(`${PAYMENT} `))).status).toBe(401);
    const other = JSON.stringify({ template: 'other', data: {} });
    expect(await (await post(app, other, sign(other))).json()).toEqual({ outcome: 'ignored' });
    expect(readWallet).not.toHaveBeenCalled();
    const res = await post(app, PAYMENT, sign(PAYMENT));
    expect(await res.json()).toEqual({ outcome: 'no_device' });
    expect(readWallet.mock.calls).toEqual([[WALLET]]);
  });

  it('keeps the answer when the read request throws, and still answers 503 on a store failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing = (): void => {
      throw new Error('read failed');
    };
    const push = await subscribedStore();
    const ok = await post(mount(push, undefined, throwing), PAYMENT, sign(PAYMENT));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ outcome: 'queued' });
    const failed = await post(
      mount(
        await subscribedStore(),
        async () => {
          throw new Error('down');
        },
        vi.fn(),
      ),
      PAYMENT,
      sign(PAYMENT),
    );
    expect(failed.status).toBe(503);
    const events = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'payment_received.read_failed' }),
    );
    expect(JSON.stringify(events)).not.toContain(WALLET);
    warn.mockRestore();
  });
});
