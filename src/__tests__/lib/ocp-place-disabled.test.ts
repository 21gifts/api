import { describe, expect, it, vi } from 'vitest';
import { resolveMapPush, type MapFetch } from '@/lib/ocp-place';

vi.mock('@/lib/shop-place-push-enabled', () => ({
  SHOP_PLACE_PUSH_ENABLED: false,
}));

describe('resolveMapPush when the code switch is off', () => {
  it('returns undefined even when the url and token are set', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: 'http://map.test', OCP_PLACE_INGEST_TOKEN: 'secret' },
        fetchImpl,
      ),
    ).toBeUndefined();
  });
});
