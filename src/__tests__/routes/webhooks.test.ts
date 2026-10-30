import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Account } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { webhookRoutes } from '@/routes/webhooks';

const SECRET = 'webhook-secret';
const WALLET = `02${'1'.repeat(64)}`;

function mount(push: InMemoryPushStore, unreadCount = async (): Promise<number> => 0): Hono {
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
      notifications: { unreadCount },
      inboxUnreadCount: async () => 0,
      now: () => 1_700_000_000_000,
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
