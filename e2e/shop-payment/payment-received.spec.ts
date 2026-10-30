/**
 * The LNURL server's payment webhook (`POST /webhooks/lnurl`) against the shop
 * api, which sets `LNURL_WEBHOOK_SECRET` and has members with a verified
 * wallet. Push subscriptions need VAPID, which this boot leaves blank, so a
 * known receiver ends at `no_device`.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { WEBHOOK_SECRET } from './stand-ins/ports';
import { verifiedShop } from './fixtures';

function paymentBody(userPubkey: string): string {
  return JSON.stringify({
    template: 'spark_payment_received',
    data: {
      payment_hash: randomBytes(32).toString('hex'),
      user_pubkey: userPubkey,
      invoice: 'lnbc210n1',
      preimage: randomBytes(32).toString('hex'),
      amount_sat: 21,
      lightning_address: null,
      sender_comment: null,
      timestamp: Date.now(),
      nostr_zap_request: null,
    },
  });
}

function postWebhook(
  request: APIRequestContext,
  body: string,
  secret: string | null = WEBHOOK_SECRET,
): Promise<APIResponse> {
  return request.post('/webhooks/lnurl', {
    headers: {
      'content-type': 'application/json',
      ...(secret === null
        ? {}
        : { 'x-breez-signature': createHmac('sha256', secret).update(body).digest('hex') }),
    },
    data: body,
  });
}

test('Function: resolvePaymentWebhookSecret — the shop api mounts POST /webhooks/lnurl', async ({
  request,
}) => {
  const res = await postWebhook(request, paymentBody(`02${'1'.repeat(64)}`), null);
  expect(res.status()).toBe(401);
});

test('Function: webhookRoutes — an unsigned or wrongly signed webhook is 401', async ({
  request,
}) => {
  const body = paymentBody(`02${'1'.repeat(64)}`);
  expect((await postWebhook(request, body, null)).status()).toBe(401);
  const wrong = await postWebhook(request, body, 'not-the-secret');
  expect(wrong.status()).toBe(401);
  expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: breezSignatureValid — a body signed with the secret is accepted', async ({
  request,
}) => {
  const res = await postWebhook(request, paymentBody(`02${'1'.repeat(64)}`));
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: 'unknown' });
});

test('Function: parsePaymentReceived — a signed body of another template is ignored', async ({
  request,
}) => {
  const res = await postWebhook(request, JSON.stringify({ template: 'other', data: {} }));
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: 'ignored' });
});

test('Function: notifyPaymentReceived — a verified wallet without a push device queues nothing', async ({
  request,
}) => {
  const shop = await verifiedShop(request, 'paid');
  const res = await postWebhook(request, paymentBody(shop.sparkPubkey));
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: 'no_device' });
});

test('Function: buildPaymentReceivedPushPayload — no payload without a push subscription (VAPID blank)', async ({
  request,
}) => {
  const shop = await verifiedShop(request, 'paidpush');
  const subscribe = await request.post('/me/push-subscriptions', {
    headers: { authorization: `Bearer ${shop.token}` },
    data: { endpoint: 'https://push.example/e2e', keys: { p256dh: 'p', auth: 'a' } },
  });
  expect(subscribe.status()).toBe(503);
  expect(await subscribe.json()).toEqual({ error: 'Push is not configured' });
  const res = await postWebhook(request, paymentBody(shop.sparkPubkey));
  expect(await res.json()).toEqual({ outcome: 'no_device' });
});
