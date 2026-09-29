import { describe, expect, it } from 'vitest';
import { SHOP_PLACE_PUSH_ENABLED } from '@/lib/shop-place-push-enabled';

describe('SHOP_PLACE_PUSH_ENABLED', () => {
  it('stays false until a later pull request turns the push on', () => {
    expect(SHOP_PLACE_PUSH_ENABLED).toBe(false);
  });
});
