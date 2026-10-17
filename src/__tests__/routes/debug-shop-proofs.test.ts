import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as shopProof from '@/lib/shop-proof';
import type { ShopPayments } from '@/lib/shop-payment';
import { debugShopProofsRoutes } from '@/routes/debug-shop-proofs';
import {
  T0,
  getProof,
  harness,
  insertProofs,
  proofRow,
  seed,
  uid,
} from '@/__tests__/helpers/shop-proof-fixture';

const TOKEN = 'debug-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function mount(shop: ShopPayments, debugToken: string | undefined): Hono {
  return new Hono().route('/debug/shop-proofs', debugShopProofsRoutes({ shop, debugToken }));
}

function retry(app: Hono, id: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return Promise.resolve(
    app.request(`/debug/shop-proofs/${id}/retry`, { method: 'POST', headers }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /debug/shop-proofs/:id/retry', () => {
  it('answers 503 when debug is not configured', async () => {
    const { shop } = harness();
    for (const token of [undefined, '', '   ']) {
      const res = await retry(mount(shop, token), uid(1));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    }
  });

  it('answers 401 without the right bearer token', async () => {
    const { shop } = harness();
    const app = mount(shop, TOKEN);
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }]) {
      const res = await retry(app, uid(1), headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('answers 404 for a malformed id without reading the store', async () => {
    const { shop } = harness();
    const spy = vi.spyOn(shopProof, 'retryStuckProof');
    const res = await retry(mount(shop, TOKEN), 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown proof', async () => {
    const { shop } = harness();
    const res = await retry(mount(shop, TOKEN), uid(0x999));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 409 for a proof that is not stuck', async () => {
    const h = harness();
    const { proofId } = await stuckProofSeed(h, null);
    const res = await retry(mount(h.shop, TOKEN), proofId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The proof is not stuck' });
  });

  it('moves a stuck proof back to unresolved for a lowercased id', async () => {
    const h = harness();
    const { proofId } = await stuckProofSeed(h, 'stuck');
    const spy = vi.spyOn(shopProof, 'retryStuckProof');
    const res = await retry(mount(h.shop, TOKEN), proofId.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: proofId, result: null });
    expect(spy).toHaveBeenCalledWith(h.shop, proofId);
    const proof = await getProof(h, proofId);
    expect(proof?.result).toBeNull();
    expect(proof?.giveUpAt?.getTime()).toBe(T0 + 24 * 60 * 60_000);
  });
});

/**
 * Seed the fixture payment with one proof in the given state.
 *
 * @param h - Fixture harness.
 * @param result - `'stuck'` or `null` (unresolved).
 * @returns The proof id.
 */
async function stuckProofSeed(
  h: ReturnType<typeof harness>,
  result: 'stuck' | null,
): Promise<{ proofId: string }> {
  await seed(h);
  const row = proofRow({ result, giveUpAt: new Date(T0 - 1) });
  await insertProofs(h, row);
  return { proofId: row.id };
}
