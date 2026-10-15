/**
 * Boot-time insert of the public production shop pins on the dev API.
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
  {
    id: '01234513-9ed1-4bf1-ac19-2cc59ba6ae3b',
    name: 'Rachel-Ann Mabulay',
    label: 'Sta.Bakhita st. Near Sta.Bakhita Chapel. Happyland Barangay 105 Tondo Manila,',
    lat: 14.620756,
    lng: 120.957925,
    createdAt: '2026-09-22T00:47:50.015Z',
  },
  {
    id: '764288f2-2ac9-4758-9506-eb81a6f8bcbf',
    name: 'Rose Otero',
    label: 'Sta.Bakhita st. Near Happyland Basketball court  Tondo Manila',
    lat: 14.620755,
    lng: 120.958461,
    createdAt: '2026-09-22T01:35:18.583Z',
  },
  {
    id: '746b992c-ee86-4c27-b36e-8f661e27a3d0',
    name: 'Rachel-Ann Mabulay',
    label: 'Daisy st. Dulo Happyland Barangay 105 Happyland Tondo,Manila',
    lat: 14.620754,
    lng: 120.957236,
    createdAt: '2026-09-22T08:32:14.190Z',
  },
  {
    id: '8a7d0c1a-1428-4d32-b28c-665b75dd8313',
    name: 'Rachel-Ann Mabulay',
    label: 'Gk front building of HAPPYLAND Barangay  105 Tondo,Manila, Philippines',
    lat: 14.620992,
    lng: 120.958539,
    createdAt: '2026-09-22T08:57:28.190Z',
  },
  {
    id: '4ba2c157-76a9-460f-9335-dc0ee8177b90',
    name: 'Rose Otero',
    label: 'Happyland Court Barangay 105 Tondo ,Manila',
    lat: 14.620787,
    lng: 120.958209,
    createdAt: '2026-09-24T05:05:37.526Z',
  },
  {
    id: 'd9ec7a6a-d4e0-43bc-95a4-dbfccebccbe2',
    name: 'Rachel-Ann Mabulay',
    label: 'Daisy Street Happyland Barangay.105 Tondo,Manila.',
    lat: 14.620683,
    lng: 120.958288,
    createdAt: '2026-09-25T04:46:24.447Z',
  },
  {
    id: '83a72d54-7070-4a8a-b3f4-9f0ca8d0dc30',
    name: 'Rose Ann Otero',
    label: 'Daisy st. corner hasa hasa st. Happyland Barangay 105  Tondo Manila',
    lat: 14.620668,
    lng: 120.957795,
    createdAt: '2026-09-27T19:47:29.198Z',
  },
  {
    id: '9980925c-42cb-4fe6-bbd9-1ddb27c9936f',
    name: 'Rachel-Ann Mabulay',
    label: 'Sta.bakhita st.katabi nang chapel Happyland Tondo Manila',
    lat: 14.620735,
    lng: 120.957702,
    createdAt: '2026-10-08T09:25:49.080Z',
  },
  {
    id: '0e54d662-e955-4c66-94d6-1d5f895506eb',
    name: 'Yorelene Macabit',
    label: 'Chicharon st. Happyland Barangay 105 Tondo,Manila',
    lat: 14.621307,
    lng: 120.957695,
    createdAt: '2026-10-09T09:39:28.646Z',
  },
  {
    id: '2e5c0aaf-a2f1-4d3a-8640-4463cba227f6',
    name: 'Rachel-Ann Mabulay',
    label: 'Daisy st.Corner hasa hasa st.happyland Barangay 105 tondo manila',
    lat: 14.620683,
    lng: 120.957941,
    createdAt: '2026-10-09T09:51:32.939Z',
  },
  {
    id: 'e942dd1c-1fc4-4ce9-8252-8922f7e93fdf',
    name: 'Rose Otero',
    label: 'Sta.bakhita chapel happyland barangay 105 Tondo Manila',
    lat: 14.620783,
    lng: 120.95758,
    createdAt: '2026-10-09T13:52:37.961Z',
  },
  {
    id: '61f13589-f04b-4319-9677-7e6b3dbab24a',
    name: 'Rachel-Ann Mabulay',
    label: 'Daisy st.  happyland Barangay 105 Tondo Manila',
    lat: 14.620743,
    lng: 120.957272,
    createdAt: '2026-10-09T13:56:40.919Z',
  },
  {
    id: '0a8bb5d4-32d2-4316-8f0a-f40e09ccb57e',
    name: 'Rachel-Ann Mabulay',
    label: 'Sta.bakhita st. Gilid ng sta.bakhita chapel happyland',
    lat: 14.62081,
    lng: 120.957576,
    createdAt: '2026-10-12T05:47:08.907Z',
  },
  {
    id: 'ed3c5451-57c2-41c2-9450-b4e92df8d8db',
    name: 'Leonardo Abaigar',
    label: 'Hasa hasa st. Happy land barangay 105 Tondo Manila',
    lat: 14.620515,
    lng: 120.957789,
    createdAt: '2026-10-12T08:12:59.395Z',
  },
  {
    id: '96ecd063-94e9-4866-bd97-a7dcfba7e5d9',
    name: 'Liberty Platon',
    label: 'Dilis St.happyland  Barangay 105 tondo manila',
    lat: 14.620718,
    lng: 120.957662,
    createdAt: '2026-10-12T08:15:09.940Z',
  },
  {
    id: '7eebacb2-cd04-46af-8d3d-fa761a4b4905',
    name: 'Girly Orillo',
    label: 'Sta.bakhita st. Corner daisy st. Happyland Tondo Manila',
    lat: 14.620722,
    lng: 120.957553,
    createdAt: '2026-10-12T08:47:10.855Z',
  },
  {
    id: '8cb805cd-3fbe-4d19-8a51-8d2e36d169ab',
    name: 'Yorelene Macabit',
    label: 'Sta.Bakhita st.harap ng chapel Happyland Tondo Manila',
    lat: 14.620698,
    lng: 120.957953,
    createdAt: '2026-10-14T00:50:51.374Z',
  },
];

function seedSql(count: number): string {
  const tuples = Array.from({ length: count }, (_, index) => {
    const base = index * 7;
    return `  ($${base + 1}::uuid, NULL, $${base + 2}, $${base + 3}, $${base + 4}::timestamptz, $${base + 5}::float8, $${base + 6}::float8, $${base + 7}, NULL, NULL, NULL, 'skipped')`;
  });
  return `INSERT INTO message (
  id, account_id, name, text, created_at,
  place_lat, place_lng, place_label,
  parent_id, deleted_at, event_id, nostr_publish_state
) VALUES
${tuples.join(',\n')}
ON CONFLICT (id) DO NOTHING`;
}

const SEED_SQL = seedSql(DEV_SHOP_PINS.length);

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
 * @returns Whether this process should seed the public shop pins.
 */
export function isDevShopSeedTarget(env: Record<string, string | undefined>): boolean {
  const raw = env['PUBLIC_BASE_URL'];
  if (raw === undefined) {
    return false;
  }
  return raw.trim().replace(/\/+$/u, '') === DEV_SHOP_SEED_URL;
}

/**
 * Insert the public production shop pins on the dev API.
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
