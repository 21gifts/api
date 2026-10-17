# Shop identity

Status: **concept only**. Decided 2026-10-17. Not implemented. No HTTP path
in this document is reserved. A later change that builds this adds its routes
to `SPEC.md` in that same change. Nothing here changes runtime behaviour.

That change also adds the `shopNpub` field on existing responses to
`SPEC.md`, the new table to `docs/schema/` and its functions and routes to the
handbook.

Every shop gets its own NOSTR identity. 21.gifts generates it, holds it and
publishes its profile, exactly the way it already does for every account. The
shop's public page is `https://21.gifts/{npub}`.

The same npub identifies the shop on the OpenCryptoPay map. OpenCryptoPay
requires a NOSTR public key for every shop it lists and uses it as the shop's
id, including for its page `https://opencryptopay.io/{npub}`. OpenCryptoPay
does not hold keys and does not maintain profiles. Its side is specified in
[openCryptoPay/api `docs/product/shop-identity.md`](https://github.com/openCryptoPay/api/blob/develop/docs/product/shop-identity.md)
(until that is merged: openCryptoPay/api#23).

## What a shop is

A **listed shop** is a top-level forum note (`parent_id` null) that:

- is live: `deleted_at` null. A staff hide sets `deleted_at` too, so a hidden
  note is not listed;
- has the hashtag token `21GiftsShop` in its text, with the same token rule
  as `GET /shops/activity`;
- has a place pin;
- has `shop_account_id` set.

"Listed" is the single rule for everything in this document: which notes get
a key, which kind 0 content a shop identity publishes (S2 publishes every
identity, listed or not, with different content), which shops
`GET /shops/:npub` serves with 200, and which shops are on the OpenCryptoPay
map. A note that stops meeting any of the four
conditions is no longer listed. It keeps its identity.

The shop name is the pin label, otherwise the author's name, otherwise
`Shop`: the same chain as today's map name (`shopOcpPlaceName`). The shop
description is the note text without the `#21GiftsShop` token. Both follow
the rules of 21gifts/api#478, which makes shops complete for the map and adds
the structured pin address, once it is merged. This concept builds on that
change.

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
    After it creates a key, it runs the OpenCryptoPay push of S5 for that
    shop, so a failed mint at the write is repaired without another edit.
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

New table `shop_identity`. The key columns have the same names as on
`account`:

| Column                  | Type                   | Rule                                             |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `message_id`            | `uuid PRIMARY KEY`     | `REFERENCES message (id)`                        |
| `nostr_pubkey`          | `text NOT NULL UNIQUE` | 64 lowercase hex                                 |
| `nostr_nsec_ciphertext` | `bytea NOT NULL`       | Envelope below                                   |
| `nostr_kek_id`          | `integer NOT NULL`     | Only `1`                                         |
| `nostr_key_custody`     | `text NOT NULL`        | `CHECK` `custodial` or `user`; `custodial`       |
| `nostr_key_created_at`  | `timestamptz NOT NULL` | Set on insert                                    |
| `profile_name`          | `text NOT NULL`        | Shop name, rewritten whenever the shop is listed |
| `ocp_photos_hash`       | `text NULL`            | SHA-256 of the photo set last answered by S5     |
| `ocp_photos_pending`    | `boolean NOT NULL`     | Default `false`; a photo push is due (S5)        |
| `ocp_photos_generation` | `integer NOT NULL`     | Default `0`; raised by every S5 trigger          |

`MessageStore.deleteById` can hard-delete a top-level note, for example when
its video file is missing. It deletes nothing for a note that has a
`shop_identity` row, the same way it already keeps a credit note with sats,
and its callers treat that note like any other kept row. So the reference
never dangles and the identity is never deleted.

### Encryption at rest

- The existing envelope and key-encryption key: `version (0x01) || kek_id
(u32 BE) || nonce (12) || ciphertext+tag`, AES-256-GCM, `NOSTR_NSEC_KEK`.
  No new secret.
- Additional authenticated data: the UTF-8 bytes of `shop:<messageId>`. An
  account key uses the account UUID, so a shop ciphertext can never be
  decrypted as an account key or as another shop's key.
- A new `signEventForShop(messageId, event)` next to `signEventForAccount` in
  `src/lib/nostr/sign.ts`: it reads `shop_identity.nostr_nsec_ciphertext`,
  decrypts with the shop AAD, signs and zeroes the secret.
- The `db_change` audit log stores a shop's `nostr_nsec_ciphertext` only as
  a SHA-256 hash, as it does for accounts.

### Custody

Custodial, like every account key in v1. The shop key only signs the shop's
kind 0 and kind 10002. The shop note itself stays a kind 1 from its author's
account key, unchanged. Handing a shop key to its owner belongs to the open
custodial-to-user step of Open Question #9 in `CONCEPT.md`.

## S2 Profile

The worker publishes a profile for **every** `shop_identity` row, listed or
not, in the same loop and with the same rules as account profiles
(`publishProfiles` in `src/lib/nostr/worker.ts`):

- same interval and batch size, same `NOSTR_PUBLISH` and
  `NOSTR_PUBLISH_PUBLIC` switches, same relays, kind 0 and kind 10002 also to
  `wss://purplepag.es`;
- published only when the content differs from the in-memory cache;
- `created_at` = `max(now, last + 1)`; a relay failure clears the cache entry.

Kind 0 content of a listed shop:

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| `name`         | shop name                                                              |
| `display_name` | shop name                                                              |
| `about`        | shop description                                                       |
| `picture`      | absolute URL of `/messages/:id/photo`, otherwise the account fallback  |
| `banner`       | absolute URL of `/messages/:id/photo/1.<ext>`, otherwise `/og.png`     |
| `website`      | `https://21.gifts/{npub}`                                              |
| `nip05`        | `<local>@<domain>`, see below                                          |
| `lud16`        | the `lud16` of the till account's own kind 0; omitted when it has none |

Kind 0 of a shop that is no longer listed:

- `name` and `display_name`: `profile_name`, the name it had when it was last
  listed. If the note is hidden or deleted, `Shop` instead, so a name staff
  removed is not kept on the relays.
- `about`: `This shop is no longer listed on 21.gifts.`
- `website`: unchanged.
- `picture`, `banner`, `nip05` and `lud16` are dropped.
- There is no kind 5 deletion.

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

New. `GET /messages/:id` keeps serving a note by its note id. This route
resolves a shop by its NOSTR identity, the id that OpenCryptoPay, NIP-05 and
the shop page use, and answers for a shop that is no longer listed with 410.

No session; a missing or invalid bearer gets the same answer. Registered
after `GET /shops/activity`, so `activity` keeps its own handler. It takes any
single path segment and validates it inside the handler, so every other value
gets the 404 body and headers below.

| Request                                  | Response                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| npub of a listed shop                    | **200** `{ "shop": Shop }`                                                |
| 64 lowercase hex of a known shop pubkey  | **301** to `/shops/{npub}`                                                |
| npub of a known shop that is not listed  | **410** `{ "error": "Shop is no longer listed", "npub": "…" }`            |
| anything else, including an unknown npub | **404** `{ "error": "Shop not found" }`                                   |
| store failure                            | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` |

`Cache-Control: public, max-age=60` on 200, 301, 404 and 410;
`Cache-Control: no-store` on 503.

The 410 body carries no name, so a hidden note's name is not served.

`Shop`:

```json
{
  "npub": "npub1…",
  "messageId": "uuid",
  "name": "…",
  "description": "…",
  "place": {
    "lat": 0,
    "lng": 0,
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

`lat` and `lng` as in `GET /messages/places`. `address` is `null` while the
pin has none. `tillUsername` is `null` when the till account has no username.
Photos are the note's photos in note order. `width` and `height` are the two
integers of the `WxH` string from `imageDisplaySize`
(`src/lib/nostr/image.ts`) on the stored bytes when the response is built,
and are both `null` when it returns `null`. For a JPEG whose EXIF orientation
is 5 to 8 the two are swapped, the same displayed size OpenCryptoPay
reports; reading that orientation is new code next to `imageDisplaySize`.

### Existing responses

- Public message JSON gains `shopNpub`: the npub when the note is a listed
  shop with a key, otherwise `null`.
- `GET /messages/places` rows gain the same `shopNpub`.

## S4 Shop page `https://21.gifts/{npub}`

- New app route `src/app/[npub]/page.tsx`. Static routes keep precedence. The
  segment must match `^npub1[02-9ac-hj-np-z]{58}$` or `^[0-9a-f]{64}$`,
  otherwise `notFound()`.
- `^[0-9a-f]{64}$` asks the api and redirects (308) to `/{npub}` on its 301.
- `generateMetadata` like a public note: 2.5 s timeout, `title` = shop name,
  description, `og:image` = first photo or `/og.png`, canonical
  `https://21.gifts/{npub}`.
- 404 → the existing not-found page. 410 → a "this shop is no longer listed"
  page without a name. 503 → an error state with retry, never a blank page.
- Content: photo gallery, name, description, address with a directions link,
  a small map with one pin, the pay link and QR of the till account
  (`/pay/<tillUsername>`) when it exists, a link to the forum note
  (`/messages/<messageId>`), the npub with a copy button and the NIP-05.
- The shops page (`/shops`) and the map link each shop to `/{npub}` instead
  of the note.
- All visible text goes through the existing translations.

## S5 OpenCryptoPay push

`src/lib/ocp-place.ts` uses "listed" as its only rule:

- **Place:** a listed shop is sent with `PUT /map/places`, and every `PUT`
  carries its `nostrPubkey` (64 lowercase hex). A shop without a key gets one
  first through S1; if that fails, nothing is sent and the S1 backfill
  repeats the push later. A note that is not listed is never sent.
- **Removal:** every change from listed to not listed sends
  `DELETE /map/places`: pin removed, till account cleared, note deleted or
  hidden. This includes `PATCH /messages/:id/shop-account` clearing the till,
  which today still re-sends the place. Each removal also sets
  `ocp_photos_hash` to null, clears `ocp_photos_pending` and raises
  `ocp_photos_generation`, because OpenCryptoPay drops the photos with the
  place, so a shop that is listed again sends its photos again.
  `publishExistingShopPlaces` at start-up sends listed shops, and sends the
  removal again for tagged pins that are not listed and for every
  `shop_identity` whose note is not listed, so a removal that failed is
  repeated.
- **Account merge:** `src/lib/account-merge.ts` moves `shop_account_id` from
  the merged account to the surviving one before it deletes the old account.
  Today the foreign key sets it to null, which would unlist the shop without
  any removal being sent.
- **Photos:** a successful place `PUT`, and `PATCH /messages/:id/photos` on
  a listed shop, set `ocp_photos_pending` and raise `ocp_photos_generation`.
  The worker takes at most 20 pending shops per tick (`WORKER_BATCH`),
  outside the request path:
  - It reads the generation `g` with the row. A shop that is not listed any
    more gets its flag cleared and nothing is sent.
  - It computes the SHA-256 over the photo set. If it equals
    `ocp_photos_hash`, it clears the flag and sends nothing.
  - Otherwise it sends up to 10 photos, in note order, with
    `PUT /map/places/photos` as `{ nostrPubkey, photos: [{ contentType, data }] }`,
    `data` being the stored bytes in base64. 21.gifts allows at most 10
    photos of 1 MiB, about 13.3 MiB in base64, under that route's 15 MiB
    body limit. An empty set is sent as an empty list.
  - It uses its own 30 s timeout instead of the 5 s timeout of the place
    push (`src/lib/ocp-place.ts:356`), because the body can reach about 13.3 MiB
    while a place body is a few fields of text.
  - Every write the worker makes, including the two early flag clears
    above, is conditional on `ocp_photos_generation = g`. If a trigger or a
    removal ran in the meantime, the write does nothing and the flag stays
    as that change left it, so the newer state wins.
  - On 200 it stores the hash and clears the flag. OpenCryptoPay may skip
    single photos it does not accept and lists them in its answer; those are
    logged as `ocp.photos.skipped` and not retried for this set.
  - On 400 or 413 it also stores the hash and clears the flag, and logs
    `ocp.photos.rejected`. The same set is not sent again.
  - On 404 (OpenCryptoPay does not know the place yet, for example because
    the place `PUT` failed) it sets the hash to null and clears the flag. The
    next successful place `PUT` sets the flag again and the photos follow.
  - On a network error, a timeout or a 5xx it logs `ocp.photos.failed` and
    keeps the flag, so the next tick retries.
- **Rollout:** OpenCryptoPay first accepts `nostrPubkey` and lists only shops
  that have one (its step 1a), then adds the photo route (step 2), and only
  then rejects writes without a key (step 1b). This change deploys after 1a
  and 2 and before 1b. Until it is live, 21.gifts shops are off the
  OpenCryptoPay list.

## Order of work

0. 21gifts/api#478: complete shops with a structured address.
1. S1 and S2: shop keys, backfill, profiles, NIP-05.
2. S3: `GET /shops/:npub`, `shopNpub`.
3. S5: OpenCryptoPay push with `nostrPubkey`, removal by the listed rule,
   photos.
4. S4 in `21gifts/app`.

Each step is one pull request with the handbook, e2e tests and the coverage
gate from `CONTRIBUTING.md`.

## Not part of this

- Shop-signed notes, or zaps to a shop key.
- Handing a shop key to its owner.
- A separate photo set for the shop beyond the note's photos.
