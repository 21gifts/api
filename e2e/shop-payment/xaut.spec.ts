import { expect, test } from '@playwright/test';
import { Control, openPayerPayment, paymentStatus, verifiedShop } from './fixtures';
import { CONTROL_URL } from './stand-ins/ports';

test('Function: fetchXautSpot accepts the stand-in Kraken ticker', async ({ request }) => {
  const shop = await verifiedShop(request, 'xautfetch');
  await openPayerPayment(request, shop.username, 2100);
  const response = await request.get(`/.well-known/lnurlp/${shop.username}`);
  const body = (await response.json()) as {
    transferAmounts: Array<{ method: string; assets: Array<{ asset: string; amount: string }> }>;
  };
  expect(
    body.transferAmounts
      .find((row) => row.method === 'Polygon')
      ?.assets.find((asset) => asset.asset === 'XAUt'),
  ).toEqual({ asset: 'XAUt', amount: '0.000529' });
});

test('Function: startXautSpotWorker supplies the boot-time price', async ({ request }) => {
  const shop = await verifiedShop(request, 'xautworker');
  await openPayerPayment(request, shop.username, 2100);
  const readCount = async (): Promise<number> => {
    const response = await request.get(`${CONTROL_URL}/__control/violations`);
    return ((await response.json()) as { xautSpotReads: number }).xautSpotReads;
  };
  const before = await readCount();
  expect(before).toBeGreaterThan(0);
  const first = await request.get(`/.well-known/lnurlp/${shop.username}`);
  expect(await first.text()).toContain('XAUt');
  const secondShop = await verifiedShop(request, 'xautworker2');
  await openPayerPayment(request, secondShop.username, 2100);
  const second = await request.get(`/.well-known/lnurlp/${secondShop.username}`);
  expect(await second.text()).toContain('XAUt');
  expect(await readCount()).toBe(before);
});

test('an overpriced XAUT0 quote is rejected while Polygon USDT and USDC remain available', async ({
  request,
}) => {
  const control = new Control(request);
  const shop = await verifiedShop(request, 'xautexpensive');
  await control.behave(shop.username, { xautOverpriced: true });
  const opened = await openPayerPayment(request, shop.username, 2100);
  expect(opened.payment).toBeTruthy();
  const response = await request.get(`/.well-known/lnurlp/${shop.username}`);
  const body = (await response.json()) as {
    transferAmounts: Array<{ method: string; assets: Array<{ asset: string }> }>;
  };
  const assets = body.transferAmounts
    .find((row) => row.method === 'Polygon')
    ?.assets.map((asset) => asset.asset);
  expect(assets).toEqual(['USDT', 'USDC']);
  expect((await control.state(shop.username)).quotes.some((quote) => quote.asset === 'XAUT0')).toBe(
    true,
  );
});

test('Polygon XAUt is offered and a detected deposit becomes accepted and paid', async ({
  request,
}) => {
  test.setTimeout(200_000);
  const control = new Control(request);
  const shop = await verifiedShop(request, 'xaut');
  await control.behave(shop.username, { completeAfterMs: null });
  const opened = await openPayerPayment(request, shop.username, 2100);
  const pay = await request.get(`/.well-known/lnurlp/${shop.username}`);
  expect(pay.status()).toBe(200);
  const body = (await pay.json()) as {
    quote: { id: string };
    transferAmounts: Array<{ method: string; assets: Array<{ asset: string; amount: string }> }>;
  };
  const xaut = body.transferAmounts
    .find((entry) => entry.method === 'Polygon')
    ?.assets.find((entry) => entry.asset === 'XAUt');
  expect(xaut).toBeDefined();
  const detail = await request.get(`/.well-known/lnurlp/${shop.username}`, {
    params: { quote: body.quote.id, method: 'Polygon', asset: 'xaut' },
  });
  expect(detail.status()).toBe(200);
  const data = (await detail.json()) as { uri: string };
  const match =
    /^ethereum:(0x[0-9a-f]+)@137\/transfer\?address=(0x[0-9a-f]+)&uint256=([0-9]+)$/i.exec(
      data.uri,
    );
  expect(match?.[1]?.toLowerCase()).toBe('0xf1815bd50389c46847f0bda824ec8da914045d14');
  const transfer = await control.transfer({
    chainId: 137,
    token: match![1]!,
    to: match![2]!,
    amount: match![3]!,
    detect: 'running',
  });
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 150_000,
    })
    .toBe('accepted');
  expect(transfer.orderId).not.toBeNull();
  await control.setOrderStatus(transfer.orderId!, 'completed');
  await expect
    .poll(async () => (await paymentStatus(request, opened.payment)).paymentStatus, {
      timeout: 30_000,
    })
    .toBe('paid');
  expect(await control.violations()).toEqual([]);
});
