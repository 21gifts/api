/**
 * Boot-time insert of the four public production shop pins on the dev API.
 *
 * Target is `https://dev.21.gifts` after trim and trailing-slash strip.
 * Idempotent via `ON CONFLICT (id) DO NOTHING`.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { logEvent } from '@/lib/log';

const DEV_SHOP_SEED_URL = 'https://dev.21.gifts';

const DEV_SHOP_PINS: ReadonlyArray<{
  id: string;
  name: string;
  label: string | null;
  lat: number;
  lng: number;
  createdAt: string;
}> = [
  {
    id: '9e6642fd-3a62-497d-bcbc-9b9daa9d55c7',
    name: 'Niza Estrera',
    label: 'Rose st.Happyland Barangay 105 Tondo,Manila',
    lat: 14.620311,
    lng: 120.959626,
    createdAt: '2026-10-07T12:16:03.538Z',
  },
  {
    id: '0cc5c2eb-aaf1-4f36-be26-f1b967e7bbe5',
    name: 'Machakos Bitcoin Academy',
    label: null,
    lat: -1.957658,
    lng: 37.840978,
    createdAt: '2026-10-02T12:54:21.602Z',
  },
  {
    id: '23d08047-df13-4f59-a541-99703e1e8fbc',
    name: 'bitcoinmakueni',
    label: null,
    lat: -2.523991,
    lng: 38.029153,
    createdAt: '2026-10-02T01:22:40.115Z',
  },
  {
    id: '5732c809-562e-4df3-b804-f287be068314',
    name: 'Rachel-Ann Mabulay',
    label: 'Happyland Court Barangay 105 Tondo, Manila',
    lat: 14.620756,
    lng: 120.958281,
    createdAt: '2026-09-29T13:59:23.922Z',
  },
];

const SEED_SQL = `INSERT INTO message (
  id, account_id, name, text, created_at,
  place_lat, place_lng, place_label,
  parent_id, deleted_at, event_id, nostr_publish_state
) VALUES
  ($1::uuid, NULL, $2, $3, $4::timestamptz, $5::float8, $6::float8, $7, NULL, NULL, NULL, 'skipped'),
  ($8::uuid, NULL, $9, $10, $11::timestamptz, $12::float8, $13::float8, $14, NULL, NULL, NULL, 'skipped'),
  ($15::uuid, NULL, $16, $17, $18::timestamptz, $19::float8, $20::float8, $21, NULL, NULL, NULL, 'skipped'),
  ($22::uuid, NULL, $23, $24, $25::timestamptz, $26::float8, $27::float8, $28, NULL, NULL, NULL, 'skipped')
ON CONFLICT (id) DO NOTHING`;

const SEED_PARAMS: readonly unknown[] = DEV_SHOP_PINS.flatMap((pin) => [
  pin.id,
  pin.name,
  `${pin.label ?? pin.name}\n\n#21GiftsShop`,
  pin.createdAt,
  pin.lat,
  pin.lng,
  pin.label,
]);

/**
 * True only when `PUBLIC_BASE_URL` is exactly `https://dev.21.gifts`.
 *
 * Trims the value and strips trailing slashes. Does not case-fold.
 *
 * @param env - Environment slice with `PUBLIC_BASE_URL`.
 * @returns Whether this process should seed the four shop pins.
 */
export function isDevShopSeedTarget(env: Record<string, string | undefined>): boolean {
  const raw = env['PUBLIC_BASE_URL'];
  if (raw === undefined) {
    return false;
  }
  return raw.trim().replace(/\/+$/u, '') === DEV_SHOP_SEED_URL;
}

/**
 * Insert the four public production shop pins on the dev API.
 *
 * No-op when the public base URL is not the dev target or `sql` is omitted.
 * A failed insert logs `dev.shop.places.failed` and does not throw.
 *
 * @param opts - Environment slice and optional SQL client.
 * @returns Resolves after the insert or a no-op. Never rejects.
 */
export async function seedDevShopPlaces(opts: {
  env: Record<string, string | undefined>;
  sql?: SqlClient;
}): Promise<void> {
  if (!isDevShopSeedTarget(opts.env) || opts.sql === undefined) {
    return;
  }
  try {
    await opts.sql.execute(SEED_SQL, SEED_PARAMS);
  } catch {
    logEvent('dev.shop.places.failed');
  }
}
