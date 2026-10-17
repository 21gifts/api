# Shop identity

Status: **specified, not implemented**. Nothing here changes runtime
behaviour yet. A change that builds a part of this adds its routes to
`SPEC.md`, its table to `docs/schema/` and its functions and routes to the
handbook in that same change.

Every shop gets its own NOSTR identity. 21.gifts generates it, holds it and
publishes its profile, exactly the way it already does for every account. The
shop's public page is `https://21.gifts/{npub}`.

The same npub identifies the shop on the OpenCryptoPay map. OpenCryptoPay
requires a NOSTR public key for every shop it lists and uses it as the shop's
id, including for its page `https://opencryptopay.io/{npub}`. OpenCryptoPay
does not hold keys and does not maintain profiles. Its side is specified in
[openCryptoPay/api `docs/product/shop-identity.md`](https://github.com/openCryptoPay/api/blob/develop/docs/product/shop-identity.md).

## What a shop is

A **listed shop** is a live top-level forum note (`parent_id` null,
`deleted_at` null) whose text has the hashtag token `21GiftsShop` (the same
token rule as `GET /shops/activity`), that has a place pin, and whose
`shop_account_id` is set.

A note that stops meeting any of these (hashtag removed, pin removed, till
account cleared, note deleted or hidden by staff) is no longer listed. It
keeps its identity.

## S1 Key per shop

- One random key per shop note, from the same `generateSecretKey()` path as
  account keys (`src/lib/nostr/keys.ts`). No master seed, no derivation.
- The key is created when a note first becomes a listed shop, after the
  commit of `POST /messages`, `PATCH /messages/:id/text`,
  `PATCH /messages/:id/place` or `PATCH /messages/:id/shop-account`.
  - A failure logs `shop.nostr_key.failed` with the message id and does not
    fail the request, the same as the lazy account key at login.
  - The worker backfill also picks up listed shops without a key, at most 20
    per tick, oldest note first, next to the existing account backfill.
- The identity belongs to the note. It is never deleted and never moved to
  another note:
  - A note that stops being listed and is listed again gets the same npub
    back.
  - Changing the till account (`shop_account_id`) or the pin does not change
    the identity.
  - A second note for the same physical shop is a second shop with its own
    identity.
- Two concurrent creators keep exactly one key: compare-and-set on insert,
  the same as `ensureAccountNostrKey`.

### Storage

New table `shop_identity`, with the same column names as the key columns on
`account`:

| Column                  | Type                   | Rule                                       |
| ----------------------- | ---------------------- | ------------------------------------------ |
| `message_id`            | `uuid PRIMARY KEY`     | `REFERENCES message (id)`                  |
| `nostr_pubkey`          | `text NOT NULL UNIQUE` | 64 lowercase hex                           |
| `nostr_nsec_ciphertext` | `bytea NOT NULL`       | Envelope below                             |
| `nostr_kek_id`          | `integer NOT NULL`     | Only `1`                                   |
| `nostr_key_custody`     | `text NOT NULL`        | `CHECK` `custodial` or `user`; `custodial` |
| `nostr_key_created_at`  | `timestamptz NOT NULL` | Set on insert                              |

Messages are soft-deleted, so the reference never dangles.

### Encryption at rest

- The existing envelope and key-encryption key: `version (0x01) || kek_id
(u32 BE) || nonce (12) || ciphertext+tag`, AES-256-GCM, `NOSTR_NSEC_KEK`.
  No new secret.
- Additional authenticated data: the UTF-8 bytes of `shop:<messageId>`. An
  account key uses the account UUID, so a shop ciphertext can never be
  decrypted as an account key or as another shop's key.
- Signing decrypts, signs and zeroes the secret, through the existing
  `src/lib/nostr/sign.ts` path.
- The `db_change` audit log stores a shop's `nostr_nsec_ciphertext` only as
  a SHA-256 hash, as it does for accounts.

### Custody

Custodial, like every account key in v1. The shop key only signs the shop's
kind 0 and kind 10002. The shop note itself stays a kind 1 from its author's
account key, unchanged. Handing a shop key to its owner belongs to the open
custodial-to-user step of Open Question #9 in `CONCEPT.md`.

## S2 Profile

The worker publishes shop profiles in the same loop and with the same rules
as account profiles (`publishProfiles` in `src/lib/nostr/worker.ts`):

- same interval and batch size, same `NOSTR_PUBLISH` and
  `NOSTR_PUBLISH_PUBLIC` switches, same relays, kind 0 and kind 10002 also to
  `wss://purplepag.es`;
- published only when the content differs from the in-memory cache;
- `created_at` = `max(now, last + 1)`; a relay failure clears the cache entry.

Kind 0 content of a listed shop:

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| `name`         | shop name: the pin label                                               |
| `display_name` | shop name                                                              |
| `about`        | shop description: the note text without the `#21GiftsShop` token       |
| `picture`      | absolute URL of `/messages/:id/photo`, otherwise the account fallback  |
| `banner`       | absolute URL of `/messages/:id/photo/1.<ext>`, otherwise `/og.png`     |
| `website`      | `https://21.gifts/{npub}`                                              |
| `nip05`        | `<local>@<domain>`, see below                                          |
| `lud16`        | the `lud16` of the till account's own kind 0; omitted when it has none |

The shop name and description follow `src/lib/shop-place.ts` once the change
that makes shops complete for the map is merged. Until then `name` is the pin
label and `about` is the note text without the token.

Kind 0 of a shop that is no longer listed keeps `name` and `website`, sets
`about` to `This shop is no longer listed on 21.gifts.`, and drops `picture`,
`banner`, `nip05` and `lud16`. There is no kind 5 deletion.

Kind 10002 lists the same write relays as an account's.

The `lud16` is a plain Lightning address. The till account's LNURL response
is unchanged, so this spec adds no zap receipts for a shop key.

### NIP-05

- Listed shops join the existing `/.well-known/nostr.json` (api route and the
  app proxy).
- The local part comes from `allocateNip05Local(shopName, messageId, taken)`,
  the same slug and the same collision suffix as accounts.
- Accounts are allocated first, then shops by `nostr_key_created_at`. An
  account never loses its local part to a shop.
- The local part follows the current shop name. A rename, or a new account
  that takes the slug, gives the shop a new local part, and its kind 0 is
  published again.

## S3 API

### `GET /shops/:npub`

New. No session; a missing or invalid bearer gets the same answer.
`Cache-Control: public, max-age=60`.

| Request                                  | Response                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| npub of a listed shop                    | **200** `{ "shop": Shop }`                                                |
| 64 lowercase hex of a known shop pubkey  | **301** to `/shops/{npub}`                                                |
| npub of a known shop that is not listed  | **410** `{ "error": "Shop is no longer listed", "npub": "…" }`            |
| anything else, including an unknown npub | **404** `{ "error": "Shop not found" }`                                   |
| store failure                            | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` |

`Shop`:

```json
{
  "npub": "npub1…",
  "messageId": "uuid",
  "name": "…",
  "description": "…",
  "place": {
    "lat": 0,
    "lon": 0,
    "label": "…",
    "address": {
      "street": "…",
      "houseNumber": "…",
      "postalCode": "…",
      "city": "…",
      "country": "CH"
    }
  },
  "photos": [{ "url": "https://…/messages/:id/photo", "width": 1280, "height": 960 }],
  "tillUsername": "…",
  "nip05": "…@21.gifts",
  "createdAt": "ISO-8601"
}
```

`address` is `null` while the pin has none. `tillUsername` is `null` when the
till account has no username. Photos are the note's photos in note order.
Hidden media are never listed.

### Existing responses

- Public message JSON gains `shopNpub`: the npub when the note is a listed
  shop with a key, otherwise `null`.
- `GET /messages/places` rows gain the same `shopNpub`.

## S4 Shop page `https://21.gifts/{npub}`

- New app route `src/app/[npub]/page.tsx`. Static routes keep precedence. The
  segment must match `^npub1[02-9ac-hj-np-z]{58}$`, otherwise `notFound()`.
- `^[0-9a-f]{64}$` asks the api and redirects (308) to `/{npub}` on its 301.
- `generateMetadata` like a public note: 2.5 s timeout, `title` = shop name,
  description, `og:image` = first photo or `/og.png`, canonical
  `https://21.gifts/{npub}`.
- 404 → the existing not-found page. 410 → a page with the name and "no
  longer listed". 503 → an error state with retry, never a blank page.
- Content: photo gallery, name, description, address with a directions link,
  a small map with one pin, the pay link and QR of the till account
  (`/pay/<tillUsername>`) when it exists, a link to the forum note
  (`/messages/<messageId>`), the npub with a copy button and the NIP-05.
- The shops page (`/shops`) and the map link each shop to `/{npub}` instead
  of the note.
- All visible text goes through the existing translations.

## S5 OpenCryptoPay push

`src/lib/ocp-place.ts`:

- Every place `PUT` carries the shop's `nostrPubkey` (64 lowercase hex).
  OpenCryptoPay rejects a place without it.
- A listed shop without a key gets one first through S1. If that fails, the
  push is skipped and logged, and the next sync or
  `publishExistingShopPlaces` tries again.
- After each successful place `PUT`, the api sends the note's photos to
  `PUT /map/places/photos` with the same bearer: up to 10, in note order,
  bytes and content type as stored. A note without photos sends an empty
  list. `PATCH /messages/:id/photos` on a listed shop triggers the same photo
  push.
- Removal is unchanged: `DELETE /map/places` when a shop is no longer listed.
  OpenCryptoPay drops the photos with it.

## Order of work

1. S1 and S2: shop keys, backfill, profiles, NIP-05.
2. S3: `GET /shops/:npub`, `shopNpub`.
3. S5: OpenCryptoPay push of `nostrPubkey` and photos, deployed together with
   the OpenCryptoPay change that requires the key. Until then 21.gifts shops
   are not on the OpenCryptoPay list.
4. S4 in `21gifts/app`.

Each step is one pull request with the handbook, e2e tests and the coverage
gate from `CONTRIBUTING.md`.

## Not part of this

- Shop-signed notes, or zaps to a shop key.
- Handing a shop key to its owner.
- A separate photo set for the shop beyond the note's photos.
